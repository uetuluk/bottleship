/**
 * SharedArrayBuffer transport between the emulator worker's virtual NIC and the host-side
 * network provider. One SAB carries a control block plus two single-producer/single-consumer
 * byte rings: RX (host → guest) and TX (guest → host).
 *
 * A ring rather than postMessage because the guest side runs inside the x86 execution loop:
 * a socket call must be able to take a packet and return within the same thunk, with no
 * await and no allocation. Frames are copied on the way in and out — SAB-backed views cannot
 * be handed to WebSocket.send or RTCDataChannel.send.
 *
 * Imported by both the main thread and the worker, so no DOM or worker-only APIs here.
 */

import { NIC_CONTRACT_VERSION } from "./nic-contract";

/** "BSNI" — checked by both ends so a stale or foreign buffer never gets interpreted. */
export const NIC_MAGIC = 0x42534e49;

// ─── Control block (Int32Array element indices) ──────────────────────────────

export const CTRL_MAGIC = 0;
export const CTRL_VERSION = 1;
/** 0 = link down (no room joined), 1 = link up. */
export const CTRL_LINK = 2;
/** Our host octet; the guest's address is 10.77.0.<this>. */
export const CTRL_LOCAL_HOST = 3;
export const CTRL_MTU = 4;
export const CTRL_RX_OFFSET = 5;
export const CTRL_RX_CAPACITY = 6;
export const CTRL_TX_OFFSET = 7;
export const CTRL_TX_CAPACITY = 8;
export const CTRL_RX_HEAD = 9;
export const CTRL_RX_TAIL = 10;
export const CTRL_TX_HEAD = 11;
export const CTRL_TX_TAIL = 12;
export const CTRL_RX_DROPS = 13;
export const CTRL_TX_DROPS = 14;
export const CTRL_RX_FRAMES = 15;
export const CTRL_TX_FRAMES = 16;
/**
 * Incremented whenever the link comes up with a new identity. The guest side compares it and
 * resets its socket state, because a reconnect that changed our address invalidates every
 * connection the game had open.
 */
export const CTRL_EPOCH = 17;
/** Host presence bitmap, 8 words covering octets 0..255 (index 24 holds 0..31). */
export const CTRL_PEERS = 24;
export const CTRL_PEERS_WORDS = 8;
export const CTRL_WORDS = 64;

const CONTROL_BYTES = CTRL_WORDS * 4;
/** 128 KB per direction: ~90 full-MTU frames in flight, far more than a frame's worth. */
export const DEFAULT_RING_CAPACITY = 128 * 1024;
/** A record is a 4-byte length followed by the frame, padded so every record stays aligned. */
const RECORD_HEADER = 4;
/** A zero length is impossible for a real frame, so it marks "skip to the start of the ring". */
const WRAP_MARKER = 0;

function align4(n: number): number {
    return (n + 3) & ~3;
}

export function createNicBuffer(capacity = DEFAULT_RING_CAPACITY, mtu = 1400): SharedArrayBuffer {
    const ringBytes = align4(capacity);
    const sab = new SharedArrayBuffer(CONTROL_BYTES + ringBytes * 2);
    const ctrl = new Int32Array(sab, 0, CTRL_WORDS);
    ctrl[CTRL_MAGIC] = NIC_MAGIC;
    ctrl[CTRL_VERSION] = NIC_CONTRACT_VERSION;
    ctrl[CTRL_MTU] = mtu;
    ctrl[CTRL_RX_OFFSET] = CONTROL_BYTES;
    ctrl[CTRL_RX_CAPACITY] = ringBytes;
    ctrl[CTRL_TX_OFFSET] = CONTROL_BYTES + ringBytes;
    ctrl[CTRL_TX_CAPACITY] = ringBytes;
    return sab;
}

/**
 * One direction of the pair. Exactly one thread may call `write` and exactly one may call
 * `read`; the head/tail pair is the only synchronisation, and Atomics ordering makes the frame
 * bytes visible before the head that publishes them.
 */
export class NicRing {
    private readonly bytes: Uint8Array;
    private readonly view: DataView;

    constructor(
        private readonly ctrl: Int32Array,
        sab: SharedArrayBuffer,
        private readonly offset: number,
        private readonly capacity: number,
        private readonly headIndex: number,
        private readonly tailIndex: number,
        private readonly dropIndex: number,
        private readonly frameIndex: number,
    ) {
        this.bytes = new Uint8Array(sab, offset, capacity);
        this.view = new DataView(sab, offset, capacity);
    }

    /** Bytes currently occupied by unread records. */
    private used(head: number, tail: number): number {
        return head >= tail ? head - tail : this.capacity - tail + head;
    }

    /**
     * Copy one frame in. Returns false when the ring is full — a dropped frame, which is the
     * honest outcome for a datagram device under overload and what the guest's protocol
     * already has to tolerate.
     */
    write(frame: Uint8Array): boolean {
        const need = RECORD_HEADER + align4(frame.length);
        if (frame.length === 0 || need > this.capacity) return this.drop();

        let head = Atomics.load(this.ctrl, this.headIndex);
        const tail = Atomics.load(this.ctrl, this.tailIndex);
        // One record slot is always left free so a full ring never looks like an empty one.
        let free = this.capacity - this.used(head, tail) - RECORD_HEADER;

        const toEnd = this.capacity - head;
        if (toEnd < need) {
            // The slack at the end is skipped wholesale, so it has to be affordable too.
            if (free < toEnd + need) return this.drop();
            this.view.setUint32(head, WRAP_MARKER, true);
            free -= toEnd;
            head = 0;
        }
        if (free < need) return this.drop();

        this.view.setUint32(head, frame.length, true);
        this.bytes.set(frame, head + RECORD_HEADER);
        Atomics.store(this.ctrl, this.headIndex, (head + need) % this.capacity);
        Atomics.add(this.ctrl, this.frameIndex, 1);
        // Lets a consumer park on the head with Atomics.wait/waitAsync instead of polling on
        // a timer, which is the difference between a frame of latency and none.
        Atomics.notify(this.ctrl, this.headIndex);
        return true;
    }

    /** True when at least one record is waiting; cheap enough to call from a polling loop. */
    get readable(): boolean {
        return Atomics.load(this.ctrl, this.headIndex) !== Atomics.load(this.ctrl, this.tailIndex);
    }

    /**
     * Copy the next frame into `into`, returning its length, or -1 when the ring is empty.
     * A frame too large for `into` is consumed and counted as a drop rather than wedging the
     * ring behind a record nobody can take.
     */
    read(into: Uint8Array): number {
        let tail = Atomics.load(this.ctrl, this.tailIndex);
        const head = Atomics.load(this.ctrl, this.headIndex);
        if (tail === head) return -1;

        let length = this.view.getUint32(tail, true);
        if (length === WRAP_MARKER) {
            tail = 0;
            if (tail === head) {
                Atomics.store(this.ctrl, this.tailIndex, tail);
                return -1;
            }
            length = this.view.getUint32(tail, true);
        }

        const next = (tail + RECORD_HEADER + align4(length)) % this.capacity;
        if (length > into.length || length > this.capacity - RECORD_HEADER) {
            Atomics.store(this.ctrl, this.tailIndex, next);
            Atomics.add(this.ctrl, this.dropIndex, 1);
            return -1;
        }

        into.set(this.bytes.subarray(tail + RECORD_HEADER, tail + RECORD_HEADER + length));
        Atomics.store(this.ctrl, this.tailIndex, next);
        return length;
    }

    private drop(): boolean {
        Atomics.add(this.ctrl, this.dropIndex, 1);
        return false;
    }
}

/** Both rings plus the control block, from one end's point of view. */
export interface NicEndpoint {
    ctrl: Int32Array;
    rx: NicRing;
    tx: NicRing;
    mtu: number;
}

function endpoint(sab: SharedArrayBuffer): NicEndpoint {
    const ctrl = new Int32Array(sab, 0, CTRL_WORDS);
    if (ctrl[CTRL_MAGIC] !== NIC_MAGIC) throw new Error("net: shared buffer is not a NIC buffer");
    if (ctrl[CTRL_VERSION] !== NIC_CONTRACT_VERSION) {
        throw new Error(`net: NIC contract v${ctrl[CTRL_VERSION]} does not match v${NIC_CONTRACT_VERSION}`);
    }
    const rx = new NicRing(ctrl, sab, ctrl[CTRL_RX_OFFSET]!, ctrl[CTRL_RX_CAPACITY]!,
        CTRL_RX_HEAD, CTRL_RX_TAIL, CTRL_RX_DROPS, CTRL_RX_FRAMES);
    const tx = new NicRing(ctrl, sab, ctrl[CTRL_TX_OFFSET]!, ctrl[CTRL_TX_CAPACITY]!,
        CTRL_TX_HEAD, CTRL_TX_TAIL, CTRL_TX_DROPS, CTRL_TX_FRAMES);
    return { ctrl, rx, tx, mtu: ctrl[CTRL_MTU]! };
}

/** Guest side: reads RX, writes TX. */
export function openGuestEndpoint(sab: SharedArrayBuffer): NicEndpoint {
    return endpoint(sab);
}

/** Host side: writes RX, reads TX. Same rings, opposite roles. */
export function openHostEndpoint(sab: SharedArrayBuffer): NicEndpoint {
    return endpoint(sab);
}

// ─── Peer bitmap ─────────────────────────────────────────────────────────────

export function setPeerPresence(ctrl: Int32Array, hosts: number[]): void {
    const words = new Array<number>(CTRL_PEERS_WORDS).fill(0);
    for (const host of hosts) {
        const octet = host & 0xff;
        words[octet >>> 5] = (words[octet >>> 5]! | (1 << (octet & 31))) >>> 0;
    }
    for (let i = 0; i < CTRL_PEERS_WORDS; i++) Atomics.store(ctrl, CTRL_PEERS + i, words[i]! | 0);
}

export function isPeerPresent(ctrl: Int32Array, host: number): boolean {
    const octet = host & 0xff;
    return (Atomics.load(ctrl, CTRL_PEERS + (octet >>> 5)) & (1 << (octet & 31))) !== 0;
}

export function listPeers(ctrl: Int32Array): number[] {
    const hosts: number[] = [];
    for (let word = 0; word < CTRL_PEERS_WORDS; word++) {
        const bits = Atomics.load(ctrl, CTRL_PEERS + word);
        if (bits === 0) continue;
        for (let bit = 0; bit < 32; bit++) {
            if (bits & (1 << bit)) hosts.push(word * 32 + bit);
        }
    }
    return hosts;
}
