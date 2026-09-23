/**
 * WM_CTLCOLOR* — a control asks its parent for the DC colours and background brush
 * before it paints. The parent's (possibly subclassed) wndProc is guest code, so the
 * query runs as a suspended-thunk callback from the thunk that drove the control's
 * class proc; the answer is cached per control so paints that cannot call back (the
 * modal pump, repaints from inside unrelated thunks) reuse the last one.
 */
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import type { ThunkResult } from '../../core/thunking/thunk-dispatcher';
import {
    windows, ctlColorAnswers, ctlColorStale, ctlColorInFlight, type WindowInfo, type CtlColorAnswer,
} from './shared-state';
import { isSentinelWndProc } from './dialog';
import { repaintDialogAfterContentChange } from './dialog-paint';
import { COLOR_WINDOW, COLOR_WINDOWTEXT, OPAQUE, ctlColorMessageFor, sysColor } from './ctl-color-brush';

function sameAnswer(a: CtlColorAnswer | undefined, b: CtlColorAnswer): boolean {
    return !!a && a.brush === b.brush && a.textColor === b.textColor
        && a.bkColor === b.bkColor && a.bkMode === b.bkMode;
}

/**
 * After a control's class proc ran inside a guest-callable thunk, send its WM_CTLCOLOR*
 * to the parent if the cached answer is missing or a repaint made it stale. Returns a
 * suspended-thunk result that resolves to `value`, or null when no query is needed.
 */
export function trySendCtlColor(
    ctx: { esp: number },
    mem: Uint8Array,
    win: WindowInfo,
    value: number,
    stackCleanup: number,
    tag: string,
): ThunkResult | null {
    const hwnd = win.handle >>> 0;
    if (ctlColorInFlight.has(hwnd)) return null;
    if (ctlColorAnswers.has(hwnd) && !ctlColorStale.has(hwnd)) return null;
    const msg = ctlColorMessageFor(win);
    if (!msg || win.parent === undefined) return null;
    const parent = windows.get(win.parent);
    if (!parent) return null;
    ctlColorStale.delete(hwnd);
    if (!parent.wndProc || isSentinelWndProc(parent.wndProc)) {
        // The parent is ours (HLE dialog manager / DefWindowProc): class defaults.
        ctlColorAnswers.set(hwnd, { textColor: 0, bkColor: 0, bkMode: OPAQUE, brush: 0 });
        return null;
    }

    const system = System.getInstance();
    const callbackManager = system.process?.dispatcher?.callbackManager;
    const gdi = system.gdiContext;
    if (!callbackManager || !gdi) return null;

    const hdc = gdi.createSizedMemoryDC(win.width, win.height);
    if (!hdc) return null;
    // A fresh window DC: black text on the window colour, OPAQUE background mode.
    gdi.setTextColor(hdc, sysColor(COLOR_WINDOWTEXT));
    gdi.setBkColor(hdc, sysColor(COLOR_WINDOW));
    gdi.setBkMode(hdc, OPAQUE);

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const frameId = callbackManager.saveSuspendedThunkContext(
        { ...ctx, returnAddr: view.getUint32(ctx.esp, true) }, stackCleanup, `${tag}-CTLCOLOR`);
    if (frameId === 0) {
        gdi.releaseDC(hdc);
        return null;
    }

    const onReturn = (brush: number): number => {
        ctlColorInFlight.delete(hwnd);
        const state = gdi.hdcStates.get(hdc);
        const answer: CtlColorAnswer = {
            textColor: (state?.textColorValue ?? 0) >>> 0,
            bkColor: gdi.getBkColor(hdc) >>> 0,
            bkMode: state?.bkMode ?? OPAQUE,
            brush: brush >>> 0,
        };
        gdi.releaseDC(hdc);
        // A zero brush means the parent did not handle it (dialog procs return FALSE).
        if (!answer.brush) answer.textColor = answer.bkColor = 0;
        const changed = !sameAnswer(ctlColorAnswers.get(hwnd), answer);
        ctlColorAnswers.set(hwnd, answer);
        if (changed && win.visible && windows.get(hwnd) === win && win.parent !== undefined) {
            repaintDialogAfterContentChange(win.parent);
        }
        return value >>> 0;
    };

    ctlColorInFlight.add(hwnd);
    const inv = callbackManager.invokeCallback(
        parent.wndProc, [parent.handle, msg, hdc, hwnd], 0, onReturn, false, `${tag}-CTLCOLOR`, frameId);
    if (inv.callbackId === 0) {
        ctlColorInFlight.delete(hwnd);
        gdi.releaseDC(hdc);
        Logger.warn(LogCategory.USER32,
            `${tag}: WM_CTLCOLOR 0x${msg.toString(16)} to 0x${parent.handle.toString(16)} not dispatched`);
        return { value: value >>> 0, stackCleanup };
    }
    return {
        value: value >>> 0,
        suspendedForCallback: true,
        callbackId: inv.callbackId,
        stackCleanup,
        skipStackCheck: true,
    };
}
