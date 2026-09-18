/**
 * TS loader for the `unpack-buffered` Rust→wasm crate (tools/build-unpack-buffered).
 *
 * Consolidates archive/codec decompression for the game-ingestion pipeline:
 *   - extract7z   — full 7z extraction (LZMA/LZMA2/BCJ-x86/Copy/Delta, solid blocks)
 *   - inflateRaw  — raw DEFLATE (zip / InstallShield cabinet codecs)
 *   - lzmaDecode  — raw LZMA1 with explicit props/dict/size
 *
 * The wasm is built by tools/build-unpack-buffered/build-wasm.sh, which emits the
 * wasm-bindgen `--target web` glue under pkg/ and mirrors the core .wasm to
 * public/unpack-buffered.wasm (Vite serves it from there — same pattern as
 * /v86.wasm and /unpack.wasm).
 */
import type { InitOutput } from "../../../../tools/build-unpack-buffered/pkg/unpack_buffered";
import init, {
    extract_7z,
    inflate_raw,
    lzma_decode,
} from "../../../../tools/build-unpack-buffered/pkg/unpack_buffered";

/** Decompressed 7z entry as returned across the wasm boundary. */
interface RawArchiveEntry {
    name: string;
    data: Uint8Array;
}

let initPromise: Promise<InitOutput> | null = null;

/**
 * Lazily instantiate the wasm module. Worker-friendly: fetches the mirrored
 * core wasm from the served path (DEV cache-busts like the v86 loader does).
 */
export function init7z(): Promise<InitOutput> {
    if (!initPromise) {
        const url = import.meta.env?.DEV
            ? `${import.meta.env.BASE_URL}unpack-buffered.wasm?t=${Date.now()}`
            : `${import.meta.env.BASE_URL}unpack-buffered.wasm`;
        initPromise = init({ module_or_path: fetch(url) });
    }
    return initPromise;
}

/**
 * Extract every file from an in-memory 7z archive.
 *
 * @returns map of entry path → decompressed bytes (directories omitted).
 * @throws on unsupported coders (BCJ2 / PPMd / AES) with a clear message.
 */
export async function extract7z(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
    await init7z();
    const entries = extract_7z(bytes) as unknown as RawArchiveEntry[];
    const out = new Map<string, Uint8Array>();
    for (const e of entries) {
        out.set(e.name, e.data);
    }
    return out;
}

/**
 * Inflate a raw DEFLATE stream (no zlib/gzip header).
 *
 * @param expectedSize optional uncompressed size hint (pre-sizes the buffer).
 */
export async function inflateRaw(
    bytes: Uint8Array,
    expectedSize?: number,
): Promise<Uint8Array> {
    await init7z();
    return inflate_raw(bytes, expectedSize ?? undefined);
}

/**
 * Decode a raw LZMA1 stream with explicit parameters.
 *
 * @param props    5-byte LZMA props (lc/lp/pb + LE dict size) — or 1-byte
 *                 lc/lp/pb, in which case `dictSize` synthesises the dict bytes.
 * @param dictSize dictionary size (used when `props` is the 1-byte form).
 * @param data     compressed payload.
 * @param outSize  uncompressed output size.
 */
export async function lzmaDecode(
    props: Uint8Array,
    dictSize: number,
    data: Uint8Array,
    outSize: number | bigint,
): Promise<Uint8Array> {
    await init7z();
    return lzma_decode(props, dictSize, data, BigInt(outSize));
}
