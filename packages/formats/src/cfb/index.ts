/**
 * Microsoft Compound File Binary (MS-CFB) — the container behind OLE structured storage
 * (StgCreateDocfile/StgOpenStorage). Parses v3 (512-byte) and v4 (4096-byte) files and
 * writes v3, all in memory over a plain directory tree.
 */

export interface CfbEntry {
    name: string;
    type: 'storage' | 'stream' | 'root';
    clsid: Uint8Array;
    stateBits: number;
    ctime: bigint;
    mtime: bigint;
    data: Uint8Array;
    children: CfbEntry[];
}

export class CfbFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CfbFormatError';
    }
}

const SIGNATURE = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const MAXREGSECT = 0xFFFFFFFA;
const DIFSECT = 0xFFFFFFFC;
const FATSECT = 0xFFFFFFFD;
const ENDOFCHAIN = 0xFFFFFFFE;
const FREESECT = 0xFFFFFFFF;
const NOSTREAM = 0xFFFFFFFF;
const HEADER_DIFAT = 109;
const DIR_ENTRY = 128;
const MINI_SECTOR = 64;
const MINI_CUTOFF = 4096;
const SECTOR = 512;

const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;
const RED = 0;
const BLACK = 1;

export function isCfb(bytes: Uint8Array): boolean {
    if (bytes.length < 8) return false;
    for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return false;
    return true;
}

export function createCfbRoot(): CfbEntry {
    return {
        name: 'Root Entry', type: 'root', clsid: new Uint8Array(16), stateBits: 0,
        ctime: 0n, mtime: 0n, data: new Uint8Array(0), children: [],
    };
}

/** MS-CFB 2.6.4: shorter names sort first; equal lengths compare by simple uppercase. */
export function compareCfbNames(a: string, b: string): number {
    if (a.length !== b.length) return a.length - b.length;
    const ua = a.toUpperCase();
    const ub = b.toUpperCase();
    for (let i = 0; i < ua.length; i++) {
        const d = ua.charCodeAt(i) - ub.charCodeAt(i);
        if (d !== 0) return d;
    }
    return 0;
}

// ── Parse ────────────────────────────────────────────────────────────────────

export function parseCfb(bytes: Uint8Array): CfbEntry {
    if (bytes.length < SECTOR || !isCfb(bytes)) throw new CfbFormatError('not a compound file');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u32 = (off: number): number => view.getUint32(off, true);
    const major = view.getUint16(0x1A, true);
    const sectorShift = view.getUint16(0x1E, true);
    if (view.getUint16(0x1C, true) !== 0xFFFE) throw new CfbFormatError('bad byte order mark');
    if (!((major === 3 && sectorShift === 9) || (major === 4 && sectorShift === 12))) {
        throw new CfbFormatError(`unsupported version ${major} / sector shift ${sectorShift}`);
    }
    if (view.getUint16(0x20, true) !== 6) throw new CfbFormatError('bad mini sector shift');
    const sectorSize = 1 << sectorShift;
    const perSector = sectorSize / 4;
    const sectorCount = Math.ceil((bytes.length - sectorSize) / sectorSize);
    const cutoff = u32(0x38);

    const sectorOffset = (sect: number): number => {
        if (sect > MAXREGSECT || sect >= sectorCount) throw new CfbFormatError(`sector ${sect} out of range`);
        return (sect + 1) * sectorSize;
    };
    const readSector = (sect: number): Uint8Array => {
        const off = sectorOffset(sect);
        const out = new Uint8Array(sectorSize);
        out.set(bytes.subarray(off, Math.min(off + sectorSize, bytes.length)));
        return out;
    };

    // DIFAT: 109 header slots, then a chain of DIFAT sectors (last slot = next).
    const fatSectors: number[] = [];
    const numFat = u32(0x2C);
    for (let i = 0; i < HEADER_DIFAT && fatSectors.length < numFat; i++) fatSectors.push(u32(0x4C + i * 4));
    let difat = u32(0x44);
    for (let n = 0; fatSectors.length < numFat; n++) {
        if (difat === ENDOFCHAIN || difat === FREESECT || n > sectorCount) throw new CfbFormatError('truncated DIFAT');
        const off = sectorOffset(difat);
        for (let i = 0; i < perSector - 1 && fatSectors.length < numFat; i++) fatSectors.push(view.getUint32(off + i * 4, true));
        difat = view.getUint32(off + (perSector - 1) * 4, true);
    }

    const fat = new Uint32Array(fatSectors.length * perSector);
    fatSectors.forEach((sect, i) => {
        const s = readSector(sect);
        fat.set(new Uint32Array(s.buffer, 0, perSector), i * perSector);
    });

    const chain = (start: number, table: Uint32Array): number[] => {
        const out: number[] = [];
        for (let s = start; s !== ENDOFCHAIN; s = table[s]) {
            if (s >= table.length || out.length > table.length) throw new CfbFormatError(`broken chain at ${s}`);
            out.push(s);
        }
        return out;
    };
    const readChain = (start: number): Uint8Array => {
        if (start === ENDOFCHAIN || start === FREESECT) return new Uint8Array(0);
        const sects = chain(start, fat);
        const out = new Uint8Array(sects.length * sectorSize);
        sects.forEach((s, i) => out.set(readSector(s), i * sectorSize));
        return out;
    };

    const dir = readChain(u32(0x30));
    const dirView = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
    const entryCount = dir.length / DIR_ENTRY;
    if (entryCount < 1) throw new CfbFormatError('empty directory');

    const miniFatBytes = readChain(u32(0x3C)).subarray(0, u32(0x40) * sectorSize);
    const miniFat = new Uint32Array(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.length / 4);
    const rootOff = 0;
    if (dir[rootOff + 0x42] !== TYPE_ROOT) throw new CfbFormatError('first directory entry is not the root');
    const miniStream = readChain(dirView.getUint32(rootOff + 0x74, true));

    const readEntry = (index: number, isRoot: boolean): CfbEntry => {
        const off = index * DIR_ENTRY;
        const nameLen = dirView.getUint16(off + 0x40, true);
        if (nameLen > 64 || nameLen % 2 !== 0) throw new CfbFormatError(`bad name length in entry ${index}`);
        let name = '';
        for (let i = 0; i < nameLen / 2 - 1; i++) name += String.fromCharCode(dirView.getUint16(off + i * 2, true));
        const type = dir[off + 0x42];
        const size = dirView.getUint32(off + 0x78, true) + (major === 4 ? dirView.getUint32(off + 0x7C, true) * 0x100000000 : 0);
        const start = dirView.getUint32(off + 0x74, true);
        let data: Uint8Array = new Uint8Array(0);
        if (type === TYPE_STREAM && size > 0) {
            if (size < cutoff) {
                const sects = chain(start, miniFat);
                data = new Uint8Array(sects.length * MINI_SECTOR);
                sects.forEach((s, i) => {
                    if ((s + 1) * MINI_SECTOR > miniStream.length) throw new CfbFormatError(`mini sector ${s} out of range`);
                    data.set(miniStream.subarray(s * MINI_SECTOR, (s + 1) * MINI_SECTOR), i * MINI_SECTOR);
                });
            } else {
                data = readChain(start);
            }
            if (data.length < size) throw new CfbFormatError(`stream "${name}" shorter than its size`);
            data = data.slice(0, size);
        }
        return {
            name,
            type: isRoot ? 'root' : type === TYPE_STORAGE ? 'storage' : 'stream',
            clsid: dir.slice(off + 0x50, off + 0x60),
            stateBits: dirView.getUint32(off + 0x60, true),
            ctime: dirView.getBigUint64(off + 0x64, true),
            mtime: dirView.getBigUint64(off + 0x6C, true),
            data,
            children: [],
        };
    };

    const visited = new Set<number>();
    const fill = (entry: CfbEntry, index: number): void => {
        const walk = (node: number): void => {
            if (node === NOSTREAM) return;
            if (node >= entryCount || visited.has(node)) throw new CfbFormatError(`bad directory link ${node}`);
            visited.add(node);
            const off = node * DIR_ENTRY;
            walk(dirView.getUint32(off + 0x44, true));
            const type = dir[off + 0x42];
            if (type === TYPE_STORAGE || type === TYPE_STREAM) {
                const child = readEntry(node, false);
                entry.children.push(child);
                if (type === TYPE_STORAGE) fill(child, node);
            }
            walk(dirView.getUint32(off + 0x48, true));
        };
        walk(dirView.getUint32(index * DIR_ENTRY + 0x4C, true));
    };
    visited.add(0);
    const root = readEntry(0, true);
    fill(root, 0);
    return root;
}

// ── Serialize ────────────────────────────────────────────────────────────────

interface DirSlot {
    entry: CfbEntry;
    left: number;
    right: number;
    child: number;
    color: number;
    start: number;
    size: number;
}

/**
 * Children become a size-balanced BST (midpoint splits), so every level but the deepest
 * is full; colouring exactly the deepest level red when it is incomplete gives every
 * root-to-nil path the same black count — a valid red-black tree.
 */
function buildSiblingTree(slots: DirSlot[], indices: number[]): number {
    if (indices.length === 0) return NOSTREAM;
    const depthOf = new Map<number, number>();
    let maxDepth = 0;
    const build = (lo: number, hi: number, depth: number): number => {
        if (lo > hi) return NOSTREAM;
        const mid = (lo + hi) >> 1;
        const idx = indices[mid];
        depthOf.set(idx, depth);
        maxDepth = Math.max(maxDepth, depth);
        slots[idx].left = build(lo, mid - 1, depth + 1);
        slots[idx].right = build(mid + 1, hi, depth + 1);
        return idx;
    };
    const top = build(0, indices.length - 1, 0);
    const complete = indices.length === 2 ** (maxDepth + 1) - 1;
    for (const idx of indices) slots[idx].color = !complete && depthOf.get(idx) === maxDepth ? RED : BLACK;
    return top;
}

export function serializeCfb(root: CfbEntry): Uint8Array {
    const slots: DirSlot[] = [];
    const add = (entry: CfbEntry): number => {
        slots.push({ entry, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, color: BLACK, start: ENDOFCHAIN, size: 0 });
        return slots.length - 1;
    };
    const addTree = (entry: CfbEntry, index: number): void => {
        const sorted = [...entry.children].sort((a, b) => compareCfbNames(a.name, b.name));
        const childIdx = sorted.map(add);
        slots[index].child = buildSiblingTree(slots, childIdx);
        sorted.forEach((c, i) => { if (c.type !== 'stream') addTree(c, childIdx[i]); });
    };
    addTree(root, add(root));

    // Mini stream: small streams packed in 64-byte mini sectors.
    const miniFat: number[] = [];
    const miniChunks: Uint8Array[] = [];
    const largeStreams: DirSlot[] = [];
    for (const slot of slots) {
        if (slot.entry.type !== 'stream') { slot.start = slot.entry.type === 'root' ? ENDOFCHAIN : 0; continue; }
        const data = slot.entry.data;
        slot.size = data.length;
        if (data.length === 0) { slot.start = ENDOFCHAIN; continue; }
        if (data.length >= MINI_CUTOFF) { largeStreams.push(slot); continue; }
        const n = Math.ceil(data.length / MINI_SECTOR);
        slot.start = miniFat.length;
        for (let i = 0; i < n; i++) miniFat.push(i === n - 1 ? ENDOFCHAIN : miniFat.length + 1);
        miniChunks.push(data);
    }
    const miniStreamSize = miniFat.length * MINI_SECTOR;

    const sectorsFor = (bytes: number): number => Math.ceil(bytes / SECTOR);
    const dirSectors = sectorsFor(slots.length * DIR_ENTRY);
    const miniFatSectors = sectorsFor(miniFat.length * 4);
    const miniStreamSectors = sectorsFor(miniStreamSize);
    const largeSectors = largeStreams.reduce((n, s) => n + sectorsFor(s.entry.data.length), 0);
    const dataSectors = dirSectors + miniFatSectors + miniStreamSectors + largeSectors;
    let fatSectors = 1;
    let difatSectors = 0;
    for (;;) {
        difatSectors = fatSectors > HEADER_DIFAT ? Math.ceil((fatSectors - HEADER_DIFAT) / (SECTOR / 4 - 1)) : 0;
        if ((dataSectors + fatSectors + difatSectors) <= fatSectors * (SECTOR / 4)) break;
        fatSectors++;
    }
    const total = dataSectors + fatSectors + difatSectors;
    const fat = new Uint32Array(fatSectors * (SECTOR / 4)).fill(FREESECT);
    let next = 0;
    const allocChain = (count: number): number => {
        if (count === 0) return ENDOFCHAIN;
        const start = next;
        for (let i = 0; i < count; i++) fat[next + i] = i === count - 1 ? ENDOFCHAIN : next + i + 1;
        next += count;
        return start;
    };

    const out = new Uint8Array((1 + total) * SECTOR);
    const view = new DataView(out.buffer);
    const sectorOff = (s: number): number => (s + 1) * SECTOR;

    const dirStart = allocChain(dirSectors);
    const miniFatStart = allocChain(miniFatSectors);
    const miniStreamStart = allocChain(miniStreamSectors);
    slots[0].start = miniStreamStart;
    slots[0].size = miniStreamSize;
    let miniOff = sectorOff(miniStreamStart);
    for (const chunk of miniChunks) {
        out.set(chunk, miniOff);
        miniOff += Math.ceil(chunk.length / MINI_SECTOR) * MINI_SECTOR;
    }
    miniFat.forEach((v, i) => view.setUint32(sectorOff(miniFatStart) + i * 4, v, true));
    for (let i = miniFat.length; i < miniFatSectors * (SECTOR / 4); i++) {
        view.setUint32(sectorOff(miniFatStart) + i * 4, FREESECT, true);
    }
    for (const slot of largeStreams) {
        slot.start = allocChain(sectorsFor(slot.entry.data.length));
        out.set(slot.entry.data, sectorOff(slot.start));
    }
    const fatStart = next;
    for (let i = 0; i < fatSectors; i++) fat[next++] = FATSECT;
    const difatStart = next;
    for (let i = 0; i < difatSectors; i++) fat[next++] = DIFSECT;

    // Directory (all sectors contiguous from dirStart).
    const dirBase = sectorOff(dirStart);
    for (let i = 0; i < dirSectors * (SECTOR / DIR_ENTRY); i++) {
        const off = dirBase + i * DIR_ENTRY;
        const slot = slots[i];
        if (!slot) {
            view.setUint32(off + 0x44, NOSTREAM, true);
            view.setUint32(off + 0x48, NOSTREAM, true);
            view.setUint32(off + 0x4C, NOSTREAM, true);
            continue;
        }
        const e = slot.entry;
        const name = e.type === 'root' ? 'Root Entry' : e.name;
        if (name.length > 31) throw new CfbFormatError(`name too long: ${name}`);
        for (let c = 0; c < name.length; c++) view.setUint16(off + c * 2, name.charCodeAt(c), true);
        view.setUint16(off + 0x40, (name.length + 1) * 2, true);
        out[off + 0x42] = e.type === 'root' ? TYPE_ROOT : e.type === 'storage' ? TYPE_STORAGE : TYPE_STREAM;
        out[off + 0x43] = slot.color;
        view.setUint32(off + 0x44, slot.left, true);
        view.setUint32(off + 0x48, slot.right, true);
        view.setUint32(off + 0x4C, slot.child, true);
        out.set(e.clsid.subarray(0, 16), off + 0x50);
        view.setUint32(off + 0x60, e.stateBits >>> 0, true);
        if (e.type !== 'root') {
            view.setBigUint64(off + 0x64, e.ctime, true);
        }
        view.setBigUint64(off + 0x6C, e.mtime, true);
        view.setUint32(off + 0x74, slot.start, true);
        view.setUint32(off + 0x78, slot.size, true);
    }

    fat.forEach((v, i) => view.setUint32(sectorOff(fatStart) + i * 4, v, true));

    // Header.
    out.set(SIGNATURE, 0);
    view.setUint16(0x18, 0x3E, true);
    view.setUint16(0x1A, 3, true);
    view.setUint16(0x1C, 0xFFFE, true);
    view.setUint16(0x1E, 9, true);
    view.setUint16(0x20, 6, true);
    view.setUint32(0x2C, fatSectors, true);
    view.setUint32(0x30, dirStart, true);
    view.setUint32(0x38, MINI_CUTOFF, true);
    view.setUint32(0x3C, miniFatSectors ? miniFatStart : ENDOFCHAIN, true);
    view.setUint32(0x40, miniFatSectors, true);
    view.setUint32(0x44, difatSectors ? difatStart : ENDOFCHAIN, true);
    view.setUint32(0x48, difatSectors, true);
    for (let i = 0; i < HEADER_DIFAT; i++) {
        view.setUint32(0x4C + i * 4, i < fatSectors ? fatStart + i : FREESECT, true);
    }
    const perDifat = SECTOR / 4 - 1;
    for (let d = 0; d < difatSectors; d++) {
        const off = sectorOff(difatStart + d);
        for (let i = 0; i < perDifat; i++) {
            const f = HEADER_DIFAT + d * perDifat + i;
            view.setUint32(off + i * 4, f < fatSectors ? fatStart + f : FREESECT, true);
        }
        view.setUint32(off + perDifat * 4, d === difatSectors - 1 ? ENDOFCHAIN : difatStart + d + 1, true);
    }
    return out;
}
