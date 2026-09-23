/**
 * DirectPlay TCP/IP service-provider wire format.
 *
 * Framing follows MS-DPDX: every datagram starts with the 20-byte DPSP header (size/token word
 * plus the SOCKADDR_IN the sender wants replies on), and system messages continue with the
 * 'play' signature, a command id and a version. User payloads carry idFrom/idTo instead of the
 * signature. EnumSessions/EnumSessionsReply and Packet (fragmentation) use the MS-DPDX body
 * layouts; the roster messages keep the MS-DPDX command ids with compact bodies, since the goal
 * is interop between BottleShip guests rather than with a native dplayx.
 *
 * Data-only: no guest pointers, so it can be unit-tested without an emulator.
 */

export const DPSP_HEADER_SIZE = 20;
export const DPMSG_HEADER_SIZE = 8;
const DPSP_TOKEN = 0xfab;
const AF_INET = 2;
/** "play", little-endian. */
export const DPMSG_SIGNATURE = 0x79616c70;
/** DirectX 7 protocol version. */
export const DPMSG_VERSION = 0x000e;

export const DPSP_MSG = {
    ENUMSESSIONSREPLY: 0x0001,
    ENUMSESSIONS: 0x0002,
    REQUESTPLAYERID: 0x0005,
    REQUESTPLAYERREPLY: 0x0007,
    CREATEPLAYER: 0x0008,
    CREATEGROUP: 0x0009,
    DELETEPLAYER: 0x000b,
    DELETEGROUP: 0x000c,
    ADDPLAYERTOGROUP: 0x000d,
    DELETEPLAYERFROMGROUP: 0x000e,
    PLAYERDATACHANGED: 0x000f,
    PLAYERNAMECHANGED: 0x0010,
    GROUPDATACHANGED: 0x0011,
    GROUPNAMECHANGED: 0x0012,
    ADDFORWARDREQUEST: 0x0013,
    PACKET: 0x0015,
    SESSIONDESCCHANGED: 0x001a,
    SUPERENUMPLAYERSREPLY: 0x0029,
} as const;

/** DPSESSIONDESC2 as carried on the wire: the 80-byte struct with pointer fields zeroed. */
export const DPSESSIONDESC2_SIZE = 80;
/** Packet body before the data: MessageGuid + six DWORDs. */
const PACKET_FIELDS_SIZE = 16 + 6 * 4;
export const PACKET_OVERHEAD = DPSP_HEADER_SIZE + DPMSG_HEADER_SIZE + PACKET_FIELDS_SIZE;

export interface SessionDesc {
    flags: number;
    guidInstance: Uint8Array;
    guidApplication: Uint8Array;
    maxPlayers: number;
    currentPlayers: number;
    name: string;
    password: string;
    user: [number, number, number, number];
}

export interface PeerAddress {
    host: number;
    port: number;
}

// ─── primitive writer / reader ───────────────────────────────────────────────

export class WireWriter {
    private buf = new Uint8Array(256);
    private view = new DataView(this.buf.buffer);
    length = 0;

    private reserve(n: number): void {
        if (this.length + n <= this.buf.length) return;
        let size = this.buf.length * 2;
        while (size < this.length + n) size *= 2;
        const next = new Uint8Array(size);
        next.set(this.buf.subarray(0, this.length));
        this.buf = next;
        this.view = new DataView(next.buffer);
    }

    u16(v: number): this {
        this.reserve(2);
        this.view.setUint16(this.length, v & 0xffff, true);
        this.length += 2;
        return this;
    }

    u16be(v: number): this {
        this.reserve(2);
        this.view.setUint16(this.length, v & 0xffff, false);
        this.length += 2;
        return this;
    }

    u32(v: number): this {
        this.reserve(4);
        this.view.setUint32(this.length, v >>> 0, true);
        this.length += 4;
        return this;
    }

    u32be(v: number): this {
        this.reserve(4);
        this.view.setUint32(this.length, v >>> 0, false);
        this.length += 4;
        return this;
    }

    bytes(b: Uint8Array): this {
        this.reserve(b.length);
        this.buf.set(b, this.length);
        this.length += b.length;
        return this;
    }

    zeros(n: number): this {
        this.reserve(n);
        this.buf.fill(0, this.length, this.length + n);
        this.length += n;
        return this;
    }

    /** Length-prefixed byte blob. */
    blob(b: Uint8Array): this {
        return this.u32(b.length).bytes(b);
    }

    /** Length-prefixed UTF-16LE string (code units, no terminator). */
    wstr(s: string): this {
        this.u32(s.length);
        for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
        return this;
    }

    /** Null-terminated UTF-16LE, as MS-DPDX carries names. */
    wstrz(s: string): this {
        for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
        return this.u16(0);
    }

    patchU32(offset: number, v: number): void {
        this.view.setUint32(offset, v >>> 0, true);
    }

    finish(): Uint8Array {
        return this.buf.slice(0, this.length);
    }
}

export class WireReader {
    private view: DataView;
    offset: number;

    constructor(private readonly buf: Uint8Array, offset = 0) {
        this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        this.offset = offset;
    }

    get remaining(): number {
        return this.buf.length - this.offset;
    }

    private need(n: number): void {
        if (this.offset + n > this.buf.length) throw new RangeError("dplay wire: truncated message");
    }

    u16(): number {
        this.need(2);
        const v = this.view.getUint16(this.offset, true);
        this.offset += 2;
        return v;
    }

    u16be(): number {
        this.need(2);
        const v = this.view.getUint16(this.offset, false);
        this.offset += 2;
        return v;
    }

    u32(): number {
        this.need(4);
        const v = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return v;
    }

    u32be(): number {
        this.need(4);
        const v = this.view.getUint32(this.offset, false);
        this.offset += 4;
        return v;
    }

    bytes(n: number): Uint8Array {
        this.need(n);
        const out = this.buf.slice(this.offset, this.offset + n);
        this.offset += n;
        return out;
    }

    skip(n: number): void {
        this.need(n);
        this.offset += n;
    }

    blob(): Uint8Array {
        return this.bytes(this.u32());
    }

    wstr(): string {
        const n = this.u32();
        this.need(n * 2);
        let s = "";
        for (let i = 0; i < n; i++) s += String.fromCharCode(this.u16());
        return s;
    }

    wstrz(): string {
        let s = "";
        for (;;) {
            const c = this.u16();
            if (c === 0) return s;
            s += String.fromCharCode(c);
        }
    }

    rest(): Uint8Array {
        return this.bytes(this.remaining);
    }
}

// ─── headers ────────────────────────────────────────────────────────────────

/** DPSP header: size|token, then SOCKADDR_IN (network byte order) of the reply address. */
function writeSpHeader(w: WireWriter, reply: PeerAddress, replyIp: number): void {
    w.u32(0); // size patched in finish()
    w.u16(AF_INET).u16be(reply.port).u32be(replyIp).zeros(8);
}

function finishSp(w: WireWriter): Uint8Array {
    const out = w.finish();
    new DataView(out.buffer).setUint32(0, ((out.length & 0xfffff) | (DPSP_TOKEN << 20)) >>> 0, true);
    return out;
}

function startSystem(reply: PeerAddress, replyIp: number, command: number): WireWriter {
    const w = new WireWriter();
    writeSpHeader(w, reply, replyIp);
    w.u32(DPMSG_SIGNATURE).u16(command).u16(DPMSG_VERSION);
    return w;
}

export interface ParsedSp {
    /** Where the sender wants replies (port from SOCKADDR_IN). */
    replyPort: number;
    replyIp: number;
    /** Everything after the SP header. */
    body: Uint8Array;
}

export function parseSpHeader(datagram: Uint8Array): ParsedSp | null {
    if (datagram.length < DPSP_HEADER_SIZE) return null;
    const view = new DataView(datagram.buffer, datagram.byteOffset, datagram.byteLength);
    const word = view.getUint32(0, true);
    if ((word >>> 20) !== DPSP_TOKEN) return null;
    const size = word & 0xfffff;
    if (size !== datagram.length) return null;
    if (view.getUint16(4, true) !== AF_INET) return null;
    return {
        replyPort: view.getUint16(6, false),
        replyIp: view.getUint32(8, false),
        body: datagram.subarray(DPSP_HEADER_SIZE),
    };
}

/** A system message body (after the SP header) starts with the signature; user data does not. */
export function isSystemBody(body: Uint8Array): boolean {
    return body.length >= DPMSG_HEADER_SIZE &&
        body[0] === 0x70 && body[1] === 0x6c && body[2] === 0x61 && body[3] === 0x79;
}

export function systemCommand(body: Uint8Array): number {
    return body[4]! | (body[5]! << 8);
}

// ─── session descriptions ───────────────────────────────────────────────────

function writeSessionDesc(w: WireWriter, d: SessionDesc): void {
    w.u32(DPSESSIONDESC2_SIZE).u32(d.flags).bytes(d.guidInstance).bytes(d.guidApplication)
        .u32(d.maxPlayers).u32(d.currentPlayers)
        .u32(0).u32(0)      // lpszSessionName, lpszPassword
        .u32(0).u32(0)      // dwReserved1/2
        .u32(d.user[0]).u32(d.user[1]).u32(d.user[2]).u32(d.user[3]);
}

function readSessionDesc(r: WireReader): Omit<SessionDesc, "name" | "password"> {
    r.u32();
    const flags = r.u32();
    const guidInstance = r.bytes(16);
    const guidApplication = r.bytes(16);
    const maxPlayers = r.u32();
    const currentPlayers = r.u32();
    r.skip(16);
    const user: [number, number, number, number] = [r.u32(), r.u32(), r.u32(), r.u32()];
    return { flags, guidInstance, guidApplication, maxPlayers, currentPlayers, user };
}

// ─── EnumSessions (MS-DPDX 2.2.29 / 2.2.28) ─────────────────────────────────

export interface EnumSessionsRequest {
    guidApplication: Uint8Array;
    flags: number;
    password: string;
}

export function encodeEnumSessions(reply: PeerAddress, replyIp: number, req: EnumSessionsRequest): Uint8Array {
    const w = startSystem(reply, replyIp, DPSP_MSG.ENUMSESSIONS);
    const passwordOffsetAt = w.length + 16;
    w.bytes(req.guidApplication).u32(0).u32(req.flags);
    if (req.password) {
        w.patchU32(passwordOffsetAt, w.length - DPSP_HEADER_SIZE);
        w.wstrz(req.password);
    }
    return finishSp(w);
}

export function decodeEnumSessions(body: Uint8Array): EnumSessionsRequest {
    const r = new WireReader(body, DPMSG_HEADER_SIZE);
    const guidApplication = r.bytes(16);
    const passwordOffset = r.u32();
    const flags = r.u32();
    const password = passwordOffset ? new WireReader(body, passwordOffset).wstrz() : "";
    return { guidApplication, flags, password };
}

export function encodeEnumSessionsReply(reply: PeerAddress, replyIp: number, desc: SessionDesc): Uint8Array {
    const w = startSystem(reply, replyIp, DPSP_MSG.ENUMSESSIONSREPLY);
    writeSessionDesc(w, desc);
    w.u32(DPMSG_HEADER_SIZE + DPSESSIONDESC2_SIZE + 4);
    w.wstrz(desc.name);
    return finishSp(w);
}

export function decodeEnumSessionsReply(body: Uint8Array): SessionDesc {
    const r = new WireReader(body, DPMSG_HEADER_SIZE);
    const desc = readSessionDesc(r);
    const nameOffset = r.u32();
    const name = nameOffset ? new WireReader(body, nameOffset).wstrz() : "";
    return { ...desc, name, password: "" };
}

// ─── roster entities ────────────────────────────────────────────────────────

export interface WireEntity {
    id: number;
    isGroup: boolean;
    /** DPPLAYER_* / DPGROUP_* flags as the app set them. */
    flags: number;
    /** Peer slot that owns the entity (its players are local there). */
    slot: number;
    parent: number;
    shortName: string;
    longName: string;
    hasName: boolean;
    data: Uint8Array;
    members: number[];
}

export function writeEntity(w: WireWriter, e: WireEntity): void {
    w.u32(e.id).u32(e.isGroup ? 1 : 0).u32(e.flags).u32(e.slot).u32(e.parent).u32(e.hasName ? 1 : 0)
        .wstr(e.shortName).wstr(e.longName).blob(e.data).u32(e.members.length);
    for (const m of e.members) w.u32(m);
}

export function readEntity(r: WireReader): WireEntity {
    const id = r.u32();
    const isGroup = r.u32() !== 0;
    const flags = r.u32();
    const slot = r.u32();
    const parent = r.u32();
    const hasName = r.u32() !== 0;
    const shortName = r.wstr();
    const longName = r.wstr();
    const data = r.blob();
    const count = r.u32();
    const members: number[] = [];
    for (let i = 0; i < count; i++) members.push(r.u32());
    return { id, isGroup, flags, slot, parent, shortName, longName, hasName, data, members };
}

export interface WirePeer {
    slot: number;
    host: number;
    port: number;
}

/** Encode a system message whose body is produced by `fill`. */
export function encodeSystem(
    reply: PeerAddress,
    replyIp: number,
    command: number,
    fill: (w: WireWriter) => void,
): Uint8Array {
    const w = startSystem(reply, replyIp, command);
    fill(w);
    return finishSp(w);
}

/** Reader positioned just past the 'play' header. */
export function systemReader(body: Uint8Array): WireReader {
    return new WireReader(body, DPMSG_HEADER_SIZE);
}

export interface JoinReply {
    slot: number;
    idKey: number;
    desc: SessionDesc;
    peers: WirePeer[];
    entities: WireEntity[];
}

export function writeJoinReply(w: WireWriter, j: JoinReply): void {
    w.u32(j.slot).u32(j.idKey);
    writeSessionDesc(w, j.desc);
    w.wstr(j.desc.name).wstr(j.desc.password);
    w.u32(j.peers.length);
    for (const p of j.peers) w.u32(p.slot).u32(p.host).u32(p.port);
    w.u32(j.entities.length);
    for (const e of j.entities) writeEntity(w, e);
}

export function readJoinReply(r: WireReader): JoinReply {
    const slot = r.u32();
    const idKey = r.u32();
    const base = readSessionDesc(r);
    const name = r.wstr();
    const password = r.wstr();
    const peers: WirePeer[] = [];
    for (let i = r.u32(); i > 0; i--) peers.push({ slot: r.u32(), host: r.u32(), port: r.u32() });
    const entities: WireEntity[] = [];
    for (let i = r.u32(); i > 0; i--) entities.push(readEntity(r));
    return { slot, idKey, desc: { ...base, name, password }, peers, entities };
}

export function writeSessionDescFull(w: WireWriter, d: SessionDesc): void {
    writeSessionDesc(w, d);
    w.wstr(d.name).wstr(d.password);
}

export function readSessionDescFull(r: WireReader): SessionDesc {
    const base = readSessionDesc(r);
    return { ...base, name: r.wstr(), password: r.wstr() };
}

// ─── user data ──────────────────────────────────────────────────────────────

/** Body of a user message: idFrom, idTo, payload. */
export function encodeUserBody(idFrom: number, idTo: number, data: Uint8Array): Uint8Array {
    return new WireWriter().u32(idFrom).u32(idTo).bytes(data).finish();
}

/** Prefix a body (user or system, without SP header) with the SP header. */
export function wrapBody(reply: PeerAddress, replyIp: number, body: Uint8Array): Uint8Array {
    const w = new WireWriter();
    writeSpHeader(w, reply, replyIp);
    w.bytes(body);
    return finishSp(w);
}

// ─── fragmentation: DPSP_MSG_PACKET (MS-DPDX 2.2.47) ────────────────────────

/**
 * Split a body (everything after the SP header) into datagrams no larger than `mtu`. A body that
 * fits goes out as a single datagram; larger ones become Packet messages, each carrying the
 * message GUID, its index, the byte offset and the total size so the receiver can reassemble
 * regardless of which fragment arrives first.
 */
export function fragmentBody(
    reply: PeerAddress,
    replyIp: number,
    body: Uint8Array,
    mtu: number,
    messageGuid: Uint8Array,
): Uint8Array[] {
    if (DPSP_HEADER_SIZE + body.length <= mtu) return [wrapBody(reply, replyIp, body)];
    const chunk = mtu - PACKET_OVERHEAD;
    if (chunk <= 0) throw new RangeError("dplay wire: MTU too small to fragment");
    const total = Math.ceil(body.length / chunk);
    const out: Uint8Array[] = [];
    for (let i = 0; i < total; i++) {
        const offset = i * chunk;
        const data = body.subarray(offset, Math.min(offset + chunk, body.length));
        out.push(encodeSystem(reply, replyIp, DPSP_MSG.PACKET, (w) => {
            w.bytes(messageGuid).u32(i).u32(data.length).u32(offset).u32(total).u32(body.length)
                .u32(DPMSG_HEADER_SIZE + PACKET_FIELDS_SIZE).bytes(data);
        }));
    }
    return out;
}

export interface PacketFragment {
    messageKey: string;
    index: number;
    offset: number;
    total: number;
    messageSize: number;
    data: Uint8Array;
}

export function decodePacket(body: Uint8Array): PacketFragment {
    const r = systemReader(body);
    const guid = r.bytes(16);
    const index = r.u32();
    const dataSize = r.u32();
    const offset = r.u32();
    const total = r.u32();
    const messageSize = r.u32();
    const packedOffset = r.u32();
    const data = new WireReader(body, packedOffset).bytes(dataSize);
    let messageKey = "";
    for (const b of guid) messageKey += b.toString(16).padStart(2, "0");
    return { messageKey, index, offset, total, messageSize, data };
}

/** Collects Packet fragments per (sender, message GUID) until a message is whole. */
export class Reassembler {
    private pending = new Map<string, { buf: Uint8Array; seen: Set<number>; total: number; at: number }>();

    constructor(private readonly maxPending = 64, private readonly maxMessage = 4 * 1024 * 1024) {}

    /** Returns the reassembled body once every fragment arrived, else null. */
    add(sender: number, frag: PacketFragment, now: number): Uint8Array | null {
        if (frag.messageSize > this.maxMessage || frag.total === 0 || frag.index >= frag.total) return null;
        if (frag.offset + frag.data.length > frag.messageSize) return null;
        const key = `${sender}:${frag.messageKey}`;
        let entry = this.pending.get(key);
        if (!entry) {
            if (this.pending.size >= this.maxPending) this.evictOldest();
            entry = { buf: new Uint8Array(frag.messageSize), seen: new Set(), total: frag.total, at: now };
            this.pending.set(key, entry);
        }
        if (entry.buf.length !== frag.messageSize || entry.total !== frag.total) return null;
        entry.buf.set(frag.data, frag.offset);
        entry.seen.add(frag.index);
        if (entry.seen.size < entry.total) return null;
        this.pending.delete(key);
        return entry.buf;
    }

    /** Forget partial messages from a sender that left. */
    dropSender(sender: number): void {
        for (const key of this.pending.keys()) {
            if (key.startsWith(`${sender}:`)) this.pending.delete(key);
        }
    }

    get size(): number {
        return this.pending.size;
    }

    private evictOldest(): void {
        let oldestKey = "";
        let oldest = Infinity;
        for (const [key, e] of this.pending) {
            if (e.at < oldest) {
                oldest = e.at;
                oldestKey = key;
            }
        }
        if (oldestKey) this.pending.delete(oldestKey);
    }
}
