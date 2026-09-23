/**
 * The contract a network provider must satisfy to be loaded from `?net=<url>`.
 *
 * BottleShip owns this shape. A provider is an ES module served by the router it belongs to;
 * BottleShip imports it, calls `connect`, and from then on only exchanges frames. The provider
 * never sees guest memory, the emulator, or the shared ring — only plain frames and callbacks.
 */

import type { NIC_CONTRACT_VERSION } from "./nic-contract";

export interface NetConnectOptions {
    /** Router base URL, exactly as the player typed it. */
    endpoint: string;
    /** Room to join; omit to have the provider create one. */
    room?: string;
    nick: string;
    secret?: string;
    /** Network → guest. Called with a frame carrying the NIC header. */
    deliver: (frame: Uint8Array) => void;
    /** Link and roster changes, for the UI and the NIC control block. */
    onStatus: (status: NetStatus) => void;
    signal?: AbortSignal;
}

export interface NetPeerStatus {
    host: number;
    nick: string;
    /** True when this peer's traffic takes a direct path rather than the router. */
    direct: boolean;
    rttMs: number | null;
    announce: unknown;
}

export interface NetStatus {
    state: "connecting" | "online" | "offline" | "error";
    room: string;
    /** Our host octet; the guest's address is 10.77.0.<localHost>. */
    localHost: number;
    relayRttMs: number | null;
    peers: NetPeerStatus[];
    error?: string;
}

export interface NetSession {
    readonly room: string;
    readonly localHost: number;
    readonly mtu: number;
    /** Guest → network. The frame already carries the NIC header. */
    send(frame: Uint8Array<ArrayBuffer>): void;
    /** Advertise an opaque blob (game, session state) to the rest of the room. */
    announce(blob: unknown): void;
    status(): NetStatus;
    close(): void;
}

export interface NetProviderModule {
    readonly contract: typeof NIC_CONTRACT_VERSION;
    readonly name: string;
    readonly version: string;
    connect(options: NetConnectOptions): Promise<NetSession>;
}

/** A provider may also register itself here, for hosts that load it as a classic script. */
declare global {
    var __BOTTLESHIP_NET__: NetProviderModule | undefined;
}
