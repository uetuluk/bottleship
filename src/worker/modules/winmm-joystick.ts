/**
 * winmm joystick API (joyGetNumDevs / joyGetDevCaps / joyGetPos / joyGetPosEx /
 * joyGetThreshold / joySetThreshold) over the host gamepad, laid out the way the
 * Xbox-class driver reports it: X/Y = left stick, Z = triggers, R = right stick Y,
 * U = right stick X, POV = D-pad, 0..65535 per axis.
 */
import { ThunkImplementation } from '../core/thunking/thunk-dispatcher';
import { System } from '../core/system';
import { encodeAnsi } from './codepage-utils';
import { povFromDpad, DIPOV_CENTERED } from './dinput/joystick-state';

const MMSYSERR_NOERROR = 0;
const MMSYSERR_INVALPARAM = 11;
const JOYERR_PARMS = 165;
const JOYERR_UNPLUGGED = 167;
const JOY_POVCENTERED = 0xffff;

/** Windows exposes 16 joystick ids; only the first is ever backed by the browser pad. */
const JOY_DEVICE_COUNT = 16;
const JOYCAPSA_SIZE = 404;
const JOYCAPSW_SIZE = 728;
const JOYCAPS_HASZ = 0x0001, JOYCAPS_HASR = 0x0002, JOYCAPS_HASU = 0x0004, JOYCAPS_HASPOV = 0x0010, JOYCAPS_POV4DIR = 0x0020;
const JOYINFO_SIZE = 16;
const JOYINFOEX_SIZE = 52;

const AXIS_MAX = 65535;
const toAxis = (v: number): number => Math.max(0, Math.min(AXIS_MAX, ((v | 0) + 32767) * 2));
/** Combined trigger axis: idle centre, left trigger up, right trigger down. */
const triggerAxis = (lt: number, rt: number): number => toAxis(lt - rt);
const popcount = (v: number): number => { let n = 0; for (let x = v >>> 0; x; x &= x - 1) n++; return n; };

export function registerWinmmJoystickExports(exports: Record<string, ThunkImplementation>): void {
    const thresholds = new Map<number, number>();

    exports["joyGetNumDevs"] = () => JOY_DEVICE_COUNT;

    const writeCaps = (mem: Uint8Array, pjc: number, cbjc: number, wide: boolean): number => {
        const size = wide ? JOYCAPSW_SIZE : JOYCAPSA_SIZE;
        if (!pjc || cbjc < size || pjc + size > mem.length) return MMSYSERR_INVALPARAM;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        mem.fill(0, pjc, pjc + size);
        view.setUint16(pjc + 0, 0x045e, true);   // wMid (Microsoft)
        view.setUint16(pjc + 2, 0x028e, true);   // wPid (Xbox-class controller)
        const name = "Gamepad";
        if (wide) {
            for (let i = 0; i < name.length; i++) view.setUint16(pjc + 4 + i * 2, name.charCodeAt(i), true);
        } else {
            mem.set(encodeAnsi(name).subarray(0, 31), pjc + 4);
        }
        // Axis ranges, button/period/caps block follows szPname (32 chars: 32 or 64 bytes).
        let p = pjc + 4 + (wide ? 64 : 32);
        const u32 = (v: number) => { view.setUint32(p, v >>> 0, true); p += 4; };
        u32(0); u32(AXIS_MAX);     // wXmin, wXmax
        u32(0); u32(AXIS_MAX);     // wYmin, wYmax
        u32(0); u32(AXIS_MAX);     // wZmin, wZmax
        u32(17);                   // wNumButtons
        u32(10); u32(1000);        // wPeriodMin, wPeriodMax
        u32(0); u32(AXIS_MAX);     // wRmin, wRmax
        u32(0); u32(AXIS_MAX);     // wUmin, wUmax
        u32(0); u32(AXIS_MAX);     // wVmin, wVmax
        u32(JOYCAPS_HASZ | JOYCAPS_HASR | JOYCAPS_HASU | JOYCAPS_HASPOV | JOYCAPS_POV4DIR); // wCaps
        u32(6);                    // wMaxAxes
        u32(5);                    // wNumAxes (X, Y, Z, R, U)
        u32(32);                   // wMaxButtons
        // szRegKey / szOEMVxD stay empty.
        return MMSYSERR_NOERROR;
    };

    exports["joyGetDevCapsA"] = (ctx, mem, args) => {
        if ((args[0] | 0) >= JOY_DEVICE_COUNT && args[0] !== 0xffffffff) return JOYERR_PARMS;
        return writeCaps(mem, args[1], args[2], false);
    };
    exports["joyGetDevCapsW"] = (ctx, mem, args) => {
        if ((args[0] | 0) >= JOY_DEVICE_COUNT && args[0] !== 0xffffffff) return JOYERR_PARMS;
        return writeCaps(mem, args[1], args[2], true);
    };

    const readPad = (uJoyID: number) => {
        if (uJoyID !== 0) return null;
        const inputManager = System.getInstance().inputManager;
        inputManager.noteGuestGamepadRead();
        const pad = inputManager.getGamepadState();
        return pad.connected ? pad : null;
    };

    exports["joyGetPos"] = (ctx, mem, args) => {
        const uJoyID = args[0];
        const pji = args[1];
        if (!pji || pji + JOYINFO_SIZE > mem.length) return MMSYSERR_INVALPARAM;
        if (uJoyID >= JOY_DEVICE_COUNT) return JOYERR_PARMS;
        const pad = readPad(uJoyID);
        if (!pad) return JOYERR_UNPLUGGED;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(pji + 0, toAxis(pad.axes[0]), true);                       // wXpos
        view.setUint32(pji + 4, toAxis(pad.axes[1]), true);                       // wYpos
        view.setUint32(pji + 8, triggerAxis(pad.triggers[0], pad.triggers[1]), true); // wZpos
        view.setUint32(pji + 12, pad.buttons & 0xf, true);                        // wButtons (JOY_BUTTON1..4)
        return MMSYSERR_NOERROR;
    };

    exports["joyGetPosEx"] = (ctx, mem, args) => {
        const uJoyID = args[0];
        const pji = args[1];
        if (!pji || pji + JOYINFOEX_SIZE > mem.length) return MMSYSERR_INVALPARAM;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if (view.getUint32(pji, true) < JOYINFOEX_SIZE) return MMSYSERR_INVALPARAM;
        if (uJoyID >= JOY_DEVICE_COUNT) return JOYERR_PARMS;
        const pad = readPad(uJoyID);
        if (!pad) return JOYERR_UNPLUGGED;

        const [lx, ly, rx, ry] = pad.axes;
        const buttons = pad.buttons >>> 0;
        const pov = povFromDpad(buttons);
        view.setUint32(pji + 8, toAxis(lx), true);                                  // dwXpos
        view.setUint32(pji + 12, toAxis(ly), true);                                 // dwYpos
        view.setUint32(pji + 16, triggerAxis(pad.triggers[0], pad.triggers[1]), true); // dwZpos
        view.setUint32(pji + 20, toAxis(ry), true);                                 // dwRpos
        view.setUint32(pji + 24, toAxis(rx), true);                                 // dwUpos
        view.setUint32(pji + 28, AXIS_MAX >> 1, true);                              // dwVpos (none: centre)
        view.setUint32(pji + 32, buttons, true);                                    // dwButtons
        view.setUint32(pji + 36, popcount(buttons), true);                          // dwButtonNumber
        view.setUint32(pji + 40, pov === DIPOV_CENTERED ? JOY_POVCENTERED : pov, true); // dwPOV
        view.setUint32(pji + 44, 0, true);
        view.setUint32(pji + 48, 0, true);
        return MMSYSERR_NOERROR;
    };

    exports["joyGetThreshold"] = (ctx, mem, args) => {
        const uJoyID = args[0];
        const puThreshold = args[1];
        if (!puThreshold || puThreshold + 4 > mem.length) return MMSYSERR_INVALPARAM;
        if (uJoyID >= JOY_DEVICE_COUNT) return JOYERR_PARMS;
        new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint32(puThreshold, thresholds.get(uJoyID) ?? 0, true);
        return MMSYSERR_NOERROR;
    };
    exports["joySetThreshold"] = (ctx, mem, args) => {
        if (args[0] >= JOY_DEVICE_COUNT) return JOYERR_PARMS;
        thresholds.set(args[0], args[1] >>> 0);
        return MMSYSERR_NOERROR;
    };
}
