/**
 * Unit tests for the virtual NIC's SharedArrayBuffer rings (src/net/nic-ring.ts).
 *
 * The ring is the seam between the emulator worker and whatever network provider is attached,
 * and it is lock-free in both directions: a framing bug here surfaces as corrupted packets
 * inside a guest's network stack, which is about the worst place to debug one. The wrap path
 * gets the most attention because it is the one the tests have to force — in normal play the
 * ring wraps only after minutes of traffic.
 */
import { describe, expect, test } from "bun:test";
import {
    CTRL_LINK,
    CTRL_LOCAL_HOST,
    CTRL_RX_DROPS,
    CTRL_RX_FRAMES,
    createNicBuffer,
    isPeerPresent,
    listPeers,
    openGuestEndpoint,
    openHostEndpoint,
    setPeerPresence,
} from "../../src/net/nic-ring";
import {
    NIC_HEADER_SIZE,
    NIC_PROTO_UDP,
    readNicHeader,
    writeNicHeader,
    hostToIp,
    ipToHost,
    ipToString,
    resolveDestination,
    VLAN_BROADCAST_HOST,
} from "../../src/net/nic-contract";

function frame(length: number, fill = 0xab): Uint8Array {
    const bytes = new Uint8Array(length);
    bytes.fill(fill);
    return bytes;
}

describe("NicRing framing", () => {
    test("round-trips frames in order", () => {
        const sab = createNicBuffer(4096);
        const host = openHostEndpoint(sab);
        const guest = openGuestEndpoint(sab);
        const scratch = new Uint8Array(2048);

        for (let i = 1; i <= 5; i++) expect(host.rx.write(frame(i * 16, i))).toBe(true);
        for (let i = 1; i <= 5; i++) {
            const length = guest.rx.read(scratch);
            expect(length).toBe(i * 16);
            expect(scratch[0]).toBe(i);
            expect(scratch[length - 1]).toBe(i);
        }
        expect(guest.rx.read(scratch)).toBe(-1);
    });

    test("reports emptiness before and after a drain", () => {
        const sab = createNicBuffer(1024);
        const host = openHostEndpoint(sab);
        const guest = openGuestEndpoint(sab);
        expect(guest.rx.readable).toBe(false);
        host.rx.write(frame(10));
        expect(guest.rx.readable).toBe(true);
        guest.rx.read(new Uint8Array(64));
        expect(guest.rx.readable).toBe(false);
    });

    test("handles unaligned frame lengths without corrupting the next record", () => {
        const sab = createNicBuffer(1024);
        const host = openHostEndpoint(sab);
        const guest = openGuestEndpoint(sab);
        const scratch = new Uint8Array(256);

        for (const length of [1, 2, 3, 5, 7, 13, 17]) {
            expect(host.rx.write(frame(length, length))).toBe(true);
        }
        for (const length of [1, 2, 3, 5, 7, 13, 17]) {
            expect(guest.rx.read(scratch)).toBe(length);
            expect(scratch[length - 1]).toBe(length);
        }
    });

    test("wraps around the end of the ring many times without losing a byte", () => {
        const sab = createNicBuffer(1024);
        const host = openHostEndpoint(sab);
        const guest = openGuestEndpoint(sab);
        const scratch = new Uint8Array(512);

        // 200 round trips through a 1 KB ring forces the wrap path repeatedly.
        for (let i = 0; i < 200; i++) {
            const length = 100 + (i % 37);
            expect(host.rx.write(frame(length, i & 0xff))).toBe(true);
            expect(guest.rx.read(scratch)).toBe(length);
            expect(scratch[0]).toBe(i & 0xff);
            expect(scratch[length - 1]).toBe(i & 0xff);
        }
    });

    test("interleaves a partially drained ring across the wrap point", () => {
        const sab = createNicBuffer(1024);
        const host = openHostEndpoint(sab);
        const guest = openGuestEndpoint(sab);
        const scratch = new Uint8Array(512);
        let written = 0;
        let read = 0;

        for (let round = 0; round < 100; round++) {
            for (let i = 0; i < 3 && host.rx.write(frame(80, written & 0xff)); i++) written++;
            for (let i = 0; i < 2; i++) {
                const length = guest.rx.read(scratch);
                if (length < 0) break;
                expect(length).toBe(80);
                expect(scratch[0]).toBe(read & 0xff);
                read++;
            }
        }
        while (guest.rx.read(scratch) >= 0) read++;
        expect(read).toBe(written);
    });

    test("drops rather than overwrites when the ring is full, and recovers after a drain", () => {
        const sab = createNicBuffer(1024);
        const host = openHostEndpoint(sab);
        const guest = openGuestEndpoint(sab);

        let accepted = 0;
        while (host.rx.write(frame(200))) accepted++;
        expect(accepted).toBeGreaterThan(0);
        expect(host.ctrl[CTRL_RX_DROPS]).toBeGreaterThan(0);

        // Everything that was accepted is still intact — a full ring must not corrupt.
        const scratch = new Uint8Array(512);
        for (let i = 0; i < accepted; i++) expect(guest.rx.read(scratch)).toBe(200);
        expect(guest.rx.read(scratch)).toBe(-1);
        expect(host.rx.write(frame(200))).toBe(true);
    });

    test("refuses a frame larger than the ring itself", () => {
        const sab = createNicBuffer(1024);
        const host = openHostEndpoint(sab);
        expect(host.rx.write(frame(4096))).toBe(false);
        expect(host.rx.write(new Uint8Array(0))).toBe(false);
    });

    test("skips a frame too large for the reader's buffer instead of wedging the ring", () => {
        const sab = createNicBuffer(4096);
        const host = openHostEndpoint(sab);
        const guest = openGuestEndpoint(sab);

        host.rx.write(frame(900, 1));
        host.rx.write(frame(16, 2));
        const small = new Uint8Array(64);
        expect(guest.rx.read(small)).toBe(-1);   // oversized record, consumed and counted
        expect(guest.rx.read(small)).toBe(16);   // the ring keeps flowing
        expect(small[0]).toBe(2);
    });

    test("counts frames written for the diagnostics overlay", () => {
        const sab = createNicBuffer(4096);
        const host = openHostEndpoint(sab);
        host.rx.write(frame(32));
        host.rx.write(frame(32));
        expect(host.ctrl[CTRL_RX_FRAMES]).toBe(2);
    });

    test("carries the two directions independently", () => {
        const sab = createNicBuffer(2048);
        const host = openHostEndpoint(sab);
        const guest = openGuestEndpoint(sab);
        const scratch = new Uint8Array(256);

        guest.tx.write(frame(24, 0x11));
        host.rx.write(frame(48, 0x22));

        expect(host.tx.read(scratch)).toBe(24);
        expect(scratch[0]).toBe(0x11);
        expect(guest.rx.read(scratch)).toBe(48);
        expect(scratch[0]).toBe(0x22);
    });

    test("rejects a buffer that is not a NIC buffer", () => {
        expect(() => openGuestEndpoint(new SharedArrayBuffer(4096))).toThrow(/not a NIC buffer/);
    });

    test("shares control fields between both ends", () => {
        const sab = createNicBuffer(1024);
        const host = openHostEndpoint(sab);
        const guest = openGuestEndpoint(sab);
        Atomics.store(host.ctrl, CTRL_LINK, 1);
        Atomics.store(host.ctrl, CTRL_LOCAL_HOST, 7);
        expect(Atomics.load(guest.ctrl, CTRL_LINK)).toBe(1);
        expect(Atomics.load(guest.ctrl, CTRL_LOCAL_HOST)).toBe(7);
    });
});

describe("peer presence bitmap", () => {
    test("records and lists hosts across word boundaries", () => {
        const sab = createNicBuffer(1024);
        const ctrl = openHostEndpoint(sab).ctrl;
        setPeerPresence(ctrl, [1, 31, 32, 200, 254]);
        expect(listPeers(ctrl)).toEqual([1, 31, 32, 200, 254]);
        expect(isPeerPresent(ctrl, 32)).toBe(true);
        expect(isPeerPresent(ctrl, 33)).toBe(false);
    });

    test("replaces the whole set, so a departed peer disappears", () => {
        const sab = createNicBuffer(1024);
        const ctrl = openHostEndpoint(sab).ctrl;
        setPeerPresence(ctrl, [1, 2, 3]);
        setPeerPresence(ctrl, [2]);
        expect(listPeers(ctrl)).toEqual([2]);
    });
});

describe("NIC header and addressing", () => {
    test("round-trips every header field", () => {
        const buf = new Uint8Array(NIC_HEADER_SIZE);
        const header = { proto: NIC_PROTO_UDP, src: 3, dst: 255, srcPort: 47624, dstPort: 65535, flags: 0x11, seq: 4097 };
        writeNicHeader(buf, 0, header);
        expect(readNicHeader(buf)).toEqual(header);
    });

    test("maps the guest's LAN addresses onto host octets", () => {
        expect(ipToString(hostToIp(9))).toBe("10.77.0.9");
        expect(ipToHost(hostToIp(9))).toBe(9);
        expect(ipToHost(0xc0a80001)).toBeNull();
    });

    test("treats INADDR_BROADCAST and the subnet broadcast alike", () => {
        expect(resolveDestination(0xffffffff)).toBe(VLAN_BROADCAST_HOST);
        expect(resolveDestination(hostToIp(255))).toBe(VLAN_BROADCAST_HOST);
        expect(resolveDestination(0x0a000001)).toBeNull(); // 10.0.0.1 — off our subnet
    });
});
