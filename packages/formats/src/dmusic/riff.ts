/**
 * RIFF chunk walking for the DirectMusic file family (segments, styles, bands, DLS).
 * Every one of them is a tree of `RIFF`/`LIST` containers around leaf chunks, with chunk
 * data padded to an even length.
 */

export interface RiffChunk {
    /** Four-character chunk id. */
    id: string;
    /** List type of a `RIFF`/`LIST` container, empty for a leaf. */
    type: string;
    /** First byte of the payload (past the list type for a container). */
    start: number;
    /** One past the payload's last byte, clamped to the enclosing container. */
    end: number;
}

function fourcc(buf: Uint8Array, o: number): string {
    return String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
}

/** The chunks directly inside [start, end). A truncated tail ends the walk. */
export function* riffChunks(buf: Uint8Array, start: number, end: number): Generator<RiffChunk> {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let o = start; o + 8 <= end;) {
        const id = fourcc(buf, o);
        const size = view.getUint32(o + 4, true);
        const dataEnd = Math.min(o + 8 + size, end);
        if (id === "RIFF" || id === "LIST") {
            if (o + 12 > end) return;
            yield { id, type: fourcc(buf, o + 8), start: o + 12, end: dataEnd };
        } else {
            yield { id, type: "", start: o + 8, end: dataEnd };
        }
        o += 8 + size + (size & 1);
    }
}

/** The outermost `RIFF` container, or null when the bytes are not a RIFF file of `type`. */
export function riffRoot(buf: Uint8Array, type: string): RiffChunk | null {
    for (const chunk of riffChunks(buf, 0, buf.length)) {
        return chunk.id === "RIFF" && chunk.type === type ? chunk : null;
    }
    return null;
}

export function isList(chunk: RiffChunk, type: string): boolean {
    return (chunk.id === "LIST" || chunk.id === "RIFF") && chunk.type === type;
}

/** A NUL-terminated UTF-16LE string chunk (`UNAM`, `name`, `file`). */
export function wideString(buf: Uint8Array, chunk: RiffChunk): string {
    let out = "";
    for (let o = chunk.start; o + 1 < chunk.end; o += 2) {
        const code = buf[o]! | (buf[o + 1]! << 8);
        if (code === 0) break;
        out += String.fromCharCode(code);
    }
    return out;
}

/** A GUID chunk in the registry spelling, lower case, no braces. */
export function guidString(buf: Uint8Array, o: number): string {
    const hex = (i: number): string => buf[o + i]!.toString(16).padStart(2, "0");
    return `${hex(3)}${hex(2)}${hex(1)}${hex(0)}-${hex(5)}${hex(4)}-${hex(7)}${hex(6)}-${hex(8)}${hex(9)}-` +
        `${hex(10)}${hex(11)}${hex(12)}${hex(13)}${hex(14)}${hex(15)}`;
}

export function dataView(buf: Uint8Array): DataView {
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}
