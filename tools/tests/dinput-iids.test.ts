import { describe, expect, test } from "bun:test";
import "../../src/worker/modules/ddraw/d3d/types";
import { guidBytes } from "../../src/worker/modules/dinput/dinput";

describe("DirectInput GUID byte layout", () => {
    test("Data1..3 are little-endian in memory, Data4 as written", () => {
        // IID_IDirectInputDevice2A = {5944E682-C92E-11CF-BFC7-444553540000}: what a game's
        // QueryInterface(riid) points at is 82 e6 44 59 2e c9 cf 11 bf c7 44 45 53 54 00 00.
        expect(guidBytes("5944e682-c92e-11cf-bfc7-444553540000")).toEqual([
            0x82, 0xe6, 0x44, 0x59, 0x2e, 0xc9, 0xcf, 0x11, 0xbf, 0xc7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00,
        ]);
        expect(guidBytes("00000000-0000-0000-c000-000000000046").slice(8)).toEqual([0xc0, 0, 0, 0, 0, 0, 0, 0x46]);
        expect(guidBytes("54d41080-dc15-4833-a41b-748f73a38179").slice(0, 8)).toEqual([0x80, 0x10, 0xd4, 0x54, 0x15, 0xdc, 0x33, 0x48]);
    });
});
