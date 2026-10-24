/**
 * A thunk that has to call the guest several times, each call depending on the last one's
 * result, written as a generator: `yield` a guest call, receive its EAX, `return` the
 * thunk's own result. COM handlers that are handed a guest-implemented interface (a
 * stream to read, a loader to resolve references through) are the main users.
 *
 * Every hop resumes exactly where this thunk's own `RET N` would have, so a routine may
 * be entered again from inside one of its own guest calls (a loader that loads another
 * object from within GetObject) without the two sharing any frame.
 */
import { Logger, LogCategory } from "../logger";
import { System } from "../system";
import { isValidAddress } from "../memory/address-guard";
import { Mem } from "../memory/mem-accessor";
import type { ThunkResult, X86Context } from "./thunk-dispatcher";

export interface GuestCall {
    /** Address of the stdcall guest function. */
    fn: number;
    args: number[];
    tag: string;
}

export type GuestRoutine = Generator<GuestCall, number, number>;

/**
 * Run `routine` and answer the current thunk with its return value. `stackCleanup` is
 * the number of argument bytes the thunk's `RET N` pops. A call the callback manager
 * refuses, or to a null function, yields E_FAIL to the routine instead of running.
 */
export function runGuestRoutine(
    ctx: X86Context, mem: Uint8Array, routine: GuestRoutine, stackCleanup: number, tag: string,
): number | ThunkResult {
    const E_FAIL = 0x80004005;
    const system = System.getInstance();
    const process = system.process;
    const generation = process?.resetGeneration;
    const ownerThread = system.scheduler.getCurrentThreadId();
    const callbackManager = process?.dispatcher?.callbackManager;
    const entryEsp = ctx.esp >>> 0;
    const extent = 4 + stackCleanup;
    if (!Number.isSafeInteger(stackCleanup) || stackCleanup < 0 || (stackCleanup & 3) !== 0
        || entryEsp + extent > mem.length || !isValidAddress(mem, entryEsp, extent, "r")) {
        routine.return(E_FAIL);
        return E_FAIL;
    }
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const returnAddr = view.getUint32(entryEsp, true) >>> 0;
    const postEsp = entryEsp + extent;
    if (!returnAddr || returnAddr >= mem.length || !isValidAddress(mem, returnAddr, 1, "rx")) {
        routine.return(E_FAIL);
        return E_FAIL;
    }

    let firstCallbackId = 0;
    let finished = false;
    const isLive = (): boolean => system.process === process && process?.resetGeneration === generation
        && process?.dispatcher?.callbackManager === callbackManager && !system.isExiting
        && system.scheduler.getCurrentThreadId() === ownerThread;
    const cancel = (): void => {
        if (finished) return;
        finished = true;
        // Run JS finally blocks, but never dispatch guest Release calls during teardown.
        try {
            let step = routine.return(E_FAIL);
            while (!step.done) step = routine.next(E_FAIL);
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `${tag}: cleanup threw: ${e}`);
        }
    };
    const advance = (input: number): number | null => {
        for (;;) {
            if (finished) return E_FAIL;
            if (!isLive()) {
                cancel();
                return E_FAIL;
            }
            let step: IteratorResult<GuestCall, number>;
            try {
                step = routine.next(input >>> 0);
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `${tag}: routine threw: ${e}`);
                cancel();
                return E_FAIL;
            }
            if (step.done) { finished = true; return step.value >>> 0; }

            const call = step.value;
            if (!call.fn || !callbackManager || (call.fn >>> 0) >= (Mem.getView()?.length ?? mem.length)
                || !isValidAddress(call.fn >>> 0, 1, "rx")) {
                input = E_FAIL;
                continue;
            }
            let invoked: { callbackId: number };
            try {
                invoked = callbackManager.invokeCallback(
                    call.fn, call.args, 0, undefined, false, call.tag, undefined,
                    { directThunkReturn: { returnAddr, postEsp, entryEsp, cancel,
                        complete: (ret: number): number | null => {
                            if (finished || !isLive()) { cancel(); return null; }
                            const result = advance(ret);
                            return isLive() ? result : null;
                        } } },
                );
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `${tag}: callback dispatch failed: ${e}`);
                input = E_FAIL;
                continue;
            }
            if (invoked.callbackId === 0) {
                input = E_FAIL;
                continue;
            }
            if (!firstCallbackId) firstCallbackId = invoked.callbackId;
            return null;
        }
    };

    const immediate = advance(0);
    if (immediate !== null) return immediate;
    return {
        value: 0,
        suspendedForCallback: true,
        callbackId: firstCallbackId,
        stackCleanup,
        skipStackCheck: true,
        preserveCallbackReturnAddress: true,
    };
}
