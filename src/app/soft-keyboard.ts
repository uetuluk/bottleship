/**
 * Key-tap queue for text that arrives as characters rather than key presses (a soft
 * keyboard's `beforeinput`, IME composition, paste). Each character becomes the US
 * chord that types it, pressed and released as a real key would be: the guest polls
 * the SAB key bitfield, so a press must stay published until the worker has consumed
 * it (pollAck) and for at least a frame, or state-polling games never see the key.
 */
import { charToKey, VK_SHIFT, type KeyChord } from "../worker/runtime/input/us-keyboard-layout";

export interface KeyTapSink {
    /** Publish a key level to the guest (SAB bitfield + input_tick). */
    setKey(vk: number, down: boolean): void;
    /** Sequence number of the most recently published input record. */
    publishedSeq(): number;
    /** Sequence number the worker last consumed (its pollAck slot). */
    consumedSeq(): number;
}

export interface KeyTapOptions {
    /** Minimum time a key stays down after the worker consumed the press. */
    holdMs: number;
    /** Give up waiting for the worker's ack after this long (busy JIT loop). */
    ackTimeoutMs: number;
    pollMs: number;
}

const DEFAULTS: KeyTapOptions = { holdMs: 40, ackTimeoutMs: 250, pollMs: 8 };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class KeyTapQueue {
    private readonly queue: KeyChord[] = [];
    private running = false;
    private readonly opts: KeyTapOptions;

    constructor(private readonly sink: KeyTapSink, opts: Partial<KeyTapOptions> = {}) {
        this.opts = { ...DEFAULTS, ...opts };
    }

    /** Queue every typeable character of `text`; returns how many were queued. */
    typeText(text: string): number {
        let n = 0;
        for (const ch of text) {
            const chord = charToKey(ch);
            if (!chord) continue;
            this.queue.push(chord);
            n++;
        }
        this.kick();
        return n;
    }

    tap(vk: number, shift = false): void {
        this.queue.push({ vk: vk & 0xff, shift });
        this.kick();
    }

    get pending(): number { return this.queue.length; }
    get busy(): boolean { return this.running; }

    /** Drop queued (not yet started) taps — e.g. on focus loss. */
    clear(): void { this.queue.length = 0; }

    private kick(): void {
        if (this.running) return;
        this.running = true;
        void this.run();
    }

    private async run(): Promise<void> {
        try {
            while (this.queue.length > 0) await this.press(this.queue.shift()!);
        } finally {
            this.running = false;
        }
    }

    private async press(chord: KeyChord): Promise<void> {
        if (chord.shift) { this.sink.setKey(VK_SHIFT, true); await this.settle(); }
        this.sink.setKey(chord.vk, true);
        await this.settle();
        await sleep(this.opts.holdMs);
        this.sink.setKey(chord.vk, false);
        await this.settle();
        if (chord.shift) { this.sink.setKey(VK_SHIFT, false); await this.settle(); }
    }

    /** Resolve once the worker has consumed the record just published (or on timeout). */
    private async settle(): Promise<void> {
        const target = this.sink.publishedSeq();
        const deadline = Date.now() + this.opts.ackTimeoutMs;
        while (this.sink.consumedSeq() < target && Date.now() < deadline) await sleep(this.opts.pollMs);
    }
}
