/**
 * Music values to MIDI notes. A style stores harmony positions, not pitches, so this
 * conversion is what decides every note a style-based score plays.
 */
import { describe, expect, test } from "bun:test";
import {
    DEFAULT_CHORD, DMUS_PLAYMODE_CHORD_INTERVALS, DMUS_PLAYMODE_CHORD_ROOT, DMUS_PLAYMODE_FIXED,
    DMUS_PLAYMODE_KEY_ROOT, DMUS_PLAYMODE_SCALE_INTERVALS, type ChordContext, musicValueToMidi,
    variationMatchesChord,
} from "../../src/worker/core/audio/directmusic/music-value";

const NORMAL_CHORD = DMUS_PLAYMODE_CHORD_ROOT | DMUS_PLAYMODE_CHORD_INTERVALS | DMUS_PLAYMODE_SCALE_INTERVALS;
/** (chord position, scale position, accidental) as the low three nibbles of a music value. */
const mv = (octave: number, chord: number, scale: number, accidental: number): number =>
    (octave << 12) | (chord << 8) | (scale << 4) | (accidental & 0xf);

describe("musicValueToMidi", () => {
    // How an authoring tool spells the chromatic scale against the default chord: each
    // semitone is a chord tone, a scale step above one, or one of those bent by an accidental.
    test("the default chord maps the twelve chromatic spellings to the twelve semitones", () => {
        const spellings = [
            mv(3, 0, 0, 0), mv(3, 0, 0, 1), mv(3, 0, 1, 0), mv(3, 1, 0, -1), mv(3, 1, 0, 0), mv(3, 1, 1, 0),
            mv(3, 2, 0, -1), mv(3, 2, 0, 0), mv(3, 2, 0, 1), mv(3, 2, 1, 0), mv(3, 3, 0, -1), mv(3, 3, 0, 0),
        ];
        expect(spellings.map((v) => musicValueToMidi(v, DEFAULT_CHORD, NORMAL_CHORD)))
            .toEqual([36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47]);
    });

    test("a music value's octave is a MIDI octave under the default chord", () => {
        expect(musicValueToMidi(0x1000, DEFAULT_CHORD, NORMAL_CHORD)).toBe(12);
        expect(musicValueToMidi(0x5000, DEFAULT_CHORD, NORMAL_CHORD)).toBe(60);
    });

    test("a chord position past the top of the chord climbs an octave", () => {
        expect(musicValueToMidi(mv(3, 4, 0, 0), DEFAULT_CHORD, NORMAL_CHORD)).toBe(48);
        expect(musicValueToMidi(mv(3, 5, 0, 0), DEFAULT_CHORD, NORMAL_CHORD)).toBe(52);
    });

    test("another chord moves the same music values", () => {
        // D minor on 2D, in C major: root, minor third, fifth.
        const dMinor: ChordContext = { chordPattern: 0x89, scalePattern: 0xab5ab5, chordRoot: 14, scaleRoot: 0, key: 12 };
        expect([mv(3, 0, 0, 0), mv(3, 1, 0, 0), mv(3, 2, 0, 0)].map((v) => musicValueToMidi(v, dMinor, NORMAL_CHORD)))
            .toEqual([38, 41, 45]);
        // A scale step above the third follows the KEY's scale: F to G, not F to F#.
        expect(musicValueToMidi(mv(3, 1, 1, 0), dMinor, NORMAL_CHORD)).toBe(43);
        // The root an octave down (1D) plays an octave lower.
        expect(musicValueToMidi(mv(3, 0, 0, 0), { ...dMinor, chordRoot: 2 }, NORMAL_CHORD)).toBe(26);
    });

    test("fixed modes take the value as a MIDI note, transposed by the root they name", () => {
        const g: ChordContext = { ...DEFAULT_CHORD, chordRoot: 19, key: 14 };
        expect(musicValueToMidi(60, g, DMUS_PLAYMODE_FIXED)).toBe(60);
        expect(musicValueToMidi(60, g, DMUS_PLAYMODE_CHORD_ROOT)).toBe(67);
        expect(musicValueToMidi(60, g, DMUS_PLAYMODE_KEY_ROOT)).toBe(62);
    });

    test("scale intervals alone read a chord position as thirds in the scale", () => {
        const melodic = DMUS_PLAYMODE_CHORD_ROOT | DMUS_PLAYMODE_SCALE_INTERVALS;
        expect([0, 1, 2, 3].map((p) => musicValueToMidi(mv(3, p, 0, 0), DEFAULT_CHORD, melodic))).toEqual([36, 40, 43, 47]);
    });
});

describe("variationMatchesChord", () => {
    const ALL = 0x1fffffff;
    const MODE_ONLY = 0x20000000;

    test("a variation with every chord flag plays; one with only its mode bits is disabled", () => {
        expect(variationMatchesChord(ALL | MODE_ONLY, DEFAULT_CHORD)).toBe(true);
        expect(variationMatchesChord(MODE_ONLY, DEFAULT_CHORD)).toBe(false);
        expect(variationMatchesChord(0, DEFAULT_CHORD)).toBe(false);
    });

    test("each of scale degree, root, chord size must be allowed", () => {
        const I_MAJOR = 0x00000001;
        const ROOT_SCALE = 0x00200000;
        const TYPE_TRIAD = 0x01000000;
        const TYPE_6AND7 = 0x02000000;
        // The default chord: major, on the first degree, four notes.
        expect(variationMatchesChord(I_MAJOR | ROOT_SCALE | TYPE_6AND7, DEFAULT_CHORD)).toBe(true);
        expect(variationMatchesChord(I_MAJOR | ROOT_SCALE | TYPE_TRIAD, DEFAULT_CHORD)).toBe(false);
        expect(variationMatchesChord(I_MAJOR | TYPE_6AND7, DEFAULT_CHORD)).toBe(false);
        expect(variationMatchesChord(0x00000002 | ROOT_SCALE | TYPE_6AND7, DEFAULT_CHORD)).toBe(false);

        // D minor triad in C major: the second degree, in the minor family (bits 7-13).
        const dMinor: ChordContext = { chordPattern: 0x89, scalePattern: 0xab5ab5, chordRoot: 14, scaleRoot: 0, key: 12 };
        expect(variationMatchesChord((1 << 8) | ROOT_SCALE | TYPE_TRIAD, dMinor)).toBe(true);
        expect(variationMatchesChord((1 << 1) | ROOT_SCALE | TYPE_TRIAD, dMinor)).toBe(false);
    });
});
