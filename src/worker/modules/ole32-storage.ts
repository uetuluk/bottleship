/**
 * OLE structured storage: compound files ("docfiles") behind StgCreateDocfile /
 * StgOpenStorage, exposed as IStorage / IStream / IEnumSTATSTG over an in-memory CFB tree
 * that is serialized to the VFS on Commit and when the last object of the file goes away
 * (direct mode) — transacted opens persist only on Commit.
 */
import { createCfbRoot, parseCfb, serializeCfb, isCfb, CfbFormatError, type CfbEntry } from '@bottleship/formats/cfb';
import type { Process } from '../core/process';
import type { ThunkImplementation, ThunkResult } from '../core/thunking/thunk-dispatcher';
import { System } from '../core/system';
import { Logger, LogCategory } from '../core/logger';
import { Marshaler } from '../core/memory/marshaler';
import { Mem } from '../core/memory/mem-accessor';
import { allocateComObject, freeComObject } from '../core/com/com-memory';
import { installComVtable, type ComVtableMethod } from '../core/com/install-com-vtable';
import { comCall, runGuestCallChain, type GuestCallChain } from '../core/com/guest-call-chain';

const S_OK = 0;
const S_FALSE = 1;
const E_NOINTERFACE = 0x80004002;
const E_INVALIDARG = 0x80070057;
const REGDB_E_CLASSNOTREG = 0x80040154;
const STG_E_INVALIDFUNCTION = 0x80030001;
const STG_E_FILENOTFOUND = 0x80030002;
const STG_E_ACCESSDENIED = 0x80030005;
const STG_E_INVALIDPOINTER = 0x80030009;
const STG_E_WRITEFAULT = 0x8003001D;
const STG_E_READFAULT = 0x8003001E;
const STG_E_FILEALREADYEXISTS = 0x80030050;
const STG_E_INVALIDPARAMETER = 0x80030057;
const STG_E_MEDIUMFULL = 0x80030070;
const STG_E_INVALIDNAME = 0x800300FC;

const STGM_ACCESS_MASK = 0x3;
const STGM_TRANSACTED = 0x00010000;
const STGM_CREATE = 0x00001000;
const STGM_DELETEONRELEASE = 0x04000000;
const STGTY_STORAGE = 1;
const STGTY_STREAM = 2;
const STATFLAG_NONAME = 1;
const STREAM_SEEK_END = 2;
const STGMOVE_COPY = 1;

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const CREATE_ALWAYS = 2;

const STATSTG_SIZE = 72;
const MAX_NAME = 31;

const IID_IUNKNOWN = '00000000-0000-0000-c000-000000000046';
const IID_ISTORAGE = '0000000b-0000-0000-c000-000000000046';
const IID_ISTREAM = '0000000c-0000-0000-c000-000000000046';
const IID_ISEQUENTIALSTREAM = '0c733a30-2a1c-11ce-ade5-00aa0044773a';
const IID_IENUMSTATSTG = '0000000d-0000-0000-c000-000000000046';
const IID_IPERSISTSTREAM = '00000109-0000-0000-c000-000000000046';

// IStream / IPersistStream / IClassFactory vtable slots used on guest objects.
const SLOT_QI = 0;
const SLOT_RELEASE = 2;
const SLOT_STREAM_READ = 3;
const SLOT_STREAM_WRITE = 4;
const SLOT_FACTORY_CREATEINSTANCE = 3;
const SLOT_PERSIST_GETCLASSID = 3;
const SLOT_PERSIST_LOAD = 5;
const SLOT_PERSIST_SAVE = 6;

interface DocFile {
    path: string;
    root: CfbEntry;
    writable: boolean;
    transacted: boolean;
    deleteOnRelease: boolean;
    dirty: boolean;
    /** Live IStorage/IStream objects on this file; the file closes at zero. */
    openObjects: number;
    /** Last committed image, for IStorage::Revert on a transacted open. */
    committed: Uint8Array | null;
}

interface StorageObj { kind: 'storage'; refCount: number; doc: DocFile; entry: CfbEntry; mode: number }
interface StreamObj { kind: 'stream'; refCount: number; doc: DocFile; entry: CfbEntry; mode: number; pos: number }
interface EnumObj { kind: 'enum'; refCount: number; items: CfbEntry[]; index: number }
type StgObj = StorageObj | StreamObj | EnumObj;

/** Guest object address → state. */
const objects = new Map<number, StgObj>();
/** Growable backing store per stream; entry.data is the live-length view into it. */
const streamBuffers = new WeakMap<CfbEntry, Uint8Array>();
let vtables: { storage: number; stream: number; enumStat: number } | null = null;
let tempCounter = 0;

export function resetStructuredStorage(): void {
    objects.clear();
    vtables = null;
    tempCounter = 0;
}

export function isHleStream(ptr: number): boolean {
    return objects.get(ptr >>> 0)?.kind === 'stream';
}

// ── helpers ─────────────────────────────────────────────────────────────────

function guid(mem: Uint8Array, ptr: number): string {
    const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const h = (n: number, w: number) => n.toString(16).padStart(w, '0');
    const tail = Array.from(mem.subarray(ptr + 8, ptr + 16), (b) => h(b, 2)).join('');
    return `${h(v.getUint32(ptr, true), 8)}-${h(v.getUint16(ptr + 4, true), 4)}-${h(v.getUint16(ptr + 6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}`;
}

function nowFileTime(): bigint {
    return (BigInt(Date.now()) + 11644473600000n) * 10000n;
}

function readName(mem: Uint8Array, ptr: number): string | null {
    if (!ptr) return null;
    const name = Marshaler.readWideString(mem, ptr);
    if (!name || name.length > MAX_NAME || /[\\/:!]/.test(name)) return null;
    return name;
}

function sameName(a: string, b: string): boolean {
    return a.length === b.length && a.toUpperCase() === b.toUpperCase();
}

function findChild(entry: CfbEntry, name: string): CfbEntry | undefined {
    return entry.children.find((c) => sameName(c.name, name));
}

function newEntry(name: string, type: 'storage' | 'stream'): CfbEntry {
    const t = type === 'storage' ? nowFileTime() : 0n;
    return { name, type, clsid: new Uint8Array(16), stateBits: 0, ctime: t, mtime: t, data: new Uint8Array(0), children: [] };
}

function cloneEntry(e: CfbEntry): CfbEntry {
    return { ...e, clsid: e.clsid.slice(), data: e.data.slice(), children: e.children.map(cloneEntry) };
}

function setStreamSize(entry: CfbEntry, size: number): void {
    let buf = streamBuffers.get(entry) ?? entry.data;
    if (size > buf.length) {
        const grown = new Uint8Array(Math.max(size, buf.length * 2, 256));
        grown.set(entry.data);
        buf = grown;
    } else if (size > entry.data.length) {
        buf.fill(0, entry.data.length, size);
    }
    streamBuffers.set(entry, buf);
    entry.data = buf.subarray(0, size);
}

function writable(mode: number): boolean {
    return (mode & STGM_ACCESS_MASK) !== 0;
}

function readable(mode: number): boolean {
    return (mode & STGM_ACCESS_MASK) !== 1;
}

function out32(ptr: number, value: number): void {
    if (ptr) Mem.writeUint32(ptr, value >>> 0);
}

function writeFileTime(ptr: number, t: bigint): void {
    Mem.writeUint32(ptr, Number(t & 0xFFFFFFFFn));
    Mem.writeUint32(ptr + 4, Number((t >> 32n) & 0xFFFFFFFFn));
}

function readFileTime(ptr: number): bigint {
    return BigInt(Mem.readUint32(ptr) ?? 0) | (BigInt(Mem.readUint32(ptr + 4) ?? 0) << 32n);
}

function allocWide(process: Process, text: string): number {
    const ptr = process.memory.alloc((text.length + 1) * 2);
    if (!ptr) return 0;
    for (let i = 0; i < text.length; i++) Mem.writeUint16(ptr + i * 2, text.charCodeAt(i));
    Mem.writeUint16(ptr + text.length * 2, 0);
    return ptr;
}

function writeStatStg(process: Process, ptr: number, entry: CfbEntry, name: string, mode: number, flag: number): void {
    Mem.writeBytes(ptr, new Uint8Array(STATSTG_SIZE));
    Mem.writeUint32(ptr, (flag & STATFLAG_NONAME) ? 0 : allocWide(process, name));
    Mem.writeUint32(ptr + 4, entry.type === 'stream' ? STGTY_STREAM : STGTY_STORAGE);
    Mem.writeUint32(ptr + 8, entry.type === 'stream' ? entry.data.length : 0);
    writeFileTime(ptr + 16, entry.mtime);
    writeFileTime(ptr + 24, entry.ctime);
    Mem.writeUint32(ptr + 40, mode >>> 0);
    Mem.writeBytes(ptr + 48, entry.clsid);
    Mem.writeUint32(ptr + 64, entry.stateBits >>> 0);
}

// ── file I/O ────────────────────────────────────────────────────────────────

function persist(doc: DocFile): number {
    if (!doc.writable) return S_OK;
    const bytes = serializeCfb(doc.root);
    const vfs = System.getInstance().fileSystem;
    const h = vfs.openSync(doc.path, GENERIC_WRITE, CREATE_ALWAYS);
    if (!h) {
        Logger.warn(LogCategory.COM, `docfile: cannot write "${doc.path}"`);
        return STG_E_WRITEFAULT;
    }
    if (vfs.writeSync(h, bytes) < 0) {
        void vfs.write(h, bytes).catch((e) => Logger.error(LogCategory.COM, `docfile: write "${doc.path}" failed: ${e}`));
    }
    void vfs.flushFile(h.path).catch(() => { /* lazy flush retries */ });
    doc.dirty = false;
    if (doc.transacted) doc.committed = bytes;
    Logger.log(LogCategory.COM, `docfile: wrote "${doc.path}" (${bytes.length} bytes)`);
    return S_OK;
}

function closeDoc(doc: DocFile): void {
    if (doc.deleteOnRelease) {
        void System.getInstance().fileSystem.deleteFile(doc.path).catch(() => { /* already gone */ });
        return;
    }
    if (!doc.transacted && doc.dirty) persist(doc);
}

function readFileSync(path: string): Uint8Array | null {
    const vfs = System.getInstance().fileSystem;
    const h = vfs.openSync(path, GENERIC_READ, OPEN_EXISTING);
    if (!h) return null;
    const size = vfs.getFileSize(h.path);
    const data = vfs.readSync(h, size);
    return data && data.length === size ? data.slice() : null;
}

async function readFileAsync(path: string): Promise<Uint8Array | null> {
    const vfs = System.getInstance().fileSystem;
    const h = await vfs.open(path, GENERIC_READ, OPEN_EXISTING);
    if (!h) return null;
    return (await vfs.read(h, vfs.getFileSize(h.path))).slice();
}

// ── object lifetime ─────────────────────────────────────────────────────────

function newObject(process: Process, mem: Uint8Array, state: StgObj): number {
    const vt = ensureVtables(process);
    if (!vt) return 0;
    const vtable = state.kind === 'storage' ? vt.storage : state.kind === 'stream' ? vt.stream : vt.enumStat;
    const addr = allocateComObject(process.memory, mem, vtable, 'THUNK_DATA');
    objects.set(addr, state);
    if (state.kind !== 'enum') state.doc.openObjects++;
    return addr;
}

function release(process: Process, addr: number): number {
    const obj = objects.get(addr);
    if (!obj) return 0;
    if (--obj.refCount > 0) return obj.refCount;
    objects.delete(addr);
    freeComObject(process.memory, addr);
    if (obj.kind !== 'enum' && --obj.doc.openObjects === 0) closeDoc(obj.doc);
    return 0;
}

function queryInterface(mem: Uint8Array, addr: number, riid: number, ppv: number): number {
    const obj = objects.get(addr);
    if (!ppv) return STG_E_INVALIDPOINTER;
    const iid = riid ? guid(mem, riid) : '';
    const ok = obj && (iid === IID_IUNKNOWN
        || (obj.kind === 'storage' && iid === IID_ISTORAGE)
        || (obj.kind === 'stream' && (iid === IID_ISTREAM || iid === IID_ISEQUENTIALSTREAM))
        || (obj.kind === 'enum' && iid === IID_IENUMSTATSTG));
    if (!ok) {
        out32(ppv, 0);
        return E_NOINTERFACE;
    }
    obj.refCount++;
    out32(ppv, addr);
    return S_OK;
}

// ── IStorage ────────────────────────────────────────────────────────────────

function storageOf(addr: number): StorageObj | null {
    const obj = objects.get(addr >>> 0);
    return obj?.kind === 'storage' ? obj : null;
}

function streamOf(addr: number): StreamObj | null {
    const obj = objects.get(addr >>> 0);
    return obj?.kind === 'stream' ? obj : null;
}

function createElement(process: Process, mem: Uint8Array, args: number[], type: 'storage' | 'stream'): number {
    const [self, pName, mode, , , ppOut] = args;
    const stg = storageOf(self);
    if (!ppOut) return STG_E_INVALIDPOINTER;
    out32(ppOut, 0);
    if (!stg) return E_INVALIDARG;
    if (!writable(stg.mode)) return STG_E_ACCESSDENIED;
    const name = readName(mem, pName);
    if (!name) return STG_E_INVALIDNAME;
    const existing = findChild(stg.entry, name);
    if (existing) {
        if (!(mode & STGM_CREATE)) return STG_E_FILEALREADYEXISTS;
        stg.entry.children.splice(stg.entry.children.indexOf(existing), 1);
    }
    const entry = newEntry(name, type);
    stg.entry.children.push(entry);
    stg.doc.dirty = true;
    const state: StgObj = type === 'storage'
        ? { kind: 'storage', refCount: 1, doc: stg.doc, entry, mode }
        : { kind: 'stream', refCount: 1, doc: stg.doc, entry, mode, pos: 0 };
    out32(ppOut, newObject(process, mem, state));
    return S_OK;
}

function openElement(process: Process, mem: Uint8Array, self: number, pName: number, mode: number, ppOut: number, type: 'storage' | 'stream'): number {
    const stg = storageOf(self);
    if (!ppOut) return STG_E_INVALIDPOINTER;
    out32(ppOut, 0);
    if (!stg) return E_INVALIDARG;
    const name = readName(mem, pName);
    if (!name) return STG_E_INVALIDNAME;
    const entry = findChild(stg.entry, name);
    if (!entry || entry.type !== type) return STG_E_FILENOTFOUND;
    if (writable(mode) && !writable(stg.mode)) return STG_E_ACCESSDENIED;
    const state: StgObj = type === 'storage'
        ? { kind: 'storage', refCount: 1, doc: stg.doc, entry, mode }
        : { kind: 'stream', refCount: 1, doc: stg.doc, entry, mode, pos: 0 };
    out32(ppOut, newObject(process, mem, state));
    return S_OK;
}

function storageHandlers(process: Process): Record<string, ThunkImplementation> {
    return {
        IStorage_QueryInterface: (_c, mem, a) => queryInterface(mem, a[0], a[1], a[2]),
        IStorage_AddRef: (_c, _m, a) => { const o = objects.get(a[0]); return o ? ++o.refCount : 0; },
        IStorage_Release: (_c, _m, a) => release(process, a[0]),
        IStorage_CreateStream: (_c, mem, a) => createElement(process, mem, a, 'stream'),
        IStorage_OpenStream: (_c, mem, a) => openElement(process, mem, a[0], a[1], a[3], a[5], 'stream'),
        IStorage_CreateStorage: (_c, mem, a) => createElement(process, mem, a, 'storage'),
        IStorage_OpenStorage: (_c, mem, a) => openElement(process, mem, a[0], a[1], a[3], a[6], 'storage'),
        IStorage_CopyTo: (_c, _m, a) => {
            const src = storageOf(a[0]);
            const dst = storageOf(a[4]);
            if (!src || !dst) return STG_E_INVALIDPOINTER;
            if (!writable(dst.mode)) return STG_E_ACCESSDENIED;
            for (const child of src.entry.children) {
                const existing = findChild(dst.entry, child.name);
                if (existing) dst.entry.children.splice(dst.entry.children.indexOf(existing), 1);
                dst.entry.children.push(cloneEntry(child));
            }
            dst.entry.clsid = src.entry.clsid.slice();
            dst.doc.dirty = true;
            return S_OK;
        },
        IStorage_MoveElementTo: (_c, mem, a) => {
            const src = storageOf(a[0]);
            const dst = storageOf(a[2]);
            if (!src || !dst) return STG_E_INVALIDPOINTER;
            const name = readName(mem, a[1]);
            const newName = readName(mem, a[3]);
            if (!name || !newName) return STG_E_INVALIDNAME;
            const entry = findChild(src.entry, name);
            if (!entry) return STG_E_FILENOTFOUND;
            if (!writable(dst.mode) || (a[4] !== STGMOVE_COPY && !writable(src.mode))) return STG_E_ACCESSDENIED;
            const existing = findChild(dst.entry, newName);
            if (existing) dst.entry.children.splice(dst.entry.children.indexOf(existing), 1);
            dst.entry.children.push({ ...cloneEntry(entry), name: newName });
            if (a[4] !== STGMOVE_COPY) src.entry.children.splice(src.entry.children.indexOf(entry), 1);
            src.doc.dirty = dst.doc.dirty = true;
            return S_OK;
        },
        IStorage_Commit: (_c, _m, a) => {
            const stg = storageOf(a[0]);
            return stg ? persist(stg.doc) : E_INVALIDARG;
        },
        IStorage_Revert: (_c, _m, a) => {
            const stg = storageOf(a[0]);
            if (!stg) return E_INVALIDARG;
            if (stg.doc.transacted && stg.doc.committed && stg.entry === stg.doc.root) {
                const restored = parseCfb(stg.doc.committed);
                stg.doc.root.children = restored.children;
                stg.doc.root.clsid = restored.clsid;
                stg.doc.dirty = false;
            }
            return S_OK;
        },
        IStorage_EnumElements: (_c, mem, a) => {
            const stg = storageOf(a[0]);
            if (!a[4]) return STG_E_INVALIDPOINTER;
            if (!stg) return E_INVALIDARG;
            out32(a[4], newObject(process, mem, { kind: 'enum', refCount: 1, items: [...stg.entry.children], index: 0 }));
            return S_OK;
        },
        IStorage_DestroyElement: (_c, mem, a) => {
            const stg = storageOf(a[0]);
            if (!stg) return E_INVALIDARG;
            if (!writable(stg.mode)) return STG_E_ACCESSDENIED;
            const name = readName(mem, a[1]);
            const entry = name ? findChild(stg.entry, name) : undefined;
            if (!entry) return STG_E_FILENOTFOUND;
            stg.entry.children.splice(stg.entry.children.indexOf(entry), 1);
            stg.doc.dirty = true;
            return S_OK;
        },
        IStorage_RenameElement: (_c, mem, a) => {
            const stg = storageOf(a[0]);
            if (!stg) return E_INVALIDARG;
            if (!writable(stg.mode)) return STG_E_ACCESSDENIED;
            const oldName = readName(mem, a[1]);
            const newName = readName(mem, a[2]);
            if (!oldName || !newName) return STG_E_INVALIDNAME;
            const entry = findChild(stg.entry, oldName);
            if (!entry) return STG_E_FILENOTFOUND;
            if (findChild(stg.entry, newName)) return STG_E_FILEALREADYEXISTS;
            entry.name = newName;
            stg.doc.dirty = true;
            return S_OK;
        },
        IStorage_SetElementTimes: (_c, mem, a) => {
            const stg = storageOf(a[0]);
            if (!stg) return E_INVALIDARG;
            const name = a[1] ? readName(mem, a[1]) : null;
            const entry = a[1] ? (name ? findChild(stg.entry, name) : undefined) : stg.entry;
            if (!entry) return STG_E_FILENOTFOUND;
            if (a[2]) entry.ctime = readFileTime(a[2]);
            if (a[4]) entry.mtime = readFileTime(a[4]);
            stg.doc.dirty = true;
            return S_OK;
        },
        IStorage_SetClass: (_c, mem, a) => {
            const stg = storageOf(a[0]);
            if (!stg) return E_INVALIDARG;
            if (!writable(stg.mode)) return STG_E_ACCESSDENIED;
            stg.entry.clsid = a[1] ? mem.slice(a[1], a[1] + 16) : new Uint8Array(16);
            stg.doc.dirty = true;
            return S_OK;
        },
        IStorage_SetStateBits: (_c, _m, a) => {
            const stg = storageOf(a[0]);
            if (!stg) return E_INVALIDARG;
            stg.entry.stateBits = ((stg.entry.stateBits & ~a[2]) | (a[1] & a[2])) >>> 0;
            stg.doc.dirty = true;
            return S_OK;
        },
        IStorage_Stat: (_c, _m, a) => {
            const stg = storageOf(a[0]);
            if (!a[1]) return STG_E_INVALIDPOINTER;
            if (!stg) return E_INVALIDARG;
            const name = stg.entry === stg.doc.root ? stg.doc.path : stg.entry.name;
            writeStatStg(process, a[1], stg.entry, name, stg.mode, a[2]);
            return S_OK;
        },
    };
}

// ── IStream ─────────────────────────────────────────────────────────────────

function streamRead(s: StreamObj, pv: number, cb: number): number {
    const n = Math.max(0, Math.min(cb, s.entry.data.length - s.pos));
    if (n > 0) Mem.writeBytes(pv, s.entry.data.subarray(s.pos, s.pos + n));
    s.pos += n;
    return n;
}

function streamWrite(s: StreamObj, bytes: Uint8Array): void {
    const end = s.pos + bytes.length;
    if (end > s.entry.data.length) setStreamSize(s.entry, end);
    s.entry.data.set(bytes, s.pos);
    s.pos = end;
    s.doc.dirty = true;
}

function streamHandlers(process: Process): Record<string, ThunkImplementation> {
    return {
        IStream_QueryInterface: (_c, mem, a) => queryInterface(mem, a[0], a[1], a[2]),
        IStream_AddRef: (_c, _m, a) => { const o = objects.get(a[0]); return o ? ++o.refCount : 0; },
        IStream_Release: (_c, _m, a) => release(process, a[0]),
        IStream_Read: (_c, _m, a) => {
            const s = streamOf(a[0]);
            if (!s) return E_INVALIDARG;
            if (!a[1]) return STG_E_INVALIDPOINTER;
            if (!readable(s.mode)) return STG_E_ACCESSDENIED;
            out32(a[3], streamRead(s, a[1], a[2]));
            return S_OK;
        },
        IStream_Write: (_c, mem, a) => {
            const s = streamOf(a[0]);
            if (!s) return E_INVALIDARG;
            if (!a[1] && a[2]) return STG_E_INVALIDPOINTER;
            if (!writable(s.mode)) return STG_E_ACCESSDENIED;
            streamWrite(s, mem.subarray(a[1], a[1] + a[2]));
            out32(a[3], a[2]);
            return S_OK;
        },
        // Seek(this, LARGE_INTEGER dlibMove (lo, hi), dwOrigin, ULARGE_INTEGER *plibNewPosition)
        IStream_Seek: (_c, _m, a) => {
            const s = streamOf(a[0]);
            if (!s) return E_INVALIDARG;
            if (a[3] > STREAM_SEEK_END) return STG_E_INVALIDFUNCTION;
            const move = (a[2] | 0) * 0x100000000 + (a[1] >>> 0);
            const base = a[3] === 0 ? 0 : a[3] === 1 ? s.pos : s.entry.data.length;
            const pos = base + move;
            if (pos < 0) return STG_E_INVALIDFUNCTION;
            s.pos = pos;
            if (a[4]) {
                Mem.writeUint32(a[4], pos >>> 0);
                Mem.writeUint32(a[4] + 4, Math.floor(pos / 0x100000000) >>> 0);
            }
            return S_OK;
        },
        IStream_SetSize: (_c, _m, a) => {
            const s = streamOf(a[0]);
            if (!s) return E_INVALIDARG;
            if (a[2] !== 0) return STG_E_MEDIUMFULL;
            if (!writable(s.mode)) return STG_E_ACCESSDENIED;
            setStreamSize(s.entry, a[1] >>> 0);
            s.doc.dirty = true;
            return S_OK;
        },
        // CopyTo(this, IStream *pstm, ULARGE_INTEGER cb (lo, hi), *pcbRead, *pcbWritten)
        IStream_CopyTo: (ctx, mem, a) => {
            const s = streamOf(a[0]);
            if (!s) return E_INVALIDARG;
            if (!a[1]) return STG_E_INVALIDPOINTER;
            const want = a[3] !== 0 ? Number.MAX_SAFE_INTEGER : a[2] >>> 0;
            const n = Math.max(0, Math.min(want, s.entry.data.length - s.pos));
            const bytes = s.entry.data.slice(s.pos, s.pos + n);
            s.pos += n;
            const report = (written: number): void => {
                if (a[4]) { Mem.writeUint32(a[4], n); Mem.writeUint32(a[4] + 4, 0); }
                if (a[5]) { Mem.writeUint32(a[5], written); Mem.writeUint32(a[5] + 4, 0); }
            };
            const dst = streamOf(a[1]);
            if (dst) {
                if (!writable(dst.mode)) return STG_E_ACCESSDENIED;
                streamWrite(dst, bytes);
                report(n);
                return S_OK;
            }
            const buf = process.memory.alloc(Math.max(n, 4) + 4);
            Mem.writeBytes(buf, bytes);
            return runGuestCallChain(ctx, mem, 24, 'IStream_CopyTo', (function* (): GuestCallChain {
                const hr = yield comCall(mem, a[1], SLOT_STREAM_WRITE, buf, n, buf + Math.max(n, 4));
                report((hr | 0) >= 0 ? (Mem.readUint32(buf + Math.max(n, 4)) ?? 0) : 0);
                process.memory.free(buf);
                return hr;
            })(), STG_E_WRITEFAULT);
        },
        IStream_Commit: (_c, _m, a) => (streamOf(a[0]) ? S_OK : E_INVALIDARG),
        IStream_Revert: (_c, _m, a) => (streamOf(a[0]) ? S_OK : E_INVALIDARG),
        // Docfile streams do not support region locking.
        IStream_LockRegion: () => STG_E_INVALIDFUNCTION,
        IStream_UnlockRegion: () => STG_E_INVALIDFUNCTION,
        IStream_Stat: (_c, _m, a) => {
            const s = streamOf(a[0]);
            if (!a[1]) return STG_E_INVALIDPOINTER;
            if (!s) return E_INVALIDARG;
            writeStatStg(process, a[1], s.entry, s.entry.name, s.mode, a[2]);
            return S_OK;
        },
        IStream_Clone: (_c, mem, a) => {
            const s = streamOf(a[0]);
            if (!a[1]) return STG_E_INVALIDPOINTER;
            if (!s) return E_INVALIDARG;
            out32(a[1], newObject(process, mem, { ...s, refCount: 1 }));
            return S_OK;
        },
    };
}

// ── IEnumSTATSTG ────────────────────────────────────────────────────────────

function enumHandlers(process: Process): Record<string, ThunkImplementation> {
    const enumOf = (addr: number): EnumObj | null => {
        const o = objects.get(addr >>> 0);
        return o?.kind === 'enum' ? o : null;
    };
    return {
        IEnumSTATSTG_QueryInterface: (_c, mem, a) => queryInterface(mem, a[0], a[1], a[2]),
        IEnumSTATSTG_AddRef: (_c, _m, a) => { const o = objects.get(a[0]); return o ? ++o.refCount : 0; },
        IEnumSTATSTG_Release: (_c, _m, a) => release(process, a[0]),
        IEnumSTATSTG_Next: (_c, _m, a) => {
            const e = enumOf(a[0]);
            if (!e) return E_INVALIDARG;
            if (!a[2]) return STG_E_INVALIDPOINTER;
            let fetched = 0;
            while (fetched < a[1] && e.index < e.items.length) {
                const item = e.items[e.index++];
                writeStatStg(process, a[2] + fetched * STATSTG_SIZE, item, item.name, 0, 0);
                fetched++;
            }
            out32(a[3], fetched);
            return fetched === a[1] ? S_OK : S_FALSE;
        },
        IEnumSTATSTG_Skip: (_c, _m, a) => {
            const e = enumOf(a[0]);
            if (!e) return E_INVALIDARG;
            const skipped = Math.min(a[1], e.items.length - e.index);
            e.index += skipped;
            return skipped === a[1] ? S_OK : S_FALSE;
        },
        IEnumSTATSTG_Reset: (_c, _m, a) => {
            const e = enumOf(a[0]);
            if (!e) return E_INVALIDARG;
            e.index = 0;
            return S_OK;
        },
        IEnumSTATSTG_Clone: (_c, mem, a) => {
            const e = enumOf(a[0]);
            if (!a[1]) return STG_E_INVALIDPOINTER;
            if (!e) return E_INVALIDARG;
            out32(a[1], newObject(process, mem, { ...e, refCount: 1 }));
            return S_OK;
        },
    };
}

const IUNKNOWN_METHODS: ComVtableMethod[] = [
    { name: 'QueryInterface', argCount: 3, stackCleanupBytes: 12 },
    { name: 'AddRef', argCount: 1, stackCleanupBytes: 4 },
    { name: 'Release', argCount: 1, stackCleanupBytes: 4 },
];

function methods(prefix: string, list: [string, number][]): ComVtableMethod[] {
    return [...IUNKNOWN_METHODS, ...list.map(([name, argCount]) => ({ name, argCount, stackCleanupBytes: argCount * 4 }))]
        .map((m) => ({ ...m, name: `${prefix}_${m.name}` }));
}

function ensureVtables(process: Process): typeof vtables {
    if (vtables) return vtables;
    const storage = installComVtable(process, {
        moduleName: 'ole32_istorage',
        methods: methods('IStorage', [
            ['CreateStream', 6], ['OpenStream', 6], ['CreateStorage', 6], ['OpenStorage', 7],
            ['CopyTo', 5], ['MoveElementTo', 5], ['Commit', 2], ['Revert', 1], ['EnumElements', 5],
            ['DestroyElement', 2], ['RenameElement', 3], ['SetElementTimes', 5], ['SetClass', 2],
            ['SetStateBits', 3], ['Stat', 3],
        ]),
        handlers: storageHandlers(process),
        logLabel: 'IStorage',
    });
    const stream = installComVtable(process, {
        moduleName: 'ole32_istream',
        methods: methods('IStream', [
            ['Read', 4], ['Write', 4], ['Seek', 5], ['SetSize', 3], ['CopyTo', 6], ['Commit', 2],
            ['Revert', 1], ['LockRegion', 6], ['UnlockRegion', 6], ['Stat', 3], ['Clone', 2],
        ]),
        handlers: streamHandlers(process),
        logLabel: 'IStream',
    });
    const enumStat = installComVtable(process, {
        moduleName: 'ole32_ienumstatstg',
        methods: methods('IEnumSTATSTG', [['Next', 4], ['Skip', 2], ['Reset', 1], ['Clone', 2]]),
        handlers: enumHandlers(process),
        logLabel: 'IEnumSTATSTG',
    });
    if (!storage || !stream || !enumStat) return null;
    vtables = { storage: storage.vtableAddr, stream: stream.vtableAddr, enumStat: enumStat.vtableAddr };
    return vtables;
}

// ── Stg* entry points ───────────────────────────────────────────────────────

function openRoot(process: Process, mem: Uint8Array, doc: DocFile, mode: number, ppstg: number): number {
    const addr = newObject(process, mem, { kind: 'storage', refCount: 1, doc, entry: doc.root, mode });
    if (!addr) return STG_E_INVALIDFUNCTION;
    out32(ppstg, addr);
    return S_OK;
}

/** HRESULT StgCreateDocfile(LPCOLESTR pwcsName, DWORD grfMode, DWORD reserved, IStorage **ppstgOpen) */
export function stgCreateDocfile(process: Process, mem: Uint8Array, args: number[]): number {
    const [pName, mode, , ppstg] = args;
    if (!ppstg) return STG_E_INVALIDPOINTER;
    out32(ppstg, 0);
    const vfs = System.getInstance().fileSystem;
    let path: string;
    let deleteOnRelease = (mode & STGM_DELETEONRELEASE) !== 0;
    if (pName) {
        path = Marshaler.readWideString(mem, pName);
        if (!path) return STG_E_INVALIDNAME;
        if (!(mode & STGM_CREATE) && vfs.fileExists(path)) return STG_E_FILEALREADYEXISTS;
    } else {
        const temp = process.environment?.get('TEMP') ?? 'C:\\TEMP';
        path = `${temp.replace(/\\$/, '')}\\~DF${(++tempCounter).toString(16).toUpperCase().padStart(4, '0')}.TMP`;
        deleteOnRelease = true;
    }
    if (!writable(mode)) return STG_E_INVALIDPARAMETER;
    const doc: DocFile = {
        path, root: createCfbRoot(), writable: true, transacted: (mode & STGM_TRANSACTED) !== 0,
        deleteOnRelease, dirty: true, openObjects: 0, committed: null,
    };
    doc.root.ctime = doc.root.mtime = nowFileTime();
    // The file exists as soon as the call returns, like the real docfile layer.
    const hr = persist(doc);
    if (hr !== S_OK) return hr;
    Logger.log(LogCategory.COM, `StgCreateDocfile("${path}", mode=0x${mode.toString(16)})`);
    return openRoot(process, mem, doc, mode, ppstg);
}

function openDocFromBytes(process: Process, mem: Uint8Array, path: string, bytes: Uint8Array | null, mode: number, ppstg: number): number {
    if (!bytes) return STG_E_FILENOTFOUND;
    if (!isCfb(bytes)) return STG_E_FILEALREADYEXISTS;
    let root: CfbEntry;
    try {
        root = parseCfb(bytes);
    } catch (e) {
        Logger.warn(LogCategory.COM, `StgOpenStorage("${path}"): ${e instanceof CfbFormatError ? e.message : e}`);
        return STG_E_READFAULT;
    }
    const transacted = (mode & STGM_TRANSACTED) !== 0;
    const doc: DocFile = {
        path, root, writable: writable(mode), transacted, deleteOnRelease: (mode & STGM_DELETEONRELEASE) !== 0,
        dirty: false, openObjects: 0, committed: transacted ? bytes : null,
    };
    return openRoot(process, mem, doc, mode, ppstg);
}

/** HRESULT StgOpenStorage(pwcsName, pstgPriority, grfMode, snbExclude, reserved, IStorage **ppstgOpen) */
export function stgOpenStorage(process: Process, mem: Uint8Array, args: number[]): number | Promise<number> {
    const [pName, , mode, , , ppstg] = args;
    if (!ppstg) return STG_E_INVALIDPOINTER;
    out32(ppstg, 0);
    const path = pName ? Marshaler.readWideString(mem, pName) : '';
    if (!path) return STG_E_INVALIDNAME;
    if (!System.getInstance().fileSystem.fileExists(path)) return STG_E_FILENOTFOUND;
    const bytes = readFileSync(path);
    if (bytes) return openDocFromBytes(process, mem, path, bytes, mode, ppstg);
    return readFileAsync(path).then((b) => openDocFromBytes(process, process.getCurrentMemory(), path, b, mode, ppstg));
}

/** HRESULT StgIsStorageFile(LPCOLESTR pwcsName): S_OK for a compound file, S_FALSE otherwise. */
export function stgIsStorageFile(mem: Uint8Array, args: number[]): number | Promise<number> {
    const path = args[0] ? Marshaler.readWideString(mem, args[0]) : '';
    if (!path || !System.getInstance().fileSystem.fileExists(path)) return STG_E_FILENOTFOUND;
    const judge = (b: Uint8Array | null) => (b ? (isCfb(b) ? S_OK : S_FALSE) : STG_E_FILENOTFOUND);
    const bytes = readFileSync(path);
    return bytes ? judge(bytes) : readFileAsync(path).then(judge);
}

// ── stream persistence helpers (may call guest IStream / IPersistStream) ───

/** Write 16 bytes at guest `src` to a stream (our IStream directly, a guest one via Write). */
function* writeToStream(mem: Uint8Array, pStm: number, src: number, cb: number): GuestCallChain {
    const s = streamOf(pStm);
    if (s) {
        if (!writable(s.mode)) return STG_E_ACCESSDENIED;
        streamWrite(s, mem.slice(src, src + cb));
        return S_OK;
    }
    return yield comCall(mem, pStm, SLOT_STREAM_WRITE, src, cb, 0);
}

/** Read `cb` bytes into guest `dst`; fails with STG_E_READFAULT on a short read. */
function* readFromStream(mem: Uint8Array, pStm: number, dst: number, cb: number, pcbRead: number): GuestCallChain {
    const s = streamOf(pStm);
    if (s) {
        if (!readable(s.mode)) return STG_E_ACCESSDENIED;
        return streamRead(s, dst, cb) === cb ? S_OK : STG_E_READFAULT;
    }
    Mem.writeUint32(pcbRead, 0);
    const hr = yield comCall(mem, pStm, SLOT_STREAM_READ, dst, cb, pcbRead);
    if ((hr | 0) < 0) return hr;
    return (Mem.readUint32(pcbRead) ?? 0) === cb ? S_OK : STG_E_READFAULT;
}

/** HRESULT WriteClassStm(IStream *pStm, REFCLSID rclsid) */
export function writeClassStm(ctx: { esp: number }, mem: Uint8Array, args: number[]): number | ThunkResult {
    const [pStm, rclsid] = args;
    if (!pStm || !rclsid) return E_INVALIDARG;
    return runGuestCallChain(ctx, mem, 8, 'WriteClassStm', writeToStream(mem, pStm, rclsid, 16), STG_E_WRITEFAULT);
}

/** HRESULT ReadClassStm(IStream *pStm, CLSID *pclsid) */
export function readClassStm(process: Process, ctx: { esp: number }, mem: Uint8Array, args: number[]): number | ThunkResult {
    const [pStm, pclsid] = args;
    if (!pStm || !pclsid) return E_INVALIDARG;
    const scratch = process.memory.alloc(4);
    return runGuestCallChain(ctx, mem, 8, 'ReadClassStm', (function* (): GuestCallChain {
        const hr = yield* readFromStream(mem, pStm, pclsid, 16, scratch);
        process.memory.free(scratch);
        return hr;
    })(), STG_E_READFAULT);
}

/** HRESULT OleSaveToStream(IPersistStream *pPStm, IStream *pStm): CLSID, then the object's own data. */
export function oleSaveToStream(process: Process, ctx: { esp: number }, mem: Uint8Array, args: number[]): number | ThunkResult {
    const [pPStm, pStm] = args;
    if (!pStm) return E_INVALIDARG;
    const clsid = process.memory.alloc(16);
    Mem.writeBytes(clsid, new Uint8Array(16));
    return runGuestCallChain(ctx, mem, 8, 'OleSaveToStream', (function* (): GuestCallChain {
        try {
            // A NULL object writes CLSID_NULL: the reader then sees "no object".
            if (!pPStm) return yield* writeToStream(mem, pStm, clsid, 16);
            let hr = yield comCall(mem, pPStm, SLOT_PERSIST_GETCLASSID, clsid);
            if ((hr | 0) < 0) return hr;
            hr = yield* writeToStream(mem, pStm, clsid, 16);
            if ((hr | 0) < 0) return hr;
            return yield comCall(mem, pPStm, SLOT_PERSIST_SAVE, pStm, 1);
        } finally {
            process.memory.free(clsid);
        }
    })(), E_INVALIDARG);
}

/**
 * HRESULT OleLoadFromStream(IStream *pStm, REFIID iidInterface, void **ppvObj):
 * read the CLSID, create the object through its class factory, IPersistStream::Load.
 * `classFactoryFor` resolves a CLSID to a guest IClassFactory (CoRegisterClassObject).
 */
export function oleLoadFromStream(
    process: Process, ctx: { esp: number }, mem: Uint8Array, args: number[],
    classFactoryFor: (clsid: string) => number,
): number | ThunkResult {
    const [pStm, riid, ppvObj] = args;
    if (!ppvObj) return E_INVALIDARG;
    out32(ppvObj, 0);
    if (!pStm || !riid) return E_INVALIDARG;
    // [0..15] CLSID, [16..31] IID_IPersistStream, [32] pUnk, [36] pPersist, [40] cbRead
    const scratch = process.memory.alloc(44);
    Mem.writeBytes(scratch, new Uint8Array(44));
    const iidPersist = IID_IPERSISTSTREAM.replace(/-/g, '');
    const v = new DataView(new ArrayBuffer(16));
    v.setUint32(0, parseInt(iidPersist.slice(0, 8), 16), true);
    v.setUint16(4, parseInt(iidPersist.slice(8, 12), 16), true);
    v.setUint16(6, parseInt(iidPersist.slice(12, 16), 16), true);
    for (let i = 0; i < 8; i++) v.setUint8(8 + i, parseInt(iidPersist.slice(16 + i * 2, 18 + i * 2), 16));
    Mem.writeBytes(scratch + 16, new Uint8Array(v.buffer));
    return runGuestCallChain(ctx, mem, 12, 'OleLoadFromStream', (function* (): GuestCallChain {
        try {
            let hr = yield* readFromStream(mem, pStm, scratch, 16, scratch + 40);
            if ((hr | 0) < 0) return hr;
            const clsid = guid(mem, scratch);
            const factory = classFactoryFor(clsid);
            if (!factory) {
                Logger.warn(LogCategory.COM, `OleLoadFromStream: no class factory for ${clsid}`);
                return REGDB_E_CLASSNOTREG;
            }
            hr = yield comCall(mem, factory, SLOT_FACTORY_CREATEINSTANCE, 0, riid, scratch + 32);
            const pUnk = Mem.readUint32(scratch + 32) ?? 0;
            if ((hr | 0) < 0 || !pUnk) return (hr | 0) < 0 ? hr : E_NOINTERFACE;
            hr = yield comCall(mem, pUnk, SLOT_QI, scratch + 16, scratch + 36);
            const pPersist = Mem.readUint32(scratch + 36) ?? 0;
            if ((hr | 0) >= 0 && pPersist) {
                hr = yield comCall(mem, pPersist, SLOT_PERSIST_LOAD, pStm);
                yield comCall(mem, pPersist, SLOT_RELEASE);
            }
            if ((hr | 0) < 0) {
                yield comCall(mem, pUnk, SLOT_RELEASE);
                return hr;
            }
            out32(ppvObj, pUnk);
            return S_OK;
        } finally {
            process.memory.free(scratch);
        }
    })(), E_INVALIDARG);
}
