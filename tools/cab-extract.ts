#!/usr/bin/env bun
/**
 * cab-extract: Extract a Microsoft Cabinet (MSCF) — a bare `.cab` OR a cabinet
 * APPENDED to a Win32 stub (InstallShield "PackageForTheWeb" self-extractors,
 * `stub32i.exe`). Unwrapping a PFTW `.exe` yields the InstallShield disk images
 * (`data1.hdr` + `data{N}.cab` + `Setup.exe` + `setup.inx` …) that
 * `tools/unshield-extract.ts` then turns into the real game files.
 *
 * The cabinet LAYOUT + MSZIP driver live in the browser-safe core
 * (`packages/formats/src/cab/index.ts`); this CLI adds the Node-side fs + a
 * dictionary-capable sync zlib for MSZIP's cross-block preset dictionary.
 *
 * Usage:
 *   bun tools/cab-extract.ts <archive.exe|.cab> <out-dir> [--list] [--quiet]
 *
 * Supported compression: NONE, MSZIP and LZX. QUANTUM is rejected.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { inflateRawSync } from "zlib";
import { dirname, resolve, sep } from "path";
import { findCabinet, parseCabHeader, extractCabToMap, type CabInflateBlock } from "@bottleship/formats/cab";

const args = process.argv.slice(2);
if (args.length < 2) {
    console.error("Usage: bun tools/cab-extract.ts <archive.exe|.cab> <out-dir> [--list] [--quiet]");
    process.exit(1);
}
const [srcPath, outDir] = args as [string, string];
const list = args.includes("--list");
const quiet = args.includes("--quiet");

const buf = new Uint8Array(readFileSync(srcPath));
const off = findCabinet(buf);
if (off == null) {
    console.error("No Microsoft Cabinet (MSCF) found in input.");
    process.exit(1);
}
const info = parseCabHeader(buf, off)!;
console.log(
    `MSCF @${off} (0x${off.toString(16)})  cbCabinet=${info.cbCabinet}  folders=${info.folders.length}  files=${info.files.length}`,
);
for (const f of info.folders) {
    const m = ["NONE", "MSZIP", "QUANTUM", "LZX"][f.typeCompress & 0x0f] ?? "?";
    const win = (f.typeCompress & 0x0f) === 3 ? ` window=2^${f.typeCompress >> 8}` : "";
    console.log(`  folder: ${f.cCFData} blocks, compress=${m}${win}`);
}

if (list) {
    console.log("\nsize        folder  name");
    for (const f of info.files) console.log(`${String(f.size).padStart(10)}  ${String(f.folder).padStart(6)}  ${f.name}`);
    process.exit(0);
}

// MSZIP needs the previous block's last 32 KiB as the DEFLATE preset dictionary.
const inflateBlock: CabInflateBlock = (chunk, dictionary) =>
    new Uint8Array(inflateRawSync(chunk, dictionary ? { dictionary } : undefined));

const files = await extractCabToMap(buf, {
    inflateBlock,
    onProgress: (done, total, name) => {
        if (!quiet && done % 3 === 0) console.log(`  [${done}/${total}] ${name}`);
    },
    onFolderProgress: (done, total) => {
        // One LZX folder can be hundreds of MB and decodes before any file appears.
        if (!quiet && (done % (8 << 20) < 32768 || done === total)) {
            console.log(`  decompressing folder: ${(done / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB`);
        }
    },
}, info);

mkdirSync(outDir, { recursive: true });
const outRoot = resolve(outDir);
let bytes = 0;
for (const [name, data] of files) {
    const dest = resolve(outRoot, name);
    // Reject a cabinet entry whose name escapes the output dir (`..`, absolute).
    if (dest !== outRoot && !dest.startsWith(outRoot + sep)) {
        console.error(`Refusing to write outside ${outRoot}: ${name}`);
        process.exit(1);
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    bytes += data.length;
}
console.log(`\nDONE  extracted=${files.size} files  ${(bytes / 1048576).toFixed(1)} MB → ${outDir}`);
