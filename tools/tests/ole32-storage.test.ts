/**
 * OLE structured storage: StgCreateDocfile/StgOpenStorage over the VFS, IStorage/IStream
 * semantics, and OleSaveToStream/OleLoadFromStream driving guest IPersistStream objects
 * through the suspended-thunk call chain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseCfb } from "../../packages/formats/src/cfb/index";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";

const handlers: Record<string, (ctx: any, mem: Uint8Array, args: number[]) => any> = {};
let nextVtable = 0x7f000;
mock.module("../../src/worker/core/com/install-com-vtable", () => ({
    installComVtable: (_p: unknown, opts: { handlers: typeof handlers }) => {
        Object.assign(handlers, opts.handlers);
        return { vtableAddr: (nextVtable += 0x100), stubBase: 0, exportTable: new Map() };
    },
}));
const storage = await import("../../src/worker/modules/ole32-storage");

const S_OK = 0;
const STG_E_FILENOTFOUND = 0x80030002;
const STG_E_ACCESSDENIED = 0x80030005;
const STG_E_FILEALREADYEXISTS = 0x80030050;
const STGM_READ = 0;
const STGM_READWRITE = 2;
const STGM_SHARE_EXCLUSIVE = 0x10;
const STGM_CREATE = 0x1000;
const RW = STGM_READWRITE | STGM_SHARE_EXCLUSIVE;

const mem = new Uint8Array(0x100000);
const view = new DataView(mem.buffer);
let heap = 0x40000;
const process: any = {
    memory: { alloc: (n: number) => { const p = heap; heap += (n + 15) & ~15; return p; }, free: () => {} },
    environment: new Map([["TEMP", "C:\\TEMP"]]),
    getCurrentMemory: () => mem,
};

/** In-memory stand-in for the VFS paths the docfile layer uses. */
const files = new Map<string, Uint8Array>();
const FS_METHODS = ["fileExists", "openSync", "writeSync", "getFileSize", "readSync", "flushFile", "deleteFile"];
const saved: Record<string, unknown> = {};
beforeAll(() => {
    Mem.bind(() => mem);
    const fs: any = System.getInstance().fileSystem;
    for (const m of FS_METHODS) saved[m] = fs[m];
    saved.process = System.getInstance().process;
    const key = (p: string) => p.toUpperCase();
    fs.fileExists = (p: string) => files.has(key(p));
    fs.openSync = (p: string, _access: number, disp: number) => {
        if (disp === 3 && !files.has(key(p))) return null;
        if (disp === 2) files.set(key(p), new Uint8Array(0));
        return { path: p, position: 0 };
    };
    fs.writeSync = (h: any, data: Uint8Array) => { files.set(key(h.path), data.slice()); return data.length; };
    fs.getFileSize = (p: string) => files.get(key(p))?.length ?? 0;
    fs.readSync = (h: any, n: number) => files.get(key(h.path))!.subarray(0, n);
    fs.flushFile = async () => {};
    fs.deleteFile = async (p: string) => files.delete(key(p));
});
afterAll(() => {
    const fs: any = System.getInstance().fileSystem;
    for (const m of FS_METHODS) fs[m] = saved[m];
    (System.getInstance() as any).process = saved.process;
});

let scratch = 0x20000;
function wide(text: string): number {
    const p = scratch;
    for (let i = 0; i < text.length; i++) view.setUint16(p + i * 2, text.charCodeAt(i), true);
    view.setUint16(p + text.length * 2, 0, true);
    scratch += (text.length + 1) * 2 + 16;
    return p;
}
function out(): number { const p = scratch; view.setUint32(p, 0, true); scratch += 16; return p; }
const u32 = (p: number) => view.getUint32(p, true);
const call = (name: string, ...args: number[]) => handlers[name]({ esp: 0x8000 }, mem, args) as number;

function createDoc(path: string, mode = RW | STGM_CREATE): number {
    const pp = out();
    expect(storage.stgCreateDocfile(process, mem, [wide(path), mode, 0, pp])).toBe(S_OK);
    return u32(pp);
}
function createStream(stg: number, name: string): number {
    const pp = out();
    expect(call("IStorage_CreateStream", stg, wide(name), RW | STGM_CREATE, 0, 0, pp)).toBe(S_OK);
    return u32(pp);
}
function write(stm: number, bytes: number[]): void {
    const p = scratch; scratch += bytes.length + 16;
    mem.set(bytes, p);
    expect(call("IStream_Write", stm, p, bytes.length, 0)).toBe(S_OK);
}
function read(stm: number, n: number): number[] {
    const p = scratch; scratch += n + 16;
    const pcb = out();
    expect(call("IStream_Read", stm, p, n, pcb)).toBe(S_OK);
    return Array.from(mem.subarray(p, p + u32(pcb)));
}

beforeEach(() => {
    files.clear();
    scratch = 0x20000;
    storage.resetStructuredStorage();
});

describe("docfile create / reopen", () => {
    test("streams written through IStream land in a compound file on the last Release", () => {
        const stg = createDoc("C:\\SAVE0001.SAV");
        const stm = createStream(stg, "CONTENTS");
        write(stm, [1, 2, 3, 4, 5]);
        call("IStream_Release", stm);
        call("IStorage_Release", stg);

        const root = parseCfb(files.get("C:\\SAVE0001.SAV")!);
        const contents = root.children.find((c) => c.name === "CONTENTS")!;
        expect(Array.from(contents.data)).toEqual([1, 2, 3, 4, 5]);
    });

    test("StgOpenStorage reads the tree back: OpenStream, Seek, Read, Stat, EnumElements", () => {
        const stg = createDoc("C:\\A.SAV");
        write(createStream(stg, "Version"), [9, 8, 7, 6]);
        createStream(stg, "CONTENTS");
        call("IStorage_Commit", stg, 0);

        const pp = out();
        expect(storage.stgOpenStorage(process, mem, [wide("C:\\A.SAV"), 0, STGM_READ | STGM_SHARE_EXCLUSIVE, 0, 0, pp])).toBe(S_OK);
        const ro = u32(pp);
        const pstm = out();
        expect(call("IStorage_OpenStream", ro, wide("version"), 0, STGM_READ | STGM_SHARE_EXCLUSIVE, 0, pstm)).toBe(S_OK);
        const stm = u32(pstm);
        expect(call("IStream_Seek", stm, 2, 0, 0, 0)).toBe(S_OK);
        expect(read(stm, 10)).toEqual([7, 6]);

        const stat = scratch; scratch += 80;
        expect(call("IStream_Stat", stm, stat, 1)).toBe(S_OK);
        expect(u32(stat + 4)).toBe(2); // STGTY_STREAM
        expect(u32(stat + 8)).toBe(4);

        const penum = out();
        expect(call("IStorage_EnumElements", ro, 0, 0, 0, penum)).toBe(S_OK);
        const rg = scratch; scratch += 72 * 4;
        const fetched = out();
        expect(call("IEnumSTATSTG_Next", u32(penum), 4, rg, fetched)).toBe(1); // S_FALSE: only 2
        expect(u32(fetched)).toBe(2);
    });

    test("Win32 error contract: exists / not found / read-only", () => {
        createDoc("C:\\B.SAV");
        const pp = out();
        expect(storage.stgCreateDocfile(process, mem, [wide("C:\\B.SAV"), RW, 0, pp])).toBe(STG_E_FILEALREADYEXISTS);
        expect(storage.stgOpenStorage(process, mem, [wide("C:\\NONE.SAV"), 0, 0, 0, 0, pp])).toBe(STG_E_FILENOTFOUND);

        expect(storage.stgOpenStorage(process, mem, [wide("C:\\B.SAV"), 0, STGM_READ, 0, 0, pp])).toBe(S_OK);
        const ro = u32(pp);
        expect(call("IStorage_CreateStream", ro, wide("X"), RW, 0, 0, out())).toBe(STG_E_ACCESSDENIED);
        expect(call("IStorage_OpenStream", ro, wide("MISSING"), 0, 0, 0, out())).toBe(STG_E_FILENOTFOUND);
        files.set("C:\\TEXT.TXT", new TextEncoder().encode("plain"));
        expect(storage.stgOpenStorage(process, mem, [wide("C:\\TEXT.TXT"), 0, 0, 0, 0, pp])).toBe(STG_E_FILEALREADYEXISTS);
        expect(storage.stgIsStorageFile(mem, [wide("C:\\TEXT.TXT")])).toBe(1);
        expect(storage.stgIsStorageFile(mem, [wide("C:\\B.SAV")])).toBe(S_OK);
    });
});

describe("OleSaveToStream / OleLoadFromStream", () => {
    interface Invocation { fn: number; args: number[]; onReturn: (ret: number) => number | null }
    let calls: Invocation[] = [];
    beforeEach(() => {
        calls = [];
        (System.getInstance() as any).process = {
            dispatcher: {
                callbackManager: {
                    saveSuspendedThunkContext: () => 1,
                    invokeCallback: (fn: number, args: number[], _c: number, onReturn: Invocation["onReturn"]) => {
                        calls.push({ fn, args, onReturn });
                        return { callbackId: calls.length };
                    },
                },
            },
        };
    });

    /** A guest COM object whose vtable slots are distinct fake code addresses (0xF000 + slot). */
    function guestObject(addr: number, base: number): number {
        const vtbl = addr + 0x40;
        view.setUint32(addr, vtbl, true);
        for (let i = 0; i < 8; i++) view.setUint32(vtbl + i * 4, base + i, true);
        return addr;
    }
    const CLSID = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 1, 2, 3, 4, 5, 6, 7, 8];

    test("writes the object's CLSID then lets IPersistStream::Save append its data", () => {
        const stm = createStream(createDoc("C:\\S.SAV"), "CONTENTS");
        const obj = guestObject(0x30000, 0xA000);
        const r: any = storage.oleSaveToStream(process, { esp: 0x8000 }, mem, [obj, stm]);
        expect(r.suspendedForCallback).toBe(true);

        expect(calls[0].fn).toBe(0xA003); // IPersistStream::GetClassID
        mem.set(CLSID, calls[0].args[1]);
        expect(calls[0].onReturn(S_OK)).toBeNull();
        expect(calls[1].fn).toBe(0xA006); // IPersistStream::Save(pStm, fClearDirty)
        expect(calls[1].args.slice(1)).toEqual([stm, 1]);
        write(stm, [0xEE, 0xFF]);
        expect(calls[1].onReturn(S_OK)).toBe(S_OK);

        call("IStream_Seek", stm, 0, 0, 0, 0);
        expect(read(stm, 32)).toEqual([...CLSID, 0xEE, 0xFF]);
    });

    test("reads the CLSID, creates via the registered factory, and IPersistStream::Load reads the rest", () => {
        const stm = createStream(createDoc("C:\\L.SAV"), "CONTENTS");
        write(stm, [...CLSID, 0xAB]);
        call("IStream_Seek", stm, 0, 0, 0, 0);
        const factory = guestObject(0x31000, 0xB000);
        const unk = guestObject(0x32000, 0xC000);
        const persist = guestObject(0x33000, 0xD000);
        const riid = wide("iid-bytes-here");
        const ppv = out();
        const seen: string[] = [];
        const r: any = storage.oleLoadFromStream(process, { esp: 0x8000 }, mem, [stm, riid, ppv], (clsid) => {
            seen.push(clsid);
            return factory;
        });
        expect(r.suspendedForCallback).toBe(true);
        expect(seen).toEqual(["44332211-6655-8877-0102-030405060708"]);

        expect(calls[0].fn).toBe(0xB003); // IClassFactory::CreateInstance(NULL, riid, ppv)
        expect(calls[0].args.slice(1, 3)).toEqual([0, riid]);
        view.setUint32(calls[0].args[3], unk, true);
        calls[0].onReturn(S_OK);
        expect(calls[1].fn).toBe(0xC000); // QueryInterface(IID_IPersistStream)
        view.setUint32(calls[1].args[2], persist, true);
        calls[1].onReturn(S_OK);
        expect(calls[2].fn).toBe(0xD005); // IPersistStream::Load(pStm)
        expect(read(stm, 4)).toEqual([0xAB]);
        calls[2].onReturn(S_OK);
        expect(calls[3].fn).toBe(0xD002); // Release the IPersistStream
        expect(calls[3].onReturn(1)).toBe(S_OK);
        expect(u32(ppv)).toBe(unk);
    });
});
