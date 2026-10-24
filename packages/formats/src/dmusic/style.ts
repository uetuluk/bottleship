/**
 * DirectMusic style (`RIFF DMST`): a time signature and tempo, a pool of parts (notes and
 * curves on a grid, in up to 32 variations), and patterns that arrange part references
 * into the musical figures the style track chooses between by groove level and
 * embellishment. Motifs are patterns playable on their own as secondary segments.
 */
import { type Band, parseBandAt } from "./band";
import { type ObjectIdentity, parseIdentity } from "./reference";
import { type RiffChunk, dataView, guidString, isList, riffChunks, riffRoot, wideString } from "./riff";

/** Music-time ticks per quarter note. */
export const DMUS_PPQ = 768;

export const DMUS_EMBELLISHT_NORMAL = 0;
export const DMUS_EMBELLISHT_FILL = 1;
export const DMUS_EMBELLISHT_INTRO = 2;
export const DMUS_EMBELLISHT_BREAK = 4;
export const DMUS_EMBELLISHT_END = 8;
export const DMUS_EMBELLISHT_MOTIF = 16;

export interface TimeSignature {
    beatsPerMeasure: number;
    /** Note value of a beat: 4 is a quarter note. Zero in a file means 256. */
    beat: number;
    gridsPerBeat: number;
}

export function ticksPerBeat(sig: TimeSignature): number {
    return Math.floor((DMUS_PPQ * 4) / (sig.beat || 256));
}

export function ticksPerGrid(sig: TimeSignature): number {
    return Math.floor(ticksPerBeat(sig) / Math.max(1, sig.gridsPerBeat));
}

export function ticksPerMeasure(sig: TimeSignature): number {
    return ticksPerBeat(sig) * Math.max(1, sig.beatsPerMeasure);
}

/** DMUS_IO_STYLENOTE. */
export interface StyleNote {
    gridStart: number;
    /** One bit per variation the note belongs to. */
    variation: number;
    duration: number;
    timeOffset: number;
    /** A MIDI note for a fixed play mode, else scale position: octave/chord/scale/accidental nibbles. */
    musicValue: number;
    velocity: number;
    timeRange: number;
    durRange: number;
    velRange: number;
    inversionId: number;
    /** DMUS_PLAYMODE_* for this note; DMUS_PLAYMODE_NONE (0) defers to the part. */
    playModeFlags: number;
}

/** DMUS_IO_STYLECURVE. */
export interface StyleCurve {
    gridStart: number;
    variation: number;
    duration: number;
    resetDuration: number;
    timeOffset: number;
    startValue: number;
    endValue: number;
    resetValue: number;
    /** DMUS_CURVET_*: 3 pitch bend, 4 control change, 5 mono aftertouch, 6 poly aftertouch. */
    eventType: number;
    /** DMUS_CURVES_*: 0 linear, 1 instant, 2 exp, 3 log, 4 sine. */
    curveShape: number;
    ccData: number;
    flags: number;
}

/** `LIST part` — DMUS_IO_STYLEPART plus its events. */
export interface StylePart {
    timeSig: TimeSignature;
    /** Per variation: which chords/keys it may play over (unused variations are 0). */
    variationChoices: number[];
    partId: string;
    measures: number;
    playModeFlags: number;
    invertUpper: number;
    invertLower: number;
    notes: StyleNote[];
    curves: StyleCurve[];
}

/** `LIST pref` — DMUS_IO_PARTREF: one part placed on a performance channel in a pattern. */
export interface PartRef {
    partId: string;
    /** The performance channel, for a file that predates the dedicated field. */
    logicalPartId: number;
    variationLockId: number;
    subChordLevel: number;
    priority: number;
    randomVariation: number;
    pChannel: number;
    name: string;
}

/** DMUS_IO_MOTIFSETTINGS. */
export interface MotifSettings {
    repeats: number;
    playStart: number;
    loopStart: number;
    loopEnd: number;
    resolution: number;
}

export interface StylePattern {
    name: string;
    timeSig: TimeSignature;
    grooveBottom: number;
    grooveTop: number;
    /** DMUS_EMBELLISHT_* bits. */
    embellishment: number;
    measures: number;
    /** One bit per grid of each measure where the pattern sounds, for chord matching. */
    rhythm: number[];
    partRefs: PartRef[];
    motifSettings: MotifSettings | null;
    /** A motif's own band, when it carries one. */
    band: Band | null;
}

export interface Style {
    identity: ObjectIdentity;
    timeSig: TimeSignature;
    tempo: number;
    bands: Band[];
    parts: Map<string, StylePart>;
    /** Patterns the style track picks from; motifs (DMUS_EMBELLISHT_MOTIF) are kept apart. */
    patterns: StylePattern[];
    motifs: StylePattern[];
}

function readTimeSig(buf: Uint8Array, o: number): TimeSignature {
    return { beatsPerMeasure: buf[o]!, beat: buf[o + 1]!, gridsPerBeat: buf[o + 2]! | (buf[o + 3]! << 8) };
}

/** An array chunk: a DWORD element size, then elements of that size. */
function* sizedArray(buf: Uint8Array, chunk: RiffChunk, minSize: number): Generator<number> {
    if (chunk.end - chunk.start < 4) return;
    const size = dataView(buf).getUint32(chunk.start, true);
    if (size < minSize) return;
    for (let o = chunk.start + 4; o + size <= chunk.end; o += size) yield o;
}

function parsePart(buf: Uint8Array, list: RiffChunk): StylePart | null {
    const view = dataView(buf);
    let part: StylePart | null = null;
    const notes: StyleNote[] = [];
    const curves: StyleCurve[] = [];
    for (const c of riffChunks(buf, list.start, list.end)) {
        if (c.id === "prth" && c.end - c.start >= 153) {
            const o = c.start;
            const choices: number[] = [];
            for (let i = 0; i < 32; i++) choices.push(view.getUint32(o + 4 + i * 4, true));
            part = {
                timeSig: readTimeSig(buf, o),
                variationChoices: choices,
                partId: guidString(buf, o + 132),
                measures: view.getUint16(o + 148, true),
                playModeFlags: buf[o + 150]!,
                invertUpper: buf[o + 151]!,
                invertLower: buf[o + 152]!,
                notes, curves,
            };
        } else if (c.id === "note") {
            for (const o of sizedArray(buf, c, 22)) {
                notes.push({
                    gridStart: view.getInt32(o, true),
                    variation: view.getUint32(o + 4, true),
                    duration: view.getInt32(o + 8, true),
                    timeOffset: view.getInt16(o + 12, true),
                    musicValue: view.getUint16(o + 14, true),
                    velocity: buf[o + 16]!,
                    timeRange: buf[o + 17]!,
                    durRange: buf[o + 18]!,
                    velRange: buf[o + 19]!,
                    inversionId: buf[o + 20]!,
                    playModeFlags: buf[o + 21]!,
                });
            }
        } else if (c.id === "crve") {
            for (const o of sizedArray(buf, c, 28)) {
                curves.push({
                    gridStart: view.getInt32(o, true),
                    variation: view.getUint32(o + 4, true),
                    duration: view.getInt32(o + 8, true),
                    resetDuration: view.getInt32(o + 12, true),
                    timeOffset: view.getInt16(o + 16, true),
                    startValue: view.getInt16(o + 18, true),
                    endValue: view.getInt16(o + 20, true),
                    resetValue: view.getInt16(o + 22, true),
                    eventType: buf[o + 24]!,
                    curveShape: buf[o + 25]!,
                    ccData: buf[o + 26]!,
                    flags: buf[o + 27]!,
                });
            }
        }
    }
    return part;
}

function parsePartRef(buf: Uint8Array, list: RiffChunk): PartRef | null {
    const view = dataView(buf);
    let ref: PartRef | null = null;
    let name = "";
    for (const c of riffChunks(buf, list.start, list.end)) {
        const size = c.end - c.start;
        if (c.id === "prfc" && size >= 22) {
            const o = c.start;
            const logical = view.getUint16(o + 16, true);
            ref = {
                partId: guidString(buf, o),
                logicalPartId: logical,
                variationLockId: buf[o + 18]!,
                subChordLevel: buf[o + 19]!,
                priority: buf[o + 20]!,
                randomVariation: buf[o + 21]!,
                pChannel: size >= 28 ? view.getUint32(o + 24, true) : logical,
                name: "",
            };
        } else if (isList(c, "UNFO")) {
            for (const u of riffChunks(buf, c.start, c.end)) if (u.id === "UNAM") name = wideString(buf, u);
        }
    }
    if (ref) ref.name = name;
    return ref;
}

function parsePattern(buf: Uint8Array, list: RiffChunk): StylePattern | null {
    const view = dataView(buf);
    let pattern: StylePattern | null = null;
    let name = "";
    const rhythm: number[] = [];
    const partRefs: PartRef[] = [];
    let motifSettings: MotifSettings | null = null;
    let band: Band | null = null;
    for (const c of riffChunks(buf, list.start, list.end)) {
        const size = c.end - c.start;
        if (c.id === "ptnh" && size >= 10) {
            const o = c.start;
            pattern = {
                name: "",
                timeSig: readTimeSig(buf, o),
                grooveBottom: buf[o + 4]!,
                grooveTop: buf[o + 5]!,
                embellishment: view.getUint16(o + 6, true),
                measures: view.getUint16(o + 8, true),
                rhythm, partRefs, motifSettings: null, band: null,
            };
        } else if (c.id === "rhtm") {
            for (let o = c.start; o + 4 <= c.end; o += 4) rhythm.push(view.getUint32(o, true));
        } else if (c.id === "mtfs" && size >= 20) {
            const o = c.start;
            motifSettings = {
                repeats: view.getUint32(o, true),
                playStart: view.getInt32(o + 4, true),
                loopStart: view.getInt32(o + 8, true),
                loopEnd: view.getInt32(o + 12, true),
                resolution: view.getUint32(o + 16, true),
            };
        } else if (isList(c, "pref")) {
            const ref = parsePartRef(buf, c);
            if (ref) partRefs.push(ref);
        } else if (isList(c, "UNFO")) {
            for (const u of riffChunks(buf, c.start, c.end)) if (u.id === "UNAM") name = wideString(buf, u);
        } else if (isList(c, "DMBD")) {
            band = parseBandAt(buf, c);
        }
    }
    if (!pattern) return null;
    pattern.name = name;
    pattern.motifSettings = motifSettings;
    pattern.band = band;
    return pattern;
}

export function parseStyle(buf: Uint8Array): Style | null {
    const root = riffRoot(buf, "DMST");
    if (!root) return null;
    const view = dataView(buf);
    const style: Style = {
        identity: parseIdentity(buf, root),
        timeSig: { beatsPerMeasure: 4, beat: 4, gridsPerBeat: 4 },
        tempo: 120,
        bands: [], parts: new Map(), patterns: [], motifs: [],
    };
    for (const c of riffChunks(buf, root.start, root.end)) {
        if (c.id === "styh" && c.end - c.start >= 16) {
            style.timeSig = readTimeSig(buf, c.start);
            style.tempo = view.getFloat64(c.start + 8, true);
        } else if (isList(c, "DMBD")) {
            style.bands.push(parseBandAt(buf, c));
        } else if (isList(c, "part")) {
            const part = parsePart(buf, c);
            if (part) style.parts.set(part.partId, part);
        } else if (isList(c, "pttn")) {
            const pattern = parsePattern(buf, c);
            if (!pattern) continue;
            // A motif is a pattern with motif settings; the embellishment bit alone is not
            // reliable across authoring-tool versions.
            if (pattern.motifSettings || (pattern.embellishment & DMUS_EMBELLISHT_MOTIF)) style.motifs.push(pattern);
            else style.patterns.push(pattern);
        }
    }
    return style;
}
