/**
 * The performance, observed through the notes it hands the synthesizer: which pattern a
 * groove command selects and for how long, how segments loop, queue and replace each
 * other, and what a band, a tempo or a transition changes.
 */
import { describe, expect, test } from "bun:test";
import type { Band } from "../../packages/formats/src/dmusic/band";
import type { DlsCollection } from "../../packages/formats/src/dmusic/dls";
import type { PartRef, Style, StyleNote, StylePart, StylePattern, TimeSignature } from "../../packages/formats/src/dmusic/style";
import {
    DMUS_COMPOSEF_BEAT, DMUS_COMPOSEF_MEASURE, DMUS_NOTIFICATION_SEGABORT, DMUS_NOTIFICATION_SEGEND,
    DMUS_NOTIFICATION_SEGLOOP, DMUS_NOTIFICATION_SEGSTART, DMUS_SEGF_BEAT, DMUS_SEGF_MEASURE, DMUS_SEGF_QUEUE,
    DMUS_SEGF_SECONDARY, PerfSegment, Performance,
} from "../../src/worker/core/audio/directmusic/performance";
import type { DlsSynth } from "../../src/worker/core/audio/directmusic/synth";

/** Ten frames per tick at 120 bpm, so a frame count reads directly as music time. */
const RATE = 15360;
const MEASURE = 3072;
const BEAT = 768;
const SIG: TimeSignature = { beatsPerMeasure: 4, beat: 4, gridsPerBeat: 4 };
const ENABLED = 0x3fffffff;
const DISABLED = 0x20000000;
const NORMAL_CHORD = 14;

interface Heard { tick: number; channel: number; key: number; velocity?: number }

class RecordingSynth {
    sampleRate = RATE;
    frame = 0;
    on: Heard[] = [];
    off: Heard[] = [];
    log: string[] = [];
    private tick(): number { return Math.round(this.frame / 10); }
    render(_l: Float32Array, _r: Float32Array, _offset: number, count: number): void { this.frame += count; }
    noteOn(channel: number, key: number, velocity: number): void { this.on.push({ tick: this.tick(), channel, key, velocity }); }
    noteOff(channel: number, key: number): void { this.off.push({ tick: this.tick(), channel, key }); }
    controlChange(channel: number, cc: number, value: number): void { this.log.push(`cc${cc} ch${channel}=${value}`); }
    pitchBend(channel: number, value: number): void { this.log.push(`bend ch${channel}=${value}`); }
    setInstrument(channel: number, collection: DlsCollection | null, patch: number): boolean {
        this.log.push(`patch ch${channel}=${patch.toString(16)}${collection ? "" : " (default)"}`);
        return true;
    }
    allNotesOff(): void { this.log.push("allNotesOff"); }
}

function setup(): { synth: RecordingSynth; perf: Performance; notifications: string[]; run: (ticks: number) => void } {
    const synth = new RecordingSynth();
    const perf = new Performance(synth as unknown as DlsSynth);
    perf.random = () => 0;
    const notifications: string[] = [];
    const names: Record<number, string> = {
        [DMUS_NOTIFICATION_SEGSTART]: "start", [DMUS_NOTIFICATION_SEGEND]: "end",
        [DMUS_NOTIFICATION_SEGLOOP]: "loop", [DMUS_NOTIFICATION_SEGABORT]: "abort",
    };
    perf.onNotification = (type, state, time) => notifications.push(`${names[type]}@${Math.round(time)}${state.primary ? "" : " secondary"}`);
    const scratch = new Float32Array(4096);
    const run = (ticks: number): void => {
        for (let frames = Math.round(ticks * 10); frames > 0;) {
            const n = Math.min(scratch.length, frames);
            perf.render(scratch, scratch, n);
            frames -= n;
        }
    };
    return { synth, perf, notifications, run };
}

let nextId = 0;
/** A part holding `notes` as [grid, key in octave 3 as a semitone, variation mask]. */
function part(measures: number, notes: Array<[number, number, number?]>, choices: number[] = [ENABLED]): StylePart {
    const SPELL = [0x000, 0x001, 0x010, 0x10f, 0x100, 0x110, 0x20f, 0x200, 0x201, 0x210, 0x30f, 0x300];
    const variationChoices = new Array<number>(32).fill(DISABLED);
    choices.forEach((c, i) => { variationChoices[i] = c; });
    return {
        timeSig: SIG, variationChoices, partId: `part-${nextId++}`, measures,
        playModeFlags: NORMAL_CHORD, invertUpper: 0, invertLower: 0, curves: [],
        notes: notes.map(([grid, semitone, mask]): StyleNote => ({
            gridStart: grid, variation: mask ?? 1, duration: 100, timeOffset: 0,
            musicValue: (3 + Math.floor(semitone / 12)) << 12 | SPELL[semitone % 12]!,
            velocity: 100, timeRange: 0, durRange: 0, velRange: 0, inversionId: 0, playModeFlags: NORMAL_CHORD,
        })),
    };
}

function ref(p: StylePart, pChannel = 0, extra: Partial<PartRef> = {}): PartRef {
    return {
        partId: p.partId, logicalPartId: pChannel, variationLockId: 0, subChordLevel: 0, priority: 0,
        randomVariation: 1, pChannel, name: "", ...extra,
    };
}

function pattern(name: string, groove: number, measures: number, partRefs: PartRef[], embellishment = 0): StylePattern {
    return {
        name, timeSig: SIG, grooveBottom: groove, grooveTop: groove, embellishment, measures,
        rhythm: [], partRefs, motifSettings: null, band: null,
    };
}

function style(parts: StylePart[], patterns: StylePattern[]): Style {
    return {
        identity: { objectId: "", name: "", versionMS: 0, versionLS: 0, hasVersion: false },
        timeSig: SIG, tempo: 120, bands: [], parts: new Map(parts.map((p) => [p.partId, p])), patterns, motifs: [],
    };
}

/** A style whose pattern at groove level g plays key 36+g on the downbeat of every measure. */
function grooveStyle(levels: number[], measures = 1): Style {
    const parts = levels.map((g) => part(1, [[0, g]]));
    return style(parts, levels.map((g, i) => pattern(`g${g}`, g, measures, [ref(parts[i]!)])));
}

function segment(s: Style, measures: number, commands: Array<[number, number, number?]>): PerfSegment {
    const seg = new PerfSegment();
    seg.length = measures * MEASURE;
    seg.styles = [{ time: 0, style: s }];
    seg.commands = commands.map(([measure, grooveLevel, command]) => ({
        time: measure * MEASURE, measure, beat: 0, command: command ?? 0, grooveLevel, grooveRange: 0,
    }));
    return seg;
}

const keysAt = (heard: Heard[]): string[] => heard.map((h) => `${h.tick}:${h.key}`);

describe("style playback", () => {
    test("each command selects the pattern at its groove level", () => {
        const { synth, perf, run } = setup();
        perf.playSegment(segment(grooveStyle([1, 2, 5]), 4, [[0, 1], [2, 5], [3, 2]]), 0);
        run(4 * MEASURE);
        expect(keysAt(synth.on)).toEqual(["0:37", "3072:37", "6144:41", "9216:38"]);
    });

    test("a command cuts a longer pattern short, and a pattern that ends is chosen again", () => {
        const { synth, perf, run } = setup();
        const long = part(4, [[0, 1], [16, 2], [32, 3], [48, 4]]);
        const short = part(1, [[0, 7]]);
        const s = style([long, short], [pattern("long", 1, 4, [ref(long)]), pattern("short", 2, 1, [ref(short)])]);
        perf.playSegment(segment(s, 5, [[0, 1], [2, 2]]), 0);
        run(5 * MEASURE);
        // Two measures of the four-measure pattern, then the one-measure pattern three times.
        expect(keysAt(synth.on)).toEqual(["0:37", "3072:38", "6144:43", "9216:43", "12288:43"]);
    });

    test("of the patterns at a level, the longest that fits before the next command plays", () => {
        const { synth, perf, run } = setup();
        const two = part(2, [[0, 2]]);
        const four = part(4, [[0, 4]]);
        const eight = part(8, [[0, 8]]);
        const s = style([two, four, eight], [
            pattern("two", 1, 2, [ref(two)]), pattern("eight", 1, 8, [ref(eight)]), pattern("four", 1, 4, [ref(four)]),
        ]);
        perf.playSegment(segment(s, 8, [[0, 1], [4, 1], [6, 1]]), 0);
        run(8 * MEASURE);
        // Four measures to fill, then two, then no command ahead to limit the choice.
        expect(keysAt(synth.on)).toEqual(["0:40", "12288:38", "18432:44"]);
    });

    test("a part shorter than its pattern repeats inside it", () => {
        const { synth, perf, run } = setup();
        const p = part(1, [[4, 0]]);
        perf.playSegment(segment(style([p], [pattern("p", 1, 3, [ref(p)])]), 3, [[0, 1]]), 0);
        run(3 * MEASURE);
        expect(keysAt(synth.on)).toEqual(["768:36", "3840:36", "6912:36"]);
    });

    test("a level the style has no pattern for is a rest, not the nearest pattern", () => {
        const { synth, perf, run } = setup();
        perf.playSegment(segment(grooveStyle([1]), 3, [[0, 1], [1, 50], [2, 1]]), 0);
        run(3 * MEASURE);
        expect(keysAt(synth.on)).toEqual(["0:37", "6144:37"]);
    });

    test("an embellishment plays on its own measure, then the groove resumes at its level", () => {
        const { synth, perf, run } = setup();
        const groove = part(1, [[0, 0]]);
        const fill = part(1, [[0, 11]]);
        const s = style([groove, fill], [pattern("groove", 3, 1, [ref(groove)]), pattern("fill", 3, 1, [ref(fill)], 1)]);
        perf.playSegment(segment(s, 4, [[0, 3], [1, 3, 1]]), 0);
        run(4 * MEASURE);
        expect(keysAt(synth.on)).toEqual(["0:36", "3072:47", "6144:36", "9216:36"]);
    });

    test("only enabled variations play, one per part, shared by parts with the same lock", () => {
        const { synth, perf, run } = setup();
        // Variation 0 is disabled; 1 and 2 are enabled. random() = 0 picks the first enabled.
        const a = part(1, [[0, 0, 1], [0, 2, 2], [0, 4, 4]], [DISABLED, ENABLED, ENABLED]);
        const b = part(1, [[0, 12, 2], [0, 14, 4]], [ENABLED, ENABLED, ENABLED]);
        const s = style([a, b], [pattern("p", 1, 1, [ref(a, 0, { variationLockId: 7 }), ref(b, 1, { variationLockId: 7 })])]);
        perf.playSegment(segment(s, 1, [[0, 1]]), 0);
        run(MEASURE);
        expect(synth.on.map((h) => `ch${h.channel}:${h.key}`)).toEqual(["ch0:38", "ch1:48"]);
    });

    test("a part that takes variations in sequence steps through them each time the pattern starts", () => {
        const { synth, perf, run } = setup();
        const p = part(1, [[0, 0, 1], [0, 2, 2], [0, 4, 4]], [ENABLED, ENABLED, ENABLED]);
        perf.playSegment(segment(style([p], [pattern("p", 1, 1, [ref(p, 0, { randomVariation: 0 })])]), 4, [[0, 1]]), 0);
        run(4 * MEASURE);
        expect(synth.on.map((h) => h.key)).toEqual([36, 38, 40, 36]);
    });

    test("a note ends after its duration", () => {
        const { synth, perf, run } = setup();
        perf.playSegment(segment(grooveStyle([1]), 1, [[0, 1]]), 0);
        run(MEASURE);
        expect(keysAt(synth.off)).toEqual(["100:37"]);
    });
});

describe("segments", () => {
    test("a segment loops between its loop points, then plays out to its end", () => {
        const { synth, perf, notifications, run } = setup();
        const p = part(4, [[0, 0], [16, 1], [32, 2], [48, 3]]);
        const seg = segment(style([p], [pattern("p", 1, 4, [ref(p)])]), 4, [[0, 1]]);
        seg.loopStart = MEASURE;
        seg.loopEnd = 3 * MEASURE;
        seg.repeats = 1;
        const state = perf.playSegment(seg, 0);
        run(7 * MEASURE);
        // Looping back to measure 1 starts the pattern afresh there, as a seek does.
        expect(synth.on.map((h) => h.key)).toEqual([36, 37, 38, 36, 37, 38]);
        expect(notifications).toEqual(["start@0", `loop@${3 * MEASURE}`, `end@${6 * MEASURE}`]);
        expect(perf.isPlaying(seg, state)).toBe(false);
    });

    test("playback starts at the segment's play start with the band in force there", () => {
        const { synth, perf, run } = setup();
        const seg = segment(grooveStyle([1, 2]), 4, [[0, 1], [2, 2]]);
        seg.playStart = 2 * MEASURE;
        const band = (name: string, patch: number): Band => ({
            identity: { objectId: "", name, versionMS: 0, versionLS: 0, hasVersion: false },
            instruments: [{
                patch, assignPatch: 0, noteRanges: [0, 0, 0, 0], pChannel: 0, flags: 0x61 | 0x80, pan: 30, volume: 90,
                transpose: 12, channelPriority: 0, pitchBendRange: 0, collection: null,
            }],
        });
        seg.bands = [
            { time: 0, band: { band: band("first", 1), collections: [null] } },
            { time: MEASURE, band: { band: band("second", 2), collections: [null] } },
            { time: 3 * MEASURE, band: { band: band("third", 3), collections: [null] } },
        ];
        perf.playSegment(seg, 0);
        run(2 * MEASURE);
        expect(synth.log.filter((l) => l.startsWith("patch"))).toEqual(["patch ch0=2 (default)", "patch ch0=3 (default)"]);
        expect(synth.log).toContain("cc7 ch0=90");
        expect(synth.log).toContain("cc10 ch0=30");
        // The band's transposition is added to what the pattern plays.
        expect(keysAt(synth.on)).toEqual(["0:50", "3072:50"]);
    });

    test("the tempo track sets the pace, scaled by the master tempo", () => {
        const { synth, perf, run } = setup();
        const seg = segment(grooveStyle([1]), 4, [[0, 1]]);
        seg.tempos = [{ time: 0, tempo: 240 }];
        perf.playSegment(seg, 0);
        run(MEASURE);   // "ticks" of render time at 120 bpm: two measures of music at 240
        expect(synth.on).toHaveLength(2);
        perf.setMasterTempo(0.5);
        run(MEASURE);
        expect(synth.on).toHaveLength(3);
    });

    test("a new primary segment replaces the old one on the boundary asked for", () => {
        const { synth, perf, notifications, run } = setup();
        const long = part(1, [[2, 0]]);
        long.notes[0]!.duration = 5000;
        const first = segment(style([long], [pattern("p", 1, 1, [ref(long)])]), 8, [[0, 1]]);
        const second = segment(grooveStyle([4]), 2, [[0, 4]]);
        const firstState = perf.playSegment(first, 0);
        run(500);
        const secondState = perf.playSegment(second, DMUS_SEGF_MEASURE);
        expect(perf.isPlaying(second, secondState)).toBe(false);   // cued, not yet sounding
        run(3 * MEASURE);
        expect(keysAt(synth.on)).toEqual(["384:36", "3072:40", "6144:40"]);
        // The note the first segment left ringing is stopped where the second takes over.
        expect(synth.off[0]).toMatchObject({ tick: MEASURE, key: 36 });
        expect(notifications.slice(0, 3)).toEqual(["start@0", `abort@${MEASURE}`, `start@${MEASURE}`]);
        expect(perf.isPlaying(first, firstState)).toBe(false);
    });

    test("a beat boundary is the next beat of the playing segment", () => {
        const { synth, perf, run } = setup();
        perf.playSegment(segment(grooveStyle([1]), 8, [[0, 1]]), 0);
        run(BEAT + 10);
        perf.playSegment(segment(grooveStyle([4]), 1, [[0, 4]]), DMUS_SEGF_BEAT);
        run(MEASURE);
        expect(keysAt(synth.on)).toEqual(["0:37", `${2 * BEAT}:40`]);
    });

    test("a queued segment starts when the playing one ends", () => {
        const { synth, perf, run } = setup();
        perf.playSegment(segment(grooveStyle([1]), 2, [[0, 1]]), 0);
        run(100);
        perf.playSegment(segment(grooveStyle([4]), 1, [[0, 4]]), DMUS_SEGF_QUEUE);
        run(3 * MEASURE);
        expect(keysAt(synth.on)).toEqual(["0:37", "3072:37", "6144:40"]);
    });

    test("a secondary segment plays alongside the primary one", () => {
        const { synth, perf, notifications, run } = setup();
        const sting = part(1, [[0, 11]]);
        const s = style([sting], []);
        const motif = pattern("sting", 1, 1, [ref(sting, 5)]);
        motif.motifSettings = { repeats: 1, playStart: 0, loopStart: 0, loopEnd: 0, resolution: 0 };
        perf.playSegment(segment(grooveStyle([1]), 4, [[0, 1]]), 0);
        run(100);
        const state = perf.playSegment(PerfSegment.motif(s, motif), DMUS_SEGF_SECONDARY | DMUS_SEGF_BEAT);
        run(3 * MEASURE);
        expect(synth.on.filter((h) => h.channel === 5).map((h) => h.tick)).toEqual([BEAT, BEAT + MEASURE]);
        expect(synth.on.filter((h) => h.channel === 0).map((h) => h.tick)).toEqual([0, MEASURE, 2 * MEASURE, 3 * MEASURE]);
        expect(notifications).toContain(`end@${BEAT + 2 * MEASURE} secondary`);
        expect(perf.isPlaying(null, state)).toBe(false);
        expect(perf.primaryState()).not.toBeNull();
    });

    test("a band segment installs its band", () => {
        const { synth, perf, run } = setup();
        const band: Band = {
            identity: { objectId: "", name: "b", versionMS: 0, versionLS: 0, hasVersion: false },
            instruments: [{
                patch: 0x80000000, assignPatch: 0, noteRanges: [0, 0, 0, 0], pChannel: 9, flags: 1, pan: 0, volume: 0,
                transpose: 0, channelPriority: 0, pitchBendRange: 0, collection: null,
            }],
        };
        perf.playSegment(PerfSegment.band({ band, collections: [null] }), DMUS_SEGF_SECONDARY);
        run(10);
        expect(synth.log).toEqual(["patch ch9=80000000 (default)"]);
        expect(perf.activeStates()).toHaveLength(0);
    });

    test("stopping a segment silences its notes; stopping everything releases every note", () => {
        const { synth, perf, notifications, run } = setup();
        const long = part(1, [[0, 0]]);
        long.notes[0]!.duration = 9000;
        const seg = segment(style([long], [pattern("p", 1, 1, [ref(long)])]), 8, [[0, 1]]);
        const state = perf.playSegment(seg, 0);
        run(200);
        perf.stop(seg, state, 0);
        run(MEASURE);
        expect(keysAt(synth.on)).toEqual(["0:36"]);
        expect(synth.off[0]!.tick).toBeLessThan(210);
        expect(notifications).toEqual(["start@0", "abort@200"]);
        expect(perf.isPlaying(seg, null)).toBe(false);

        perf.playSegment(seg, 0);
        run(200);
        perf.stop(null, null, 0);
        expect(synth.log).toContain("allNotesOff");
        expect(perf.activeStates()).toHaveLength(0);
    });

    test("a groove level set on a playing segment is taken up at the next pattern", () => {
        const { synth, perf, run } = setup();
        const seg = segment(grooveStyle([1, 9], 2), 8, [[0, 1]]);
        perf.playSegment(seg, 0);
        run(MEASURE + 5);
        expect(seg.setCommand(0, 0, 9, 1)).toBe(true);
        run(3 * MEASURE - 10);
        expect(keysAt(synth.on)).toEqual(["0:37", "3072:37", "6144:45", "9216:45"]);
        // A segment with no command track has nothing to set it on.
        expect(new PerfSegment().setCommand(0, 0, 9, 1)).toBe(false);
    });
});

describe("AutoTransition", () => {
    function scored(): { s: Style } {
        const groove = part(1, [[0, 0]]);
        const ending = part(1, [[0, 11]]);
        return { s: style([groove, ending], [pattern("groove", 3, 1, [ref(groove)]), pattern("ending", 100, 1, [ref(ending)], 8)]) };
    }

    test("an ending embellishment plays for one measure on the next beat, then silence", () => {
        const { synth, perf, notifications, run } = setup();
        const from = segment(scored().s, 8, [[0, 3]]);
        perf.playSegment(from, 0);
        run(MEASURE + 10);
        const result = perf.autoTransition(null, 4, DMUS_COMPOSEF_BEAT);
        expect(result.transition).not.toBeNull();
        expect(result.toState).toBeNull();
        run(3 * MEASURE);
        const cut = MEASURE + BEAT;
        // The ending is found although its groove range does not hold the playing level.
        expect(keysAt(synth.on)).toEqual(["0:36", `${MEASURE}:36`, `${cut}:47`]);
        expect(notifications).toEqual(["start@0", `abort@${cut}`, `start@${cut}`, `end@${cut + MEASURE}`]);
        expect(perf.primaryState()).toBeNull();
    });

    test("a groove transition is one more measure of the playing style, then the next segment", () => {
        const { synth, perf, run } = setup();
        perf.playSegment(segment(scored().s, 8, [[0, 3]]), 0);
        run(100);
        const to = segment(grooveStyle([5]), 2, [[0, 5]]);
        const result = perf.autoTransition(to, 0, DMUS_COMPOSEF_MEASURE);
        expect(result.toState).not.toBeNull();
        run(4 * MEASURE);
        expect(keysAt(synth.on)).toEqual(["0:36", `${MEASURE}:36`, `${2 * MEASURE}:41`, `${3 * MEASURE}:41`]);
        expect(perf.isPlaying(to, result.toState)).toBe(false);   // it has played out by now
    });

    test("with nothing playing there is no transition: the next segment just starts", () => {
        const { synth, perf, run } = setup();
        const to = segment(grooveStyle([5]), 1, [[0, 5]]);
        const result = perf.autoTransition(to, 4, DMUS_COMPOSEF_MEASURE);
        expect(result.transition).toBeNull();
        expect(result.transitionState).toBeNull();
        run(MEASURE);
        expect(keysAt(synth.on)).toEqual(["0:41"]);
    });
});
