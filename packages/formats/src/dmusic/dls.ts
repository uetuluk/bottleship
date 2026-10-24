/**
 * Downloadable Sounds collection (`RIFF DLS `), level 1: instruments made of key/velocity
 * regions, each pointing at a PCM wave in the collection's wave pool, with articulation
 * (envelopes, LFO, controller routings) given as a list of connection blocks.
 */
import { type ObjectIdentity, parseIdentity } from "./reference";
import { type RiffChunk, dataView, isList, riffChunks, riffRoot } from "./riff";

export const F_INSTRUMENT_DRUMS = 0x80000000;

export const CONN_SRC_NONE = 0x0000;
export const CONN_SRC_LFO = 0x0001;
export const CONN_SRC_KEYONVELOCITY = 0x0002;
export const CONN_SRC_KEYNUMBER = 0x0003;
export const CONN_SRC_EG1 = 0x0004;
export const CONN_SRC_EG2 = 0x0005;
export const CONN_SRC_PITCHWHEEL = 0x0006;
export const CONN_SRC_CC1 = 0x0081;
export const CONN_SRC_CC7 = 0x0087;
export const CONN_SRC_CC10 = 0x008a;
export const CONN_SRC_CC11 = 0x008b;

export const CONN_DST_NONE = 0x0000;
export const CONN_DST_ATTENUATION = 0x0001;
export const CONN_DST_PITCH = 0x0003;
export const CONN_DST_PAN = 0x0004;
export const CONN_DST_LFO_FREQUENCY = 0x0104;
export const CONN_DST_LFO_STARTDELAY = 0x0105;
export const CONN_DST_EG1_ATTACKTIME = 0x0206;
export const CONN_DST_EG1_DECAYTIME = 0x0207;
export const CONN_DST_EG1_RELEASETIME = 0x0209;
export const CONN_DST_EG1_SUSTAINLEVEL = 0x020a;
export const CONN_DST_EG2_ATTACKTIME = 0x030a;
export const CONN_DST_EG2_DECAYTIME = 0x030b;
export const CONN_DST_EG2_RELEASETIME = 0x030d;
export const CONN_DST_EG2_SUSTAINLEVEL = 0x030e;

export const WLOOP_TYPE_FORWARD = 0;
export const F_RGN_OPTION_SELFNONEXCLUSIVE = 0x0001;

/** CONNECTION: `source` (scaled by `control`) drives `destination` by `scale`. */
export interface DlsConnection {
    source: number;
    control: number;
    destination: number;
    transform: number;
    /** 16.16 fixed point in the destination's unit (time cents, pitch cents, 0.1% steps, dB/10). */
    scale: number;
}

/** WSMPL: how a wave maps to pitch and whether it loops. */
export interface DlsWaveSample {
    unityNote: number;
    /** Cents. */
    fineTune: number;
    /** 16.16 fixed-point tenths of a decibel; negative is quieter. */
    attenuation: number;
    options: number;
    loop: { type: number; start: number; length: number } | null;
}

export interface DlsRegion {
    keyLow: number;
    keyHigh: number;
    velocityLow: number;
    velocityHigh: number;
    options: number;
    keyGroup: number;
    /** The region's own sample setup; when absent the wave's applies. */
    sample: DlsWaveSample | null;
    /** Index into the pool cue table. */
    waveIndex: number;
    articulation: DlsConnection[];
}

export interface DlsInstrument {
    /** Bank MSB in bits 8-14, LSB in 0-6, F_INSTRUMENT_DRUMS in bit 31. */
    bank: number;
    program: number;
    name: string;
    regions: DlsRegion[];
    /** Instrument-wide articulation, used by a region that carries none. */
    articulation: DlsConnection[];
}

export interface DlsWave {
    formatTag: number;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
    /** The PCM bytes, a view into the collection buffer. */
    data: Uint8Array;
    sample: DlsWaveSample | null;
}

export interface DlsCollection {
    identity: ObjectIdentity;
    instruments: DlsInstrument[];
    /** Waves by cue-table index (the order regions refer to them in). */
    waves: Array<DlsWave | null>;
}

function parseWaveSample(buf: Uint8Array, c: RiffChunk): DlsWaveSample | null {
    if (c.end - c.start < 20) return null;
    const view = dataView(buf);
    const o = c.start;
    const headerSize = view.getUint32(o, true);
    const loops = view.getUint32(o + 16, true);
    const sample: DlsWaveSample = {
        unityNote: view.getUint16(o + 4, true),
        fineTune: view.getInt16(o + 6, true),
        attenuation: view.getInt32(o + 8, true),
        options: view.getUint32(o + 12, true),
        loop: null,
    };
    const lo = o + headerSize;
    if (loops > 0 && lo + 16 <= c.end) {
        sample.loop = {
            type: view.getUint32(lo + 4, true),
            start: view.getUint32(lo + 8, true),
            length: view.getUint32(lo + 12, true),
        };
    }
    return sample;
}

function parseArticulation(buf: Uint8Array, list: RiffChunk): DlsConnection[] {
    const view = dataView(buf);
    const out: DlsConnection[] = [];
    for (const c of riffChunks(buf, list.start, list.end)) {
        if (c.id !== "art1" || c.end - c.start < 8) continue;
        const headerSize = view.getUint32(c.start, true);
        const count = view.getUint32(c.start + 4, true);
        let o = c.start + headerSize;
        for (let i = 0; i < count && o + 12 <= c.end; i++, o += 12) {
            out.push({
                source: view.getUint16(o, true),
                control: view.getUint16(o + 2, true),
                destination: view.getUint16(o + 4, true),
                transform: view.getUint16(o + 6, true),
                scale: view.getInt32(o + 8, true),
            });
        }
    }
    return out;
}

function parseRegion(buf: Uint8Array, list: RiffChunk): DlsRegion | null {
    const view = dataView(buf);
    let region: DlsRegion | null = null;
    let sample: DlsWaveSample | null = null;
    let waveIndex = -1;
    let articulation: DlsConnection[] = [];
    for (const c of riffChunks(buf, list.start, list.end)) {
        const size = c.end - c.start;
        if (c.id === "rgnh" && size >= 12) {
            const o = c.start;
            region = {
                keyLow: view.getUint16(o, true), keyHigh: view.getUint16(o + 2, true),
                velocityLow: view.getUint16(o + 4, true), velocityHigh: view.getUint16(o + 6, true),
                options: view.getUint16(o + 8, true), keyGroup: view.getUint16(o + 10, true),
                sample: null, waveIndex: -1, articulation: [],
            };
        } else if (c.id === "wsmp") {
            sample = parseWaveSample(buf, c);
        } else if (c.id === "wlnk" && size >= 12) {
            waveIndex = view.getUint32(c.start + 8, true);
        } else if (isList(c, "lart")) {
            articulation = parseArticulation(buf, c);
        }
    }
    if (!region) return null;
    region.sample = sample;
    region.waveIndex = waveIndex;
    region.articulation = articulation;
    return region;
}

function infoName(buf: Uint8Array, list: RiffChunk): string {
    for (const c of riffChunks(buf, list.start, list.end)) {
        if (c.id !== "INAM") continue;
        let out = "";
        for (let o = c.start; o < c.end && buf[o] !== 0; o++) out += String.fromCharCode(buf[o]!);
        return out;
    }
    return "";
}

function parseInstrument(buf: Uint8Array, list: RiffChunk): DlsInstrument | null {
    const view = dataView(buf);
    let inst: DlsInstrument | null = null;
    const regions: DlsRegion[] = [];
    let articulation: DlsConnection[] = [];
    let name = "";
    for (const c of riffChunks(buf, list.start, list.end)) {
        if (c.id === "insh" && c.end - c.start >= 12) {
            inst = {
                bank: view.getUint32(c.start + 4, true),
                program: view.getUint32(c.start + 8, true),
                name: "", regions, articulation: [],
            };
        } else if (isList(c, "lrgn")) {
            for (const r of riffChunks(buf, c.start, c.end)) {
                if (!isList(r, "rgn ")) continue;
                const region = parseRegion(buf, r);
                if (region) regions.push(region);
            }
        } else if (isList(c, "lart")) {
            articulation = parseArticulation(buf, c);
        } else if (isList(c, "INFO")) {
            name = infoName(buf, c);
        }
    }
    if (!inst) return null;
    inst.articulation = articulation;
    inst.name = name;
    return inst;
}

function parseWave(buf: Uint8Array, list: RiffChunk): DlsWave | null {
    const view = dataView(buf);
    let wave: DlsWave | null = null;
    let data: Uint8Array | null = null;
    let sample: DlsWaveSample | null = null;
    for (const c of riffChunks(buf, list.start, list.end)) {
        if (c.id === "fmt " && c.end - c.start >= 16) {
            const o = c.start;
            wave = {
                formatTag: view.getUint16(o, true),
                channels: view.getUint16(o + 2, true),
                sampleRate: view.getUint32(o + 4, true),
                bitsPerSample: view.getUint16(o + 14, true),
                data: new Uint8Array(0), sample: null,
            };
        } else if (c.id === "data") {
            data = buf.subarray(c.start, c.end);
        } else if (c.id === "wsmp") {
            sample = parseWaveSample(buf, c);
        }
    }
    if (!wave || !data) return null;
    wave.data = data;
    wave.sample = sample;
    return wave;
}

export function parseDls(buf: Uint8Array): DlsCollection | null {
    const root = riffRoot(buf, "DLS ");
    if (!root) return null;
    const view = dataView(buf);
    const collection: DlsCollection = { identity: parseIdentity(buf, root), instruments: [], waves: [] };
    let cues: number[] = [];
    let pool: RiffChunk | null = null;
    for (const c of riffChunks(buf, root.start, root.end)) {
        if (c.id === "dlid" && c.end - c.start >= 16 && !collection.identity.objectId) {
            // A DLS collection names itself with `dlid`; the DirectMusic `guid` chunk is absent.
            const hex = (i: number): string => buf[c.start + i]!.toString(16).padStart(2, "0");
            collection.identity.objectId =
                `${hex(3)}${hex(2)}${hex(1)}${hex(0)}-${hex(5)}${hex(4)}-${hex(7)}${hex(6)}-${hex(8)}${hex(9)}-` +
                `${hex(10)}${hex(11)}${hex(12)}${hex(13)}${hex(14)}${hex(15)}`;
        } else if (isList(c, "lins")) {
            for (const i of riffChunks(buf, c.start, c.end)) {
                if (!isList(i, "ins ")) continue;
                const inst = parseInstrument(buf, i);
                if (inst) collection.instruments.push(inst);
            }
        } else if (c.id === "ptbl" && c.end - c.start >= 8) {
            const headerSize = view.getUint32(c.start, true);
            const count = view.getUint32(c.start + 4, true);
            cues = [];
            for (let i = 0, o = c.start + headerSize; i < count && o + 4 <= c.end; i++, o += 4) {
                cues.push(view.getUint32(o, true));
            }
        } else if (isList(c, "wvpl")) {
            pool = c;
        } else if (isList(c, "INFO") && !collection.identity.name) {
            collection.identity.name = infoName(buf, c);
        }
    }
    if (pool) {
        // A cue is the offset of a wave's LIST header from the start of the pool data.
        const byOffset = new Map<number, DlsWave | null>();
        for (const w of riffChunks(buf, pool.start, pool.end)) {
            if (isList(w, "wave")) byOffset.set(w.start - 12 - pool.start, parseWave(buf, w));
        }
        collection.waves = cues.map((offset) => byOffset.get(offset) ?? null);
    }
    return collection;
}
