/**
 * Run an ordered sequence of stdcall guest calls from inside one thunk (a COM helper
 * such as OleSaveToStream calling GetClassID → Write → Save). The generator yields each
 * call and receives its EAX; its return value becomes the thunk's EAX. The thunk stays
 * suspended across the whole chain, exactly like a synchronous Win32 call.
 */
import type { ThunkResult } from '../thunking/thunk-dispatcher';
import { System } from '../system';
import { Logger, LogCategory } from '../logger';

export interface GuestCall {
    fn: number;
    args: number[];
}

export type GuestCallChain = Generator<GuestCall, number, number>;

/** Address of vtable slot `slot` of the COM object at `obj`, or 0 when unreadable. */
export function guestVtblSlot(mem: Uint8Array, obj: number, slot: number): number {
    if (!obj || obj + 4 > mem.length) return 0;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const vtbl = view.getUint32(obj, true) >>> 0;
    if (!vtbl || vtbl + (slot + 1) * 4 > mem.length) return 0;
    return view.getUint32(vtbl + slot * 4, true) >>> 0;
}

/** A COM method call `obj->vtbl[slot](obj, ...args)`. */
export function comCall(mem: Uint8Array, obj: number, slot: number, ...args: number[]): GuestCall {
    return { fn: guestVtblSlot(mem, obj, slot), args: [obj >>> 0, ...args.map((a) => a >>> 0)] };
}

/**
 * Drive `chain`. Returns its value directly when it needs no guest call, otherwise a
 * suspended-thunk result that resumes the caller with the chain's final value.
 */
export function runGuestCallChain(
    ctx: { esp: number },
    mem: Uint8Array,
    stackCleanup: number,
    tag: string,
    chain: GuestCallChain,
    failValue: number,
): number | ThunkResult {
    let step = chain.next();
    // Resolve missing methods before a frame exists, so a chain that needs no guest
    // call returns synchronously without leaving a suspended frame behind.
    while (!step.done && !step.value.fn) {
        Logger.warn(LogCategory.COM, `${tag}: guest method missing (this=0x${(step.value.args[0] ?? 0).toString(16)})`);
        step = chain.next(failValue >>> 0);
    }
    if (step.done) return step.value >>> 0;

    const callbackManager = System.getInstance().process?.dispatcher?.callbackManager;
    if (!callbackManager) return failValue >>> 0;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const frameId = callbackManager.saveSuspendedThunkContext(
        { ...ctx, returnAddr: view.getUint32(ctx.esp, true) }, stackCleanup, tag);
    if (frameId === 0) return failValue >>> 0;

    // Dispatch the pending call; a call to a missing method fails the chain.
    const dispatch = (): number => {
        while (!step.done) {
            const call = step.value;
            if (!call.fn) {
                Logger.warn(LogCategory.COM, `${tag}: guest method missing (this=0x${(call.args[0] ?? 0).toString(16)})`);
                step = chain.next(failValue >>> 0);
                continue;
            }
            const inv = callbackManager.invokeCallback(call.fn, call.args, 0, onReturn, false, tag, frameId);
            if (inv.callbackId !== 0) return inv.callbackId;
            step = chain.next(failValue >>> 0);
        }
        return 0;
    };
    const onReturn = (ret: number): number | null => {
        step = chain.next(ret >>> 0);
        if (step.done) return step.value >>> 0;
        return dispatch() !== 0 ? null : finalValue();
    };
    // dispatch() only returns 0 once the chain has finished.
    const finalValue = (): number => (step as IteratorReturnResult<number>).value >>> 0;

    const firstId = dispatch();
    if (firstId === 0) {
        // Nothing could be dispatched; the chain already finished synchronously.
        return { value: finalValue(), stackCleanup };
    }
    return { value: 0, suspendedForCallback: true, callbackId: firstId, stackCleanup, skipStackCheck: true };
}
