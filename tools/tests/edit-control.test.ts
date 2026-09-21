/**
 * EDIT class window procedure: text entry through WM_CHAR / WM_KEYDOWN, the EM_*
 * protocol, and EN_* notifications to the parent. Runs the JS class proc directly
 * (handleSystemControlMessage) — the same entry DispatchMessage and a subclass's
 * CallWindowProc(original proc) reach.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { handleSystemControlMessage } from "../../src/worker/modules/user32/dialog-control-messages";
import { windows, resetUser32SharedState, type WindowInfo } from "../../src/worker/modules/user32/shared-state";
import { vkToChar } from "../../src/worker/runtime/input/us-keyboard-layout";
import { createWindowExports } from "../../src/worker/modules/user32/window";
import { invalidateWindow, validateWindow } from "../../src/worker/modules/user32/paint-region";

const WM_SETTEXT = 0x000c;
const WM_GETTEXT = 0x000d;
const WM_KEYDOWN = 0x0100;
const WM_CHAR = 0x0102;
const WM_COMMAND = 0x0111;
const EM_GETSEL = 0x00b0;
const EM_SETSEL = 0x00b1;
const EM_GETMODIFY = 0x00b8;
const EM_REPLACESEL = 0x00c2;
const EM_GETLINE = 0x00c4;
const EM_LIMITTEXT = 0x00c5;
const EM_GETLINECOUNT = 0x00ba;
const EN_CHANGE = 0x0300;
const EN_MAXTEXT = 0x0501;
const ES_UPPERCASE = 0x0008;
const ES_MULTILINE = 0x0004;
const ES_READONLY = 0x0800;
const ES_NUMBER = 0x2000;
const VK_LEFT = 0x25;
const VK_HOME = 0x24;
const VK_DELETE = 0x2e;

const PARENT = 0x10001;
const EDIT = 0x10002;
const mem = new Uint8Array(0x20000);

function mkEdit(style = 0): WindowInfo {
    const win: WindowInfo = {
        handle: EDIT, title: "", style: 0x50000080 | style, x: 0, y: 0, width: 150, height: 18,
        parent: PARENT, children: [], visible: true, wndProc: 0xffff0003,
        controlId: 1001, isSystemControl: true, systemControlClass: "Edit",
    };
    windows.set(EDIT, win);
    return win;
}

const send = (win: WindowInfo, msg: number, wParam = 0, lParam = 0) =>
    handleSystemControlMessage(win, msg, wParam, lParam, mem);

function type(win: WindowInfo, text: string): void {
    for (const ch of text) send(win, WM_CHAR, ch.charCodeAt(0));
}

/** Drain the queue, returning the EN_* codes the edit posted to its parent. */
function drainNotifications(): number[] {
    const wm = System.getInstance().windowManager;
    const codes: number[] = [];
    for (let m = wm.getMessage(); m; m = wm.getMessage()) {
        if (m.hwnd === PARENT && m.message === WM_COMMAND && m.lParam === EDIT) codes.push(m.wParam >>> 16);
    }
    return codes;
}

beforeEach(() => {
    resetUser32SharedState();
    drainNotifications();
});

describe("EDIT WM_CHAR", () => {
    test("typed characters are inserted and reported with EN_CHANGE", () => {
        const win = mkEdit();
        type(win, "Hi 7!");
        expect(win.title).toBe("Hi 7!");
        expect(drainNotifications().filter((c) => c === EN_CHANGE).length).toBe(5);
        expect(send(win, EM_GETMODIFY)).toBe(1);
    });

    test("backspace deletes before the caret; control chars insert nothing", () => {
        const win = mkEdit();
        type(win, "abc");
        send(win, WM_CHAR, 0x08);
        send(win, WM_CHAR, 0x1b);
        send(win, WM_CHAR, 0x0d);
        expect(win.title).toBe("ab");
    });

    test("ES_NUMBER / ES_UPPERCASE / ES_READONLY filter input", () => {
        const num = mkEdit(ES_NUMBER);
        type(num, "a1b2");
        expect(num.title).toBe("12");
        const upper = mkEdit(ES_UPPERCASE);
        type(upper, "abc");
        expect(upper.title).toBe("ABC");
        const ro = mkEdit(ES_READONLY);
        type(ro, "abc");
        expect(ro.title).toBe("");
    });

    test("EM_LIMITTEXT caps user entry and posts EN_MAXTEXT", () => {
        const win = mkEdit();
        send(win, EM_LIMITTEXT, 3);
        drainNotifications();
        type(win, "abcd");
        expect(win.title).toBe("abc");
        expect(drainNotifications()).toContain(EN_MAXTEXT);
    });

    test("multiline edits take Enter as CRLF", () => {
        const win = mkEdit(ES_MULTILINE);
        type(win, "a\rb");
        expect(win.title).toBe("a\r\nb");
        expect(send(win, EM_GETLINECOUNT)).toBe(2);
    });
});

describe("EDIT caret and selection", () => {
    test("arrow keys move the caret; insertion lands mid-text; Delete removes after", () => {
        const win = mkEdit();
        type(win, "ac");
        send(win, WM_KEYDOWN, VK_LEFT);
        type(win, "b");
        expect(win.title).toBe("abc");
        send(win, WM_KEYDOWN, VK_HOME);
        send(win, WM_KEYDOWN, VK_DELETE);
        expect(win.title).toBe("bc");
    });

    test("EM_GETSEL returns MAKELONG(start,end) and fills both out-pointers", () => {
        const win = mkEdit();
        type(win, "hello");
        expect(send(win, EM_SETSEL, 1, 4)).toBe(1);
        const view = new DataView(mem.buffer);
        view.setUint32(0x100, 0xdeadbeef, true);
        view.setUint32(0x104, 0xdeadbeef, true);
        expect(send(win, EM_GETSEL, 0x100, 0x104)).toBe((4 << 16) | 1);
        expect(view.getUint32(0x100, true)).toBe(1);
        expect(view.getUint32(0x104, true)).toBe(4);
    });

    test("typing replaces the selection; EM_SETSEL(0,-1) selects all", () => {
        const win = mkEdit();
        type(win, "hello");
        send(win, EM_SETSEL, 0, -1);
        type(win, "x");
        expect(win.title).toBe("x");
    });

    test("EM_REPLACESEL inserts an ANSI string at the caret", () => {
        const win = mkEdit();
        type(win, "ad");
        send(win, EM_SETSEL, 1, 1);
        mem.set(new TextEncoder().encode("bc\0"), 0x200);
        send(win, EM_REPLACESEL, 1, 0x200);
        expect(win.title).toBe("abcd");
    });

    test("WM_SETTEXT resets the caret and modify flag; WM_GETTEXT / EM_GETLINE read back", () => {
        const win = mkEdit();
        type(win, "zz");
        mem.set(new TextEncoder().encode("Player\0"), 0x300);
        send(win, WM_SETTEXT, 0, 0x300);
        expect(send(win, EM_GETMODIFY)).toBe(0);
        expect(send(win, EM_GETSEL)).toBe(0);
        expect(send(win, WM_GETTEXT, 32, 0x400)).toBe(6);
        new DataView(mem.buffer).setUint16(0x500, 3, true);
        expect(send(win, EM_GETLINE, 0, 0x500)).toBe(3);
        expect(new TextDecoder().decode(mem.subarray(0x500, 0x503))).toBe("Pla");
    });
});

describe("subclassed EDIT", () => {
    // Win32 subclassing idiom: the app's proc forwards to the original class proc via
    // CallWindowProc(GetWindowLong(GWL_WNDPROC) result, ...). That original proc is our
    // sentinel, and it must behave as the EDIT class, not swallow the message.
    // Live system controls hand out the DefWindowProcA thunk as their class proc, so
    // the forwarded call lands in DefWindowProcA; a sentinel proc must behave the same.
    const exportsTable = createWindowExports();
    const defWindowProc = exportsTable["DefWindowProcA"]!;
    const callWindowProc = exportsTable["CallWindowProcA"]!;
    const call = (msg: number, wParam = 0, lParam = 0) => {
        const r = callWindowProc({} as never, mem, [0xffff0003, EDIT, msg, wParam, lParam]) as { value: number; stackCleanup: number };
        expect(r.stackCleanup).toBe(20);
        return r.value;
    };

    test("WM_CHAR forwarded to the original proc inserts text", () => {
        const win = mkEdit();
        win.wndProcSubclassed = true;
        for (const ch of "Name") call(WM_CHAR, ch.charCodeAt(0));
        expect(win.title).toBe("Name");
    });

    test("EM_GETSEL forwarded to the original proc answers and fills out-pointers", () => {
        const win = mkEdit();
        win.wndProcSubclassed = true;
        for (const ch of "abc") defWindowProc({} as never, mem, [EDIT, WM_CHAR, ch.charCodeAt(0), 0]);
        expect(defWindowProc({} as never, mem, [EDIT, EM_GETSEL, 0x600, 0x604])).toBe((3 << 16) | 3);
        expect(new DataView(mem.buffer).getUint32(0x604, true)).toBe(3);
        expect(call(EM_GETSEL)).toBe((3 << 16) | 3);
    });
});

describe("CreateWindowEx on a predefined control class", () => {
    const APP_PARENT = 0x2fff0;
    test("an app-created EDIT is the system EDIT class: typing reaches it through DefWindowProc", () => {
        const exportsTable = createWindowExports();
        // Class-name pointers must sit above 64K (lower values are class atoms).
        mem.set(new TextEncoder().encode("edit\0"), 0x10700);
        const hwnd = exportsTable["CreateWindowExA"]!({} as never, mem,
            [0, 0x10700, 0, 0x50000080, 344, 290, 155, 17, APP_PARENT, 7, 0, 0]) as number;
        const win = windows.get(hwnd)!;
        expect(win.isSystemControl).toBe(true);
        expect(win.systemControlClass).toBe("Edit");
        expect(win.controlId).toBe(7);
        const defWindowProc = exportsTable["DefWindowProcA"]!;
        for (const ch of "Bob") defWindowProc({} as never, mem, [hwnd, WM_CHAR, ch.charCodeAt(0), 0]);
        expect(win.title).toBe("Bob");
    });

    test("class atoms resolve too; unregistered custom classes stay plain windows", () => {
        const exportsTable = createWindowExports();
        const button = exportsTable["CreateWindowExA"]!({} as never, mem,
            [0, 0x80, 0, 0x50000000, 0, 0, 80, 20, APP_PARENT, 1, 0, 0]) as number;
        expect(windows.get(button)!.systemControlClass).toBe("Button");
        mem.set(new TextEncoder().encode("MyGameWnd\0"), 0x10740);
        const custom = exportsTable["CreateWindowExA"]!({} as never, mem,
            [0, 0x10740, 0, 0x50000000, 0, 0, 80, 20, APP_PARENT, 2, 0, 0]) as number;
        expect(windows.get(custom)!.isSystemControl).toBeUndefined();
    });
});

describe("WM_PAINT lifetime", () => {
    const WM_PAINT = 0x000f;
    const hasPaint = () => System.getInstance().windowManager.hasMessages(WM_PAINT, WM_PAINT);

    test("the EDIT class proc's WM_PAINT validates and withdraws the queued paint", () => {
        const win = mkEdit();
        invalidateWindow(EDIT, null, true);
        System.getInstance().windowManager.postMessage(EDIT, WM_PAINT, 0, 0);
        expect(hasPaint()).toBe(true);
        // A PM_NOREMOVE peek + DispatchMessage leaves the paint queued until the
        // window proc validates; after that the same MSG must not come back.
        send(win, WM_PAINT);
        expect(hasPaint()).toBe(false);
    });

    test("ValidateRect covering the update region withdraws the paint; a partial one keeps it", () => {
        mkEdit();
        const wm = System.getInstance().windowManager;
        invalidateWindow(EDIT, { left: 0, top: 0, right: 100, bottom: 18 }, false);
        wm.postMessage(EDIT, WM_PAINT, 0, 0);
        validateWindow(EDIT, { left: 0, top: 0, right: 50, bottom: 18 });
        expect(hasPaint()).toBe(true);
        validateWindow(EDIT, { left: 50, top: 0, right: 100, bottom: 18 });
        expect(hasPaint()).toBe(false);
    });
});

describe("vkToChar (US layout, TranslateMessage/ToAscii)", () => {
    test("letters honor Shift xor CapsLock; Ctrl+letter is the C0 control code", () => {
        expect(vkToChar(0x41, false, false)).toBe(0x61);
        expect(vkToChar(0x41, true, false)).toBe(0x41);
        expect(vkToChar(0x41, true, true)).toBe(0x61);
        expect(vkToChar(0x41, false, false, true)).toBe(0x01);
    });
    test("digits, numpad, OEM punctuation, and keys that type nothing", () => {
        expect(vkToChar(0x31, true, false)).toBe(0x21);
        expect(vkToChar(0x65, false, false)).toBe(0x35);
        expect(vkToChar(0xbd, true, false)).toBe(0x5f);
        expect(vkToChar(0x08, false, false, true)).toBe(0x7f);
        expect(vkToChar(0x25, false, false)).toBe(0);
        expect(vkToChar(0x31, false, false, true)).toBe(0);
    });
});
