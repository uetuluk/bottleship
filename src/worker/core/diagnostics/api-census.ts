/**
 * API call census + silent-stub detector — the companion to stub-registry.ts.
 *
 * stub-registry tracks UNIMPLEMENTED thunks (no JS handler at all → the dispatcher
 * returns ERROR_NOT_SUPPORTED). But the nastier class is the SILENT STUB: a handler
 * that EXISTS and returns a success code (D3D_OK / 0) without doing the real work —
 * `() => D3D_OK`, or one that declares (ctx,mem,args) but ignores them and never
 * writes the out-params the caller reads back. These "pretend to work" and are hell
 * to debug: the game reads uninitialised/garbage data and derails far from the stub.
 *
 * This census records EVERY implemented thunk/COM-method the guest actually calls
 * (deduped, with a hit count + sample caller) and flags the likely silent stubs so
 * `report()` answers "what DX/API did the game use, and which of those are fake?"
 * across ALL modules (DDraw, D3D8, D3D9, D3DX, DInput, …) — not just D3D8.
 *
 * Silent-stub signal:
 *   - arity 0  : `impl.length === 0` → the handler ignores ctx/mem/args entirely
 *                (the `() => D3D_OK` pattern). Strong auto-signal, zero annotation.
 *   - curated  : SILENT_STUBS holds keys for handlers that DECLARE (ctx,mem,args)
 *                but still don't do the work (can't be caught by arity). Add as found.
 *   - E_NOTIMPL: a handler that returned E_NOTIMPL says so itself; the caller usually
 *                treats it as a plain failure and bails quietly (an error box, no write).
 *
 * Zero-alloc on the hot repeat: a repeated call just bumps a counter. Recording is a
 * single Map lookup on the thunk hot path — same cost class as the WinAPI ring.
 */

export interface ApiCallRecord {
    /** "module:Method" (e.g. "d3d8:IDirect3DDevice8_GetLight"). */
    name: string;
    count: number;
    /** Declared parameter count of the JS handler (0 ⇒ ignores ctx/mem/args). */
    arity: number;
    /** True if flagged a likely silent stub (arity 0, curated, or returned E_NOTIMPL). */
    suspectStub: boolean;
    /** The handler returned E_NOTIMPL at least once. */
    notImpl: boolean;
    firstCaller: number;
    lastCaller: number;
    /** Monotonic sequence of the last hit (ordering only; no Date/time on the hot path). */
    lastSeq: number;
}

/**
 * Curated keys for handlers that DECLARE args but are still no-ops / don't fill the
 * out-params the caller reads (arity heuristic can't catch these). Grow as the audit
 * finds them. Key = exact thunk name "module:Method".
 */
export const SILENT_STUBS = new Set<string>([
    // D3D8 — return D3D_OK / a constant without real work or without filling out-params.
    "d3d8:IDirect3DDevice8_Reset",            // recreates device/swapchain → we no-op
    "d3d8:IDirect3DDevice8_GetFrontBuffer",   // should copy front buffer to the given surface
    "d3d8:IDirect3DDevice8_ProcessVertices",  // software T&L+lighting → dest VB; if no-op, garbage verts
]);

class ApiCensus {
    private map = new Map<string, ApiCallRecord>();
    private seq = 0;

    /** Record one implemented dispatch. `arity` = impl.length (handler param count).
     *  Hot-path cheap: a Map lookup + a couple of field writes, no Date/time call. */
    record(name: string, arity: number, caller: number): void {
        const existing = this.map.get(name);
        if (existing) {
            existing.count++;
            existing.lastCaller = caller >>> 0;
            existing.lastSeq = ++this.seq;
            return;
        }
        this.map.set(name, {
            name,
            count: 1,
            arity: arity | 0,
            suspectStub: arity === 0 || SILENT_STUBS.has(name),
            notImpl: false,
            firstCaller: caller >>> 0,
            lastCaller: caller >>> 0,
            lastSeq: ++this.seq,
        });
    }

    /** The sync result of `name` was E_NOTIMPL (called right after record()). */
    noteNotImplemented(name: string): void {
        const rec = this.map.get(name);
        if (rec) rec.suspectStub = rec.notImpl = true;
    }

    /** All recorded calls, most-recently-hit first. */
    list(): ApiCallRecord[] {
        return [...this.map.values()].sort((a, b) => b.lastSeq - a.lastSeq);
    }

    /** Only the likely silent stubs the guest actually CALLED (most-hit first). */
    suspectStubs(): ApiCallRecord[] {
        return [...this.map.values()].filter(r => r.suspectStub).sort((a, b) => b.count - a.count);
    }

    clear(): void {
        this.map.clear();
    }
}

/** Worker-wide singleton (dispatcher records into it, report()/harness read from it). */
export const apiCensus = new ApiCensus();
