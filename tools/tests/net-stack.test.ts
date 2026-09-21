/**
 * Unit tests for the guest transport stack (src/worker/core/net/net-stack.ts).
 *
 * Two stacks are wired together through a simulated switch that behaves like the Durable
 * Object router: it forwards by destination host octet, fans out broadcasts, and stamps the
 * true source. That lets the Winsock-visible semantics — port binding, broadcast permission,
 * datagram truncation, the stream handshake — be tested without a browser or a network.
 */
import { describe, expect, test } from "bun:test";
import {
    NetStack,
    SOCK_DGRAM,
    SOCK_STREAM,
    WSAEACCES,
    WSAEADDRINUSE,
    WSAECONNREFUSED,
    WSAEMSGSIZE,
    WSAENETDOWN,
    WSAEWOULDBLOCK,
    errorOf,
    isError,
} from "../../src/worker/core/net/net-stack";
import type { FrameSink, NicDevice } from "../../src/worker/core/net/virtual-nic";
import { VLAN_BROADCAST_HOST, hostToIp, type NicHeader } from "../../src/net/nic-contract";

/** Stands in for the router: routes by destination octet, never looks at a payload. */
class Switch {
    private ports = new Map<number, TestNic>();

    attach(nic: TestNic): void {
        this.ports.set(nic.localHost, nic);
    }

    detach(host: number): void {
        this.ports.delete(host);
    }

    hosts(): number[] {
        return [...this.ports.keys()].sort((a, b) => a - b);
    }

    forward(from: number, header: NicHeader, payload: Uint8Array): void {
        const stamped: NicHeader = { ...header, src: from };
        if (header.dst === VLAN_BROADCAST_HOST) {
            for (const [host, nic] of this.ports) {
                if (host !== from) nic.inbound.push({ header: stamped, payload: payload.slice() });
            }
            return;
        }
        if (header.dst === from) return;
        this.ports.get(header.dst)?.inbound.push({ header: stamped, payload: payload.slice() });
    }
}

class TestNic implements NicDevice {
    inbound: Array<{ header: NicHeader; payload: Uint8Array }> = [];
    linkUp = true;
    mtu = 1400;
    epochPending = false;
    /** Frames the device refuses to send, to exercise the full-ring path. */
    sendFails = false;

    constructor(readonly localHost: number, private readonly wire: Switch) {
        wire.attach(this);
    }

    get localIp(): number {
        return hostToIp(this.localHost);
    }

    peers(): number[] {
        return this.wire.hosts().filter((h) => h !== this.localHost);
    }

    consumeEpochChange(): boolean {
        const pending = this.epochPending;
        this.epochPending = false;
        return pending;
    }

    send(header: NicHeader, payload: Uint8Array): boolean {
        if (!this.linkUp || this.sendFails) return false;
        this.wire.forward(this.localHost, header, payload);
        return true;
    }

    poll(sink: FrameSink, budget = 64): number {
        let count = 0;
        while (count < budget) {
            const frame = this.inbound.shift();
            if (!frame) break;
            sink(frame.header, frame.payload);
            count++;
        }
        return count;
    }
}

interface Pair {
    wire: Switch;
    a: { nic: TestNic; stack: NetStack };
    b: { nic: TestNic; stack: NetStack };
}

function makePair(): Pair {
    const wire = new Switch();
    const nicA = new TestNic(1, wire);
    const nicB = new TestNic(2, wire);
    return {
        wire,
        a: { nic: nicA, stack: new NetStack(nicA) },
        b: { nic: nicB, stack: new NetStack(nicB) },
    };
}

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe("datagram sockets", () => {
    test("carries a datagram between two guests with the sender's address attached", () => {
        const { a, b } = makePair();
        const sender = a.stack.open(SOCK_DGRAM);
        const receiver = b.stack.open(SOCK_DGRAM);
        expect(b.stack.bind(receiver, 2300)).toBe(0);
        expect(a.stack.bind(sender, 2301)).toBe(0);

        expect(a.stack.sendTo(sender, 2, 2300, text("hello"))).toBe(5);
        b.stack.pump();

        const out = new Uint8Array(64);
        const result = b.stack.recvFrom(receiver, out);
        expect(typeof result).not.toBe("number");
        if (typeof result === "number") return;
        expect(result.length).toBe(5);
        expect(result.host).toBe(1);
        expect(result.port).toBe(2301);
        expect(new TextDecoder().decode(out.subarray(0, 5))).toBe("hello");
    });

    test("reports WSAEWOULDBLOCK when nothing has arrived", () => {
        const { b } = makePair();
        const socket = b.stack.open(SOCK_DGRAM);
        b.stack.bind(socket, 2300);
        b.stack.pump();
        const result = b.stack.recvFrom(socket, new Uint8Array(64));
        expect(isError(result as number)).toBe(true);
        expect(errorOf(result as number)).toBe(WSAEWOULDBLOCK);
    });

    test("delivers only to the socket bound to the destination port", () => {
        const { a, b } = makePair();
        const sender = a.stack.open(SOCK_DGRAM);
        const wanted = b.stack.open(SOCK_DGRAM);
        const other = b.stack.open(SOCK_DGRAM);
        b.stack.bind(wanted, 2300);
        b.stack.bind(other, 2400);

        a.stack.sendTo(sender, 2, 2300, bytes(1, 2, 3));
        b.stack.pump();

        expect(b.stack.readable(wanted)).toBe(true);
        expect(b.stack.readable(other)).toBe(false);
    });

    test("truncates an oversized datagram and says so, as Winsock does", () => {
        const { a, b } = makePair();
        const sender = a.stack.open(SOCK_DGRAM);
        const receiver = b.stack.open(SOCK_DGRAM);
        b.stack.bind(receiver, 2300);

        a.stack.sendTo(sender, 2, 2300, text("0123456789"));
        b.stack.pump();

        const small = new Uint8Array(4);
        const result = b.stack.recvFrom(receiver, small);
        if (typeof result === "number") throw new Error("expected a datagram");
        expect(result.length).toBe(4);
        expect(result.truncated).toBe(true);
        // The rest of the datagram is discarded, not left to corrupt the next read.
        expect(isError(b.stack.recvFrom(receiver, small) as number)).toBe(true);
    });

    test("refuses a datagram larger than the link MTU", () => {
        const { a } = makePair();
        const socket = a.stack.open(SOCK_DGRAM);
        const result = a.stack.sendTo(socket, 2, 2300, new Uint8Array(2000));
        expect(errorOf(result)).toBe(WSAEMSGSIZE);
    });

    test("auto-binds an unbound sender to an ephemeral port", () => {
        const { a, b } = makePair();
        const sender = a.stack.open(SOCK_DGRAM);
        const receiver = b.stack.open(SOCK_DGRAM);
        b.stack.bind(receiver, 2300);

        a.stack.sendTo(sender, 2, 2300, bytes(9));
        expect(a.stack.localPort(sender)).toBeGreaterThanOrEqual(49152);
        b.stack.pump();
        const result = b.stack.recvFrom(receiver, new Uint8Array(8));
        if (typeof result === "number") throw new Error("expected a datagram");
        expect(result.port).toBe(a.stack.localPort(sender));
    });

    test("rejects a second bind to the same port unless SO_REUSEADDR was set", () => {
        const { a } = makePair();
        const first = a.stack.open(SOCK_DGRAM);
        const second = a.stack.open(SOCK_DGRAM);
        expect(a.stack.bind(first, 2300)).toBe(0);
        expect(errorOf(a.stack.bind(second, 2300))).toBe(WSAEADDRINUSE);

        const third = a.stack.open(SOCK_DGRAM);
        a.stack.setReuseAddr(third, true);
        expect(a.stack.bind(third, 2300)).toBe(0);
    });

    test("keeps a connected datagram socket deaf to other senders", () => {
        const wire = new Switch();
        const nicA = new TestNic(1, wire);
        const nicB = new TestNic(2, wire);
        const nicC = new TestNic(3, wire);
        const a = new NetStack(nicA);
        const b = new NetStack(nicB);
        const c = new NetStack(nicC);

        const receiver = b.open(SOCK_DGRAM);
        b.bind(receiver, 2300);
        b.connect(receiver, 1, 2301);

        const wanted = a.open(SOCK_DGRAM);
        a.bind(wanted, 2301);
        const unwanted = c.open(SOCK_DGRAM);
        c.bind(unwanted, 2301);

        a.sendTo(wanted, 2, 2300, bytes(1));
        c.sendTo(unwanted, 2, 2300, bytes(2));
        b.pump();

        const out = new Uint8Array(8);
        const first = b.recvFrom(receiver, out);
        if (typeof first === "number") throw new Error("expected the connected peer's datagram");
        expect(first.host).toBe(1);
        expect(isError(b.recvFrom(receiver, out) as number)).toBe(true);
    });
});

describe("broadcast", () => {
    test("requires SO_BROADCAST, exactly as Windows does", () => {
        const { a } = makePair();
        const socket = a.stack.open(SOCK_DGRAM);
        a.stack.bind(socket, 2300);
        expect(errorOf(a.stack.sendTo(socket, VLAN_BROADCAST_HOST, 2300, bytes(1)))).toBe(WSAEACCES);

        a.stack.setBroadcast(socket, true);
        expect(a.stack.sendTo(socket, VLAN_BROADCAST_HOST, 2300, bytes(1))).toBe(1);
    });

    test("reaches every other guest in the room — the LAN discovery path", () => {
        const wire = new Switch();
        const nics = [new TestNic(1, wire), new TestNic(2, wire), new TestNic(3, wire)];
        const stacks = nics.map((nic) => new NetStack(nic));

        const announcer = stacks[0]!.open(SOCK_DGRAM);
        stacks[0]!.bind(announcer, 47624);
        stacks[0]!.setBroadcast(announcer, true);
        const listeners = [1, 2].map((i) => {
            const socket = stacks[i]!.open(SOCK_DGRAM);
            stacks[i]!.bind(socket, 47624);
            return { stack: stacks[i]!, socket };
        });

        stacks[0]!.sendTo(announcer, VLAN_BROADCAST_HOST, 47624, text("who is there"));
        for (const listener of listeners) {
            listener.stack.pump();
            expect(listener.stack.readable(listener.socket)).toBe(true);
        }
        // The sender does not hear its own broadcast on the sending socket.
        stacks[0]!.pump();
        expect(stacks[0]!.readable(announcer)).toBe(false);
    });

    test("loops a broadcast back to the guest's own other sockets", () => {
        const { a } = makePair();
        const announcer = a.stack.open(SOCK_DGRAM);
        a.stack.bind(announcer, 47624);
        a.stack.setBroadcast(announcer, true);
        const sibling = a.stack.open(SOCK_DGRAM);
        a.stack.setReuseAddr(sibling, true);
        a.stack.bind(sibling, 47624);

        a.stack.sendTo(announcer, VLAN_BROADCAST_HOST, 47624, bytes(7));
        expect(a.stack.readable(sibling)).toBe(true);
        expect(a.stack.readable(announcer)).toBe(false);
    });
});

describe("stream sockets", () => {
    function establish(pair: Pair) {
        const listener = pair.b.stack.open(SOCK_STREAM);
        pair.b.stack.bind(listener, 7000);
        pair.b.stack.listen(listener, 5);

        const client = pair.a.stack.open(SOCK_STREAM);
        expect(errorOf(pair.a.stack.connect(client, 2, 7000))).toBe(WSAEWOULDBLOCK);

        pair.b.stack.pump();                       // listener sees the SYN, replies SYN|ACK
        expect(pair.b.stack.readable(listener)).toBe(true);
        pair.a.stack.pump();                       // client sees SYN|ACK, is established
        expect(pair.a.stack.writable(client)).toBe(true);

        const accepted = pair.b.stack.accept(listener);
        if (typeof accepted === "number") throw new Error("accept failed");
        pair.b.stack.pump();                       // consume the handshake ACK
        return { listener, client, server: accepted.id, peer: accepted };
    }

    test("completes a handshake and reports readiness through select", () => {
        const pair = makePair();
        const { peer } = establish(pair);
        expect(peer.host).toBe(1);
        expect(peer.port).toBeGreaterThanOrEqual(49152);
    });

    test("carries a byte stream in order", () => {
        const pair = makePair();
        const { client, server } = establish(pair);

        pair.a.stack.send(client, text("hello "));
        pair.a.stack.send(client, text("world"));
        pair.b.stack.pump();

        const out = new Uint8Array(64);
        const length = pair.b.stack.recv(server, out);
        expect(new TextDecoder().decode(out.subarray(0, length))).toBe("hello world");
    });

    test("splits a write larger than the MTU and reassembles it", () => {
        const pair = makePair();
        const { client, server } = establish(pair);

        const payload = new Uint8Array(3500);
        for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
        expect(pair.a.stack.send(client, payload)).toBe(3500);
        pair.b.stack.pump();

        const out = new Uint8Array(4096);
        expect(pair.b.stack.recv(server, out)).toBe(3500);
        expect(out[0]).toBe(0);
        expect(out[3499]).toBe(3499 & 0xff);
    });

    test("reports a peer's teardown of a live connection as a reset, not a refusal", () => {
        const pair = makePair();
        const { client, server } = establish(pair);
        pair.b.stack.close(server);
        pair.a.stack.pump();
        expect(pair.a.stack.recv(client, new Uint8Array(4))).toBe(0); // FIN reads as a clean close
        expect(pair.a.stack.readable(client)).toBe(true);
    });

    test("reports a graceful close as a zero-length read, after the buffer drains", () => {
        const pair = makePair();
        const { client, server } = establish(pair);

        pair.a.stack.send(client, text("bye"));
        pair.a.stack.close(client);
        pair.b.stack.pump();

        const out = new Uint8Array(16);
        expect(pair.b.stack.recv(server, out)).toBe(3);   // buffered data comes first
        expect(pair.b.stack.recv(server, out)).toBe(0);   // then the close
    });

    test("refuses a connection to a port nobody is listening on", () => {
        const pair = makePair();
        const client = pair.a.stack.open(SOCK_STREAM);
        pair.a.stack.connect(client, 2, 9999);
        pair.b.stack.pump();   // no listener → RST
        pair.a.stack.pump();

        expect(pair.a.stack.failed(client)).toBe(true);
        expect(errorOf(pair.a.stack.recv(client, new Uint8Array(4)))).toBe(WSAECONNREFUSED);
    });

    test("reassembles chunks that arrive out of order", () => {
        const pair = makePair();
        const { client, server } = establish(pair);

        // Reverse the two frames in flight, as a relay→direct switchover can.
        pair.a.stack.send(client, text("first "));
        pair.a.stack.send(client, text("second"));
        const inbound = pair.b.nic.inbound;
        inbound.reverse();
        pair.b.stack.pump();

        const out = new Uint8Array(64);
        const length = pair.b.stack.recv(server, out);
        expect(new TextDecoder().decode(out.subarray(0, length))).toBe("first second");
    });

    test("queues several pending connections up to the backlog", () => {
        const wire = new Switch();
        const server = new NetStack(new TestNic(1, wire));
        const listener = server.open(SOCK_STREAM);
        server.bind(listener, 7000);
        server.listen(listener, 5);

        for (const host of [2, 3, 4]) {
            const client = new NetStack(new TestNic(host, wire));
            const socket = client.open(SOCK_STREAM);
            client.connect(socket, 1, 7000);
        }
        server.pump();

        const hosts: number[] = [];
        for (;;) {
            const accepted = server.accept(listener);
            if (typeof accepted === "number") break;
            hosts.push(accepted.host);
        }
        expect(hosts.sort()).toEqual([2, 3, 4]);
    });
});

describe("link state", () => {
    test("fails sends while the link is down", () => {
        const { a } = makePair();
        a.nic.linkUp = false;
        const socket = a.stack.open(SOCK_DGRAM);
        expect(errorOf(a.stack.sendTo(socket, 2, 2300, bytes(1)))).toBe(WSAENETDOWN);
        expect(a.stack.writable(socket)).toBe(false);
    });

    test("resets established connections when our address changes under us", () => {
        const pair = makePair();
        const listener = pair.b.stack.open(SOCK_STREAM);
        pair.b.stack.bind(listener, 7000);
        pair.b.stack.listen(listener, 5);
        const client = pair.a.stack.open(SOCK_STREAM);
        pair.a.stack.connect(client, 2, 7000);
        pair.b.stack.pump();
        pair.a.stack.pump();
        expect(pair.a.stack.writable(client)).toBe(true);

        pair.a.nic.epochPending = true;
        pair.a.stack.pump();
        expect(pair.a.stack.failed(client)).toBe(true);
    });

    test("reports WSAEWOULDBLOCK when the device cannot take the frame", () => {
        const { a } = makePair();
        const socket = a.stack.open(SOCK_DGRAM);
        a.stack.bind(socket, 2300);
        a.nic.sendFails = true;
        expect(errorOf(a.stack.sendTo(socket, 2, 2300, bytes(1)))).toBe(WSAEWOULDBLOCK);
    });

    test("reports what a single recv would return, for FIONREAD", () => {
        const { a, b } = makePair();
        const sender = a.stack.open(SOCK_DGRAM);
        const receiver = b.stack.open(SOCK_DGRAM);
        b.stack.bind(receiver, 2300);
        a.stack.sendTo(sender, 2, 2300, text("12345"));
        a.stack.sendTo(sender, 2, 2300, text("678"));
        b.stack.pump();
        expect(b.stack.available(receiver)).toBe(5);   // the first datagram, not the total
    });
});
