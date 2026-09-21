/**
 * IDirectPlay4A — guest ABI over DPlayEngine.
 *
 * One engine per DirectPlay object: the object is the session handle, so two objects in one
 * process are independent peers (a game may enumerate on one and host on another). Everything
 * here is marshalling: DPSESSIONDESC2/DPNAME/DPCAPS/DPMSG_* structs, the size-query protocol
 * (write the required size, return DPERR_BUFFERTOOSMALL) and enumeration callbacks.
 */

import type { Process } from "../../core/process";
import type { ThunkImplementation, ThunkResult } from "../../core/thunking/thunk-dispatcher";
import { Mem } from "../../core/memory/mem-accessor";
import { Logger, LogCategory } from "../../core/logger";
import { System } from "../../core/system";
import { getNetStack } from "../../core/net/net-stack";
import { getVirtualNic } from "../../core/net/virtual-nic";
import { hostToIp, ipToString } from "../../../net/nic-contract";
import { encodeAnsi, readAnsiFromGuest } from "../codepage-utils";
import {
    DP_OK,
    DPERR_ALREADYINITIALIZED,
    DPERR_BUFFERTOOSMALL,
    DPERR_INVALIDGROUP,
    DPERR_INVALIDPARAMS,
    DPERR_INVALIDPLAYER,
    DPERR_NOCONNECTION,
    DPERR_NOMESSAGES,
    DPERR_UNINITIALIZED,
    DPERR_UNKNOWNMESSAGE,
    DPENUMSESSIONS_ASYNC,
    DPENUMSESSIONS_STOPASYNC,
    DPID_SERVERPLAYER,
    DPLAY_DEFAULT_TIMEOUT_MS,
    DPLAY_ENUM_PORT,
    DPPLAYER_LOCAL,
    DPPLAYER_SERVERPLAYER,
    DPPLAYER_SPECTATOR,
    DPSYS_ADDPLAYERTOGROUP,
    DPSYS_CREATEPLAYERORGROUP,
    DPSYS_DELETEPLAYERFROMGROUP,
    DPSYS_DESTROYPLAYERORGROUP,
    DPSYS_SENDCOMPLETE,
    DPSYS_SESSIONLOST,
    DPSYS_SETPLAYERORGROUPDATA,
    DPSYS_SETPLAYERORGROUPNAME,
    DPSYS_SETSESSIONDESC,
    DPlayEngine,
    type Entity,
    type NameSnapshot,
    type SessionDesc,
    type SystemMessage,
} from "./dplay-sp";

const E_NOTIMPL = 0x80004001;
const DPERR_CONNECTING = 0x8877015e;

// {36E95EE0-8577-11cf-960C-0080C7534E82}
export const DPSPGUID_TCPIP = new Uint8Array([
    0xe0, 0x5e, 0xe9, 0x36, 0x77, 0x85, 0xcf, 0x11, 0x96, 0x0c, 0x00, 0x80, 0xc7, 0x53, 0x4e, 0x82,
]);
// {07D916C0-E0AF-11cf-9C4E-00A0C905425E}
export const DPAID_SERVICEPROVIDER = new Uint8Array([
    0xc0, 0x16, 0xd9, 0x07, 0xaf, 0xe0, 0xcf, 0x11, 0x9c, 0x4e, 0x00, 0xa0, 0xc9, 0x05, 0x42, 0x5e,
]);
// {1318F560-912C-11d0-9DAA-00A0C90A43CB}
export const DPAID_TOTALSIZE = new Uint8Array([
    0x60, 0xf5, 0x18, 0x13, 0x2c, 0x91, 0xd0, 0x11, 0x9d, 0xaa, 0x00, 0xa0, 0xc9, 0x0a, 0x43, 0xcb,
]);
// {C4A54DA0-E0AF-11cf-9C4E-00A0C905425E}
const DPAID_INET = new Uint8Array([
    0xa0, 0x4d, 0xa5, 0xc4, 0xaf, 0xe0, 0xcf, 0x11, 0x9c, 0x4e, 0x00, 0xa0, 0xc9, 0x05, 0x42, 0x5e,
]);
// {E4524541-8EA5-11d1-8A96-006097B01411}
const DPAID_INETPORT = new Uint8Array([
    0x41, 0x45, 0x52, 0xe4, 0xa5, 0x8e, 0xd1, 0x11, 0x8a, 0x96, 0x00, 0x60, 0x97, 0xb0, 0x14, 0x11,
]);
export const TCPIP_PROVIDER_NAME = "Internet TCP/IP Connection For DirectPlay";

const DPOPEN_JOIN = 0x1;
const DPOPEN_CREATE = 0x2;
const DPOPEN_RETURNSTATUS = 0x80;
const DPRECEIVE_ALL = 0x1;
const DPRECEIVE_TOPLAYER = 0x2;
const DPRECEIVE_FROMPLAYER = 0x4;
const DPRECEIVE_PEEK = 0x8;
const DPSEND_ASYNC = 0x200;
const DPSEND_NOSENDCOMPLETEMSG = 0x400;
const DPGET_LOCAL = 0x1;
const DPSET_LOCAL = 0x1;
const DPCONNECTION_DIRECTPLAY = 0x1;
const DPESC_TIMEDOUT = 0x1;
const DPENUMPLAYERS_LOCAL = 0x8;
const DPENUMPLAYERS_REMOTE = 0x10;
const DPENUMPLAYERS_GROUP = 0x20;
const DPENUMPLAYERS_SESSION = 0x80;
const DPENUMPLAYERS_SERVERPLAYER = 0x100;
const DPENUMPLAYERS_SPECTATOR = 0x200;
const DPPLAYERTYPE_GROUP = 0;
const DPPLAYERTYPE_PLAYER = 1;
const DPMESSAGEQUEUE_SEND = 0x1;
const DPMESSAGEQUEUE_RECEIVE = 0x2;
const DPCAPS_ISHOST = 0x2;
const DPCAPS_GUARANTEEDOPTIMIZED = 0x20;
const DPCAPS_GUARANTEEDSUPPORTED = 0x40;
const DPCAPS_ASYNCSUPPORTED = 0x2000;
const DPPLAYERCAPS_LOCAL = 0x800;

const DPSESSIONDESC2_SIZE = 80;
const DPNAME_SIZE = 16;
const DPCAPS_SIZE = 40;
/** SP header plus idFrom/idTo: what DirectPlay adds to every user message. */
const DPLAY_HEADER_LENGTH = 28;
const DPLAY_MAX_BUFFER = 65479;

/** stdcall bytes popped by each enumerating method (this + params). */
const CLEANUP = {
    EnumSessions: 24,
    EnumConnections: 20,
    EnumPlayers: 20,
    EnumGroups: 20,
    EnumGroupPlayers: 24,
    EnumGroupsInGroup: 24,
} as const;

/** Per-object DirectPlay state; lives on the COM object and dies with it. */
export class DirectPlayInstance {
    readonly engine: DPlayEngine;
    connected = false;
    joining = false;
    /** CreatePlayer hEvent per local player, set when a message for it is queued. */
    readonly events = new Map<number, number>();

    constructor() {
        this.engine = new DPlayEngine(getNetStack(), getVirtualNic(), {
            onQueued: (to) => this.signal(to),
        });
    }

    private signal(to: number): void {
        const handle = this.events.get(to >>> 0) ?? (to === 0 ? this.events.values().next().value : undefined);
        if (handle) System.getInstance().scheduler.setEvent(handle);
    }
}

type Ctx = { esp: number; returnAddr?: number };

const rd = (addr: number): number => Mem.readUint32(addr) ?? 0;
const wr = (addr: number, value: number): void => {
    Mem.writeUint32(addr, value >>> 0);
};
const ansiz = (s: string): Uint8Array => {
    const b = encodeAnsi(s);
    const out = new Uint8Array(b.length + 1);
    out.set(b);
    return out;
};

export interface DirectPlay4Deps {
    process: Process;
    memory: () => Uint8Array;
    validateRange: (address: number, size: number, perms: "r" | "rw" | "rx") => boolean;
    /** Resolve the instance for a `this` pointer, or null for an invalid object. */
    instance: (thisPtr: number) => DirectPlayInstance | null;
}

/** Pump instances whose players registered events, so a thread asleep on one wakes on arrival. */
const EVENT_PUMP_MS = 5;

export class DirectPlay4Api {
    private readonly pumped = new Set<DirectPlayInstance>();
    private pumpTimer: ReturnType<typeof setInterval> | null = null;

    constructor(private readonly deps: DirectPlay4Deps) {}

    // ─── guest struct helpers ────────────────────────────────────────────────

    private str(ptr: number): string {
        return ptr ? readAnsiFromGuest(this.deps.memory(), ptr) : "";
    }

    private readName(lpName: number): NameSnapshot {
        if (!lpName || !this.deps.validateRange(lpName, DPNAME_SIZE, "r")) {
            return { shortName: "", longName: "", hasName: false };
        }
        return { shortName: this.str(rd(lpName + 8)), longName: this.str(rd(lpName + 12)), hasName: true };
    }

    private readData(ptr: number, size: number): Uint8Array | null {
        if (size === 0) return new Uint8Array(0);
        if (!ptr || !this.deps.validateRange(ptr, size, "r")) return null;
        return Mem.readBytes(ptr, size);
    }

    private readSessionDesc(lpsd: number): SessionDesc | null {
        if (!lpsd || !this.deps.validateRange(lpsd, DPSESSIONDESC2_SIZE, "r")) return null;
        return {
            flags: rd(lpsd + 4),
            guidInstance: Mem.readBytes(lpsd + 8, 16) ?? new Uint8Array(16),
            guidApplication: Mem.readBytes(lpsd + 24, 16) ?? new Uint8Array(16),
            maxPlayers: rd(lpsd + 40),
            currentPlayers: rd(lpsd + 44),
            name: this.str(rd(lpsd + 48)),
            password: this.str(rd(lpsd + 52)),
            user: [rd(lpsd + 64), rd(lpsd + 68), rd(lpsd + 72), rd(lpsd + 76)],
        };
    }

    /** DPSESSIONDESC2 at `at`, strings packed at `strings`; returns bytes used after the struct. */
    private writeSessionDesc(at: number, d: SessionDesc, strings: number, withPassword: boolean): number {
        let cursor = strings;
        const put = (s: string): number => {
            if (!s) return 0;
            const b = ansiz(s);
            Mem.writeBytes(cursor, b);
            const p = cursor;
            cursor += b.length;
            return p;
        };
        wr(at, DPSESSIONDESC2_SIZE);
        wr(at + 4, d.flags);
        Mem.writeBytes(at + 8, d.guidInstance);
        Mem.writeBytes(at + 24, d.guidApplication);
        wr(at + 40, d.maxPlayers);
        wr(at + 44, d.currentPlayers);
        wr(at + 48, put(d.name));
        wr(at + 52, withPassword ? put(d.password) : 0);
        wr(at + 56, 0);
        wr(at + 60, 0);
        for (let i = 0; i < 4; i++) wr(at + 64 + i * 4, d.user[i]!);
        return cursor - strings;
    }

    private sessionDescSize(d: SessionDesc, withPassword: boolean): number {
        const n = (s: string) => (s ? encodeAnsi(s).length + 1 : 0);
        return DPSESSIONDESC2_SIZE + n(d.name) + (withPassword ? n(d.password) : 0);
    }

    private nameSize(n: NameSnapshot): number {
        if (!n.hasName) return 0;
        return (n.shortName ? encodeAnsi(n.shortName).length + 1 : 0) + (n.longName ? encodeAnsi(n.longName).length + 1 : 0);
    }

    /** DPNAME at `at`, strings at `strings`; returns string bytes written. */
    private writeName(at: number, n: NameSnapshot, strings: number): number {
        let cursor = strings;
        const put = (s: string): number => {
            if (!n.hasName || !s) return 0;
            const b = ansiz(s);
            Mem.writeBytes(cursor, b);
            const p = cursor;
            cursor += b.length;
            return p;
        };
        wr(at, DPNAME_SIZE);
        wr(at + 4, 0);
        wr(at + 8, put(n.shortName));
        wr(at + 12, put(n.longName));
        return cursor - strings;
    }

    /** The size-query protocol: report `required`, fail small buffers, else fill. */
    private fill(lpData: number, lpdwSize: number, required: number, write: (base: number) => void): number {
        if (!lpdwSize || !this.deps.validateRange(lpdwSize, 4, "rw")) return DPERR_INVALIDPARAMS;
        const capacity = rd(lpdwSize);
        wr(lpdwSize, required);
        if (!lpData || capacity < required) return DPERR_BUFFERTOOSMALL;
        if (!this.deps.validateRange(lpData, required, "rw")) return DPERR_INVALIDPARAMS;
        write(lpData);
        return DP_OK;
    }

    // ─── callback chains ─────────────────────────────────────────────────────

    /**
     * Invoke `callback` for each argument list `next` produces, feeding it the previous return
     * value; `next` returning null (or a callback returning FALSE, as `next` decides) ends the
     * chain, and `finish()` becomes the method's return value. Returns the suspended-thunk result,
     * or null when there was nothing to call (the caller then returns synchronously).
     */
    private runChain(
        ctx: Ctx,
        stackCleanup: number,
        callback: number,
        next: (previous: number | null) => number[] | null,
        finish: () => number,
    ): ThunkResult | null {
        const cm = this.deps.process.dispatcher.callbackManager;
        const first = next(null);
        if (!first || !cm) return null;
        cm.saveSuspendedThunkContext(ctx, stackCleanup);

        let pending: number[] = first;
        let firstId: number | null = null;
        const invoke = (): void => {
            const { callbackId } = cm.invokeCallback(callback, pending, 0, (ret) => {
                const more = next(ret);
                if (!more) return finish();
                pending = more;
                return null;
            });
            if (firstId === null) firstId = callbackId;
            const invocation = cm.getPendingCallback(callbackId);
            if (invocation) {
                invocation.enumerationState = { continueEnumeration: invoke, finishEnumeration: () => {} };
                if (callbackId !== firstId) {
                    const head = cm.getPendingCallback(firstId);
                    if (head?.thunkContext) invocation.thunkContext = head.thunkContext;
                }
            }
        };
        invoke();
        return { value: 0, suspendedForCallback: true, callbackId: firstId ?? 0, stackCleanup };
    }

    private callableCallback(ptr: number): boolean {
        return ptr !== 0 && this.deps.validateRange(ptr, 1, "rx");
    }

    /** Guest scratch blocks for one enumeration, freed when it ends. */
    private scratch(): { alloc(size: number): number; free(): void } {
        const blocks: number[] = [];
        const memory = this.deps.process.memory;
        return {
            alloc: (size) => {
                const p = memory.alloc(size);
                blocks.push(p);
                return p;
            },
            free: () => {
                for (const p of blocks) memory.free(p);
                blocks.length = 0;
            },
        };
    }

    // ─── event pump ──────────────────────────────────────────────────────────

    private watchEvents(inst: DirectPlayInstance): void {
        if (inst.events.size > 0) this.pumped.add(inst);
        else this.pumped.delete(inst);
        if (this.pumped.size > 0 && !this.pumpTimer) {
            this.pumpTimer = setInterval(() => {
                for (const i of this.pumped) i.engine.pump();
            }, EVENT_PUMP_MS);
        } else if (this.pumped.size === 0 && this.pumpTimer) {
            clearInterval(this.pumpTimer);
            this.pumpTimer = null;
        }
    }

    release(inst: DirectPlayInstance): void {
        inst.events.clear();
        this.watchEvents(inst);
        inst.engine.shutdown();
    }

    // ─── connection addresses ────────────────────────────────────────────────

    /** DPAID_TotalSize + DPAID_ServiceProvider, as EnumConnections hands out. */
    static tcpipConnection(): Uint8Array {
        const out = new Uint8Array(60);
        const view = new DataView(out.buffer);
        out.set(DPAID_TOTALSIZE, 0);
        view.setUint32(16, 4, true);
        view.setUint32(20, out.length, true);
        out.set(DPAID_SERVICEPROVIDER, 24);
        view.setUint32(40, 16, true);
        out.set(DPSPGUID_TCPIP, 44);
        return out;
    }

    /** Walk a DirectPlay address; the leading DPAID_TotalSize chunk bounds it. */
    private parseAddress(ptr: number, sizeHint: number): Map<string, Uint8Array> | null {
        const chunks = new Map<string, Uint8Array>();
        if (!ptr || !this.deps.validateRange(ptr, 20, "r")) return null;
        const key = (g: Uint8Array) => [...g].join(",");
        const head = Mem.readBytes(ptr, 16)!;
        let total = sizeHint;
        if (key(head) === key(DPAID_TOTALSIZE) && rd(ptr + 16) === 4) total = rd(ptr + 20);
        if (!total || !this.deps.validateRange(ptr, total, "r")) total = 20 + rd(ptr + 16);
        let at = ptr;
        while (at + 20 <= ptr + total) {
            const guid = Mem.readBytes(at, 16)!;
            const size = rd(at + 16);
            if (at + 20 + size > ptr + total) break;
            chunks.set(key(guid), Mem.readBytes(at + 20, size) ?? new Uint8Array(0));
            at += 20 + size;
        }
        return chunks;
    }

    /** Point enumeration at a DPAID_INet address if the connection carries one. */
    private applyAddress(inst: DirectPlayInstance, chunks: Map<string, Uint8Array>): void {
        const key = (g: Uint8Array) => [...g].join(",");
        const inet = chunks.get(key(DPAID_INET));
        const portChunk = chunks.get(key(DPAID_INETPORT));
        const port = portChunk && portChunk.length >= 4 ? new DataView(portChunk.buffer).getUint32(0, true) : DPLAY_ENUM_PORT;
        if (!inet) {
            inst.engine.setEnumTarget(null, port);
            return;
        }
        const text = new TextDecoder().decode(inet).replace(/\0.*$/s, "").trim();
        const parts = text.split(".").map(Number);
        const valid = parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255);
        const ip = valid ? ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0 : null;
        inst.engine.setEnumTarget(text === "" ? null : ip, port);
    }

    /**
     * DirectPlayEnumerate(A/W): one callback per installed service provider — here the TCP/IP
     * provider, reported with DirectX 6 provider version numbers.
     */
    enumerateProviders(ctx: Ctx, callback: number, context: number, wide: boolean): ReturnType<ThunkImplementation> {
        if (!this.callableCallback(callback)) return DPERR_INVALIDPARAMS;
        const mem = this.scratch();
        const guidAddr = mem.alloc(16);
        Mem.writeBytes(guidAddr, DPSPGUID_TCPIP);
        let name: Uint8Array;
        if (wide) {
            name = new Uint8Array((TCPIP_PROVIDER_NAME.length + 1) * 2);
            const view = new DataView(name.buffer);
            for (let i = 0; i < TCPIP_PROVIDER_NAME.length; i++) view.setUint16(i * 2, TCPIP_PROVIDER_NAME.charCodeAt(i), true);
        } else {
            name = ansiz(TCPIP_PROVIDER_NAME);
        }
        const nameAddr = mem.alloc(name.length);
        Mem.writeBytes(nameAddr, name);
        let done = false;
        const r = this.runChain(ctx, 8, callback, (prev) => {
            if (prev !== null || done) return null;
            done = true;
            return [guidAddr, nameAddr, 6, 0, context];
        }, () => {
            mem.free();
            return DP_OK;
        });
        return r ?? DP_OK;
    }

    /** DirectPlayCreate with a provider GUID initializes the connection up front. */
    connectOnCreate(inst: DirectPlayInstance, guid: Uint8Array | null): void {
        if (guid && guid.some((b) => b !== 0)) inst.connected = true;
    }

    // ─── registration ────────────────────────────────────────────────────────

    register(exports: Record<string, ThunkImplementation>): void {
        const P = "IDirectPlay4A_";
        const withInst = (fn: (inst: DirectPlayInstance, ctx: Ctx, args: number[]) => ReturnType<ThunkImplementation>): ThunkImplementation =>
            (ctx, _mem, args) => {
                const inst = this.deps.instance(args[0]! >>> 0);
                if (!inst) return 0x88770082; // DPERR_INVALIDOBJECT
                return fn(inst, ctx, args);
            };

        exports[`${P}InitializeConnection`] = withInst((inst, _ctx, args) => {
            const chunks = this.parseAddress(args[1]! >>> 0, 0);
            if (!chunks) return DPERR_INVALIDPARAMS;
            if (!chunks.has([...DPAID_SERVICEPROVIDER].join(","))) return DPERR_INVALIDPARAMS;
            if (inst.connected) return DPERR_ALREADYINITIALIZED;
            inst.connected = true;
            this.applyAddress(inst, chunks);
            Logger.log(LogCategory.SYSTEM, "[dplay] InitializeConnection: TCP/IP provider over the virtual NIC");
            return DP_OK;
        });

        exports[`${P}EnumConnections`] = withInst((_inst, ctx, args) => {
            const callback = args[2]! >>> 0;
            const context = args[3]! >>> 0;
            const flags = args[4]! >>> 0;
            if (!this.callableCallback(callback)) return DPERR_INVALIDPARAMS;
            // Only DirectPlay service providers exist here; a lobby-provider-only request is empty.
            if (flags !== 0 && !(flags & DPCONNECTION_DIRECTPLAY)) return DP_OK;
            const mem = this.scratch();
            const connection = DirectPlay4Api.tcpipConnection();
            const connAddr = mem.alloc(connection.length);
            Mem.writeBytes(connAddr, connection);
            const guidAddr = mem.alloc(16);
            Mem.writeBytes(guidAddr, DPSPGUID_TCPIP);
            const nameStr = ansiz(TCPIP_PROVIDER_NAME);
            const nameAddr = mem.alloc(DPNAME_SIZE + nameStr.length);
            Mem.writeBytes(nameAddr + DPNAME_SIZE, nameStr);
            wr(nameAddr, DPNAME_SIZE);
            wr(nameAddr + 4, 0);
            wr(nameAddr + 8, nameAddr + DPNAME_SIZE);
            wr(nameAddr + 12, 0);
            let done = false;
            const r = this.runChain(ctx, CLEANUP.EnumConnections, callback, (prev) => {
                if (prev !== null || done) return null;
                done = true;
                return [guidAddr, connAddr, connection.length, nameAddr, DPCONNECTION_DIRECTPLAY, context];
            }, () => {
                mem.free();
                return DP_OK;
            });
            return r ?? DP_OK;
        });

        const enumSessionsChain = (inst: DirectPlayInstance, ctx: Ctx, callback: number, context: number, guidApp: Uint8Array, password: string, flags: number, timeout: number): ThunkResult | null => {
            const mem = this.scratch();
            const timeoutAddr = mem.alloc(4);
            wr(timeoutAddr, timeout);
            const async = (flags & DPENUMSESSIONS_ASYNC) !== 0;
            let list = inst.engine.sessions(guidApp, flags);
            let index = 0;
            let timedOutSent = false;
            return this.runChain(ctx, CLEANUP.EnumSessions, callback, (prev) => {
                if (prev === 0) return null;
                if (timedOutSent) {
                    // TRUE from the timed-out callback asks a synchronous enumeration to go on.
                    if (async) return null;
                    wr(timeoutAddr, timeout);
                    inst.engine.pollSessions(guidApp, password, flags);
                    list = inst.engine.sessions(guidApp, flags);
                    index = 0;
                    timedOutSent = false;
                }
                const s = list[index++];
                if (!s) {
                    timedOutSent = true;
                    return [0, timeoutAddr, DPESC_TIMEDOUT, context];
                }
                const at = mem.alloc(this.sessionDescSize(s.desc, false));
                this.writeSessionDesc(at, s.desc, at + DPSESSIONDESC2_SIZE, false);
                return [at, timeoutAddr, 0, context];
            }, () => {
                mem.free();
                return DP_OK;
            });
        };

        exports[`${P}EnumSessions`] = withInst((inst, ctx, args) => {
            const lpsd = args[1]! >>> 0;
            const timeoutArg = args[2]! >>> 0;
            const callback = args[3]! >>> 0;
            const context = args[4]! >>> 0;
            const flags = args[5]! >>> 0;
            if (!inst.connected) return DPERR_UNINITIALIZED;
            if (flags & DPENUMSESSIONS_STOPASYNC) {
                inst.engine.stopEnumeration();
                return DP_OK;
            }
            const desc = this.readSessionDesc(lpsd);
            if (!desc || !this.callableCallback(callback)) return DPERR_INVALIDPARAMS;
            const timeout = timeoutArg || DPLAY_DEFAULT_TIMEOUT_MS;

            if (flags & DPENUMSESSIONS_ASYNC) {
                inst.engine.pollSessions(desc.guidApplication, desc.password, flags);
                return enumSessionsChain(inst, ctx, callback, context, desc.guidApplication, desc.password, flags, timeout) ?? DP_OK;
            }

            // Synchronous: broadcast, park the caller for the timeout while replies arrive, then
            // report what came back.
            inst.engine.clearSessionCache();
            inst.engine.pollSessions(desc.guidApplication, desc.password, flags);
            return new Promise<ThunkResult>((resolve) => {
                const started = Date.now();
                const tick = setInterval(() => {
                    inst.engine.pollSessions(desc.guidApplication, desc.password, flags);
                    if (Date.now() - started < timeout) return;
                    clearInterval(tick);
                    resolve({
                        value: DP_OK,
                        startCallbackChain: ({ esp, returnAddr }) =>
                            enumSessionsChain(inst, { esp, returnAddr }, callback, context, desc.guidApplication, desc.password, flags, timeout) !== null,
                    });
                }, 20);
            });
        });

        const open = (inst: DirectPlayInstance, lpsd: number, flags: number): number | Promise<number> => {
            if (!inst.connected) return DPERR_UNINITIALIZED;
            const desc = this.readSessionDesc(lpsd);
            if (!desc) return DPERR_INVALIDPARAMS;
            if (inst.joining) {
                const hr = inst.engine.pollJoin();
                if (hr === null) return DPERR_CONNECTING;
                inst.joining = false;
                return hr;
            }
            if (inst.engine.isOpen) return DPERR_ALREADYINITIALIZED;
            if (flags & DPOPEN_CREATE) return inst.engine.createSession(desc);
            if (!(flags & DPOPEN_JOIN)) return DPERR_INVALIDPARAMS;

            const hr = inst.engine.beginJoin(desc.guidInstance, desc.password);
            if (hr !== DP_OK) return hr;
            if (flags & DPOPEN_RETURNSTATUS) {
                inst.joining = true;
                return DPERR_CONNECTING;
            }
            return new Promise<number>((resolve) => {
                const tick = setInterval(() => {
                    const result = inst.engine.pollJoin();
                    if (result === null) return;
                    clearInterval(tick);
                    resolve(result);
                }, 20);
            });
        };
        exports[`${P}Open`] = withInst((inst, _ctx, args) => open(inst, args[1]! >>> 0, args[2]! >>> 0));
        exports[`${P}SecureOpen`] = withInst((inst, _ctx, args) => open(inst, args[1]! >>> 0, args[2]! >>> 0));

        exports[`${P}Close`] = withInst((inst) => {
            inst.engine.close();
            inst.joining = false;
            inst.events.clear();
            this.watchEvents(inst);
            return DP_OK;
        });

        const createEntity = (inst: DirectPlayInstance, isGroup: boolean, lpid: number, lpName: number, lpData: number, size: number, flags: number, parent: number, hEvent: number): number => {
            if (!lpid || !this.deps.validateRange(lpid, 4, "rw")) return DPERR_INVALIDPARAMS;
            const data = this.readData(lpData, size);
            if (!data) return DPERR_INVALIDPARAMS;
            const name = this.readName(lpName);
            const r = isGroup
                ? inst.engine.createGroup(name, data, flags, parent)
                : inst.engine.createPlayer(name, data, flags);
            if (r.hr !== DP_OK) return r.hr;
            wr(lpid, r.id);
            if (hEvent) {
                inst.events.set(r.id, hEvent);
                this.watchEvents(inst);
            }
            Logger.log(LogCategory.SYSTEM, `[dplay] Create${isGroup ? "Group" : "Player"} "${name.shortName}" -> 0x${r.id.toString(16)}`);
            return DP_OK;
        };
        exports[`${P}CreatePlayer`] = withInst((inst, _ctx, a) =>
            createEntity(inst, false, a[1]! >>> 0, a[2]! >>> 0, a[4]! >>> 0, a[5]! >>> 0, a[6]! >>> 0, 0, a[3]! >>> 0));
        exports[`${P}CreateGroup`] = withInst((inst, _ctx, a) =>
            createEntity(inst, true, a[1]! >>> 0, a[2]! >>> 0, a[3]! >>> 0, a[4]! >>> 0, a[5]! >>> 0, 0, 0));
        exports[`${P}CreateGroupInGroup`] = withInst((inst, _ctx, a) =>
            createEntity(inst, true, a[2]! >>> 0, a[3]! >>> 0, a[4]! >>> 0, a[5]! >>> 0, a[6]! >>> 0, a[1]! >>> 0, 0));
        exports[`${P}DestroyPlayer`] = withInst((inst, _ctx, a) => {
            inst.events.delete(a[1]! >>> 0);
            this.watchEvents(inst);
            return inst.engine.destroyEntity(a[1]! >>> 0, false);
        });
        exports[`${P}DestroyGroup`] = withInst((inst, _ctx, a) => inst.engine.destroyEntity(a[1]! >>> 0, true));
        exports[`${P}AddPlayerToGroup`] = withInst((inst, _ctx, a) => inst.engine.changeMembership(a[1]! >>> 0, a[2]! >>> 0, true));
        exports[`${P}DeletePlayerFromGroup`] = withInst((inst, _ctx, a) => inst.engine.changeMembership(a[1]! >>> 0, a[2]! >>> 0, false));

        // ── enumeration of players and groups ──
        const enumEntities = (inst: DirectPlayInstance, ctx: Ctx, cleanup: number, callback: number, context: number, pick: () => Entity[] | number): ReturnType<ThunkImplementation> => {
            if (!this.callableCallback(callback)) return DPERR_INVALIDPARAMS;
            const list = pick();
            if (typeof list === "number") return list;
            const mem = this.scratch();
            let index = 0;
            const r = this.runChain(ctx, cleanup, callback, (prev) => {
                if (prev === 0 || index >= list.length) return null;
                const e = list[index++]!;
                const name = mem.alloc(DPNAME_SIZE + this.nameSize(e));
                this.writeName(name, e, name + DPNAME_SIZE);
                let cbFlags = e.local ? DPENUMPLAYERS_LOCAL : DPENUMPLAYERS_REMOTE;
                if (e.isGroup) cbFlags |= e.flags;
                else {
                    if (e.flags & DPPLAYER_SERVERPLAYER) cbFlags |= DPENUMPLAYERS_SERVERPLAYER;
                    if (e.flags & DPPLAYER_SPECTATOR) cbFlags |= DPENUMPLAYERS_SPECTATOR;
                }
                return [e.id, e.isGroup ? DPPLAYERTYPE_GROUP : DPPLAYERTYPE_PLAYER, name, cbFlags, context];
            }, () => {
                mem.free();
                return DP_OK;
            });
            return r ?? (mem.free(), DP_OK);
        };
        const filterPlayers = (flags: number) => (e: Entity): boolean => {
            if (flags & DPENUMPLAYERS_LOCAL && !e.local) return false;
            if (flags & DPENUMPLAYERS_REMOTE && e.local) return false;
            if (e.isGroup) return true;
            if (e.id === DPID_SERVERPLAYER && !(flags & DPENUMPLAYERS_SERVERPLAYER)) return false;
            if (flags & DPENUMPLAYERS_SPECTATOR && !(e.flags & DPPLAYER_SPECTATOR)) return false;
            return true;
        };

        exports[`${P}EnumPlayers`] = withInst((inst, ctx, a) => {
            const flags = a[4]! >>> 0;
            return enumEntities(inst, ctx, CLEANUP.EnumPlayers, a[2]! >>> 0, a[3]! >>> 0, () => {
                if (flags & DPENUMPLAYERS_SESSION) return E_NOTIMPL;
                if (!inst.engine.isOpen) return DPERR_NOCONNECTION;
                return inst.engine.listEntities()
                    .filter((e) => (!e.isGroup || (flags & DPENUMPLAYERS_GROUP)) && filterPlayers(flags)(e));
            });
        });
        exports[`${P}EnumGroups`] = withInst((inst, ctx, a) => {
            const flags = a[4]! >>> 0;
            return enumEntities(inst, ctx, CLEANUP.EnumGroups, a[2]! >>> 0, a[3]! >>> 0, () => {
                if (flags & DPENUMPLAYERS_SESSION) return E_NOTIMPL;
                if (!inst.engine.isOpen) return DPERR_NOCONNECTION;
                return inst.engine.listEntities().filter((e) => e.isGroup && e.parent === 0 && filterPlayers(flags)(e));
            });
        });
        exports[`${P}EnumGroupsInGroup`] = withInst((inst, ctx, a) => {
            const group = a[1]! >>> 0;
            const flags = a[5]! >>> 0;
            return enumEntities(inst, ctx, CLEANUP.EnumGroupsInGroup, a[3]! >>> 0, a[4]! >>> 0, () => {
                if (!inst.engine.entity(group)?.isGroup) return DPERR_INVALIDGROUP;
                return inst.engine.listEntities().filter((e) => e.isGroup && e.parent === group && filterPlayers(flags)(e));
            });
        });
        exports[`${P}EnumGroupPlayers`] = withInst((inst, ctx, a) => {
            const group = a[1]! >>> 0;
            const flags = a[5]! >>> 0;
            return enumEntities(inst, ctx, CLEANUP.EnumGroupPlayers, a[3]! >>> 0, a[4]! >>> 0, () => {
                const g = inst.engine.entity(group);
                if (!g?.isGroup) return DPERR_INVALIDGROUP;
                return [...g.members].map((id) => inst.engine.entity(id))
                    .filter((e): e is Entity => !!e && !e.isGroup && filterPlayers(flags)(e));
            });
        });

        // ── names, data, flags ──
        const entityOf = (inst: DirectPlayInstance, id: number, isGroup: boolean): Entity | number => {
            const e = inst.engine.entity(id);
            if (!e || e.isGroup !== isGroup) return isGroup ? DPERR_INVALIDGROUP : DPERR_INVALIDPLAYER;
            return e;
        };
        const getName = (isGroup: boolean): ThunkImplementation => withInst((inst, _ctx, a) => {
            const e = entityOf(inst, a[1]! >>> 0, isGroup);
            if (typeof e === "number") return e;
            return this.fill(a[2]! >>> 0, a[3]! >>> 0, DPNAME_SIZE + this.nameSize(e), (base) => {
                this.writeName(base, e, base + DPNAME_SIZE);
            });
        });
        exports[`${P}GetPlayerName`] = getName(false);
        exports[`${P}GetGroupName`] = getName(true);

        const getData = (isGroup: boolean): ThunkImplementation => withInst((inst, _ctx, a) => {
            const e = entityOf(inst, a[1]! >>> 0, isGroup);
            if (typeof e === "number") return e;
            const data = (a[4]! >>> 0) & DPGET_LOCAL ? e.localData : e.remoteData;
            return this.fill(a[2]! >>> 0, a[3]! >>> 0, data.length, (base) => {
                if (data.length) Mem.writeBytes(base, data);
            });
        });
        exports[`${P}GetPlayerData`] = getData(false);
        exports[`${P}GetGroupData`] = getData(true);

        const setData = (isGroup: boolean): ThunkImplementation => withInst((inst, _ctx, a) => {
            const data = this.readData(a[2]! >>> 0, a[3]! >>> 0);
            if (!data) return DPERR_INVALIDPARAMS;
            return inst.engine.setData(a[1]! >>> 0, isGroup, data, ((a[4]! >>> 0) & DPSET_LOCAL) !== 0);
        });
        exports[`${P}SetPlayerData`] = setData(false);
        exports[`${P}SetGroupData`] = setData(true);

        const setName = (isGroup: boolean): ThunkImplementation => withInst((inst, _ctx, a) =>
            inst.engine.setName(a[1]! >>> 0, isGroup, this.readName(a[2]! >>> 0)));
        exports[`${P}SetPlayerName`] = setName(false);
        exports[`${P}SetGroupName`] = setName(true);

        exports[`${P}GetPlayerFlags`] = withInst((inst, _ctx, a) => {
            const e = entityOf(inst, a[1]! >>> 0, false);
            if (typeof e === "number") return e;
            if (!a[2] || !this.deps.validateRange(a[2]! >>> 0, 4, "rw")) return DPERR_INVALIDPARAMS;
            wr(a[2]! >>> 0, (e.local ? DPPLAYER_LOCAL : 0) | (e.flags & (DPPLAYER_SERVERPLAYER | DPPLAYER_SPECTATOR)));
            return DP_OK;
        });
        exports[`${P}GetGroupFlags`] = withInst((inst, _ctx, a) => {
            const e = entityOf(inst, a[1]! >>> 0, true);
            if (typeof e === "number") return e;
            if (!a[2] || !this.deps.validateRange(a[2]! >>> 0, 4, "rw")) return DPERR_INVALIDPARAMS;
            wr(a[2]! >>> 0, (e.local ? DPPLAYER_LOCAL : 0) | e.flags);
            return DP_OK;
        });
        exports[`${P}GetGroupParent`] = withInst((inst, _ctx, a) => {
            const e = entityOf(inst, a[1]! >>> 0, true);
            if (typeof e === "number") return e;
            if (!a[2] || !this.deps.validateRange(a[2]! >>> 0, 4, "rw")) return DPERR_INVALIDPARAMS;
            wr(a[2]! >>> 0, e.parent);
            return DP_OK;
        });

        exports[`${P}GetPlayerAddress`] = withInst((inst, _ctx, a) => {
            const e = entityOf(inst, a[1]! >>> 0, false);
            if (typeof e === "number") return e;
            const peer = inst.engine.peerAddress(e.slot);
            const ip = ansiz(peer ? ipToString(hostToIp(peer.host)) : "0.0.0.0");
            const required = 24 + 36 + 20 + ip.length;
            return this.fill(a[2]! >>> 0, a[3]! >>> 0, required, (base) => {
                Mem.writeBytes(base, DPAID_TOTALSIZE);
                wr(base + 16, 4);
                wr(base + 20, required);
                Mem.writeBytes(base + 24, DPAID_SERVICEPROVIDER);
                wr(base + 40, 16);
                Mem.writeBytes(base + 44, DPSPGUID_TCPIP);
                Mem.writeBytes(base + 60, DPAID_INET);
                wr(base + 76, ip.length);
                Mem.writeBytes(base + 80, ip);
            });
        });

        // ── session description and caps ──
        exports[`${P}GetSessionDesc`] = withInst((inst, _ctx, a) => {
            const d = inst.engine.sessionDesc;
            if (!d) return DPERR_NOCONNECTION;
            const withPassword = inst.engine.isHost;
            return this.fill(a[1]! >>> 0, a[2]! >>> 0, this.sessionDescSize(d, withPassword), (base) => {
                this.writeSessionDesc(base, d, base + DPSESSIONDESC2_SIZE, withPassword);
            });
        });
        exports[`${P}SetSessionDesc`] = withInst((inst, _ctx, a) => {
            const d = this.readSessionDesc(a[1]! >>> 0);
            if (!d) return DPERR_INVALIDPARAMS;
            return inst.engine.setSessionDesc(d);
        });

        const writeCaps = (lpCaps: number, flags: number): number => {
            if (!lpCaps || !this.deps.validateRange(lpCaps, 4, "r")) return DPERR_INVALIDPARAMS;
            const size = rd(lpCaps);
            if (size < DPCAPS_SIZE || !this.deps.validateRange(lpCaps, DPCAPS_SIZE, "rw")) return DPERR_INVALIDPARAMS;
            const values = [
                flags | DPCAPS_GUARANTEEDOPTIMIZED | DPCAPS_GUARANTEEDSUPPORTED | DPCAPS_ASYNCSUPPORTED,
                DPLAY_MAX_BUFFER, 0, 65536, 0, 50, 65536, DPLAY_HEADER_LENGTH, DPLAY_DEFAULT_TIMEOUT_MS,
            ];
            values.forEach((v, i) => wr(lpCaps + 4 + i * 4, v));
            return DP_OK;
        };
        exports[`${P}GetCaps`] = withInst((inst, _ctx, a) =>
            writeCaps(a[1]! >>> 0, inst.engine.isHost ? DPCAPS_ISHOST : 0));
        exports[`${P}GetPlayerCaps`] = withInst((inst, _ctx, a) => {
            const e = entityOf(inst, a[1]! >>> 0, false);
            if (typeof e === "number") return e;
            const flags = (e.local ? DPPLAYERCAPS_LOCAL : 0) | (e.slot === DPlayEngine.HOST_SLOT ? DPCAPS_ISHOST : 0);
            return writeCaps(a[2]! >>> 0, flags);
        });

        // ── messages ──
        exports[`${P}Send`] = withInst((inst, _ctx, a) => {
            const data = this.readData(a[4]! >>> 0, a[5]! >>> 0);
            if (!data) return DPERR_INVALIDPARAMS;
            return inst.engine.send(a[1]! >>> 0, a[2]! >>> 0, data);
        });

        exports[`${P}SendEx`] = withInst((inst, _ctx, a) => {
            const [, from, to, flags, lpData, size, priority, timeout, context, lpdwMsgID] = a.map((v) => v! >>> 0);
            const data = this.readData(lpData!, size!);
            if (!data) return DPERR_INVALIDPARAMS;
            if (!(flags! & DPSEND_ASYNC)) return inst.engine.send(from!, to!, data);
            const r = inst.engine.sendAsync(from!, to!, data, {
                flags: flags!, priority: priority!, timeout: timeout!, context: context!,
                notify: !(flags! & DPSEND_NOSENDCOMPLETEMSG),
            });
            if (lpdwMsgID && this.deps.validateRange(lpdwMsgID, 4, "rw")) wr(lpdwMsgID, r.msgId);
            return r.hr;
        });

        exports[`${P}Receive`] = withInst((inst, _ctx, a) => {
            const lpidFrom = a[1]! >>> 0;
            const lpidTo = a[2]! >>> 0;
            const flags = a[3]! >>> 0;
            const lpData = a[4]! >>> 0;
            const lpdwSize = a[5]! >>> 0;
            const filtered = !(flags & DPRECEIVE_ALL) && (flags & (DPRECEIVE_TOPLAYER | DPRECEIVE_FROMPLAYER)) !== 0;
            const fromFilter = filtered && (flags & DPRECEIVE_FROMPLAYER) && lpidFrom ? rd(lpidFrom) : null;
            const toFilter = filtered && (flags & DPRECEIVE_TOPLAYER) && lpidTo ? rd(lpidTo) : null;
            const index = inst.engine.findMessage(fromFilter, toFilter);
            if (index < 0) return DPERR_NOMESSAGES;
            const msg = inst.engine.message(index)!;
            const required = msg.data ? msg.data.length : this.systemSize(msg.sys!);
            const hr = this.fill(lpData, lpdwSize, required, (base) => {
                if (msg.data) {
                    if (msg.data.length) Mem.writeBytes(base, msg.data);
                } else {
                    this.writeSystem(base, msg.sys!);
                }
            });
            if (hr !== DP_OK) return hr;
            if (lpidFrom && this.deps.validateRange(lpidFrom, 4, "rw")) wr(lpidFrom, msg.from);
            if (lpidTo && this.deps.validateRange(lpidTo, 4, "rw")) wr(lpidTo, msg.to);
            if (!(flags & DPRECEIVE_PEEK)) inst.engine.takeMessage(index);
            return DP_OK;
        });

        exports[`${P}GetMessageCount`] = withInst((inst, _ctx, a) => {
            const lpdwCount = a[2]! >>> 0;
            if (!lpdwCount || !this.deps.validateRange(lpdwCount, 4, "rw")) return DPERR_INVALIDPARAMS;
            wr(lpdwCount, inst.engine.messageCount(a[1]! >>> 0));
            return DP_OK;
        });

        exports[`${P}GetMessageQueue`] = withInst((inst, _ctx, a) => {
            const [, from, to, flags, lpdwNumMsgs, lpdwNumBytes] = a.map((v) => v! >>> 0);
            let count = 0;
            let bytes = 0;
            if (!flags || (flags! & DPMESSAGEQUEUE_SEND)) {
                const pending = inst.engine.pendingSends;
                count += pending.count;
                bytes += pending.bytes;
            }
            if (flags! & DPMESSAGEQUEUE_RECEIVE) {
                for (let i = 0; ; i++) {
                    const m = inst.engine.message(i);
                    if (!m) break;
                    if (from && m.from !== from) continue;
                    if (to && m.to !== to) continue;
                    count++;
                    bytes += m.data?.length ?? 0;
                }
            }
            if (lpdwNumMsgs && this.deps.validateRange(lpdwNumMsgs, 4, "rw")) wr(lpdwNumMsgs, count);
            if (lpdwNumBytes && this.deps.validateRange(lpdwNumBytes, 4, "rw")) wr(lpdwNumBytes, bytes);
            return DP_OK;
        });

        // Sends complete as soon as they are issued, so nothing is ever left to cancel.
        exports[`${P}CancelMessage`] = withInst((_inst, _ctx, a) => (a[1]! >>> 0) === 0 ? DP_OK : DPERR_UNKNOWNMESSAGE);
        exports[`${P}CancelPriority`] = withInst(() => DP_OK);
    }

    // ─── DPMSG_* system messages ─────────────────────────────────────────────

    private systemSize(sys: SystemMessage): number {
        switch (sys.type) {
            case DPSYS_CREATEPLAYERORGROUP:
                return 48 + sys.entity.data.length + this.nameSize(sys.entity);
            case DPSYS_DESTROYPLAYERORGROUP:
                return 52 + sys.localData.length + sys.entity.data.length + this.nameSize(sys.entity);
            case DPSYS_ADDPLAYERTOGROUP:
            case DPSYS_DELETEPLAYERFROMGROUP:
                return 12;
            case DPSYS_SETPLAYERORGROUPDATA:
                return 20 + sys.data.length;
            case DPSYS_SETPLAYERORGROUPNAME:
                return 28 + this.nameSize(sys);
            case DPSYS_SETSESSIONDESC:
                return 4 + this.sessionDescSize(sys.desc, false);
            case DPSYS_SESSIONLOST:
                return 4;
            case DPSYS_SENDCOMPLETE:
                return 40;
        }
    }

    /** Lay out a DPMSG_* at `base`; embedded pointers point into the same buffer, as DirectPlay's do. */
    private writeSystem(base: number, sys: SystemMessage): void {
        wr(base, sys.type);
        switch (sys.type) {
            case DPSYS_CREATEPLAYERORGROUP: {
                const e = sys.entity;
                const dataAt = base + 48;
                wr(base + 4, e.isGroup ? DPPLAYERTYPE_GROUP : DPPLAYERTYPE_PLAYER);
                wr(base + 8, e.id);
                wr(base + 12, sys.currentPlayers);
                wr(base + 16, e.data.length ? dataAt : 0);
                wr(base + 20, e.data.length);
                if (e.data.length) Mem.writeBytes(dataAt, e.data);
                this.writeName(base + 24, e, dataAt + e.data.length);
                wr(base + 40, e.parent);
                wr(base + 44, e.flags);
                return;
            }
            case DPSYS_DESTROYPLAYERORGROUP: {
                const e = sys.entity;
                const localAt = base + 52;
                const remoteAt = localAt + sys.localData.length;
                wr(base + 4, e.isGroup ? DPPLAYERTYPE_GROUP : DPPLAYERTYPE_PLAYER);
                wr(base + 8, e.id);
                wr(base + 12, sys.localData.length ? localAt : 0);
                wr(base + 16, sys.localData.length);
                wr(base + 20, e.data.length ? remoteAt : 0);
                wr(base + 24, e.data.length);
                if (sys.localData.length) Mem.writeBytes(localAt, sys.localData);
                if (e.data.length) Mem.writeBytes(remoteAt, e.data);
                this.writeName(base + 28, e, remoteAt + e.data.length);
                wr(base + 44, e.parent);
                wr(base + 48, e.flags);
                return;
            }
            case DPSYS_ADDPLAYERTOGROUP:
            case DPSYS_DELETEPLAYERFROMGROUP:
                wr(base + 4, sys.group);
                wr(base + 8, sys.player);
                return;
            case DPSYS_SETPLAYERORGROUPDATA:
                wr(base + 4, sys.isGroup ? DPPLAYERTYPE_GROUP : DPPLAYERTYPE_PLAYER);
                wr(base + 8, sys.id);
                wr(base + 12, sys.data.length ? base + 20 : 0);
                wr(base + 16, sys.data.length);
                if (sys.data.length) Mem.writeBytes(base + 20, sys.data);
                return;
            case DPSYS_SETPLAYERORGROUPNAME:
                wr(base + 4, sys.isGroup ? DPPLAYERTYPE_GROUP : DPPLAYERTYPE_PLAYER);
                wr(base + 8, sys.id);
                this.writeName(base + 12, sys, base + 28);
                return;
            case DPSYS_SETSESSIONDESC:
                this.writeSessionDesc(base + 4, sys.desc, base + 4 + DPSESSIONDESC2_SIZE, false);
                return;
            case DPSYS_SESSIONLOST:
                return;
            case DPSYS_SENDCOMPLETE: {
                const fields = [sys.from, sys.to, sys.flags, sys.priority, sys.timeout, sys.context, sys.msgId, sys.hr, 0];
                fields.forEach((v, i) => wr(base + 4 + i * 4, v));
                return;
            }
        }
    }
}
