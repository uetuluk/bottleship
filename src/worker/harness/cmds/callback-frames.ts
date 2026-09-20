/** Inspect callback nesting and pin pressure; a snapshot alone cannot prove starvation. */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { ThreadState, THREAD_STATE_NAMES } from "../../core/scheduler/types";
import { sys, proc } from "../serialize";

const hx = (v: number): string => "0x" + (v >>> 0).toString(16);

export function registerCallbackFrameCommands(svc: HarnessService): void {
    svc.register("callbackFrames", () => {
        const cm = proc()?.dispatcher?.callbackManager;
        if (!cm?.snapshotSuspendedFrames) {
            throw new HarnessError("callbackManager unavailable (no process loaded?)", HarnessErrorCode.BAD_ARGS);
        }
        const scheduler = sys().scheduler as unknown as {
            getCurrentThreadId?: () => number;
            threads?: Map<number, { id: number; state: number; stateName?: string; kernelPinCount: number }>;
            runQueue?: number[];
        };

        const snapshot: import("../../core/thunking/callback-manager").SuspendedThunkFrame[] = cm.snapshotSuspendedFrames();
        const depth = snapshot.length;
        const frames: Array<Record<string, unknown>> = [];
        const liveByThread = new Map<number, number>();
        // Per thread, the entry ESP of the previous (outer) frame — nested frames must
        // sit strictly below it.
        const prevEsp = new Map<number, number>();
        let inversions = 0;

        for (let i = 0; i < depth; i++) {
            const frame = snapshot[i];
            const tid = frame.threadId;
            const esp = frame.espEntry;
            const outer = prevEsp.get(tid);
            const monotonic = outer === undefined || esp < outer;
            if (!monotonic) inversions++;
            prevEsp.set(tid, esp);
            liveByThread.set(tid, (liveByThread.get(tid) ?? 0) + 1);

            frames.push({
                depth: i,
                frameId: frame.frameId,
                threadId: tid,
                source: frame.source,
                espEntry: hx(esp),
                returnAddr: hx(frame.returnAddr),
                callbackId: hx(frame.callbackId),
                stackCleanup: frame.thunkCleanup,
                // false => the guest unwound past this frame; its slot was reused.
                espMonotonic: monotonic,
            });
        }

        const runQueue = Array.isArray(scheduler.runQueue) ? scheduler.runQueue.slice() : [];
        const currentThreadId = scheduler.getCurrentThreadId?.() ?? null;
        const pins: Array<Record<string, unknown>> = [];
        let pinnedRunning: number | null = null;
        for (const t of scheduler.threads?.values() ?? []) {
            const live = liveByThread.get(t.id) ?? 0;
            const pin = t.kernelPinCount | 0;
            if (pin > 0 && t.state === ThreadState.RUNNING) pinnedRunning = t.id;
            pins.push({
                threadId: t.id,
                state: THREAD_STATE_NAMES[t.state as ThreadState] ?? t.state,
                kernelPinCount: pin,
                liveFrames: live,
                // Timer callbacks and critical runtimes can hold pins without frames.
                nonFramePins: Math.max(0, pin - live),
            });
        }
        const otherReady = pins.some((p) => p.threadId !== pinnedRunning && String(p.state).toUpperCase().includes("READY"))
            || runQueue.some((id) => id !== pinnedRunning);
        // Timer and critical-runtime pins are separate from suspended-frame pressure.
        const starvingFrames = pinnedRunning !== null ? (liveByThread.get(pinnedRunning) ?? 0) : 0;

        let verdict: string;
        if (inversions > 0) {
            verdict = `ORPHANED_FRAMES: ${inversions} inner frame(s) sit at or above their outer frame — ` +
                `the guest unwound past them without returning through their stub. Their pins are stuck, ` +
                `so the owning thread can never be switched away from.`;
        } else if (pinnedRunning !== null && otherReady && starvingFrames > 0) {
            verdict = `POSSIBLE_PIN_STARVATION: T${pinnedRunning} is RUNNING and pinned by ${starvingFrames} ` +
                `live callback frame(s) while another thread is READY. If the guest is waiting inside the callback ` +
                `on state that thread must produce, this is a livelock — check the thunk ring for a repeating ` +
                `wait/release loop (report().thunkTrace). Check thread progress and UI responsiveness; ` +
                `stable frame ids alone do not prove starvation.`;
        } else if (depth === 0) {
            verdict = "ok: no suspended callback frames";
        } else {
            verdict = `ok: ${depth} live frame(s), strictly nested, no callback-frame pin pressure detected`;
        }

        return { depth, frames, pins, runQueue, currentThreadId, inversions, verdict };
    });
}
