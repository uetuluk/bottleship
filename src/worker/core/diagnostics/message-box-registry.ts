/**
 * MessageBox ring — the last few boxes the guest showed (caption, text, style,
 * caller). A game that pops an error box and then calls ExitProcess leaves the
 * text only in the log firehose; the exit report needs it beside the thunk ring.
 */

import { TimeService } from "../../runtime/time";

export interface MessageBoxRecent {
    api: string;
    caption: string;
    text: string;
    uType: number;
    caller: number;
    ts: number;
}

const RING_SIZE = 8;
const MAX_TEXT = 512;

class MessageBoxRegistry {
    private ring: MessageBoxRecent[] = new Array(RING_SIZE);
    private ringWrite = 0;
    private ringCount = 0;

    record(api: string, caption: string, text: string, uType: number, caller: number): void {
        const slot = this.ringWrite;
        this.ring[slot] = {
            api,
            caption: caption.slice(0, MAX_TEXT),
            text: text.slice(0, MAX_TEXT),
            uType: uType >>> 0,
            caller: caller >>> 0,
            ts: TimeService.getInstance().nowMs(),
        };
        this.ringWrite = (slot + 1) % RING_SIZE;
        if (this.ringCount < RING_SIZE) this.ringCount++;
    }

    /** Chronological tail, oldest..newest. */
    recent(count = RING_SIZE): MessageBoxRecent[] {
        const n = Math.min(count, this.ringCount);
        if (n <= 0) return [];
        const out: MessageBoxRecent[] = [];
        for (let i = 0; i < n; i++) {
            const entry = this.ring[(this.ringWrite - n + i + RING_SIZE) % RING_SIZE];
            if (entry) out.push(entry);
        }
        return out;
    }

    clear(): void {
        this.ring.fill(undefined as unknown as MessageBoxRecent);
        this.ringWrite = 0;
        this.ringCount = 0;
    }
}

export const messageBoxRegistry = new MessageBoxRegistry();
