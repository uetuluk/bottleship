// Suspended-frame nesting, reaping, and cross-thread ownership.

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

const T1 = 1;

/** Track frame pins so leaks are visible. */
let pinCount = 0;
let currentThreadId = T1;
let wakeAllowed = true;
const reportFatal = mock(() => {});
const wakeCurrent = mock(() => wakeAllowed);

import { System } from '../../src/worker/core/system';
import { CallbackManager } from '../../src/worker/core/thunking/callback-manager';

let systemSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
    systemSpy = spyOn(System, 'getInstance').mockReturnValue({
        scheduler: {
            getCurrentThreadId: () => currentThreadId,
            wakeCurrentThreadForCallbackDispatch: wakeCurrent,
            reportCallbackFrameFatal: reportFatal,
            pinCallbackFrame: () => { pinCount++; },
            unpinCallbackFrame: () => { if (pinCount > 0) pinCount--; },
        },
    } as any);
});
afterEach(() => systemSpy.mockRestore());

function mkManager(): any {
    pinCount = 0;
    currentThreadId = T1;
    wakeAllowed = true;
    reportFatal.mockClear();
    wakeCurrent.mockClear();
    const mem = new Uint8Array(0x2000000);
    return new (CallbackManager as any)({} as any, {} as any, () => mem);
}

/** Push a frame directly through the private allocator (the reap hook under test). */
function push(cm: any, esp: number, source: string, threadId = T1): number {
    return cm.allocateSuspendedFrame(threadId, esp, 0x400000, 0x14, source);
}

function depth(cm: any): number { return cm.frameStackDepth; }

function entryEsps(cm: any): number[] {
    const out: number[] = [];
    for (let i = 0; i < cm.frameStackDepth; i++) out.push(cm.frameEspEntry[cm.frameStack[i]] >>> 0);
    return out;
}

describe('suspended-frame reaping', () => {
    let cm: any;
    beforeEach(() => { cm = mkManager(); });

    it('keeps genuinely nested frames (strictly decreasing entry ESP)', () => {
        push(cm, 0x11ff4b4, 'DispatchMessageW');
        push(cm, 0x11ff190, 'CallWindowProcA');
        push(cm, 0x11ff140, 'CallWindowProcA');
        expect(depth(cm)).toBe(3);
        expect(entryEsps(cm)).toEqual([0x11ff4b4, 0x11ff190, 0x11ff140]);
        expect(pinCount).toBe(3);
    });

    it('reaps a frame the guest unwound past, and releases its pin', () => {
        push(cm, 0x11ff4b4, 'DispatchMessageW');
        push(cm, 0x11ff190, 'CallWindowProcA');
        push(cm, 0x11fe200, 'SendMessageW');   // deepest so far
        expect(depth(cm)).toBe(3);
        expect(pinCount).toBe(3);

        // The guest returned past SendMessageW without unwinding it: the next frame
        // enters at an ESP ABOVE it. That proves 0x11fe200's slot was reused.
        push(cm, 0x11fea98, 'CallWindowProcA');

        expect(entryEsps(cm)).toEqual([0x11ff4b4, 0x11ff190, 0x11fea98]);
        expect(depth(cm)).toBe(3);
        expect(pinCount).toBe(3); // stale pin dropped, new one taken — no leak
    });

    it('leaves the stack strictly decreasing after a reap', () => {
        for (const [esp, src] of [
            [0x11ff4b4, 'DispatchMessageW'], [0x11ff190, 'CallWindowProcA'],
            [0x11ff140, 'CallWindowProcA'], [0x11fe200, 'SendMessageW'],
            [0x11fea98, 'CallWindowProcA'], [0x11fe6cc, 'SendMessageW'],
            [0x11fe3a8, 'CallWindowProcA'], [0x11fe358, 'CallWindowProcA'],
        ] as [number, string][]) push(cm, esp, src);

        const esps = entryEsps(cm);
        for (let i = 1; i < esps.length; i++) expect(esps[i]).toBeLessThan(esps[i - 1]);
        expect(pinCount).toBe(depth(cm)); // pins stay balanced with live frames
    });

    it('does not reap frames belonging to another thread', () => {
        // T2's frame sits at a LOWER entry ESP than the T1 frames that follow it.
        // Threads have separate stacks, so that ordering says nothing about T2 —
        // only same-thread frames may be reaped.
        push(cm, 0x21ff000, 'DispatchMessageW', 2);
        push(cm, 0x11ff400, 'CallWindowProcA', T1);
        push(cm, 0x11ff190, 'CallWindowProcA', T1);
        expect(depth(cm)).toBe(3);

        // This T1 frame reaps the T1 frames below it, and must leave T2's alone.
        push(cm, 0x11ff4b4, 'CallWindowProcA', T1);
        const threads = [];
        for (let i = 0; i < cm.frameStackDepth; i++) threads.push(cm.frameThreadId[cm.frameStack[i]] >>> 0);
        expect(threads).toEqual([2, T1]);
    });
});


describe('suspended-frame ownership', () => {
    it('resolves the innermost frame for each thread independently', () => {
        const cm = mkManager();
        const outer = push(cm, 0x11ff400, 'outer');
        expect(cm.hasSavedThunkContextForThread(2)).toBe(false);
        currentThreadId = 2;
        expect(cm.getTopSuspendedFrameId()).toBe(0);
        const peer = push(cm, 0x21ff400, 'peer', 2);
        currentThreadId = 1;
        const inner = push(cm, 0x11ff100, 'inner');
        expect(cm.getTopSuspendedFrameId()).toBe(inner);
        currentThreadId = 2;
        expect(cm.getTopSuspendedFrameId()).toBe(peer);
        expect(cm.hasSavedThunkContextForThread(1)).toBe(true);
        expect(cm.hasSavedThunkContextForThread(2)).toBe(true);
        cm.releaseFrame(cm.findFrameIndexById(inner));
        currentThreadId = 1;
        expect(cm.getTopSuspendedFrameId()).toBe(outer);
    });

    for (const wrongOwner of [true, false]) {
        it(`rejects ${wrongOwner ? 'another thread' : 'a non-wakeable owner'} before touching CPU or stack`, () => {
            const cm = mkManager();
            const frame = push(cm, 0x11ff400, 'dialog');
            const stub = { callbackId: 42, address: 0x100000, inUse: true };
            cm.getReturnStub = () => stub;
            // No CPU is provided: reaching any register/stack access would throw.
            currentThreadId = wrongOwner ? 2 : 1;
            wakeAllowed = false;
            expect(cm.invokeCallback(0x400000, [], 0, () => 0, false, 'dialog', frame))
                .toEqual({ callbackId: 0 });
            expect(stub.inUse).toBe(false);
            expect(reportFatal).toHaveBeenCalledTimes(1);
            expect(wakeCurrent).toHaveBeenCalledTimes(wrongOwner ? 0 : 1);
        });
    }
});

describe('callback nesting depth', () => {
    it('accepts a guest callback a dozen suspended frames deep (dialog SendMessage chains)', () => {
        const cm = mkManager();
        const reg32 = new Int32Array(8);
        reg32[4] = 0x11fe000;
        cm.v86 = { cpu: { reg32, instruction_pointer: new Int32Array(1) } };
        cm.initialize();
        for (let i = 0; i < 12; i++) push(cm, 0x11ff000 - i * 0x100, `nest${i}`);
        expect(depth(cm)).toBe(12);
        const { callbackId } = cm.invokeCallback(0x594660, [0x10062, 0x465, 0, 0], 16, undefined, false, 'CallWindowProcA');
        expect(callbackId).not.toBe(0);
    });
});
