import { describe, expect, test } from "bun:test";
import { charToKey, vkFromKeyboardEvent, KEYCODE_COMPOSING, VK_BACK, VK_RETURN, VK_SHIFT } from "../../src/worker/runtime/input/us-keyboard-layout";

describe("charToKey", () => {
    test("letters, digits, shifted symbols map to the producing key", () => {
        expect(charToKey("a")).toEqual({ vk: 0x41, shift: false });
        expect(charToKey("Z")).toEqual({ vk: 0x5a, shift: true });
        expect(charToKey("7")).toEqual({ vk: 0x37, shift: false });
        expect(charToKey("!")).toEqual({ vk: 0x31, shift: true });
        expect(charToKey("?")).toEqual({ vk: 0xbf, shift: true });
        expect(charToKey("\n")).toEqual({ vk: VK_RETURN, shift: false });
    });
    test("unmappable code points are null", () => {
        expect(charToKey("é")).toBeNull();
        expect(charToKey("😀")).toBeNull();
        expect(charToKey("")).toBeNull();
    });
});

describe("vkFromKeyboardEvent", () => {
    test("physical code wins over key and keyCode", () => {
        expect(vkFromKeyboardEvent({ code: "KeyA", key: "q", keyCode: 81 })).toBe(0x41);
        expect(vkFromKeyboardEvent({ code: "Digit1", key: "!", keyCode: 49 })).toBe(0x31);
        expect(vkFromKeyboardEvent({ code: "ArrowLeft", key: "ArrowLeft", keyCode: 37 })).toBe(0x25);
        expect(vkFromKeyboardEvent({ code: "NumpadEnter", key: "Enter", keyCode: 13 })).toBe(VK_RETURN);
        expect(vkFromKeyboardEvent({ code: "F12", key: "F12", keyCode: 123 })).toBe(0x7b);
    });
    test("soft keyboard with empty code falls back to key", () => {
        expect(vkFromKeyboardEvent({ code: "", key: "a", keyCode: 65 })).toBe(0x41);
        expect(vkFromKeyboardEvent({ code: "", key: "A", keyCode: 65 })).toBe(0x41);
        expect(vkFromKeyboardEvent({ code: "", key: "Backspace", keyCode: 8 })).toBe(VK_BACK);
        expect(vkFromKeyboardEvent({ code: "", key: "Shift", keyCode: 16 })).toBe(VK_SHIFT);
        expect(vkFromKeyboardEvent({ code: "", key: "?", keyCode: 191 })).toBe(0xbf);
    });
    test("composition placeholders carry no key", () => {
        expect(vkFromKeyboardEvent({ code: "", key: "Unidentified", keyCode: KEYCODE_COMPOSING })).toBe(0);
        expect(vkFromKeyboardEvent({ code: "", key: "Process", keyCode: KEYCODE_COMPOSING })).toBe(0);
        expect(vkFromKeyboardEvent({ code: "", key: "", keyCode: 0 })).toBe(0);
    });
    test("legacy keyCode is the last resort", () => {
        expect(vkFromKeyboardEvent({ code: "", key: "é", keyCode: 0xde })).toBe(0xde);
    });
});
