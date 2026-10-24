/**
 * DirectMusic band (`RIFF DMBD`): the instrument assigned to each performance channel,
 * with its volume, pan, transposition, and the DLS collection the patch comes from.
 * A band stands alone in a `.bnd` file, sits inside a style, or rides a segment's band track.
 */
import { type ObjectIdentity, type ObjectReference, parseIdentity, parseReference } from "./reference";
import { type RiffChunk, dataView, isList, riffChunks, riffRoot } from "./riff";

export const DMUS_IO_INST_PATCH = 1 << 0;
export const DMUS_IO_INST_BANKSELECT = 1 << 1;
export const DMUS_IO_INST_ASSIGN_PATCH = 1 << 3;
export const DMUS_IO_INST_NOTERANGES = 1 << 4;
export const DMUS_IO_INST_PAN = 1 << 5;
export const DMUS_IO_INST_VOLUME = 1 << 6;
export const DMUS_IO_INST_TRANSPOSE = 1 << 7;
export const DMUS_IO_INST_GM = 1 << 8;
export const DMUS_IO_INST_GS = 1 << 9;
export const DMUS_IO_INST_XG = 1 << 10;
export const DMUS_IO_INST_CHANNEL_PRIORITY = 1 << 11;
export const DMUS_IO_INST_USE_DEFAULT_GM_SET = 1 << 12;
export const DMUS_IO_INST_PITCHBENDRANGE = 1 << 13;

/** DMUS_IO_INSTRUMENT, with the collection reference that follows it. */
export interface BandInstrument {
    /** MIDI patch: program in bits 0-6, bank LSB in 8-14, bank MSB in 16-22, drum flag in 31. */
    patch: number;
    assignPatch: number;
    noteRanges: [number, number, number, number];
    pChannel: number;
    /** DMUS_IO_INST_* — which of the fields below the band actually sets. */
    flags: number;
    pan: number;
    volume: number;
    transpose: number;
    channelPriority: number;
    pitchBendRange: number;
    /** The DLS collection holding the patch; null selects the default (GM) collection. */
    collection: ObjectReference | null;
}

export interface Band {
    identity: ObjectIdentity;
    instruments: BandInstrument[];
}

function parseInstrument(buf: Uint8Array, list: RiffChunk): BandInstrument | null {
    const view = dataView(buf);
    let inst: BandInstrument | null = null;
    let collection: ObjectReference | null = null;
    for (const c of riffChunks(buf, list.start, list.end)) {
        const size = c.end - c.start;
        if (c.id === "bins" && size >= 36) {
            const o = c.start;
            inst = {
                patch: view.getUint32(o, true),
                assignPatch: view.getUint32(o + 4, true),
                noteRanges: [
                    view.getUint32(o + 8, true), view.getUint32(o + 12, true),
                    view.getUint32(o + 16, true), view.getUint32(o + 20, true),
                ],
                pChannel: view.getUint32(o + 24, true),
                flags: view.getUint32(o + 28, true),
                pan: buf[o + 32]!,
                volume: buf[o + 33]!,
                transpose: view.getInt16(o + 34, true),
                channelPriority: size >= 40 ? view.getUint32(o + 36, true) : 0,
                pitchBendRange: size >= 42 ? view.getInt16(o + 40, true) : 0,
                collection: null,
            };
        } else if (isList(c, "DMRF")) {
            collection = parseReference(buf, c);
        }
    }
    if (inst) inst.collection = collection;
    return inst;
}

/** Parse the contents of a `DMBD` container found at `root`. */
export function parseBandAt(buf: Uint8Array, root: RiffChunk): Band {
    const band: Band = { identity: parseIdentity(buf, root), instruments: [] };
    for (const c of riffChunks(buf, root.start, root.end)) {
        if (!isList(c, "lbil")) continue;
        for (const item of riffChunks(buf, c.start, c.end)) {
            if (!isList(item, "lbin")) continue;
            const inst = parseInstrument(buf, item);
            if (inst) band.instruments.push(inst);
        }
    }
    return band;
}

export function parseBand(buf: Uint8Array): Band | null {
    const root = riffRoot(buf, "DMBD");
    return root ? parseBandAt(buf, root) : null;
}
