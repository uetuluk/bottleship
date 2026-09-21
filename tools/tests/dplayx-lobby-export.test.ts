import { describe, expect, test } from "bun:test";
// Initialize shared graphics constants before the existing System import cycle.
import "../../src/worker/modules/ddraw/d3d/types";
import { dplayxModule } from "../../src/worker/api/dplayx.api";
import { generateStubDllSpec } from "../../src/worker/api/codegen";
import { DPlayX } from "../../src/worker/modules/dplayx/dplayx";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

describe("DirectPlayLobbyCreateW import compatibility", () => {
    test("ordinal 5 generates a five-argument stdcall thunk", () => {
        const descriptor = dplayxModule.functions.find((fn) => fn.ordinal === 5);
        expect(descriptor?.name).toBe("DirectPlayLobbyCreateW");
        const stub = generateStubDllSpec(dplayxModule).find((fn) => fn.name === descriptor?.name);
        expect(stub?.argCount).toBe(5);
        expect(stub?.stackCleanup).toBe(20);
    });

    test("name and ordinal dispatch to the lobby handler and reject a null output pointer", () => {
        const module = new DPlayX();
        // Register exports without booting the unrelated CPU and graphics subsystems.
        (module as unknown as { registerDirectExports(): void }).registerDirectExports();
        const named = module.exports["directplaylobbycreatew"];
        const ordinal = module.exports["ord_5"];
        expect(typeof ordinal).toBe("function");
        expect(ordinal).toBe(named);
        const ctx = {} as Parameters<ThunkImplementation>[0];
        expect(ordinal(ctx, new Uint8Array(4096), [0, 0, 0, 0, 0])).toBe(0x80004003);
    });
});

describe("TCP/IP connection address", () => {
    test("EnumConnections hands out DPAID_TotalSize followed by the TCP/IP service provider", async () => {
        const { DirectPlay4Api, DPAID_TOTALSIZE, DPAID_SERVICEPROVIDER, DPSPGUID_TCPIP } =
            await import("../../src/worker/modules/dplayx/directplay4");
        const address = DirectPlay4Api.tcpipConnection();
        const view = new DataView(address.buffer);
        expect([...address.subarray(0, 16)]).toEqual([...DPAID_TOTALSIZE]);
        expect(view.getUint32(16, true)).toBe(4);
        expect(view.getUint32(20, true)).toBe(address.length);
        expect([...address.subarray(24, 40)]).toEqual([...DPAID_SERVICEPROVIDER]);
        expect(view.getUint32(40, true)).toBe(16);
        expect([...address.subarray(44, 60)]).toEqual([...DPSPGUID_TCPIP]);
    });

    test("DirectPlayEnumerate is exported by name and ordinal, ANSI and Unicode", () => {
        const module = new DPlayX();
        (module as unknown as { registerDirectExports(): void }).registerDirectExports();
        for (const name of ["directplayenumeratea", "ord_2", "directplayenumeratew", "ord_3", "directplayenumerate", "ord_9"]) {
            expect(typeof module.exports[name]).toBe("function");
        }
        expect(module.exports["ord_9"]).toBe(module.exports["ord_2"]);
    });
});
