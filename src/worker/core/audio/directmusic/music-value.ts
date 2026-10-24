/**
 * DirectMusic music values: a style stores a note as a position in the harmony (octave,
 * chord tone, scale steps above it, accidental) so one pattern can play over any chord.
 * This is the conversion IDirectMusicPerformance::MusicToMIDI performs when the note sounds.
 */

export const DMUS_PLAYMODE_FIXED = 0;
export const DMUS_PLAYMODE_KEY_ROOT = 1;
export const DMUS_PLAYMODE_CHORD_ROOT = 2;
export const DMUS_PLAYMODE_SCALE_INTERVALS = 4;
export const DMUS_PLAYMODE_CHORD_INTERVALS = 8;
/** On a note: "use the part's play mode". */
export const DMUS_PLAYMODE_NONE = 16;

/** The part of a chord one sub-chord level plays against. */
export interface ChordContext {
    /** Bit n set: the chord contains the note n semitones above `chordRoot`. */
    chordPattern: number;
    /** Bit n set: the scale contains the note n semitones above `scaleRoot`. */
    scalePattern: number;
    chordRoot: number;
    scaleRoot: number;
    /** Root of the key, for the key-relative play modes. */
    key: number;
}

/**
 * Chord roots are counted from 1C, so that a chord can sit an octave below where chords
 * are normally written. 2C is that normal place: a note played against it is not
 * transposed, and a music value's octave is then a MIDI octave (0x3000 is MIDI 36).
 */
const UNTRANSPOSED_ROOT = 12;

/**
 * What a style plays against when its segment has no chord track: a major seventh on 2C
 * over the C major scale. Under it the twelve (chord, scale, accidental) spellings an
 * authoring tool uses are exactly the twelve semitones.
 */
export const DEFAULT_CHORD: ChordContext = {
    chordPattern: 0x891,
    scalePattern: 0xab5ab5,
    chordRoot: 12,
    scaleRoot: 0,
    key: 12,
};

const MAJOR_SCALE = 0xab5;

/** The scale as one octave of semitone bits relative to `root`. */
function scaleFrom(scalePattern: number, scaleRoot: number, root: number): number {
    const octave = ((scalePattern | (scalePattern >>> 12)) & 0xfff) || MAJOR_SCALE;
    const shift = (((root - scaleRoot) % 12) + 12) % 12;
    return ((octave >>> shift) | (octave << (12 - shift))) & 0xfff;
}

/** Semitones above the root of the `position`-th chord tone; past the top it climbs an octave. */
function chordToneOffset(chordPattern: number, position: number): number {
    const tones: number[] = [];
    for (let bit = 0; bit < 24; bit++) if (chordPattern & (1 << bit)) tones.push(bit);
    if (tones.length === 0) tones.push(0);
    const span = tones[tones.length - 1]! >= 12 ? 24 : 12;
    return tones[position % tones.length]! + span * Math.floor(position / tones.length);
}

/**
 * Convert `musicValue` (0xOCSA: octave, chord position, scale position, signed accidental)
 * to a MIDI note under `playMode`. The result is not clamped: the caller transposes first.
 */
export function musicValueToMidi(musicValue: number, chord: ChordContext, playMode: number): number {
    const mode = playMode & 0x0f;
    if (mode === DMUS_PLAYMODE_FIXED) return musicValue;

    const root = mode & DMUS_PLAYMODE_KEY_ROOT ? chord.key : chord.chordRoot;
    const transposition = root - UNTRANSPOSED_ROOT;
    if (!(mode & (DMUS_PLAYMODE_SCALE_INTERVALS | DMUS_PLAYMODE_CHORD_INTERVALS))) return musicValue + transposition;

    const octave = (musicValue >>> 12) & 0xf;
    const chordPosition = (musicValue >>> 8) & 0xf;
    let scalePosition = (musicValue >>> 4) & 0xf;
    const nibble = musicValue & 0xf;
    const accidental = nibble > 7 ? nibble - 16 : nibble;

    let offset = 0;
    if (mode & DMUS_PLAYMODE_CHORD_INTERVALS) {
        offset = chordToneOffset(chord.chordPattern, chordPosition);
    } else {
        // Without chord intervals a chord position is a stack of thirds in the scale.
        scalePosition += chordPosition * 2;
    }
    if (mode & DMUS_PLAYMODE_SCALE_INTERVALS) {
        const scale = scaleFrom(chord.scalePattern, chord.scaleRoot, root);
        for (; scalePosition > 0; scalePosition--) {
            do { offset++; } while (!(scale & (1 << (offset % 12))));
        }
    }
    return transposition + 12 * octave + offset + accidental;
}

// DMUS_VARIATIONF_*: the chords a variation may play over.
const VARIATIONF_ROOT_SCALE = 0x00200000;
const VARIATIONF_ROOT_FLAT = 0x00400000;
const VARIATIONF_ROOT_SHARP = 0x00800000;
const VARIATIONF_TYPE_TRIAD = 0x01000000;
const VARIATIONF_TYPE_6AND7 = 0x02000000;
const VARIATIONF_TYPE_COMPLEX = 0x04000000;

/**
 * Whether a variation with these DMUS_VARIATIONF_* choices may play over `chord`: it must
 * allow the chord's scale degree (in the major, minor or other family), the root's
 * relation to the scale, and the chord's size.
 */
export function variationMatchesChord(choices: number, chord: ChordContext): boolean {
    const scale = scaleFrom(chord.scalePattern, chord.scaleRoot, chord.scaleRoot);
    const rootInScale = (((chord.chordRoot - chord.scaleRoot) % 12) + 12) % 12;

    // Scale degree of the root; a root off the scale takes the degree below it, sharpened.
    let degree = 0;
    let rootFlag = VARIATIONF_ROOT_SCALE;
    if (scale & (1 << rootInScale)) {
        for (let bit = 0; bit < rootInScale; bit++) if (scale & (1 << bit)) degree++;
    } else {
        for (let bit = 0; bit < rootInScale; bit++) if (scale & (1 << bit)) degree++;
        degree = Math.max(0, degree - 1);
        rootFlag = VARIATIONF_ROOT_SHARP | VARIATIONF_ROOT_FLAT;
    }
    degree = Math.min(degree, 6);

    const third = chord.chordPattern & 0x18;   // minor third (bit 3) or major third (bit 4)
    const family = third === 0x10 ? 0 : third === 0x08 ? 7 : 14;
    if (!(choices & (1 << (family + degree)))) return false;
    if (!(choices & rootFlag)) return false;

    let tones = 0;
    for (let bit = 0; bit < 24; bit++) if (chord.chordPattern & (1 << bit)) tones++;
    const typeFlag = tones <= 3 ? VARIATIONF_TYPE_TRIAD : tones === 4 ? VARIATIONF_TYPE_6AND7 : VARIATIONF_TYPE_COMPLEX;
    return (choices & typeFlag) !== 0;
}
