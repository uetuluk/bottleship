/**
 * Winsock AF_IPX marshalling (src/worker/modules/wsa-net.ts) over a real NIC ring.
 *
 * The guest-visible contract is what matters here: SOCKADDR_IPX layout (network-order socket
 * number at +12), the IPX_ADDRESS_DATA a game reads its node address from, and the frames
 * that reach the wire — so the test drives the exports with guest pointers, the way
 * WinsockInterfaceClass-style IPX code does, and reads the provider side of the ring.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { getVirtualNic } from "../../src/worker/core/net/virtual-nic";
import { makeNetSocketExports } from "../../src/worker/modules/wsa-net";
import {
    CTRL_LINK,
    CTRL_LOCAL_HOST,
    createNicBuffer,
    openHostEndpoint,
    type NicEndpoint,
} from "../../src/net/nic-ring";
import {
    NIC_HEADER_SIZE,
    NIC_PROTO_IPX,
    VLAN_BROADCAST_HOST,
    readNicHeader,
    writeNicHeader,
} from "../../src/net/nic-contract";

const AF_IPX = 6;
const SOCK_DGRAM = 2;
const NSPROTO_IPX = 1000;
const SOL_SOCKET = 0xffff;
const SO_BROADCAST = 0x20;
const IPX_PTYPE = 0x4000;
const IPX_ADDRESS = 0x4007;
const IPX_MAX_ADAPTER_NUM = 0x400d;

const SCRATCH = 0x20000;
const ADDR = 0x21000;
const LEN = 0x21100;
const OPT = 0x21200;
const BUF = 0x22000;

let lastError = 0;
const ws = makeNetSocketExports((code) => { lastError = code; });
const call = (name: string, ...args: number[]) => ws[name]!(null as never, null as never, args) as number;
let provider: NicEndpoint;
const mem = new Uint8Array(0x40000);

beforeAll(() => {
    Mem.bind(() => mem);
    const sab = createNicBuffer(64 * 1024);
    provider = openHostEndpoint(sab);
    provider.ctrl[CTRL_LOCAL_HOST] = 3;
    provider.ctrl[CTRL_LINK] = 1;
    getVirtualNic().attach(sab);
});

function writeSockaddrIpx(ptr: number, node: number[], socket: number): void {
    mem.fill(0, ptr, ptr + 14);
    mem[ptr] = AF_IPX;
    for (let i = 0; i < 6; i++) mem[ptr + 6 + i] = node[i]!;
    mem[ptr + 12] = socket >>> 8;
    mem[ptr + 13] = socket & 0xff;
}

describe("Winsock over IPX", () => {
    let s = 0;

    test("socket(AF_IPX, SOCK_DGRAM, NSPROTO_IPX+4) opens a socket that sends packet type 4", () => {
        s = call("socket", AF_IPX, SOCK_DGRAM, NSPROTO_IPX + 4);
        expect(s).toBeGreaterThan(0);
        new DataView(mem.buffer).setInt32(LEN, 4, true);
        expect(call("getsockopt", s, NSPROTO_IPX, IPX_PTYPE, OPT, LEN)).toBe(0);
        expect(new DataView(mem.buffer).getInt32(OPT, true)).toBe(4);
    });

    test("binds a socket number given in network byte order", () => {
        writeSockaddrIpx(ADDR, [0, 0, 0, 0, 0, 0], 0x5000);
        expect(call("bind", s, ADDR, 14)).toBe(0);
        new DataView(mem.buffer).setInt32(LEN, 14, true);
        expect(call("getsockname", s, ADDR, LEN)).toBe(0);
        expect([...mem.subarray(ADDR, ADDR + 14)]).toEqual([
            AF_IPX, 0, 0x0a, 0x4d, 0, 0, 0x02, 0x00, 0x0a, 0x4d, 0x00, 3, 0x50, 0x00,
        ]);
    });

    test("IPX_ADDRESS reports adapter 0 on the room's network with this guest's node", () => {
        const view = new DataView(mem.buffer);
        view.setInt32(LEN, 4, true);
        expect(call("getsockopt", s, NSPROTO_IPX, IPX_MAX_ADAPTER_NUM, OPT, LEN)).toBe(0);
        expect(view.getInt32(OPT, true)).toBe(1);

        view.setInt32(OPT, 0, true);
        view.setInt32(LEN, 24, true);
        expect(call("getsockopt", s, NSPROTO_IPX, IPX_ADDRESS, OPT, LEN)).toBe(0);
        expect([...mem.subarray(OPT + 4, OPT + 14)]).toEqual([0x0a, 0x4d, 0, 0, 0x02, 0x00, 0x0a, 0x4d, 0x00, 3]);
        expect(mem[OPT + 15]).toBe(1);
        expect(view.getInt32(OPT + 16, true)).toBe(1400);

        view.setInt32(OPT, 1, true);
        expect(call("getsockopt", s, NSPROTO_IPX, IPX_ADDRESS, OPT, LEN)).toBe(-1);
    });

    test("a broadcast needs SO_BROADCAST and goes out as an IPX frame to the whole room", () => {
        mem.set([1, 2, 3], BUF);
        writeSockaddrIpx(ADDR, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0x5000);
        expect(call("sendto", s, BUF, 3, 0, ADDR, 14)).toBe(-1);
        expect(lastError).toBe(10013);

        new DataView(mem.buffer).setInt32(OPT, 1, true);
        expect(call("setsockopt", s, SOL_SOCKET, SO_BROADCAST, OPT, 4)).toBe(0);
        expect(call("sendto", s, BUF, 3, 0, ADDR, 14)).toBe(3);

        const frame = new Uint8Array(2048);
        const length = provider.tx.read(frame);
        const header = readNicHeader(frame)!;
        expect(header.proto).toBe(NIC_PROTO_IPX);
        expect(header.dst).toBe(VLAN_BROADCAST_HOST);
        expect(header.dstPort).toBe(0x5000);
        expect(header.srcPort).toBe(0x5000);
        expect(header.flags).toBe(4);
        expect([...frame.subarray(NIC_HEADER_SIZE, length)]).toEqual([1, 2, 3]);
    });

    test("a datagram for a node nobody in the room owns is sent and lost, not refused", () => {
        writeSockaddrIpx(ADDR, [0x00, 0x60, 0x08, 0x12, 0x34, 0x56], 0x5000);
        expect(call("sendto", s, BUF, 3, 0, ADDR, 14)).toBe(3);
        expect(provider.tx.read(new Uint8Array(2048))).toBe(-1);
    });

    test("recvfrom returns the sender as a SOCKADDR_IPX", () => {
        const frame = new Uint8Array(NIC_HEADER_SIZE + 2);
        writeNicHeader(frame, 0, { proto: NIC_PROTO_IPX, src: 7, dst: 3, srcPort: 0x5001, dstPort: 0x5000, flags: 4, seq: 0 });
        frame.set([9, 8], NIC_HEADER_SIZE);
        expect(provider.rx.write(frame)).toBe(true);

        new DataView(mem.buffer).setInt32(LEN, 16, true);
        expect(call("recvfrom", s, SCRATCH, 64, 0, ADDR, LEN)).toBe(2);
        expect([...mem.subarray(SCRATCH, SCRATCH + 2)]).toEqual([9, 8]);
        expect([...mem.subarray(ADDR, ADDR + 14)]).toEqual([
            AF_IPX, 0, 0x0a, 0x4d, 0, 0, 0x02, 0x00, 0x0a, 0x4d, 0x00, 7, 0x50, 0x01,
        ]);
        expect(new DataView(mem.buffer).getInt32(LEN, true)).toBe(14);
    });

    test("SPX is refused with WSAESOCKTNOSUPPORT", () => {
        expect(call("socket", AF_IPX, 5 /* SOCK_SEQPACKET */, 1256)).toBe(-1);
        expect(lastError).toBe(10044);
    });
});
