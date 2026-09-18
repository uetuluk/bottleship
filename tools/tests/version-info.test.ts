// VS_VERSIONINFO codec: build → walk round trip, plus RT_VERSION extraction from an
// on-disk PE image (section-table RVA translation, not a mapped image).

import { describe, expect, test } from "bun:test";
import {
    buildVersionInfoBlob,
    findVersionResourceInFile,
    queryVersionValue,
    readVersionNode,
    versionBlobLength,
    VFT_DLL,
    VOS__WINDOWS32,
    VS_FFI_SIGNATURE,
    VS_FIXEDFILEINFO_SIZE,
} from "../../src/worker/modules/version-info";

const fixed = {
    fileVersionMS: 0x00040009, fileVersionLS: 0x00000388,
    productVersionMS: 0x00040009, productVersionLS: 0x00000388,
    fileOS: VOS__WINDOWS32, fileType: VFT_DLL,
};
const strings = { CompanyName: "Microsoft Corporation", FileVersion: "4.09.00.0904", ProductName: "DirectX" };

function wide(view: DataView, off: number, chars: number): string {
    let s = "";
    for (let i = 0; i < chars; i++) {
        const c = view.getUint16(off + i * 2, true);
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s;
}

describe("buildVersionInfoBlob / queryVersionValue", () => {
    const blob = buildVersionInfoBlob(fixed, strings);
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);

    test("root node spans the whole blob and carries VS_FIXEDFILEINFO", () => {
        const root = readVersionNode(view, 0)!;
        expect(root.key).toBe("VS_VERSION_INFO");
        expect(root.length).toBe(blob.length);
        expect(versionBlobLength(view, 0)).toBe(blob.length);
        const v = queryVersionValue(view, 0, "\\")!;
        expect(v.length).toBe(VS_FIXEDFILEINFO_SIZE);
        expect(view.getUint32(v.offset, true)).toBe(VS_FFI_SIGNATURE);
        expect(view.getUint32(v.offset + 8, true)).toBe(0x00040009);
        expect(view.getUint32(v.offset + 12, true)).toBe(0x00000388);
        expect(v.offset % 4).toBe(0);
    });

    test("Translation is a 4-byte binary value (lang | codepage<<16)", () => {
        const v = queryVersionValue(view, 0, "\\VarFileInfo\\Translation")!;
        expect(v.type).toBe(0);
        expect(v.length).toBe(4);
        expect(view.getUint32(v.offset, true)).toBe(0x04b00409);
    });

    test("StringFileInfo strings resolve case-insensitively, length counts the NUL", () => {
        const v = queryVersionValue(view, 0, "\\stringfileinfo\\040904b0\\productname")!;
        expect(v.type).toBe(1);
        expect(v.length).toBe("DirectX".length + 1);
        expect(wide(view, v.offset, v.length)).toBe("DirectX");
        expect(v.offset % 4).toBe(0);
        const cn = queryVersionValue(view, 0, "\\StringFileInfo\\040904B0\\CompanyName")!;
        expect(wide(view, cn.offset, cn.length)).toBe("Microsoft Corporation");
    });

    test("unknown keys and foreign blocks fail cleanly", () => {
        expect(queryVersionValue(view, 0, "\\StringFileInfo\\040904B0\\Nope")).toBeNull();
        expect(queryVersionValue(view, 0, "\\StringFileInfo\\041004B0\\ProductName")).toBeNull();
        const junk = new DataView(new ArrayBuffer(64));
        expect(queryVersionValue(junk, 0, "\\")).toBeNull();
    });

    test("walks a blob placed at a non-zero offset (guest pBlock)", () => {
        const buf = new Uint8Array(blob.length + 0x40);
        buf.set(blob, 0x20);
        const dv = new DataView(buf.buffer);
        const v = queryVersionValue(dv, 0x20, "\\StringFileInfo\\040904B0\\FileVersion")!;
        expect(wide(dv, v.offset, v.length)).toBe("4.09.00.0904");
    });
});

/** Minimal PE32 with one .rsrc section holding a single RT_VERSION/1/0x409 entry. */
function buildPeWithVersion(blob: Uint8Array): Uint8Array {
    const rsrcRva = 0x2000, rsrcRaw = 0x400;
    // Directory tree: type dir(16+8) → name dir(16+8) → lang dir(16+8) → data entry(16) → data
    const dirTree = 0x60;
    const dataOffInRsrc = dirTree;
    const rsrc = new Uint8Array(dataOffInRsrc + blob.length);
    const rv = new DataView(rsrc.buffer);
    // type dir: 1 id entry → subdir at 0x18
    rv.setUint16(14, 1, true); rv.setUint32(16, 16, true); rv.setUint32(20, 0x80000018, true);
    // name dir @0x18: 1 id entry (id 1) → subdir at 0x30
    rv.setUint16(0x18 + 14, 1, true); rv.setUint32(0x18 + 16, 1, true); rv.setUint32(0x18 + 20, 0x80000030, true);
    // lang dir @0x30: 1 id entry (0x409) → data entry at 0x48
    rv.setUint16(0x30 + 14, 1, true); rv.setUint32(0x30 + 16, 0x409, true); rv.setUint32(0x30 + 20, 0x48, true);
    // data entry @0x48: rva, size
    rv.setUint32(0x48, rsrcRva + dataOffInRsrc, true); rv.setUint32(0x4c, blob.length, true);
    rsrc.set(blob, dataOffInRsrc);

    const file = new Uint8Array(rsrcRaw + rsrc.length);
    const fv = new DataView(file.buffer);
    fv.setUint16(0, 0x5a4d, true);
    fv.setUint32(0x3c, 0x80, true);
    const pe = 0x80;
    fv.setUint32(pe, 0x00004550, true);
    fv.setUint16(pe + 6, 1, true);       // NumberOfSections
    fv.setUint16(pe + 20, 224, true);    // SizeOfOptionalHeader
    const opt = pe + 24;
    fv.setUint16(opt, 0x10b, true);
    fv.setUint32(opt + 112, rsrcRva, true);
    fv.setUint32(opt + 116, rsrc.length, true);
    const sec = opt + 224;
    file.set(new TextEncoder().encode(".rsrc"), sec);
    fv.setUint32(sec + 8, rsrc.length, true);   // VirtualSize
    fv.setUint32(sec + 12, rsrcRva, true);      // VirtualAddress
    fv.setUint32(sec + 16, rsrc.length, true);  // SizeOfRawData
    fv.setUint32(sec + 20, rsrcRaw, true);      // PointerToRawData
    file.set(rsrc, rsrcRaw);
    return file;
}

describe("findVersionResourceInFile", () => {
    test("extracts RT_VERSION through the section table", () => {
        const blob = buildVersionInfoBlob(fixed, strings);
        const out = findVersionResourceInFile(buildPeWithVersion(blob))!;
        expect(out).not.toBeNull();
        expect(Array.from(out)).toEqual(Array.from(blob));
    });

    test("returns null for non-PE bytes and for a PE without resources", () => {
        expect(findVersionResourceInFile(new Uint8Array(16))).toBeNull();
        const pe = buildPeWithVersion(buildVersionInfoBlob(fixed, strings));
        new DataView(pe.buffer).setUint32(0x80 + 24 + 112, 0, true);
        expect(findVersionResourceInFile(pe)).toBeNull();
    });
});
