/**
 * The DLS synthesizer, measured on what it renders from a collection built here: one
 * cycle-exact sine wave, so pitch, level, envelopes and stereo placement can be read back
 * from the output instead of assumed.
 */
import { describe, expect, test } from "bun:test";
import {
    CONN_DST_EG1_ATTACKTIME, CONN_DST_EG1_RELEASETIME, CONN_DST_EG1_SUSTAINLEVEL, CONN_DST_PAN,
    F_INSTRUMENT_DRUMS, type DlsCollection, type DlsConnection, type DlsRegion,
} from "../../packages/formats/src/dmusic/dls";
import { DlsSynth, findInstrument } from "../../src/worker/core/audio/directmusic/synth";

const RATE = 22050;
/** A sine at exactly 441 Hz when played at its recorded rate: 50 frames per cycle. */
const CYCLE = 50;

function sineWave(cycles: number): Uint8Array {
    const pcm = new Int16Array(cycles * CYCLE);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * i) / CYCLE) * 32767);
    return new Uint8Array(pcm.buffer);
}

const timeCents = (seconds: number): number => Math.round(1200 * Math.log2(seconds) * 65536);
const connection = (destination: number, scale: number): DlsConnection =>
    ({ source: 0, control: 0, destination, transform: 0, scale });

function region(overrides: Partial<DlsRegion> & { articulation?: DlsConnection[] } = {}): DlsRegion {
    return {
        keyLow: 0, keyHigh: 127, velocityLow: 0, velocityHigh: 127, options: 0, keyGroup: 0,
        sample: null, waveIndex: 0, articulation: [], ...overrides,
    };
}

function collection(regions: DlsRegion[], opts: { loop?: boolean; cycles?: number; bank?: number } = {}): DlsCollection {
    const cycles = opts.cycles ?? 200;
    return {
        identity: { objectId: "", name: "", versionMS: 0, versionLS: 0, hasVersion: false },
        instruments: [{ bank: opts.bank ?? 1, program: 25, name: "Sine", regions, articulation: [] }],
        waves: [{
            formatTag: 1, channels: 1, sampleRate: RATE, bitsPerSample: 16, data: sineWave(cycles),
            sample: {
                unityNote: 60, fineTune: 0, attenuation: 0, options: 0,
                loop: opts.loop === false ? null : { type: 0, start: 0, length: cycles * CYCLE },
            },
        }],
    };
}

const PATCH = 0x0119;   // program 25, bank LSB 1

function render(synth: DlsSynth, frames: number): { left: Float32Array; right: Float32Array } {
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    synth.render(left, right, 0, frames);
    return { left, right };
}

const peak = (a: Float32Array, from = 0, to = a.length): number => {
    let p = 0;
    for (let i = from; i < to; i++) p = Math.max(p, Math.abs(a[i]!));
    return p;
};

/** Frequency from upward zero crossings over the whole buffer. */
function frequency(a: Float32Array): number {
    let first = -1, last = -1, crossings = 0;
    for (let i = 1; i < a.length; i++) {
        if (a[i - 1]! < 0 && a[i]! >= 0) {
            if (first < 0) first = i;
            last = i;
            crossings++;
        }
    }
    return crossings > 1 ? ((crossings - 1) * RATE) / (last - first) : 0;
}

function playing(c: DlsCollection, key = 60, velocity = 127): DlsSynth {
    const synth = new DlsSynth(RATE, 8);
    expect(synth.setInstrument(0, c, PATCH)).toBe(true);
    synth.controlChange(0, 7, 127);
    synth.noteOn(0, key, velocity);
    return synth;
}

describe("DlsSynth", () => {
    test("a patch selects by program, bank and drum flag", () => {
        const melodic = collection([region()]);
        expect(findInstrument(melodic, PATCH)?.name).toBe("Sine");
        expect(findInstrument(melodic, 0x0019)).toBeNull();              // bank 0
        expect(findInstrument(melodic, 0x011a)).toBeNull();              // program 26
        expect(findInstrument(melodic, (PATCH | F_INSTRUMENT_DRUMS) >>> 0)).toBeNull();
        const drums = collection([region()], { bank: (1 | F_INSTRUMENT_DRUMS) >>> 0 });
        expect(findInstrument(drums, (PATCH | F_INSTRUMENT_DRUMS) >>> 0)?.name).toBe("Sine");
    });

    test("the unity note plays the wave as recorded; an octave up doubles its frequency", () => {
        expect(frequency(render(playing(collection([region()])), 8000).left)).toBeCloseTo(441, 0);
        expect(frequency(render(playing(collection([region()]), 72), 8000).left)).toBeCloseTo(882, 0);
        expect(frequency(render(playing(collection([region()]), 53), 8000).left)).toBeCloseTo(441 * Math.pow(2, -7 / 12), 0);
    });

    test("pitch bend moves the pitch by the channel's bend range", () => {
        const synth = playing(collection([region()]));
        synth.pitchBend(0, 0x3fff);
        expect(frequency(render(synth, 8000).left)).toBeCloseTo(441 * Math.pow(2, 2 / 12), 0);
    });

    test("velocity and channel volume both scale level by the square of their value", () => {
        const full = peak(render(playing(collection([region()])), 4000).left);
        const halfVelocity = peak(render(playing(collection([region()]), 60, 64), 4000).left);
        expect(halfVelocity / full).toBeCloseTo((64 / 127) ** 2, 2);

        const quiet = playing(collection([region()]));
        quiet.controlChange(0, 7, 64);
        expect(peak(render(quiet, 4000).left, 2000) / full).toBeCloseTo((64 / 127) ** 2, 2);
    });

    test("pan places the voice: centre is equal power, hard left leaves the right silent", () => {
        const centre = render(playing(collection([region()])), 4000);
        expect(peak(centre.left)).toBeCloseTo(peak(centre.right), 4);

        const synth = new DlsSynth(RATE, 8);
        synth.setInstrument(0, collection([region()]), PATCH);
        synth.controlChange(0, 7, 127);
        synth.controlChange(0, 10, 0);
        synth.noteOn(0, 60, 127);
        const hardLeft = render(synth, 4000);
        expect(peak(hardLeft.right)).toBe(0);
        expect(peak(hardLeft.left) / peak(centre.left)).toBeCloseTo(Math.SQRT2, 2);

        // A region's own pan offsets the channel's.
        const offset = render(playing(collection([region({ articulation: [connection(CONN_DST_PAN, 500 * 65536)] })])), 4000);
        expect(peak(offset.left)).toBe(0);
    });

    test("with no envelope a released note stops at once; a release time lets it ring down", () => {
        const dry = playing(collection([region()]));
        render(dry, 2000);
        dry.noteOff(0, 60);
        render(dry, 200);
        expect(dry.activeVoiceCount).toBe(0);

        const ringing = playing(collection([region({ articulation: [connection(CONN_DST_EG1_RELEASETIME, timeCents(1))] })]));
        render(ringing, 2000);
        ringing.noteOff(0, 60);
        const tail = render(ringing, RATE).left;
        // The release falls 96 dB over its time, linearly in decibels: half way is -48 dB.
        const start = peak(tail, 0, 200);
        expect(20 * Math.log10(peak(tail, RATE / 2 - 100, RATE / 2 + 100) / start)).toBeCloseTo(-48, 0);
        render(ringing, RATE / 2);
        expect(ringing.activeVoiceCount).toBe(0);
    });

    test("the attack ramps level up linearly, then decay settles at the sustain level", () => {
        const synth = playing(collection([region({ articulation: [
            connection(CONN_DST_EG1_ATTACKTIME, timeCents(0.5)),
            connection(CONN_DST_EG1_SUSTAINLEVEL, 500 * 65536),
        ] })]));
        const out = render(synth, RATE).left;
        const full = peak(render(playing(collection([region()])), 2000).left);
        const quarter = Math.floor(RATE / 4);
        expect(peak(out, quarter - 100, quarter + 100) / full).toBeCloseTo(0.5, 1);
        // Sustain of 50% is half way down the 96 dB range, reached instantly with no decay time.
        expect(20 * Math.log10(peak(out, RATE - 500) / full)).toBeCloseTo(-48, 0);
    });

    test("a wave without a loop ends the voice; a looped one sustains", () => {
        const oneShot = playing(collection([region()], { loop: false, cycles: 20 }));
        render(oneShot, 20 * CYCLE + 100);
        expect(oneShot.activeVoiceCount).toBe(0);

        const looped = playing(collection([region()], { cycles: 20 }));
        const out = render(looped, 20 * CYCLE * 5).left;
        expect(looped.activeVoiceCount).toBe(1);
        // No seam at the loop point: the frequency is still exact across four passes.
        expect(frequency(out)).toBeCloseTo(441, 0);
    });

    test("a key group is exclusive, and a key retriggers unless its region allows overlap", () => {
        const grouped = new DlsSynth(RATE, 8);
        const ring = [connection(CONN_DST_EG1_RELEASETIME, timeCents(4))];
        grouped.setInstrument(0, collection([
            region({ keyLow: 0, keyHigh: 60, keyGroup: 1, articulation: ring }),
            region({ keyLow: 61, keyHigh: 127, keyGroup: 1, articulation: ring }),
        ]), PATCH);
        grouped.noteOn(0, 60, 100);
        grouped.noteOn(0, 61, 100);
        render(grouped, 1000);   // the cut voice dies in a few milliseconds, not its 4 s release
        expect(grouped.activeVoiceCount).toBe(1);

        const retrigger = playing(collection([region({ articulation: ring })]));
        retrigger.noteOn(0, 60, 100);
        render(retrigger, 1000);
        expect(retrigger.activeVoiceCount).toBe(1);

        const overlap = playing(collection([region({ options: 1, articulation: ring })]));
        overlap.noteOn(0, 60, 100);
        render(overlap, 1000);
        expect(overlap.activeVoiceCount).toBe(2);
    });

    test("the sustain pedal holds released notes until it comes up", () => {
        const synth = playing(collection([region()]));
        synth.controlChange(0, 64, 127);
        synth.noteOff(0, 60);
        render(synth, 2000);
        expect(synth.activeVoiceCount).toBe(1);
        synth.controlChange(0, 64, 0);
        render(synth, 200);
        expect(synth.activeVoiceCount).toBe(0);
    });

    test("polyphony is bounded: the oldest note gives way", () => {
        const synth = new DlsSynth(RATE, 2);
        synth.setInstrument(0, collection([region({ options: 1 })]), PATCH);
        for (const key of [60, 62, 64]) synth.noteOn(0, key, 100);
        expect(synth.activeVoiceCount).toBe(2);
        synth.noteOff(0, 60);   // already stolen: releasing it changes nothing
        render(synth, 200);
        expect(synth.activeVoiceCount).toBe(2);
    });

    test("notes that cannot sound are counted, not played", () => {
        const synth = new DlsSynth(RATE, 8);
        synth.noteOn(3, 60, 100);
        synth.setInstrument(0, collection([region({ keyLow: 40, keyHigh: 50 })]), PATCH);
        synth.noteOn(0, 60, 100);
        synth.noteOn(0, 45, 100);
        expect(synth.stats).toEqual({ notes: 1, noInstrument: 1, noRegion: 1 });
        // An unknown patch leaves the channel without an instrument rather than with the old one.
        expect(synth.setInstrument(0, collection([region()]), 0x7f7f7f)).toBe(false);
        synth.noteOn(0, 45, 100);
        expect(synth.stats.noInstrument).toBe(2);
    });

    test("master volume is in hundredths of a decibel", () => {
        const full = peak(render(playing(collection([region()])), 4000).left);
        const synth = playing(collection([region()]));
        synth.setMasterVolume(-600);
        expect(peak(render(synth, 4000).left, 2000) / full).toBeCloseTo(Math.pow(10, -6 / 20), 2);
    });
});
