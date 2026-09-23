/**
 * Virtual NIC contract — the frame format and addressing the emulator's network device uses.
 *
 * BottleShip owns this definition; a network provider loaded from `?net=` must speak it
 * verbatim (see src/net/provider-contract.ts). It is deliberately a *link layer*, not a
 * transport: the provider moves frames between peers and never interprets a payload, so the
 * same device carries Winsock datagrams today and DirectPlay messages later.
 *
 * This module is imported by both the main thread and the emulator worker, so it must not
 * touch DOM or worker-only APIs.
 */

/** Bumped only for an incompatible change; the provider refuses to attach on a mismatch. */
export const NIC_CONTRACT_VERSION = 1;

// ─── Addressing ──────────────────────────────────────────────────────────────

/**
 * Guests live on 10.77.0.0/24. A private Class-A block keeps us clear of the 192.168/172.16
 * ranges games and their config files tend to have real addresses baked into, and the whole
 * room fits in one octet so the host id is also the on-wire peer id.
 */
export const VLAN_PREFIX = 0x0a4d0000;
export const VLAN_NETMASK = 0xffffff00;
export const VLAN_BROADCAST_HOST = 0xff;
export const HOST_UNASSIGNED = 0;

/** Guest-visible IPv4 address (host byte order) for a host octet. */
export function hostToIp(host: number): number {
    return (VLAN_PREFIX | (host & 0xff)) >>> 0;
}

/** Host octet for a guest-supplied address, or null when it is not on our subnet. */
export function ipToHost(ip: number): number | null {
    if (((ip >>> 0) & VLAN_NETMASK) !== VLAN_PREFIX) return null;
    return (ip >>> 0) & 0xff;
}

/**
 * Map any address the guest may aim at the LAN onto a host octet.
 * 255.255.255.255 (INADDR_BROADCAST) and 10.77.0.255 both mean "everyone", which is how these
 * games discover each other; anything else off-subnet is unreachable.
 */
export function resolveDestination(ip: number): number | null {
    const addr = ip >>> 0;
    if (addr === 0xffffffff) return VLAN_BROADCAST_HOST;
    return ipToHost(addr);
}

export function ipToString(ip: number): string {
    return `${(ip >>> 24) & 0xff}.${(ip >>> 16) & 0xff}.${(ip >>> 8) & 0xff}.${ip & 0xff}`;
}

// ─── Frame header ────────────────────────────────────────────────────────────

export const NIC_HEADER_SIZE = 12;
export const NIC_KIND_DATAGRAM = 1;

/** IANA protocol numbers, so guest-visible semantics stay recognisable in a packet dump. */
export const NIC_PROTO_UDP = 17;
export const NIC_PROTO_STREAM = 6;
/**
 * Novell IPX datagrams (IANA 111, IPX-in-IP). The IPX packet type rides in the header's flags
 * byte and the 16-bit IPX socket number in the port fields; the node address is derived from
 * the host octet, so a room is one IPX network.
 */
export const NIC_PROTO_IPX = 111;
/** Reserved for the provider's own peer-to-peer chatter; never reaches the guest. */
export const NIC_PROTO_CONTROL = 0;
/**
 * Echo, answered by the stack rather than by any socket — the same thing every real Windows
 * box does with a ping, and invisible to Winsock, which cannot open a raw socket here.
 * It is what `harness().netPing()` uses to prove two guests can reach each other without
 * involving a game.
 */
export const NIC_PROTO_ICMP = 1;
export const ICMP_ECHO_REPLY = 0;
export const ICMP_ECHO_REQUEST = 8;

/** Stream control bits (connection setup and teardown only — see the note in socket-layer). */
export const NIC_SF_SYN = 0x01;
export const NIC_SF_ACK = 0x02;
export const NIC_SF_FIN = 0x04;
export const NIC_SF_RST = 0x08;
export const NIC_SF_PSH = 0x10;

export interface NicHeader {
    proto: number;
    src: number;
    dst: number;
    srcPort: number;
    dstPort: number;
    flags: number;
    seq: number;
}

/** Ports and seq are little-endian: this is our own link layer, not an on-the-wire IP packet. */
export function writeNicHeader(out: Uint8Array, off: number, h: NicHeader): void {
    out[off] = NIC_KIND_DATAGRAM;
    out[off + 1] = h.proto & 0xff;
    out[off + 2] = h.src & 0xff;
    out[off + 3] = h.dst & 0xff;
    out[off + 4] = h.srcPort & 0xff;
    out[off + 5] = (h.srcPort >>> 8) & 0xff;
    out[off + 6] = h.dstPort & 0xff;
    out[off + 7] = (h.dstPort >>> 8) & 0xff;
    out[off + 8] = h.flags & 0xff;
    out[off + 9] = 64;
    out[off + 10] = h.seq & 0xff;
    out[off + 11] = (h.seq >>> 8) & 0xff;
}

export function readNicHeader(buf: Uint8Array, off = 0): NicHeader | null {
    if (buf.length - off < NIC_HEADER_SIZE) return null;
    if (buf[off] !== NIC_KIND_DATAGRAM) return null;
    return {
        proto: buf[off + 1]!,
        src: buf[off + 2]!,
        dst: buf[off + 3]!,
        srcPort: buf[off + 4]! | (buf[off + 5]! << 8),
        dstPort: buf[off + 6]! | (buf[off + 7]! << 8),
        flags: buf[off + 8]!,
        seq: buf[off + 10]! | (buf[off + 11]! << 8),
    };
}
