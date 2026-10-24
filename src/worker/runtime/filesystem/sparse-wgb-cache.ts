import { hasZipEocd } from "./wgb-cache-integrity";
import type { SyncAccessHandleLike } from "@bottleship/formats/zip";
import { WgbCache } from "./wgb-cache";
import { sameWgbVersion, urlToCacheKey, type WgbVersion } from "./wgb-cache-identity";

type SyncFile = FileSystemFileHandle & {
    createSyncAccessHandle(): Promise<SyncAccessHandleLike>;
    move?(name: string): Promise<void>;
};

function writeAll(handle: SyncAccessHandleLike, bytes: Uint8Array, at: number): void {
    let written = 0;
    while (written < bytes.length) {
        const n = handle.write(bytes.subarray(written), { at: at + written });
        if (n <= 0) throw new Error("Sparse WGB cache short write");
        written += n;
    }
}

function readAll(handle: SyncAccessHandleLike, bytes: Uint8Array, at: number): void {
    let read = 0;
    while (read < bytes.length) {
        const n = handle.read(bytes.subarray(read), { at: at + read });
        if (n <= 0) throw new Error(`Sparse WGB cache truncated at ${at + read}`);
        read += n;
    }
}

/** Only flushed disk chunks publish residency. RAM eviction can never invalidate a bit. */
export class SparseWgbCache {
    private complete = false;
    private bitmapOffset = 0;
    private downloaded = 0;
    private promotion: Promise<boolean> | null = null;
    private readonly slots: Uint32Array;
    private readonly slotBytes = new Uint8Array(4);
    private readonly slotView = new DataView(this.slotBytes.buffer);

    private constructor(
        readonly version: WgbVersion, readonly chunkBytes: number,
        private readonly dir: FileSystemDirectoryHandle,
        private disk: SyncAccessHandleLike, private readonly bitmap: SyncAccessHandleLike,
        private readonly residency: Int32Array,
    ) {
        this.slots = new Uint32Array(Math.ceil(version.size / chunkBytes));
    }

    static async open(version: WgbVersion, chunkBytes: number, residency: Int32Array,
        directory?: FileSystemDirectoryHandle): Promise<SparseWgbCache | null> {
        // A mutable URL with no strong validator cannot safely resume old chunks.
        if (!version.etag || version.etag.startsWith("W/")) return null;
        let disk: SyncAccessHandleLike | undefined;
        let bitmap: SyncAccessHandleLike | undefined;
        try {
            const key = urlToCacheKey(version.url);
            const dir = directory ?? await WgbCache.prepareSparseCache(version.size, key);
            if (!dir) return null;
            const file = await dir.getFileHandle(`${key}.sparse`, { create: true }) as SyncFile;
            disk = await file.createSyncAccessHandle();
            const bitFile = await dir.getFileHandle(`${key}.bitmap`, { create: true }) as SyncFile;
            bitmap = await bitFile.createSyncAccessHandle();
            const cache = new SparseWgbCache(version, chunkBytes, dir, disk, bitmap, residency);
            cache.restore();
            return cache;
        } catch {
            // Initialization has not published this SAB to the guest yet.
            residency.fill(0);
            try { disk?.close(); } catch {}
            try { bitmap?.close(); } catch {}
            return null;
        }
    }

    private restore(): void {
        this.residency.fill(0);
        let valid = false;
        try {
            const lengthBytes = new Uint8Array(4);
            if (this.bitmap.read(lengthBytes, { at: 0 }) === 4) {
                const length = new DataView(lengthBytes.buffer).getUint32(0, true);
                if (length > 0 && length < 16_384 && this.bitmap.getSize() === 4 + length + this.slots.byteLength) {
                    const json = new Uint8Array(length);
                    if (this.bitmap.read(json, { at: 4 }) !== length) throw new Error("short metadata");
                    const info = JSON.parse(new TextDecoder().decode(json));
                    valid = sameWgbVersion(info, this.version) && info.chunkBytes === this.chunkBytes
                        && info.layout === "packed-v1";
                    this.bitmapOffset = 4 + length;
                    if (valid) {
                        const raw = new Uint8Array(this.slots.byteLength);
                        readAll(this.bitmap, raw, this.bitmapOffset);
                        const view = new DataView(raw.buffer);
                        const occupied = new Uint8Array(this.chunkCount);
                        const size = this.disk.getSize();
                        let maxSlot = 0, extent = 0;
                        for (let ci = 0; ci < this.chunkCount; ci++) {
                            const slot = view.getUint32(ci * 4, true);
                            this.slots[ci] = slot;
                            if (!slot) continue;
                            const end = (slot - 1) * this.chunkBytes + this.chunkSize(ci);
                            if (slot > this.chunkCount || occupied[slot - 1] || end > size) {
                                valid = false; break;
                            }
                            occupied[slot - 1] = 1;
                            maxSlot = Math.max(maxSlot, slot);
                            extent = Math.max(extent, end);
                            this.downloaded++;
                        }
                        if (maxSlot !== this.downloaded) valid = false;
                        if (valid) {
                            // Discard a data write whose slot never committed.
                            this.disk.truncate(extent);
                            this.disk.flush();
                        }
                    }
                }
            }
        } catch { valid = false; }
        if (!valid) {
            this.disk.truncate(0);
            this.disk.flush();
            this.slots.fill(0);
            this.downloaded = 0;
            const json = new TextEncoder().encode(JSON.stringify({ ...this.version, chunkBytes: this.chunkBytes, layout: "packed-v1" }));
            const length = new Uint8Array(4);
            new DataView(length.buffer).setUint32(0, json.length, true);
            this.bitmap.truncate(0);
            writeAll(this.bitmap, length, 0);
            writeAll(this.bitmap, json, 4);
            this.bitmapOffset = 4 + json.length;
            writeAll(this.bitmap, new Uint8Array(this.slots.byteLength), this.bitmapOffset);
            this.bitmap.flush();
        }
        for (let ci = 0; ci < this.chunkCount; ci++) {
            if (this.has(ci)) this.publish(ci);
        }
        this.bitmap.flush();
    }

    get promoted(): boolean { return this.complete; }
    get chunkCount(): number { return Math.ceil(this.version.size / this.chunkBytes); }
    get downloadedChunks(): number { return this.downloaded; }
    has(ci: number): boolean { return ci >= 0 && ci < this.chunkCount && this.slots[ci] > 0; }
    private chunkSize(ci: number): number { return Math.min(this.chunkBytes, this.version.size - ci * this.chunkBytes); }
    private publish(ci: number): void { Atomics.or(this.residency, ci >> 5, 1 << (ci & 31)); }

    read(ci: number): Uint8Array | null {
        if (!this.has(ci)) return null;
        const start = (this.complete ? ci : this.slots[ci] - 1) * this.chunkBytes;
        const out = new Uint8Array(this.chunkSize(ci));
        readAll(this.disk, out, start);
        return out;
    }

    async readAsync(ci: number): Promise<Uint8Array | null> {
        // Promotion keeps the packed source open until the new archive is ready.
        return this.read(ci);
    }

    write(ci: number, bytes: Uint8Array): void {
        if (this.has(ci)) return;
        if (!Number.isInteger(ci) || ci < 0 || ci >= this.chunkCount) throw new Error(`Invalid sparse chunk ${ci}`);
        const want = this.chunkSize(ci);
        if (bytes.length !== want) throw new Error(`Sparse WGB cache short chunk ${ci}`);
        // OPFS does not promise physical holes; archive offsets can allocate gigabytes.
        writeAll(this.disk, bytes, this.downloaded * this.chunkBytes);
        this.disk.flush();
        const slot = this.downloaded + 1;
        this.slotView.setUint32(0, slot, true);
        writeAll(this.bitmap, this.slotBytes, this.bitmapOffset + ci * 4);
        this.bitmap.flush();
        this.slots[ci] = slot;
        this.downloaded++;
        this.publish(ci);
    }

    promote(): Promise<boolean> {
        if (!this.promotion) {
            this.promotion = this.promoteImpl().finally(() => { this.promotion = null; });
        }
        return this.promotion;
    }

    private async promoteImpl(): Promise<boolean> {
        if (this.complete || this.downloaded !== this.chunkCount) return this.complete;
        const key = urlToCacheKey(this.version.url);
        if (!(await WgbCache.ensureSpaceFor(this.version.size, key))) return false;
        const target = await this.dir.getFileHandle(`${key}.part`, { create: true }) as SyncFile;
        if (!target.move) return false;
        let handle: SyncAccessHandleLike | undefined = await target.createSyncAccessHandle();
        try {
            handle.truncate(0);
            const buffer = new Uint8Array(this.chunkBytes);
            for (let ci = 0; ci < this.chunkCount; ci++) {
                const part = buffer.subarray(0, this.chunkSize(ci));
                readAll(this.disk, part, (this.slots[ci] - 1) * this.chunkBytes);
                writeAll(handle, part, ci * this.chunkBytes);
                if ((ci + 1) * this.chunkBytes % (8 * 1024 * 1024) === 0) {
                    handle.flush();
                    await new Promise<void>(resolve => setTimeout(resolve, 0));
                }
            }
            handle.flush();
            if (handle.getSize() !== this.version.size || !hasZipEocd(handle, this.version.size)) throw new Error("Completed sparse cache is not a ZIP");
            handle.close(); handle = undefined;
            await target.move(key);
            await WgbCache.storeVersion(this.version, this.dir);
            const next = await target.createSyncAccessHandle();
            this.disk.close();
            this.disk = next;
            this.complete = true;
            this.bitmap.close();
            // Cleanup must not invalidate the successfully published archive.
            try { await this.dir.removeEntry(`${key}.sparse`); } catch {}
            try { await this.dir.removeEntry(`${key}.bitmap`); } catch {}
        } finally {
            handle?.close();
        }
        return this.complete;
    }

    async close(): Promise<void> {
        try { await this.promotion; } catch {}
        this.disk.close();
        if (!this.complete) this.bitmap.close();
    }
}
