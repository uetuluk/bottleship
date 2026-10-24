/**
 * Service Control Manager entry points outside an SCM child.
 *
 * StartServiceCtrlDispatcherA returning TRUE is the worst kind of lie: a game that
 * probes "am I running as a service?" takes its service branch, registers a handler
 * and exits cleanly — before it ever creates a window. Windows answers FALSE with
 * ERROR_FAILED_SERVICE_CONTROLLER_CONNECT; Diablo II's 1.14 build relies on that.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Advapi32 } from "../../src/worker/modules/advapi32";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

let mem: Uint8Array;
let exports: Record<string, any>;

function call(name: string, ...args: number[]): number {
    const r = exports[name]!({ esp: 0 } as any, mem, args as any);
    return typeof r === "number" ? r : r.value;
}

beforeEach(() => {
    mem = new Uint8Array(0x10000);
    Mem.bind(() => mem);
    const mod = new Advapi32();
    mod.initialize({ resourceProvider: { getKernelObject: () => null } } as any);
    exports = mod.exports;
});

describe("StartServiceCtrlDispatcherA", () => {
    test("outside an SCM child: FALSE, never the service-main branch", () => {
        expect(call("StartServiceCtrlDispatcherA", 0x1000)).toBe(0);
    });

    test("RegisterServiceCtrlHandlerA has no status handle to return", () => {
        expect(call("RegisterServiceCtrlHandlerA", 0, 0x1000)).toBe(0);
    });
});
