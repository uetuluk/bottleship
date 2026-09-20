
import { ThunkDispatcher } from './thunking/thunk-dispatcher';
import { PELoader } from './pe-loader';
import { SystemResourceProvider } from './resources/system-resource-provider';
import { APIRegistry } from './api-registry';
import { ThunkMemoryManager } from './thunking/thunk-memory-manager';
import { AddressSpace, RegionKind, RegionPerms } from './memory/address-space';
import { Mem } from './memory/mem-accessor';
import { EMU_MEMORY_SIZE, MAX_ALLOC_BYTES } from './cpu/emulator-config';
import { Logger, LogCategory } from './logger';
import { ModuleRegistry } from './module-registry';
import { memoryEventBuffer, MemoryEventType } from './memory/memory-event-buffer';
import { ensureGuestPagesCommitted } from './memory/guest-page-commit';
import type { PageTableManager } from './memory/page-table-manager';
import { SEH_SCRATCH_TOTAL_SIZE } from './thunking/seh-layout';

export interface MemoryMetrics {
    totalAllocated: number;  // Total bytes ever allocated
    currentBytes: number;    // Currently allocated bytes
    peakBytes: number;       // Maximum bytes allocated at once
    allocationCount: number; // Number of active allocations
}

interface BucketState {
    base: number;
    limit: number;
    next: number;     // guest bump frontier — grows UP from base
    slabTop?: number; // slab-arena frontier — grows DOWN from limit (HEAP only)
    everMax: number;  // high-water mark: highest bump frontier ever reached. Anything
                      // at/above this is virgin territory (guest RAM starts zeroed);
                      // anything below it that a bump re-hands-out was previously written.
}

const BUCKET_KINDS: RegionKind[] = ['HEAP', 'SURFACE', 'THUNK_CODE', 'THUNK_DATA'];

export class MemoryManager {
    constructor(private addressSpace: AddressSpace) {
        this.bucketState = new Map();
    }

    // Memory tracking
    private allocations: Map<number, number> = new Map();
    private totalAllocated = 0;
    private currentBytes = 0;
    private peakBytes = 0;

    // Free list: bucketKind → sorted array of {addr, size} blocks
    private freeBlocks: Map<RegionKind, Array<{ addr: number; size: number }>> = new Map();
    /** Live guest VirtualAlloc(NULL, MEM_RESERVE) reservations: base → size. */
    private vaReservations: Map<number, number> = new Map();
    /** Released reservations, reusable only by another reservation (see reserveGuestVa). */
    private vaFreeBlocks: Array<{ addr: number; size: number }> = [];
    // Track which bucket kind each allocation belongs to
    private allocBucket: Map<number, RegionKind> = new Map();

    private bucketState: Map<RegionKind, BucketState> = new Map();
    private reservedAddresses: Set<number> = new Set();

    // [DIAG] Large-allocation (≥64KB) lifecycle log. VirtualAlloc-class blocks are
    // rare, so a long ring spans the whole session — unlike the 4K generic
    // memoryEventBuffer that wraps in milliseconds under heap churn. Each entry
    // carries a lightweight caller backtrace (__guestBtLite) so an address can be
    // attributed to its allocator module. Decisive for the D2 Fog-descriptor /
    // Storm-MPQ overlap: query by address to see the full alloc/free SEQUENCE and
    // tell UAF-reuse (alloc→free→alloc) from double-hand-out (alloc→alloc, no free)
    // from corruption (address only ever allocated by one subsystem).
    private static readonly LARGE_ALLOC_THRESHOLD = 0x10000; // 64KB = VirtualAlloc granularity
    private static readonly LARGE_ALLOC_LOG_SIZE = 4096;
    private largeAllocLog: Array<{ op: 'alloc' | 'free' | 'alias'; addr: number; size: number; time: number; bt: string }> = [];
    private largeAllocLogIdx = 0;

    private alignUp(value: number, align: number): number {
        return (value + (align - 1)) & ~(align - 1);
    }

    /** Record a ≥64KB block lifecycle event with a lightweight caller backtrace. */
    private logLargeEvent(op: 'alloc' | 'free' | 'alias', addr: number, size: number): void {
        if (size < MemoryManager.LARGE_ALLOC_THRESHOLD) return;
        let bt = '';
        try { bt = (globalThis as any).__guestBtLite?.() ?? ''; } catch { /* best-effort */ }
        const entry = { op, addr: addr >>> 0, size, time: performance.now(), bt };
        if (this.largeAllocLog.length < MemoryManager.LARGE_ALLOC_LOG_SIZE) {
            this.largeAllocLog.push(entry);
        } else {
            this.largeAllocLog[this.largeAllocLogIdx] = entry;
            this.largeAllocLogIdx = (this.largeAllocLogIdx + 1) % MemoryManager.LARGE_ALLOC_LOG_SIZE;
        }
    }

    /**
     * Full lifecycle history of large (≥64KB) blocks whose range intersects
     * [addr-radius, addr+radius], time-sorted. `overlaps` flags entries whose
     * block actually contains `addr`. Used by the #DE diagnostic to disambiguate
     * the Fog-descriptor / Storm-MPQ overlap: the alloc/free sequence + per-entry
     * caller backtrace shows whether the address was freed before reuse (UAF) or
     * handed out while live (double-hand-out / corruption).
     */
    getLargeAllocHistory(addr: number, radius: number = 0x20000): Array<{ op: string; addr: string; size: string; t: string; overlaps: boolean; bt: string }> {
        const target = addr >>> 0;
        const lo = Math.max(0, target - radius);
        const hi = target + radius;
        return this.largeAllocLog
            .filter(e => e && e.addr < hi && (e.addr + e.size) > lo)
            .sort((a, b) => a.time - b.time)
            .map(e => ({
                op: e.op,
                addr: '0x' + e.addr.toString(16),
                size: '0x' + e.size.toString(16),
                t: (e.time / 1000).toFixed(3) + 's',
                overlaps: e.addr <= target && (e.addr + e.size) > target,
                bt: e.bt,
            }));
    }

    private resolveBucketKind(kind?: RegionKind): RegionKind {
        const requested = kind ?? 'HEAP';
        if (requested === 'SURFACE') return 'SURFACE';
        if (requested === 'THUNK_CODE' || requested === 'CALLBACK_STUB' || requested === 'SPIN_LOOP') return 'THUNK_CODE';
        if (requested === 'THUNK_DATA') return 'THUNK_DATA';
        return 'HEAP';
    }

    refreshLayoutBuckets(): void {
        this.bucketState.clear();
        for (const kind of BUCKET_KINDS) {
            const region = this.addressSpace.getLayoutBucket(kind);
            if (!region || region.size <= 0) continue;
            const base = this.alignUp(region.base, 8);
            const limit = region.base + region.size;
            this.bucketState.set(kind, { base, limit, next: base, slabTop: limit, everMax: base });
        }
    }

    alloc(size: number, kind?: RegionKind, perms?: RegionPerms, alignment?: number): number {
        // Sanity guard against corrupted/garbage sizes only. The real ceiling is the
        // bucket's free space (a too-large request fails there → caller gets NULL). A 256MB
        // cap here under-served guests with >256MB RAM: a legit 300MB GlobalAlloc threw,
        // LocalAlloc caught it → returned NULL → unchecked guest deref crash (GTA3 New Game).
        if (size <= 0 || size > MAX_ALLOC_BYTES) {
            throw new Error(`Invalid allocation size: ${size}`);
        }
        const minAlign = alignment ?? 8;
        const aligned = this.alignUp(size, minAlign);
        const finalKind = kind ?? 'HEAP';
        const finalPerms = perms ?? 'rw';
        const bucketKind = this.resolveBucketKind(finalKind);

        const bucket = this.bucketState.get(bucketKind);
        if (!bucket) {
            throw new Error(`MemoryManager: bucket ${bucketKind} is not available`);
        }

        const addr = this.allocateInBucket(bucket, aligned, minAlign, bucketKind);

        // [DIAG/SAFETY] Double-hand-out detector: the allocator must never return an
        // address that is still recorded live. A real heap never hands out a busy block;
        // a hit here means two owners share a block (overlapping live allocations) → the
        // classic UAF / pointer high-byte stomp. Always-on, O(1) — logs the colliding
        // sizes so the next repro pins the mechanism instead of guessing.
        if (this.allocations.has(addr)) {
            Logger.error(LogCategory.SYSTEM,
                `[MemoryManager] DOUBLE-HAND-OUT 0x${addr.toString(16)}: already live ` +
                `(liveSize=0x${(this.allocations.get(addr) ?? 0).toString(16)}, ` +
                `newReq=0x${aligned.toString(16)}, bucket=${bucketKind}) — overlapping ` +
                `live allocations → use-after-free.`);
        }

        // Only register regions for non-HEAP kinds (surfaces, thunk memory, etc.).
        // Individual HEAP sub-allocations (HeapAlloc etc.) are already covered by the
        // HEAP layout bucket — registering each one bloats regions[] to 200K+ entries,
        // making findBlockingRegion and releaseRegion O(n) and killing performance.
        if (finalKind !== 'HEAP') {
            this.addressSpace.registerRegion({
                base: addr,
                size: aligned,
                perms: finalPerms,
                kind: finalKind,
                owner: 'MemoryManager',
                skipOverlapCheck: true,
            });
        }

        this.recordAllocation(addr, aligned);
        this.allocBucket.set(addr, bucketKind);
        this.logLargeEvent('alloc', addr, aligned);

        if (bucketKind === 'HEAP' || bucketKind === 'SURFACE') {
            ensureGuestPagesCommitted(addr, aligned);
        }

        return addr;
    }

    allocSurface(size: number): number {
        return this.alloc(size, 'SURFACE');
    }

    /**
     * Allocate a kernel32 heap-slab ARENA top-down from the HEAP bucket (growing down
     * from `limit`), kept OUT of the guest bump frontier (`next`, growing up).
     *
     * Why: the slab arena used to be a normal `alloc()` at the shared bump frontier, so
     * carving 4 MB+ at tick-500 SHIFTED every subsequent guest allocation's address vs the
     * no-slab case. Diablo II is sensitive to that — it crashed (garbage pointers / wild
     * VirtualAlloc) only with the slab on, and was stable under `__noHeapSlab` purely
     * because no arena was carved. Placing the arena at the top makes the guest's own
     * allocation addresses BYTE-IDENTICAL to the no-slab layout while the slab keeps
     * working. Faithful too: a real heap's reserve lives in its own VA, not interleaved
     * with the app's. Arenas are never freed (geometric, bounded), so no free path here.
     */
    allocSlabArena(size: number): number {
        const bucket = this.bucketState.get('HEAP');
        if (!bucket) throw new Error('MemoryManager: HEAP bucket unavailable for slab arena');
        const aligned = this.alignUp(size, 0x10000); // 64KB allocation granularity
        const top = (bucket.slabTop ?? bucket.limit) >>> 0;
        const addr = (top - aligned) & ~0xFFFF;       // 64KB-aligned base, growing down
        if (addr < bucket.next) {
            throw new Error(
                `MemoryManager: slab arena OOM (top=0x${top.toString(16)} need 0x${aligned.toString(16)} ` +
                `would cross guest frontier 0x${bucket.next.toString(16)})`);
        }
        bucket.slabTop = addr;
        this.recordAllocation(addr, aligned);
        this.allocBucket.set(addr, 'HEAP');
        ensureGuestPagesCommitted(addr, aligned);
        this.logLargeEvent('alloc', addr, aligned);
        return addr;
    }

    /**
     * Carve VA for a guest `VirtualAlloc(NULL, …, MEM_RESERVE)` — top-down, from the
     * same descending frontier as the slab arena, and NEVER from the guest bump
     * frontier that HeapAlloc & co. allocate from.
     *
     * Why not the shared bump frontier: an arena allocator (Flash Player, the MSVC
     * CRT's low-fragmentation heap, most engine allocators) reserves a big block and
     * later extends it by reserving *at its own end*. Bump-allocating both reservations
     * and heap blocks from one frontier puts whatever the guest allocated next — a
     * 48-byte HeapAlloc is enough, since a reservation then rounds up to the next 64KB
     * granule — squarely in that growth path, so the extend is refused. Windows does
     * not collide that reliably: its heap sub-allocates inside its own segments and its
     * address space has real holes. Growing DOWN restores the property the guest
     * actually depends on — the VA immediately above a reservation stays free — while
     * keeping reservations 64KB-granular as Win32 requires.
     *
     * Released reservations are reused only by other reservations: handing one back to
     * the shared HEAP free list would let a later HeapAlloc land inside guest VA again
     * and reintroduce exactly this fragmentation.
     */
    reserveGuestVa(size: number): number {
        const bucket = this.bucketState.get('HEAP');
        if (!bucket) throw new Error('MemoryManager: HEAP bucket unavailable for guest VA reservation');
        const aligned = this.alignUp(size, 0x10000); // 64KB allocation granularity

        // Best fit among released reservations; split the tail back for later reuse.
        let bestIdx = -1;
        let bestWaste = Infinity;
        for (let i = 0; i < this.vaFreeBlocks.length; i++) {
            const waste = this.vaFreeBlocks[i]!.size - aligned;
            if (waste >= 0 && waste < bestWaste) {
                bestWaste = waste;
                bestIdx = i;
            }
        }
        let addr: number;
        if (bestIdx >= 0) {
            const block = this.vaFreeBlocks[bestIdx]!;
            this.vaFreeBlocks.splice(bestIdx, 1);
            addr = block.addr;
            const tail = block.size - aligned;
            if (tail >= 0x10000) this.vaFreeBlocks.push({ addr: addr + aligned, size: tail });
        } else {
            const top = (bucket.slabTop ?? bucket.limit) >>> 0;
            addr = (top - aligned) & ~0xffff;
            if (addr < bucket.next) {
                throw new Error(
                    `MemoryManager: guest VA reservation OOM (top=0x${top.toString(16)} ` +
                    `need 0x${aligned.toString(16)} would cross bump frontier 0x${bucket.next.toString(16)})`);
            }
            bucket.slabTop = addr;
        }

        this.vaReservations.set(addr, aligned);
        this.recordAllocation(addr, aligned);
        this.allocBucket.set(addr, 'HEAP');
        ensureGuestPagesCommitted(addr, aligned);
        this.logLargeEvent('alloc', addr, aligned);
        return addr;
    }

    /** MEM_RELEASE of a {@link reserveGuestVa} block. False when `addr` isn't one. */
    releaseGuestVa(addr: number): boolean {
        const base = addr >>> 0;
        const size = this.vaReservations.get(base);
        if (size === undefined) return false;
        this.vaReservations.delete(base);
        this.allocations.delete(base);
        this.allocBucket.delete(base);
        this.reservedAddresses.delete(base);
        this.currentBytes -= size;
        this.vaFreeBlocks.push({ addr: base, size });
        this.logLargeEvent('free', base, size);
        return true;
    }

    allocAt(addr: number, size: number, kind?: RegionKind, perms?: RegionPerms): number {
        const aligned = this.alignUp(size, 8);
        const finalKind = kind ?? 'HEAP';
        const finalPerms = perms ?? 'rw';
        const bucketKind = this.resolveBucketKind(finalKind);
        const bucket = this.bucketState.get(bucketKind);
        if (!bucket) {
            throw new Error(`MemoryManager: bucket ${bucketKind} is not available`);
        }

        if (addr < bucket.base || addr + aligned > bucket.limit) {
            throw new Error(`MemoryManager: allocAt out of bucket bounds (0x${addr.toString(16)} size=0x${aligned.toString(16)})`);
        }

        const existingSize = this.allocations.get(addr);
        if (existingSize !== undefined && existingSize >= aligned) {
            if (bucketKind === 'HEAP' || bucketKind === 'SURFACE') {
                ensureGuestPagesCommitted(addr, aligned);
            }
            return addr;
        }

        this.addressSpace.registerRegion({
            base: addr,
            size: aligned,
            perms: finalPerms,
            kind: finalKind,
            owner: 'MemoryManager',
            skipOverlapCheck: true,
        });

        bucket.next = Math.max(bucket.next, addr + aligned);
        this.recordAllocation(addr, aligned);
        this.allocBucket.set(addr, bucketKind);
        this.logLargeEvent('alloc', addr, aligned);
        if (bucketKind === 'HEAP' || bucketKind === 'SURFACE') {
            ensureGuestPagesCommitted(addr, aligned);
        }
        return addr;
    }

    free(ptr: number): void {
        const size = this.allocations.get(ptr);
        if (size === undefined) return;

        // HEAP allocs are not registered in addressSpace.regions (skipped in alloc),
        // so skip releaseRegion for them to avoid O(n) scan of a non-existent entry.
        const bucketKind = this.allocBucket.get(ptr);
        if (bucketKind !== 'HEAP') {
            this.addressSpace.releaseRegion(ptr);
        }
        this.currentBytes -= size;
        this.allocations.delete(ptr);
        this.reservedAddresses.delete(ptr);

        if (bucketKind) {
            this.allocBucket.delete(ptr);
            this.releaseToFreeList(bucketKind, ptr, size);
        }
        this.logLargeEvent('free', ptr, size);

        memoryEventBuffer.record({
            timestamp: performance.now(),
            type: MemoryEventType.FREE,
            address: ptr,
            size: size,
            context: 'MemoryManager.free',
        });
    }

    /**
     * Return a block to its bucket's free list with three invariants:
     *   1. **Sorted by address ascending** — O(log n) insert + O(1) neighbor lookup.
     *   2. **Coalesce with immediate neighbors** — avoids death-by-fragmentation when
     *      games alloc/free same-size textures in interleaved order.
     *   3. **Retreat bump pointer** — if the (possibly coalesced) block ends at
     *      `bucket.next`, reclaim it directly into the bump arena and don't store it.
     *      Handles the runaway case where `used` keeps climbing even though frees
     *      outnumber allocs (NB scene transitions create transient per-frame
     *      surfaces; free list ends up with a tall stack of same-size chunks but
     *      bump marched past all of them).
     *
     * Called from `free()` and from the pre-waste/post-waste split path in the
     * allocator — both must funnel through here to keep invariants consistent.
     */
    private releaseToFreeList(bucketKind: RegionKind, addr: number, size: number): void {
        if (size <= 0) return;
        let list = this.freeBlocks.get(bucketKind);
        if (!list) {
            list = [];
            this.freeBlocks.set(bucketKind, list);
        }

        // Binary-search insertion point (sorted by addr ascending).
        let lo = 0, hi = list.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (list[mid].addr < addr) lo = mid + 1;
            else hi = mid;
        }

        // [DIAG/SAFETY] Double-free / overlap detector: a block must not already be in the
        // free list, nor fall inside an existing free block. A hit means the SAME block is
        // about to be free-listed twice → two later allocs return it → overlapping live
        // allocations → UAF (the Morrowind UpdateLights pointer stomp). Self-heal: refuse
        // the second push so the corruption can't proceed, and log it loudly with the
        // colliding entries so the next repro names the path.
        if (lo < list.length && list[lo].addr === addr) {
            Logger.error(LogCategory.SYSTEM,
                `[MemoryManager] DOUBLE-FREE into ${bucketKind} free-list: 0x${addr.toString(16)} ` +
                `(size=0x${size.toString(16)}) is already free (existingSize=0x${list[lo].size.toString(16)}) ` +
                `— refusing re-push to avoid a double-hand-out UAF.`);
            return;
        }
        if (lo > 0 && list[lo - 1].addr + list[lo - 1].size > addr) {
            Logger.error(LogCategory.SYSTEM,
                `[MemoryManager] FREE-LIST OVERLAP in ${bucketKind}: freeing 0x${addr.toString(16)} ` +
                `(size=0x${size.toString(16)}) overlaps existing free block 0x${list[lo - 1].addr.toString(16)} ` +
                `(size=0x${list[lo - 1].size.toString(16)}) — refusing to avoid corruption.`);
            return;
        }

        let mergedAddr = addr;
        let mergedSize = size;

        // Coalesce with right neighbour if adjacent.
        if (lo < list.length && list[lo].addr === mergedAddr + mergedSize) {
            mergedSize += list[lo].size;
            list.splice(lo, 1);
        }
        // Coalesce with left neighbour if adjacent.
        if (lo > 0 && list[lo - 1].addr + list[lo - 1].size === mergedAddr) {
            mergedAddr = list[lo - 1].addr;
            mergedSize += list[lo - 1].size;
            list.splice(lo - 1, 1);
            lo -= 1;
        }

        const bucket = this.bucketState.get(bucketKind);
        if (bucket && mergedAddr + mergedSize === bucket.next) {
            // Block is right at the bump frontier — retreat rather than storing.
            // May expose further absorbable blocks below; repeat until the top
            // of the sorted free list no longer touches `bucket.next`.
            bucket.next = mergedAddr;
            while (list.length > 0) {
                const top = list[list.length - 1];
                if (top.addr + top.size === bucket.next) {
                    bucket.next = top.addr;
                    list.pop();
                } else {
                    break;
                }
            }
        } else {
            list.splice(lo, 0, { addr: mergedAddr, size: mergedSize });
        }
    }

    getMetrics(): MemoryMetrics {
        return {
            totalAllocated: this.totalAllocated,
            currentBytes: this.currentBytes,
            peakBytes: this.peakBytes,
            allocationCount: this.allocations.size,
        };
    }

    getSize(ptr: number): number | undefined {
        return this.allocations.get(ptr);
    }

    /**
     * Snapshot of live HEAP-bucket allocations for a faithful HeapWalk.
     *
     * Third-party heap managers that coexist with the Win32 heap (SmartHeap/Shw32
     * in Blade of Darkness) validate a free()'d pointer that isn't in their own
     * pool by walking the OS heap via GetProcessHeaps + HeapWalk — "is this a raw
     * HeapAlloc block?". Our buffers (Miles audio buffers, SmartHeap-delegated
     * large blocks) all come from this allocator's HEAP bucket, so enumerating
     * them here lets that validation succeed instead of raising MEM_BAD_POINTER.
     *
     * Returned newest-first (MRU): linear walkers looking for a freshly-freed
     * buffer find it near the front, so the common case stays cheap even when the
     * live set is large. Slab roots are reported as single large blocks, which
     * also covers (by containment) any small sub-allocations carved out of them.
     */
    snapshotHeapAllocations(): Array<{ addr: number; size: number }> {
        const out: Array<{ addr: number; size: number }> = [];
        for (const [addr, size] of this.allocations) {
            if (this.allocBucket.get(addr) === 'HEAP') {
                out.push({ addr, size });
            }
        }
        out.reverse();
        return out;
    }

    /**
     * Per-bucket stats for the DevTools diagnostic `getMemReport()`.
     * Cheap to compute: all counters are maintained incrementally.
     *
     * `used`     = bump frontier (next - base) — how far the arena has grown.
     * `liveUsed` = used minus interior free blocks — what's actually held.
     *              Gap between the two is fragmentation; big gap → many small
     *              allocs live past large allocs that were freed but can't be
     *              retreated into the bump.
     */
    getBucketStats(): Array<{ kind: string; base: number; limit: number; next: number; used: number; liveUsed: number; free: number; freeBlocks: number; freeBytes: number }> {
        const rows: Array<{ kind: string; base: number; limit: number; next: number; used: number; liveUsed: number; free: number; freeBlocks: number; freeBytes: number }> = [];
        for (const [kind, state] of this.bucketState.entries()) {
            const total = state.limit - state.base;
            const used = state.next - state.base;
            const list = this.freeBlocks.get(kind);
            let freeBytes = 0;
            if (list) {
                for (let i = 0; i < list.length; i++) freeBytes += list[i].size;
            }
            rows.push({
                kind,
                base: state.base,
                limit: state.limit,
                next: state.next,
                used,
                liveUsed: used - freeBytes,
                free: total - used,
                freeBlocks: list?.length ?? 0,
                freeBytes,
            });
        }
        return rows;
    }

    /** Register a page-aligned alias so VirtualFree can find VirtualAlloc blocks. */
    registerAlias(alignedAddr: number, size: number): void {
        this.allocations.set(alignedAddr, size);
        this.logLargeEvent('alias', alignedAddr, size);
    }

    reset(): void {
        this.allocations.clear();
        this.freeBlocks.clear();
        this.allocBucket.clear();
        this.reservedAddresses.clear();
        this.totalAllocated = 0;
        this.currentBytes = 0;
        this.peakBytes = 0;
        this.largeAllocLog = [];
        this.largeAllocLogIdx = 0;
        this.refreshLayoutBuckets();
    }

    private allocateInBucket(bucket: BucketState, size: number, alignment: number = 8, bucketKind?: RegionKind): number {
        // Try free list first: find a block that fits (best-fit), then SPLIT the
        // remainder back into the list. Pre-split behaviour used the entire block
        // even when much larger than needed — a 4 MB freed block picked for a
        // 256 KB alloc lost 3.75 MB until the game happened to free an exact-size
        // block next to it. With splitting, NB scene churn converges: the first
        // wave of allocs+frees establishes a free-list "shape" that all later
        // scene loads can reuse without touching the bump pointer.
        if (bucketKind) {
            const list = this.freeBlocks.get(bucketKind);
            if (list && list.length > 0) {
                let bestIdx = -1;
                let bestWaste = Infinity;
                for (let i = 0; i < list.length; i++) {
                    const block = list[i];
                    const alignedAddr = this.alignUp(block.addr, alignment);
                    const usable = block.size - (alignedAddr - block.addr);
                    if (usable >= size) {
                        const waste = usable - size;
                        if (waste < bestWaste) {
                            bestWaste = waste;
                            bestIdx = i;
                        }
                    }
                }
                if (bestIdx >= 0) {
                    const block = list[bestIdx];
                    list.splice(bestIdx, 1);
                    const alignedAddr = this.alignUp(block.addr, alignment);
                    const preWaste = alignedAddr - block.addr;
                    const tailStart = alignedAddr + size;
                    const tailSize = block.addr + block.size - tailStart;
                    // Push back unused head (alignment padding) and tail.
                    // Threshold: 16 bytes — smaller fragments not worth tracking
                    // and would inflate the free-list search cost.
                    if (preWaste >= 16) {
                        this.releaseToFreeList(bucketKind, block.addr, preWaste);
                    }
                    if (tailSize >= 16) {
                        this.releaseToFreeList(bucketKind, tailStart, tailSize);
                    }
                    // Hand out zeroed memory. Strictly, Win32 HeapAlloc without HEAP_ZERO_MEMORY
                    // leaves a reused block dirty — but this best-fit free list reuses far more
                    // aggressively than the real heap (which prefers per-size-class fresh commits,
                    // whose pages come zeroed via the VirtualAlloc/MEM_COMMIT guarantee). A guest
                    // that reads a just-allocated field expecting the zero a fresh commit would have
                    // given (a very common pattern) otherwise sees our stale reuse — the Re-Volt
                    // "garbage vertex / wild index" corruption. Zeroing matches that observable
                    // fresh-memory contract and is safe: correct code never relies on reused-dirty.
                    this.addressSpace.fill(alignedAddr, size, 0);
                    return alignedAddr;
                }
            }
        }

        let alignedStart = this.alignUp(bucket.next, alignment);

        // Skip over any PE-image or other foreign regions that already occupy this range.
        // This handles large EXEs (e.g. ImageBase=0x400000, sizeOfImage>12MB) whose
        // mapped region overlaps MEM_HEAP_BASE (0x1000000).
        for (let guard = 0; guard < 32; guard++) {
            const blocker = this.addressSpace.findBlockingRegion(alignedStart, size);
            if (!blocker) break;
            alignedStart = this.alignUp(blocker.base + blocker.size, alignment);
        }

        // Guest allocations grow UP and must never enter the slab-arena region (which
        // grows DOWN from limit). Once a slab arena exists (slabTop < limit), the guest
        // ceiling is slabTop, not limit — growing past it would overwrite slab blocks
        // (and vice-versa). Expanding the bucket can't help (the slab sits at the top),
        // so this is a genuine OOM at the slab boundary rather than a silent corruption.
        const guestCeiling = bucket.slabTop ?? bucket.limit;
        if (bucket.slabTop !== undefined && bucket.slabTop < bucket.limit &&
            alignedStart + size > guestCeiling) {
            throw new Error(
                `MemoryManager: HEAP exhausted at slab boundary (need 0x${size.toString(16)} ` +
                `at 0x${alignedStart.toString(16)}, slabTop=0x${bucket.slabTop.toString(16)})`);
        }
        if (alignedStart + size > bucket.limit) {
            const bucketKind = this.getBucketKindByState(bucket);
            const needed = alignedStart + size - bucket.base;
            const growthIncrement = 64 * 1024 * 1024;
            const newSize = Math.max(needed, bucket.limit - bucket.base + growthIncrement);

            Logger.log(LogCategory.SYSTEM,
                `[MemoryManager] Bucket overflow detected for ${bucketKind}: ` +
                `need 0x${size.toString(16)} at 0x${alignedStart.toString(16)}, ` +
                `limit 0x${bucket.limit.toString(16)}. Attempting expansion...`);

            const expandedSize = this.addressSpace.expandLayoutBucket(bucketKind, newSize);
            if (expandedSize === 0) {
                throw new Error(
                    `MemoryManager: bucket overflow (requested 0x${size.toString(16)} ` +
                    `in 0x${bucket.base.toString(16)}..0x${bucket.limit.toString(16)})`
                );
            }

            bucket.limit = bucket.base + expandedSize;
            Logger.log(LogCategory.SYSTEM,
                `[MemoryManager] Bucket ${bucketKind} expanded successfully to 0x${bucket.limit.toString(16)}`);
        }

        const address = alignedStart;
        bucket.next = address + size;

        // Faithful Win32 fresh-memory semantics. Real Windows guarantees freshly-committed
        // pages read as zero (the VirtualAlloc/MEM_COMMIT contract that heap segment growth
        // relies on), while reused freed blocks stay dirty (HeapAlloc without HEAP_ZERO_MEMORY).
        // Guest RAM starts zeroed, so virgin territory at/above the high-water mark is already
        // zero. But releaseToFreeList retreats `next` when a freed block abuts the frontier, so
        // a later bump can re-hand-out that now-dirty range below the high-water mark — those
        // must be re-zeroed so every fresh bump allocation reads as zero, matching hardware.
        // (Free-list reuse is zeroed at its own return site above for the same reason.)
        if (address < bucket.everMax) {
            this.addressSpace.fill(address, size, 0);
        }
        if (bucket.next > bucket.everMax) bucket.everMax = bucket.next;

        return address;
    }

    private getBucketKindByState(bucket: BucketState): RegionKind {
        for (const [kind, state] of this.bucketState.entries()) {
            if (state.base === bucket.base && state.limit === bucket.limit) {
                return kind;
            }
        }
        return 'HEAP';
    }

    private recordAllocation(address: number, size: number): void {
        this.allocations.set(address, size);
        this.reservedAddresses.add(address);
        this.currentBytes += size;
        this.totalAllocated += size;
        this.peakBytes = Math.max(this.peakBytes, this.currentBytes);

        memoryEventBuffer.record({
            timestamp: performance.now(),
            type: MemoryEventType.ALLOC,
            address: address,
            size: size,
            context: 'MemoryManager.alloc',
        });
    }

    private getMemory(): Uint8Array {
        return this.addressSpace.getMemory();
    }
}
export class Process {
    resourceProvider = SystemResourceProvider.getInstance();
    addressSpace: AddressSpace;
    memory: MemoryManager;
    loader: PELoader;
    dispatcher: ThunkDispatcher; // Will be set after init
    thunkGenerator: any;
    thunkMemoryManager: ThunkMemoryManager; // Memory manager for thunk system
    moduleRegistry: ModuleRegistry; // Registry for loaded PE modules (EXE + DLLs)
    pageTableManager: PageTableManager | null = null; // x86 page tables for virtual memory protection

    // Canvas for rendering backends
    canvas: OffscreenCanvas | null = null;

    // Loaded modules by name (kernel32, user32, etc.)
    modules: Map<string, any> = new Map();

    // Environment variables
    environment: Map<string, string> = new Map();

    // Last error code (set by SetLastError, read by GetLastError)
    lastError: number = 0;

    // Bumped on every reset() that regenerates thunk memory. Caches that store
    // thunk-stub addresses (e.g. kernel32's GetProcAddress cache) compare against
    // this so they self-invalidate after an in-place reset — the Process object
    // identity stays the same across reset(), so identity alone can't detect it.
    resetGeneration: number = 0;

    constructor(
        private getMemory: () => Uint8Array,
        public v86: any,
        thunkGenerator: any,
        apiRegistry: APIRegistry
    ) {
        this.getMemory = getMemory;
        this.addressSpace = new AddressSpace(getMemory);
        this.memory = new MemoryManager(this.addressSpace);
        Mem.bind(getMemory);
        this.initializeMemoryLayout();
        this.memory.refreshLayoutBuckets();
        // Log memory map at boot for observability
        this.addressSpace.logMap();
        this.moduleRegistry = new ModuleRegistry();
        this.loader = new PELoader(getMemory, thunkGenerator, apiRegistry);
        this.loader.setModuleRegistry(this.moduleRegistry);
        this.dispatcher = new ThunkDispatcher(v86, thunkGenerator);
        this.thunkGenerator = thunkGenerator;
        this.thunkMemoryManager = new ThunkMemoryManager();

        // Initialize thunk memory manager before dispatcher initialization
        // This allocates memory regions for callback stubs, spin loops, and thunk stubs
        // Do NOT compute checksums yet - callback stubs/thunks not written
        this.thunkMemoryManager.initialize(this.memory, getMemory, { skipChecksums: true }).catch(err => {
            Logger.error(LogCategory.SYSTEM, `Failed to initialize thunk memory: ${err}`);
        });

        // Default environment
        this.environment.set("PATH", "C:\\WINDOWS\\SYSTEM32;C:\\WINDOWS;C:\\");
        this.environment.set("SYSTEMROOT", "C:\\WINDOWS");
        this.environment.set("WINDIR", "C:\\WINDOWS");
        this.environment.set("TEMP", "C:\\TEMP");
        this.environment.set("TMP", "C:\\TEMP");
        this.environment.set("USERNAME", "BottleShip");
        this.environment.set("COMPUTERNAME", "BS-EMULATOR");

        // Initialize callback manager for x86 callback invocation (WndProc, etc.)
        // Pass thunk memory manager to dispatcher so it can use dynamic addresses
        this.dispatcher.initializeCallbackManager(getMemory, this.thunkMemoryManager);

        // Initialize thunk generator with dynamic base address
        const regions = this.thunkMemoryManager.getRegions();
        this.thunkGenerator.setBaseAddress(regions.thunkGeneratorBase);
        // Materialize the shared "missing import" UD2 trap (guarded — memory may not be
        // ready this early; pe-loader re-ensures it lazily before patching IATs).
        this.thunkGenerator.writeTrapStub(getMemory());

        // Allocate SEH scratch area in THUNK_DATA for hardware exception dispatch.
        // Used by the SEH dispatch stub to pass EXCEPTION_RECORD, CONTEXT, and frame list
        // between JS (#PF handler) and x86 (native SEH handler execution).
        const sehScratchAddr = this.memory.alloc(SEH_SCRATCH_TOTAL_SIZE, 'THUNK_DATA');
        this.thunkMemoryManager.setSehScratchAddr(sehScratchAddr, SEH_SCRATCH_TOTAL_SIZE);
        this.dispatcher.updateSehScratchAddr(sehScratchAddr);
        const sehRegions = this.thunkMemoryManager.getRegions();
        Logger.log(LogCategory.SYSTEM,
            `SEH scratch area allocated at 0x${sehScratchAddr.toString(16)} ` +
            `(size=0x${SEH_SCRATCH_TOTAL_SIZE.toString(16)}, ` +
            `stack=0x${sehRegions.sehStackBase.toString(16)}..0x${sehRegions.sehStackTop.toString(16)})`);

        // Now compute checksums AFTER all code is written
        // This must be done in background to avoid blocking constructor
        Promise.all([
            // Wait a bit for callback manager to finish writing stubs
            new Promise(resolve => setTimeout(resolve, 100)),
        ]).then(() => {
            return this.thunkMemoryManager.computeChecksums(getMemory);
        }).catch(err => {
            Logger.error(LogCategory.SYSTEM, `Failed to compute thunk checksums: ${err}`);
        });

        this.setupProtectedMode();
    }

    getCurrentMemory(): Uint8Array {
        return this.getMemory();
    }

    allocateMemory(size: number): number {
        return this.memory.alloc(size);
    }

    allocateSurface(size: number): number {
        return this.memory.allocSurface(size);
    }

    private setupProtectedMode() {
        // NOTE: Mode switch is now handled by the bootloader (bootloader.ts)
        // The bootloader correctly transitions from real mode to protected mode
        // using proper x86 instructions (CLI, LGDT, LIDT, MOV CR0, far JMP)
        // 
        // Previous manual CPU state patching was causing conflicts with the bootloader
        // because v86 was left in an inconsistent state (part real mode, part protected mode)
        Logger.log(LogCategory.SYSTEM, "Protected mode setup deferred to bootloader");
    }

    getModule(name: string) {
        return this.modules.get(name.toLowerCase());
    }

    private initializeMemoryLayout(): void {
        const limit = Math.min(EMU_MEMORY_SIZE, this.getMemory().length);
        this.addressSpace.initializeLayout(limit);
        Mem.sync();
    }

    registerModule(name: string, instance: any) {
        this.modules.set(name.toLowerCase(), instance);
    }

    /**
     * Reset process state - clear memory, dispatcher state, and restore default environment
     */
    async reset(): Promise<void> {
        // --- Zero out memory regions ---
        const mem = this.getMemory();
        if (mem) {
            const totalMemory = Math.min(EMU_MEMORY_SIZE, mem.length);
            // Clear HEAP, THUNK regions, and also LOW_MEM to remove any stale spin loops
            const clearKinds = new Set<RegionKind>(["LOW_MEM", "HEAP", "THUNK_CODE", "CALLBACK_STUB", "SPIN_LOOP", "THUNK_DATA"]);
            const regions = this.addressSpace.getRegions();
            for (const region of regions) {
                if (!clearKinds.has(region.kind)) continue;
                const start = region.base;
                if (start >= totalMemory) continue;
                const end = Math.min(region.base + region.size, totalMemory);
                const size = end - start;
                if (size > 0) {
                    this.addressSpace.fill(start, size, 0);
                }
            }
        }

        this.addressSpace.reset();
        this.initializeMemoryLayout();

        this.memory.reset();
        // Modules map is kept to avoid re-registration overhead, individual modules are reset via System.reset()
        this.dispatcher.reset();
        this.thunkGenerator.reset();
        this.thunkMemoryManager.reset();
        // Thunk stubs are regenerated below — bump the generation so address-keyed
        // caches (kernel32 GetProcAddress) drop stale pre-reset stub addresses.
        this.resetGeneration++;
        this.moduleRegistry.reset();
        this.loader.resetCaches();

        // Re-initialize thunk memory manager after reset
        // Refresh buckets AGAIN before thunk initialization to ensure clean state
        this.memory.refreshLayoutBuckets();

        // Must await to ensure regions are allocated before using them
        await this.thunkMemoryManager.initialize(this.memory, this.getMemory);
        const thunkRegions = this.thunkMemoryManager.getRegions();
        this.thunkGenerator.setBaseAddress(thunkRegions.thunkGeneratorBase);
        // Re-materialize the missing-import UD2 trap (see initialization path above).
        this.thunkGenerator.writeTrapStub(this.getMemory());

        // Re-initialize callback manager to update spinLoopAddress after memory layout change
        // Without this, async thunks redirect to stale/old spinLoop addresses causing infinite loops
        this.dispatcher.initializeCallbackManager(this.getMemory, this.thunkMemoryManager);

        // Re-allocate SEH scratch area after reset
        const sehScratchAddr = this.memory.alloc(SEH_SCRATCH_TOTAL_SIZE, 'THUNK_DATA');
        this.thunkMemoryManager.setSehScratchAddr(sehScratchAddr, SEH_SCRATCH_TOTAL_SIZE);
        this.dispatcher.updateSehScratchAddr(sehScratchAddr);

        // Restore default environment
        this.environment.clear();
        this.environment.set("PATH", "C:\\WINDOWS\\SYSTEM32;C:\\WINDOWS;C:\\");
        this.environment.set("SYSTEMROOT", "C:\\WINDOWS");
        this.environment.set("WINDIR", "C:\\WINDOWS");
        this.environment.set("TEMP", "C:\\TEMP");
        this.environment.set("TMP", "C:\\TEMP");
        this.environment.set("USERNAME", "BottleShip");
        this.environment.set("COMPUTERNAME", "BS-EMULATOR");

        this.lastError = 0;

        Logger.log(LogCategory.SYSTEM, "Process reset");
    }
}
