/**
 * A headless BottleShip guest, for driving the network layer without a browser.
 *
 * Runs the same VirtualNic and NetStack the emulator worker uses, wrapped in the same
 * ring pump the page does (src/net/net-link.ts) — only the guest above the stack is missing.
 * Shared by tools/net-loopback.ts (two guests, one process) and tools/net-peer.ts (one
 * standing guest a browser can be tested against).
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NIC_CONTRACT_VERSION, hostToIp, ipToString } from "../src/net/nic-contract";
import {
    CTRL_EPOCH,
    CTRL_LINK,
    CTRL_LOCAL_HOST,
    CTRL_MTU,
    createNicBuffer,
    openHostEndpoint,
    setPeerPresence,
    type NicEndpoint,
} from "../src/net/nic-ring";
import type { NetProviderModule, NetSession, NetStatus } from "../src/net/provider-contract";
import { VirtualNic } from "../src/worker/core/net/virtual-nic";
import { NetStack } from "../src/worker/core/net/net-stack";

/** Bun cannot import a remote module directly, so the bundle is staged on disk first. */
export async function loadProvider(endpoint: string): Promise<NetProviderModule> {
    const config = await (await fetch(new URL("/v1/config", endpoint))).json() as { client: string; protocol: number };
    if (config.protocol !== NIC_CONTRACT_VERSION) {
        throw new Error(`router protocol ${config.protocol} != contract ${NIC_CONTRACT_VERSION}`);
    }
    const source = await (await fetch(config.client)).text();
    const dir = await mkdtemp(join(tmpdir(), "bs-net-"));
    const file = join(dir, "client.mjs");
    await writeFile(file, source);
    return ((await import(file)) as { default: NetProviderModule }).default;
}

export class HeadlessGuest {
    readonly nic = new VirtualNic();
    readonly stack: NetStack;
    private rings: NicEndpoint;
    private scratch: Uint8Array;
    private session: NetSession | null = null;
    private pump: ReturnType<typeof setInterval> | null = null;
    private lastHost = 0;

    private constructor(sab: SharedArrayBuffer, readonly nick: string) {
        this.rings = openHostEndpoint(sab);
        this.nic.attach(sab);
        this.stack = new NetStack(this.nic);
        this.scratch = new Uint8Array(this.rings.mtu + 64);
    }

    static async join(
        provider: NetProviderModule,
        endpoint: string,
        nick: string,
        room?: string,
    ): Promise<HeadlessGuest> {
        const guest = new HeadlessGuest(createNicBuffer(), nick);
        guest.session = await provider.connect({
            endpoint,
            room,
            nick,
            deliver: (frame) => { guest.rings.rx.write(frame); },
            onStatus: (status) => guest.applyStatus(status),
        });
        Atomics.store(guest.rings.ctrl, CTRL_MTU, guest.session.mtu);
        guest.applyStatus(guest.session.status());
        // Drains the guest's outbound ring, and pumps inbound so the stack answers echoes
        // even when no test code is calling into it.
        guest.pump = setInterval(() => {
            guest.drain();
            guest.stack.pump();
        }, 1);
        return guest;
    }

    get room(): string {
        return this.session!.room;
    }

    get address(): string {
        return ipToString(hostToIp(this.nic.localHost));
    }

    status(): NetStatus | null {
        return this.session?.status() ?? null;
    }

    private applyStatus(status: NetStatus): void {
        const ctrl = this.rings.ctrl;
        Atomics.store(ctrl, CTRL_LOCAL_HOST, status.localHost);
        Atomics.store(ctrl, CTRL_LINK, status.state === "online" ? 1 : 0);
        setPeerPresence(ctrl, status.peers.map((peer) => peer.host));
        if (status.localHost !== this.lastHost) {
            if (this.lastHost !== 0) Atomics.add(ctrl, CTRL_EPOCH, 1);
            this.lastHost = status.localHost;
        }
    }

    private drain(): void {
        for (;;) {
            const length = this.rings.tx.read(this.scratch);
            if (length < 0) break;
            this.session?.send(this.scratch.slice(0, length));
        }
    }

    close(): void {
        if (this.pump !== null) clearInterval(this.pump);
        this.session?.close();
    }
}

export async function waitFor(check: () => boolean, what: string, ms = 8000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (check()) return;
        await Bun.sleep(10);
    }
    throw new Error(`timed out waiting for ${what}`);
}
