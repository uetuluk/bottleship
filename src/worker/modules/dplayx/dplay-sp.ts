/**
 * DirectPlay session engine over the guest NetStack — the TCP/IP service provider plus the parts
 * of dplayx above it (name server, roster, message queue).
 *
 * Topology is DirectPlay's peer-to-peer model: the host is the name server that answers
 * EnumSessions and admits joiners, and every peer then talks to every other peer directly. The
 * host hands each peer a slot and the session's ID key at join time, so a peer mints DPIDs for
 * its own players and groups locally and CreatePlayer never waits on a round trip. Each peer
 * also has a system player (counter 0 of its slot); deleting it is how a peer leaves.
 *
 * Everything is datagrams on one socket in the DirectPlay game-port range, plus the well-known
 * enumeration port while hosting. The link under the stack is reliable and ordered, so the only
 * loss to design for is a full transmit ring: such datagrams wait in a backlog, flushed in order
 * on the next pump. Messages past the MTU are fragmented with DPSP_MSG_PACKET.
 *
 * Data-only (no guest pointers); dplayx.ts marshals structs and callbacks.
 */

import { SOCK_DGRAM, WSAEWOULDBLOCK, errorOf, isError, type NetStack } from "../../core/net/net-stack";
import { VLAN_BROADCAST_HOST, hostToIp, ipToHost } from "../../../net/nic-contract";
import { Logger, LogCategory } from "../../core/logger";
import {
    DPSP_MSG,
    Reassembler,
    decodeEnumSessions,
    decodeEnumSessionsReply,
    decodePacket,
    encodeEnumSessions,
    encodeEnumSessionsReply,
    encodeSystem,
    encodeUserBody,
    fragmentBody,
    isSystemBody,
    parseSpHeader,
    readEntity,
    readJoinReply,
    readSessionDescFull,
    systemCommand,
    systemReader,
    writeEntity,
    writeJoinReply,
    writeSessionDescFull,
    type PeerAddress,
    type SessionDesc,
    type WireEntity,
    type WireWriter,
} from "./dplay-wire";

export type { SessionDesc } from "./dplay-wire";

// ─── dplay.h ─────────────────────────────────────────────────────────────────

const dpErr = (code: number): number => (0x88770000 | code) >>> 0;
export const DP_OK = 0;
export const DPERR_ALREADYINITIALIZED = dpErr(5);
export const DPERR_ACCESSDENIED = dpErr(10);
export const DPERR_BUFFERTOOSMALL = dpErr(30);
export const DPERR_CANTADDPLAYER = dpErr(40);
export const DPERR_CANTCREATESESSION = dpErr(70);
export const DPERR_INVALIDFLAGS = dpErr(120);
export const DPERR_INVALIDOBJECT = dpErr(130);
export const DPERR_INVALIDPLAYER = dpErr(150);
export const DPERR_INVALIDGROUP = dpErr(155);
export const DPERR_NOCONNECTION = dpErr(170);
export const DPERR_NOMESSAGES = dpErr(190);
export const DPERR_NOSESSIONS = dpErr(220);
export const DPERR_TIMEOUT = dpErr(240);
export const DPERR_UNAVAILABLE = dpErr(250);
export const DPERR_SESSIONLOST = dpErr(310);
export const DPERR_UNINITIALIZED = dpErr(320);
export const DPERR_NONEWPLAYERS = dpErr(330);
export const DPERR_INVALIDPASSWORD = dpErr(340);
export const DPERR_UNKNOWNMESSAGE = dpErr(370);
export const DPERR_INVALIDPARAMS = 0x80070057;
export const DPERR_PENDING = 0x8000000a;

export const DPID_SYSMSG = 0;
export const DPID_ALLPLAYERS = 0;
export const DPID_SERVERPLAYER = 1;
export const DPID_UNKNOWN = 0xffffffff;

export const DPSESSION_NEWPLAYERSDISABLED = 0x1;
export const DPSESSION_JOINDISABLED = 0x20;
export const DPSESSION_NODATAMESSAGES = 0x80;
export const DPSESSION_PRIVATE = 0x200;
export const DPSESSION_PASSWORDREQUIRED = 0x400;

export const DPENUMSESSIONS_AVAILABLE = 0x1;
export const DPENUMSESSIONS_ALL = 0x2;
export const DPENUMSESSIONS_ASYNC = 0x10;
export const DPENUMSESSIONS_STOPASYNC = 0x20;
export const DPENUMSESSIONS_PASSWORDREQUIRED = 0x40;

export const DPPLAYER_SERVERPLAYER = 0x100;
export const DPPLAYER_SPECTATOR = 0x200;
export const DPPLAYER_LOCAL = 0x8;

export const DPSYS_CREATEPLAYERORGROUP = 0x0003;
export const DPSYS_DESTROYPLAYERORGROUP = 0x0005;
export const DPSYS_ADDPLAYERTOGROUP = 0x0007;
export const DPSYS_DELETEPLAYERFROMGROUP = 0x0021;
export const DPSYS_SESSIONLOST = 0x0031;
export const DPSYS_SETPLAYERORGROUPDATA = 0x0102;
export const DPSYS_SETPLAYERORGROUPNAME = 0x0103;
export const DPSYS_SETSESSIONDESC = 0x0104;
export const DPSYS_SENDCOMPLETE = 0x010d;

/** Well-known port a host's name server answers EnumSessions on. */
export const DPLAY_ENUM_PORT = 47624;
/** Range DirectPlay's TCP/IP provider binds game traffic in. */
export const DPLAY_GAME_PORT_MIN = 2300;
export const DPLAY_GAME_PORT_MAX = 2400;
/** SP caps dwTimeout: also the default EnumSessions wait when the caller passes 0. */
export const DPLAY_DEFAULT_TIMEOUT_MS = 2000;

const ENUM_REBROADCAST_MS = 1000;
/** A session that stopped answering is dropped from the cache after this long. */
const SESSION_CACHE_TTL_MS = 10_000;
const JOIN_RETRY_MS = 1000;
const JOIN_TIMEOUT_MS = 8000;
const HOST_SLOT = 1;
const RECV_BUFFER = 2048;

// ─── model ───────────────────────────────────────────────────────────────────

export interface Entity {
    id: number;
    isGroup: boolean;
    flags: number;
    slot: number;
    parent: number;
    shortName: string;
    longName: string;
    hasName: boolean;
    remoteData: Uint8Array;
    localData: Uint8Array;
    /** Group members (player ids); empty for players. */
    members: Set<number>;
    local: boolean;
}

interface Peer {
    slot: number;
    host: number;
    port: number;
    /** Seen in the link's peer list, so its later absence means it left the room. */
    seenOnLink: boolean;
}

export interface NameSnapshot {
    shortName: string;
    longName: string;
    hasName: boolean;
}

export type SystemMessage =
    | { type: typeof DPSYS_CREATEPLAYERORGROUP; entity: EntitySnapshot; currentPlayers: number }
    | { type: typeof DPSYS_DESTROYPLAYERORGROUP; entity: EntitySnapshot; localData: Uint8Array }
    | { type: typeof DPSYS_ADDPLAYERTOGROUP | typeof DPSYS_DELETEPLAYERFROMGROUP; group: number; player: number }
    | { type: typeof DPSYS_SETPLAYERORGROUPDATA; id: number; isGroup: boolean; data: Uint8Array }
    | ({ type: typeof DPSYS_SETPLAYERORGROUPNAME; id: number; isGroup: boolean } & NameSnapshot)
    | { type: typeof DPSYS_SETSESSIONDESC; desc: SessionDesc }
    | { type: typeof DPSYS_SESSIONLOST }
    | {
        type: typeof DPSYS_SENDCOMPLETE; from: number; to: number; flags: number; priority: number;
        timeout: number; context: number; msgId: number; hr: number;
    };

export interface EntitySnapshot extends NameSnapshot {
    id: number;
    isGroup: boolean;
    flags: number;
    parent: number;
    data: Uint8Array;
}

export interface QueuedMessage {
    from: number;
    to: number;
    /** User payload, or null for a system message. */
    data: Uint8Array | null;
    sys: SystemMessage | null;
}

export interface FoundSession {
    desc: SessionDesc;
    host: number;
    port: number;
    seenAt: number;
}

/** What the engine needs from the NIC beyond the stack. */
export interface DPlayLink {
    readonly linkUp: boolean;
    readonly localHost: number;
    readonly mtu: number;
    peers(): number[];
}

export interface EngineOptions {
    now?: () => number;
    random?: (bytes: Uint8Array) => void;
    /** Called whenever a message is queued for a local player (DPID_ALLPLAYERS when none exists). */
    onQueued?: (to: number) => void;
}

const guidKey = (g: Uint8Array): string => {
    let s = "";
    for (const b of g) s += b.toString(16).padStart(2, "0");
    return s;
};
const isNullGuid = (g: Uint8Array): boolean => g.every((b) => b === 0);
const sameGuid = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
/** Registry-form GUID text: the first three fields are little-endian on the wire. */
export function formatGuid(g: Uint8Array): string {
    const h = (i: number) => (g[i] ?? 0).toString(16).padStart(2, "0");
    return `{${h(3)}${h(2)}${h(1)}${h(0)}-${h(5)}${h(4)}-${h(7)}${h(6)}-${h(8)}${h(9)}-${[10, 11, 12, 13, 14, 15].map(h).join("")}}`;
}

function snapshot(e: Entity): EntitySnapshot {
    return {
        id: e.id, isGroup: e.isGroup, flags: e.flags, parent: e.parent,
        shortName: e.shortName, longName: e.longName, hasName: e.hasName, data: e.remoteData,
    };
}

function toWire(e: Entity): WireEntity {
    return {
        id: e.id, isGroup: e.isGroup, flags: e.flags, slot: e.slot, parent: e.parent,
        shortName: e.shortName, longName: e.longName, hasName: e.hasName, data: e.remoteData,
        members: [...e.members],
    };
}

function fromWire(w: WireEntity): Entity {
    return {
        id: w.id, isGroup: w.isGroup, flags: w.flags, slot: w.slot, parent: w.parent,
        shortName: w.shortName, longName: w.longName, hasName: w.hasName, remoteData: w.data,
        localData: new Uint8Array(0), members: new Set(w.members), local: false,
    };
}

type JoinState =
    | { phase: "waiting"; host: number; port: number; password: string; started: number; lastSent: number }
    | { phase: "done"; hr: number };

// ─── engine ─────────────────────────────────────────────────────────────────

export class DPlayEngine {
    private readonly now: () => number;
    private readonly random: (bytes: Uint8Array) => void;
    private readonly onQueued: ((to: number) => void) | null;

    private sock = 0;
    private enumSock = 0;
    private backlog: Array<{ host: number; port: number; data: Uint8Array }> = [];
    private readonly rx = new Uint8Array(RECV_BUFFER);
    private readonly reassembler = new Reassembler();

    /** EnumSessions cache, keyed by guidInstance. */
    private found = new Map<string, FoundSession>();
    private enumRequest: { guidApplication: Uint8Array; password: string; flags: number } | null = null;
    private lastEnumBroadcast = -Infinity;
    /** Unicast enumeration target (DPAID_INet), or broadcast. */
    private enumTarget = VLAN_BROADCAST_HOST;
    private enumTargetPort = DPLAY_ENUM_PORT;

    private desc: SessionDesc | null = null;
    private hosting = false;
    private lost = false;
    private slot = 0;
    private idKey = 0;
    private nextCounter = 1;
    private nextSlot = HOST_SLOT + 1;
    private peers = new Map<number, Peer>();
    private entities = new Map<number, Entity>();
    private queue: QueuedMessage[] = [];
    private join: JoinState | null = null;
    private nextMsgId = 1;

    constructor(private readonly stack: NetStack, private readonly link: DPlayLink, opts: EngineOptions = {}) {
        this.now = opts.now ?? (() => Date.now());
        this.random = opts.random ?? ((b) => { crypto.getRandomValues(b as Uint8Array<ArrayBuffer>); });
        this.onQueued = opts.onQueued ?? null;
    }

    private enqueue(m: QueuedMessage): void {
        this.queue.push(m);
        this.onQueued?.(m.to);
    }

    // ─── state queries ───────────────────────────────────────────────────────

    get isOpen(): boolean {
        return this.desc !== null;
    }

    get isHost(): boolean {
        return this.hosting;
    }

    get sessionLost(): boolean {
        return this.lost;
    }

    get sessionDesc(): SessionDesc | null {
        return this.desc;
    }

    get pendingSends(): { count: number; bytes: number } {
        let bytes = 0;
        for (const b of this.backlog) bytes += b.data.length;
        return { count: this.backlog.length, bytes };
    }

    entity(id: number): Entity | undefined {
        return this.entities.get(id >>> 0);
    }

    /** Players and groups visible to the application (system players excluded). */
    listEntities(): Entity[] {
        return [...this.entities.values()];
    }

    /** Harness view. */
    describe(): Record<string, unknown> {
        return {
            open: this.isOpen,
            host: this.hosting,
            lost: this.lost,
            slot: this.slot,
            port: this.sock ? this.stack.localPort(this.sock) : 0,
            session: this.desc ? { name: this.desc.name, app: formatGuid(this.desc.guidApplication), flags: this.desc.flags, maxPlayers: this.desc.maxPlayers, currentPlayers: this.desc.currentPlayers } : null,
            enumApp: this.enumRequest ? formatGuid(this.enumRequest.guidApplication) : null,
            peers: [...this.peers.values()].map((p) => ({ slot: p.slot, host: p.host, port: p.port })),
            players: [...this.entities.values()].map((e) => ({
                id: `0x${e.id.toString(16)}`, group: e.isGroup, local: e.local, name: e.shortName, slot: e.slot,
            })),
            queued: this.queue.length,
            backlog: this.backlog.length,
            found: [...this.found.values()].map((f) => ({ name: f.desc.name, host: f.host, port: f.port, players: f.desc.currentPlayers, app: formatGuid(f.desc.guidApplication) })),
        };
    }

    // ─── transport ───────────────────────────────────────────────────────────

    private ensureSocket(): boolean {
        if (this.sock && this.stack.has(this.sock)) return true;
        const s = this.stack.open(SOCK_DGRAM);
        if (isError(s)) return false;
        let bound = false;
        for (let port = DPLAY_GAME_PORT_MIN; port <= DPLAY_GAME_PORT_MAX && !bound; port++) {
            bound = !isError(this.stack.bind(s, port));
        }
        if (!bound && isError(this.stack.bind(s, 0))) {
            this.stack.close(s);
            return false;
        }
        this.stack.setBroadcast(s, true);
        this.sock = s;
        return true;
    }

    private replyAddress(): PeerAddress {
        return { host: this.link.localHost, port: this.sock ? this.stack.localPort(this.sock) : 0 };
    }

    private get replyIp(): number {
        return hostToIp(this.link.localHost);
    }

    private transmit(host: number, port: number, datagrams: Uint8Array[]): void {
        for (const data of datagrams) {
            if (this.backlog.length > 0) {
                this.backlog.push({ host, port, data });
                continue;
            }
            const r = this.stack.sendTo(this.sock, host, port, data);
            if (isError(r)) {
                if (errorOf(r) === WSAEWOULDBLOCK) this.backlog.push({ host, port, data });
                else Logger.verbose(LogCategory.SYSTEM, `[dplay] sendTo ${host}:${port} failed (WSA ${errorOf(r)})`);
            }
        }
    }

    private flushBacklog(): void {
        while (this.backlog.length > 0) {
            const next = this.backlog[0]!;
            const r = this.stack.sendTo(this.sock, next.host, next.port, next.data);
            if (isError(r) && errorOf(r) === WSAEWOULDBLOCK) return;
            this.backlog.shift();
        }
    }

    /** Send a body (system or user, without SP header) to one peer address, fragmenting as needed. */
    private sendBody(host: number, port: number, body: Uint8Array): void {
        const guid = new Uint8Array(16);
        this.random(guid);
        this.transmit(host, port, fragmentBody(this.replyAddress(), this.replyIp, body, this.link.mtu || 1400, guid));
    }

    private sendSystem(host: number, port: number, command: number, fill: (w: WireWriter) => void): void {
        const datagram = encodeSystem(this.replyAddress(), this.replyIp, command, fill);
        this.sendBody(host, port, datagram.subarray(20));
    }

    private broadcastToPeers(command: number, fill: (w: WireWriter) => void, exceptSlot = 0): void {
        for (const peer of this.peers.values()) {
            if (peer.slot === exceptSlot) continue;
            this.sendSystem(peer.host, peer.port, command, fill);
        }
    }

    /** Drain the NIC and handle everything addressed to this session. */
    pump(): void {
        this.stack.pump();
        if (this.sock) {
            this.flushBacklog();
            this.drain(this.sock);
        }
        if (this.enumSock) this.drain(this.enumSock);
        this.checkPeersOnLink();
    }

    private drain(sock: number): void {
        for (;;) {
            const r = this.stack.recvFrom(sock, this.rx);
            if (typeof r === "number") return;
            if (r.truncated) continue;
            const sp = parseSpHeader(this.rx.subarray(0, r.length));
            if (!sp) continue;
            try {
                this.handleBody(r.host, sp.replyPort || r.port, sp.body.slice());
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `[dplay] dropped malformed message from ${r.host}: ${String(e)}`);
            }
        }
    }

    /** A peer that dropped out of the room without saying goodbye has left. */
    private checkPeersOnLink(): void {
        if (!this.desc || this.peers.size === 0 || !this.link.linkUp) return;
        const present = new Set(this.link.peers());
        for (const peer of [...this.peers.values()]) {
            if (present.has(peer.host)) peer.seenOnLink = true;
            else if (peer.seenOnLink) this.removePeer(peer.slot);
        }
    }

    // ─── inbound ─────────────────────────────────────────────────────────────

    private handleBody(src: number, replyPort: number, body: Uint8Array): void {
        if (!isSystemBody(body)) {
            this.handleUser(src, body);
            return;
        }
        const r = systemReader(body);
        switch (systemCommand(body)) {
            case DPSP_MSG.PACKET: {
                const whole = this.reassembler.add(src, decodePacket(body), this.now());
                if (whole) this.handleBody(src, replyPort, whole);
                return;
            }
            case DPSP_MSG.ENUMSESSIONS:
                this.answerEnum(src, replyPort, body);
                return;
            case DPSP_MSG.ENUMSESSIONSREPLY: {
                const desc = decodeEnumSessionsReply(body);
                this.found.set(guidKey(desc.guidInstance), { desc, host: src, port: replyPort, seenAt: this.now() });
                return;
            }
            case DPSP_MSG.REQUESTPLAYERID:
                this.admit(src, replyPort, r.u32(), r.wstr());
                return;
            case DPSP_MSG.REQUESTPLAYERREPLY:
                if (this.join?.phase === "waiting" && src === this.join.host) {
                    r.u32();
                    this.join = { phase: "done", hr: r.u32() };
                }
                return;
            case DPSP_MSG.SUPERENUMPLAYERSREPLY:
                if (this.join?.phase === "waiting" && src === this.join.host) this.completeJoin(src, readJoinReply(r));
                return;
        }

        // Roster traffic is only meaningful inside a session, from one of its peers.
        const from = this.peerByHost(src);
        if (!this.desc || !from) return;
        switch (systemCommand(body)) {
            case DPSP_MSG.ADDFORWARDREQUEST: {
                if (from.slot !== HOST_SLOT) return;
                const slot = r.u32();
                const host = r.u32();
                const port = r.u32();
                if (slot !== this.slot) this.peers.set(slot, { slot, host, port, seenOnLink: false });
                return;
            }
            case DPSP_MSG.CREATEPLAYER:
            case DPSP_MSG.CREATEGROUP: {
                const e = fromWire(readEntity(r));
                if (this.entities.has(e.id)) return;
                this.entities.set(e.id, e);
                if (e.parent) this.entities.get(e.parent)?.members.add(e.id);
                this.recountPlayers();
                this.postSystem({ type: DPSYS_CREATEPLAYERORGROUP, entity: snapshot(e), currentPlayers: this.desc.currentPlayers });
                return;
            }
            case DPSP_MSG.DELETEPLAYER:
            case DPSP_MSG.DELETEGROUP: {
                const id = r.u32();
                if (id === this.systemPlayerId(from.slot)) this.removePeer(from.slot);
                else this.removeEntity(id);
                return;
            }
            case DPSP_MSG.ADDPLAYERTOGROUP:
            case DPSP_MSG.DELETEPLAYERFROMGROUP: {
                const group = r.u32();
                const player = r.u32();
                const add = systemCommand(body) === DPSP_MSG.ADDPLAYERTOGROUP;
                this.applyMembership(group, player, add);
                return;
            }
            case DPSP_MSG.PLAYERDATACHANGED:
            case DPSP_MSG.GROUPDATACHANGED: {
                const e = this.entities.get(r.u32());
                if (!e) return;
                e.remoteData = r.blob();
                if (!(this.desc.flags & DPSESSION_NODATAMESSAGES)) {
                    this.postSystem({ type: DPSYS_SETPLAYERORGROUPDATA, id: e.id, isGroup: e.isGroup, data: e.remoteData });
                }
                return;
            }
            case DPSP_MSG.PLAYERNAMECHANGED:
            case DPSP_MSG.GROUPNAMECHANGED: {
                const e = this.entities.get(r.u32());
                if (!e) return;
                e.hasName = r.u32() !== 0;
                e.shortName = r.wstr();
                e.longName = r.wstr();
                if (!(this.desc.flags & DPSESSION_NODATAMESSAGES)) {
                    this.postSystem({
                        type: DPSYS_SETPLAYERORGROUPNAME, id: e.id, isGroup: e.isGroup,
                        shortName: e.shortName, longName: e.longName, hasName: e.hasName,
                    });
                }
                return;
            }
            case DPSP_MSG.SESSIONDESCCHANGED: {
                if (from.slot !== HOST_SLOT) return;
                const desc = readSessionDescFull(r);
                this.desc = { ...desc, currentPlayers: this.desc.currentPlayers };
                this.postSystem({ type: DPSYS_SETSESSIONDESC, desc: this.desc });
                return;
            }
        }
    }

    private handleUser(src: number, body: Uint8Array): void {
        if (!this.desc || body.length < 8 || !this.peerByHost(src)) return;
        const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const from = view.getUint32(0, true);
        const to = view.getUint32(4, true);
        const target = this.entities.get(to);
        if (!target?.local || target.isGroup) return;
        this.enqueue({ from, to, data: body.slice(8), sys: null });
    }

    private peerByHost(host: number): Peer | undefined {
        for (const p of this.peers.values()) if (p.host === host) return p;
        return undefined;
    }

    // ─── enumeration ─────────────────────────────────────────────────────────

    /** DPAID_INet: enumerate one address instead of broadcasting. `null` restores broadcast. */
    setEnumTarget(ip: number | null, port = DPLAY_ENUM_PORT): void {
        const host = ip === null ? null : (ip >>> 0) === 0xffffffff ? VLAN_BROADCAST_HOST : ipToHost(ip);
        this.enumTarget = host ?? VLAN_BROADCAST_HOST;
        this.enumTargetPort = port & 0xffff || DPLAY_ENUM_PORT;
    }

    /**
     * Refresh the session cache: drain replies, then send a fresh request if the last one is
     * older than the rebroadcast interval (or the request changed). Never blocks.
     */
    pollSessions(guidApplication: Uint8Array, password: string, flags: number): void {
        this.pump();
        if (!this.ensureSocket()) return;
        const now = this.now();
        const changed = !this.enumRequest ||
            !sameGuid(this.enumRequest.guidApplication, guidApplication) ||
            this.enumRequest.password !== password || this.enumRequest.flags !== flags;
        if (!changed && now - this.lastEnumBroadcast < ENUM_REBROADCAST_MS) return;
        this.enumRequest = { guidApplication: guidApplication.slice(), password, flags };
        this.lastEnumBroadcast = now;
        this.transmit(this.enumTarget, this.enumTargetPort, [
            encodeEnumSessions(this.replyAddress(), this.replyIp, { guidApplication, flags, password }),
        ]);
    }

    stopEnumeration(): void {
        this.enumRequest = null;
    }

    /** Drop everything cached (a synchronous EnumSessions starts from a clean slate). */
    clearSessionCache(): void {
        this.found.clear();
    }

    /** Cached sessions still answering, in discovery order, filtered the way the host filters. */
    sessions(guidApplication: Uint8Array, flags: number): FoundSession[] {
        const now = this.now();
        const out: FoundSession[] = [];
        for (const [key, s] of this.found) {
            if (now - s.seenAt > SESSION_CACHE_TTL_MS) {
                this.found.delete(key);
                continue;
            }
            if (!isNullGuid(guidApplication) && !sameGuid(s.desc.guidApplication, guidApplication)) continue;
            if (!(flags & DPENUMSESSIONS_ALL) && !this.joinable(s.desc, flags)) continue;
            out.push(s);
        }
        return out;
    }

    private joinable(d: SessionDesc, enumFlags: number): boolean {
        if (d.flags & (DPSESSION_NEWPLAYERSDISABLED | DPSESSION_JOINDISABLED)) return false;
        if (d.maxPlayers !== 0 && d.currentPlayers >= d.maxPlayers) return false;
        if ((d.flags & DPSESSION_PASSWORDREQUIRED) && !(enumFlags & DPENUMSESSIONS_PASSWORDREQUIRED)) return false;
        return true;
    }

    /** Name server: answer an EnumSessions request for our session. */
    private answerEnum(src: number, replyPort: number, body: Uint8Array): void {
        const d = this.desc;
        if (!d || !this.hosting || this.lost) return;
        const req = decodeEnumSessions(body);
        if (!isNullGuid(req.guidApplication) && !sameGuid(req.guidApplication, d.guidApplication)) return;
        if ((d.flags & DPSESSION_PRIVATE) && req.password !== d.password) return;
        if (!(req.flags & DPENUMSESSIONS_ALL) && !this.joinable(d, req.flags)) return;
        const advertised: SessionDesc = {
            ...d,
            password: "",
            flags: d.password ? d.flags | DPSESSION_PASSWORDREQUIRED : d.flags & ~DPSESSION_PASSWORDREQUIRED,
        };
        this.ensureSocket();
        this.transmit(src, replyPort, [encodeEnumSessionsReply(this.replyAddress(), this.replyIp, advertised)]);
    }

    // ─── session lifetime ────────────────────────────────────────────────────

    /** Open(DPOPEN_CREATE). */
    createSession(template: SessionDesc): number {
        if (this.desc) return DPERR_ALREADYINITIALIZED;
        if (!this.ensureSocket()) return DPERR_CANTCREATESESSION;
        const guidInstance = new Uint8Array(16);
        this.random(guidInstance);
        const key = new Uint32Array(1);
        this.random(new Uint8Array(key.buffer));
        this.desc = { ...template, guidInstance, currentPlayers: 0 };
        this.hosting = true;
        this.lost = false;
        this.slot = HOST_SLOT;
        this.idKey = key[0]!;
        this.nextCounter = 1;
        this.nextSlot = HOST_SLOT + 1;

        const listener = this.stack.open(SOCK_DGRAM);
        if (!isError(listener)) {
            if (isError(this.stack.bind(listener, DPLAY_ENUM_PORT))) this.stack.close(listener);
            else this.enumSock = listener;
        }
        Logger.log(LogCategory.SYSTEM, `[dplay] hosting "${this.desc.name}" on port ${this.stack.localPort(this.sock)}`);
        return DP_OK;
    }

    /** Open(DPOPEN_JOIN), first half: send the request. Completion is polled with pollJoin(). */
    beginJoin(guidInstance: Uint8Array, password: string): number {
        if (this.desc) return DPERR_ALREADYINITIALIZED;
        this.pump();
        const target = this.found.get(guidKey(guidInstance));
        if (!target) return DPERR_NOSESSIONS;
        if (!this.ensureSocket()) return DPERR_NOCONNECTION;
        const now = this.now();
        this.join = { phase: "waiting", host: target.host, port: target.port, password, started: now, lastSent: now };
        this.sendJoinRequest();
        return DP_OK;
    }

    private sendJoinRequest(): void {
        if (this.join?.phase !== "waiting") return;
        const { password } = this.join;
        this.sendSystem(this.join.host, this.join.port, DPSP_MSG.REQUESTPLAYERID, (w) => w.u32(1).wstr(password));
    }

    /** Result of an outstanding join, or null while the host has not answered yet. */
    pollJoin(): number | null {
        this.pump();
        const join = this.join;
        if (!join) return DPERR_NOSESSIONS;
        if (join.phase === "done") {
            this.join = null;
            return join.hr;
        }
        const now = this.now();
        if (now - join.started >= JOIN_TIMEOUT_MS) {
            this.join = null;
            return DPERR_TIMEOUT;
        }
        if (now - join.lastSent >= JOIN_RETRY_MS) {
            join.lastSent = now;
            this.sendJoinRequest();
        }
        return null;
    }

    /** Host side of a join: validate, allocate a slot, hand over the roster. */
    private admit(src: number, replyPort: number, _flags: number, password: string): void {
        const d = this.desc;
        if (!d || !this.hosting || this.lost) return;
        const refuse = (hr: number): void => {
            this.sendSystem(src, replyPort, DPSP_MSG.REQUESTPLAYERREPLY, (w) => w.u32(0).u32(hr));
        };
        let peer = [...this.peers.values()].find((p) => p.host === src && p.port === replyPort);
        if (!peer) {
            if (d.flags & (DPSESSION_NEWPLAYERSDISABLED | DPSESSION_JOINDISABLED)) return refuse(DPERR_NONEWPLAYERS);
            if (d.maxPlayers !== 0 && d.currentPlayers >= d.maxPlayers) return refuse(DPERR_NONEWPLAYERS);
            if (d.password && password !== d.password) return refuse(DPERR_INVALIDPASSWORD);
            peer = { slot: this.nextSlot++, host: src, port: replyPort, seenOnLink: false };
            const joined = peer;
            this.broadcastToPeers(DPSP_MSG.ADDFORWARDREQUEST, (w) => w.u32(joined.slot).u32(joined.host).u32(joined.port));
            this.peers.set(peer.slot, peer);
            Logger.log(LogCategory.SYSTEM, `[dplay] peer slot ${peer.slot} joined from host ${src}:${replyPort}`);
        }
        const self = { slot: this.slot, host: this.link.localHost, port: this.stack.localPort(this.sock) };
        const reply = {
            slot: peer.slot,
            idKey: this.idKey,
            desc: d,
            peers: [self, ...[...this.peers.values()].map((p) => ({ slot: p.slot, host: p.host, port: p.port }))],
            entities: [...this.entities.values()].map(toWire),
        };
        this.sendSystem(src, replyPort, DPSP_MSG.SUPERENUMPLAYERSREPLY, (w) => writeJoinReply(w, reply));
    }

    private completeJoin(src: number, reply: ReturnType<typeof readJoinReply>): void {
        this.desc = reply.desc;
        this.hosting = false;
        this.lost = false;
        this.slot = reply.slot;
        this.idKey = reply.idKey;
        this.nextCounter = 1;
        this.peers.clear();
        for (const p of reply.peers) {
            if (p.slot === this.slot) continue;
            // The host is whoever answered, whatever address it believes it has.
            const host = p.slot === HOST_SLOT ? src : p.host;
            this.peers.set(p.slot, { slot: p.slot, host, port: p.port, seenOnLink: false });
        }
        this.entities.clear();
        for (const e of reply.entities) this.entities.set(e.id, fromWire(e));
        this.recountPlayers();
        this.join = { phase: "done", hr: DP_OK };
        Logger.log(LogCategory.SYSTEM, `[dplay] joined "${reply.desc.name}" as slot ${reply.slot}`);
    }

    /** Close(): announce departure, then forget the session. */
    close(): void {
        if (this.desc && !this.lost) {
            for (const e of [...this.entities.values()]) {
                if (e.local && !e.isGroup) this.broadcastToPeers(DPSP_MSG.DELETEPLAYER, (w) => w.u32(e.id));
            }
            const sysId = this.systemPlayerId(this.slot);
            this.broadcastToPeers(DPSP_MSG.DELETEPLAYER, (w) => w.u32(sysId));
            this.flushBacklog();
        }
        this.resetSession();
    }

    /** Release: close the session and the sockets. */
    shutdown(): void {
        this.close();
        if (this.sock) this.stack.close(this.sock);
        this.sock = 0;
        this.backlog.length = 0;
        this.found.clear();
        this.enumRequest = null;
    }

    private resetSession(): void {
        if (this.enumSock) this.stack.close(this.enumSock);
        this.enumSock = 0;
        this.desc = null;
        this.hosting = false;
        this.lost = false;
        this.slot = 0;
        this.peers.clear();
        this.entities.clear();
        this.queue.length = 0;
        this.join = null;
    }

    private removePeer(slot: number): void {
        const peer = this.peers.get(slot);
        if (!peer) return;
        for (const e of [...this.entities.values()]) {
            if (e.slot === slot && !e.isGroup) this.removeEntity(e.id);
        }
        for (const e of [...this.entities.values()]) {
            if (e.slot === slot) this.removeEntity(e.id);
        }
        this.peers.delete(slot);
        this.reassembler.dropSender(peer.host);
        if (slot === HOST_SLOT && !this.hosting && this.desc) {
            this.lost = true;
            this.postSystem({ type: DPSYS_SESSIONLOST });
            Logger.log(LogCategory.SYSTEM, "[dplay] host left; session lost");
        }
    }

    // ─── roster ──────────────────────────────────────────────────────────────

    private systemPlayerId(slot: number): number {
        return this.makeId(slot, 0);
    }

    private makeId(slot: number, counter: number): number {
        return ((((slot & 0xfff) << 20) | (counter & 0xfffff)) ^ this.idKey) >>> 0;
    }

    private allocateId(): number {
        for (;;) {
            const id = this.makeId(this.slot, this.nextCounter++);
            if (id !== DPID_ALLPLAYERS && id !== DPID_SERVERPLAYER && id !== DPID_UNKNOWN && !this.entities.has(id)) {
                return id;
            }
        }
    }

    private recountPlayers(): void {
        if (!this.desc) return;
        let n = 0;
        for (const e of this.entities.values()) if (!e.isGroup) n++;
        this.desc.currentPlayers = n;
    }

    private checkUsable(): number {
        if (!this.desc) return DPERR_UNINITIALIZED;
        if (this.lost) return DPERR_SESSIONLOST;
        return DP_OK;
    }

    createPlayer(name: NameSnapshot, data: Uint8Array, flags: number): { hr: number; id: number } {
        const usable = this.checkUsable();
        if (usable !== DP_OK) return { hr: usable, id: 0 };
        const d = this.desc!;
        if (d.maxPlayers !== 0 && d.currentPlayers >= d.maxPlayers) return { hr: DPERR_CANTADDPLAYER, id: 0 };
        let id: number;
        if (flags & DPPLAYER_SERVERPLAYER) {
            if (!this.hosting || this.entities.has(DPID_SERVERPLAYER)) return { hr: DPERR_CANTADDPLAYER, id: 0 };
            id = DPID_SERVERPLAYER;
        } else {
            id = this.allocateId();
        }
        const e: Entity = {
            id, isGroup: false, flags: flags & (DPPLAYER_SERVERPLAYER | DPPLAYER_SPECTATOR), slot: this.slot,
            parent: 0, ...name, remoteData: data.slice(), localData: new Uint8Array(0), members: new Set(), local: true,
        };
        this.addLocalEntity(e, DPSP_MSG.CREATEPLAYER);
        return { hr: DP_OK, id };
    }

    createGroup(name: NameSnapshot, data: Uint8Array, flags: number, parent = 0): { hr: number; id: number } {
        const usable = this.checkUsable();
        if (usable !== DP_OK) return { hr: usable, id: 0 };
        if (parent && !this.entities.get(parent)?.isGroup) return { hr: DPERR_INVALIDGROUP, id: 0 };
        const e: Entity = {
            id: this.allocateId(), isGroup: true, flags, slot: this.slot, parent, ...name,
            remoteData: data.slice(), localData: new Uint8Array(0), members: new Set(), local: true,
        };
        this.addLocalEntity(e, DPSP_MSG.CREATEGROUP);
        return { hr: DP_OK, id: e.id };
    }

    private addLocalEntity(e: Entity, command: number): void {
        this.entities.set(e.id, e);
        if (e.parent) this.entities.get(e.parent)?.members.add(e.id);
        this.recountPlayers();
        const wire = toWire(e);
        this.broadcastToPeers(command, (w) => writeEntity(w, wire));
        this.postSystem(
            { type: DPSYS_CREATEPLAYERORGROUP, entity: snapshot(e), currentPlayers: this.desc!.currentPlayers },
            e.id,
        );
    }

    destroyEntity(id: number, isGroup: boolean): number {
        const usable = this.checkUsable();
        if (usable !== DP_OK) return usable;
        const e = this.entities.get(id >>> 0);
        if (!e || e.isGroup !== isGroup) return isGroup ? DPERR_INVALIDGROUP : DPERR_INVALIDPLAYER;
        if (!e.local) return DPERR_ACCESSDENIED;
        this.broadcastToPeers(isGroup ? DPSP_MSG.DELETEGROUP : DPSP_MSG.DELETEPLAYER, (w) => w.u32(e.id));
        this.removeEntity(e.id, e.id);
        return DP_OK;
    }

    /** Remove an entity and tell local players, membership first as DirectPlay does. */
    private removeEntity(id: number, except = 0): void {
        const e = this.entities.get(id);
        if (!e) return;
        for (const g of this.entities.values()) {
            if (g.isGroup && g.members.delete(id)) {
                this.postSystem({ type: DPSYS_DELETEPLAYERFROMGROUP, group: g.id, player: id }, except);
            }
        }
        this.entities.delete(id);
        this.recountPlayers();
        this.postSystem({ type: DPSYS_DESTROYPLAYERORGROUP, entity: snapshot(e), localData: e.localData }, except);
    }

    changeMembership(group: number, player: number, add: boolean): number {
        const usable = this.checkUsable();
        if (usable !== DP_OK) return usable;
        const g = this.entities.get(group >>> 0);
        if (!g?.isGroup) return DPERR_INVALIDGROUP;
        const p = this.entities.get(player >>> 0);
        if (!p || p.isGroup) return DPERR_INVALIDPLAYER;
        if (g.members.has(p.id) === add) return DP_OK;
        this.broadcastToPeers(add ? DPSP_MSG.ADDPLAYERTOGROUP : DPSP_MSG.DELETEPLAYERFROMGROUP, (w) => w.u32(g.id).u32(p.id));
        this.applyMembership(g.id, p.id, add);
        return DP_OK;
    }

    private applyMembership(group: number, player: number, add: boolean): void {
        const g = this.entities.get(group);
        if (!g?.isGroup || !this.entities.has(player)) return;
        if (add ? g.members.has(player) : !g.members.has(player)) return;
        if (add) g.members.add(player);
        else g.members.delete(player);
        this.postSystem({ type: add ? DPSYS_ADDPLAYERTOGROUP : DPSYS_DELETEPLAYERFROMGROUP, group, player });
    }

    setData(id: number, isGroup: boolean, data: Uint8Array, local: boolean): number {
        const usable = this.checkUsable();
        if (usable !== DP_OK) return usable;
        const e = this.entities.get(id >>> 0);
        if (!e || e.isGroup !== isGroup) return isGroup ? DPERR_INVALIDGROUP : DPERR_INVALIDPLAYER;
        if (local) {
            e.localData = data.slice();
            return DP_OK;
        }
        if (!e.local) return DPERR_ACCESSDENIED;
        e.remoteData = data.slice();
        const payload = e.remoteData;
        this.broadcastToPeers(isGroup ? DPSP_MSG.GROUPDATACHANGED : DPSP_MSG.PLAYERDATACHANGED, (w) => w.u32(e.id).blob(payload));
        return DP_OK;
    }

    setName(id: number, isGroup: boolean, name: NameSnapshot): number {
        const usable = this.checkUsable();
        if (usable !== DP_OK) return usable;
        const e = this.entities.get(id >>> 0);
        if (!e || e.isGroup !== isGroup) return isGroup ? DPERR_INVALIDGROUP : DPERR_INVALIDPLAYER;
        if (!e.local) return DPERR_ACCESSDENIED;
        Object.assign(e, name);
        this.broadcastToPeers(isGroup ? DPSP_MSG.GROUPNAMECHANGED : DPSP_MSG.PLAYERNAMECHANGED, (w) =>
            w.u32(e.id).u32(name.hasName ? 1 : 0).wstr(name.shortName).wstr(name.longName));
        return DP_OK;
    }

    setSessionDesc(desc: SessionDesc): number {
        const usable = this.checkUsable();
        if (usable !== DP_OK) return usable;
        if (!this.hosting) return DPERR_ACCESSDENIED;
        const d = this.desc!;
        this.desc = { ...desc, guidInstance: d.guidInstance, guidApplication: d.guidApplication, currentPlayers: d.currentPlayers };
        const next = this.desc;
        this.broadcastToPeers(DPSP_MSG.SESSIONDESCCHANGED, (w) => writeSessionDescFull(w, next));
        return DP_OK;
    }

    // ─── messages ────────────────────────────────────────────────────────────

    /**
     * Queue a system message for every local player except `except`. With no local player yet
     * (a host that has not created one) it is addressed to DPID_ALLPLAYERS so it is not lost.
     */
    private postSystem(sys: SystemMessage, except = 0): void {
        let delivered = false;
        let hasLocal = false;
        for (const e of this.entities.values()) {
            if (!e.local || e.isGroup) continue;
            hasLocal = true;
            if (e.id === except) continue;
            this.enqueue({ from: DPID_SYSMSG, to: e.id, data: null, sys });
            delivered = true;
        }
        if (!delivered && !hasLocal) this.enqueue({ from: DPID_SYSMSG, to: DPID_ALLPLAYERS, data: null, sys });
    }

    /** Players a send to `to` reaches, excluding the sender itself. */
    private recipients(from: number, to: number): Entity[] | null {
        if (to === DPID_ALLPLAYERS) {
            return [...this.entities.values()].filter((e) => !e.isGroup && e.id !== from);
        }
        const target = this.entities.get(to);
        if (!target) return null;
        if (!target.isGroup) return [target];
        const out: Entity[] = [];
        for (const id of target.members) {
            const p = this.entities.get(id);
            if (p && !p.isGroup && p.id !== from) out.push(p);
        }
        return out;
    }

    send(from: number, to: number, data: Uint8Array): number {
        this.pump();
        const usable = this.checkUsable();
        if (usable !== DP_OK) return usable;
        from >>>= 0;
        to >>>= 0;
        const sender = this.entities.get(from);
        if (!sender || sender.isGroup || !sender.local) return DPERR_INVALIDPLAYER;
        const targets = this.recipients(from, to);
        if (!targets) return DPERR_INVALIDPLAYER;
        for (const p of targets) {
            if (p.local) {
                this.enqueue({ from, to: p.id, data: data.slice(), sys: null });
                continue;
            }
            const peer = this.peers.get(p.slot);
            if (peer) this.sendBody(peer.host, peer.port, encodeUserBody(from, p.id, data));
        }
        return DP_OK;
    }

    /** SendEx with DPSEND_ASYNC: the send completes immediately, reported by DPSYS_SENDCOMPLETE. */
    sendAsync(from: number, to: number, data: Uint8Array, info: { flags: number; priority: number; timeout: number; context: number; notify: boolean }): { hr: number; msgId: number } {
        const hr = this.send(from, to, data);
        if (hr !== DP_OK) return { hr, msgId: 0 };
        const msgId = this.nextMsgId++;
        if (info.notify) {
            this.enqueue({
                from: DPID_SYSMSG, to: from >>> 0, data: null,
                sys: {
                    type: DPSYS_SENDCOMPLETE, from: from >>> 0, to: to >>> 0, flags: info.flags, priority: info.priority,
                    timeout: info.timeout, context: info.context, msgId, hr: DP_OK,
                },
            });
        }
        return { hr: DPERR_PENDING, msgId };
    }

    /** Index of the first queued message matching Receive's filters, or -1. */
    findMessage(from: number | null, to: number | null): number {
        this.pump();
        for (let i = 0; i < this.queue.length; i++) {
            const m = this.queue[i]!;
            if (from !== null && m.from !== from >>> 0) continue;
            if (to !== null && m.to !== to >>> 0) continue;
            return i;
        }
        return -1;
    }

    message(index: number): QueuedMessage | undefined {
        return this.queue[index];
    }

    takeMessage(index: number): void {
        this.queue.splice(index, 1);
    }

    messageCount(player: number): number {
        this.pump();
        if (player === DPID_ALLPLAYERS) return this.queue.length;
        let n = 0;
        for (const m of this.queue) if (m.to === player >>> 0) n++;
        return n;
    }

    peerAddress(slot: number): { host: number; port: number } | null {
        if (slot === this.slot) return { host: this.link.localHost, port: this.sock ? this.stack.localPort(this.sock) : 0 };
        const p = this.peers.get(slot);
        return p ? { host: p.host, port: p.port } : null;
    }

    /** Local id of the host's slot, for DPCAPS_ISHOST on remote players. */
    static readonly HOST_SLOT = HOST_SLOT;
}
