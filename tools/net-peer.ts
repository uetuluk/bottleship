/**
 * A standing headless guest, so a guest running in the browser has something to talk to.
 *
 * Joins a room and stays there, answering echoes from its stack and reporting what arrives.
 * The point is to isolate which guest is broken: if `harness().netPing()` from the browser
 * reaches this peer, the link and the router are fine and the problem is above the stack.
 *
 * Usage: bun tools/net-peer.ts <room> [router-url] [--echo <port>]
 */

import { HeadlessGuest, loadProvider } from "./net-guest";
import { SOCK_DGRAM } from "../src/worker/core/net/net-stack";
import { hostToIp, ipToString } from "../src/net/nic-contract";

const room = process.argv[2];
if (!room) {
    console.error("usage: bun tools/net-peer.ts <room> [router-url] [--echo <port>]");
    process.exit(2);
}
const router = process.argv[3]?.startsWith("http") ? process.argv[3] : "https://bottleship-net.uetuluk.workers.dev";
const echoIndex = process.argv.indexOf("--echo");
const echoPort = echoIndex > 0 ? Number(process.argv[echoIndex + 1]) : 0;

const provider = await loadProvider(router);
const guest = await HeadlessGuest.join(provider, router, "test-peer", room);
console.log(`joined ${guest.room} as ${guest.address} (${provider.name} ${provider.version})`);
console.log("answering echo; ctrl-c to leave");

/** Optional UDP echo on a port, for testing a guest's datagram path end to end. */
let echoSocket = 0;
if (echoPort > 0) {
    echoSocket = guest.stack.open(SOCK_DGRAM);
    guest.stack.bind(echoSocket, echoPort);
    guest.stack.setBroadcast(echoSocket, true);
    console.log(`echoing UDP on port ${echoPort}`);
}

let lastPeers = "";
const buffer = new Uint8Array(2048);
setInterval(() => {
    const peers = guest.nic.peers().map((host) => ipToString(hostToIp(host))).join(", ") || "(none)";
    if (peers !== lastPeers) {
        lastPeers = peers;
        console.log(`peers: ${peers}`);
    }

    if (!echoSocket) return;
    guest.stack.pump();
    for (;;) {
        const received = guest.stack.recvFrom(echoSocket, buffer);
        if (typeof received === "number") break;
        const from = ipToString(hostToIp(received.host));
        console.log(`recv ${received.length}B from ${from}:${received.port} → echoing back`);
        guest.stack.sendTo(echoSocket, received.host, received.port, buffer.subarray(0, received.length));
    }
}, 250);

process.on("SIGINT", () => {
    guest.close();
    process.exit(0);
});
