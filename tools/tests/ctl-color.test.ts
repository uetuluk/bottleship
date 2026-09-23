/**
 * WM_CTLCOLOR*: the EDIT class asks its parent for DC colours + a background brush
 * (a guest callback from the thunk that ran the class proc), caches the answer, and
 * paints with it; the border follows WS_BORDER / WS_EX_CLIENTEDGE.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

/** Minimal recording 2D context: enough for GDI DC bookkeeping and control painting. */
class RecordingContext {
    ops: { op: string; style: string; x?: number; y?: number; w?: number; h?: number; text?: string }[] = [];
    fillStyle: unknown = "#000000";
    strokeStyle: unknown = "#000000";
    lineWidth = 1;
    font = "";
    textAlign = "left";
    textBaseline = "top";
    globalAlpha = 1;
    constructor(readonly canvas: unknown) {}
    fillRect(x: number, y: number, w: number, h: number) { this.ops.push({ op: "fillRect", style: String(this.fillStyle), x, y, w, h }); }
    strokeRect(x: number, y: number, w: number, h: number) { this.ops.push({ op: "strokeRect", style: String(this.strokeStyle), x, y, w, h }); }
    fillText(text: string) { this.ops.push({ op: "fillText", style: String(this.fillStyle), text }); }
    measureText(text: string) { return { width: text.length * 6 }; }
    createPattern() { return "pattern"; }
    save() {}
    restore() {}
    beginPath() {}
    rect() {}
    clip() {}
}
class FakeOffscreenCanvas {
    private ctx?: RecordingContext;
    constructor(public width: number, public height: number) {}
    getContext() { return (this.ctx ??= new RecordingContext(this)); }
}
(globalThis as any).OffscreenCanvas ??= FakeOffscreenCanvas;

import { System } from "../../src/worker/core/system";
import { handleSystemControlMessage } from "../../src/worker/modules/user32/dialog-control-messages";
import { paintSystemControl } from "../../src/worker/modules/user32/controls";
import { trySendCtlColor } from "../../src/worker/modules/user32/ctl-color";
import { defWindowProcCtlColor } from "../../src/worker/modules/user32/ctl-color-brush";
import { windows, ctlColorAnswers, resetUser32SharedState, type WindowInfo } from "../../src/worker/modules/user32/shared-state";

const WM_CHAR = 0x0102;
const WM_CTLCOLOREDIT = 0x0133;
const WM_CTLCOLORSTATIC = 0x0138;
const ES_READONLY = 0x0800;
const WS_BORDER = 0x00800000;
const WS_EX_CLIENTEDGE = 0x00000200;
const BLACK_BRUSH = 0x80000004;
const PARENT_PROC = 0x00401000;

const PARENT = 0x10001;
const EDIT = 0x10002;
const ESP = 0x18000;
const RET = 0x00402345;
const mem = new Uint8Array(0x20000);
new DataView(mem.buffer).setUint32(ESP, RET, true);
const ctx = { esp: ESP } as any;

interface Invocation { addr: number; args: number[]; onReturn: (ret: number) => number | null }
let invocations: Invocation[] = [];
let savedProcess: any;

function mkParent(wndProc: number): WindowInfo {
    const win: WindowInfo = {
        handle: PARENT, title: "Game", style: 0x10000000, x: 0, y: 0, width: 640, height: 480,
        children: [EDIT], visible: true, wndProc,
    };
    windows.set(PARENT, win);
    return win;
}

function mkEdit(style = 0, exStyle = 0): WindowInfo {
    const win: WindowInfo = {
        handle: EDIT, title: "", style: 0x50000080 | style, exStyle, x: 10, y: 20, width: 150, height: 18,
        parent: PARENT, children: [], visible: true, wndProc: 0xffff0003,
        controlId: 1001, isSystemControl: true, systemControlClass: "Edit",
    };
    windows.set(EDIT, win);
    return win;
}

/** Run the parent's WM_CTLCOLOREDIT like a typical game handler: white text, transparent, black brush. */
function answerLikeGuest(inv: Invocation): number | null {
    const gdi = System.getInstance().gdiContext;
    const hdc = inv.args[2];
    gdi.setTextColor(hdc, 0x00FFFFFF);
    gdi.setBkMode(hdc, 1);
    return inv.onReturn(BLACK_BRUSH);
}

function paint(win: WindowInfo): RecordingContext {
    const gdi = System.getInstance().gdiContext;
    const hdc = gdi.createSizedMemoryDC(640, 480);
    paintSystemControl(win, hdc, gdi, 0, 0);
    const rec = gdi.getDC(hdc) as unknown as RecordingContext;
    gdi.releaseDC(hdc);
    return rec;
}

beforeEach(() => {
    resetUser32SharedState();
    invocations = [];
    const system = System.getInstance();
    savedProcess = system.process;
    system.process = {
        dispatcher: {
            callbackManager: {
                saveSuspendedThunkContext: () => 7,
                invokeCallback: (addr: number, args: number[], _a: number, onReturn: Invocation["onReturn"]) => {
                    invocations.push({ addr, args, onReturn });
                    return { callbackId: invocations.length };
                },
            },
        },
    } as any;
});

afterEach(() => {
    System.getInstance().process = savedProcess;
});

describe("WM_CTLCOLOREDIT query", () => {
    test("sends (hdc, hwndEdit) to the parent proc and resumes with the class-proc result", () => {
        mkParent(PARENT_PROC);
        const edit = mkEdit();
        const r = trySendCtlColor(ctx, mem, edit, 42, 20, "CallWindowProcA");
        expect(r?.suspendedForCallback).toBe(true);
        expect(r?.stackCleanup).toBe(20);
        expect(invocations.length).toBe(1);
        const [hwnd, msg, hdc, lParam] = invocations[0].args;
        expect(invocations[0].addr).toBe(PARENT_PROC);
        expect([hwnd, msg, lParam]).toEqual([PARENT, WM_CTLCOLOREDIT, EDIT]);
        expect(System.getInstance().gdiContext.getDC(hdc)).toBeDefined();

        expect(answerLikeGuest(invocations[0])).toBe(42);
        expect(ctlColorAnswers.get(EDIT)).toEqual({ textColor: 0xFFFFFF, bkColor: 0xFFFFFF, bkMode: 1, brush: BLACK_BRUSH });
        // The query DC is released once the answer is captured.
        expect(System.getInstance().gdiContext.getDC(hdc)).toBeUndefined();
    });

    test("the answer is cached until the edit repaints", () => {
        mkParent(PARENT_PROC);
        const edit = mkEdit();
        trySendCtlColor(ctx, mem, edit, 0, 16, "SendMessageW");
        answerLikeGuest(invocations[0]);
        expect(trySendCtlColor(ctx, mem, edit, 0, 16, "SendMessageW")).toBeNull();
        handleSystemControlMessage(edit, WM_CHAR, "a".charCodeAt(0), 0, mem);
        expect(trySendCtlColor(ctx, mem, edit, 0, 16, "SendMessageW")?.suspendedForCallback).toBe(true);
    });

    test("a read-only edit asks with WM_CTLCOLORSTATIC", () => {
        mkParent(PARENT_PROC);
        trySendCtlColor(ctx, mem, mkEdit(ES_READONLY), 0, 16, "SendMessageW");
        expect(invocations[0].args[1]).toBe(WM_CTLCOLORSTATIC);
    });

    test("a parent without a guest proc gets class defaults without a callback", () => {
        mkParent(0xffff0001);
        expect(trySendCtlColor(ctx, mem, mkEdit(), 0, 16, "SendMessageW")).toBeNull();
        expect(invocations.length).toBe(0);
        expect(ctlColorAnswers.get(EDIT)?.brush).toBe(0);
    });
});

describe("EDIT paint honours the parent's answer", () => {
    test("brush fills the client, text uses the DC text colour, no frame without border styles", () => {
        mkParent(PARENT_PROC);
        const edit = mkEdit();
        edit.title = "Alice";
        trySendCtlColor(ctx, mem, edit, 0, 16, "SendMessageW");
        answerLikeGuest(invocations[0]);

        const ops = paint(edit).ops;
        expect(ops[0]).toEqual({ op: "fillRect", style: "#000000", x: 10, y: 20, w: 150, h: 18 });
        expect(ops.find((o) => o.op === "fillText")).toMatchObject({ text: "Alice", style: "rgb(255,255,255)" });
        // No sunken edge / frame: nothing but the background fill touches the border.
        expect(ops.filter((o) => o.op === "strokeRect" || o.style === "#808080" || o.style === "#404040")).toEqual([]);
    });

    test("parent that returns no brush keeps the white window background", () => {
        mkParent(PARENT_PROC);
        const edit = mkEdit();
        trySendCtlColor(ctx, mem, edit, 0, 16, "SendMessageW");
        invocations[0].onReturn(0);
        expect(paint(edit).ops[0]).toMatchObject({ op: "fillRect", style: "#FFFFFF" });
    });

    test("WS_EX_CLIENTEDGE draws the sunken edge; bare WS_BORDER a 1px frame", () => {
        mkParent(PARENT_PROC);
        const sunken = paint(mkEdit(0, WS_EX_CLIENTEDGE)).ops;
        expect(sunken.some((o) => o.op === "fillRect" && o.style === "#808080")).toBe(true);
        const framed = paint(mkEdit(WS_BORDER)).ops;
        expect(framed.find((o) => o.op === "strokeRect")).toMatchObject({ style: "#000000" });
        expect(framed.some((o) => o.style === "#808080")).toBe(false);
    });
});

describe("DefWindowProc WM_CTLCOLOR*", () => {
    test("edit gets the window colours; static the button face", () => {
        const gdi = System.getInstance().gdiContext;
        const hdc = gdi.createSizedMemoryDC(8, 8);
        gdi.setTextColor(hdc, 0x123456);
        expect(defWindowProcCtlColor(WM_CTLCOLOREDIT, hdc, gdi)).toBe(0x1000 + 5);
        expect(gdi.getBkColor(hdc)).toBe(0xFFFFFF);
        expect(gdi.hdcStates.get(hdc)?.textColorValue).toBe(0);
        expect(defWindowProcCtlColor(WM_CTLCOLORSTATIC, hdc, gdi)).toBe(0x1000 + 15);
        gdi.releaseDC(hdc);
    });
});
