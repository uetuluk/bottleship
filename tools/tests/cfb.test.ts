/** MS-CFB compound file core: v3 writer, v3/v4 reader, directory tree invariants. */
import { describe, expect, test } from "bun:test";
import {
    compareCfbNames, createCfbRoot, isCfb, parseCfb, serializeCfb, CfbFormatError, type CfbEntry,
} from "../../packages/formats/src/cfb/index";

function stream(name: string, size: number, seed = 1): CfbEntry {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = (i * 31 + seed) & 0xff;
    return { name, type: "stream", clsid: new Uint8Array(16), stateBits: 0, ctime: 0n, mtime: 0n, data, children: [] };
}

function storage(name: string, children: CfbEntry[]): CfbEntry {
    const clsid = new Uint8Array(16).map((_, i) => i + 1);
    return { name, type: "storage", clsid, stateBits: 7, ctime: 123n, mtime: 456n, data: new Uint8Array(0), children };
}

function shape(e: CfbEntry): unknown {
    return {
        name: e.name, type: e.type, clsid: [...e.clsid], data: [...e.data],
        children: [...e.children].sort((a, b) => compareCfbNames(a.name, b.name)).map(shape),
    };
}

describe("CFB round trip", () => {
    test("nested storage, mini-stream, cutoff and large streams survive serialize → parse", () => {
        const root = createCfbRoot();
        root.children.push(
            stream("Small", 10),
            stream("Exactly4096", 4096, 2),
            stream("Large", 10000, 3),
            stream("Empty", 0),
            storage("Sub", [stream("Inner", 100, 4), storage("Deeper", [stream("Leaf", 5000, 5)])]),
        );
        const bytes = serializeCfb(root);
        expect(bytes.length % 512).toBe(0);
        const back = parseCfb(bytes);
        expect(shape(back)).toEqual(shape(root));
        const sub = back.children.find((c) => c.name === "Sub")!;
        expect(sub.stateBits).toBe(7);
        expect(sub.ctime).toBe(123n);
        expect(sub.mtime).toBe(456n);
    });

    test("an empty root is a valid file", () => {
        const back = parseCfb(serializeCfb(createCfbRoot()));
        expect(back.type).toBe("root");
        expect(back.children).toEqual([]);
    });

    test("header fields are MS-CFB v3", () => {
        const bytes = serializeCfb(createCfbRoot());
        const v = new DataView(bytes.buffer);
        expect([...bytes.subarray(0, 8)]).toEqual([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        expect(v.getUint16(0x18, true)).toBe(0x3e);
        expect(v.getUint16(0x1a, true)).toBe(3);
        expect(v.getUint16(0x1c, true)).toBe(0xfffe);
        expect(v.getUint16(0x1e, true)).toBe(9);
        expect(v.getUint16(0x20, true)).toBe(6);
        expect(v.getUint32(0x28, true)).toBe(0);
        expect(v.getUint32(0x38, true)).toBe(4096);
    });

    test("many siblings form a valid red-black tree ordered by CFB name compare", () => {
        const root = createCfbRoot();
        for (let i = 0; i < 50; i++) root.children.push(stream(`S${"x".repeat(i % 7)}${i}`, i * 13, i));
        const bytes = serializeCfb(root);
        expect(shape(parseCfb(bytes))).toEqual(shape(root));

        // Walk the raw directory: BST order + no red-red + equal black height.
        const v = new DataView(bytes.buffer);
        const dirBase = (v.getUint32(0x30, true) + 1) * 512; // directory is contiguous in our writer
        const at = (i: number) => dirBase + i * 128;
        const name = (i: number) => {
            let s = "";
            const n = v.getUint16(at(i) + 0x40, true) / 2 - 1;
            for (let c = 0; c < n; c++) s += String.fromCharCode(v.getUint16(at(i) + c * 2, true));
            return s;
        };
        const blackHeight = (i: number, parentRed: boolean): number => {
            if (i === 0xffffffff) return 1;
            const red = bytes[at(i) + 0x43] === 0;
            expect(red && parentRed).toBe(false);
            const l = v.getUint32(at(i) + 0x44, true);
            const r = v.getUint32(at(i) + 0x48, true);
            if (l !== 0xffffffff) expect(compareCfbNames(name(l), name(i))).toBeLessThan(0);
            if (r !== 0xffffffff) expect(compareCfbNames(name(r), name(i))).toBeGreaterThan(0);
            const hl = blackHeight(l, red);
            expect(blackHeight(r, red)).toBe(hl);
            return hl + (red ? 0 : 1);
        };
        const top = v.getUint32(at(0) + 0x4c, true);
        expect(bytes[at(top) + 0x43]).toBe(1);
        blackHeight(top, false);
    });

    test("a file needing DIFAT sectors (>109 FAT sectors) round-trips", () => {
        const root = createCfbRoot();
        root.children.push(stream("Huge", 110 * 128 * 512, 9));
        const bytes = serializeCfb(root);
        const v = new DataView(bytes.buffer);
        expect(v.getUint32(0x2c, true)).toBeGreaterThan(109);
        expect(v.getUint32(0x48, true)).toBeGreaterThan(0);
        const back = parseCfb(bytes);
        expect(back.children[0].data.length).toBe(110 * 128 * 512);
        expect(back.children[0].data[12345]).toBe((12345 * 31 + 9) & 0xff);
    });
});

describe("CFB reader validation", () => {
    test("isCfb checks the signature", () => {
        expect(isCfb(serializeCfb(createCfbRoot()))).toBe(true);
        expect(isCfb(new Uint8Array(512))).toBe(false);
    });

    test("garbage and corrupted chains throw CfbFormatError", () => {
        expect(() => parseCfb(new Uint8Array(1024))).toThrow(CfbFormatError);
        const root = createCfbRoot();
        root.children.push(stream("Large", 10000));
        const bytes = serializeCfb(root);
        const v = new DataView(bytes.buffer);
        v.setUint32(0x30, 0x7fffff, true); // directory start out of range
        expect(() => parseCfb(bytes)).toThrow(CfbFormatError);
    });

    test("a FAT cycle is detected", () => {
        const root = createCfbRoot();
        root.children.push(stream("Large", 10000));
        const bytes = serializeCfb(root);
        const v = new DataView(bytes.buffer);
        const fatOff = (v.getUint32(0x4c, true) + 1) * 512;
        // Point the large stream's first sector at itself.
        const dirBase = (v.getUint32(0x30, true) + 1) * 512;
        const start = v.getUint32(dirBase + 128 + 0x74, true);
        v.setUint32(fatOff + start * 4, start, true);
        expect(() => parseCfb(bytes)).toThrow(CfbFormatError);
    });
});
