/**
 * Page-side entry point for multiplayer: turns `?net=<router url>` into a live virtual NIC,
 * and exposes `window.net` so a session can be started, inspected or torn down from the
 * console without a reload.
 *
 * Nothing here runs unless a router URL is supplied. Attaching a network means executing a
 * module from that URL (see net-link.ts), so it stays an explicit, per-session opt-in.
 */

import { NetLink } from "./net-link";
import { hostToIp, ipToString } from "./nic-contract";
import type { NetStatus } from "./provider-contract";

/** Fired on `window` whenever the room's state changes, for any UI that wants to listen. */
export const NET_STATUS_EVENT = "bs-net-status";

let link: NetLink | null = null;
let connecting: Promise<unknown> | null = null;

export interface NetSummary {
    room: string;
    address: string;
    peers: Array<{ address: string; nick: string; direct: boolean; rttMs: number | null }>;
    state: NetStatus["state"];
    error?: string;
}

function summarize(status: NetStatus): NetSummary {
    return {
        room: status.room,
        address: ipToString(hostToIp(status.localHost)),
        peers: status.peers.map((peer) => ({
            address: ipToString(hostToIp(peer.host)),
            nick: peer.nick,
            direct: peer.direct,
            rttMs: peer.rttMs,
        })),
        state: status.state,
        ...(status.error ? { error: status.error } : {}),
    };
}

export function installNetwork(worker: Worker): void {
    const params = new URLSearchParams(window.location.search);

    const connect = async (endpoint: string, room?: string, nick?: string): Promise<NetSummary> => {
        if (connecting) await connecting.catch(() => undefined);
        link?.close();
        link = null;

        const attempt = NetLink.connect({
            endpoint,
            room,
            nick: nick ?? params.get("nick") ?? undefined,
            secret: params.get("netsecret") ?? undefined,
            worker,
            onStatus: (status) => {
                window.dispatchEvent(new CustomEvent(NET_STATUS_EVENT, { detail: summarize(status) }));
            },
        });
        connecting = attempt;
        try {
            link = await attempt;
            return summarize(link.status());
        } finally {
            connecting = null;
        }
    };

    const api = {
        connect,
        disconnect: () => {
            link?.close();
            link = null;
            return "disconnected";
        },
        status: (): NetSummary | "not connected" => (link ? summarize(link.status()) : "not connected"),
        /** Advertise an opaque blob to the room (game name, session state). */
        announce: (blob: unknown) => link?.announce(blob),
    };
    (window as unknown as { net: typeof api }).net = api;

    const endpoint = params.get("net");
    if (!endpoint) return;
    void connect(endpoint, params.get("room") ?? undefined).catch((error: unknown) => {
        console.error("[bs] network: could not attach", error);
        window.dispatchEvent(new CustomEvent(NET_STATUS_EVENT, {
            detail: { room: "", address: "", peers: [], state: "error", error: String(error) },
        }));
    });
}
