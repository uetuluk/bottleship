/**
 * The guest's transport layer: ports, sockets and connection state over the virtual NIC.
 *
 * Deliberately data-only — it deals in host octets, ports and byte arrays, never in guest
 * pointers — so the Winsock modules keep all the marshalling and this stays unit-testable.
 *
 * Scope of the stream implementation: the link under us delivers reliably and in order (a
 * relay WebSocket, or a WebRTC channel in reliable mode), so a stream socket needs connection
 * setup and teardown but not retransmission, windowing or congestion control. Those exist in
 * TCP to survive an unreliable IP layer we do not have. The one place ordering can break is a
 * mid-stream switch between relay and direct path, which the sequence number resolves.
 *
 * Blocking semantics: every operation completes or reports WSAEWOULDBLOCK immediately. The
 * emulator worker runs the x86 loop, so a socket call that blocked would stall every guest
 * thread, not just the caller's. Games that drive sockets with select/WSAAsyncSelect — the
 * overwhelming majority of the LAN-era titles this targets — see correct behaviour; a game
 * that expects a blocking recv to sleep will spin instead. Parking the calling guest thread
 * via the async-thunk path (CLAUDE.md §3.5) is the faithful fix and the next step here.
 */

import {
    ICMP_ECHO_REPLY,
    ICMP_ECHO_REQUEST,
    NIC_PROTO_ICMP,
    NIC_PROTO_STREAM,
    NIC_PROTO_UDP,
    NIC_SF_ACK,
    NIC_SF_FIN,
    NIC_SF_PSH,
    NIC_SF_RST,
    NIC_SF_SYN,
    VLAN_BROADCAST_HOST,
    type NicHeader,
} from "../../../net/nic-contract";
import { Logger, LogCategory } from "../logger";
import { getVirtualNic, type NicDevice } from "./virtual-nic";

export const SOCK_STREAM = 1;
export const SOCK_DGRAM = 2;

export const WSAEACCES = 10013;
export const WSAEFAULT = 10014;
export const WSAEINVAL = 10022;
export const WSAEMFILE = 10024;
export const WSAENOTSOCK = 10038;
export const WSAEWOULDBLOCK = 10035;
export const WSAEMSGSIZE = 10040;
export const WSAEAFNOSUPPORT = 10047;
export const WSAEADDRINUSE = 10048;
export const WSAEADDRNOTAVAIL = 10049;
export const WSAENETDOWN = 10050;
export const WSAECONNABORTED = 10053;
export const WSAECONNRESET = 10054;
export const WSAEISCONN = 10056;
export const WSAENOTCONN = 10057;
export const WSAESHUTDOWN = 10058;
export const WSAECONNREFUSED = 10061;
export const WSAEHOSTUNREACH = 10065;

/** Errors travel as negative codes so a single number can carry either a length or a failure. */
export function isError(result: number): boolean {
    return result < 0;
}
export function errorOf(result: number): number {
    return -result;
}
const fail = (code: number): number => -code;

const EPHEMERAL_MIN = 49152;
const EPHEMERAL_MAX = 65535;
/** Per-socket receive budget; a flooding peer fills its own queue and is dropped, not us. */
const MAX_DGRAM_QUEUE = 512;
const MAX_STREAM_BUFFER = 256 * 1024;
/** How far out of order a stream chunk may arrive before we give up waiting for the gap. */
const REORDER_WINDOW = 32;

type StreamState = "closed" | "listen" | "syn-sent" | "established" | "peer-closed";

interface Datagram {
    host: number;
    port: number;
    data: Uint8Array;
}

interface PendingConnection {
    host: number;
    port: number;
}

interface Socket {
    id: number;
    type: number;
    localPort: number;
    remoteHost: number;
    remotePort: number;
    nonBlocking: boolean;
    broadcast: boolean;
    reuseAddr: boolean;
    /** Datagram sockets keep message boundaries; stream sockets keep a byte stream. */
    queue: Datagram[];
    queuedBytes: number;
    stream: {
        state: StreamState;
        chunks: Uint8Array[];
        bytes: number;
        txSeq: number;
        rxSeq: number;
        reorder: Map<number, Uint8Array>;
        backlog: number;
        pending: PendingConnection[];
        resetError: number;
        sendShutdown: boolean;
        recvShutdown: boolean;
    };
}

export interface RecvFromResult {
    length: number;
    host: number;
    port: number;
    truncated: boolean;
}

/**
 * One instance per guest. Sockets are numbered from 1; Winsock's INVALID_SOCKET is ~0 and
 * never collides.
 */
export class NetStack {
    private sockets = new Map<number, Socket>();
    private nextId = 1;
    private nextEphemeral = EPHEMERAL_MIN;
    private scratch = new Uint8Array(0);
    /** Outstanding echo requests (sequence → send time) and the replies they earned. */
    private echoes = new Map<number, number>();
    private echoReplies = new Map<number, number>();
    private nextEcho = 1;

    constructor(private readonly nic: NicDevice) {}

    // ─── lifecycle ───────────────────────────────────────────────────────────

    reset(): void {
        this.sockets.clear();
        this.echoes.clear();
        this.echoReplies.clear();
        this.nextId = 1;
        this.nextEphemeral = EPHEMERAL_MIN;
    }

    /**
     * Drain the NIC into per-socket queues. Called at the top of every Winsock entry point so
     * a game that only ever calls recvfrom still makes progress without a separate pump.
     */
    pump(): void {
        if (this.nic.consumeEpochChange()) {
            // Our address changed under us: tear the guest's connections down loudly rather
            // than let it keep sending from an address the room will not answer.
            let reset = 0;
            for (const socket of this.sockets.values()) {
                if (socket.type === SOCK_STREAM && socket.stream.state === "established") {
                    socket.stream.state = "peer-closed";
                    socket.stream.resetError = WSAECONNRESET;
                    reset++;
                }
            }
            if (reset > 0) {
                Logger.warn(LogCategory.SYSTEM, `[net] link identity changed; ${reset} connection(s) reset`);
            }
        }
        this.nic.poll((header, payload) => this.deliver(header, payload));
    }

    open(type: number): number {
        if (type !== SOCK_DGRAM && type !== SOCK_STREAM) return fail(WSAEAFNOSUPPORT);
        if (this.sockets.size >= 1024) return fail(WSAEMFILE);
        const id = this.nextId++;
        this.sockets.set(id, {
            id,
            type,
            localPort: 0,
            remoteHost: 0,
            remotePort: 0,
            nonBlocking: false,
            broadcast: false,
            reuseAddr: false,
            queue: [],
            queuedBytes: 0,
            stream: {
                state: "closed",
                chunks: [],
                bytes: 0,
                txSeq: 0,
                rxSeq: 0,
                reorder: new Map(),
                backlog: 0,
                pending: [],
                resetError: 0,
                sendShutdown: false,
                recvShutdown: false,
            },
        });
        return id;
    }

    close(id: number): number {
        const socket = this.sockets.get(id);
        if (!socket) return fail(WSAENOTCONN);
        if (socket.type === SOCK_STREAM && socket.stream.state === "established") {
            this.sendStreamFlag(socket, NIC_SF_FIN);
        }
        this.sockets.delete(id);
        return 0;
    }

    has(id: number): boolean {
        return this.sockets.has(id);
    }

    // ─── addressing ──────────────────────────────────────────────────────────

    bind(id: number, port: number): number {
        const socket = this.sockets.get(id);
        if (!socket) return fail(WSAENOTCONN);
        if (socket.localPort !== 0) return fail(WSAEINVAL);

        const wanted = port & 0xffff;
        if (wanted === 0) {
            const assigned = this.allocEphemeral(socket.type);
            if (assigned === 0) return fail(WSAEADDRINUSE);
            socket.localPort = assigned;
            return 0;
        }
        if (!socket.reuseAddr && this.portTaken(socket.type, wanted)) return fail(WSAEADDRINUSE);
        socket.localPort = wanted;
        return 0;
    }

    localPort(id: number): number {
        return this.sockets.get(id)?.localPort ?? 0;
    }

    remote(id: number): { host: number; port: number } | null {
        const socket = this.sockets.get(id);
        if (!socket || socket.remoteHost === 0) return null;
        return { host: socket.remoteHost, port: socket.remotePort };
    }

    // ─── datagrams ───────────────────────────────────────────────────────────

    sendTo(id: number, host: number, port: number, data: Uint8Array): number {
        const socket = this.sockets.get(id);
        if (!socket) return fail(WSAENOTCONN);
        if (socket.type !== SOCK_DGRAM) return fail(WSAEINVAL);
        if (!this.nic.linkUp) return fail(WSAENETDOWN);
        if (socket.localPort === 0) {
            const assigned = this.allocEphemeral(socket.type);
            if (assigned === 0) return fail(WSAEADDRINUSE);
            socket.localPort = assigned;
        }
        if (data.length > this.nic.mtu) return fail(WSAEMSGSIZE);
        // Windows refuses a broadcast from a socket that never asked for one.
        if (host === VLAN_BROADCAST_HOST && !socket.broadcast) return fail(WSAEACCES);

        const header: NicHeader = {
            proto: NIC_PROTO_UDP,
            src: this.nic.localHost,
            dst: host,
            srcPort: socket.localPort,
            dstPort: port & 0xffff,
            flags: 0,
            seq: 0,
        };

        // A real stack loops back traffic aimed at ourselves; the switch upstream drops it.
        if (host === this.nic.localHost || host === VLAN_BROADCAST_HOST) {
            this.deliverLocal(header, data, socket.id);
        }
        if (host === this.nic.localHost) return data.length;

        if (!this.nic.send(header, data)) return fail(WSAEWOULDBLOCK);
        return data.length;
    }

    recvFrom(id: number, out: Uint8Array, peek = false): RecvFromResult | number {
        const socket = this.sockets.get(id);
        if (!socket) return fail(WSAENOTCONN);
        if (socket.type !== SOCK_DGRAM) return fail(WSAEINVAL);

        const datagram = socket.queue[0];
        if (!datagram) return fail(WSAEWOULDBLOCK);
        if (!peek) {
            socket.queue.shift();
            socket.queuedBytes -= datagram.data.length;
        }

        const length = Math.min(out.length, datagram.data.length);
        out.set(datagram.data.subarray(0, length));
        return {
            length,
            host: datagram.host,
            port: datagram.port,
            // Winsock reports the overflow rather than silently handing back a short read.
            truncated: length < datagram.data.length,
        };
    }

    // ─── streams ─────────────────────────────────────────────────────────────

    connect(id: number, host: number, port: number): number {
        const socket = this.sockets.get(id);
        if (!socket) return fail(WSAENOTCONN);
        if (!this.nic.linkUp) return fail(WSAENETDOWN);

        if (socket.type === SOCK_DGRAM) {
            // A connected datagram socket just pins the default destination.
            socket.remoteHost = host;
            socket.remotePort = port & 0xffff;
            if (socket.localPort === 0) socket.localPort = this.allocEphemeral(socket.type);
            return 0;
        }

        if (socket.stream.state === "established") return fail(WSAEISCONN);
        if (socket.stream.state === "syn-sent") return fail(WSAEWOULDBLOCK);
        if (socket.localPort === 0) socket.localPort = this.allocEphemeral(socket.type);
        socket.remoteHost = host;
        socket.remotePort = port & 0xffff;
        socket.stream.state = "syn-sent";
        this.sendStreamFlag(socket, NIC_SF_SYN);
        // Like a non-blocking Windows connect: completion is reported through select/poll.
        return fail(WSAEWOULDBLOCK);
    }

    listen(id: number, backlog: number): number {
        const socket = this.sockets.get(id);
        if (!socket) return fail(WSAENOTCONN);
        if (socket.type !== SOCK_STREAM) return fail(WSAEINVAL);
        if (socket.localPort === 0) return fail(WSAEINVAL);
        socket.stream.state = "listen";
        socket.stream.backlog = Math.max(1, Math.min(backlog || 5, 200));
        return 0;
    }

    accept(id: number): { id: number; host: number; port: number } | number {
        const socket = this.sockets.get(id);
        if (!socket) return fail(WSAENOTCONN);
        if (socket.stream.state !== "listen") return fail(WSAEINVAL);
        const pending = socket.stream.pending.shift();
        if (!pending) return fail(WSAEWOULDBLOCK);

        const accepted = this.open(SOCK_STREAM);
        if (isError(accepted)) return accepted;
        const child = this.sockets.get(accepted)!;
        child.localPort = socket.localPort;
        child.remoteHost = pending.host;
        child.remotePort = pending.port;
        child.stream.state = "established";
        return { id: accepted, host: pending.host, port: pending.port };
    }

    send(id: number, data: Uint8Array): number {
        const socket = this.sockets.get(id);
        if (!socket) return fail(WSAENOTCONN);
        if (!this.nic.linkUp) return fail(WSAENETDOWN);

        if (socket.type === SOCK_DGRAM) {
            if (socket.remoteHost === 0) return fail(WSAENOTCONN);
            return this.sendTo(id, socket.remoteHost, socket.remotePort, data);
        }
        if (socket.stream.state !== "established") {
            return fail(socket.stream.resetError || WSAENOTCONN);
        }
        if (socket.stream.sendShutdown) return fail(WSAESHUTDOWN);

        // The guest's stream has no packet boundaries, so oversized writes are simply split.
        const limit = this.nic.mtu;
        let sent = 0;
        while (sent < data.length) {
            const chunk = data.subarray(sent, Math.min(sent + limit, data.length));
            const header: NicHeader = {
                proto: NIC_PROTO_STREAM,
                src: this.nic.localHost,
                dst: socket.remoteHost,
                srcPort: socket.localPort,
                dstPort: socket.remotePort,
                flags: NIC_SF_PSH,
                seq: socket.stream.txSeq,
            };
            if (!this.nic.send(header, chunk)) break;
            socket.stream.txSeq = (socket.stream.txSeq + 1) & 0xffff;
            sent += chunk.length;
        }
        if (sent === 0) return fail(WSAEWOULDBLOCK);
        return sent;
    }

    recv(id: number, out: Uint8Array, peek = false): number {
        const socket = this.sockets.get(id);
        if (!socket) return fail(WSAENOTCONN);

        if (socket.type === SOCK_DGRAM) {
            const result = this.recvFrom(id, out, peek);
            return typeof result === "number" ? result : result.length;
        }
        if (socket.stream.recvShutdown) return 0;
        if (socket.stream.resetError && socket.stream.bytes === 0) return fail(socket.stream.resetError);

        if (socket.stream.bytes === 0) {
            // A graceful close is reported as zero bytes, exactly once the buffer is empty.
            if (socket.stream.state === "peer-closed") return 0;
            if (socket.stream.state !== "established") return fail(WSAENOTCONN);
            return fail(WSAEWOULDBLOCK);
        }

        let copied = 0;
        while (copied < out.length && socket.stream.chunks.length > 0) {
            const chunk = socket.stream.chunks[0]!;
            const take = Math.min(out.length - copied, chunk.length);
            out.set(chunk.subarray(0, take), copied);
            copied += take;
            if (peek) break;
            if (take === chunk.length) socket.stream.chunks.shift();
            else socket.stream.chunks[0] = chunk.subarray(take);
            socket.stream.bytes -= take;
        }
        return copied;
    }

    shutdown(id: number, how: number): number {
        const socket = this.sockets.get(id);
        if (!socket) return fail(WSAENOTCONN);
        if (how === 0 || how === 2) socket.stream.recvShutdown = true;
        if (how === 1 || how === 2) {
            socket.stream.sendShutdown = true;
            if (socket.type === SOCK_STREAM && socket.stream.state === "established") {
                this.sendStreamFlag(socket, NIC_SF_FIN);
            }
        }
        return 0;
    }

    // ─── readiness, for select() and WSAAsyncSelect ──────────────────────────

    readable(id: number): boolean {
        const socket = this.sockets.get(id);
        if (!socket) return false;
        if (socket.type === SOCK_DGRAM) return socket.queue.length > 0;
        if (socket.stream.state === "listen") return socket.stream.pending.length > 0;
        // A closed or reset peer is readable: recv() is how the guest learns about it.
        return socket.stream.bytes > 0 || socket.stream.state === "peer-closed" || socket.stream.resetError !== 0;
    }

    writable(id: number): boolean {
        const socket = this.sockets.get(id);
        if (!socket || !this.nic.linkUp) return false;
        if (socket.type === SOCK_DGRAM) return true;
        return socket.stream.state === "established";
    }

    failed(id: number): boolean {
        const socket = this.sockets.get(id);
        return socket ? socket.stream.resetError !== 0 : false;
    }

    /** FIONREAD: what a single recv can return — one datagram, or the whole stream buffer. */
    available(id: number): number {
        const socket = this.sockets.get(id);
        if (!socket) return 0;
        if (socket.type === SOCK_DGRAM) return socket.queue[0]?.data.length ?? 0;
        return socket.stream.bytes;
    }

    setNonBlocking(id: number, value: boolean): void {
        const socket = this.sockets.get(id);
        if (socket) socket.nonBlocking = value;
    }

    setBroadcast(id: number, value: boolean): void {
        const socket = this.sockets.get(id);
        if (socket) socket.broadcast = value;
    }

    setReuseAddr(id: number, value: boolean): void {
        const socket = this.sockets.get(id);
        if (socket) socket.reuseAddr = value;
    }

    getBroadcast(id: number): boolean {
        return this.sockets.get(id)?.broadcast ?? false;
    }

    /** Send an echo request to a peer. Returns the sequence number to poll for a reply. */
    sendEcho(host: number): number {
        const seq = this.nextEcho;
        this.nextEcho = (this.nextEcho + 1) & 0xffff;
        this.echoes.set(seq, Date.now());
        this.nic.send({
            proto: NIC_PROTO_ICMP,
            src: this.nic.localHost,
            dst: host,
            srcPort: 0,
            dstPort: 0,
            flags: ICMP_ECHO_REQUEST,
            seq,
        }, this.emptyPayload());
        return seq;
    }

    /** Round-trip time for an earlier echo request, or null while it is still outstanding. */
    takeEcho(seq: number): number | null {
        const rtt = this.echoReplies.get(seq);
        if (rtt === undefined) return null;
        this.echoReplies.delete(seq);
        return rtt;
    }

    /** Live socket table, for the harness. Shaped for reading, not for the hot path. */
    describe(): Array<Record<string, unknown>> {
        const rows: Array<Record<string, unknown>> = [];
        for (const socket of this.sockets.values()) {
            rows.push({
                id: socket.id,
                type: socket.type === SOCK_DGRAM ? "dgram" : "stream",
                localPort: socket.localPort,
                peer: socket.remoteHost ? `10.77.0.${socket.remoteHost}:${socket.remotePort}` : null,
                state: socket.type === SOCK_STREAM ? socket.stream.state : "-",
                queued: socket.type === SOCK_DGRAM ? socket.queue.length : socket.stream.bytes,
                readable: this.readable(socket.id),
                writable: this.writable(socket.id),
                nonBlocking: socket.nonBlocking,
                broadcast: socket.broadcast,
            });
        }
        return rows;
    }

    // ─── inbound ─────────────────────────────────────────────────────────────

    private deliver(header: NicHeader, payload: Uint8Array): void {
        // The payload is a view into the NIC scratch buffer, so anything queued must be copied.
        if (header.proto === NIC_PROTO_ICMP) {
            this.deliverEcho(header);
            return;
        }
        if (header.proto === NIC_PROTO_UDP) {
            this.deliverDatagram(header, payload);
            return;
        }
        if (header.proto === NIC_PROTO_STREAM) this.deliverStream(header, payload);
    }

    /**
     * Answer an echo request, or record the round trip for one we sent. Handled entirely in
     * the stack: no socket is involved, so a ping works before a game has opened anything.
     */
    private deliverEcho(header: NicHeader): void {
        if (header.flags === ICMP_ECHO_REQUEST) {
            this.nic.send({
                proto: NIC_PROTO_ICMP,
                src: this.nic.localHost,
                dst: header.src,
                srcPort: 0,
                dstPort: 0,
                flags: ICMP_ECHO_REPLY,
                seq: header.seq,
            }, this.emptyPayload());
            return;
        }
        if (header.flags === ICMP_ECHO_REPLY) {
            const sentAt = this.echoes.get(header.seq);
            if (sentAt !== undefined) {
                this.echoes.delete(header.seq);
                this.echoReplies.set(header.seq, Date.now() - sentAt);
            }
        }
    }

    /** Local loopback: same path as the wire, minus the wire. */
    private deliverLocal(header: NicHeader, payload: Uint8Array, exceptSocket: number): void {
        for (const socket of this.sockets.values()) {
            if (socket.id === exceptSocket) continue;
            if (socket.type !== SOCK_DGRAM || socket.localPort !== header.dstPort) continue;
            this.enqueue(socket, header.src, header.srcPort, payload);
        }
    }

    private deliverDatagram(header: NicHeader, payload: Uint8Array): void {
        for (const socket of this.sockets.values()) {
            if (socket.type !== SOCK_DGRAM || socket.localPort !== header.dstPort) continue;
            // A connected datagram socket ignores traffic from anyone else, as Windows does.
            if (socket.remoteHost !== 0 && (socket.remoteHost !== header.src || socket.remotePort !== header.srcPort)) {
                continue;
            }
            this.enqueue(socket, header.src, header.srcPort, payload);
        }
    }

    private enqueue(socket: Socket, host: number, port: number, payload: Uint8Array): void {
        if (socket.queue.length >= MAX_DGRAM_QUEUE) {
            socket.queue.shift();  // drop the oldest, as a full receive buffer does
        }
        socket.queue.push({ host, port, data: payload.slice() });
        socket.queuedBytes += payload.length;
    }

    private deliverStream(header: NicHeader, payload: Uint8Array): void {
        const connection = this.findStream(header.dstPort, header.src, header.srcPort);

        if (header.flags & NIC_SF_RST) {
            if (connection) {
                // An RST answering our SYN means nobody was listening; one on a live
                // connection means the peer tore it down. Winsock distinguishes the two.
                connection.stream.resetError =
                    connection.stream.state === "syn-sent" ? WSAECONNREFUSED : WSAECONNRESET;
                connection.stream.state = "peer-closed";
            }
            return;
        }

        if (header.flags & NIC_SF_SYN) {
            if (header.flags & NIC_SF_ACK) {
                // Our connect() completed.
                if (connection && connection.stream.state === "syn-sent") {
                    connection.stream.state = "established";
                    this.sendStreamFlag(connection, NIC_SF_ACK);
                }
                return;
            }
            this.acceptSyn(header);
            return;
        }

        if (!connection) {
            if (header.flags & NIC_SF_ACK) return; // handshake tail for a socket already set up
            this.sendRst(header);
            return;
        }

        if (header.flags & NIC_SF_FIN) {
            connection.stream.state = "peer-closed";
            return;
        }
        if (payload.length > 0) this.appendStream(connection, header.seq, payload);
    }

    private acceptSyn(header: NicHeader): void {
        for (const socket of this.sockets.values()) {
            if (socket.type !== SOCK_STREAM || socket.stream.state !== "listen") continue;
            if (socket.localPort !== header.dstPort) continue;
            if (socket.stream.pending.length >= socket.stream.backlog) {
                this.sendRst(header);
                return;
            }
            socket.stream.pending.push({ host: header.src, port: header.srcPort });
            // The handshake completes in the stack; accept() only hands over a finished socket.
            this.nic.send({
                proto: NIC_PROTO_STREAM,
                src: this.nic.localHost,
                dst: header.src,
                srcPort: header.dstPort,
                dstPort: header.srcPort,
                flags: NIC_SF_SYN | NIC_SF_ACK,
                seq: 0,
            }, this.emptyPayload());
            return;
        }
        this.sendRst(header);  // nobody is listening: refuse, do not time out
    }

    /**
     * Append in sequence, parking anything early. The only way a gap appears is a stream
     * switching between the relay and a direct path mid-flight; the window bounds how long we
     * wait before accepting that a chunk is gone for good.
     */
    private appendStream(socket: Socket, seq: number, payload: Uint8Array): void {
        if (socket.stream.bytes >= MAX_STREAM_BUFFER) return;

        if (seq !== socket.stream.rxSeq) {
            if (socket.stream.reorder.size >= REORDER_WINDOW) {
                Logger.warn(LogCategory.SYSTEM, "[net] stream reorder window overflow; resyncing");
                socket.stream.reorder.clear();
                socket.stream.rxSeq = seq;
            } else {
                socket.stream.reorder.set(seq, payload.slice());
                return;
            }
        }

        socket.stream.chunks.push(payload.slice());
        socket.stream.bytes += payload.length;
        socket.stream.rxSeq = (socket.stream.rxSeq + 1) & 0xffff;

        for (;;) {
            const next = socket.stream.reorder.get(socket.stream.rxSeq);
            if (!next) break;
            socket.stream.reorder.delete(socket.stream.rxSeq);
            socket.stream.chunks.push(next);
            socket.stream.bytes += next.length;
            socket.stream.rxSeq = (socket.stream.rxSeq + 1) & 0xffff;
        }
    }

    private findStream(localPort: number, remoteHost: number, remotePort: number): Socket | null {
        for (const socket of this.sockets.values()) {
            if (socket.type !== SOCK_STREAM || socket.localPort !== localPort) continue;
            if (socket.stream.state === "listen") continue;
            if (socket.remoteHost === remoteHost && socket.remotePort === remotePort) return socket;
        }
        return null;
    }

    private sendStreamFlag(socket: Socket, flags: number): void {
        this.nic.send({
            proto: NIC_PROTO_STREAM,
            src: this.nic.localHost,
            dst: socket.remoteHost,
            srcPort: socket.localPort,
            dstPort: socket.remotePort,
            flags,
            seq: socket.stream.txSeq,
        }, this.emptyPayload());
    }

    private sendRst(header: NicHeader): void {
        this.nic.send({
            proto: NIC_PROTO_STREAM,
            src: this.nic.localHost,
            dst: header.src,
            srcPort: header.dstPort,
            dstPort: header.srcPort,
            flags: NIC_SF_RST,
            seq: 0,
        }, this.emptyPayload());
    }

    private emptyPayload(): Uint8Array {
        return this.scratch;
    }

    private portTaken(type: number, port: number): boolean {
        for (const socket of this.sockets.values()) {
            if (socket.type === type && socket.localPort === port) return true;
        }
        return false;
    }

    private allocEphemeral(type: number): number {
        for (let i = 0; i <= EPHEMERAL_MAX - EPHEMERAL_MIN; i++) {
            const port = this.nextEphemeral;
            this.nextEphemeral = this.nextEphemeral >= EPHEMERAL_MAX ? EPHEMERAL_MIN : this.nextEphemeral + 1;
            if (!this.portTaken(type, port)) return port;
        }
        return 0;
    }
}

let instance: NetStack | null = null;

/**
 * The guest's one stack, shared by every consumer — Winsock and DirectPlay alike — because a
 * guest is one host: a port bound through one API is taken for the other, as on real Windows.
 */
export function getNetStack(): NetStack {
    if (!instance) instance = new NetStack(getVirtualNic());
    return instance;
}
