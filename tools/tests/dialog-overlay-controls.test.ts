/** Live overlay windows over an exclusive-fullscreen DirectDraw primary: dialogs and system controls. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { noteDialogOverlayCandidate, getLiveDialogOverlayRects } from "../../src/worker/modules/user32/dialog-overlay";
import { windows, resetUser32SharedState, type WindowInfo } from "../../src/worker/modules/user32/shared-state";

const DDSCL_EXCLUSIVE_FULLSCREEN = 0x11;
let savedProcess: unknown;

function mkWindow(handle: number, extra: Partial<WindowInfo>): WindowInfo {
    const win: WindowInfo = { handle, title: "", style: 0x50000000, x: 0, y: 0, width: 10, height: 10, children: [], visible: true, wndProc: 0, ...extra };
    windows.set(handle, win);
    return win;
}

beforeEach(() => {
    resetUser32SharedState();
    const system = System.getInstance() as any;
    savedProcess = system.process;
    system.process = { getModule: (name: string) => (name === "ddraw" ? { context: { cooperative: { flags: DDSCL_EXCLUSIVE_FULLSCREEN } } } : undefined) };
});
afterEach(() => { (System.getInstance() as any).process = savedProcess; });

describe("noteDialogOverlayCandidate", () => {
    test("a system control shown on the fullscreen game window composites over the primary", () => {
        mkWindow(0x10001, { style: 0x92000000, width: 800, height: 600 });
        const edit = mkWindow(0x10002, { parent: 0x10001, x: 344, y: 290, width: 155, height: 17, isSystemControl: true, systemControlClass: "edit" });
        windows.get(0x10001)!.children.push(0x10002);
        noteDialogOverlayCandidate(edit);
        expect(edit.overlayOnFlipScreen).toBe(true);
        expect(getLiveDialogOverlayRects()).toEqual([{ x: 344, y: 290, w: 155, h: 17 }]);
    });

    test("an ordinary guest-painted window is not treated as overlay UI", () => {
        const win = mkWindow(0x10003, { nativeClassName: "GameWindow" });
        noteDialogOverlayCandidate(win);
        expect(win.overlayOnFlipScreen).toBeUndefined();
    });
});
