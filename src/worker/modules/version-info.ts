/**
 * VS_VERSIONINFO (RT_VERSION resource) codec — pure, no System dependency.
 *
 * GetFileVersionInfo hands the app the raw resource blob; VerQueryValue walks it.
 * Node layout (each node 32-bit aligned): WORD wLength, WORD wValueLength, WORD wType
 * (0 = binary, 1 = text), WCHAR szKey[] + NUL, pad, value, pad, children until wLength.
 */

export const VS_FFI_SIGNATURE = 0xfeef04bd;
export const VS_FIXEDFILEINFO_SIZE = 52;
const VS_FFI_STRUCVERSION = 0x00010000;
const VS_FFI_FILEFLAGSMASK = 0x3f;

export const VOS__WINDOWS32 = 0x00000004;
export const VOS_NT_WINDOWS32 = 0x00040004;
export const VFT_UNKNOWN = 0;
export const VFT_APP = 1;
export const VFT_DLL = 2;
export const VFT_DRV = 3;

export interface FixedFileInfo {
    fileVersionMS: number;
    fileVersionLS: number;
    productVersionMS: number;
    productVersionLS: number;
    fileOS: number;
    fileType: number;
    fileSubtype?: number;
    fileFlags?: number;
}

export interface VersionNode {
    offset: number;
    length: number;
    valueLength: number;
    type: number;
    key: string;
    valueOffset: number;
    /** Offset of the first child (already 4-byte aligned); === end when childless. */
    childrenOffset: number;
    end: number;
}

export interface VersionValue {
    offset: number;
    /** Characters for text values (NUL included, as the RC compiler stores it), bytes otherwise. */
    length: number;
    type: number;
}

const align4 = (n: number): number => (n + 3) & ~3;

const encodeUtf16z = (s: string): Uint8Array => {
    const out = new Uint8Array((s.length + 1) * 2);
    const view = new DataView(out.buffer);
    for (let i = 0; i < s.length; i++) view.setUint16(i * 2, s.charCodeAt(i), true);
    return out;
};

/** Serialize one node: header + key + pad + value + pad + children; returns the padded byte image. */
function packNode(key: string, type: number, value: Uint8Array, valueLength: number, children: Uint8Array[]): Uint8Array {
    const keyBytes = encodeUtf16z(key);
    const headerLen = 6 + keyBytes.length;
    const valueStart = align4(headerLen);
    const childStart = align4(valueStart + value.length);
    let total = childStart;
    for (const c of children) total = align4(total) + c.length;
    const out = new Uint8Array(align4(total));
    const view = new DataView(out.buffer);
    view.setUint16(0, total, true);
    view.setUint16(2, valueLength, true);
    view.setUint16(4, type, true);
    out.set(keyBytes, 6);
    out.set(value, valueStart);
    let off = childStart;
    for (const c of children) {
        off = align4(off);
        out.set(c, off);
        off += c.length;
    }
    return out;
}

export function packFixedFileInfo(fixed: FixedFileInfo): Uint8Array {
    const out = new Uint8Array(VS_FIXEDFILEINFO_SIZE);
    const v = new DataView(out.buffer);
    const words = [
        VS_FFI_SIGNATURE, VS_FFI_STRUCVERSION,
        fixed.fileVersionMS >>> 0, fixed.fileVersionLS >>> 0,
        fixed.productVersionMS >>> 0, fixed.productVersionLS >>> 0,
        VS_FFI_FILEFLAGSMASK, (fixed.fileFlags ?? 0) >>> 0,
        fixed.fileOS >>> 0, fixed.fileType >>> 0, (fixed.fileSubtype ?? 0) >>> 0,
        0, 0,
    ];
    words.forEach((w, i) => v.setUint32(i * 4, w, true));
    return out;
}

/** Build a complete VS_VERSIONINFO blob with one StringTable and a matching Translation. */
export function buildVersionInfoBlob(
    fixed: FixedFileInfo,
    strings: Record<string, string>,
    langId = 0x0409,
    codePage = 0x04b0,
): Uint8Array {
    const tableKey = ((langId << 16) | codePage).toString(16).toUpperCase().padStart(8, "0");
    const stringNodes = Object.entries(strings).map(([k, s]) =>
        packNode(k, 1, encodeUtf16z(s), s.length + 1, []));
    const stringTable = packNode(tableKey, 1, new Uint8Array(0), 0, stringNodes);
    const stringFileInfo = packNode("StringFileInfo", 1, new Uint8Array(0), 0, [stringTable]);
    const translation = new Uint8Array(4);
    new DataView(translation.buffer).setUint32(0, ((codePage << 16) | langId) >>> 0, true);
    const varNode = packNode("Translation", 0, translation, 4, []);
    const varFileInfo = packNode("VarFileInfo", 1, new Uint8Array(0), 0, [varNode]);
    return packNode("VS_VERSION_INFO", 0, packFixedFileInfo(fixed), VS_FIXEDFILEINFO_SIZE,
        [stringFileInfo, varFileInfo]);
}

const MAX_KEY_CHARS = 256;

/** Parse the node at `offset`; null when the header is out of range or self-inconsistent. */
export function readVersionNode(view: DataView, offset: number, limit = view.byteLength): VersionNode | null {
    if (offset < 0 || offset + 6 > limit) return null;
    const length = view.getUint16(offset, true);
    const valueLength = view.getUint16(offset + 2, true);
    const type = view.getUint16(offset + 4, true);
    if (length < 6 || offset + length > limit) return null;
    const end = offset + length;
    let key = "";
    let p = offset + 6;
    for (let i = 0; i < MAX_KEY_CHARS; i++) {
        if (p + 2 > end) return null;
        const ch = view.getUint16(p, true);
        p += 2;
        if (ch === 0) break;
        key += String.fromCharCode(ch);
    }
    const valueOffset = align4(p);
    // Text values count characters; binary values count bytes.
    const valueBytes = type === 1 ? valueLength * 2 : valueLength;
    const childrenOffset = Math.min(align4(valueOffset + valueBytes), end);
    return { offset, length, valueLength, type, key, valueOffset, childrenOffset, end };
}

const MAX_CHILDREN = 512;

function findChild(view: DataView, parent: VersionNode, key: string): VersionNode | null {
    const want = key.toLowerCase();
    let off = parent.childrenOffset;
    for (let i = 0; i < MAX_CHILDREN && off + 6 <= parent.end; i++) {
        const child = readVersionNode(view, off, parent.end);
        if (!child) return null;
        if (child.key.toLowerCase() === want) return child;
        off = align4(child.end);
    }
    return null;
}

/**
 * Resolve a VerQueryValue sub-block ("\", "\VarFileInfo\Translation",
 * "\StringFileInfo\040904B0\ProductName") against the blob at `blockOffset`.
 */
export function queryVersionValue(view: DataView, blockOffset: number, subBlock: string): VersionValue | null {
    const root = readVersionNode(view, blockOffset);
    if (!root || root.key !== "VS_VERSION_INFO") return null;
    const parts = subBlock.split("\\").filter((s) => s.length > 0);
    let node: VersionNode = root;
    for (const part of parts) {
        const next = findChild(view, node, part);
        if (!next) return null;
        node = next;
    }
    if (node === root) {
        if (root.valueLength < VS_FIXEDFILEINFO_SIZE) return null;
        return { offset: root.valueOffset, length: root.valueLength, type: 0 };
    }
    if (node.type === 1) {
        // Some linkers store 0 for empty strings; fall back to the bytes actually present.
        const chars = node.valueLength > 0 ? node.valueLength : (node.end - node.valueOffset) >> 1;
        return { offset: node.valueOffset, length: chars, type: 1 };
    }
    return { offset: node.valueOffset, length: node.valueLength, type: 0 };
}

/** Round-trip helper: total blob bytes of the VS_VERSIONINFO at `blockOffset`, 0 if malformed. */
export function versionBlobLength(view: DataView, blockOffset: number): number {
    const root = readVersionNode(view, blockOffset);
    return root && root.key === "VS_VERSION_INFO" ? root.length : 0;
}

const RT_VERSION = 16;

/** Map an RVA to a file offset through the section table; null when unmapped. */
function rvaToFileOffset(view: DataView, sectionTable: number, sectionCount: number, rva: number): number | null {
    for (let i = 0; i < sectionCount; i++) {
        const sec = sectionTable + i * 40;
        if (sec + 40 > view.byteLength) return null;
        const virtualSize = view.getUint32(sec + 8, true);
        const virtualAddress = view.getUint32(sec + 12, true);
        const rawSize = view.getUint32(sec + 16, true);
        const rawPointer = view.getUint32(sec + 20, true);
        const span = Math.max(virtualSize, rawSize);
        if (rva >= virtualAddress && rva < virtualAddress + span) {
            return rawPointer + (rva - virtualAddress);
        }
    }
    return null;
}

function firstEntry(view: DataView, dirOffset: number, id: number | null): number | null {
    if (dirOffset + 16 > view.byteLength) return null;
    const named = view.getUint16(dirOffset + 12, true);
    const ids = view.getUint16(dirOffset + 14, true);
    const count = named + ids;
    for (let i = 0; i < count; i++) {
        const e = dirOffset + 16 + i * 8;
        if (e + 8 > view.byteLength) return null;
        const nameOrId = view.getUint32(e, true);
        if (id === null || ((nameOrId & 0x80000000) === 0 && (nameOrId & 0xffff) === id)) {
            return view.getUint32(e + 4, true);
        }
    }
    return null;
}

/**
 * Extract the first RT_VERSION resource from an on-disk PE image (not a mapped one:
 * directory offsets are translated through the section table). Null when absent.
 */
export function findVersionResourceInFile(bytes: Uint8Array): Uint8Array | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 0x40 || view.getUint16(0, true) !== 0x5a4d) return null;
    const pe = view.getUint32(0x3c, true);
    if (pe + 24 + 96 + 8 * 3 > bytes.length || view.getUint32(pe, true) !== 0x00004550) return null;
    const sectionCount = view.getUint16(pe + 6, true);
    const optSize = view.getUint16(pe + 20, true);
    const opt = pe + 24;
    if (view.getUint16(opt, true) !== 0x10b) return null;
    const resourceRva = view.getUint32(opt + 112, true);
    if (resourceRva === 0) return null;
    const sectionTable = opt + optSize;
    const resDir = rvaToFileOffset(view, sectionTable, sectionCount, resourceRva);
    if (resDir === null) return null;

    const typeEntry = firstEntry(view, resDir, RT_VERSION);
    if (typeEntry === null || (typeEntry & 0x80000000) === 0) return null;
    const nameEntry = firstEntry(view, resDir + (typeEntry & 0x7fffffff), null);
    if (nameEntry === null || (nameEntry & 0x80000000) === 0) return null;
    const langEntry = firstEntry(view, resDir + (nameEntry & 0x7fffffff), null);
    if (langEntry === null || (langEntry & 0x80000000) !== 0) return null;
    const dataEntry = resDir + langEntry;
    if (dataEntry + 16 > bytes.length) return null;
    const dataRva = view.getUint32(dataEntry, true);
    const size = view.getUint32(dataEntry + 4, true);
    const dataOff = rvaToFileOffset(view, sectionTable, sectionCount, dataRva);
    if (dataOff === null || size < 6 || dataOff + size > bytes.length) return null;
    return bytes.slice(dataOff, dataOff + size);
}

/** Copy the RT_VERSION blob out of a mapped (in-memory) image given its data RVA + size. */
export function sliceMappedResource(mem: Uint8Array, moduleBase: number, dataRva: number, size: number): Uint8Array | null {
    const start = (moduleBase + dataRva) >>> 0;
    if (size < 6 || start + size > mem.length) return null;
    return mem.slice(start, start + size);
}
