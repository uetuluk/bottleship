/** Builders for synthetic DirectMusic files (RIFF trees), shared by the dmusic tests. */

export function bytes(...parts: Array<Uint8Array | number[]>): Uint8Array {
    const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
    const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of arrays) { out.set(a, o); o += a.length; }
    return out;
}

export const u8 = (...v: number[]): Uint8Array => Uint8Array.from(v);
export const u16 = (...v: number[]): Uint8Array => new Uint8Array(Uint16Array.from(v).buffer);
export const i16 = (...v: number[]): Uint8Array => new Uint8Array(Int16Array.from(v).buffer);
export const u32 = (...v: number[]): Uint8Array => new Uint8Array(Uint32Array.from(v).buffer);
export const i32 = (...v: number[]): Uint8Array => new Uint8Array(Int32Array.from(v).buffer);
export const f64 = (...v: number[]): Uint8Array => new Uint8Array(Float64Array.from(v).buffer);
export const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** A NUL-terminated UTF-16LE string. */
export function wide(s: string): Uint8Array {
    const out = new Uint8Array((s.length + 1) * 2);
    for (let i = 0; i < s.length; i++) { out[i * 2] = s.charCodeAt(i) & 0xff; out[i * 2 + 1] = s.charCodeAt(i) >> 8; }
    return out;
}

/** A GUID in its in-memory layout from the registry spelling. */
export function guid(s: string): Uint8Array {
    const hex = s.replace(/-/g, "");
    const b = (i: number): number => parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return u8(b(3), b(2), b(1), b(0), b(5), b(4), b(7), b(6), b(8), b(9), b(10), b(11), b(12), b(13), b(14), b(15));
}

export function chunk(id: string, ...data: Array<Uint8Array | number[]>): Uint8Array {
    const payload = bytes(...data);
    return bytes(ascii(id), u32(payload.length), payload, payload.length & 1 ? [0] : []);
}

export const list = (type: string, ...children: Uint8Array[]): Uint8Array => chunk("LIST", ascii(type), ...children);
export const riff = (type: string, ...children: Uint8Array[]): Uint8Array => chunk("RIFF", ascii(type), ...children);

/** `LIST DMRF` naming an object of `classId` by file name. */
export function reference(classId: string, fileName: string, objectId?: string): Uint8Array {
    return list("DMRF",
        chunk("refh", guid(classId), u32(0)),
        ...(objectId ? [chunk("guid", guid(objectId))] : []),
        chunk("file", wide(fileName)));
}

export interface InstrumentSpec {
    patch: number; pChannel: number; flags: number; pan?: number; volume?: number; transpose?: number;
    collection?: string;
}

export function bandChunks(name: string, instruments: InstrumentSpec[]): Uint8Array[] {
    return [
        list("UNFO", chunk("UNAM", wide(name))),
        list("lbil", ...instruments.map((inst) => list("lbin",
            chunk("bins", u32(inst.patch, 0, 0, 0, 0, 0, inst.pChannel, inst.flags),
                u8(inst.pan ?? 64, inst.volume ?? 100), i16(inst.transpose ?? 0), u32(0)),
            ...(inst.collection ? [reference("480ff4b0-28b2-11d1-bef7-00c04fbf8fef", inst.collection)] : [])))),
    ];
}
