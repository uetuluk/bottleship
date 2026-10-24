/**
 * From parsed DirectMusic files to what the performance plays. A segment names its style
 * and a band names its DLS collections by reference; whoever owns the load (the
 * application's loader, in the end) resolves them.
 */
import type { Band } from "@bottleship/formats/dmusic/band";
import type { DlsCollection } from "@bottleship/formats/dmusic/dls";
import type { ObjectReference } from "@bottleship/formats/dmusic/reference";
import type { Segment } from "@bottleship/formats/dmusic/segment";
import type { Style } from "@bottleship/formats/dmusic/style";
import { ticksPerBeat, ticksPerMeasure } from "@bottleship/formats/dmusic/style";
import { type LoadedBand, PerfSegment } from "./performance";

export type ResolveStyle = (ref: ObjectReference) => Style | null;
export type ResolveCollection = (ref: ObjectReference) => DlsCollection | null;

/** A band's instruments with their collections resolved; null selects the default collection. */
export function loadBand(band: Band, resolveCollection: ResolveCollection): LoadedBand {
    return {
        band,
        collections: band.instruments.map((inst) => inst.collection ? resolveCollection(inst.collection) : null),
    };
}

export function buildSegment(file: Segment, resolveStyle: ResolveStyle, resolveCollection: ResolveCollection): PerfSegment {
    const segment = new PerfSegment();
    const h = file.header;
    segment.length = h.length;
    segment.playStart = h.playStart;
    segment.loopStart = h.loopStart;
    segment.loopEnd = h.loopEnd;
    segment.repeats = h.repeats;
    segment.resolution = h.resolution;
    for (const track of file.tracks) {
        switch (track.kind) {
            case "tempo": segment.tempos.push(...track.items); break;
            case "command": segment.commands = [...(segment.commands ?? []), ...track.items.map((c) => ({ ...c }))]; break;
            case "style":
                for (const item of track.items) {
                    const style = resolveStyle(item.style);
                    if (style) segment.styles.push({ time: item.time, style });
                }
                break;
            case "band":
                for (const item of track.items) {
                    segment.bands.push({ time: item.time, band: loadBand(item.band, resolveCollection) });
                }
                break;
            case "chord":
                segment.chords.push(...track.items);
                segment.chordKey = track.root;
                segment.chordScale = track.scale;
                break;
            case "seq":
                segment.events.push(...track.events);
                segment.curves.push(...track.curves);
                break;
        }
    }
    // A command is authored on a measure and beat; its tick time follows from the style's meter.
    if (segment.commands && segment.styles[0]) {
        const sig = segment.styles[0].style.timeSig;
        for (const c of segment.commands) c.time = c.measure * ticksPerMeasure(sig) + c.beat * ticksPerBeat(sig);
    }
    return segment;
}
