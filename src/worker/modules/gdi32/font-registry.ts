/**
 * GDI font registry — the faces `CreateFontIndirect` can actually match.
 *
 * Two sources, mirroring Windows:
 *  - The metric-compatible substitutes we ship for the faces a real Windows box
 *    would have (Arial, Times, Courier … → Liberation). These are "installed"
 *    once per session.
 *  - The fonts the GUEST has installed: every file under `C:\WINDOWS\FONTS`,
 *    which is where an installer copies the TTFs a game ships, plus anything
 *    added at runtime through `AddFontResource`. A game asking for a face it
 *    installed itself — AoE2's UI is set in Lucida Blackletter and Georgia,
 *    both shipped in its own FONTS\ directory — can only be matched from here;
 *    without it every such request silently fell back to the default sans and
 *    the text rendered in the wrong typeface.
 *
 * Registration goes through the worker's FontFaceSet (`self.fonts`), which is
 * what OffscreenCanvas 2D resolves a CSS font string against. The family name
 * comes from the file's own `name` table, not its filename, because that is the
 * name GDI matches on (LBLACK.TTF declares "Lucida Blackletter").
 */

import { Logger, LogCategory } from "../../core/logger";

/** Families successfully registered with the worker's FontFaceSet, lowercased. */
const registered = new Set<string>();
/** Guest font files already processed, so a re-scan or AddFontResource is idempotent. */
const loadedPaths = new Set<string>();

/** The substitutes we ship, and the Windows faces each one stands in for. */
const BUNDLED_FONTS: ReadonlyArray<{ family: string; url: string; weight: string; style: string }> = [
    { family: "Liberation Sans", url: "/fonts/LiberationSans-Regular.ttf", weight: "400", style: "normal" },
    { family: "Liberation Sans", url: "/fonts/LiberationSans-Bold.ttf", weight: "700", style: "normal" },
    { family: "Liberation Sans", url: "/fonts/LiberationSans-Italic.ttf", weight: "400", style: "italic" },
    { family: "Liberation Serif", url: "/fonts/LiberationSerif-Regular.ttf", weight: "400", style: "normal" },
    { family: "Liberation Mono", url: "/fonts/LiberationMono-Regular.ttf", weight: "400", style: "normal" },
    { family: "Liberation Mono", url: "/fonts/LiberationMono-Bold.ttf", weight: "700", style: "normal" },
];

export function isFontFamilyRegistered(family: string): boolean {
    return registered.has(family.trim().toLowerCase());
}

function fontSet(): FontFaceSet | null {
    const set = (globalThis as unknown as { fonts?: FontFaceSet }).fonts;
    return set && typeof set.add === "function" ? set : null;
}

async function addFace(family: string, source: BufferSource | string, weight: string, style: string): Promise<boolean> {
    const set = fontSet();
    if (!set || typeof FontFace !== "function") return false;
    try {
        const face = new FontFace(family, typeof source === "string" ? `url(${source})` : source, { weight, style });
        await face.load();
        set.add(face);
        registered.add(family.trim().toLowerCase());
        return true;
    } catch (e) {
        Logger.warn(LogCategory.GDI32, `font: registering "${family}" (${weight}/${style}) failed: ${e}`);
        return false;
    }
}

// ---------------------------------------------------------------------------
// sfnt `name` table
// ---------------------------------------------------------------------------

export interface FontIdentity {
    family: string;
    weight: string;
    style: string;
}

const readUtf16Be = (b: Uint8Array): string => {
    let s = "";
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
    return s;
};

/**
 * Pull the family + subfamily out of a TrueType/OpenType file. Returns null when
 * the bytes are not an sfnt we can name (a collection, a bitmap-only .fon, …).
 * Name IDs: 1 = family, 2 = subfamily, 16/17 = typographic family/subfamily —
 * the typographic pair wins when present because that is the grouping GDI shows.
 */
export function parseFontIdentity(data: Uint8Array): FontIdentity | null {
    if (data.length < 12) return null;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const tag = dv.getUint32(0, false);
    // 0x00010000 TrueType, 'true' (Mac), 'OTTO' (CFF). 'ttcf' collections are skipped.
    if (tag !== 0x00010000 && tag !== 0x74727565 && tag !== 0x4f54544f) return null;

    const numTables = dv.getUint16(4, false);
    let nameOff = 0;
    for (let i = 0; i < numTables; i++) {
        const rec = 12 + i * 16;
        if (rec + 16 > data.length) return null;
        if (dv.getUint32(rec, false) === 0x6e616d65 /* 'name' */) {
            nameOff = dv.getUint32(rec + 8, false);
            break;
        }
    }
    if (!nameOff || nameOff + 6 > data.length) return null;

    const count = dv.getUint16(nameOff + 2, false);
    const stringOff = nameOff + dv.getUint16(nameOff + 4, false);
    const best = new Map<number, string>();
    for (let i = 0; i < count; i++) {
        const rec = nameOff + 6 + i * 12;
        if (rec + 12 > data.length) break;
        const platformId = dv.getUint16(rec, false);
        const nameId = dv.getUint16(rec + 6, false);
        if (nameId !== 1 && nameId !== 2 && nameId !== 16 && nameId !== 17) continue;
        const len = dv.getUint16(rec + 8, false);
        const off = stringOff + dv.getUint16(rec + 10, false);
        if (off + len > data.length) continue;
        const raw = data.subarray(off, off + len);
        // Platform 3 (Windows) is UTF-16BE; platform 1 (Mac) is single-byte. Some
        // files tag a UTF-16 string as Mac, which shows up as NUL-interleaved.
        const text = platformId === 3 || (raw.length > 1 && raw[0] === 0)
            ? readUtf16Be(raw)
            : new TextDecoder("latin1").decode(raw);
        const clean = text.replace(/\0/g, "").trim();
        if (clean && !best.has(nameId)) best.set(nameId, clean);
    }

    const family = best.get(16) ?? best.get(1);
    if (!family) return null;
    const sub = (best.get(17) ?? best.get(2) ?? "Regular").toLowerCase();

    // Subfamily → CSS weight/style. Demibold/semibold are 600 so a game asking for
    // bold still matches them when no 700 face exists (Lucida Bright Demibold).
    let weight = "400";
    if (/black|heavy/.test(sub)) weight = "900";
    else if (/extra\s*bold|ultra\s*bold/.test(sub)) weight = "800";
    else if (/demi|semi/.test(sub)) weight = "600";
    else if (/bold/.test(sub)) weight = "700";
    else if (/light|thin/.test(sub)) weight = "300";
    const style = /italic|oblique/.test(sub) ? "italic" : "normal";
    return { family, weight, style };
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/** Install the shipped substitutes. Idempotent; safe to call per process start. */
export async function registerBundledFonts(): Promise<void> {
    if (!fontSet()) return;
    for (const f of BUNDLED_FONTS) {
        if (registered.has(f.family.toLowerCase()) && f.weight === "400" && f.style === "normal") continue;
        await addFace(f.family, f.url, f.weight, f.style);
    }
}

/** Register one guest font file by path. Returns the family name, or null. */
export async function registerGuestFontFile(path: string, read: (p: string) => Promise<Uint8Array | null>): Promise<string | null> {
    const key = path.toLowerCase();
    if (loadedPaths.has(key)) return null;
    loadedPaths.add(key);

    const data = await read(path);
    if (!data || data.length === 0) return null;
    const id = parseFontIdentity(data);
    if (!id) return null;
    // Copy: the VFS buffer may be a view into a larger shared array, and FontFace
    // keeps the bytes.
    const ok = await addFace(id.family, data.slice().buffer, id.weight, id.style);
    if (!ok) return null;
    Logger.log(LogCategory.GDI32, `font: registered "${id.family}" ${id.weight}/${id.style} from ${path}`);
    return id.family;
}

const FONT_EXT = /\.(ttf|otf|ttc|fon)$/i;

/**
 * Install every font the guest has, i.e. the contents of its Windows font
 * directory — what an installer copies there when it adds a game's own faces.
 */
export async function registerGuestFonts(
    list: (dir: string) => Array<{ name: string; kind: string }>,
    read: (path: string) => Promise<Uint8Array | null>,
    dirs: readonly string[] = ["C:\\WINDOWS\\FONTS", "C:\\WINDOWS\\Fonts"],
): Promise<number> {
    if (!fontSet()) return 0;
    let count = 0;
    const seen = new Set<string>();
    for (const dir of dirs) {
        let entries: Array<{ name: string; kind: string }>;
        try {
            entries = list(dir);
        } catch {
            continue;
        }
        for (const e of entries) {
            if (e.kind === "dir" || !FONT_EXT.test(e.name)) continue;
            const lower = e.name.toLowerCase();
            if (seen.has(lower)) continue;
            seen.add(lower);
            if (await registerGuestFontFile(`${dir}\\${e.name}`, read)) count++;
        }
    }
    return count;
}

/** Drop all registrations — a game switch reloads the worker's font set. */
export function resetFontRegistry(): void {
    registered.clear();
    loadedPaths.clear();
}
