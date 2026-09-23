/**
 * EDIT class window procedure: text entry, caret/selection, and the EM_* protocol.
 * The control's text lives in WindowInfo.title (shared with WM_SETTEXT/GETTEXT);
 * selection, limit and modify flag live in editControlStates. Notifications go to
 * the parent as WM_COMMAND(MAKEWPARAM(id, EN_*), hwnd).
 */
import { System } from '../../core/system';
import { Marshaler } from '../../core/memory/marshaler';
import { type WindowInfo, editControlStates, getOrCreateEditState, type EditControlState } from './shared-state';
import { repaintDialogAfterContentChange } from './dialog-paint';
import { markCtlColorStale } from './ctl-color-brush';
import { getWindowFont } from './controls';
import { encodeAnsi, getAnsiCodePage, getCodePageDecoder } from '../codepage-utils';

const ES_MULTILINE = 0x0004;
const ES_UPPERCASE = 0x0008;
const ES_LOWERCASE = 0x0010;
const ES_PASSWORD = 0x0020;
const ES_READONLY = 0x0800;
const ES_NUMBER = 0x2000;

const WM_SETFOCUS = 0x0007;
const WM_KILLFOCUS = 0x0008;
const WM_SETTEXT = 0x000C;
const WM_COMMAND = 0x0111;
const WM_KEYDOWN = 0x0100;
const WM_CHAR = 0x0102;
const WM_LBUTTONDOWN = 0x0201;
const WM_CLEAR = 0x0303;

const EM_GETSEL = 0x00B0;
const EM_SETSEL = 0x00B1;
const EM_SCROLLCARET = 0x00B7;
const EM_GETMODIFY = 0x00B8;
const EM_SETMODIFY = 0x00B9;
const EM_GETLINECOUNT = 0x00BA;
const EM_LINEINDEX = 0x00BB;
const EM_LINELENGTH = 0x00C1;
const EM_REPLACESEL = 0x00C2;
const EM_GETLINE = 0x00C4;
const EM_LIMITTEXT = 0x00C5;
const EM_CANUNDO = 0x00C6;
const EM_UNDO = 0x00C7;
const EM_LINEFROMCHAR = 0x00C9;
const EM_SETPASSWORDCHAR = 0x00CC;
const EM_EMPTYUNDOBUFFER = 0x00CD;
const EM_GETFIRSTVISIBLELINE = 0x00CE;
const EM_SETREADONLY = 0x00CF;
const EM_GETPASSWORDCHAR = 0x00D2;
const EM_SETMARGINS = 0x00D3;
const EM_GETMARGINS = 0x00D4;
const EM_GETLIMITTEXT = 0x00D5;

const EN_SETFOCUS = 0x0100;
const EN_KILLFOCUS = 0x0200;
const EN_CHANGE = 0x0300;
const EN_UPDATE = 0x0400;
const EN_MAXTEXT = 0x0501;

const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_END = 0x23;
const VK_HOME = 0x24;
const VK_LEFT = 0x25;
const VK_UP = 0x26;
const VK_RIGHT = 0x27;
const VK_DOWN = 0x28;
const VK_DELETE = 0x2E;

/** EM_LIMITTEXT(0) = the maximum single-line limit. */
const EDIT_MAX_LIMIT = 0x7FFFFFFE;

export function isEditControl(win: WindowInfo | undefined): boolean {
    return (win?.systemControlClass ?? '').trim().toLowerCase() === 'edit';
}

function state(win: WindowInfo): EditControlState {
    const st = getOrCreateEditState(win.handle, (win.style & ES_PASSWORD) !== 0 ? 0x2A : 0);
    // Text may have been replaced behind the class proc (SetWindowText) — keep the
    // selection inside it.
    const len = win.title.length;
    if (st.anchor > len) st.anchor = len;
    if (st.caret > len) st.caret = len;
    return st;
}

function selRange(st: EditControlState): [number, number] {
    return st.anchor <= st.caret ? [st.anchor, st.caret] : [st.caret, st.anchor];
}

function notifyParent(win: WindowInfo, code: number): void {
    if (win.parent === undefined) return;
    const system = System.getInstance();
    const wParam = ((code << 16) | ((win.controlId ?? 0) & 0xFFFF)) >>> 0;
    system.windowManager.postMessage(win.parent, WM_COMMAND, wParam, win.handle);
    system.scheduler.wakeMessageWaiters();
}

function repaint(win: WindowInfo): void {
    markCtlColorStale(win.handle);
    if (win.parent !== undefined) repaintDialogAfterContentChange(win.parent);
}

function lineStarts(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 0x0A) starts.push(i + 1);
    }
    return starts;
}

function lineOf(starts: number[], index: number): number {
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1] <= index) line++;
    return line;
}

/** Length of `line` excluding its CR/LF terminator. */
function lineLength(text: string, starts: number[], line: number): number {
    const start = starts[line];
    let end = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
    if (end > start && text.charCodeAt(end - 1) === 0x0D) end--;
    return Math.max(0, end - start);
}

/**
 * Replace the selection with `insert` the way user typing does: honors the text
 * limit (EN_MAXTEXT when truncated) and posts EN_UPDATE + EN_CHANGE on change.
 * Returns false when nothing could be inserted.
 */
function replaceSelection(win: WindowInfo, st: EditControlState, insert: string, fromUser: boolean): boolean {
    const text = win.title;
    const [start, end] = selRange(st);
    let piece = insert;
    const room = st.limit - (text.length - (end - start));
    if (piece.length > room) {
        piece = piece.slice(0, Math.max(0, room));
        notifyParent(win, EN_MAXTEXT);
    }
    if (piece.length === 0 && start === end) return false;
    win.title = text.slice(0, start) + piece + text.slice(end);
    st.anchor = st.caret = start + piece.length;
    if (fromUser) st.modified = true;
    repaint(win);
    notifyParent(win, EN_UPDATE);
    notifyParent(win, EN_CHANGE);
    return true;
}

function decodeChar(code: number): string {
    if (code < 0x80 || code > 0xFF) return String.fromCharCode(code);
    return getCodePageDecoder(getAnsiCodePage()).decode(Uint8Array.of(code));
}

function onChar(win: WindowInfo, st: EditControlState, code: number): void {
    const readOnly = (win.style & ES_READONLY) !== 0;
    const multiline = (win.style & ES_MULTILINE) !== 0;
    if (code === 0x08) {
        if (readOnly) return;
        const [start, end] = selRange(st);
        if (start === end) {
            if (start === 0) return;
            st.anchor = start - (start >= 2 && win.title.slice(start - 2, start) === '\r\n' ? 2 : 1);
            st.caret = start;
        }
        replaceSelection(win, st, '', true);
        return;
    }
    if (code === 0x0D || code === 0x0A) {
        if (readOnly || !multiline) return;
        replaceSelection(win, st, '\r\n', true);
        return;
    }
    if (code === 0x09) {
        if (!readOnly && multiline) replaceSelection(win, st, '\t', true);
        return;
    }
    if (code === 0x01) { // Ctrl+A
        st.anchor = 0;
        st.caret = win.title.length;
        repaint(win);
        return;
    }
    if (code < 0x20 || code === 0x7F || readOnly) return;
    if ((win.style & ES_NUMBER) !== 0 && (code < 0x30 || code > 0x39)) return;
    let ch = decodeChar(code);
    if ((win.style & ES_UPPERCASE) !== 0) ch = ch.toUpperCase();
    else if ((win.style & ES_LOWERCASE) !== 0) ch = ch.toLowerCase();
    replaceSelection(win, st, ch, true);
}

function isWordChar(c: string): boolean {
    return /[0-9A-Za-z_\u00C0-\uFFFF]/.test(c);
}

function onKeyDown(win: WindowInfo, st: EditControlState, vk: number): void {
    const input = System.getInstance().inputManager;
    const shift = (input.getKeyState(VK_SHIFT) & 0x8000) !== 0;
    const ctrl = (input.getKeyState(VK_CONTROL) & 0x8000) !== 0;
    const text = win.title;
    const multiline = (win.style & ES_MULTILINE) !== 0;
    const [start, end] = selRange(st);
    let caret = st.caret;

    switch (vk) {
        case VK_DELETE: {
            if ((win.style & ES_READONLY) !== 0) return;
            if (start === end) {
                if (start >= text.length) return;
                st.anchor = start;
                st.caret = start + (text.slice(start, start + 2) === '\r\n' ? 2 : 1);
            }
            replaceSelection(win, st, '', true);
            return;
        }
        case VK_LEFT:
        case VK_RIGHT: {
            const back = vk === VK_LEFT;
            if (!shift && start !== end && !ctrl) {
                caret = back ? start : end;
            } else if (ctrl) {
                let i = caret;
                if (back) {
                    while (i > 0 && !isWordChar(text[i - 1])) i--;
                    while (i > 0 && isWordChar(text[i - 1])) i--;
                } else {
                    while (i < text.length && isWordChar(text[i])) i++;
                    while (i < text.length && !isWordChar(text[i])) i++;
                }
                caret = i;
            } else if (back) {
                caret = Math.max(0, caret - (caret >= 2 && text.slice(caret - 2, caret) === '\r\n' ? 2 : 1));
            } else {
                caret = Math.min(text.length, caret + (text.slice(caret, caret + 2) === '\r\n' ? 2 : 1));
            }
            break;
        }
        case VK_UP:
        case VK_DOWN: {
            if (!multiline) {
                // A single-line edit treats Up/Down as Left/Right.
                onKeyDown(win, st, vk === VK_UP ? VK_LEFT : VK_RIGHT);
                return;
            }
            const starts = lineStarts(text);
            const line = lineOf(starts, caret);
            const target = vk === VK_UP ? line - 1 : line + 1;
            if (target < 0 || target >= starts.length) return;
            const col = caret - starts[line];
            caret = starts[target] + Math.min(col, lineLength(text, starts, target));
            break;
        }
        case VK_HOME:
        case VK_END: {
            if (!multiline || ctrl) {
                caret = vk === VK_HOME ? 0 : text.length;
            } else {
                const starts = lineStarts(text);
                const line = lineOf(starts, caret);
                caret = vk === VK_HOME ? starts[line] : starts[line] + lineLength(text, starts, line);
            }
            break;
        }
        default:
            return;
    }

    st.caret = caret;
    if (!shift) st.anchor = caret;
    repaint(win);
}

function writeDword(mem: Uint8Array, ptr: number, value: number): void {
    if (!ptr || ptr + 4 > mem.length) return;
    new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint32(ptr, value >>> 0, true);
}

/**
 * EDIT class handling for `msg`. Returns the LRESULT, or null when the message is
 * not edit-specific (caller falls through to the shared control handling).
 */
export function handleEditMessage(
    win: WindowInfo, msg: number, wParam: number, lParam: number, mem: Uint8Array,
): number | null {
    switch (msg) {
        case WM_CHAR:
            onChar(win, state(win), wParam & 0xFFFF);
            return 0;
        case WM_KEYDOWN:
            onKeyDown(win, state(win), wParam & 0xFF);
            return 0;
        case WM_LBUTTONDOWN:
            onLButtonDown(win, wParam, lParam);
            return 0;
        case WM_SETFOCUS:
            notifyParent(win, EN_SETFOCUS);
            repaint(win);
            return 0;
        case WM_KILLFOCUS:
            notifyParent(win, EN_KILLFOCUS);
            repaint(win);
            return 0;
        case WM_CLEAR: {
            const st = state(win);
            if ((win.style & ES_READONLY) === 0) replaceSelection(win, st, '', true);
            return 0;
        }
        case EM_GETSEL: {
            const [start, end] = selRange(state(win));
            writeDword(mem, wParam >>> 0, start);
            writeDword(mem, lParam >>> 0, end);
            return (start > 0xFFFF || end > 0xFFFF) ? -1 : (((end & 0xFFFF) << 16) | (start & 0xFFFF)) >>> 0;
        }
        case EM_SETSEL: {
            const st = state(win);
            const len = win.title.length;
            const start = wParam | 0;
            const end = lParam | 0;
            if (start === -1) {
                st.anchor = st.caret;
            } else {
                st.anchor = Math.min(Math.max(0, start), len);
                st.caret = end < 0 ? len : Math.min(end, len);
            }
            repaint(win);
            return 1;
        }
        case EM_REPLACESEL: {
            const st = state(win);
            const text = lParam ? Marshaler.readString(mem, lParam >>> 0) : '';
            replaceSelection(win, st, text, true);
            return 0;
        }
        case EM_LIMITTEXT:
            state(win).limit = wParam ? (wParam >>> 0) : EDIT_MAX_LIMIT;
            return 0;
        case EM_GETLIMITTEXT:
            return state(win).limit >>> 0;
        case EM_GETMODIFY:
            return state(win).modified ? 1 : 0;
        case EM_SETMODIFY:
            state(win).modified = wParam !== 0;
            return 0;
        case EM_SETREADONLY:
            if (wParam) win.style |= ES_READONLY;
            else win.style &= ~ES_READONLY;
            repaint(win);
            return 1;
        case EM_SETPASSWORDCHAR:
            state(win).passwordChar = wParam & 0xFFFF;
            if (wParam) win.style |= ES_PASSWORD;
            else win.style &= ~ES_PASSWORD;
            repaint(win);
            return 0;
        case EM_GETPASSWORDCHAR:
            return state(win).passwordChar;
        case EM_GETLINECOUNT:
            return (win.style & ES_MULTILINE) ? lineStarts(win.title).length : 1;
        case EM_LINEINDEX: {
            if (!(win.style & ES_MULTILINE)) return (wParam | 0) <= 0 ? 0 : -1;
            const starts = lineStarts(win.title);
            const line = (wParam | 0) === -1 ? lineOf(starts, state(win).caret) : wParam | 0;
            return line < starts.length ? starts[line] : -1;
        }
        case EM_LINEFROMCHAR: {
            if (!(win.style & ES_MULTILINE)) return 0;
            const starts = lineStarts(win.title);
            const index = (wParam | 0) === -1 ? selRange(state(win))[0] : wParam | 0;
            return lineOf(starts, index);
        }
        case EM_LINELENGTH: {
            if (!(win.style & ES_MULTILINE)) return win.title.length;
            const starts = lineStarts(win.title);
            if ((wParam | 0) === -1) {
                const [start, end] = selRange(state(win));
                const l0 = lineOf(starts, start), l1 = lineOf(starts, end);
                return (start - starts[l0]) + (starts[l1] + lineLength(win.title, starts, l1) - end);
            }
            return lineLength(win.title, starts, lineOf(starts, wParam | 0));
        }
        case EM_GETLINE: {
            const ptr = lParam >>> 0;
            if (!ptr || ptr + 2 > mem.length) return 0;
            const cap = mem[ptr] | (mem[ptr + 1] << 8);
            let line = win.title;
            if (win.style & ES_MULTILINE) {
                const starts = lineStarts(line);
                const idx = wParam | 0;
                if (idx < 0 || idx >= starts.length) return 0;
                line = line.substr(starts[idx], lineLength(win.title, starts, idx));
            }
            // Copies without a terminator, clamped to the WORD capacity at lpch[0].
            const bytes = encodeAnsi(line);
            const n = Math.min(bytes.length, cap, mem.length - ptr);
            mem.set(bytes.subarray(0, n), ptr);
            return n;
        }
        case EM_SCROLLCARET:
            return 1;
        case EM_CANUNDO:
        case EM_UNDO:
        case EM_GETFIRSTVISIBLELINE:
        case EM_EMPTYUNDOBUFFER:
        case EM_SETMARGINS:
        case EM_GETMARGINS:
            return 0;
        default:
            return null;
    }
}

/** WM_SETTEXT on an edit resets the caret and modify flag and reports EN_CHANGE. */
export function onEditTextSet(win: WindowInfo, msg: number): void {
    if (msg !== WM_SETTEXT) return;
    const st = editControlStates.get(win.handle);
    if (st) {
        st.anchor = st.caret = 0;
        st.modified = false;
    }
    if ((win.style & ES_MULTILINE) === 0) {
        notifyParent(win, EN_UPDATE);
        notifyParent(win, EN_CHANGE);
    }
}

const MK_SHIFT = 0x0004;
/** Where the painter starts the text and how tall a multiline row is (controls.ts paintEdit). */
const TEXT_LEFT = 4;
const TEXT_TOP = 4;
const LINE_HEIGHT = 14;
const CARET_MARGIN = 10;
const FALLBACK_CHAR_PX = 6;

let measureContext: OffscreenCanvasRenderingContext2D | null | undefined;

/** Width of `text` in the edit's font — the metric its painter lays the text out with. */
function textWidth(win: WindowInfo, text: string): number {
    if (measureContext === undefined) {
        measureContext = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1).getContext('2d') : null;
    }
    if (!measureContext) return text.length * FALLBACK_CHAR_PX;
    measureContext.font = getWindowFont(win);
    return measureContext.measureText(text).width;
}

/** The character boundary nearest a client-area x within one line of text. */
function nearestBoundary(win: WindowInfo, line: string, x: number): number {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i <= line.length; i++) {
        const distance = Math.abs(textWidth(win, line.slice(0, i)) - x);
        if (distance < bestDistance) {
            best = i;
            bestDistance = distance;
        }
    }
    return best;
}

/** EM_CHARFROMPOS: the text index under a client point, as the edit currently lays it out. */
function charFromPoint(win: WindowInfo, st: EditControlState, x: number, y: number): number {
    const text = win.title;
    if (win.style & ES_MULTILINE) {
        const starts = lineStarts(text);
        const line = Math.min(starts.length - 1, Math.max(0, Math.floor((y - TEXT_TOP) / LINE_HEIGHT)));
        return starts[line] + nearestBoundary(win, text.slice(starts[line], starts[line] + lineLength(text, starts, line)), x - TEXT_LEFT);
    }
    const shown = st.passwordChar ? String.fromCharCode(st.passwordChar).repeat(text.length) : text;
    // A single line scrolls so the caret stays in view; hit-test against that same offset.
    const scroll = Math.max(0, textWidth(win, shown.slice(0, st.caret)) - (win.width - CARET_MARGIN));
    return nearestBoundary(win, shown, x - TEXT_LEFT + scroll);
}

/**
 * Mouse press on an edit: it takes the keyboard focus and puts the caret under the pointer
 * (Shift+click extends the selection to it), whether or not it already had the focus.
 */
function onLButtonDown(win: WindowInfo, keys: number, lParam: number): void {
    const system = System.getInstance();
    const st = state(win);
    const x = (lParam << 16) >> 16;
    const y = lParam >> 16;
    st.caret = charFromPoint(win, st, x, y);
    if ((keys & MK_SHIFT) === 0) st.anchor = st.caret;
    if (system.windowManager.getFocusHwnd() !== win.handle) {
        system.windowManager.setFocus(win.handle);
        system.scheduler.wakeMessageWaiters();
    }
    repaint(win);
}
