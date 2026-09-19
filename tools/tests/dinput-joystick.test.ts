// DirectInput joystick model: axis conditioning, D-pad hat, DIDATAFORMAT binding and the
// DIJOYSTATE layout; plus the winmm JOYCAPS/JOYINFOEX layouts.

import { describe, expect, test } from "bun:test";
import "../../src/worker/modules/ddraw/d3d/types";
import {
    DIJOYSTATE_FORMAT, DIJOYSTATE2_FORMAT, DIJOYSTATE_SIZE, DIJOYSTATE2_SIZE, DIPOV_CENTERED,
    GUID_XAXIS, GUID_YAXIS, GUID_BUTTON, GUID_POVOBJ, GUID_RXAXIS,
    axesForProperty, conditionAxis, defaultAxisConditioning, defaultJoystickAxes, parseJoystickDataFormat,
    povFromDpad, writeJoystickState, type JoystickSample,
} from "../../src/worker/modules/dinput/joystick-state";
import { registerWinmmJoystickExports } from "../../src/worker/modules/winmm-joystick";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

const sample = (over: Partial<JoystickSample> = {}): JoystickSample =>
    ({ connected: true, buttons: 0, axes: [0, 0, 0, 0], triggers: [0, 0], ...over });

describe("axis conditioning", () => {
    test("default range maps centre to 32768 and the extremes to 0 / 65535", () => {
        const c = defaultAxisConditioning();
        expect(conditionAxis(0, c)).toBe(32768);
        expect(conditionAxis(-1, c)).toBe(0);
        expect(conditionAxis(1, c)).toBe(65535);
    });
    test("honours an app range and a deadzone", () => {
        const c = { min: -1000, max: 1000, deadzone: 2000, saturation: 10000 };
        expect(conditionAxis(0.1, c)).toBe(0);          // inside the 20% deadzone
        expect(conditionAxis(0.6, c)).toBe(500);        // (0.6-0.2)/0.8 = 0.5 of the half-range
        expect(conditionAxis(-1, c)).toBe(-1000);
    });
    test("saturation pins the axis before full deflection", () => {
        const c = { min: 0, max: 100, deadzone: 0, saturation: 5000 };
        expect(conditionAxis(0.5, c)).toBe(100);
        expect(conditionAxis(-0.5, c)).toBe(0);
    });
});

describe("D-pad hat", () => {
    test("cardinals and diagonals in hundredths of a degree", () => {
        expect(povFromDpad(0)).toBe(DIPOV_CENTERED);
        expect(povFromDpad(1 << 12)).toBe(0);
        expect(povFromDpad(1 << 15)).toBe(9000);
        expect(povFromDpad(1 << 13)).toBe(18000);
        expect(povFromDpad(1 << 14)).toBe(27000);
        expect(povFromDpad((1 << 12) | (1 << 15))).toBe(4500);
        expect(povFromDpad((1 << 13) | (1 << 14))).toBe(22500);
    });
});

describe("DIJOYSTATE", () => {
    test("c_dfDIJoystick layout: axes, hat, buttons, D-pad only on the hat", () => {
        const mem = new Uint8Array(256);
        const s = sample({ buttons: (1 << 0) | (1 << 3) | (1 << 12), axes: [-32767, 16383, 32767, 0], triggers: [32767, 0] });
        writeJoystickState(mem, 16, DIJOYSTATE_SIZE, DIJOYSTATE_FORMAT, s, defaultJoystickAxes());
        const v = new DataView(mem.buffer);
        expect(v.getInt32(16 + 0, true)).toBe(0);        // lX full left
        expect(Math.abs(v.getInt32(16 + 4, true) - 49152)).toBeLessThanOrEqual(2); // lY half down
        expect(v.getInt32(16 + 8, true)).toBe(65535);    // lZ: left trigger fully in
        expect(v.getInt32(16 + 12, true)).toBe(65535);   // lRx
        expect(v.getInt32(16 + 16, true)).toBe(32768);   // lRy centre
        expect(v.getInt32(16 + 20, true)).toBe(32768);   // lRz centre
        expect(v.getUint32(16 + 32, true)).toBe(0);      // POV up
        expect(v.getUint32(16 + 36, true)).toBe(DIPOV_CENTERED);
        expect(mem[16 + 48]).toBe(0x80);
        expect(mem[16 + 51]).toBe(0x80);
        expect(mem[16 + 48 + 12]).toBe(0);               // D-pad is the hat, not a button
        expect(mem[16 + DIJOYSTATE_SIZE]).toBe(0);       // nothing written past the struct
    });
    test("DIJOYSTATE2 is fully initialised (no caller garbage past 80 bytes)", () => {
        const mem = new Uint8Array(300).fill(0xaa);
        writeJoystickState(mem, 0, DIJOYSTATE2_SIZE, DIJOYSTATE2_FORMAT, sample(), defaultJoystickAxes());
        for (let i = 48; i < DIJOYSTATE2_SIZE; i++) expect(mem[i]).toBe(0);
        expect(mem[DIJOYSTATE2_SIZE]).toBe(0xaa);
    });
    test("disconnected pad reads centred with no buttons", () => {
        const mem = new Uint8Array(128);
        writeJoystickState(mem, 0, DIJOYSTATE_SIZE, DIJOYSTATE_FORMAT, sample({ connected: false, buttons: 0xff }), defaultJoystickAxes());
        const v = new DataView(mem.buffer);
        expect(v.getInt32(0, true)).toBe(32768);
        expect(v.getUint32(32, true)).toBe(DIPOV_CENTERED);
        expect(mem[48]).toBe(0);
    });
});

describe("DIDATAFORMAT binding", () => {
    function buildFormat(mem: Uint8Array, base: number, dataSize: number,
        objs: Array<{ guid: number[] | null; ofs: number; type: number }>): number {
        const v = new DataView(mem.buffer);
        let guidAt = base + 32 + objs.length * 16;
        const rgodf = base + 32;
        objs.forEach((o, i) => {
            const e = rgodf + i * 16;
            if (o.guid) { mem.set(o.guid, guidAt); v.setUint32(e, guidAt, true); guidAt += 16; } else v.setUint32(e, 0, true);
            v.setUint32(e + 4, o.ofs, true);
            v.setUint32(e + 8, o.type, true);
        });
        v.setUint32(base, 32, true); v.setUint32(base + 4, 16, true); v.setUint32(base + 8, 1, true);
        v.setUint32(base + 12, dataSize, true); v.setUint32(base + 16, objs.length, true); v.setUint32(base + 20, rgodf, true);
        return base;
    }
    const ANY = 0xffff << 8;
    test("a custom 2-axis + 4-button format lands the pad at the app's offsets", () => {
        const mem = new Uint8Array(1024);
        const lpdf = buildFormat(mem, 64, 12, [
            { guid: GUID_YAXIS, ofs: 0, type: 0x02 | ANY },      // Y first
            { guid: GUID_XAXIS, ofs: 4, type: 0x02 | ANY },
            { guid: GUID_BUTTON, ofs: 8, type: 0x04 | ANY },
            { guid: GUID_BUTTON, ofs: 9, type: 0x04 | ANY },
            { guid: GUID_BUTTON, ofs: 10, type: 0x04 | ANY },
            { guid: GUID_BUTTON, ofs: 11, type: 0x04 | ANY },
        ]);
        const bound = parseJoystickDataFormat(mem, lpdf)!;
        expect(bound.dataSize).toBe(12);
        expect(bound.objects).toEqual([
            { ofs: 0, kind: "axis", index: 1 }, { ofs: 4, kind: "axis", index: 0 },
            { ofs: 8, kind: "button", index: 0 }, { ofs: 9, kind: "button", index: 1 },
            { ofs: 10, kind: "button", index: 2 }, { ofs: 11, kind: "button", index: 3 },
        ]);
        const out = new Uint8Array(32);
        writeJoystickState(out, 0, 12, bound.objects, sample({ axes: [32767, -32767, 0, 0], buttons: 0b1010 }), defaultJoystickAxes());
        const v = new DataView(out.buffer);
        expect(v.getInt32(0, true)).toBe(0);         // Y (up) at offset 0
        expect(v.getInt32(4, true)).toBe(65535);     // X (right) at offset 4
        expect(Array.from(out.subarray(8, 12))).toEqual([0, 0x80, 0, 0x80]);
    });
    test("anonymous axes bind in order; explicit instances and hats are honoured", () => {
        const mem = new Uint8Array(1024);
        const lpdf = buildFormat(mem, 64, 16, [
            { guid: null, ofs: 0, type: 0x02 | ANY },            // first free axis → X
            { guid: GUID_RXAXIS, ofs: 4, type: 0x02 | ANY },
            { guid: GUID_POVOBJ, ofs: 8, type: 0x10 | ANY },
            { guid: null, ofs: 12, type: 0x02 | (1 << 8) },      // axis instance 1 → Y
        ]);
        const bound = parseJoystickDataFormat(mem, lpdf)!;
        expect(bound.objects.map((o) => `${o.kind}${o.index}@${o.ofs}`)).toEqual(["axis0@0", "axis3@4", "pov0@8", "axis1@12"]);
    });
    test("property addressing by offset and by id resolves the bound axis", () => {
        const fmt = [{ ofs: 20, kind: "axis" as const, index: 3 }, { ofs: 0, kind: "button" as const, index: 0 }];
        expect(axesForProperty(fmt, 20, 1)).toEqual([3]);
        expect(axesForProperty(fmt, 0, 1)).toEqual([]);
        expect(axesForProperty(fmt, 0x02 | (5 << 8), 2)).toEqual([5]);
        expect(axesForProperty(fmt, 0, 0)).toHaveLength(8);
    });
});

describe("winmm joystick", () => {
    const exports: Record<string, ThunkImplementation> = {};
    registerWinmmJoystickExports(exports);
    const ctx = {} as Parameters<ThunkImplementation>[0];
    test("JOYCAPSA has the real field layout (404 bytes)", () => {
        const mem = new Uint8Array(1024);
        expect(exports["joyGetDevCapsA"](ctx, mem, [0, 16, 404])).toBe(0);
        const v = new DataView(mem.buffer);
        expect(v.getUint32(16 + 36, true)).toBe(0);       // wXmin
        expect(v.getUint32(16 + 40, true)).toBe(65535);   // wXmax
        expect(v.getUint32(16 + 60, true)).toBe(17);      // wNumButtons
        expect(v.getUint32(16 + 96, true) & 0x10).toBe(0x10); // JOYCAPS_HASPOV
        expect(v.getUint32(16 + 104, true)).toBe(5);      // wNumAxes
        expect(v.getUint32(16 + 108, true)).toBe(32);     // wMaxButtons
        expect(String.fromCharCode(...mem.subarray(20, 27))).toBe("Gamepad");
        expect(exports["joyGetDevCapsA"](ctx, mem, [0, 16, 64])).toBe(11);   // MMSYSERR_INVALPARAM: too small
        expect(exports["joyGetDevCapsA"](ctx, mem, [16, 16, 404])).toBe(165); // JOYERR_PARMS
    });
    test("joyGetNumDevs reports the 16 Windows joystick ids", () => {
        expect(exports["joyGetNumDevs"](ctx, new Uint8Array(0), [])).toBe(16);
    });
});
