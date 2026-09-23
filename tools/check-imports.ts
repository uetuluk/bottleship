#!/usr/bin/env bun
/**
 * check-imports: bring-up preflight — list every PE import we cannot generate a
 * correct stdcall stub for, in ONE pass.
 *
 * The PE loader refuses to guess: an imported stdcall function with no argCount
 * (and no `@N` decoration) aborts the whole load ("Stub requires argCount or
 * stackCleanupBytes"). Booting a new game therefore surfaces exactly ONE missing
 * symbol per run — a ~30s round trip each. This tool resolves the entire import
 * table against the same sources the worker's APIRegistry uses (every
 * `src/worker/api/*.api.ts` descriptor + `tools/reference/win32/**.sig.json`) and
 * prints the full gap list up front.
 *
 * It also reports imports that resolve but have no JS implementation behind them
 * (`--stubs`): those load fine and then return garbage at runtime, which is the
 * usual cause of a game "gracefully vanishing" (see CLAUDE.md, `stubs()`).
 *
 * Usage:
 *   bun tools/check-imports.ts <file.exe|file.dll|bundle.wgb> [--stubs] [--all]
 *     --stubs   also list resolvable imports with no implementation in src/worker/modules
 *     --all     list every import, resolved or not
 *
 * A .wgb argument checks the bundle's entrypoint plus every PE inside it.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename, extname } from "path";
import { calculateStackCleanup, type ModuleDescriptor } from "../src/worker/api/types";
import { REFERENCE_ARG_COUNTS } from "../src/worker/reference-argcounts.generated";
import { unzipToMap } from "@bottleship/formats/zip";

// ---------------------------------------------------------------------------
// PE import table
// ---------------------------------------------------------------------------

interface PeImport {
    dll: string;
    /** Import name, or `ord_<N>` for an import-by-ordinal. */
    name: string;
    ordinal: number | null;
}

/** Parse the import directory of a 32-bit PE. Returns null when `buf` is not a PE. */
function parseImports(buf: Uint8Array): PeImport[] | null {
    if (buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const peOff = dv.getUint32(0x3c, true);
    if (peOff + 0xf8 > buf.length || dv.getUint32(peOff, true) !== 0x00004550) return null;

    const numSections = dv.getUint16(peOff + 6, true);
    const optSize = dv.getUint16(peOff + 20, true);
    const optOff = peOff + 24;
    if (dv.getUint16(optOff, true) !== 0x10b) return null; // PE32 only

    const sections: Array<{ va: number; vs: number; raw: number; rawSize: number }> = [];
    const secOff = optOff + optSize;
    for (let i = 0; i < numSections; i++) {
        const s = secOff + i * 40;
        if (s + 40 > buf.length) break;
        sections.push({
            va: dv.getUint32(s + 12, true),
            vs: dv.getUint32(s + 8, true),
            raw: dv.getUint32(s + 20, true),
            rawSize: dv.getUint32(s + 16, true),
        });
    }
    const toFile = (rva: number): number => {
        for (const s of sections) {
            const size = Math.max(s.vs, s.rawSize);
            if (rva >= s.va && rva < s.va + size) return s.raw + (rva - s.va);
        }
        return -1;
    };
    const cstr = (off: number): string => {
        if (off < 0 || off >= buf.length) return "";
        let e = off;
        while (e < buf.length && buf[e] !== 0) e++;
        return new TextDecoder("latin1").decode(buf.subarray(off, e));
    };

    const impRva = dv.getUint32(optOff + 96 + 8, true); // DataDirectory[1] = import table
    if (!impRva) return [];
    let d = toFile(impRva);
    if (d < 0) return [];

    const out: PeImport[] = [];
    for (; d + 20 <= buf.length; d += 20) {
        const origFirstThunk = dv.getUint32(d, true);
        const nameRva = dv.getUint32(d + 12, true);
        const firstThunk = dv.getUint32(d + 16, true);
        if (!nameRva && !firstThunk && !origFirstThunk) break;

        const dll = cstr(toFile(nameRva)).toLowerCase().replace(/\.dll$/, "");
        let t = toFile(origFirstThunk || firstThunk);
        if (t < 0) continue;
        for (; t + 4 <= buf.length; t += 4) {
            const entry = dv.getUint32(t, true);
            if (entry === 0) break;
            if (entry & 0x80000000) {
                const ord = entry & 0xffff;
                out.push({ dll, name: `ord_${ord}`, ordinal: ord });
            } else {
                out.push({ dll, name: cstr(toFile(entry) + 2), ordinal: null });
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// The same resolution sources the worker's APIRegistry uses
// ---------------------------------------------------------------------------

/** module → lowercased function name → argCount (dword slots). */
type ArgMap = Map<string, Map<string, number>>;

async function loadApiDescriptors(): Promise<{ args: ArgMap; byOrdinal: Map<string, Map<number, number>>; textOnly: Map<string, Set<string>> }> {
    const apiDir = join(import.meta.dir, "../src/worker/api");
    const args: ArgMap = new Map();
    const byOrdinal = new Map<string, Map<number, number>>();

    const record = (mod: string, d: ModuleDescriptor) => {
        const fns = args.get(mod) ?? new Map<string, number>();
        const ords = byOrdinal.get(mod) ?? new Map<number, number>();
        for (const f of d.functions) {
            const slots = (f.stackCleanupBytes ?? calculateStackCleanup(f.params)) >> 2;
            fns.set(f.name.toLowerCase(), slots);
            if (typeof f.ordinal === "number") ords.set(f.ordinal, slots);
        }
        args.set(mod, fns);
        byOrdinal.set(mod, ords);
    };

    const skipped: string[] = [];
    // Descriptors we could only read as text (see below) — name-presence only, no argCount.
    const textOnly = new Map<string, Set<string>>();
    for (const file of readdirSync(apiDir)) {
        if (!file.endsWith(".api.ts") && file !== "kernel32-vista-supplement.ts") continue;
        let mod: Record<string, unknown>;
        try {
            // A few descriptors pull in worker modules whose module-init order only
            // works under Vite; they are reported rather than silently dropped.
            mod = await import(join(apiDir, file));
        } catch (e) {
            skipped.push(`${file} (${(e as Error).message.split("\n")[0]})`);
            // Fall back to a textual scan so its exports still count as "declared":
            // the argCount is unavailable, but a listed name is one the loader resolves.
            const names = new Set<string>();
            for (const m of readFileSync(join(apiDir, file), "utf8").matchAll(/makeFunc\(\s*["'`]([^"'`]+)["'`]|\bname:\s*["'`]([A-Za-z_][\w@$]*)["'`]/g)) {
                names.add((m[1] ?? m[2]!).toLowerCase());
            }
            textOnly.set(file.replace(/\.api\.ts$/, "").toLowerCase(), names);
            continue;
        }
        for (const key of Object.keys(mod)) {
            const obj = mod[key];
            if (obj && typeof obj === "object" && "name" in obj && "functions" in obj) {
                record(String(obj.name).toLowerCase(), obj as ModuleDescriptor);
            }
        }
    }
    if (skipped.length > 0) {
        console.warn(`note: ${skipped.length} descriptor file(s) only readable as text (names counted, argCounts unverified):`);
        for (const s of skipped) console.warn(`  ${s}`);
    }

    // tools/reference/win32/**.sig.json — the argCount fallback for non-thunked DLLs.
    for (const [mod, fns] of Object.entries(REFERENCE_ARG_COUNTS)) {
        const target = args.get(mod) ?? new Map<string, number>();
        for (const [name, count] of Object.entries(fns)) {
            if (!target.has(name)) target.set(name, count as number);
        }
        args.set(mod, target);
    }

    return { args, byOrdinal, textOnly };
}

/** Mirrors APIRegistry.getArgCount: exact → A/W-stripped → any module → `@N` decoration. */
function resolveArgCount(args: ArgMap, imp: PeImport): number | undefined {
    const fns = args.get(imp.dll);
    const name = imp.name.toLowerCase();
    if (fns) {
        const exact = fns.get(name);
        if (exact !== undefined) return exact;
        const base = imp.name.replace(/[WA]$/, "").toLowerCase();
        const stripped = fns.get(base);
        if (stripped !== undefined) return stripped;
    }
    for (const [, m] of args) {
        const any = m.get(name);
        if (any !== undefined) return any;
    }
    const decorated = imp.name.match(/@(\d+)$/);
    if (decorated) {
        const bytes = parseInt(decorated[1]!, 10);
        if (bytes >= 0 && bytes % 4 === 0) return bytes / 4;
    }
    return undefined;
}

/** Function names that appear as `exports["Name"]` anywhere under src/worker/modules. */
function loadImplementedNames(): Set<string> {
    const root = join(import.meta.dir, "../src/worker/modules");
    const found = new Set<string>();
    const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!e.name.endsWith(".ts")) continue;
            const src = readFileSync(p, "utf8");
            for (const m of src.matchAll(/exports\[\s*["'`]([A-Za-z_@$][\w@$]*)["'`]\s*\]/g)) {
                found.add(m[1]!.toLowerCase());
            }
        }
    };
    walk(root);
    return found;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith("--"));
if (!target || !existsSync(target)) {
    console.error("Usage: bun tools/check-imports.ts <file.exe|file.dll|bundle.wgb> [--stubs] [--all]");
    process.exit(1);
}
const showStubs = argv.includes("--stubs");
const showAll = argv.includes("--all");

/** label → PE bytes. A .wgb expands to every PE it contains. */
const targets = new Map<string, Uint8Array>();
if (extname(target).toLowerCase() === ".wgb") {
    for (const [name, data] of await unzipToMap(new Uint8Array(readFileSync(target)))) {
        if (!/\.(exe|dll|ocx)$/i.test(name)) continue;
        targets.set(name, data);
    }
} else {
    targets.set(basename(target), new Uint8Array(readFileSync(target)));
}

const { args, byOrdinal, textOnly } = await loadApiDescriptors();
const implemented = showStubs ? loadImplementedNames() : new Set<string>();

let blocking = 0;
let stubbed = 0;
for (const [label, bytes] of targets) {
    const imports = parseImports(bytes);
    if (!imports) { console.log(`${label}: not a 32-bit PE, skipped`); continue; }

    const missing: PeImport[] = [];
    const noImpl: PeImport[] = [];
    for (const imp of imports) {
        const resolved = imp.ordinal !== null
            ? (byOrdinal.get(imp.dll)?.get(imp.ordinal) ?? resolveArgCount(args, imp))
            : resolveArgCount(args, imp);
        const declaredAsText = textOnly.get(imp.dll)?.has(imp.name.toLowerCase()) ?? false;
        if (resolved === undefined && !declaredAsText) missing.push(imp);
        else if (showStubs && !implemented.has(imp.name.toLowerCase())) noImpl.push(imp);
    }

    console.log(`\n${label}: ${imports.length} imports from ${new Set(imports.map((i) => i.dll)).size} DLLs`);
    if (showAll) for (const i of imports) console.log(`    ${i.dll}:${i.name}`);

    if (missing.length === 0) {
        console.log("  ✓ every import resolves to an argCount — the PE loader can build all stubs");
    } else {
        blocking += missing.length;
        console.log(`  ✗ ${missing.length} import(s) WILL ABORT the PE load (no argCount):`);
        for (const i of missing) console.log(`      ${i.dll}:${i.name}`);
    }
    if (noImpl.length > 0) {
        stubbed += noImpl.length;
        console.log(`  ! ${noImpl.length} import(s) resolve but have no JS implementation (return garbage at runtime):`);
        for (const i of noImpl) console.log(`      ${i.dll}:${i.name}`);
    }
}

console.log(
    `\n${blocking === 0 ? "OK" : "BLOCKED"}: ${blocking} unresolvable import(s)` +
    (showStubs ? `, ${stubbed} unimplemented` : ""),
);
process.exit(blocking === 0 ? 0 : 1);
