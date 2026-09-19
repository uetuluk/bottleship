/**
 * VERSION.dll — GetFileVersionInfo* / VerQueryValue*.
 *
 * The app receives the file's real RT_VERSION blob: from the mapped image when the
 * file is a loaded module, from the on-disk PE otherwise. HLE system DLLs have no PE, so
 * they get a synthesized VS_VERSIONINFO stamped with the emulated OS / DirectX version.
 * Size queries return twice the blob (Wine's layout): VerQueryValueA converts strings
 * into the mirror half after the blob so several answers can stay live at once.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { System } from "../core/system";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { EmulatorConfig, VER_PLATFORM_WIN32_NT } from "../core/emulator-config-manager";
import { isUnderSystemDirectory } from "../core/hle-system-catalog";
import { findResourceInPE } from "./kernel32/resource";
import { encodeAnsi, readAnsiFromGuest } from "./codepage-utils";
import {
    buildVersionInfoBlob,
    findVersionResourceInFile,
    queryVersionValue,
    sliceMappedResource,
    versionBlobLength,
    VFT_APP,
    VFT_DLL,
    VFT_DRV,
    VFT_UNKNOWN,
    VOS__WINDOWS32,
    VOS_NT_WINDOWS32,
    type FixedFileInfo,
} from "./version-info";

const TRUE = 1;
const FALSE = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_RESOURCE_TYPE_NOT_FOUND = 1813;
const RT_VERSION = 16;
const VERSION_STR_BUF_A_SIZE = 0x400;
const BLOCK_SIZE_MEMO = 16;

const align4 = (n: number): number => (n + 3) & ~3;

const readWideZ = (mem: Uint8Array, ptr: number, maxChars = 260): string => {
    if (!ptr || ptr + 1 >= mem.length) return "";
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let out = "";
    for (let i = 0, addr = ptr; i < maxChars && addr + 1 < mem.length; i++, addr += 2) {
        const ch = view.getUint16(addr, true);
        if (ch === 0) break;
        out += String.fromCharCode(ch);
    }
    return out;
};

const readWideChars = (mem: Uint8Array, ptr: number, chars: number): string => {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let out = "";
    for (let i = 0; i < chars && ptr + i * 2 + 1 < mem.length; i++) {
        const ch = view.getUint16(ptr + i * 2, true);
        if (ch === 0) break;
        out += String.fromCharCode(ch);
    }
    return out;
};

type VersionSource =
    | { key: string; kind: "module"; base: number; name: string }
    | { key: string; kind: "file"; path: string }
    | { key: string; kind: "synthetic"; baseName: string; ext: string };

const DIRECTX_DLLS = new Set([
    "ddraw", "dsound", "dinput", "dinput8", "dplayx", "dplay", "dpwsockx", "d3d8", "d3d9",
    "d3dim", "d3dim700", "d3drm", "d3dxof", "dmusic", "dsetup", "dpnet", "dpnhpast", "dpnhupnp",
]);
const DIRECTX_FILE_VERSION = { ms: 0x00040009, ls: 0x00000388, text: "4.09.00.0904" }; // DX 9.0c
const D3DX9_FILE_VERSION = { ms: 0x0009001d, ls: 0x03b80c27, text: "9.29.952.3111" };

/** LoadLibrary-style lookup: mapped module → app dir / cwd / system dirs on the VFS → HLE. */
function resolveVersionSource(rawName: string): VersionSource | null {
    const system = System.getInstance();
    const name = rawName.trim().replace(/^"(.*)"$/, "$1").replace(/\//g, "\\");
    if (!name) return null;

    const mod = system.process?.moduleRegistry?.getByName(name);
    if (mod) return { key: `module:${mod.name}`, kind: "module", base: mod.baseAddress, name: mod.name };

    const vfs = system.fileSystem;
    const hasDir = name.includes("\\");
    const candidates: string[] = [];
    if (hasDir) {
        candidates.push(vfs.resolvePath(name));
    } else {
        const exeDir = system.executablePath.replace(/\\[^\\]*$/, "");
        candidates.push(`${exeDir}\\${name}`, vfs.resolvePath(name),
            `C:\\WINDOWS\\SYSTEM32\\${name}`, `C:\\WINDOWS\\SYSTEM\\${name}`, `C:\\WINDOWS\\${name}`);
    }
    for (const candidate of candidates) {
        const stored = vfs.resolveStoredFile(candidate);
        if (stored) return { key: `file:${stored.path.toLowerCase()}`, kind: "file", path: stored.path };
    }

    if (!hasDir || isUnderSystemDirectory(candidates[0].toLowerCase())) {
        const leaf = name.split("\\").pop() ?? name;
        const dot = leaf.lastIndexOf(".");
        const baseName = (dot > 0 ? leaf.slice(0, dot) : leaf).toLowerCase();
        const ext = (dot > 0 ? leaf.slice(dot + 1) : "dll").toLowerCase();
        return { key: `synthetic:${baseName}.${ext}`, kind: "synthetic", baseName, ext };
    }
    return null;
}

function synthesizeVersionBlob(baseName: string, ext: string): Uint8Array {
    const os = EmulatorConfig.getInstance().osVersion;
    const isNt = os.platformId === VER_PLATFORM_WIN32_NT;
    const fileType = ext === "exe" ? VFT_APP : ext === "dll" || ext === "ocx" ? VFT_DLL : ext === "drv" ? VFT_DRV : VFT_UNKNOWN;
    const isD3dx = /^d3dx9(_\d+)?$/.test(baseName);
    const isDirectX = isD3dx || DIRECTX_DLLS.has(baseName);
    let ms: number, ls: number, text: string;
    if (isD3dx) {
        ({ ms, ls, text } = D3DX9_FILE_VERSION);
    } else if (isDirectX) {
        ({ ms, ls, text } = DIRECTX_FILE_VERSION);
    } else {
        // Windows file versions are major.minor.build.revision; Win9x stamped 4.10.0.<build>.
        ms = ((os.major << 16) | (os.minor & 0xffff)) >>> 0;
        ls = isNt ? (os.build << 16) >>> 0 : os.build & 0xffff;
        text = isNt ? `${os.major}.${os.minor}.${os.build}.0` : `${os.major}.${os.minor}.0.${os.build}`;
    }
    const fixed: FixedFileInfo = {
        fileVersionMS: ms, fileVersionLS: ls, productVersionMS: ms, productVersionLS: ls,
        fileOS: isNt ? VOS_NT_WINDOWS32 : VOS__WINDOWS32, fileType,
    };
    const fileName = `${baseName}.${ext}`;
    return buildVersionInfoBlob(fixed, {
        CompanyName: "Microsoft Corporation",
        FileDescription: fileName,
        FileVersion: text,
        InternalName: baseName,
        LegalCopyright: "\u00a9 Microsoft Corporation. All rights reserved.",
        OriginalFilename: fileName,
        ProductName: isDirectX ? "Microsoft\u00ae DirectX for Windows\u00ae" : "Microsoft\u00ae Windows\u00ae Operating System",
        ProductVersion: text,
    });
}

export class Version implements IModule {
    name = "version";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;
    private versionStrBufA = 0;
    /** Resolved source key → blob (null = file present but no RT_VERSION). */
    private blobCache = new Map<string, Uint8Array | null>();
    /** pBlock → dwLen handed to GetFileVersionInfo, so VerQueryValueA knows the mirror half's bounds. */
    private blockSizes = new Map<number, number>();

    initialize(process: Process): void {
        this.process = process;
        this.versionStrBufA = process.memory.alloc(VERSION_STR_BUF_A_SIZE, "THUNK_DATA", "rw");

        const sizeImpl = (api: string, filename: string, lpdwHandle: number, mem: Uint8Array) => {
            if (lpdwHandle) Mem.writeUint32(lpdwHandle, 0);
            return this.withBlob(filename, mem, (blob) => {
                if (!blob) {
                    Logger.log(LogCategory.SYSTEM, `${api}("${filename}") -> 0 (no version resource)`);
                    return 0;
                }
                const size = align4(blob.length) * 2;
                Logger.verbose(LogCategory.SYSTEM, `${api}("${filename}") -> ${size}`);
                return size;
            });
        };
        const infoImpl = (api: string, filename: string, dwLen: number, lpData: number, mem: Uint8Array) => {
            if (!lpData) return FALSE;
            return this.withBlob(filename, mem, (blob) => {
                if (!blob) {
                    Logger.log(LogCategory.SYSTEM, `${api}("${filename}") -> FALSE (no version resource)`);
                    return FALSE;
                }
                const n = Math.min(dwLen >>> 0, blob.length);
                if (n > 0) Mem.writeBytes(lpData, blob.subarray(0, n));
                if (n < blob.length) {
                    System.getInstance().scheduler.setLastError(ERROR_INSUFFICIENT_BUFFER);
                    Logger.log(LogCategory.SYSTEM, `${api}("${filename}") len=${dwLen} < ${blob.length} -> FALSE`);
                    return FALSE;
                }
                this.rememberBlock(lpData, dwLen >>> 0);
                Logger.verbose(LogCategory.SYSTEM, `${api}("${filename}") -> TRUE (${blob.length} bytes)`);
                return TRUE;
            });
        };

        this.exports["GetFileVersionInfoSizeA"] = (ctx, mem, args) =>
            args[0] ? sizeImpl("GetFileVersionInfoSizeA", readAnsiFromGuest(mem, args[0]), args[1], mem) : 0;
        this.exports["GetFileVersionInfoSizeW"] = (ctx, mem, args) =>
            args[0] ? sizeImpl("GetFileVersionInfoSizeW", readWideZ(mem, args[0]), args[1], mem) : 0;
        this.exports["GetFileVersionInfoSizeExA"] = (ctx, mem, args) =>
            args[1] ? sizeImpl("GetFileVersionInfoSizeExA", readAnsiFromGuest(mem, args[1]), args[2], mem) : 0;
        this.exports["GetFileVersionInfoSizeExW"] = (ctx, mem, args) =>
            args[1] ? sizeImpl("GetFileVersionInfoSizeExW", readWideZ(mem, args[1]), args[2], mem) : 0;

        this.exports["GetFileVersionInfoA"] = (ctx, mem, args) =>
            args[0] ? infoImpl("GetFileVersionInfoA", readAnsiFromGuest(mem, args[0]), args[2], args[3], mem) : FALSE;
        this.exports["GetFileVersionInfoW"] = (ctx, mem, args) =>
            args[0] ? infoImpl("GetFileVersionInfoW", readWideZ(mem, args[0]), args[2], args[3], mem) : FALSE;
        this.exports["GetFileVersionInfoExA"] = (ctx, mem, args) =>
            args[1] ? infoImpl("GetFileVersionInfoExA", readAnsiFromGuest(mem, args[1]), args[3], args[4], mem) : FALSE;
        this.exports["GetFileVersionInfoExW"] = (ctx, mem, args) =>
            args[1] ? infoImpl("GetFileVersionInfoExW", readWideZ(mem, args[1]), args[3], args[4], mem) : FALSE;

        this.exports["VerQueryValueA"] = (ctx, mem, args) =>
            this.queryValue(mem, args[0], readAnsiFromGuest(mem, args[1], 512), args[2], args[3], false);
        this.exports["VerQueryValueW"] = (ctx, mem, args) =>
            this.queryValue(mem, args[0], readWideZ(mem, args[1], 512), args[2], args[3], true);
    }

    reset(): void {
        this.blobCache.clear();
        this.blockSizes.clear();
    }

    private rememberBlock(pBlock: number, dwLen: number): void {
        if (this.blockSizes.size >= BLOCK_SIZE_MEMO) {
            const oldest = this.blockSizes.keys().next().value;
            if (oldest !== undefined) this.blockSizes.delete(oldest);
        }
        this.blockSizes.set(pBlock >>> 0, dwLen);
    }

    /** Run `fn` on the file's blob; async only when the PE has to be read from the VFS. */
    private withBlob(filename: string, mem: Uint8Array, fn: (blob: Uint8Array | null) => number): number | Promise<number> {
        const source = resolveVersionSource(filename);
        if (!source) {
            System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
            Logger.log(LogCategory.SYSTEM, `version: "${filename}" not found`);
            return fn(null);
        }
        const cached = this.blobCache.get(source.key);
        if (cached !== undefined) return fn(cached);
        const finish = (blob: Uint8Array | null): number => {
            this.blobCache.set(source.key, blob);
            if (!blob) System.getInstance().scheduler.setLastError(ERROR_RESOURCE_TYPE_NOT_FOUND);
            return fn(blob);
        };
        switch (source.kind) {
            case "module": {
                const entry = findResourceInPE(mem, source.base, RT_VERSION, 1);
                return finish(entry ? sliceMappedResource(mem, entry.moduleBase, entry.dataRVA, entry.size) : null);
            }
            case "synthetic":
                return finish(synthesizeVersionBlob(source.baseName, source.ext));
            case "file": {
                const vfs = System.getInstance().fileSystem;
                const size = vfs.getFileSize(source.path);
                if (size <= 0) return finish(null);
                const GENERIC_READ = 0x80000000, OPEN_EXISTING = 3;
                return vfs.open(source.path, GENERIC_READ, OPEN_EXISTING)
                    .then(async (handle) => {
                        if (!handle) return finish(null);
                        return finish(findVersionResourceInFile(await vfs.read(handle, size)));
                    })
                    .catch((e: unknown) => {
                        Logger.warn(LogCategory.SYSTEM, `version: reading "${source.path}" failed: ${e}`);
                        return finish(null);
                    });
            }
        }
    }

    private queryValue(mem: Uint8Array, pBlock: number, subBlock: string, lplpBuffer: number, puLen: number, wide: boolean): number {
        if (!pBlock || !lplpBuffer) return FALSE;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const value = queryVersionValue(view, pBlock, subBlock);
        if (!value) {
            Logger.verbose(LogCategory.SYSTEM, `VerQueryValue${wide ? "W" : "A"}: "${subBlock}" -> FALSE`);
            return FALSE;
        }
        if (value.type !== 1 || wide) {
            Mem.writeUint32(lplpBuffer, value.offset);
            if (puLen) Mem.writeUint32(puLen, value.length);
            return TRUE;
        }
        // ANSI answer: the wide value's slot in the mirror half (half offset, half size) after the blob.
        const text = readWideChars(mem, value.offset, value.length);
        const bytes = encodeAnsi(text);
        const blobLen = align4(versionBlobLength(view, pBlock));
        const mirror = (pBlock + blobLen + ((value.offset - pBlock) >> 1)) >>> 0;
        const capacity = this.blockSizes.get(pBlock >>> 0) ?? 0;
        const fits = blobLen > 0 && mirror + bytes.length + 1 <= pBlock + capacity;
        const dest = fits ? mirror : this.versionStrBufA;
        if (!fits && bytes.length + 1 > VERSION_STR_BUF_A_SIZE) return FALSE;
        Mem.writeBytes(dest, bytes);
        Mem.writeUint8(dest + bytes.length, 0);
        Mem.writeUint32(lplpBuffer, dest);
        if (puLen) Mem.writeUint32(puLen, bytes.length + 1);
        Logger.verbose(LogCategory.SYSTEM, `VerQueryValueA: "${subBlock}" -> "${text}"`);
        return TRUE;
    }
}
