/** WM_CTLCOLOR* constants, DefWindowProc's default answer and brush → fill resolution. */
import type { GDIContext } from '../gdi32/context';
import { colorToCss } from '../gdi32/gdi-objects';
import { sysColors, ctlColorStale, type WindowInfo } from './shared-state';

export const WM_CTLCOLORMSGBOX = 0x0132;
export const WM_CTLCOLOREDIT = 0x0133;
export const WM_CTLCOLORLISTBOX = 0x0134;
export const WM_CTLCOLORBTN = 0x0135;
export const WM_CTLCOLORDLG = 0x0136;
export const WM_CTLCOLORSCROLLBAR = 0x0137;
export const WM_CTLCOLORSTATIC = 0x0138;

const COLOR_SCROLLBAR = 0;
export const COLOR_WINDOW = 5;
export const COLOR_WINDOWTEXT = 8;
const COLOR_BTNFACE = 15;
/** Our GetSysColorBrush handles are 0x1000 + COLOR_* index. */
const SYS_COLOR_BRUSH_BASE = 0x1000;

export const OPAQUE = 2;
const ES_READONLY = 0x0800;
const WS_DISABLED = 0x08000000;

/** A repaint of this control must re-ask its parent on the next class-proc run. */
export function markCtlColorStale(hwnd: number): void {
    ctlColorStale.add(hwnd >>> 0);
}

/** The WM_CTLCOLOR* message a control sends before painting, or 0 if it sends none we model. */
export function ctlColorMessageFor(win: WindowInfo): number {
    const cls = (win.systemControlClass ?? '').trim().toLowerCase();
    if (cls === 'edit') {
        // A read-only or disabled edit paints like a static.
        return (win.style & (ES_READONLY | WS_DISABLED)) !== 0 ? WM_CTLCOLORSTATIC : WM_CTLCOLOREDIT;
    }
    return 0;
}

export function sysColor(index: number): number {
    return (sysColors.get(index) ?? 0xFFFFFF) >>> 0;
}

/** DefWindowProc's WM_CTLCOLOR* answer: class-default DC colours + a system-colour brush. */
export function defWindowProcCtlColor(msg: number, hdc: number, gdi: GDIContext): number {
    if (msg < WM_CTLCOLORMSGBOX || msg > WM_CTLCOLORSTATIC) return 0;
    const bk = msg === WM_CTLCOLOREDIT || msg === WM_CTLCOLORLISTBOX ? COLOR_WINDOW : COLOR_BTNFACE;
    if (hdc && gdi.getDC(hdc)) {
        gdi.setTextColor(hdc, sysColor(COLOR_WINDOWTEXT));
        gdi.setBkColor(hdc, sysColor(bk));
    }
    return SYS_COLOR_BRUSH_BASE + (msg === WM_CTLCOLORSCROLLBAR ? COLOR_SCROLLBAR : bk);
}

/** CSS fill for a brush handle, 'transparent' for NULL_BRUSH, or an 8x8 tile for a pattern brush. */
export function resolveBrushFill(gdi: GDIContext, hbr: number): string | OffscreenCanvas | null {
    const h = hbr >>> 0;
    if (!h) return null;
    let colorIndex = -1;
    if (h <= 0x1F) colorIndex = h - 1; // COLOR_* + 1 pseudo-brush
    else if (h >= SYS_COLOR_BRUSH_BASE && h <= SYS_COLOR_BRUSH_BASE + 0x1F) colorIndex = h - SYS_COLOR_BRUSH_BASE;
    if (colorIndex >= 0) return colorToCss(gdi, sysColor(colorIndex));
    const obj = gdi.getBrushObject(h);
    if (!obj) return null;
    if (typeof obj.data === 'string') return obj.data;
    if (obj.data?.kind === 'pattern' && obj.data.tileCanvas) return obj.data.tileCanvas as OffscreenCanvas;
    return null;
}

