#!/usr/bin/env bun
/**
 * dmusic-render: play a DirectMusic segment from loose files through our own performance
 * and DLS synthesizer, into a WAV file. The offline half of the DirectMusic HLE — what a
 * title's music sounds like, with no emulator in the loop.
 *
 * Usage:
 *   bun tools/dmusic-render.ts <dir> <segment.sgt> <out.wav> [--seconds n] [--rate hz]
 *                              [--groove n] [--motif Style.sty:Name] [--seed n] [--info]
 *
 * <dir> holds the segment and everything it refers to (.sty, .dls, .bnd), found by file
 * name, case-insensitively.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDls, type DlsCollection } from "../packages/formats/src/dmusic/dls";
import type { ObjectReference } from "../packages/formats/src/dmusic/reference";
import { parseSegment } from "../packages/formats/src/dmusic/segment";
import { parseStyle, type Style } from "../packages/formats/src/dmusic/style";
import { buildSegment } from "../src/worker/core/audio/directmusic/build";
import { DMUS_SEGF_BEAT, DMUS_SEGF_SECONDARY, PerfSegment, Performance } from "../src/worker/core/audio/directmusic/performance";
import { DlsSynth } from "../src/worker/core/audio/directmusic/synth";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && args[i - 1] !== "--info"));
const [dir, segmentName, outPath] = positional;
if (!dir || !segmentName || !outPath) {
    console.error("Usage: bun tools/dmusic-render.ts <dir> <segment.sgt> <out.wav> [--seconds n] [--rate hz] [--groove n] [--motif Style.sty:Name] [--seed n] [--info]");
    process.exit(2);
}
const seconds = Number(flag("--seconds") ?? 30);
const rate = Number(flag("--rate") ?? 22050);

const files = new Map(readdirSync(dir).map((f) => [f.toLowerCase(), f]));
const read = (name: string): Uint8Array | null => {
    const actual = files.get(name.toLowerCase());
    return actual ? new Uint8Array(readFileSync(join(dir, actual))) : null;
};
const styles = new Map<string, Style | null>();
const collections = new Map<string, DlsCollection | null>();
const resolveStyle = (ref: ObjectReference): Style | null => {
    const key = ref.fileName.toLowerCase();
    if (!styles.has(key)) {
        const bytes = read(ref.fileName);
        styles.set(key, bytes ? parseStyle(bytes) : null);
        if (!styles.get(key)) console.error(`style not found: ${ref.fileName}`);
    }
    return styles.get(key) ?? null;
};
const resolveCollection = (ref: ObjectReference): DlsCollection | null => {
    const key = ref.fileName.toLowerCase();
    if (!collections.has(key)) {
        const bytes = read(ref.fileName);
        collections.set(key, bytes ? parseDls(bytes) : null);
        if (!collections.get(key)) console.error(`collection not found: ${ref.fileName}`);
    }
    return collections.get(key) ?? null;
};

const bytes = read(segmentName);
const file = bytes ? parseSegment(bytes) : null;
if (!file) {
    console.error(`not a DirectMusic segment: ${segmentName}`);
    process.exit(1);
}
const segment = buildSegment(file, resolveStyle, resolveCollection);
const groove = flag("--groove");
if (groove !== undefined) segment.setCommand(0, 0, Number(groove), 1);

const synth = new DlsSynth(rate, 64);
const performance = new Performance(synth);
const seed = flag("--seed");
if (seed !== undefined) {
    // mulberry32: a repeatable stand-in for Math.random.
    let state = Number(seed) >>> 0;
    performance.random = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const info = args.includes("--info");
if (info) {
    performance.onNotification = (type, state, time) => {
        console.log(`t=${(time / 768).toFixed(2)}q notification ${type} primary=${state.primary}`);
    };
}
performance.playSegment(segment, 0);

const motif = flag("--motif");
let motifSegment: PerfSegment | null = null;
if (motif) {
    const [styleFile, name] = motif.split(":");
    const style = resolveStyle({ fileName: styleFile! } as ObjectReference);
    const pattern = style?.motifs.find((m) => m.name.toLowerCase() === name!.toLowerCase());
    if (!style || !pattern) {
        console.error(`motif not found: ${motif}`);
        process.exit(1);
    }
    motifSegment = PerfSegment.motif(style, pattern);
}

const frames = Math.floor(seconds * rate);
const left = new Float32Array(frames);
const right = new Float32Array(frames);
const block = 1024;
let lastPattern = "";
let peakVoices = 0;
for (let done = 0; done < frames; done += block) {
    const n = Math.min(block, frames - done);
    // The motif enters a third of the way in, as a secondary segment on the next beat.
    if (motifSegment && done >= frames / 3) {
        performance.playSegment(motifSegment, DMUS_SEGF_SECONDARY | DMUS_SEGF_BEAT);
        motifSegment = null;
    }
    performance.render(left.subarray(done, done + n), right.subarray(done, done + n), n);
    peakVoices = Math.max(peakVoices, synth.activeVoiceCount);
    if (info) {
        const state = performance.primaryState();
        const name = state?.pattern ? `${state.pattern.name} (groove ${state.grooveLevel})` : "-";
        if (name !== lastPattern) {
            console.log(`${(done / rate).toFixed(2)}s  tempo ${performance.currentTempo.toFixed(1)}  pattern ${name}  voices ${synth.activeVoiceCount}`);
            lastPattern = name;
        }
    }
}

let peak = 0;
let sum = 0;
let clipped = 0;
const pcm = new Int16Array(frames * 2);
for (let i = 0; i < frames; i++) {
    const l = left[i]!;
    const r = right[i]!;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    sum += l * l + r * r;
    if (Math.abs(l) > 1 || Math.abs(r) > 1) clipped++;
    pcm[i * 2] = Math.max(-32768, Math.min(32767, Math.round(l * 32767)));
    pcm[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(r * 32767)));
}
const header = new DataView(new ArrayBuffer(44));
const tag = (o: number, s: string): void => { for (let i = 0; i < 4; i++) header.setUint8(o + i, s.charCodeAt(i)); };
tag(0, "RIFF"); header.setUint32(4, 36 + pcm.byteLength, true); tag(8, "WAVE");
tag(12, "fmt "); header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 2, true);
header.setUint32(24, rate, true); header.setUint32(28, rate * 4, true); header.setUint16(32, 4, true); header.setUint16(34, 16, true);
tag(36, "data"); header.setUint32(40, pcm.byteLength, true);
writeFileSync(outPath, Buffer.concat([Buffer.from(header.buffer), Buffer.from(pcm.buffer)]));
console.log(`${outPath}: ${seconds}s at ${rate} Hz, peak ${peak.toFixed(3)}, rms ${Math.sqrt(sum / (frames * 2)).toFixed(4)}, ` +
    `clipped frames ${clipped}, peak voices ${peakVoices}, notes ${synth.stats.notes} ` +
    `(no instrument ${synth.stats.noInstrument}, no region ${synth.stats.noRegion})`);
