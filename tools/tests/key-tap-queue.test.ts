import { describe, expect, test } from "bun:test";
import { KeyTapQueue, type KeyTapSink } from "../../src/app/soft-keyboard";
import { VK_SHIFT } from "../../src/worker/runtime/input/us-keyboard-layout";

/** A sink whose "worker" consumes every publish immediately unless told to lag. */
function makeSink(ackLag = 0) {
    const log: Array<[number, boolean]> = [];
    let published = 0;
    let consumed = 0;
    const sink: KeyTapSink = {
        setKey: (vk, down) => { log.push([vk, down]); published += 2; if (ackLag === 0) consumed = published; },
        publishedSeq: () => published,
        consumedSeq: () => consumed,
    };
    return { sink, log, ack: () => { consumed = published; }, publishedNow: () => published, consumedNow: () => consumed };
}

const settle = (q: KeyTapQueue) => new Promise<void>((resolve) => {
    const tick = () => (q.busy || q.pending ? setTimeout(tick, 2) : resolve());
    tick();
});

describe("KeyTapQueue", () => {
    test("types a chord as press/release with Shift bracketing", async () => {
        const { sink, log } = makeSink();
        const q = new KeyTapQueue(sink, { holdMs: 1, pollMs: 1 });
        expect(q.typeText("aB")).toBe(2);
        await settle(q);
        expect(log).toEqual([
            [0x41, true], [0x41, false],
            [VK_SHIFT, true], [0x42, true], [0x42, false], [VK_SHIFT, false],
        ]);
    });

    test("skips characters no key produces", async () => {
        const { sink, log } = makeSink();
        const q = new KeyTapQueue(sink, { holdMs: 1, pollMs: 1 });
        expect(q.typeText("é1")).toBe(1);
        await settle(q);
        expect(log).toEqual([[0x31, true], [0x31, false]]);
    });

    test("holds the press until the worker acknowledges it", async () => {
        const s = makeSink(1);
        const q = new KeyTapQueue(s.sink, { holdMs: 1, pollMs: 2, ackTimeoutMs: 1000 });
        q.tap(0x41);
        await new Promise((r) => setTimeout(r, 30));
        expect(s.log).toEqual([[0x41, true]]); // still down: nothing consumed yet
        s.ack();
        await settle(q);
        expect(s.log).toEqual([[0x41, true], [0x41, false]]);
    });

    test("gives up waiting after the ack timeout", async () => {
        const s = makeSink(1);
        const q = new KeyTapQueue(s.sink, { holdMs: 1, pollMs: 2, ackTimeoutMs: 10 });
        q.tap(0x41);
        await settle(q);
        expect(s.log).toEqual([[0x41, true], [0x41, false]]);
    });

    test("clear drops taps not yet started", async () => {
        const s = makeSink(1);
        const q = new KeyTapQueue(s.sink, { holdMs: 1, pollMs: 2, ackTimeoutMs: 10 });
        q.typeText("abc");
        q.clear();
        await settle(q);
        expect(s.log.length).toBe(2); // only the tap already in flight
    });
});
