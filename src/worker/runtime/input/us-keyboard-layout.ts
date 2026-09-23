/**
 * US keyboard layout: the key that PRODUCES a character, and the key behind a DOM
 * KeyboardEvent, both as Win32 virtual-key codes. Pure — shared by the host
 * (keyboard/soft-keyboard bridge) and the worker harness (`type`/`key` verbs).
 */

export interface KeyChord { vk: number; shift: boolean }

export const VK_BACK = 0x08, VK_TAB = 0x09, VK_RETURN = 0x0d, VK_SHIFT = 0x10, VK_CONTROL = 0x11,
    VK_MENU = 0x12, VK_ESCAPE = 0x1b, VK_SPACE = 0x20, VK_DELETE = 0x2e;

/** Shifted symbols and OEM punctuation: '!' is Shift+'1' (VK 0x31), not char code 33. */
const SYMBOL_CHORDS: Record<string, KeyChord> = {
    "!": { vk: 0x31, shift: true }, "@": { vk: 0x32, shift: true }, "#": { vk: 0x33, shift: true },
    "$": { vk: 0x34, shift: true }, "%": { vk: 0x35, shift: true }, "^": { vk: 0x36, shift: true },
    "&": { vk: 0x37, shift: true }, "*": { vk: 0x38, shift: true }, "(": { vk: 0x39, shift: true }, ")": { vk: 0x30, shift: true },
    ";": { vk: 0xba, shift: false }, ":": { vk: 0xba, shift: true },
    "=": { vk: 0xbb, shift: false }, "+": { vk: 0xbb, shift: true },
    ",": { vk: 0xbc, shift: false }, "<": { vk: 0xbc, shift: true },
    "-": { vk: 0xbd, shift: false }, "_": { vk: 0xbd, shift: true },
    ".": { vk: 0xbe, shift: false }, ">": { vk: 0xbe, shift: true },
    "/": { vk: 0xbf, shift: false }, "?": { vk: 0xbf, shift: true },
    "`": { vk: 0xc0, shift: false }, "~": { vk: 0xc0, shift: true },
    "[": { vk: 0xdb, shift: false }, "{": { vk: 0xdb, shift: true },
    "\\": { vk: 0xdc, shift: false }, "|": { vk: 0xdc, shift: true },
    "]": { vk: 0xdd, shift: false }, "}": { vk: 0xdd, shift: true },
    "'": { vk: 0xde, shift: false }, '"': { vk: 0xde, shift: true },
};

/** The US-layout chord that types `ch`; null for characters no key produces. */
export function charToKey(ch: string): KeyChord | null {
    if (ch.length !== 1) return null; // astral / surrogate half
    if (ch >= "A" && ch <= "Z") return { vk: ch.charCodeAt(0), shift: true };
    if (ch >= "a" && ch <= "z") return { vk: ch.charCodeAt(0) - 32, shift: false };
    if (ch >= "0" && ch <= "9") return { vk: ch.charCodeAt(0), shift: false };
    if (ch === " ") return { vk: VK_SPACE, shift: false };
    if (ch === "\t") return { vk: VK_TAB, shift: false };
    if (ch === "\n" || ch === "\r") return { vk: VK_RETURN, shift: false };
    return SYMBOL_CHORDS[ch] ?? null;
}

/** KeyboardEvent.code (physical key) → VK. Covers every key a US keyboard reports. */
const CODE_TO_VK: Record<string, number> = {
    Backspace: VK_BACK, Tab: VK_TAB, Enter: VK_RETURN, NumpadEnter: VK_RETURN,
    ShiftLeft: VK_SHIFT, ShiftRight: VK_SHIFT, ControlLeft: VK_CONTROL, ControlRight: VK_CONTROL,
    AltLeft: VK_MENU, AltRight: VK_MENU, Pause: 0x13, CapsLock: 0x14, Escape: VK_ESCAPE, Space: VK_SPACE,
    PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24,
    ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
    PrintScreen: 0x2c, Insert: 0x2d, Delete: VK_DELETE,
    MetaLeft: 0x5b, MetaRight: 0x5c, ContextMenu: 0x5d,
    NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f,
    NumLock: 0x90, ScrollLock: 0x91,
    Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe, Slash: 0xbf, Backquote: 0xc0,
    BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde, IntlBackslash: 0xe2,
};
for (let i = 0; i < 26; i++) CODE_TO_VK[`Key${String.fromCharCode(65 + i)}`] = 0x41 + i;
for (let i = 0; i < 10; i++) { CODE_TO_VK[`Digit${i}`] = 0x30 + i; CODE_TO_VK[`Numpad${i}`] = 0x60 + i; }
for (let i = 1; i <= 24; i++) CODE_TO_VK[`F${i}`] = 0x70 + i - 1;

/** KeyboardEvent.key names for keys whose `code` a soft keyboard leaves empty. */
const KEY_NAME_TO_VK: Record<string, number> = {
    Backspace: VK_BACK, Tab: VK_TAB, Enter: VK_RETURN, Shift: VK_SHIFT, Control: VK_CONTROL, Alt: VK_MENU,
    Escape: VK_ESCAPE, Esc: VK_ESCAPE, " ": VK_SPACE, Spacebar: VK_SPACE, PageUp: 0x21, PageDown: 0x22,
    End: 0x23, Home: 0x24, ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
    Left: 0x25, Up: 0x26, Right: 0x27, Down: 0x28, Insert: 0x2d, Delete: VK_DELETE, Del: VK_DELETE,
    Meta: 0x5b, CapsLock: 0x14, NumLock: 0x90, ScrollLock: 0x91, Pause: 0x13, PrintScreen: 0x2c, ContextMenu: 0x5d,
};

export interface KeyboardEventLike { code?: string; key?: string; keyCode?: number }

/** keyCode a browser reports while an IME / soft keyboard is still composing. */
export const KEYCODE_COMPOSING = 229;

/**
 * VK of the key behind a DOM keyboard event, or 0 when the event carries no key
 * (an IME/soft-keyboard placeholder: keyCode 229, key "Unidentified"/"Process" — the
 * text then arrives through `beforeinput`). Physical `code` wins (layout-independent
 * scan position, matches what Windows would report for that key); `key` covers soft
 * keyboards that leave `code` empty; `keyCode` is the legacy fallback.
 */
export function vkFromKeyboardEvent(e: KeyboardEventLike): number {
    const code = e.code ?? "";
    if (code) {
        const vk = CODE_TO_VK[code];
        if (vk !== undefined) return vk;
    }
    const key = e.key ?? "";
    if (key === "Unidentified" || key === "Process" || key === "Dead") return 0;
    if (key) {
        const named = KEY_NAME_TO_VK[key];
        if (named !== undefined) return named;
        if (key.length === 1) {
            const chord = charToKey(key);
            if (chord) return chord.vk;
        }
    }
    const keyCode = e.keyCode ?? 0;
    if (keyCode === KEYCODE_COMPOSING || keyCode === 0) return 0;
    return keyCode & 0xff;
}

const SHIFTED_DIGITS = ")!@#$%^&*(";
/** OEM punctuation VK → [unshifted, shifted] character. */
const OEM_CHARS: Record<number, [number, number]> = {
    0xba: [0x3b, 0x3a], 0xbb: [0x3d, 0x2b], 0xbc: [0x2c, 0x3c], 0xbd: [0x2d, 0x5f],
    0xbe: [0x2e, 0x3e], 0xbf: [0x2f, 0x3f], 0xc0: [0x60, 0x7e],
    0xdb: [0x5b, 0x7b], 0xdc: [0x5c, 0x7c], 0xdd: [0x5d, 0x7d], 0xde: [0x27, 0x22],
};
/** Ctrl chords the US layout maps to C0 control characters (besides Ctrl+letter). */
const CTRL_OEM_CHARS: Record<number, number> = { 0xdb: 0x1b, 0xdc: 0x1c, 0xdd: 0x1d };

/**
 * The character the US layout produces for `vk` under the given modifier state
 * (ToAscii / TranslateMessage semantics), or 0 for a key that types nothing.
 * Ctrl+letter yields the C0 control code (Ctrl+A = 0x01), Ctrl+Enter = LF,
 * Ctrl+Backspace = DEL; Ctrl with a digit/punctuation types nothing.
 */
export function vkToChar(vk: number, shift: boolean, capsLock: boolean, ctrl = false): number {
    vk &= 0xff;
    if (vk >= 0x41 && vk <= 0x5a) {
        if (ctrl) return vk - 0x40;
        return shift !== capsLock ? vk : vk + 32;
    }
    if (vk === VK_BACK) return ctrl ? 0x7f : 0x08;
    if (vk === VK_RETURN) return ctrl ? 0x0a : 0x0d;
    if (vk === VK_ESCAPE) return 0x1b;
    if (ctrl) return CTRL_OEM_CHARS[vk] ?? (vk === VK_SPACE ? 0x20 : 0);
    if (vk >= 0x30 && vk <= 0x39) return shift ? SHIFTED_DIGITS.charCodeAt(vk - 0x30) : vk;
    if (vk >= 0x60 && vk <= 0x69) return 0x30 + (vk - 0x60);
    if (vk === 0x6a) return 0x2a;
    if (vk === 0x6b) return 0x2b;
    if (vk === 0x6d) return 0x2d;
    if (vk === 0x6e) return 0x2e;
    if (vk === 0x6f) return 0x2f;
    if (vk === VK_SPACE || vk === VK_TAB) return vk;
    const oem = OEM_CHARS[vk];
    return oem ? oem[shift ? 1 : 0] : 0;
}
