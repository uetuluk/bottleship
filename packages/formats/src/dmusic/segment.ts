/**
 * DirectMusic segment (`RIFF DMSG`): a length, loop points, and a list of tracks. Each
 * track is one kind of timed data — tempo changes, groove/embellishment commands, the
 * style to play, the band to install, chords, or plain MIDI-like sequence events.
 */
import { type Band, parseBandAt } from "./band";
import { type ObjectIdentity, type ObjectReference, parseIdentity, parseReference } from "./reference";
import { type RiffChunk, dataView, guidString, isList, riffChunks, riffRoot } from "./riff";
import type { TimeSignature } from "./style";

export const CLSID_DirectMusicTempoTrack = "d2ac2885-b39b-11d1-8704-00600893b1bd";
export const CLSID_DirectMusicSeqTrack = "d2ac2886-b39b-11d1-8704-00600893b1bd";
export const CLSID_DirectMusicTimeSigTrack = "d2ac2888-b39b-11d1-8704-00600893b1bd";
export const CLSID_DirectMusicChordTrack = "d2ac288b-b39b-11d1-8704-00600893b1bd";
export const CLSID_DirectMusicCommandTrack = "d2ac288c-b39b-11d1-8704-00600893b1bd";
export const CLSID_DirectMusicStyleTrack = "d2ac288d-b39b-11d1-8704-00600893b1bd";
export const CLSID_DirectMusicMotifTrack = "d2ac288e-b39b-11d1-8704-00600893b1bd";
export const CLSID_DirectMusicBandTrack = "d2ac2894-b39b-11d1-8704-00600893b1bd";

export const DMUS_COMMANDT_GROOVE = 0;
export const DMUS_COMMANDT_FILL = 1;
export const DMUS_COMMANDT_INTRO = 2;
export const DMUS_COMMANDT_BREAK = 3;
export const DMUS_COMMANDT_END = 4;
export const DMUS_COMMANDT_ENDANDINTRO = 5;

/** DMUS_IO_SEGMENT_HEADER. */
export interface SegmentHeader {
    repeats: number;
    length: number;
    playStart: number;
    loopStart: number;
    /** Zero means the loop runs to the end of the segment. */
    loopEnd: number;
    /** DMUS_SEGF_* default start boundary. */
    resolution: number;
}

export interface TempoItem { time: number; tempo: number }
export interface TimeSigItem { time: number; timeSig: TimeSignature }
export interface StyleItem { time: number; style: ObjectReference }
export interface BandItem { time: number; band: Band }

/** DMUS_IO_COMMAND. */
export interface CommandItem {
    time: number;
    measure: number;
    beat: number;
    /** DMUS_COMMANDT_*. */
    command: number;
    grooveLevel: number;
    grooveRange: number;
}

/** DMUS_IO_SUBCHORD. */
export interface SubChord {
    chordPattern: number;
    scalePattern: number;
    inversionPoints: number;
    levels: number;
    chordRoot: number;
    scaleRoot: number;
}

export interface ChordItem {
    time: number;
    measure: number;
    beat: number;
    subChords: SubChord[];
}

/** DMUS_IO_SEQ_ITEM: one channel-voice MIDI event, with a duration when it is a note. */
export interface SeqItem {
    time: number;
    duration: number;
    pChannel: number;
    offset: number;
    status: number;
    byte1: number;
    byte2: number;
}

/** DMUS_IO_CURVE_ITEM. */
export interface SeqCurve {
    time: number;
    duration: number;
    resetDuration: number;
    pChannel: number;
    offset: number;
    startValue: number;
    endValue: number;
    resetValue: number;
    type: number;
    curveShape: number;
    ccData: number;
    flags: number;
}

interface TrackBase {
    classId: string;
    /** Track group bits (DMUS_IO_TRACK_HEADER.dwGroup). */
    group: number;
    position: number;
}

export type SegmentTrack = TrackBase & (
    | { kind: "tempo"; items: TempoItem[] }
    | { kind: "timesig"; items: TimeSigItem[] }
    | { kind: "command"; items: CommandItem[] }
    | { kind: "style"; items: StyleItem[] }
    | { kind: "band"; items: BandItem[] }
    | { kind: "chord"; root: number; scale: number; items: ChordItem[] }
    | { kind: "seq"; events: SeqItem[]; curves: SeqCurve[] }
    | { kind: "unknown" }
);

export interface Segment {
    identity: ObjectIdentity;
    header: SegmentHeader;
    tracks: SegmentTrack[];
}

/** An array chunk region: a DWORD element size, then elements of that size, from `o`. */
function* sizedArray(buf: Uint8Array, start: number, end: number, minSize: number): Generator<number> {
    if (end - start < 4) return;
    const size = dataView(buf).getUint32(start, true);
    if (size < minSize) return;
    for (let o = start + 4; o + size <= end; o += size) yield o;
}

function parseBandTrack(buf: Uint8Array, root: RiffChunk): BandItem[] {
    const view = dataView(buf);
    const items: BandItem[] = [];
    for (const c of riffChunks(buf, root.start, root.end)) {
        if (!isList(c, "lbdl")) continue;
        for (const entry of riffChunks(buf, c.start, c.end)) {
            if (!isList(entry, "lbnd")) continue;
            let time = 0;
            let band: Band | null = null;
            for (const e of riffChunks(buf, entry.start, entry.end)) {
                // bdih carries one time; bd2h a logical and a physical one, the physical last.
                if (e.id === "bdih" && e.end - e.start >= 4) time = view.getInt32(e.start, true);
                else if (e.id === "bd2h" && e.end - e.start >= 8) time = view.getInt32(e.start + 4, true);
                else if (isList(e, "DMBD")) band = parseBandAt(buf, e);
            }
            if (band) items.push({ time, band });
        }
    }
    return items;
}

function parseStyleTrack(buf: Uint8Array, list: RiffChunk): StyleItem[] {
    const view = dataView(buf);
    const items: StyleItem[] = [];
    for (const c of riffChunks(buf, list.start, list.end)) {
        if (!isList(c, "strf")) continue;
        let time = 0;
        let style: ObjectReference | null = null;
        for (const e of riffChunks(buf, c.start, c.end)) {
            if (e.id === "stmp" && e.end - e.start >= 4) time = view.getInt32(e.start, true);
            else if (isList(e, "DMRF")) style = parseReference(buf, e);
        }
        if (style) items.push({ time, style });
    }
    return items;
}

function parseChordTrack(buf: Uint8Array, list: RiffChunk): { root: number; scale: number; items: ChordItem[] } {
    const view = dataView(buf);
    const out = { root: 0, scale: 0, items: [] as ChordItem[] };
    for (const c of riffChunks(buf, list.start, list.end)) {
        if (c.id === "crdh" && c.end - c.start >= 4) {
            const header = view.getUint32(c.start, true);
            out.scale = header & 0xffffff;
            out.root = header >>> 24;
        } else if (c.id === "crdb" && c.end - c.start >= 4) {
            // DMUS_IO_CHORD (a 16-WCHAR name first), then a counted array of sub-chords.
            const chordSize = view.getUint32(c.start, true);
            let o = c.start + 4;
            if (chordSize < 39 || o + chordSize + 8 > c.end) continue;
            const item: ChordItem = {
                time: view.getInt32(o + 32, true),
                measure: view.getUint16(o + 36, true),
                beat: buf[o + 38]!,
                subChords: [],
            };
            o += chordSize;
            const count = view.getUint32(o, true);
            const subSize = view.getUint32(o + 4, true);
            o += 8;
            for (let i = 0; i < count && subSize >= 18 && o + subSize <= c.end; i++, o += subSize) {
                item.subChords.push({
                    chordPattern: view.getUint32(o, true),
                    scalePattern: view.getUint32(o + 4, true),
                    inversionPoints: view.getUint32(o + 8, true),
                    levels: view.getUint32(o + 12, true),
                    chordRoot: buf[o + 16]!,
                    scaleRoot: buf[o + 17]!,
                });
            }
            out.items.push(item);
        }
    }
    return out;
}

function parseSeqTrack(buf: Uint8Array, chunk: RiffChunk): { events: SeqItem[]; curves: SeqCurve[] } {
    const view = dataView(buf);
    const events: SeqItem[] = [];
    const curves: SeqCurve[] = [];
    for (const c of riffChunks(buf, chunk.start, chunk.end)) {
        if (c.id === "evtl") {
            for (const o of sizedArray(buf, c.start, c.end, 17)) {
                events.push({
                    time: view.getInt32(o, true),
                    duration: view.getInt32(o + 4, true),
                    pChannel: view.getUint32(o + 8, true),
                    offset: view.getInt16(o + 12, true),
                    status: buf[o + 14]!,
                    byte1: buf[o + 15]!,
                    byte2: buf[o + 16]!,
                });
            }
        } else if (c.id === "curl") {
            for (const o of sizedArray(buf, c.start, c.end, 28)) {
                curves.push({
                    time: view.getInt32(o, true),
                    duration: view.getInt32(o + 4, true),
                    resetDuration: view.getInt32(o + 8, true),
                    pChannel: view.getUint32(o + 12, true),
                    offset: view.getInt16(o + 16, true),
                    startValue: view.getInt16(o + 18, true),
                    endValue: view.getInt16(o + 20, true),
                    resetValue: view.getInt16(o + 22, true),
                    type: buf[o + 24]!,
                    curveShape: buf[o + 25]!,
                    ccData: buf[o + 26]!,
                    flags: buf[o + 27]!,
                });
            }
        }
    }
    return { events, curves };
}

function parseTrack(buf: Uint8Array, root: RiffChunk): SegmentTrack | null {
    const view = dataView(buf);
    let base: TrackBase | null = null;
    let track: SegmentTrack | null = null;
    for (const c of riffChunks(buf, root.start, root.end)) {
        if (c.id === "trkh" && c.end - c.start >= 24) {
            base = {
                classId: guidString(buf, c.start),
                position: view.getUint32(c.start + 16, true),
                group: view.getUint32(c.start + 20, true),
            };
            continue;
        }
        if (!base) continue;
        if (c.id === "tetr") {
            const items: TempoItem[] = [];
            for (const o of sizedArray(buf, c.start, c.end, 16)) {
                items.push({ time: view.getInt32(o, true), tempo: view.getFloat64(o + 8, true) });
            }
            track = { ...base, kind: "tempo", items };
        } else if (c.id === "tims") {
            const items: TimeSigItem[] = [];
            for (const o of sizedArray(buf, c.start, c.end, 8)) {
                items.push({
                    time: view.getInt32(o, true),
                    timeSig: { beatsPerMeasure: buf[o + 4]!, beat: buf[o + 5]!, gridsPerBeat: view.getUint16(o + 6, true) },
                });
            }
            track = { ...base, kind: "timesig", items };
        } else if (c.id === "cmnd") {
            const items: CommandItem[] = [];
            for (const o of sizedArray(buf, c.start, c.end, 10)) {
                items.push({
                    time: view.getInt32(o, true),
                    measure: view.getUint16(o + 4, true),
                    beat: buf[o + 6]!,
                    command: buf[o + 7]!,
                    grooveLevel: buf[o + 8]!,
                    grooveRange: buf[o + 9]!,
                });
            }
            track = { ...base, kind: "command", items };
        } else if (isList(c, "sttr")) {
            track = { ...base, kind: "style", items: parseStyleTrack(buf, c) };
        } else if (isList(c, "DMBT")) {
            track = { ...base, kind: "band", items: parseBandTrack(buf, c) };
        } else if (isList(c, "cord")) {
            track = { ...base, kind: "chord", ...parseChordTrack(buf, c) };
        } else if (c.id === "seqt") {
            track = { ...base, kind: "seq", ...parseSeqTrack(buf, c) };
        }
    }
    return track ?? (base ? { ...base, kind: "unknown" } : null);
}

export function parseSegment(buf: Uint8Array): Segment | null {
    const root = riffRoot(buf, "DMSG");
    if (!root) return null;
    const view = dataView(buf);
    const segment: Segment = {
        identity: parseIdentity(buf, root),
        header: { repeats: 0, length: 0, playStart: 0, loopStart: 0, loopEnd: 0, resolution: 0 },
        tracks: [],
    };
    for (const c of riffChunks(buf, root.start, root.end)) {
        if (c.id === "segh" && c.end - c.start >= 24) {
            const o = c.start;
            segment.header = {
                repeats: view.getUint32(o, true),
                length: view.getInt32(o + 4, true),
                playStart: view.getInt32(o + 8, true),
                loopStart: view.getInt32(o + 12, true),
                loopEnd: view.getInt32(o + 16, true),
                resolution: view.getUint32(o + 20, true),
            };
        } else if (isList(c, "trkl")) {
            for (const t of riffChunks(buf, c.start, c.end)) {
                if (!isList(t, "DMTK")) continue;
                const track = parseTrack(buf, t);
                if (track) segment.tracks.push(track);
            }
        }
    }
    return segment;
}
