/**
 * A headless DirectPlay peer, so a game in the browser has a session to find or a host to join.
 *
 * Runs the emulator's own DirectPlay engine (src/worker/modules/dplayx/dplay-sp.ts) on a headless
 * guest (tools/net-guest.ts), which isolates the failing side: if this peer sees the browser's
 * session, the link, the router and the host side are fine and the problem is in the enumerator.
 *
 *   bun tools/dplay-peer.ts <room> --host "My Game" [--app <guid>] [--max 8]
 *       Host a session and echo every user message back to its sender.
 *   bun tools/dplay-peer.ts <room> --enum [--app <guid>]
 *       Print sessions as they are discovered.
 *   bun tools/dplay-peer.ts <room> --join [--app <guid>] [--size 5000]
 *       Join the first session found, create a player, send it a message of --size bytes and
 *       report what comes back.
 *
 * A router URL may follow the room; the default is the public BottleShip router.
 */

import { HeadlessGuest, loadProvider } from "./net-guest";
import {
    DP_OK,
    DPENUMSESSIONS_ALL,
    DPID_ALLPLAYERS,
    DPlayEngine,
    formatGuid,
    type QueuedMessage,
} from "../src/worker/modules/dplayx/dplay-sp";

const args = process.argv.slice(2);
const room = args[0];
const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i > 0 ? args[i + 1] : undefined;
};
if (!room || !(args.includes("--host") || args.includes("--enum") || args.includes("--join"))) {
    console.error("usage: bun tools/dplay-peer.ts <room> [router-url] (--host <name> | --enum | --join) [--app <guid>] [--max N] [--size N]");
    process.exit(2);
}
const router = args[1]?.startsWith("http") ? args[1] : "https://bottleship-net.uetuluk.workers.dev";

/** "{01234567-89ab-cdef-0123-456789abcdef}" → the GUID's in-memory (little-endian) bytes. */
function parseGuid(text: string | undefined): Uint8Array {
    const out = new Uint8Array(16);
    if (!text) return out;
    const hex = text.replace(/[{}-]/g, "");
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`bad GUID: ${text}`);
    const b = (i: number) => parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    [3, 2, 1, 0, 5, 4, 7, 6].forEach((src, dst) => { out[dst] = b(src); });
    for (let i = 8; i < 16; i++) out[i] = b(i);
    return out;
}

function describe(m: QueuedMessage): string {
    if (m.data) return `data ${m.data.length}B 0x${m.from.toString(16)} → 0x${m.to.toString(16)}`;
    const sys = m.sys!;
    const detail = "entity" in sys ? ` "${sys.entity.shortName}" 0x${sys.entity.id.toString(16)}` : "";
    return `system 0x${sys.type.toString(16)}${detail} → 0x${m.to.toString(16)}`;
}

const app = parseGuid(opt("--app"));
const provider = await loadProvider(router);
const guest = await HeadlessGuest.join(provider, router, "dplay-peer", room);
console.log(`joined ${guest.room} as ${guest.address}`);
const dp = new DPlayEngine(guest.stack, guest.nic);

function drain(onData?: (m: QueuedMessage) => void): void {
    for (;;) {
        const i = dp.findMessage(null, null);
        if (i < 0) return;
        const m = dp.message(i)!;
        dp.takeMessage(i);
        console.log(`recv ${describe(m)}`);
        if (m.data) onData?.(m);
    }
}

if (args.includes("--host")) {
    const name = opt("--host") ?? "dplay-peer";
    const hr = dp.createSession({
        flags: 0, guidInstance: new Uint8Array(16), guidApplication: app,
        maxPlayers: Number(opt("--max") ?? 8), currentPlayers: 0, name, password: "", user: [0, 0, 0, 0],
    });
    if (hr !== DP_OK) throw new Error(`createSession failed 0x${hr.toString(16)}`);
    const me = dp.createPlayer({ shortName: "HeadlessHost", longName: "", hasName: true }, new Uint8Array(0), 0);
    console.log(`hosting "${name}" app=${formatGuid(app)} player=0x${me.id.toString(16)}`);
    setInterval(() => {
        dp.pump();
        drain((m) => {
            const r = dp.send(me.id, m.from, m.data!);
            console.log(`echo ${m.data!.length}B → 0x${m.from.toString(16)}: 0x${r.toString(16)}`);
        });
    }, 20);
} else {
    const joining = args.includes("--join");
    const size = Number(opt("--size") ?? 5000);
    const seen = new Set<string>();
    let state: "enum" | "joining" | "joined" = "enum";
    let player = 0;
    const timer = setInterval(() => {
        if (state === "enum") {
            dp.pollSessions(app, "", DPENUMSESSIONS_ALL);
            for (const s of dp.sessions(app, DPENUMSESSIONS_ALL)) {
                const key = formatGuid(s.desc.guidInstance);
                if (!seen.has(key)) {
                    seen.add(key);
                    console.log(`session "${s.desc.name}" host=10.77.0.${s.host}:${s.port} players=${s.desc.currentPlayers}/${s.desc.maxPlayers} app=${formatGuid(s.desc.guidApplication)}`);
                }
                if (joining) {
                    const hr = dp.beginJoin(s.desc.guidInstance, "");
                    console.log(`join "${s.desc.name}": 0x${hr.toString(16)}`);
                    if (hr === DP_OK) state = "joining";
                    break;
                }
            }
            return;
        }
        if (state === "joining") {
            const hr = dp.pollJoin();
            if (hr === null) return;
            if (hr !== DP_OK) {
                console.log(`join failed 0x${hr.toString(16)}`);
                clearInterval(timer);
                process.exit(1);
            }
            state = "joined";
            player = dp.createPlayer({ shortName: "HeadlessJoiner", longName: "", hasName: true }, new Uint8Array(0), 0).id;
            for (const e of dp.listEntities()) console.log(`roster 0x${e.id.toString(16)} "${e.shortName}"${e.local ? " (local)" : ""}`);
            const payload = new Uint8Array(size).map((_, i) => (i * 13) & 0xff);
            console.log(`send ${size}B to all: 0x${dp.send(player, DPID_ALLPLAYERS, payload).toString(16)}`);
            return;
        }
        dp.pump();
        drain((m) => {
            const ok = m.data!.every((v, i) => v === ((i * 13) & 0xff));
            console.log(`  payload ${ok ? "intact" : "CORRUPT"}`);
        });
    }, 50);
}

process.on("SIGINT", () => {
    dp.shutdown();
    guest.close();
    process.exit(0);
});
