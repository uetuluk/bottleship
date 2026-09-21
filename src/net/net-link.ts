/**
 * Host side of the virtual NIC: loads a network provider, owns the shared ring buffer, and
 * pumps frames between the emulator worker and whatever transport the provider runs.
 *
 * The provider is an ES module fetched from the URL the player supplied in `?net=`. That is
 * third-party code running on the page, so it is loaded only when a URL is explicitly given —
 * never by default, never from a remembered value — and it is handed nothing but frames.
 */

import { NIC_CONTRACT_VERSION, NIC_HEADER_SIZE, hostToIp, ipToString } from "./nic-contract";
import {
    CTRL_EPOCH,
    CTRL_LINK,
    CTRL_LOCAL_HOST,
    CTRL_MTU,
    CTRL_TX_HEAD,
    createNicBuffer,
    openHostEndpoint,
    setPeerPresence,
    type NicEndpoint,
} from "./nic-ring";
import type { NetProviderModule, NetSession, NetStatus } from "./provider-contract";

export interface NetLinkOptions {
    /** Router base URL from `?net=`. */
    endpoint: string;
    room?: string;
    nick?: string;
    secret?: string;
    /** The emulator worker, which receives the shared buffer. */
    worker: Worker;
    onStatus?: (status: NetStatus) => void;
}

/** Safety net in case a provider ever delivers without notifying; also bounds shutdown latency. */
const PUMP_TIMEOUT_MS = 50;

/**
 * Atomics.waitAsync is ES2024 and the project targets ES2022, so it is reached through a
 * narrow local declaration rather than widening the whole build's lib. The optional shape
 * doubles as the feature test for browsers that do not have it yet.
 */
type WaitAsyncResult =
    | { async: true; value: Promise<"ok" | "timed-out"> }
    | { async: false; value: "not-equal" | "timed-out" };
type WaitAsync = (typedArray: Int32Array, index: number, value: number, timeout?: number) => WaitAsyncResult;
const waitAsync = (Atomics as unknown as { waitAsync?: WaitAsync }).waitAsync;

interface RouterConfig {
    client: string;
    protocol: number;
}

/**
 * Fetch the router's discovery document and import the client module it names. Going through
 * `/v1/config` rather than guessing a path means the router decides what its client is, and a
 * protocol mismatch is reported before anything is executed.
 */
async function loadProvider(endpoint: string, signal?: AbortSignal): Promise<NetProviderModule> {
    const base = new URL(endpoint);
    const response = await fetch(new URL("/v1/config", base.origin), { signal });
    if (!response.ok) throw new Error(`network router did not answer (HTTP ${response.status})`);
    const config = (await response.json()) as RouterConfig;
    if (config.protocol !== NIC_CONTRACT_VERSION) {
        throw new Error(
            `router speaks network protocol ${config.protocol}; this build speaks ${NIC_CONTRACT_VERSION}`,
        );
    }

    const module = (await import(/* @vite-ignore */ config.client)) as { default?: NetProviderModule };
    const provider = module.default ?? globalThis.__BOTTLESHIP_NET__;
    if (!provider || typeof provider.connect !== "function") {
        throw new Error("network provider module did not export a provider");
    }
    if (provider.contract !== NIC_CONTRACT_VERSION) {
        throw new Error(`provider implements contract v${provider.contract}, expected v${NIC_CONTRACT_VERSION}`);
    }
    return provider;
}

export class NetLink {
    private endpointRings: NicEndpoint;
    private scratch: Uint8Array;
    private closed = false;
    private lastHost = 0;
    private lastStatus: NetStatus | null = null;

    private constructor(
        private readonly buffer: SharedArrayBuffer,
        private readonly worker: Worker,
        private readonly session: NetSession,
        private readonly onStatus?: (status: NetStatus) => void,
    ) {
        this.endpointRings = openHostEndpoint(buffer);
        this.scratch = new Uint8Array(this.endpointRings.mtu + NIC_HEADER_SIZE);
    }

    static async connect(options: NetLinkOptions): Promise<NetLink> {
        const provider = await loadProvider(options.endpoint);
        const buffer = createNicBuffer();
        const rings = openHostEndpoint(buffer);
        const deliverScratch = { rings };

        let link: NetLink | null = null;
        const session = await provider.connect({
            endpoint: options.endpoint,
            room: options.room,
            nick: options.nick ?? "player",
            secret: options.secret,
            deliver: (frame) => {
                // Dropped when the guest is not draining; a datagram device is allowed to.
                deliverScratch.rings.rx.write(frame);
            },
            onStatus: (status) => link?.applyStatus(status),
        });

        link = new NetLink(buffer, options.worker, session, options.onStatus);
        Atomics.store(rings.ctrl, CTRL_MTU, session.mtu);
        link.applyStatus(session.status());
        options.worker.postMessage({ type: "net_attach", buffer });
        void link.pump();

        console.info(
            `[bs] network: room "${session.room}", this guest is ${ipToString(hostToIp(session.localHost))}`,
        );
        return link;
    }

    get room(): string {
        return this.session.room;
    }

    status(): NetStatus {
        return this.lastStatus ?? this.session.status();
    }

    announce(blob: unknown): void {
        this.session.announce(blob);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        Atomics.store(this.endpointRings.ctrl, CTRL_LINK, 0);
        Atomics.notify(this.endpointRings.ctrl, CTRL_TX_HEAD);
        this.session.close();
        this.worker.postMessage({ type: "net_attach", buffer: null });
    }

    /** Mirror the provider's view of the room into the control block the guest reads. */
    private applyStatus(status: NetStatus): void {
        const ctrl = this.endpointRings.ctrl;
        Atomics.store(ctrl, CTRL_LOCAL_HOST, status.localHost);
        Atomics.store(ctrl, CTRL_LINK, status.state === "online" ? 1 : 0);
        setPeerPresence(ctrl, status.peers.map((peer) => peer.host));
        if (status.localHost !== this.lastHost) {
            // Only a change between two real addresses invalidates anything. Getting our first
            // address is not a change — bumping the epoch there would reset a guest that had
            // already opened sockets while the link was still coming up.
            if (this.lastHost !== 0) Atomics.add(ctrl, CTRL_EPOCH, 1);
            this.lastHost = status.localHost;
        }
        this.lastStatus = status;
        this.onStatus?.(status);
    }

    /**
     * Drain the guest's outbound ring forever. The worker notifies the TX head on every frame,
     * so this parks in `Atomics.waitAsync` rather than spinning on a timer — no polling
     * interval to trade against latency.
     */
    private async pump(): Promise<void> {
        const ctrl = this.endpointRings.ctrl;
        while (!this.closed) {
            for (;;) {
                const length = this.endpointRings.tx.read(this.scratch);
                if (length < 0) break;
                // slice() because the provider hands the frame to WebSocket/RTCDataChannel,
                // neither of which accepts a view backed by shared memory.
                this.session.send(this.scratch.slice(0, length));
            }
            const head = Atomics.load(ctrl, CTRL_TX_HEAD);
            const waiter = waitAsync?.call(Atomics, ctrl, CTRL_TX_HEAD, head, PUMP_TIMEOUT_MS);
            if (waiter?.async) await waiter.value;
            else await new Promise((resolve) => setTimeout(resolve, waiter ? 0 : 1));
        }
    }
}
