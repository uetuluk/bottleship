import { harness } from "../../harness";

const wgb = process.env.WGB;
if (!wgb) throw new Error("Set WGB to a large bundle URL");
const result = await harness().clearModals().openWgb(wgb, { io: { mode: "stream" } })
    .call("storageReport", { verifyChunks: 16 }).report().run();
if (!result.ok) throw new Error(JSON.stringify(result.error));
const storage = result.named.storageReport as { caches: Array<{ layout: string; dataBytes: number; committedChunks: number; chunkBytes: number; verification: Array<{ matches: boolean }>; error?: string }> };
if (!storage.caches.length) throw new Error("No persistent streaming cache was opened");
for (const cache of storage.caches) {
    if (cache.error) throw new Error(cache.error);
    if (cache.layout !== "packed-v1") throw new Error(`Legacy cache layout: ${cache.layout}`);
    // A writer can commit chunks between the metadata and data-file snapshots.
    if (cache.dataBytes > (cache.committedChunks + 8) * cache.chunkBytes) {
        throw new Error(`Cache extent ${cache.dataBytes} exceeds committed packed slots`);
    }
    if (!cache.verification?.length || cache.verification.some(chunk => !chunk.matches)) {
        throw new Error("Packed cache differs from its source archive");
    }
}
console.log(JSON.stringify(storage, null, 2));
