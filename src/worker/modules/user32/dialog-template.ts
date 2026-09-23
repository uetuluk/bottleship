/**
 * DLGTEMPLATE / DLGITEMTEMPLATE binary parser
 *
 * Parses the in-memory Win32 dialog template format used by
 * CreateDialogIndirectParam / DialogBoxIndirectParam.
 */

import { Logger, LogCategory } from '../../core/logger';

export interface ParsedDlgTemplate {
    style: number;
    exStyle: number;
    x: number;   // DLUs
    y: number;
    cx: number;
    cy: number;
    title: string;
    fontSize?: number;
    fontName?: string;
    menuId: number;       // 0 = none
    windowClass: string;  // '#32770' if default
    controls: ParsedDlgItem[];
}

export interface ParsedDlgItem {
    style: number;
    exStyle: number;
    x: number;   // DLUs
    y: number;
    cx: number;
    cy: number;
    id: number;
    className: string;  // 'Button', 'Static', 'Edit', etc.
    title: string;
}

const DS_SETFONT = 0x40;
const DS_SHELLFONT = 0x48;

/** System class atoms → class names */
const SYSTEM_CLASS_ATOMS: Record<number, string> = {
    0x0080: 'Button',
    0x0081: 'Edit',
    0x0082: 'Static',
    0x0083: 'ListBox',
    0x0084: 'ScrollBar',
    0x0085: 'ComboBox',
};

/**
 * Canonical name of a predefined USER32 control class (by name or class atom), or
 * null for any other class. These classes exist without RegisterClass.
 */
export function predefinedControlClassName(className: string | number): string | null {
    if (typeof className === 'number') return SYSTEM_CLASS_ATOMS[className] ?? null;
    const lower = className.toLowerCase();
    for (const name of Object.values(SYSTEM_CLASS_ATOMS)) {
        if (name.toLowerCase() === lower) return name;
    }
    return null;
}

/** DWORD-align an offset */
function dwordAlign(offset: number): number {
    return (offset + 3) & ~3;
}

/**
 * Read a sz_Or_Ord field (menu, class, title in DLGTEMPLATE/DLGITEMTEMPLATE).
 * Format: WORD prefix.
 *   0x0000 → empty / none (returns { value: '', isOrdinal: false })
 *   0xFFFF → next WORD is ordinal
 *   else   → UTF-16 null-terminated string starting at this WORD
 * Returns the parsed value and the new offset after the field.
 */
function readSzOrOrd(
    view: DataView, offset: number
): { value: string; ordinal: number; newOffset: number } {
    const first = view.getUint16(offset, true);

    if (first === 0x0000) {
        return { value: '', ordinal: 0, newOffset: offset + 2 };
    }

    if (first === 0xFFFF) {
        const ord = view.getUint16(offset + 2, true);
        return { value: '', ordinal: ord, newOffset: offset + 4 };
    }

    // UTF-16 string
    let str = '';
    let pos = offset;
    while (true) {
        const ch = view.getUint16(pos, true);
        pos += 2;
        if (ch === 0) break;
        str += String.fromCharCode(ch);
    }
    return { value: str, ordinal: 0, newOffset: pos };
}

/**
 * Read a class field from DLGITEMTEMPLATE.
 * WORD prefix: if 0xFFFF, next WORD is atom (map to class name).
 * Otherwise UTF-16 null-terminated string.
 */
function readItemClass(
    view: DataView, offset: number
): { className: string; newOffset: number } {
    const first = view.getUint16(offset, true);

    if (first === 0xFFFF) {
        const atom = view.getUint16(offset + 2, true);
        const name = SYSTEM_CLASS_ATOMS[atom] || `#${atom}`;
        return { className: name, newOffset: offset + 4 };
    }

    // UTF-16 string
    let str = '';
    let pos = offset;
    while (true) {
        const ch = view.getUint16(pos, true);
        pos += 2;
        if (ch === 0) break;
        str += String.fromCharCode(ch);
    }
    return { className: str, newOffset: pos };
}

/**
 * Read a UTF-16 null-terminated string (title field).
 */
function readWideString(
    view: DataView, offset: number
): { value: string; newOffset: number } {
    let str = '';
    let pos = offset;
    while (true) {
        const ch = view.getUint16(pos, true);
        pos += 2;
        if (ch === 0) break;
        str += String.fromCharCode(ch);
    }
    return { value: str, newOffset: pos };
}

/**
 * Detect whether the template at `offset` is DLGTEMPLATEEX.
 * DLGTEMPLATEEX starts with: WORD dlgVer=1, WORD signature=0xFFFF
 */
function isDlgTemplateEx(view: DataView, offset: number): boolean {
    const dlgVer = view.getUint16(offset, true);
    const signature = view.getUint16(offset + 2, true);
    return dlgVer === 1 && signature === 0xFFFF;
}

/**
 * Parse a DLGTEMPLATEEX structure (26-byte header).
 */
function parseDlgTemplateEx(view: DataView, offset: number): ParsedDlgTemplate {
    // DLGTEMPLATEEX header: 26 bytes
    // +0  WORD  dlgVer (1)
    // +2  WORD  signature (0xFFFF)
    // +4  DWORD helpID
    // +8  DWORD exStyle
    // +12 DWORD style
    // +16 WORD  cdit
    // +18 short x, +20 short y, +22 short cx, +24 short cy
    const exStyle = view.getUint32(offset + 8, true);
    const style   = view.getUint32(offset + 12, true);
    const cdit    = view.getUint16(offset + 16, true);
    const x       = view.getInt16(offset + 18, true);
    const y       = view.getInt16(offset + 20, true);
    const cx      = view.getInt16(offset + 22, true);
    const cy      = view.getInt16(offset + 24, true);

    let pos = offset + 26;

    // Variable fields: menu, windowClass, title (same format as DLGTEMPLATE)
    const menu = readSzOrOrd(view, pos);
    pos = menu.newOffset;

    const wndClass = readSzOrOrd(view, pos);
    pos = wndClass.newOffset;

    const titleField = readWideString(view, pos);
    pos = titleField.newOffset;

    let fontSize: number | undefined;
    let fontName: string | undefined;

    // DLGTEMPLATEEX font block: DS_SETFONT or DS_SHELLFONT
    // pointSize(WORD), weight(WORD), italic(BYTE), charset(BYTE), typeface(WCHAR[])
    if (style & (DS_SETFONT | DS_SHELLFONT)) {
        fontSize = view.getUint16(pos, true);
        pos += 2;
        // weight (WORD) — skip
        pos += 2;
        // italic (BYTE) + charset (BYTE) — skip
        pos += 2;
        const font = readWideString(view, pos);
        fontName = font.value;
        pos = font.newOffset;
    }

    // Parse child controls (DLGITEMTEMPLATEEX)
    const controls: ParsedDlgItem[] = [];
    for (let i = 0; i < cdit; i++) {
        pos = dwordAlign(pos);

        // DLGITEMTEMPLATEEX: 24-byte header
        // +0  DWORD helpID
        // +4  DWORD exStyle
        // +8  DWORD style
        // +12 short x, +14 short y, +16 short cx, +18 short cy
        // +20 DWORD id
        const itemExStyle = view.getUint32(pos + 4, true);
        const itemStyle   = view.getUint32(pos + 8, true);
        const itemX       = view.getInt16(pos + 12, true);
        const itemY       = view.getInt16(pos + 14, true);
        const itemCx      = view.getInt16(pos + 16, true);
        const itemCy      = view.getInt16(pos + 18, true);
        const itemId      = view.getUint32(pos + 20, true);  // DWORD, not WORD

        pos += 24;

        // Class field (same format)
        const cls = readItemClass(view, pos);
        pos = cls.newOffset;

        // Title field
        const titleFirst = view.getUint16(pos, true);
        let itemTitle = '';
        if (titleFirst === 0xFFFF) {
            itemTitle = `#${view.getUint16(pos + 2, true)}`;
            pos += 4;
        } else {
            const t = readWideString(view, pos);
            itemTitle = t.value;
            pos = t.newOffset;
        }

        // Creation data: WORD cbExtra + bytes
        const cbExtra = view.getUint16(pos, true);
        pos += 2 + cbExtra;

        controls.push({
            style: itemStyle,
            exStyle: itemExStyle,
            x: itemX,
            y: itemY,
            cx: itemCx,
            cy: itemCy,
            id: itemId,
            className: cls.className,
            title: itemTitle,
        });
    }

    return {
        style,
        exStyle,
        x, y, cx, cy,
        title: titleField.value,
        fontSize,
        fontName,
        menuId: menu.ordinal,
        windowClass: wndClass.value || '#32770',
        controls,
    };
}

/**
 * Parse a standard DLGTEMPLATE structure (18-byte header).
 */
function parseDlgTemplateStd(view: DataView, offset: number): ParsedDlgTemplate {
    // Fixed header: 18 bytes
    const style   = view.getUint32(offset + 0, true);
    const exStyle = view.getUint32(offset + 4, true);
    const cdit    = view.getUint16(offset + 8, true);
    const x       = view.getInt16(offset + 10, true);
    const y       = view.getInt16(offset + 12, true);
    const cx      = view.getInt16(offset + 14, true);
    const cy      = view.getInt16(offset + 16, true);

    let pos = offset + 18;

    // Variable fields: menu, windowClass, title
    const menu = readSzOrOrd(view, pos);
    pos = menu.newOffset;

    const wndClass = readSzOrOrd(view, pos);
    pos = wndClass.newOffset;

    const titleField = readWideString(view, pos);
    pos = titleField.newOffset;

    let fontSize: number | undefined;
    let fontName: string | undefined;

    if (style & DS_SETFONT) {
        fontSize = view.getUint16(pos, true);
        pos += 2;
        const font = readWideString(view, pos);
        fontName = font.value;
        pos = font.newOffset;
    }

    // Parse child controls
    const controls: ParsedDlgItem[] = [];
    for (let i = 0; i < cdit; i++) {
        // Each DLGITEMTEMPLATE must be DWORD-aligned
        pos = dwordAlign(pos);

        const itemStyle   = view.getUint32(pos + 0, true);
        const itemExStyle = view.getUint32(pos + 4, true);
        const itemX       = view.getInt16(pos + 8, true);
        const itemY       = view.getInt16(pos + 10, true);
        const itemCx      = view.getInt16(pos + 12, true);
        const itemCy      = view.getInt16(pos + 14, true);
        const itemId      = view.getUint16(pos + 16, true);

        pos += 18;

        // Class field
        const cls = readItemClass(view, pos);
        pos = cls.newOffset;

        // Title field (sz_Or_Ord: can be 0xFFFF+ordinal for resource ID, or string)
        const titleFirst = view.getUint16(pos, true);
        let itemTitle = '';
        if (titleFirst === 0xFFFF) {
            // Resource ordinal — store as string representation
            itemTitle = `#${view.getUint16(pos + 2, true)}`;
            pos += 4;
        } else {
            const t = readWideString(view, pos);
            itemTitle = t.value;
            pos = t.newOffset;
        }

        // Creation data: WORD cbExtra + bytes
        const cbExtra = view.getUint16(pos, true);
        pos += 2 + cbExtra;

        controls.push({
            style: itemStyle,
            exStyle: itemExStyle,
            x: itemX,
            y: itemY,
            cx: itemCx,
            cy: itemCy,
            id: itemId,
            className: cls.className,
            title: itemTitle,
        });
    }

    return {
        style,
        exStyle,
        x, y, cx, cy,
        title: titleField.value,
        fontSize,
        fontName,
        menuId: menu.ordinal,
        windowClass: wndClass.value || '#32770',
        controls,
    };
}

/**
 * Parse a DLGTEMPLATE or DLGTEMPLATEEX structure from guest memory.
 *
 * @param mem   Guest memory (Uint8Array)
 * @param offset  Byte offset of the DLGTEMPLATE in mem
 */
export function parseDlgTemplate(mem: Uint8Array, offset: number): ParsedDlgTemplate {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    if (isDlgTemplateEx(view, offset)) {
        return parseDlgTemplateEx(view, offset);
    }
    return parseDlgTemplateStd(view, offset);
}

/**
 * Dialog base units: the horizontal (avg char width) and vertical (char cell
 * height) GDI text metrics the dialog manager uses to map DLUs to pixels.
 */
export interface DialogBaseUnits {
    x: number;
    y: number;
}

/**
 * System-font base units, returned for templates with no DS_SETFONT block —
 * the classic GetDialogBaseUnits() value for the default System font.
 */
const SYSTEM_BASE_UNITS: DialogBaseUnits = { x: 8, y: 16 };

/**
 * Compute a dialog's base units exactly as the Win32 dialog manager does.
 *
 * A DS_SETFONT/DS_SHELLFONT template measures ITS OWN font: the manager selects
 * the font into a DC, then derives the horizontal unit from the average glyph
 * width and the vertical unit from the cell height (GetTextMetrics/
 * GetTextExtentPoint of the alphabet). A template with no font block falls back
 * to the system-font units (GetDialogBaseUnits).
 *
 * We can't run GDI over an arbitrary guest font here, so we reproduce the
 * canonical result: the standard proportional UI fonts (MS Sans Serif / MS
 * Shell Dlg / Tahoma / Microsoft Sans Serif) measure (6, 13) at 8pt/96dpi, and
 * other point sizes scale linearly from that reference. This matches real
 * GetDialogBaseUnits/MapDialogRect output for the overwhelmingly common case.
 */
export function getDialogBaseUnits(parsed: ParsedDlgTemplate | null): DialogBaseUnits {
    if (!parsed || parsed.fontSize == null || parsed.fontSize <= 0 || !parsed.fontName) {
        return SYSTEM_BASE_UNITS;
    }
    const REF_X = 6, REF_Y = 13, REF_PT = 8;
    return {
        x: Math.max(1, Math.round((REF_X * parsed.fontSize) / REF_PT)),
        y: Math.max(1, Math.round((REF_Y * parsed.fontSize) / REF_PT)),
    };
}

/** Win32 MulDiv(a, b, c): round to nearest, ties away from zero. */
function mulDiv(a: number, b: number, c: number): number {
    const v = a * b;
    const half = c >> 1;
    return v >= 0
        ? Math.floor((v + half) / c)
        : -Math.floor((-v + half) / c);
}

/**
 * Convert Dialog Logical Units to pixels (MapDialogRect):
 *   pixelX = MulDiv(dluX, baseUnitX, 4)
 *   pixelY = MulDiv(dluY, baseUnitY, 8)
 * `base` defaults to the system font units when a caller has no template font.
 */
export function dluToPixelX(dlu: number, base: DialogBaseUnits = SYSTEM_BASE_UNITS): number {
    return mulDiv(dlu, base.x, 4);
}

export function dluToPixelY(dlu: number, base: DialogBaseUnits = SYSTEM_BASE_UNITS): number {
    return mulDiv(dlu, base.y, 8);
}

const SS_TYPEMASK = 0x001F;
const SS_ICON = 0x0003;
const SS_BITMAP = 0x000E;
const SS_CENTERIMAGE = 0x0200;
const SS_REALSIZEIMAGE = 0x0800;

const WS_VISIBLE = 0x10000000;
const WS_CHILD = 0x40000000;

function decodeStaticStyle(style: number): string {
    const type = style & SS_TYPEMASK;
    const parts: string[] = [];
    switch (type) {
        case SS_ICON: parts.push('SS_ICON'); break;
        case SS_BITMAP: parts.push('SS_BITMAP'); break;
        case 0: parts.push('SS_LEFT'); break;
        case 1: parts.push('SS_CENTER'); break;
        case 2: parts.push('SS_RIGHT'); break;
        default: parts.push(`SS_type=0x${type.toString(16)}`);
    }
    if ((style & SS_CENTERIMAGE) !== 0) parts.push('SS_CENTERIMAGE');
    if ((style & SS_REALSIZEIMAGE) !== 0) parts.push('SS_REALSIZEIMAGE');
    if ((style & WS_VISIBLE) !== 0) parts.push('WS_VISIBLE');
    if ((style & WS_CHILD) !== 0) parts.push('WS_CHILD');
    return parts.join('|');
}

/**
 * Human-readable DLGTEMPLATE dump for console debugging (copy/paste friendly).
 */
export function formatDlgTemplateDump(
    parsed: ParsedDlgTemplate,
    templatePtr?: number,
): string {
    const lines: string[] = [];
    const base = getDialogBaseUnits(parsed);
    const hdr = templatePtr != null
        ? `DLGTEMPLATE @ 0x${templatePtr.toString(16)}`
        : 'DLGTEMPLATE';
    lines.push(`=== ${hdr} ===`);
    lines.push(
        `dialog: "${parsed.title}" class=${parsed.windowClass || '#32770'} ` +
        `style=0x${parsed.style.toString(16)} exStyle=0x${parsed.exStyle.toString(16)}`,
    );
    lines.push(
        `  rect DLU: (${parsed.x},${parsed.y}) ${parsed.cx}x${parsed.cy} ` +
        `→ px: (${dluToPixelX(parsed.x, base)},${dluToPixelY(parsed.y, base)}) ` +
        `${dluToPixelX(parsed.cx, base)}x${dluToPixelY(parsed.cy, base)}`,
    );
    if (parsed.fontSize != null) {
        lines.push(`  font: ${parsed.fontSize}pt "${parsed.fontName ?? ''}" baseUnits=(${base.x},${base.y})`);
    }
    lines.push(`  controls: ${parsed.controls.length}`);
    for (let i = 0; i < parsed.controls.length; i++) {
        const c = parsed.controls[i];
        const pxX = dluToPixelX(c.x, base);
        const pxY = dluToPixelY(c.y, base);
        const pxW = dluToPixelX(c.cx, base);
        const pxH = dluToPixelY(c.cy, base);
        let extra = '';
        if (c.className.toLowerCase() === 'static') {
            extra = ` staticStyle={${decodeStaticStyle(c.style)}}`;
        }
        lines.push(
            `  [${i}] ${c.className} id=${c.id} title="${c.title}"`,
        );
        lines.push(
            `       style=0x${c.style.toString(16)} exStyle=0x${c.exStyle.toString(16)}${extra}`,
        );
        lines.push(
            `       DLU (${c.x},${c.y}) ${c.cx}x${c.cy} → px (${pxX},${pxY}) ${pxW}x${pxH}`,
        );
    }
    lines.push('=== end DLGTEMPLATE ===');
    return lines.join('\n');
}

/** Log full template dump to USER32 category (visible in dev console / log stream). */
export function logDlgTemplateDump(
    parsed: ParsedDlgTemplate,
    label: string,
    templatePtr?: number,
): void {
    Logger.log(LogCategory.USER32, `${label} template dump:\n${formatDlgTemplateDump(parsed, templatePtr)}`);
}
