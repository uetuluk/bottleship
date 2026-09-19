/**
 * DirectInput joystick data model — pure, so it is unit-testable without the System.
 *
 * The host delivers a browser "standard mapping" pad: sticks as ±32767, triggers as
 * 0..32767, buttons as a bitmask (12..15 = D-pad). DirectInput presents that as absolute
 * axes conditioned per object (DIPROP_RANGE / DEADZONE / SATURATION), a POV hat for the
 * D-pad, and buttons, laid out wherever the app's DIDATAFORMAT asked for them.
 */

export const DIPOV_CENTERED = 0xffffffff;
export const DIJOYSTATE_SIZE = 80;
export const DIJOYSTATE2_SIZE = 272;

const DIDFT_RELAXIS = 0x01;
const DIDFT_ABSAXIS = 0x02;
const DIDFT_PSHBUTTON = 0x04;
const DIDFT_TGLBUTTON = 0x08;
const DIDFT_POV = 0x10;
const DIDFT_ANYINSTANCE = 0xffff;

const guid = (first: number, rest: number[]): number[] => [first, ...rest];
const AXIS_TAIL = [0x02, 0x6d, 0xa3, 0xf3, 0xc9, 0xcf, 0x11, 0xbf, 0xc7, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00];
export const GUID_XAXIS = guid(0xe0, AXIS_TAIL);
export const GUID_YAXIS = guid(0xe1, AXIS_TAIL);
export const GUID_ZAXIS = guid(0xe2, AXIS_TAIL);
export const GUID_RZAXIS = guid(0xe3, AXIS_TAIL);
export const GUID_SLIDER = guid(0xe4, AXIS_TAIL);
export const GUID_BUTTON = guid(0xf0, AXIS_TAIL);
export const GUID_POVOBJ = guid(0xf2, AXIS_TAIL);
export const GUID_RXAXIS = guid(0xf4, AXIS_TAIL);
export const GUID_RYAXIS = guid(0xf5, AXIS_TAIL);

/** Axis ids: 0 X, 1 Y, 2 Z (triggers), 3 Rx, 4 Ry, 5 Rz, 6 Slider0, 7 Slider1. */
export const JOY_AXIS_COUNT = 8;
export const JOY_AXIS_GUIDS = [GUID_XAXIS, GUID_YAXIS, GUID_ZAXIS, GUID_RXAXIS, GUID_RYAXIS, GUID_RZAXIS, GUID_SLIDER, GUID_SLIDER];
export const JOY_AXIS_NAMES = ["X Axis", "Y Axis", "Z Axis", "X Rotation", "Y Rotation", "Z Rotation", "Slider", "Slider"];
/** Objects a game can actually drive from a standard-mapping pad. */
export const JOY_REPORTED_AXES = 6;
export const JOY_REPORTED_BUTTONS = 17;
export const JOY_REPORTED_POVS = 1;
/** Browser standard-mapping D-pad buttons, exposed as the hat rather than as buttons. */
const DPAD_UP = 12, DPAD_DOWN = 13, DPAD_LEFT = 14, DPAD_RIGHT = 15;
const DPAD_MASK = (1 << DPAD_UP) | (1 << DPAD_DOWN) | (1 << DPAD_LEFT) | (1 << DPAD_RIGHT);

export interface AxisConditioning {
    min: number;
    max: number;
    /** 0..10000: fraction of the half-range reported as centre. */
    deadzone: number;
    /** 0..10000: fraction of the half-range beyond which the axis reads full. */
    saturation: number;
}

export const defaultAxisConditioning = (): AxisConditioning => ({ min: 0, max: 65535, deadzone: 0, saturation: 10000 });
export const defaultJoystickAxes = (): AxisConditioning[] =>
    Array.from({ length: JOY_AXIS_COUNT }, () => defaultAxisConditioning());

export interface JoystickSample {
    connected: boolean;
    buttons: number;
    /** Left X/Y, right X/Y as ±32767. */
    axes: [number, number, number, number];
    /** Left/right analog triggers as 0..32767. */
    triggers: [number, number];
}

/** Raw axis position as -1..1 (unmapped axes rest at centre; sliders at their minimum). */
export function axisNormalized(sample: JoystickSample, axis: number): number {
    if (!sample.connected) return axis >= 6 ? -1 : 0;
    const s = (v: number) => Math.max(-1, Math.min(1, v / 32767));
    switch (axis) {
        case 0: return s(sample.axes[0]);
        case 1: return s(sample.axes[1]);
        // Combined trigger axis the way the Xbox DirectInput driver reports it: left pulls
        // positive, right pulls negative, both idle = centre.
        case 2: return s(sample.triggers[0] - sample.triggers[1]);
        case 3: return s(sample.axes[2]);
        case 4: return s(sample.axes[3]);
        case 5: return 0;
        default: return -1;
    }
}

/** DirectInput deadzone/saturation shaping, then scale into the object's range. */
export function conditionAxis(n: number, c: AxisConditioning): number {
    const dz = Math.max(0, Math.min(10000, c.deadzone)) / 10000;
    const sat = Math.max(dz, Math.min(10000, c.saturation)) / 10000;
    let a = Math.abs(n);
    if (a <= dz) a = 0;
    else if (a >= sat) a = 1;
    else a = (a - dz) / Math.max(1e-9, sat - dz);
    const shaped = Math.sign(n) * a;
    const value = Math.round(c.min + ((shaped + 1) / 2) * (c.max - c.min));
    return Math.max(Math.min(c.min, c.max), Math.min(Math.max(c.min, c.max), value)) | 0;
}

/** Hat angle in hundredths of a degree (0 = up, clockwise), or centred. */
export function povFromDpad(buttons: number): number {
    const up = !!(buttons & (1 << DPAD_UP)), down = !!(buttons & (1 << DPAD_DOWN));
    const left = !!(buttons & (1 << DPAD_LEFT)), right = !!(buttons & (1 << DPAD_RIGHT));
    if (up && right) return 4500;
    if (down && right) return 13500;
    if (down && left) return 22500;
    if (up && left) return 31500;
    if (up) return 0;
    if (right) return 9000;
    if (down) return 18000;
    if (left) return 27000;
    return DIPOV_CENTERED;
}

/** Button state for rgbButtons[i]: browser indices, with the D-pad living on the hat. */
export function buttonPressed(buttons: number, index: number): boolean {
    if (index >= 32) return false;
    return ((buttons & ~DPAD_MASK) & (1 << index)) !== 0;
}

export interface JoyFormatObject {
    ofs: number;
    kind: "axis" | "button" | "pov";
    index: number;
}

function standardFormat(buttonCount: number): JoyFormatObject[] {
    const objs: JoyFormatObject[] = [];
    for (let a = 0; a < JOY_AXIS_COUNT; a++) objs.push({ ofs: a * 4, kind: "axis", index: a });
    for (let p = 0; p < 4; p++) objs.push({ ofs: 32 + p * 4, kind: "pov", index: p });
    for (let b = 0; b < buttonCount; b++) objs.push({ ofs: 48 + b, kind: "button", index: b });
    return objs;
}
/** c_dfDIJoystick: 8 axes @0, 4 POVs @32, 32 buttons @48. */
export const DIJOYSTATE_FORMAT: JoyFormatObject[] = standardFormat(32);
/** c_dfDIJoystick2: DIJOYSTATE plus buttons 32..127 @80 and the velocity/accel/force blocks (left zero). */
export const DIJOYSTATE2_FORMAT: JoyFormatObject[] = standardFormat(128);

function guidEquals(mem: Uint8Array, ptr: number, g: number[]): boolean {
    if (ptr + 16 > mem.length) return false;
    for (let i = 0; i < 16; i++) if (mem[ptr + i] !== g[i]) return false;
    return true;
}

/**
 * Bind an app DIDATAFORMAT (SetDataFormat) to the pad's objects the way DirectInput does:
 * each format entry claims the first unclaimed device object of its type class whose GUID
 * (when given) and instance (when not ANYINSTANCE) match. Entries that fit nothing are
 * skipped (c_dfDIJoystick marks everything optional; a stricter app format would be
 * rejected by real DirectInput, but a lenient bind keeps the game running).
 */
export function parseJoystickDataFormat(mem: Uint8Array, lpdf: number): { dataSize: number; objects: JoyFormatObject[] } | null {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    if (lpdf + 24 > mem.length) return null;
    const objSize = view.getUint32(lpdf + 4, true);
    const dataSize = view.getUint32(lpdf + 12, true);
    const numObjs = view.getUint32(lpdf + 16, true);
    const rgodf = view.getUint32(lpdf + 20, true);
    if (objSize < 16 || numObjs > 1024 || !rgodf || rgodf + numObjs * objSize > mem.length) return null;

    const usedAxis = new Set<number>(), usedButton = new Set<number>(), usedPov = new Set<number>();
    const objects: JoyFormatObject[] = [];
    for (let i = 0; i < numObjs; i++) {
        const e = rgodf + i * objSize;
        const pguid = view.getUint32(e, true);
        const ofs = view.getUint32(e + 4, true);
        const type = view.getUint32(e + 8, true);
        const cls = type & 0xff;
        const inst = (type >>> 8) & 0xffff;
        const any = inst === DIDFT_ANYINSTANCE;
        if (cls & (DIDFT_ABSAXIS | DIDFT_RELAXIS)) {
            let pick = -1;
            for (let a = 0; a < JOY_AXIS_COUNT; a++) {
                if (usedAxis.has(a)) continue;
                if (pguid && !guidEquals(mem, pguid, JOY_AXIS_GUIDS[a])) continue;
                if (!any && inst !== a) continue;
                pick = a; break;
            }
            if (pick >= 0 && ofs + 4 <= dataSize) { usedAxis.add(pick); objects.push({ ofs, kind: "axis", index: pick }); }
        } else if (cls & (DIDFT_PSHBUTTON | DIDFT_TGLBUTTON)) {
            if (pguid && !guidEquals(mem, pguid, GUID_BUTTON)) continue;
            let pick = -1;
            for (let b = 0; b < 128; b++) {
                if (usedButton.has(b)) continue;
                if (!any && inst !== b) continue;
                pick = b; break;
            }
            if (pick >= 0 && ofs < dataSize) { usedButton.add(pick); objects.push({ ofs, kind: "button", index: pick }); }
        } else if (cls & DIDFT_POV) {
            if (pguid && !guidEquals(mem, pguid, GUID_POVOBJ)) continue;
            let pick = -1;
            for (let p = 0; p < 4; p++) {
                if (usedPov.has(p)) continue;
                if (!any && inst !== p) continue;
                pick = p; break;
            }
            if (pick >= 0 && ofs + 4 <= dataSize) { usedPov.add(pick); objects.push({ ofs, kind: "pov", index: pick }); }
        }
    }
    return { dataSize, objects };
}

/** Fill `cbData` bytes at `lpvData` from the sample, object by object. */
export function writeJoystickState(
    mem: Uint8Array, lpvData: number, cbData: number,
    objects: JoyFormatObject[], sample: JoystickSample, axes: AxisConditioning[],
): void {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    mem.fill(0, lpvData, lpvData + cbData);
    for (const o of objects) {
        const at = lpvData + o.ofs;
        switch (o.kind) {
            case "axis":
                if (o.ofs + 4 > cbData) break;
                view.setInt32(at, conditionAxis(axisNormalized(sample, o.index), axes[o.index] ?? defaultAxisConditioning()), true);
                break;
            case "pov":
                if (o.ofs + 4 > cbData) break;
                view.setUint32(at, o.index === 0 && sample.connected ? povFromDpad(sample.buttons) : DIPOV_CENTERED, true);
                break;
            case "button":
                if (o.ofs >= cbData) break;
                mem[at] = sample.connected && buttonPressed(sample.buttons, o.index) ? 0x80 : 0x00;
                break;
        }
    }
}

/** Axis addressed by a DIPROPHEADER (dwObj/dwHow) against the bound format, or all axes. */
export function axesForProperty(objects: JoyFormatObject[], dwObj: number, dwHow: number): number[] {
    const DIPH_DEVICE = 0, DIPH_BYOFFSET = 1, DIPH_BYID = 2;
    if (dwHow === DIPH_DEVICE) return Array.from({ length: JOY_AXIS_COUNT }, (_, i) => i);
    if (dwHow === DIPH_BYOFFSET) {
        const hit = objects.find((o) => o.kind === "axis" && o.ofs === dwObj);
        return hit ? [hit.index] : [];
    }
    if (dwHow === DIPH_BYID) {
        if (!((dwObj & 0xff) & (DIDFT_ABSAXIS | DIDFT_RELAXIS))) return [];
        const inst = (dwObj >>> 8) & 0xffff;
        return inst < JOY_AXIS_COUNT ? [inst] : [];
    }
    return [];
}
