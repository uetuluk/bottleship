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
