/**
 * net — virtual NIC and socket state over the harness RPC.
 *
 * When a networked game "does nothing", the first question is which side of the ring the
 * packets stop at: is the link even up, did the guest send anything (txFrames), did anything
 * arrive (rxFrames), is the ring overflowing (drops), and which ports did the guest bind?
 * One POJO answers all of that without reading the log firehose.
 *
 * For the layers below the ring — router, relay, peer connections — use
 * `bun tools/net-loopback.ts`, which drives the same stack against a real router.
 */

import type { HarnessService } from "../service";
import { getVirtualNic } from "../../core/net/virtual-nic";
import { getNetStack } from "../../core/net/net-stack";
import { hostToIp, ipToHost, ipToString } from "../../../net/nic-contract";

/** Accepts "10.77.0.2" or a bare octet as text. */
function parseAddress(value: string): number {
    const parts = value.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return 0;
    }
    return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

export function registerNetCommands(svc: HarnessService): void {
    /** net() — link state, peer list and NIC counters. `attached:false` means no provider
     *  was ever handed to the worker (no `?net=` on the page); `linkUp:false` with
     *  `attached:true` means a provider is loaded but has not joined a room yet. */
    svc.register("net", async () => {
        const nic = getVirtualNic();
        const stats = nic.stats();
        return {
            attached: nic.attached,
            linkUp: stats.linkUp,
            address: stats.linkUp ? ipToString(hostToIp(stats.localHost)) : null,
            mtu: nic.mtu,
            peers: stats.peers.map((host) => ipToString(hostToIp(host))),
            frames: { tx: stats.txFrames, rx: stats.rxFrames },
            drops: { tx: stats.txDrops, rx: stats.rxDrops },
        };
    });

    /** netPing({peer, timeoutMs?=2000}) — round trip to another guest, answered by its stack
     *  rather than by any game, so it works before a game has opened a single socket. `peer`
     *  is a host octet or a 10.77.0.x address; omit it to ping every peer in the room.
     *  This is the call that separates "the link is broken" from "the game is not using it". */
    svc.register("netPing", async (args) => {
        const nic = getVirtualNic();
        if (!nic.linkUp) return { error: "link is down" };

        const requested = (args as { peer?: number | string } | undefined)?.peer;
        const targets = requested === undefined
            ? nic.peers()
            : [typeof requested === "string" ? (ipToHost(parseAddress(requested)) ?? -1) : requested];
        const timeoutMs = (args as { timeoutMs?: number } | undefined)?.timeoutMs ?? 2000;

        const stack = getNetStack();
        const pending = targets
            .filter((host) => host >= 0)
            .map((host) => ({ host, seq: stack.sendEcho(host), rttMs: null as number | null }));

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && pending.some((p) => p.rttMs === null)) {
            stack.pump();
            for (const probe of pending) {
                if (probe.rttMs === null) probe.rttMs = stack.takeEcho(probe.seq);
            }
            if (pending.every((p) => p.rttMs !== null)) break;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        return pending.map((probe) => ({
            peer: ipToString(hostToIp(probe.host)),
            rttMs: probe.rttMs,
            reachable: probe.rttMs !== null,
        }));
    });

    /** netSockets() — every live guest socket: type, bound port, peer and readiness.
     *  A game that binds nothing has not reached its network code; a socket that is
     *  readable while the game keeps polling points at the Winsock layer, not the link. */
    svc.register("netSockets", async () => {
        const stack = getNetStack();
        stack.pump();
        return stack.describe();
    });
}
