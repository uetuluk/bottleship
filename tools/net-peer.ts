/**
 * A standing headless guest, so a guest running in the browser has something to talk to.
 *
 * Joins a room and stays there, answering echoes from its stack and reporting what arrives.
 * The point is to isolate which guest is broken: if `harness().netPing()` from the browser
 * reaches this peer, the link and the router are fine and the problem is above the stack.
 *
 * With `--ipx <socket>` it also listens for IPX datagrams on that socket number (hex or
 * decimal) and logs each one, which shows whether a guest's IPX game is announcing itself to
 * the room; `--ipx-hello` makes it broadcast a datagram there every second as well.
 *
 * Usage: bun tools/net-peer.ts <room> [router-url] [--echo <port>] [--ipx <socket> [--ipx-hello]]
 */

import { HeadlessGuest, loadProvider } from "./net-guest";
import { FAMILY_IPX, SOCK_DGRAM } from "../src/worker/core/net/net-stack";
import { VLAN_BROADCAST_HOST, hostToIp, ipToString } from "../src/net/nic-contract";

const room = process.argv[2];
if (!room) {
    console.error("usage: bun tools/net-peer.ts <room> [router-url] [--echo <port>] [--ipx <socket> [--ipx-hello]]");
    process.exit(2);
}
const router = process.argv[3]?.startsWith("http") ? process.argv[3] : "https://bottleship-net.uetuluk.workers.dev";
const echoIndex = process.argv.indexOf("--echo");
const echoPort = echoIndex > 0 ? Number(process.argv[echoIndex + 1]) : 0;
const ipxIndex = process.argv.indexOf("--ipx");
const ipxSocketNumber = ipxIndex > 0 ? Number(process.argv[ipxIndex + 1]) : 0;
const ipxHello = process.argv.includes("--ipx-hello");

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

/** Optional IPX listener (and announcer) on a socket number. */
let ipxSocket = 0;
if (ipxSocketNumber > 0) {
    ipxSocket = guest.stack.open(SOCK_DGRAM, FAMILY_IPX);
    guest.stack.bind(ipxSocket, ipxSocketNumber);
    guest.stack.setBroadcast(ipxSocket, true);
    console.log(`listening for IPX on socket 0x${ipxSocketNumber.toString(16)}${ipxHello ? ", broadcasting hello" : ""}`);
    if (ipxHello) {
        const hello = new TextEncoder().encode(`hello from ${guest.address}`);
        setInterval(() => guest.stack.sendTo(ipxSocket, VLAN_BROADCAST_HOST, ipxSocketNumber, hello), 1000);
    }
}

let lastPeers = "";
const buffer = new Uint8Array(2048);
setInterval(() => {
    const peers = guest.nic.peers().map((host) => ipToString(hostToIp(host))).join(", ") || "(none)";
    if (peers !== lastPeers) {
        lastPeers = peers;
        console.log(`peers: ${peers}`);
    }

    guest.stack.pump();
    while (ipxSocket) {
        const received = guest.stack.recvFrom(ipxSocket, buffer);
        if (typeof received === "number") break;
        const hex = [...buffer.subarray(0, Math.min(received.length, 24))].map((b) => b.toString(16).padStart(2, "0")).join(" ");
        console.log(`ipx ${received.length}B from ${ipToString(hostToIp(received.host))} socket 0x${received.port.toString(16)}: ${hex}`);
    }
    if (!echoSocket) return;
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
