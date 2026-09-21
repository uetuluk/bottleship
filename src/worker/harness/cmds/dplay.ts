/**
 * dplay — DirectPlay session state over the harness RPC.
 *
 * When a DirectPlay game "sees no games" or "can't join", this answers which layer stops: is the
 * object connected to a provider, what did enumeration find, is a session open, who is in the
 * roster, and are messages queued that the game never reads. Pair with net() for the NIC below.
 */

import type { HarnessService } from "../service";
import { DirectPlayInstance } from "../../modules/dplayx/directplay4";

export function registerDplayCommands(svc: HarnessService): void {
    /** dplay() — one row per live IDirectPlay object: provider connection, session, peers,
     *  roster (local/remote players and groups), receive queue depth, send backlog, and the
     *  sessions enumeration has cached. */
    svc.register("dplay", async () => {
        return [...DirectPlayInstance.live].map((inst) => ({
            connected: inst.connected,
            joining: inst.joining,
            events: inst.events.size,
            ...inst.engine.describe(),
        }));
    });
}
