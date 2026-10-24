/**
 * The DirectMusic file parsers, against files built chunk by chunk here: what each
 * structure's fields are, which optional tails a later format version adds, and that a
 * reference to another object survives with enough to resolve it.
 */
import { describe, expect, test } from "bun:test";
import { DMUS_IO_INST_PATCH, DMUS_IO_INST_VOLUME, parseBand } from "../../packages/formats/src/dmusic/band";
import { parseDls } from "../../packages/formats/src/dmusic/dls";
import { DMUS_OBJ_CLASS, DMUS_OBJ_FILENAME, DMUS_OBJ_OBJECT } from "../../packages/formats/src/dmusic/reference";
import { riffChunks, riffRoot } from "../../packages/formats/src/dmusic/riff";
import { CLSID_DirectMusicTempoTrack, parseSegment } from "../../packages/formats/src/dmusic/segment";
import { parseStyle, ticksPerBeat, ticksPerGrid, ticksPerMeasure } from "../../packages/formats/src/dmusic/style";
import {
    ascii, bandChunks, bytes, chunk, f64, guid, i16, i32, list, reference, riff, u16, u32, u8, wide,
} from "./dmusic-fixtures";

const CLSID_STYLE = "d2ac288a-b39b-11d1-8704-00600893b1bd";
const PART_ID = "0e54d502-1111-2222-3344-556677889900";

describe("riff", () => {
    test("walks padded chunks and stops at a truncated tail", () => {
        const file = riff("TEST", chunk("odd ", [1, 2, 3]), chunk("even", [4, 5]), list("sub ", chunk("leaf", [6])));
        const root = riffRoot(file, "TEST")!;
        expect([...riffChunks(file, root.start, root.end)].map((c) => `${c.id}:${c.type}:${c.end - c.start}`))
            .toEqual(["odd ::3", "even::2", "LIST:sub :10"]);
        expect(riffRoot(file, "ELSE")).toBeNull();
        // Half a chunk header is the end of the walk, not a chunk.
        const cut = file.subarray(0, file.length - 13);
        expect([...riffChunks(cut, 12, cut.length)].map((c) => c.id)).toEqual(["odd ", "even"]);
    });
});

describe("band", () => {
    test("instruments with their collection references", () => {
        const band = parseBand(riff("DMBD", chunk("guid", guid(PART_ID)), ...bandChunks("Brass", [
            { patch: 0x0119, pChannel: 3, flags: DMUS_IO_INST_PATCH | DMUS_IO_INST_VOLUME, volume: 90, pan: 20, transpose: -12, collection: "Kit.dls" },
            { patch: 0x80000000, pChannel: 9, flags: DMUS_IO_INST_PATCH },
        ])))!;
        expect(band.identity).toMatchObject({ name: "Brass", objectId: PART_ID });
        expect(band.instruments).toHaveLength(2);
        expect(band.instruments[0]).toMatchObject({ patch: 0x119, pChannel: 3, volume: 90, pan: 20, transpose: -12 });
        expect(band.instruments[0]!.collection).toMatchObject({
            fileName: "Kit.dls", validData: DMUS_OBJ_CLASS | DMUS_OBJ_FILENAME,
        });
        // No reference: the instrument comes from the default collection.
        expect(band.instruments[1]!.collection).toBeNull();
        expect(band.instruments[1]!.patch >>> 0).toBe(0x80000000);
    });

    test("something that is not a band is not parsed as an empty one", () => {
        expect(parseBand(riff("DMST"))).toBeNull();
    });
});

function stylePart(measures: number, notes: Uint8Array, curves?: Uint8Array): Uint8Array {
    const choices = new Uint32Array(32).fill(0x20000000);
    choices[0] = 0x3fffffff;
    return list("part",
        chunk("prth", u8(4, 4), u16(2), new Uint8Array(choices.buffer), guid(PART_ID), u16(measures), u8(14, 0, 0), u8(0, 0, 0)),
        chunk("note", notes),
        ...(curves ? [chunk("crve", curves)] : []));
}

describe("style", () => {
    const note = bytes(i32(4), u32(1), i32(192), i16(-6), u16(0x3110), u8(100, 0, 0, 0, 0, 14), u8(0, 0));
    const curve = bytes(i32(0), u32(1), i32(0), i32(0), i16(0), i16(0), i16(127), i16(0), u8(4, 1, 7, 0));
    const style = parseStyle(riff("DMST",
        chunk("styh", u8(3, 4), u16(4), u32(0), f64(96)),
        chunk("guid", guid(PART_ID)),
        list("DMBD", ...bandChunks("Default", [{ patch: 5, pChannel: 0, flags: DMUS_IO_INST_PATCH }])),
        stylePart(2, bytes(u32(24), note), bytes(u32(28), curve)),
        list("pttn",
            chunk("ptnh", u8(3, 4), u16(4), u8(10, 20), u16(0), u16(4)),
            chunk("rhtm", u32(1, 0, 0, 0)),
            list("UNFO", chunk("UNAM", wide("Verse"))),
            list("pref", chunk("prfc", guid(PART_ID), u16(7), u8(2, 1, 100, 1), u16(0), u32(7)))),
        list("pttn",
            chunk("ptnh", u8(3, 4), u16(4), u8(1, 100), u16(8), u16(1)),
            list("UNFO", chunk("UNAM", wide("Ending")))),
        list("pttn",
            chunk("ptnh", u8(3, 4), u16(4), u8(1, 100), u16(0), u16(1)),
            chunk("mtfs", u32(2), i32(0, 0, 2304), u32(0x1000)),
            list("UNFO", chunk("UNAM", wide("Sting"))))))!;

    test("header, parts and their events", () => {
        expect(style.timeSig).toEqual({ beatsPerMeasure: 3, beat: 4, gridsPerBeat: 4 });
        expect(style.tempo).toBe(96);
        expect(style.bands.map((b) => b.identity.name)).toEqual(["Default"]);
        const part = style.parts.get(PART_ID)!;
        expect(part).toMatchObject({ measures: 2, playModeFlags: 14 });
        expect(part.timeSig).toEqual({ beatsPerMeasure: 4, beat: 4, gridsPerBeat: 2 });
        expect(part.variationChoices.slice(0, 2)).toEqual([0x3fffffff, 0x20000000]);
        expect(part.notes).toEqual([{
            gridStart: 4, variation: 1, duration: 192, timeOffset: -6, musicValue: 0x3110, velocity: 100,
            timeRange: 0, durRange: 0, velRange: 0, inversionId: 0, playModeFlags: 14,
        }]);
        expect(part.curves[0]).toMatchObject({ eventType: 4, curveShape: 1, ccData: 7, endValue: 127 });
    });

    test("patterns are kept apart from motifs", () => {
        expect(style.patterns.map((p) => p.name)).toEqual(["Verse", "Ending"]);
        expect(style.patterns[0]).toMatchObject({ grooveBottom: 10, grooveTop: 20, embellishment: 0, measures: 4 });
        expect(style.patterns[0]!.partRefs[0]).toMatchObject({
            partId: PART_ID, pChannel: 7, variationLockId: 2, subChordLevel: 1, randomVariation: 1,
        });
        expect(style.patterns[1]!.embellishment).toBe(8);
        expect(style.motifs.map((m) => m.name)).toEqual(["Sting"]);
        expect(style.motifs[0]!.motifSettings).toEqual({
            repeats: 2, playStart: 0, loopStart: 0, loopEnd: 2304, resolution: 0x1000,
        });
    });

    test("a part reference without the channel field falls back to its logical part id", () => {
        const old = parseStyle(riff("DMST", list("pttn",
            chunk("ptnh", u8(4, 4), u16(4), u8(1, 100), u16(0), u16(1)),
            list("pref", chunk("prfc", guid(PART_ID), u16(5), u8(0, 0, 0, 0))))))!;
        expect(old.patterns[0]!.partRefs[0]!.pChannel).toBe(5);
    });

    test("tick arithmetic follows the time signature", () => {
        expect(ticksPerBeat({ beatsPerMeasure: 4, beat: 4, gridsPerBeat: 4 })).toBe(768);
        expect(ticksPerGrid({ beatsPerMeasure: 4, beat: 4, gridsPerBeat: 2 })).toBe(384);
        expect(ticksPerMeasure({ beatsPerMeasure: 6, beat: 8, gridsPerBeat: 2 })).toBe(2304);
    });
});

function track(classId: string, group: number, ...body: Uint8Array[]): Uint8Array {
    return riff("DMTK", chunk("trkh", guid(classId), u32(0, group), ascii("xxxx"), u32(0)), ...body);
}

describe("segment", () => {
    const segment = parseSegment(riff("DMSG",
        chunk("segh", u32(99), i32(12288, 3072, 3072, 9216), u32(0x2000)),
        chunk("guid", guid(PART_ID)),
        list("UNFO", chunk("UNAM", wide("Race"))),
        list("trkl",
            track(CLSID_DirectMusicTempoTrack, 0xffffffff, chunk("tetr", u32(16), i32(0), u32(0), f64(140), i32(768), u32(0), f64(135.5))),
            track("d2ac288c-b39b-11d1-8704-00600893b1bd", 1,
                chunk("cmnd", u32(12), i32(0), u16(0), u8(0, 0, 13, 0), u16(0), i32(12288), u16(4), u8(0, 4, 56, 2), u16(0))),
            track("d2ac288d-b39b-11d1-8704-00600893b1bd", 1,
                list("sttr", list("strf", chunk("stmp", i32(0)), reference(CLSID_STYLE, "Race.sty", PART_ID)))),
            track("d2ac2894-b39b-11d1-8704-00600893b1bd", 1,
                riff("DMBT", list("lbdl", list("lbnd", chunk("bdih", i32(3072)),
                    riff("DMBD", ...bandChunks("Second", [{ patch: 1, pChannel: 2, flags: DMUS_IO_INST_PATCH }])))))),
            track("00000000-0000-0000-0000-000000000001", 1, chunk("????", [1, 2])))))!;

    test("header and identity", () => {
        expect(segment.identity).toMatchObject({ name: "Race", objectId: PART_ID });
        expect(segment.header).toEqual({
            repeats: 99, length: 12288, playStart: 3072, loopStart: 3072, loopEnd: 9216, resolution: 0x2000,
        });
    });

    test("each track kind", () => {
        const [tempo, command, style, band, unknown] = segment.tracks;
        expect(tempo).toMatchObject({ kind: "tempo", group: 0xffffffff, items: [{ time: 0, tempo: 140 }, { time: 768, tempo: 135.5 }] });
        expect(command).toMatchObject({
            kind: "command", items: [
                { measure: 0, beat: 0, command: 0, grooveLevel: 13, grooveRange: 0 },
                { measure: 4, beat: 0, command: 4, grooveLevel: 56, grooveRange: 2 },
            ],
        });
        expect(style!.kind).toBe("style");
        if (style!.kind === "style") {
            expect(style.items[0]!.style).toMatchObject({
                fileName: "Race.sty", classId: CLSID_STYLE, objectId: PART_ID,
                validData: DMUS_OBJ_CLASS | DMUS_OBJ_OBJECT | DMUS_OBJ_FILENAME,
            });
        }
        expect(band).toMatchObject({ kind: "band", items: [{ time: 3072 }] });
        if (band!.kind === "band") expect(band.items[0]!.band.identity.name).toBe("Second");
        // A track we have no reader for is still listed, so GetTrack can count it.
        expect(unknown!.kind).toBe("unknown");
    });
});

describe("dls", () => {
    const pcm = i16(0, 1000, -1000, 32767, -32768, 5);
    const wave = (unity: number): Uint8Array => list("wave",
        chunk("fmt ", u16(1, 1), u32(22050, 44100), u16(2, 16)),
        chunk("wsmp", u32(20), u16(unity), i16(-3), i32(-655360), u32(0, 1), u32(16, 0, 2, 3)),
        chunk("data", pcm));
    const first = wave(60);
    const second = wave(72);
    const collection = parseDls(riff("DLS ",
        chunk("colh", u32(1)),
        chunk("dlid", guid(PART_ID)),
        list("lins", list("ins ",
            chunk("insh", u32(2, 0x80000101, 25)),
            list("lrgn",
                list("rgn ",
                    chunk("rgnh", u16(0, 59, 0, 127, 1, 3)),
                    chunk("wlnk", u16(0, 0), u32(1, 1)),
                    list("lart", chunk("art1", u32(8, 1), u16(0, 0, 0x209, 0), i32(1200 * 65536)))),
                list("rgn ",
                    chunk("rgnh", u16(60, 127, 0, 127, 0, 0)),
                    chunk("wsmp", u32(20), u16(64), i16(0), i32(0), u32(0, 0)),
                    chunk("wlnk", u16(0, 0), u32(1, 0)))),
            list("lart", chunk("art1", u32(8, 1), u16(0, 0, 0x206, 0), i32(-0x80000000))),
            list("INFO", chunk("INAM", ascii("Kit\0"))))),
        chunk("ptbl", u32(8, 2), u32(0, first.length)),
        list("wvpl", first, second)))!;

    test("instruments, regions and articulation", () => {
        expect(collection.identity.objectId).toBe(PART_ID);
        const inst = collection.instruments[0]!;
        expect(inst).toMatchObject({ program: 25, name: "Kit" });
        expect(inst.bank >>> 0).toBe(0x80000101);
        expect(inst.regions[0]).toMatchObject({ keyLow: 0, keyHigh: 59, options: 1, keyGroup: 3, waveIndex: 1 });
        expect(inst.regions[0]!.articulation).toEqual([
            { source: 0, control: 0, destination: 0x209, transform: 0, scale: 1200 * 65536 },
        ]);
        // The second region overrides the wave's sample setup and carries no articulation.
        expect(inst.regions[1]!.sample).toMatchObject({ unityNote: 64, loop: null });
        expect(inst.regions[1]!.articulation).toEqual([]);
        expect(inst.articulation[0]!.scale).toBe(-0x80000000);
    });

    test("waves are indexed by the cue table, not by their order in the pool", () => {
        expect(collection.waves.map((w) => w?.sample?.unityNote)).toEqual([60, 72]);
        const w = collection.waves[0]!;
        expect(w).toMatchObject({ formatTag: 1, channels: 1, sampleRate: 22050, bitsPerSample: 16 });
        expect(w.data.length).toBe(12);
        expect(w.sample).toMatchObject({ fineTune: -3, attenuation: -655360, loop: { type: 0, start: 2, length: 3 } });
    });

    test("a cue that points at no wave leaves a hole instead of shifting the rest", () => {
        const holed = parseDls(riff("DLS ", chunk("ptbl", u32(8, 2), u32(4, 0)), list("wvpl", first)))!;
        expect(holed.waves.map((w) => w !== null)).toEqual([false, true]);
    });
});
