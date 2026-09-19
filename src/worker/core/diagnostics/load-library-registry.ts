/**
 * LoadLibrary ring — chronological record of the guest's DLL load requests and
 * how each resolved. A NULL result is the bring-up signal: a game that asks for
 * a DLL we neither ship as HLE nor find on the VFS typically shows one error
 * box and exits, and the thunk ring alone (ids + ESP) never names the DLL.
 */

import { TimeService } from "../../runtime/time";

export interface LoadLibraryRecent {
    api: string;
    name: string;
    /** Returned HMODULE; 0 = failure (see `note`). */
    handle: number;
    /** How the request resolved ("hle", "native", "cached") or why it failed. */
    note: string;
    caller: number;
    ts: number;
}

const RING_SIZE = 32;

class LoadLibraryRegistry {
    private ring: LoadLibraryRecent[] = new Array(RING_SIZE);
    private ringWrite = 0;
    private ringCount = 0;

    record(api: string, name: string, handle: number, note: string, caller: number): void {
        const slot = this.ringWrite;
        this.ring[slot] = {
            api,
            name,
            handle: handle >>> 0,
            note,
            caller: caller >>> 0,
            ts: TimeService.getInstance().nowMs(),
        };
        this.ringWrite = (slot + 1) % RING_SIZE;
        if (this.ringCount < RING_SIZE) this.ringCount++;
    }

    /** Chronological tail, oldest..newest. */
    recent(count = 16): LoadLibraryRecent[] {
        const n = Math.min(count, this.ringCount);
        if (n <= 0) return [];
        const out: LoadLibraryRecent[] = [];
        for (let i = 0; i < n; i++) {
            const entry = this.ring[(this.ringWrite - n + i + RING_SIZE) % RING_SIZE];
            if (entry) out.push(entry);
        }
        return out;
    }

    /** Failed requests (handle 0), oldest..newest. */
    failures(): LoadLibraryRecent[] {
        return this.recent(RING_SIZE).filter((e) => e.handle === 0);
    }

    clear(): void {
        this.ring.fill(undefined as unknown as LoadLibraryRecent);
        this.ringWrite = 0;
        this.ringCount = 0;
    }
}

export const loadLibraryRegistry = new LoadLibraryRegistry();
