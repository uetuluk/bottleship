/**
 * WGB build service (Stage 1) — split bundle *building* from *booting*.
 *
 * `loadBundle` (emulator.worker.ts) still owns the boot path; this module owns the
 * non-booting half: classify a dropped payload, extract/synthesize into a staged `.wgb`
 * under OPFS `bottleship/_wizard/<id>.wgb`, inspect an existing `.wgb`, and finalize a
 * (possibly edited) staged bundle to one of three destinations (play / library / download).
 *
 * It deliberately reuses the existing browser-callable building blocks rather than
 * re-implementing them: `installerToWgb` (Inno extract → synth → buildZip), `synthesizeManifest`
 * (manifest + registry), `buildZip` (store-only ZIP), `ZipArchive` (reader), `container-id`.
 *
 * Pure helpers (`detectFromBytes`, `classifySource`, `mergeManifest`, `unzipStored`) are exported
 * for unit tests; nothing here touches v86 or boots the guest.
 */

import {
    BufferSource,
    extractInnoToMap,
    MultiSliceReader,
    parseInnoHeader,
    parseSliceFile,
    type InnoParseResult,
    type SliceData,
} from "@bottleship/formats/inno";
import { UnpackDecoder } from "@bottleship/formats/unpack";
import { detectFormat, sniffBlobHead, type DetectedFormat } from "@bottleship/repack/detect";
import { installerToWgb } from "@bottleship/repack/installer-to-wgb";
import { buildZip } from "@bottleship/formats/wgb/zip-build";
import {
    guessCacheKey,
    parseGogGameInfo,
    synthesizeManifest,
    type SynthOptions,
} from "@bottleship/repack/manifest-synth";
import { loadOverrides, getOverride, setOverridesUrl, type GogOverridesDb } from "@bottleship/repack/overrides";
import { isGogJunk, detectExeFromPaths } from "@bottleship/repack/gog-filter";
import { detectInstallShield, extractInstallerFromFiles } from "@bottleship/repack/container-extract";
import { IsoImage, detectSectorLayout, extractIsoToMap } from "@bottleship/formats/iso";
import { extract7z } from "../archive/unpack-buffered";
import { ZipArchive, BufferSource as ZipBufferSource, unzipToMap, type ZipEntry } from "@bottleship/formats/zip";
import { resolveGameId, gameIdToContainerDir, manifestToWgbFilename } from "@bottleship/formats/wgb/container-id";
import { getBottleshipRoot } from "./container-store";
import { WgbCache } from "./wgb-cache";
import { Logger, LogCategory } from "../../core/logger";
import { asWriteChunk } from "../../../dom-buffer";

setOverridesUrl(`${import.meta.env?.BASE_URL ?? "/"}gog-overrides.json`);

// --- public types ----------------------------------------------------------------

export type SourceKind =
    | "wgb"
    | "gog-installer"
    | "installshield"
    | "archive-7z"
    | "iso9660"
    | "installer-zip"
    | "installer-sfx"
    | "game-folder"
    | "unknown";

/** Normalized build input. The worker maps the postMessage payload into one of these shapes. */
export interface BuildSource {
    /** Single dropped file (a `.wgb`, a GOG `setup.exe`, or a plain `.zip`). */
    blob?: Blob;
    /** Multi-part GOG installer: `setup.exe` + every `setup-*.bin` slice. */
    blobs?: File[];
    /** A folder of already-extracted game files (host-enumerated → rel-path → bytes). */
    files?: Map<string, Uint8Array>;
    /** Cached bundle URL (existing `.wgb` served from /apps/...). */
    url?: string;
    /** Manifest-synthesis overrides forwarded from the wizard form (name/exe/os/...). */
    cli?: SynthOptions["cli"];
}

export interface SourceDetection {
    kind: SourceKind;
    /** All `.exe` candidates discovered (so the wizard can disambiguate the entrypoint). */
    exeCandidates: string[];
    /** Best-guess entrypoint relative path (forward slashes), if one stands out. */
    suggestedEntrypoint?: string;
    /** GOG product id, when the payload carries a goggame-*.info. */
    gogGameId?: string;
    /** Human-readable note (e.g. multiple exes found, unsupported Inno version). */
    note?: string;
    /** Raw format the byte sniffer reported (debugging aid). */
    detectedFormat?: DetectedFormat;
}

export interface StagedEntry {
    name: string;
    size: number;
    isDirectory: boolean;
}

export interface BuildResult {
    /** OPFS path of the staged bundle, `bottleship/_wizard/<id>.wgb`. */
    stagedPath: string;
    manifest: Record<string, unknown>;
    entries: StagedEntry[];
    gameId: string;
    detections: SourceDetection;
}

export interface InspectResult {
    manifest: Record<string, unknown>;
    entries: StagedEntry[];
}

export type FinalizeDestination = "play" | "library" | "download";

export type FinalizeProgressFn = (percent: number, label: string) => void;

export interface FinalizeArgs {
    stagedPath: string;
    manifest: Record<string, unknown>;
    /** Optional edited registry (RegistrySeed | RegistrySeed[]); when omitted the staged one is kept. */
    registry?: unknown;
    /**
     * Inline-edited text files keyed by bundle entry path (e.g. `rom/Game/foo.ini`).
     * Their UTF-8 text overwrites the corresponding staged entry bytes before re-pack.
     */
    editedFiles?: Record<string, string>;
    destination: FinalizeDestination;
    onProgress?: FinalizeProgressFn;
}

export interface FinalizeResult {
    destination: FinalizeDestination;
    gameId: string;
    /** Final `.wgb` bytes (always returned for `download`; also handy for `play`). */
    bytes?: Uint8Array;
    /** OPFS cache key the library copy was persisted under (`library`). */
    cacheKey?: string;
    suggestedFilename: string;
}

export interface BuildProgress {
    phase: "reading" | "detecting" | "installing" | "unzipping" | "packing" | "staging" | "done";
    percent: number;
    label: string;
}

export type ProgressFn = (phase: BuildProgress["phase"], percent: number, label: string) => void;

const WIZARD_DIR = "_wizard";

// --- pure helpers (unit-tested) ---------------------------------------------------

/** Classify a single payload's leading bytes. Mirrors detect.ts but folds head + full sniff. */
export function detectFromBytes(data: Uint8Array): DetectedFormat {
    // A `.wgb` and a plain `.zip` both lead with PK\x03\x04 — detectFormat reports both as "wgb".
    return detectFormat(data);
}

/** True when a ZIP central directory holds a manifest.json (→ it's a finished `.wgb`, not a raw zip). */
export function looksLikeWgb(entryNames: Iterable<string>): boolean {
    for (const n of entryNames) {
        if (n === "manifest.json") return true;
    }
    return false;
}

/**
 * Collect `.exe` candidates + a suggested entrypoint from a set of relative paths
 * (forward slashes). Pure — drives the wizard's entrypoint disambiguation.
 */
export function collectExeDetections(paths: Iterable<string>): {
    exeCandidates: string[];
    suggestedEntrypoint?: string;
} {
    const list = [...paths].map((p) => p.replace(/\\/g, "/"));
    const exeCandidates = list.filter((p) => /\.exe$/i.test(p) && !isGogJunk(p));
    const suggestedEntrypoint = detectExeFromPaths(list) ?? exeCandidates[0];
    return { exeCandidates, suggestedEntrypoint };
}

/** Deep-merge `patch` onto `base` (plain objects merged, everything else replaced). Pure, immutable. */
export function mergeManifest(
    base: Record<string, unknown>,
    patch: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch)) {
        const cur = out[k];
        if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
            out[k] = mergeManifest(cur as Record<string, unknown>, v as Record<string, unknown>);
        } else if (v !== undefined) {
            out[k] = v;
        }
    }
    return out;
}

// `detectInstallShield` + the installer extraction recursion now live in
// `@bottleship/repack/container-extract` (shared with the headless `iso-to-wgb` CLI).
// Re-exported here for callers/tests that import it from the build service.
export { detectInstallShield };

/** 7z archive signature: `37 7A BC AF 27 1C`. */
function is7zHead(head: Uint8Array): boolean {
    return (
        head.length >= 6 &&
        head[0] === 0x37 &&
        head[1] === 0x7a &&
        head[2] === 0xbc &&
        head[3] === 0xaf &&
        head[4] === 0x27 &&
        head[5] === 0x1c
    );
}

/** Read every STORED (or DEFLATE) entry of a ZIP buffer into a rel-path → bytes Map. */
export const unzipStored = unzipToMap;

/**
 * Probe a PE executable for an appended/embedded ZIP archive — i.e. a self-extractor
 * (WinZip SFX, 7z-SFX-as-zip, …). Returns the inner entry names when present, else null.
 * `ZipArchive` locates the EOCD by scanning from the file end and recovers the stub prefix,
 * so this works regardless of how large the PE stub is. Never throws.
 */
export async function sfxZipEntries(data: Uint8Array): Promise<string[] | null> {
    try {
        const archive = new ZipArchive(new ZipBufferSource(data));
        await archive.init();
        const names = archive.listEntries().map((e) => e.name);
        return names.length ? names : null;
    } catch {
        return null;
    }
}

function entriesFromZip(zipEntries: ZipEntry[]): StagedEntry[] {
    return zipEntries.map((e) => ({
        name: e.name,
        size: e.uncompressedSize,
        isDirectory: e.isDirectory,
    }));
}

// --- WASM loader (Inno LZMA) ------------------------------------------------------

let _lzmaWasm: ArrayBuffer | null = null;
async function getLzmaWasm(): Promise<ArrayBuffer> {
    if (_lzmaWasm) return _lzmaWasm;
    const resp = await fetch(`${import.meta.env.BASE_URL}unpack-streaming.wasm`);
    _lzmaWasm = await resp.arrayBuffer();
    return _lzmaWasm;
}

// --- detection --------------------------------------------------------------------

/**
 * Classify a dropped payload. Reads only the bytes it needs (a 64-B head for blobs; the
 * full buffer when it must walk an Inno offsets table or a ZIP central directory).
 */
export async function detectSource(source: BuildSource): Promise<SourceDetection> {
    // Folder of already-extracted files.
    if (source.files) {
        const is = detectInstallShield(source.files.keys());
        if (is.stem) {
            return {
                kind: "installshield",
                exeCandidates: [],
                note: "InstallShield cabinet — extracting game files",
            };
        }
        const { exeCandidates, suggestedEntrypoint } = collectExeDetections(source.files.keys());
        const gog = parseGogGameInfo(source.files);
        return {
            kind: "game-folder",
            exeCandidates,
            suggestedEntrypoint,
            gogGameId: gog.gameId,
            note: exeCandidates.length > 1 ? `${exeCandidates.length} executables found` : undefined,
        };
    }

    // Multi-part GOG installer.
    if (source.blobs && source.blobs.length) {
        const exe = source.blobs.find((f) => !f.name.toLowerCase().endsWith(".bin"));
        if (!exe) return { kind: "unknown", exeCandidates: [], note: "no setup.exe among dropped files" };
        const data = new Uint8Array(await exe.arrayBuffer());
        const fmt = detectFromBytes(data);
        if (fmt === "inno") return { kind: "gog-installer", exeCandidates: [], detectedFormat: fmt };
        return {
            kind: "unknown",
            exeCandidates: [],
            detectedFormat: fmt,
            note: fmt === "inno-unsupported" ? "unsupported Inno Setup version" : "not a supported GOG installer",
        };
    }

    // Cached bundle URL — always a finished `.wgb`.
    if (source.url) {
        return { kind: "wgb", exeCandidates: [], detectedFormat: "wgb" };
    }

    // Single blob: head-sniff, then full classify.
    if (source.blob) {
        const head = new Uint8Array(await source.blob.slice(0, 64).arrayBuffer());
        // 7z archive (magic "7z\xBC\xAF\x27\x1C") — unwrap it, then re-detect the contents.
        if (is7zHead(head)) {
            return { kind: "archive-7z", exeCandidates: [], note: "7z archive — extracting" };
        }
        const headKind = sniffBlobHead(head);
        if (headKind === "wgb") {
            // PK — either a finished `.wgb` (has manifest.json) or a plain installer `.zip`.
            const data = new Uint8Array(await source.blob.arrayBuffer());
            const archive = new ZipArchive(new ZipBufferSource(data));
            await archive.init();
            const names = archive.listEntries().map((e) => e.name);
            if (looksLikeWgb(names)) {
                return { kind: "wgb", exeCandidates: [], detectedFormat: "wgb" };
            }
            const is = detectInstallShield(names);
            if (is.stem) {
                return {
                    kind: "installshield",
                    exeCandidates: [],
                    note: "InstallShield cabinet — extracting game files",
                };
            }
            const { exeCandidates, suggestedEntrypoint } = collectExeDetections(names);
            const gog = parseGogGameInfo(await zipToMap(archive));
            return {
                kind: "installer-zip",
                exeCandidates,
                suggestedEntrypoint,
                gogGameId: gog.gameId,
                note: exeCandidates.length > 1 ? `${exeCandidates.length} executables found` : undefined,
            };
        }
        if (headKind === "mz") {
            const data = new Uint8Array(await source.blob.arrayBuffer());
            const fmt = detectFromBytes(data);
            if (fmt === "inno") return { kind: "gog-installer", exeCandidates: [], detectedFormat: fmt };
            // Not Inno — maybe a self-extractor (WinZip SFX etc.): a PE stub with a ZIP
            // appended. Unwrap it like any other container and recurse into the payload.
            const sfxNames = await sfxZipEntries(data);
            if (sfxNames) {
                if (looksLikeWgb(sfxNames)) return { kind: "wgb", exeCandidates: [], detectedFormat: "wgb" };
                const { exeCandidates, suggestedEntrypoint } = collectExeDetections(sfxNames);
                return {
                    kind: "installer-sfx",
                    exeCandidates,
                    suggestedEntrypoint,
                    detectedFormat: fmt,
                    note: "self-extracting archive — extracting",
                };
            }
            return {
                kind: "unknown",
                exeCandidates: [],
                detectedFormat: fmt,
                note: fmt === "inno-unsupported" ? "unsupported Inno Setup version" : "executable is not an Inno installer",
            };
        }
        // No PK/MZ head magic — a disc image hides its filesystem at sector 16. Probe the
        // volume-descriptor region (covers every CD framing) without reading the whole disc.
        const isoProbe = new Uint8Array(await source.blob.slice(0, ISO_PROBE_BYTES).arrayBuffer());
        if (detectSectorLayout(new BufferSource(isoProbe))) {
            return { kind: "iso9660", exeCandidates: [], note: "disc image — mounting filesystem" };
        }
        return { kind: "unknown", exeCandidates: [], detectedFormat: "unknown" };
    }

    return { kind: "unknown", exeCandidates: [], note: "empty source" };
}

/**
 * Bytes to slice off a disc image for sector-layout detection. The first volume
 * descriptor sits at logical sector 16; the largest candidate framing (MODE2/2352)
 * puts its user-data window near byte 37 656, so 64 KiB safely covers all of them.
 */
const ISO_PROBE_BYTES = 64 * 1024;

async function zipToMap(archive: ZipArchive): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    for (const entry of archive.listEntries()) {
        if (entry.isDirectory) continue;
        // Only the small metadata files matter for detection; skip multi-MB payloads.
        const base = entry.name.split("/").pop() ?? "";
        if (/^goggame-.*\.(info|script)$/i.test(base)) out.set(entry.name, await archive.readEntry(entry));
    }
    return out;
}

// --- build ------------------------------------------------------------------------

/** Pack a rel-path → bytes Map of game files into a `.wgb` Map (manifest + registry + rom/*). */
function packGameFiles(
    gameFiles: Map<string, Uint8Array>,
    manifest: Record<string, unknown>,
    registry: unknown,
): Map<string, Uint8Array> {
    const files = new Map<string, Uint8Array>();
    files.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
    files.set("registry.json", new TextEncoder().encode(JSON.stringify(registry, null, 2)));
    for (const [rel, data] of gameFiles) {
        if (isGogJunk(rel)) continue;
        files.set(`rom/${rel.replace(/\\/g, "/")}`, data);
    }
    return files;
}

/**
 * Build a bundle from a "container" file map (an InstallShield/Inno installer's loose
 * files, a 7z payload, or a mounted disc tree). Recurse into any embedded installer via
 * the shared `extractInstallerFromFiles` seam, then synth + pack the resulting game tree.
 *
 * `containerFiles` are the pre-extraction files (used for SETUP.INI name detection); the
 * returned bundle is built from whatever the installer recursion yielded (or the same
 * files when no installer was present).
 */
async function buildFromContainer(
    containerFiles: Map<string, Uint8Array>,
    source: BuildSource,
    db: GogOverridesDb,
    detections: SourceDetection,
    onProgress: ProgressFn | undefined,
    installBasePct: number,
): Promise<{ wgbBytes: Uint8Array; manifest: Record<string, unknown>; gameId: string }> {
    const extracted = await extractInstallerFromFiles(containerFiles, {
        innoWasm: await getLzmaWasm(),
        onProgress: (pct, label) =>
            onProgress?.("installing", installBasePct + Math.round((pct / 100) * (78 - installBasePct)), label),
    });
    const gameFiles = extracted.gameFiles;

    onProgress?.("packing", 80, "Building bundle");
    const synth = synthFromFiles(gameFiles, withSynthName(source.cli, source, containerFiles), db);
    const manifest = synth.manifest;
    const gameId = resolveGameId(manifest as { gameId?: string; name?: string; entrypoint?: string });
    const wgbBytes = buildZip(packGameFiles(gameFiles, synth.manifest, synth.registry));

    detections.gogGameId = detections.gogGameId ?? synth.gameId;
    const ep = (manifest as { entrypoint?: string }).entrypoint;
    if (ep) detections.suggestedEntrypoint = ep;
    detections.exeCandidates = collectExeDetections(gameFiles.keys()).exeCandidates;
    if (extracted.via !== "none") detections.note = `extracted via ${extracted.note}`;
    return { wgbBytes, manifest, gameId };
}

/** Read `[Startup] AppName=` from a SETUP.INI among installer/extracted files, if present. */
function parseSetupIniAppName(files: Map<string, Uint8Array>): string | undefined {
    for (const [rel, data] of files) {
        const base = (rel.split(/[\\/]/).pop() ?? rel).toLowerCase();
        if (base === "setup.ini") {
            const text = new TextDecoder("latin1").decode(data.subarray(0, 4096));
            const m = text.match(/^\s*AppName\s*=\s*(.+?)\s*$/im);
            if (m && m[1]?.trim()) return m[1].trim();
        }
    }
    return undefined;
}

/** Worst-case display name: the source file's basename (sans extension). */
function sourceBaseName(source: BuildSource): string | undefined {
    let n: string | undefined;
    const named = source.blob as File | undefined;
    if (named && typeof named.name === "string") n = named.name;
    else if (source.blobs && source.blobs[0]) n = source.blobs[0].name;
    else if (source.url) n = source.url.split(/[?#]/)[0]!.split("/").pop();
    if (!n) return undefined;
    const stem = n.replace(/\.[^.]+$/, "").trim();
    return stem || undefined;
}

/**
 * Resolve the manifest display name with sensible fallbacks so we never emit the generic
 * "GOG Game" for a real drop: explicit cli.name → installer SETUP.INI AppName → source filename.
 */
function withSynthName(
    cli: SynthOptions["cli"] | undefined,
    source: BuildSource,
    iniFiles?: Map<string, Uint8Array>,
): SynthOptions["cli"] | undefined {
    if (cli?.name) return cli;
    const name = (iniFiles ? parseSetupIniAppName(iniFiles) : undefined) ?? sourceBaseName(source);
    return name ? { ...(cli ?? {}), name } : cli;
}

/** Synthesize a manifest+registry for a folder/zip of extracted game files (no Inno header). */
function synthFromFiles(
    gameFiles: Map<string, Uint8Array>,
    cli: SynthOptions["cli"] | undefined,
    db: GogOverridesDb,
): { manifest: Record<string, unknown>; registry: unknown; gameId?: string } {
    // synthesizeManifest needs a parsed Inno result; for raw files there isn't one. Build a
    // minimal stand-in (no Inno registry/icons) so the same synth path applies the same
    // entrypoint detection + override merge logic.
    const emptyParsed = {
        files: [],
        icons: [],
        registryEntries: [],
        header: { appName: undefined, appVersion: "" },
        version: { isUnicode: () => true },
    } as unknown as InnoParseResult;
    const gog = parseGogGameInfo(gameFiles);
    const override = getOverride(db, gog.gameId);
    const synth = synthesizeManifest({ parsed: emptyParsed, gameFiles, override, cli });
    return { manifest: synth.manifest, registry: synth.registry, gameId: synth.gameId };
}

/** Write a staged `.wgb` to OPFS `bottleship/_wizard/<id>.wgb` and return its path. */
async function writeStaged(id: string, bytes: Uint8Array): Promise<string> {
    const bs = await getBottleshipRoot(true);
    if (!bs) throw new Error("OPFS unavailable — cannot stage bundle");
    const wizard = await bs.getDirectoryHandle(WIZARD_DIR, { create: true });
    const key = `${gameIdToContainerDir(id)}.wgb`;
    const fh = await wizard.getFileHandle(key, { create: true });
    const createSah = (fh as unknown as { createSyncAccessHandle?: () => Promise<any> }).createSyncAccessHandle;
    if (typeof createSah === "function") {
        const sah = await createSah.call(fh);
        try {
            sah.truncate(0);
            let pos = 0;
            while (pos < bytes.byteLength) {
                const n = sah.write(bytes.subarray(pos), { at: pos });
                if (n <= 0) throw new Error("SAH short write");
                pos += n;
            }
            sah.flush();
        } finally {
            try { sah.close(); } catch { /* ignore */ }
        }
    } else {
        const w = await fh.createWritable();
        await w.write(asWriteChunk(bytes));
        await w.close();
    }
    return `${WIZARD_DIR}/${key}`;
}

/**
 * Build a staged (un-booted) `.wgb`: extract → synthesize manifest+registry → buildZip →
 * write to OPFS `bottleship/_wizard/<id>.wgb`. Posts progress via `onProgress`.
 */
export async function buildStagedBundle(source: BuildSource, onProgress?: ProgressFn): Promise<BuildResult> {
    onProgress?.("detecting", 0, "Inspecting source");
    const detections = await detectSource(source);
    const db = await loadOverrides();

    let wgbBytes: Uint8Array;
    let manifest: Record<string, unknown>;
    let gameId: string;

    if (detections.kind === "wgb") {
        // Passthrough: read the finished bundle's bytes + manifest, re-stage as-is.
        onProgress?.("reading", 10, "Reading bundle");
        const data = await readSourceBytes(source);
        const archive = new ZipArchive(new ZipBufferSource(data));
        await archive.init();
        const manEntry = archive.getEntry("manifest.json");
        if (!manEntry) throw new Error("not a WGB bundle (no manifest.json)");
        manifest = JSON.parse(new TextDecoder().decode(await archive.readEntry(manEntry)));
        gameId = resolveGameId(manifest as { gameId?: string; name?: string; entrypoint?: string });
        wgbBytes = data;
        onProgress?.("packing", 90, "Staging");
    } else if (detections.kind === "gog-installer") {
        // Inno installer (single or multi-part) — reuse installerToWgb end to end.
        onProgress?.("installing", 0, "Extracting installer");
        const wasm = await getLzmaWasm();
        const lzma = new UnpackDecoder();
        await lzma.init(wasm);

        let parsed: InnoParseResult;
        let setupBytes: Uint8Array;
        let sliceSource: MultiSliceReader | undefined;

        if (source.blobs && source.blobs.length) {
            const exe = source.blobs.find((f) => !f.name.toLowerCase().endsWith(".bin"))!;
            const bins = source.blobs.filter((f) => f.name.toLowerCase().endsWith(".bin"));
            setupBytes = new Uint8Array(await exe.arrayBuffer());
            parsed = await parseInnoHeader(new BufferSource(setupBytes), lzma);
            // Natural-sort the slices by their `-N[letter].bin` ordinal.
            const ordered = [...bins].sort((a, b) => sliceOrdinal(a.name) - sliceOrdinal(b.name));
            const sliceData: SliceData[] = [];
            for (const f of ordered) sliceData.push(parseSliceFile(new Uint8Array(await f.arrayBuffer())));
            sliceSource = new MultiSliceReader(sliceData);
        } else {
            setupBytes = await readSourceBytes(source);
            parsed = await parseInnoHeader(new BufferSource(setupBytes), lzma);
        }

        const result = await installerToWgb({
            source: new BufferSource(setupBytes),
            wasmBytes: wasm,
            parsed,
            sliceSource,
            overrides: db,
            synth: source.cli,
            onProgress: (p) => {
                const pct = p.totalBytes > 0 ? Math.round((p.doneBytes / p.totalBytes) * 100) : 0;
                onProgress?.("installing", pct, p.phase);
            },
        });
        wgbBytes = result.wgb;
        const archive = new ZipArchive(new ZipBufferSource(wgbBytes));
        await archive.init();
        manifest = JSON.parse(new TextDecoder().decode(await archive.readEntry(archive.getEntry("manifest.json")!)));
        gameId = resolveGameId(manifest as { gameId?: string; name?: string; entrypoint?: string });
        // Carry the GOG id detection forward from the synthesized manifest.
        detections.gogGameId = detections.gogGameId ?? result.gameId;
    } else if (detections.kind === "installshield") {
        // InstallShield 5/6 cabinet (inside a zip, or a folder of installer files) →
        // recurse into the installer (data*.hdr+data*.cab → real game tree), then synth
        // from THOSE files (not the raw installer scaffolding).
        let installerFiles: Map<string, Uint8Array>;
        if (source.files) {
            installerFiles = source.files;
        } else {
            onProgress?.("unzipping", 0, "Unzipping installer");
            installerFiles = await unzipStored(await readSourceBytes(source));
        }
        onProgress?.("installing", 10, "Extracting installer");
        ({ wgbBytes, manifest, gameId } = await buildFromContainer(installerFiles, source, db, detections, onProgress, 10));
    } else if (detections.kind === "archive-7z") {
        // 7z archive (e.g. archive.org demo) → unwrap via the unpack-buffered wasm lib, then
        // recurse one level: the payload is usually an InstallShield/Inno installer,
        // sometimes a raw game tree.
        onProgress?.("unzipping", 0, "Extracting 7z archive");
        const extracted = await extract7z(await readSourceBytes(source));
        onProgress?.("installing", 10, "Extracting installer");
        ({ wgbBytes, manifest, gameId } = await buildFromContainer(extracted, source, db, detections, onProgress, 10));
    } else if (detections.kind === "installer-sfx") {
        // Self-extracting archive (WinZip SFX etc.) → unwrap the embedded ZIP, then recurse:
        // the payload is usually an installer (e.g. an EA `compressed.zip` + `common_filelist.txt`),
        // occasionally a raw game tree (packaged as-is).
        onProgress?.("unzipping", 0, "Extracting self-extractor");
        const sfxFiles = await unzipStored(await readSourceBytes(source));
        onProgress?.("installing", 10, "Checking installer payload");
        ({ wgbBytes, manifest, gameId } = await buildFromContainer(sfxFiles, source, db, detections, onProgress, 10));
    } else if (detections.kind === "iso9660") {
        // CD/DVD image → mount the ISO9660 filesystem, then recurse: a disc is just
        // another container, usually holding an InstallShield/Inno installer (run it),
        // occasionally a pre-installed game tree (package as-is).
        onProgress?.("reading", 0, "Reading disc image");
        const discBytes = await readSourceBytes(source);
        const image = IsoImage.mount(new BufferSource(discBytes));
        onProgress?.("unzipping", 5, `Mounting disc filesystem (${image.layout.label})`);
        const discFiles = extractIsoToMap(image);
        onProgress?.("installing", 10, "Checking disc for installer");
        ({ wgbBytes, manifest, gameId } = await buildFromContainer(discFiles, source, db, detections, onProgress, 10));
    } else if (detections.kind === "installer-zip" || detections.kind === "game-folder") {
        // Plain zip / folder of extracted files → unzip (if needed) → synth → buildZip.
        let gameFiles: Map<string, Uint8Array>;
        if (detections.kind === "game-folder") {
            gameFiles = source.files!;
        } else {
            onProgress?.("unzipping", 0, "Unzipping");
            gameFiles = await unzipStored(await readSourceBytes(source));
        }
        onProgress?.("packing", 60, "Building bundle");
        const synth = synthFromFiles(gameFiles, withSynthName(source.cli, source, gameFiles), db);
        manifest = synth.manifest;
        gameId = resolveGameId(manifest as { gameId?: string; name?: string; entrypoint?: string });
        wgbBytes = buildZip(packGameFiles(gameFiles, synth.manifest, synth.registry));
        detections.gogGameId = detections.gogGameId ?? synth.gameId;
    } else {
        throw new Error(`unsupported source: ${detections.note ?? detections.kind}`);
    }

    onProgress?.("staging", 95, "Writing staged bundle");
    const stagedPath = await writeStaged(gameId, wgbBytes);

    // List the staged bundle's entries for the wizard's content tree.
    const archive = new ZipArchive(new ZipBufferSource(wgbBytes));
    await archive.init();
    const entries = entriesFromZip(archive.listEntries());

    onProgress?.("done", 100, "Ready");
    Logger.log(LogCategory.SYSTEM, `WGB build: staged "${stagedPath}" gameId="${gameId}" (${entries.length} entries)`);
    return { stagedPath, manifest, entries, gameId, detections };
}

/** Inspect an existing `.wgb` (list entries + read manifest.json) WITHOUT a full extraction. */
export async function inspectBundle(source: BuildSource): Promise<InspectResult> {
    const data = await readSourceBytes(source);
    const archive = new ZipArchive(new ZipBufferSource(data));
    await archive.init();
    const manEntry = archive.getEntry("manifest.json");
    if (!manEntry) throw new Error("not a WGB bundle (no manifest.json)");
    const manifest = JSON.parse(new TextDecoder().decode(await archive.readEntry(manEntry)));
    return { manifest, entries: entriesFromZip(archive.listEntries()) };
}

/**
 * Read a single entry's raw bytes out of a staged `.wgb` (for the wizard's inline text
 * editor). `name` is the bundle entry path (e.g. `rom/Game/foo.ini`). Throws if the
 * staged bundle or the entry is missing.
 */
export async function readStagedEntry(stagedPath: string, name: string): Promise<Uint8Array> {
    const staged = await readStaged(stagedPath);
    const archive = new ZipArchive(new ZipBufferSource(staged));
    await archive.init();
    const entry = archive.getEntry(name);
    if (!entry) throw new Error(`entry "${name}" not found in staged bundle`);
    return archive.readEntry(entry);
}

/**
 * Finalize a staged bundle: read its entries, swap the (possibly edited) manifest.json /
 * registry.json, re-pack, and route by destination.
 *   - `play`     → return bytes (the caller hands them to loadBundle({data})).
 *   - `library`  → persist into the OPFS WGB cache (keyed by gameId container dir).
 *   - `download` → return bytes for the host to save (showSaveFilePicker / anchor download).
 */
export async function finalizeBundle(args: FinalizeArgs): Promise<FinalizeResult> {
    const report = (percent: number, label: string) => args.onProgress?.(percent, label);

    report(0, "Reading staged bundle…");
    const staged = await readStaged(args.stagedPath);
    const archive = new ZipArchive(new ZipBufferSource(staged));
    await archive.init();

    const files = new Map<string, Uint8Array>();
    const fileEntries = archive.listEntries().filter((e) => !e.isDirectory);
    for (let i = 0; i < fileEntries.length; i++) {
        const entry = fileEntries[i]!;
        files.set(entry.name, await archive.readEntry(entry));
        if (fileEntries.length > 0) {
            const pct = Math.round(((i + 1) / fileEntries.length) * 45);
            report(pct, `Reading files (${i + 1}/${fileEntries.length})…`);
        }
    }

    // Swap the edited manifest (always) and registry (when provided).
    files.set("manifest.json", new TextEncoder().encode(JSON.stringify(args.manifest, null, 2)));
    if (args.registry !== undefined) {
        files.set("registry.json", new TextEncoder().encode(JSON.stringify(args.registry, null, 2)));
    }
    // Overwrite any inline-edited text files with their new UTF-8 bytes (only entries that
    // actually exist in the staged bundle; an unknown key is ignored rather than injected).
    if (args.editedFiles) {
        const enc = new TextEncoder();
        for (const [path, text] of Object.entries(args.editedFiles)) {
            if (files.has(path)) files.set(path, enc.encode(text));
        }
    }

    report(50, "Building package…");
    const bytes = buildZip(files);
    const gameId = resolveGameId(args.manifest as { gameId?: string; name?: string; entrypoint?: string });
    const suggestedFilename = manifestToWgbFilename(args.manifest as { gameId?: string; name?: string; entrypoint?: string });

    if (args.destination === "library") {
        const cacheKey = `${gameIdToContainerDir(gameId)}.wgb`;
        report(60, "Saving to library…");
        await WgbCache.put(cacheKey, bytes);
        report(100, "Done");
        Logger.log(LogCategory.SYSTEM, `WGB finalize: persisted "${cacheKey}" to library (${bytes.byteLength} bytes)`);
        return { destination: "library", gameId, cacheKey, bytes, suggestedFilename };
    }

    report(55, "Package ready");
    // play + download both hand the bytes back to the caller.
    return { destination: args.destination, gameId, bytes, suggestedFilename };
}

// --- source byte readers ----------------------------------------------------------

async function readSourceBytes(source: BuildSource): Promise<Uint8Array> {
    if (source.blob) return new Uint8Array(await source.blob.arrayBuffer());
    if (source.url) {
        const cached = await WgbCache.get(source.url);
        if (cached) return cached;
        const resp = await fetch(source.url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${source.url}`);
        return new Uint8Array(await resp.arrayBuffer());
    }
    throw new Error("source has no readable bytes (expected blob or url)");
}

async function readStaged(stagedPath: string): Promise<Uint8Array> {
    const bs = await getBottleshipRoot(false);
    if (!bs) throw new Error("OPFS unavailable — cannot read staged bundle");
    // stagedPath is "<WIZARD_DIR>/<key>".
    const slash = stagedPath.indexOf("/");
    const dirName = slash >= 0 ? stagedPath.slice(0, slash) : WIZARD_DIR;
    const key = slash >= 0 ? stagedPath.slice(slash + 1) : stagedPath;
    const dir = await bs.getDirectoryHandle(dirName);
    const fh = await dir.getFileHandle(key);
    return new Uint8Array(await (await fh.getFile()).arrayBuffer());
}

// --- slice ordering (multi-part GOG) ----------------------------------------------

/** Natural slice ordinal from a `-<major>[<letter>].bin` suffix. Matches emulator.worker.ts. */
function sliceOrdinal(name: string): number {
    const m = name.toLowerCase().match(/-(\d+)([a-z])?\.bin$/);
    if (!m) return 0;
    return parseInt(m[1]!, 10) * 100 + (m[2] ? m[2].charCodeAt(0) - 97 : 0);
}

// Re-export for the cache-key guess (used by callers that want to dedupe Inno builds).
export { guessCacheKey };
