/** Read-only inventory: OPFS file extents, archive sizes and committed cache chunks. */
export async function storageReport(opts: { verifyChunks?: number } = {}): Promise<unknown> {
    const estimate = await navigator.storage.estimate();
    const files: Array<{ name: string; bytes: number }> = [];
    const caches: Array<Record<string, unknown>> = [];
    let dir: FileSystemDirectoryHandle;
    try {
        const root = await navigator.storage.getDirectory();
        dir = await (await root.getDirectoryHandle("bottleship")).getDirectoryHandle("wgb-cache");
    } catch {
        return { estimate, files, caches, cacheBytes: 0 };
    }
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        if (handle.kind !== "file") continue;
        const file = await (handle as FileSystemFileHandle).getFile();
        files.push({ name, bytes: file.size });
        if (!name.endsWith(".bitmap")) continue;
        try {
            const bytes = await file.arrayBuffer(), view = new DataView(bytes);
            const length = view.getUint32(0, true), offset = 4 + length;
            const info = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 4, length)));
            const count = Math.ceil(info.size / info.chunkBytes);
            let committedChunks = 0, packedExtent = 0;
            for (let ci = 0; ci < count; ci++) {
                if (info.layout === "packed-v1") {
                    const slot = view.getUint32(offset + ci * 4, true);
                    if (slot) {
                        committedChunks++;
                        packedExtent = Math.max(packedExtent, (slot - 1) * info.chunkBytes + Math.min(info.chunkBytes, info.size - ci * info.chunkBytes));
                    }
                } else if (view.getUint8(offset + (ci >> 3)) & (1 << (ci & 7))) committedChunks++;
            }
            const data = await (await dir.getFileHandle(name.slice(0, -7) + ".sparse")).getFile();
            const verification: Array<{ chunk: number; matches: boolean }> = [];
            if (info.layout === "packed-v1" && opts.verifyChunks) {
                const committed = Array.from({ length: count }, (_, ci) => ci)
                    .filter(ci => view.getUint32(offset + ci * 4, true) !== 0);
                const samples = Math.min(committed.length, Math.max(1, Math.min(32, opts.verifyChunks | 0)));
                for (let i = 0; i < samples; i++) {
                    const ci = committed[samples === 1 ? 0 : Math.round(i * (committed.length - 1) / (samples - 1))];
                    const slot = view.getUint32(offset + ci * 4, true), start = ci * info.chunkBytes;
                    const size = Math.min(info.chunkBytes, info.size - start);
                    const response = await fetch(info.url, { headers: { Range: `bytes=${start}-${start + size - 1}` } });
                    if (response.status !== 206 || response.headers.get("etag") !== info.etag) {
                        throw new Error(`Cache reference changed or rejected Range (${response.status})`);
                    }
                    const reference = new Uint8Array(await response.arrayBuffer());
                    const cached = new Uint8Array(await data.slice((slot - 1) * info.chunkBytes, (slot - 1) * info.chunkBytes + size).arrayBuffer());
                    verification.push({ chunk: ci, matches: reference.length === size && cached.length === size
                        && reference.every((byte, j) => byte === cached[j]) });
                }
            }
            caches.push({ name, layout: info.layout ?? "archive-offsets", archiveBytes: info.size,
                chunkBytes: info.chunkBytes, chunks: count, committedChunks, dataBytes: data.size,
                packedExtent: info.layout === "packed-v1" ? packedExtent : null, verification });
        } catch (error) { caches.push({ name, error: String(error) }); }
    }
    return { estimate, cacheBytes: files.reduce((n, f) => n + f.bytes, 0), files, caches };
}
