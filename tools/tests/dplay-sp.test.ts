/**
 * Unit tests for the DirectPlay TCP/IP service provider (src/worker/modules/dplayx/dplay-sp.ts
 * and dplay-wire.ts).
 *
 * Guests are real NetStacks joined by a simulated switch that forwards by host octet and fans out
 * broadcasts, like the router. That covers the whole SP path — enumeration on the well-known port,
 * join, roster propagation, fragmentation past the MTU — without a browser.
 */
import { describe, expect, test } from "bun:test";
import { NetStack } from "../../src/worker/core/net/net-stack";
import type { FrameSink, NicDevice } from "../../src/worker/core/net/virtual-nic";
import { VLAN_BROADCAST_HOST, hostToIp, type NicHeader } from "../../src/net/nic-contract";
import {
    DP_OK,
    DPENUMSESSIONS_AVAILABLE,
    DPERR_INVALIDPASSWORD,
    DPERR_NONEWPLAYERS,
    DPERR_PENDING,
    DPERR_SESSIONLOST,
    DPID_ALLPLAYERS,
    DPID_SYSMSG,
    DPLAY_ENUM_PORT,
    DPSESSION_JOINDISABLED,
    DPSYS_ADDPLAYERTOGROUP,
    DPSYS_CREATEPLAYERORGROUP,
    DPSYS_DESTROYPLAYERORGROUP,
    DPSYS_SENDCOMPLETE,
    DPSYS_SESSIONLOST,
    DPSYS_SETPLAYERORGROUPDATA,
    DPlayEngine,
    type SessionDesc,
} from "../../src/worker/modules/dplayx/dplay-sp";
import {
    DPSP_HEADER_SIZE,
    DPSP_MSG,
    PACKET_OVERHEAD,
    Reassembler,
    decodeEnumSessions,
    decodeEnumSessionsReply,
    decodePacket,
    encodeEnumSessions,
    encodeEnumSessionsReply,
    fragmentBody,
    isSystemBody,
    parseSpHeader,
    systemCommand,
} from "../../src/worker/modules/dplayx/dplay-wire";

class Switch {
    private ports = new Map<number, TestNic>();
    attach(nic: TestNic): void {
        this.ports.set(nic.localHost, nic);
    }
    detach(host: number): void {
        this.ports.delete(host);
    }
    hosts(): number[] {
        return [...this.ports.keys()];
    }
    forward(from: number, header: NicHeader, payload: Uint8Array): void {
        const stamped: NicHeader = { ...header, src: from };
        if (header.dst === VLAN_BROADCAST_HOST) {
            for (const [host, nic] of this.ports) {
                if (host !== from) nic.inbound.push({ header: stamped, payload: payload.slice() });
            }
            return;
        }
        this.ports.get(header.dst)?.inbound.push({ header: stamped, payload: payload.slice() });
    }
}

class TestNic implements NicDevice {
    inbound: Array<{ header: NicHeader; payload: Uint8Array }> = [];
    linkUp = true;
    mtu = 1400;
    /** Refuse sends to exercise the backlog path. */
    ringFull = false;
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
        return false;
    }
    send(header: NicHeader, payload: Uint8Array): boolean {
        if (!this.linkUp || this.ringFull) return false;
        this.wire.forward(this.localHost, header, payload);
        return true;
    }
    poll(sink: FrameSink, budget = 64): number {
        let n = 0;
        while (n < budget) {
            const f = this.inbound.shift();
            if (!f) break;
            sink(f.header, f.payload);
            n++;
        }
        return n;
    }
}

let clock = 1000;
const now = () => clock;
let seed = 1;
const random = (b: Uint8Array) => {
    for (let i = 0; i < b.length; i++) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        b[i] = seed >>> 24;
    }
};

function guest(wire: Switch, host: number): { nic: TestNic; dp: DPlayEngine } {
    const nic = new TestNic(host, wire);
    return { nic, dp: new DPlayEngine(new NetStack(nic), nic, { now, random }) };
}

const APP = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const NULL_GUID = new Uint8Array(16);

function desc(overrides: Partial<SessionDesc> = {}): SessionDesc {
    return {
        flags: 0, guidInstance: new Uint8Array(16), guidApplication: APP, maxPlayers: 8, currentPlayers: 0,
        name: "Test Game", password: "", user: [11, 22, 33, 44], ...overrides,
    };
}

const noName = { shortName: "", longName: "", hasName: false };
const named = (s: string) => ({ shortName: s, longName: `${s} long`, hasName: true });

/** Host on `a`, `b` discovers it and joins. Returns both engines. */
function hostAndJoin(wire = new Switch()) {
    const a = guest(wire, 1);
    const b = guest(wire, 2);
    expect(a.dp.createSession(desc())).toBe(DP_OK);
    b.dp.pollSessions(APP, "", DPENUMSESSIONS_AVAILABLE);
    a.dp.pump();
    b.dp.pollSessions(APP, "", DPENUMSESSIONS_AVAILABLE);
    const [found] = b.dp.sessions(APP, DPENUMSESSIONS_AVAILABLE);
    expect(found).toBeDefined();
    expect(b.dp.beginJoin(found!.desc.guidInstance, "")).toBe(DP_OK);
    a.dp.pump();
    expect(b.dp.pollJoin()).toBe(DP_OK);
    return { wire, a, b };
}

function drainAll(dp: DPlayEngine) {
    const out = [];
    for (;;) {
        const i = dp.findMessage(null, null);
        if (i < 0) return out;
        out.push(dp.message(i)!);
        dp.takeMessage(i);
    }
}

describe("wire format", () => {
    const reply = { host: 3, port: 2300 };

    test("EnumSessions request carries the MS-DPDX header and body", () => {
        const dg = encodeEnumSessions(reply, hostToIp(3), { guidApplication: APP, flags: 0x41, password: "pw" });
        const sp = parseSpHeader(dg)!;
        expect(sp.replyPort).toBe(2300);
        expect(sp.replyIp).toBe(hostToIp(3));
        expect(isSystemBody(sp.body)).toBe(true);
        expect(systemCommand(sp.body)).toBe(DPSP_MSG.ENUMSESSIONS);
        // size|token word: low 20 bits are the datagram size, high 12 bits 0xFAB.
        const word = new DataView(dg.buffer).getUint32(0, true);
        expect(word & 0xfffff).toBe(dg.length);
        expect(word >>> 20).toBe(0xfab);
        const req = decodeEnumSessions(sp.body);
        expect([...req.guidApplication]).toEqual([...APP]);
        expect(req.flags).toBe(0x41);
        expect(req.password).toBe("pw");
    });

    test("EnumSessionsReply round-trips DPSESSIONDESC2 and the Unicode name", () => {
        const d = desc({ name: "Ünïcode room", flags: 0x4, currentPlayers: 3 });
        const sp = parseSpHeader(encodeEnumSessionsReply(reply, hostToIp(3), d))!;
        expect(systemCommand(sp.body)).toBe(DPSP_MSG.ENUMSESSIONSREPLY);
        // NameOffset points past signature(8) + DPSESSIONDESC2(80) + the offset field itself.
        expect(new DataView(sp.body.buffer, sp.body.byteOffset).getUint32(88, true)).toBe(92);
        const back = decodeEnumSessionsReply(sp.body);
        expect(back.name).toBe("Ünïcode room");
        expect(back.flags).toBe(0x4);
        expect(back.currentPlayers).toBe(3);
        expect(back.user).toEqual([11, 22, 33, 44]);
    });

    test("rejects datagrams whose size word does not match", () => {
        const dg = encodeEnumSessions(reply, 0, { guidApplication: APP, flags: 0, password: "" });
        expect(parseSpHeader(dg.subarray(0, dg.length - 1))).toBeNull();
        expect(parseSpHeader(new Uint8Array(8))).toBeNull();
    });

    test("fragments bodies past the MTU and reassembles them in any order", () => {
        const body = new Uint8Array(5000).map((_, i) => (i * 7) & 0xff);
        const guid = new Uint8Array(16).fill(0xab);
        const frags = fragmentBody(reply, 0, body, 1400, guid);
        expect(frags.length).toBe(Math.ceil(5000 / (1400 - PACKET_OVERHEAD)));
        for (const f of frags) expect(f.length).toBeLessThanOrEqual(1400);
        const r = new Reassembler();
        let whole: Uint8Array | null = null;
        for (const f of [...frags].reverse()) {
            const sp = parseSpHeader(f)!;
            expect(systemCommand(sp.body)).toBe(DPSP_MSG.PACKET);
            whole = r.add(3, decodePacket(sp.body), 0) ?? whole;
        }
        expect(whole).not.toBeNull();
        expect([...whole!]).toEqual([...body]);
        expect(r.size).toBe(0);
    });

    test("a body that fits is sent whole", () => {
        const body = new Uint8Array(1400 - DPSP_HEADER_SIZE);
        expect(fragmentBody(reply, 0, body, 1400, new Uint8Array(16)).length).toBe(1);
        expect(fragmentBody(reply, 0, new Uint8Array(body.length + 1), 1400, new Uint8Array(16)).length).toBe(2);
    });

    test("a missing fragment never completes the message", () => {
        const frags = fragmentBody(reply, 0, new Uint8Array(3000), 1400, new Uint8Array(16).fill(1));
        const r = new Reassembler();
        for (const f of frags.slice(1)) expect(r.add(3, decodePacket(parseSpHeader(f)!.body), 0)).toBeNull();
        r.dropSender(3);
        expect(r.size).toBe(0);
    });
});

describe("session enumeration", () => {
    test("a host answers a broadcast request on the well-known port", () => {
        const wire = new Switch();
        const a = guest(wire, 1);
        const b = guest(wire, 2);
        a.dp.createSession(desc({ name: "LAN party" }));
        b.dp.pollSessions(APP, "", DPENUMSESSIONS_AVAILABLE);
        // The request is a broadcast to the enum port.
        expect(a.nic.inbound.some((f) => f.header.dstPort === DPLAY_ENUM_PORT && f.header.dst === VLAN_BROADCAST_HOST)).toBe(true);
        a.dp.pump();
        b.dp.pump();
        const sessions = b.dp.sessions(APP, DPENUMSESSIONS_AVAILABLE);
        expect(sessions.length).toBe(1);
        expect(sessions[0]!.desc.name).toBe("LAN party");
        expect(sessions[0]!.host).toBe(1);
        expect(sessions[0]!.port).toBe(2300);
    });

    test("filters by application GUID; the null GUID matches any", () => {
        const wire = new Switch();
        const a = guest(wire, 1);
        const b = guest(wire, 2);
        a.dp.createSession(desc());
        const other = new Uint8Array(16).fill(9);
        b.dp.pollSessions(other, "", 0);
        a.dp.pump();
        b.dp.pump();
        expect(b.dp.sessions(other, 0).length).toBe(0);
        b.dp.pollSessions(NULL_GUID, "", 0);
        a.dp.pump();
        b.dp.pump();
        expect(b.dp.sessions(NULL_GUID, 0).length).toBe(1);
    });

    test("re-polling does not flood: requests are rate limited", () => {
        const wire = new Switch();
        const a = guest(wire, 1);
        const b = guest(wire, 2);
        a.dp.createSession(desc());
        b.dp.pollSessions(APP, "", 0);
        b.dp.pollSessions(APP, "", 0);
        b.dp.pollSessions(APP, "", 0);
        expect(a.nic.inbound.length).toBe(1);
        clock += 1500;
        b.dp.pollSessions(APP, "", 0);
        expect(a.nic.inbound.length).toBe(2);
    });

    test("stale sessions age out of the cache", () => {
        const { a, b } = hostAndJoin();
        void a;
        clock += 60_000;
        expect(b.dp.sessions(APP, 0).length).toBe(0);
    });

    test("a join-disabled session is hidden from AVAILABLE enumeration", () => {
        const wire = new Switch();
        const a = guest(wire, 1);
        const b = guest(wire, 2);
        a.dp.createSession(desc({ flags: DPSESSION_JOINDISABLED }));
        b.dp.pollSessions(APP, "", DPENUMSESSIONS_AVAILABLE);
        a.dp.pump();
        b.dp.pump();
        expect(b.dp.sessions(APP, DPENUMSESSIONS_AVAILABLE).length).toBe(0);
    });
});

describe("joining", () => {
    test("host and joiner see each other's players with system messages", () => {
        const { a, b } = hostAndJoin();
        const host = a.dp.createPlayer(named("Alice"), new Uint8Array([1]), 0);
        expect(host.hr).toBe(DP_OK);
        b.dp.pump();
        const join = b.dp.createPlayer(named("Bob"), new Uint8Array(0), 0);
        expect(join.hr).toBe(DP_OK);
        expect(join.id).not.toBe(host.id);
        a.dp.pump();

        const atHost = drainAll(a.dp);
        const created = atHost.find((m) => m.sys?.type === DPSYS_CREATEPLAYERORGROUP);
        expect(created).toBeDefined();
        expect(created!.from).toBe(DPID_SYSMSG);
        expect(created!.to).toBe(host.id);
        if (created!.sys?.type === DPSYS_CREATEPLAYERORGROUP) {
            expect(created!.sys.entity.shortName).toBe("Bob");
            expect(created!.sys.currentPlayers).toBe(2);
        }
        expect(b.dp.entity(host.id)?.shortName).toBe("Alice");
        expect(a.dp.sessionDesc!.currentPlayers).toBe(2);
        expect(b.dp.sessionDesc!.currentPlayers).toBe(2);
    });

    test("wrong password and closed sessions are refused", () => {
        const wire = new Switch();
        const a = guest(wire, 1);
        const b = guest(wire, 2);
        a.dp.createSession(desc({ password: "secret" }));
        b.dp.pollSessions(APP, "", 0x2 | 0x40);
        a.dp.pump();
        b.dp.pump();
        const [s] = b.dp.sessions(APP, 0x2);
        expect(b.dp.beginJoin(s!.desc.guidInstance, "nope")).toBe(DP_OK);
        a.dp.pump();
        expect(b.dp.pollJoin()).toBe(DPERR_INVALIDPASSWORD);

        a.dp.setSessionDesc({ ...a.dp.sessionDesc!, password: "", flags: DPSESSION_JOINDISABLED });
        expect(b.dp.beginJoin(s!.desc.guidInstance, "")).toBe(DP_OK);
        a.dp.pump();
        expect(b.dp.pollJoin()).toBe(DPERR_NONEWPLAYERS);
    });

    test("a third guest joining is announced to existing peers", () => {
        const { wire, a, b } = hostAndJoin();
        const c = guest(wire, 3);
        const pa = a.dp.createPlayer(named("A"), new Uint8Array(0), 0).id;
        b.dp.pump();
        c.dp.pollSessions(APP, "", 0);
        a.dp.pump();
        c.dp.pollSessions(APP, "", 0);
        const [s] = c.dp.sessions(APP, 0);
        c.dp.beginJoin(s!.desc.guidInstance, "");
        a.dp.pump();
        expect(c.dp.pollJoin()).toBe(DP_OK);
        b.dp.pump();
        const pc = c.dp.createPlayer(named("C"), new Uint8Array(0), 0).id;
        a.dp.pump();
        b.dp.pump();
        expect(b.dp.entity(pc)?.shortName).toBe("C");
        expect(c.dp.entity(pa)?.shortName).toBe("A");
        // b → c goes direct, not through the host.
        const pb = b.dp.createPlayer(named("B"), new Uint8Array(0), 0).id;
        c.dp.pump();
        expect(c.dp.entity(pb)?.shortName).toBe("B");
    });

    test("a join retransmits until the host answers, then times out", () => {
        const wire = new Switch();
        const a = guest(wire, 1);
        const b = guest(wire, 2);
        a.dp.createSession(desc());
        b.dp.pollSessions(APP, "", 0);
        a.dp.pump();
        b.dp.pump();
        const [s] = b.dp.sessions(APP, 0);
        wire.detach(1);
        b.dp.beginJoin(s!.desc.guidInstance, "");
        expect(b.dp.pollJoin()).toBeNull();
        clock += 20_000;
        expect(b.dp.pollJoin()).not.toBe(DP_OK);
        expect(b.dp.isOpen).toBe(false);
    });
});

describe("messages", () => {
    test("Send/Receive between guests, including payloads past the MTU", () => {
        const { a, b } = hostAndJoin();
        const pa = a.dp.createPlayer(named("A"), new Uint8Array(0), 0).id;
        b.dp.pump();
        const pb = b.dp.createPlayer(named("B"), new Uint8Array(0), 0).id;
        a.dp.pump();
        drainAll(a.dp);
        drainAll(b.dp);

        const big = new Uint8Array(6000).map((_, i) => (i * 31 + 7) & 0xff);
        expect(a.dp.send(pa, pb, big)).toBe(DP_OK);
        expect(a.dp.send(pa, pb, new Uint8Array([42]))).toBe(DP_OK);
        expect(b.dp.messageCount(pb)).toBe(2);
        const i = b.dp.findMessage(null, null);
        const m = b.dp.message(i)!;
        expect(m.from).toBe(pa);
        expect(m.to).toBe(pb);
        expect([...m.data!]).toEqual([...big]);
        b.dp.takeMessage(i);
        expect([...b.dp.message(b.dp.findMessage(pa, pb))!.data!]).toEqual([42]);
    });

    test("DPID_ALLPLAYERS reaches every player but the sender, local ones included", () => {
        const { a, b } = hostAndJoin();
        const pa = a.dp.createPlayer(named("A"), new Uint8Array(0), 0).id;
        const pa2 = a.dp.createPlayer(named("A2"), new Uint8Array(0), 0).id;
        b.dp.pump();
        const pb = b.dp.createPlayer(named("B"), new Uint8Array(0), 0).id;
        a.dp.pump();
        drainAll(a.dp);
        drainAll(b.dp);
        a.dp.send(pa, DPID_ALLPLAYERS, new Uint8Array([7]));
        expect(drainAll(b.dp).map((m) => m.to)).toEqual([pb]);
        expect(drainAll(a.dp).map((m) => m.to)).toEqual([pa2]);
    });

    test("group sends reach members only; membership changes propagate", () => {
        const { a, b } = hostAndJoin();
        const pa = a.dp.createPlayer(named("A"), new Uint8Array(0), 0).id;
        b.dp.pump();
        const pb = b.dp.createPlayer(named("B"), new Uint8Array(0), 0).id;
        a.dp.pump();
        const g = a.dp.createGroup(named("team"), new Uint8Array(0), 0).id;
        expect(a.dp.changeMembership(g, pb, true)).toBe(DP_OK);
        b.dp.pump();
        const sys = drainAll(b.dp).map((m) => m.sys?.type);
        expect(sys).toContain(DPSYS_ADDPLAYERTOGROUP);
        a.dp.send(pa, g, new Uint8Array([9]));
        const got = drainAll(b.dp);
        expect(got.length).toBe(1);
        expect(got[0]!.to).toBe(pb);
    });

    test("remote player data changes arrive as DPSYS_SETPLAYERORGROUPDATA", () => {
        const { a, b } = hostAndJoin();
        const pa = a.dp.createPlayer(named("A"), new Uint8Array(0), 0).id;
        b.dp.createPlayer(named("B"), new Uint8Array(0), 0);
        b.dp.pump();
        drainAll(b.dp);
        a.dp.setData(pa, false, new Uint8Array([5, 6]), false);
        b.dp.pump();
        const m = drainAll(b.dp).find((x) => x.sys?.type === DPSYS_SETPLAYERORGROUPDATA);
        expect(m).toBeDefined();
        expect([...b.dp.entity(pa)!.remoteData]).toEqual([5, 6]);
    });

    test("async sends report completion with DPSYS_SENDCOMPLETE", () => {
        const { a } = hostAndJoin();
        const pa = a.dp.createPlayer(named("A"), new Uint8Array(0), 0).id;
        const r = a.dp.sendAsync(pa, DPID_ALLPLAYERS, new Uint8Array([1]), { flags: 0x200, priority: 0, timeout: 0, context: 0x1234, notify: true });
        expect(r.hr).toBe(DPERR_PENDING);
        const done = drainAll(a.dp).find((m) => m.sys?.type === DPSYS_SENDCOMPLETE);
        expect(done?.to).toBe(pa);
    });

    test("a full transmit ring defers datagrams instead of dropping them", () => {
        const { a, b } = hostAndJoin();
        const pa = a.dp.createPlayer(named("A"), new Uint8Array(0), 0).id;
        b.dp.pump();
        const pb = b.dp.createPlayer(named("B"), new Uint8Array(0), 0).id;
        a.dp.pump();
        drainAll(b.dp);
        a.nic.ringFull = true;
        a.dp.send(pa, pb, new Uint8Array(3000));
        a.dp.send(pa, pb, new Uint8Array([1]));
        expect(a.dp.pendingSends.count).toBeGreaterThan(0);
        a.nic.ringFull = false;
        a.dp.pump();
        expect(a.dp.pendingSends.count).toBe(0);
        const got = drainAll(b.dp);
        expect(got.map((m) => m.data!.length)).toEqual([3000, 1]);
    });
});

describe("leaving", () => {
    test("a joiner's Close destroys its players at the host", () => {
        const { a, b } = hostAndJoin();
        a.dp.createPlayer(named("A"), new Uint8Array(0), 0);
        const pb = b.dp.createPlayer(named("B"), new Uint8Array(0), 0).id;
        a.dp.pump();
        drainAll(a.dp);
        b.dp.close();
        a.dp.pump();
        const destroyed = drainAll(a.dp).filter((m) => m.sys?.type === DPSYS_DESTROYPLAYERORGROUP);
        expect(destroyed.length).toBe(1);
        expect(a.dp.entity(pb)).toBeUndefined();
        expect(a.dp.sessionDesc!.currentPlayers).toBe(1);
    });

    test("the host vanishing from the room loses the session", () => {
        const { wire, a, b } = hostAndJoin();
        const pa = a.dp.createPlayer(named("A"), new Uint8Array(0), 0).id;
        b.dp.pump();
        const pb = b.dp.createPlayer(named("B"), new Uint8Array(0), 0).id;
        b.dp.pump();
        wire.detach(1);
        b.dp.pump();
        const types = drainAll(b.dp).map((m) => m.sys?.type);
        expect(types).toContain(DPSYS_DESTROYPLAYERORGROUP);
        expect(types[types.length - 1]).toBe(DPSYS_SESSIONLOST);
        expect(b.dp.entity(pa)).toBeUndefined();
        expect(b.dp.send(pb, DPID_ALLPLAYERS, new Uint8Array([1]))).toBe(DPERR_SESSIONLOST);
    });

    test("a host can host again after Close", () => {
        const { a } = hostAndJoin();
        a.dp.close();
        expect(a.dp.isOpen).toBe(false);
        expect(a.dp.createSession(desc())).toBe(DP_OK);
        expect(a.dp.createPlayer(noName, new Uint8Array(0), 0).hr).toBe(DP_OK);
    });
});
