/**
 * The guest's network adapter, as seen from inside the emulator worker.
 *
 * It owns nothing but the shared ring pair: frames go out by copying into TX, frames come in
 * by draining RX. Everything above it (ports, sockets, connection state) lives in NetStack;
 * everything below it (rooms, relays, WebRTC) lives in the host-side provider, which this
 * module knows nothing about.
 *
 * Hot-path discipline per CLAUDE.md §3.1: one scratch buffer per direction, bound once and
 * reused, so a packet never allocates.
 */

import {
    NIC_HEADER_SIZE,
    hostToIp,
    readNicHeader,
    writeNicHeader,
    type NicHeader,
} from "../../../net/nic-contract";
import {
    CTRL_EPOCH,
    CTRL_LINK,
    CTRL_LOCAL_HOST,
    CTRL_MTU,
    CTRL_RX_DROPS,
    CTRL_RX_FRAMES,
    CTRL_TX_DROPS,
    CTRL_TX_FRAMES,
    listPeers,
    openGuestEndpoint,
    type NicEndpoint,
} from "../../../net/nic-ring";
import { Logger, LogCategory } from "../logger";

export interface NicStats {
    linkUp: boolean;
    localHost: number;
    peers: number[];
    rxFrames: number;
    txFrames: number;
    rxDrops: number;
    txDrops: number;
}

/** Called for every inbound frame. `payload` is a view into the NIC's scratch buffer: copy
 *  anything you intend to keep past the callback. */
export type FrameSink = (header: NicHeader, payload: Uint8Array) => void;

/**
 * What the transport layer above needs from a network device. NetStack depends on this rather
 * than on VirtualNic, so a test can wire two stacks together through a simulated switch
 * without a SharedArrayBuffer or a provider.
 */
export interface NicDevice {
    readonly linkUp: boolean;
    readonly localHost: number;
    readonly localIp: number;
    readonly mtu: number;
    peers(): number[];
    consumeEpochChange(): boolean;
    send(header: NicHeader, payload: Uint8Array): boolean;
    poll(sink: FrameSink, budget?: number): number;
}

export class VirtualNic implements NicDevice {
    private endpoint: NicEndpoint | null = null;
    private txScratch = new Uint8Array(0);
    private rxScratch = new Uint8Array(0);
    private lastEpoch = 0;

    /** Attach a provider's shared buffer. Replacing one drops whatever the old link had queued. */
    attach(sab: SharedArrayBuffer): void {
        this.endpoint = openGuestEndpoint(sab);
        const capacity = this.endpoint.mtu + NIC_HEADER_SIZE;
        this.txScratch = new Uint8Array(capacity);
        this.rxScratch = new Uint8Array(capacity);
        this.lastEpoch = Atomics.load(this.endpoint.ctrl, CTRL_EPOCH);
        Logger.log(LogCategory.SYSTEM, `[net] virtual NIC attached (mtu=${this.endpoint.mtu})`);
    }

    detach(): void {
        this.endpoint = null;
    }

    get attached(): boolean {
        return this.endpoint !== null;
    }

    /** True once the provider has joined a room and given us an address. */
    get linkUp(): boolean {
        const ctrl = this.endpoint?.ctrl;
        return ctrl ? Atomics.load(ctrl, CTRL_LINK) === 1 : false;
    }

    get localHost(): number {
        const ctrl = this.endpoint?.ctrl;
        return ctrl ? Atomics.load(ctrl, CTRL_LOCAL_HOST) : 0;
    }

    /** The address the guest believes it has, in host byte order. */
    get localIp(): number {
        return hostToIp(this.localHost);
    }

    get mtu(): number {
        const ctrl = this.endpoint?.ctrl;
        return ctrl ? Atomics.load(ctrl, CTRL_MTU) : 0;
    }

    peers(): number[] {
        const ctrl = this.endpoint?.ctrl;
        return ctrl ? listPeers(ctrl) : [];
    }

    /**
     * True exactly once per link identity change. A reconnect that hands us a different
     * address invalidates every connection the guest had open, so the stack above resets
     * rather than silently sending from an address nobody will answer.
     */
    consumeEpochChange(): boolean {
        const ctrl = this.endpoint?.ctrl;
        if (!ctrl) return false;
        const epoch = Atomics.load(ctrl, CTRL_EPOCH);
        if (epoch === this.lastEpoch) return false;
        this.lastEpoch = epoch;
        return true;
    }

    /** Copy header + payload into TX. Returns false if the link is down or the ring is full. */
    send(header: NicHeader, payload: Uint8Array): boolean {
        const endpoint = this.endpoint;
        if (!endpoint || !this.linkUp) return false;
        const total = NIC_HEADER_SIZE + payload.length;
        if (total > this.txScratch.length) return false;

        writeNicHeader(this.txScratch, 0, { ...header, src: this.localHost });
        this.txScratch.set(payload, NIC_HEADER_SIZE);
        return endpoint.tx.write(this.txScratch.subarray(0, total));
    }

    /**
     * Drain up to `budget` inbound frames. Bounded because this runs from the guest's socket
     * calls: an unbounded drain would let a flooding peer stall the emulation loop.
     */
    poll(sink: FrameSink, budget = 64): number {
        const endpoint = this.endpoint;
        if (!endpoint) return 0;
        let delivered = 0;
        while (delivered < budget) {
            const length = endpoint.rx.read(this.rxScratch);
            if (length < 0) break;
            const header = readNicHeader(this.rxScratch);
            if (!header) continue;
            sink(header, this.rxScratch.subarray(NIC_HEADER_SIZE, length));
            delivered++;
        }
        return delivered;
    }

    stats(): NicStats {
        const ctrl = this.endpoint?.ctrl;
        if (!ctrl) {
            return { linkUp: false, localHost: 0, peers: [], rxFrames: 0, txFrames: 0, rxDrops: 0, txDrops: 0 };
        }
        return {
            linkUp: this.linkUp,
            localHost: this.localHost,
            peers: this.peers(),
            rxFrames: Atomics.load(ctrl, CTRL_RX_FRAMES),
            txFrames: Atomics.load(ctrl, CTRL_TX_FRAMES),
            rxDrops: Atomics.load(ctrl, CTRL_RX_DROPS),
            txDrops: Atomics.load(ctrl, CTRL_TX_DROPS),
        };
    }
}

let instance: VirtualNic | null = null;

export function getVirtualNic(): VirtualNic {
    if (!instance) instance = new VirtualNic();
    return instance;
}
