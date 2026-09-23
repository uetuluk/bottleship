/** API census: silent-stub flags, including handlers that report E_NOTIMPL themselves. */
import { beforeEach, describe, expect, test } from "bun:test";
import { apiCensus } from "../../src/worker/core/diagnostics/api-census";

beforeEach(() => apiCensus.clear());

describe("apiCensus suspect stubs", () => {
    test("a handler that returned E_NOTIMPL is listed as a suspect stub", () => {
        apiCensus.record("ole32:StgCreateDocfile", 3, 0x5d5015);
        apiCensus.record("kernel32:CreateFileA", 3, 0x5be4df);
        expect(apiCensus.suspectStubs()).toEqual([]);
        apiCensus.noteNotImplemented("ole32:StgCreateDocfile");
        expect(apiCensus.suspectStubs().map((s) => [s.name, s.notImpl])).toEqual([["ole32:StgCreateDocfile", true]]);
    });

    test("arity-0 handlers are still flagged without an E_NOTIMPL result", () => {
        apiCensus.record("d3d8:IDirect3DDevice8_Nop", 0, 0);
        expect(apiCensus.suspectStubs()[0]).toMatchObject({ name: "d3d8:IDirect3DDevice8_Nop", notImpl: false });
    });
});
