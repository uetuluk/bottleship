// DirectMusic core object: vtable layout matches dmusicc.h and the port-less semantics
// the DX version probe relies on (object creatable, QueryInterface for IDirectMusic OK).

import { describe, expect, test } from "bun:test";
import "../../src/worker/modules/ddraw/d3d/types";
import { dmusicModule, IDirectMusic2 } from "../../src/worker/api/dmusic.api";
import { DMusic, IID_IDIRECTMUSIC, IID_IDIRECTMUSIC2 } from "../../src/worker/modules/dmusic/dmusic";
import { THUNKED_DLL_PSEUDO_BASE } from "../../src/worker/core/hle-system-catalog";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

function guidBytes(guid: string): Uint8Array {
    const hex = guid.replace(/-/g, "");
    const b = (i: number) => parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    const out = new Uint8Array(16);
    // Data1..Data3 little-endian, Data4 as-is
    out.set([b(3), b(2), b(1), b(0), b(5), b(4), b(7), b(6)], 0);
    for (let i = 8; i < 16; i++) out[i] = b(i);
    return out;
}

describe("dmusic descriptor", () => {
    test("IDirectMusic2 vtable has the dmusicc.h slot order", () => {
        const names = IDirectMusic2.methods.map((m) => m.name);
        expect(names.slice(0, 3)).toEqual(["QueryInterface", "AddRef", "Release"]);
        expect(names[3]).toBe("EnumPort");
        expect(names[11]).toBe("SetDirectSound");
        expect(names[12]).toBe("SetExternalMasterClock");
        expect(names.length).toBe(13);
        expect(IDirectMusic2.iid).toBe(IID_IDIRECTMUSIC2);
        expect(dmusicModule.name).toBe("dmusic");
    });

    test("dmusic.dll is a virtual system DLL so LoadLibrary succeeds", () => {
        expect(THUNKED_DLL_PSEUDO_BASE.dmusic).toBeGreaterThan(0);
        const bases = Object.values(THUNKED_DLL_PSEUDO_BASE);
        expect(new Set(bases).size).toBe(bases.length);
    });
});

describe("IDirectMusic methods", () => {
    const mod = new DMusic();
    mod.registerExports();
    let bound = new Uint8Array(0);
    Mem.bind(() => bound);
    const fresh = (): Uint8Array => (bound = new Uint8Array(0x100));
    const ctx = {} as Parameters<ThunkImplementation>[0];
    const call = (name: string, mem: Uint8Array, args: number[]) => mod.exports[name](ctx, mem, args) as number;

    test("QueryInterface accepts IDirectMusic and rejects strangers", () => {
        const mem = fresh();
        mem.set(guidBytes(IID_IDIRECTMUSIC), 0x10);
        expect(call("IDirectMusic2_QueryInterface", mem, [0x1234, 0x10, 0x40])).toBe(0);
        expect(new DataView(mem.buffer).getUint32(0x40, true)).toBe(0x1234);
        mem.set(guidBytes("11111111-2222-3333-4444-555555555555"), 0x20);
        expect(call("IDirectMusic2_QueryInterface", mem, [0x1234, 0x20, 0x40]) >>> 0).toBe(0x80004002);
    });

    test("no ports: EnumPort ends immediately, CreatePort fails cleanly", () => {
        const mem = fresh();
        expect(call("IDirectMusic2_EnumPort", mem, [1, 0, 0x50])).toBe(1);
        expect(call("IDirectMusic2_CreatePort", mem, [1, 0, 0, 0x60, 0]) >>> 0).toBe(0x88780134);
        expect(call("IDirectMusic2_Activate", mem, [1, 1])).toBe(0);
    });
});
