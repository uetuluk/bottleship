/**
 * End-to-end check of guest networking against a real router.
 *
 * Stands up two guests — each with the same VirtualNic and NetStack the emulator worker uses,
 * driven by the router's own client module — joins them to one room, and exchanges traffic.
 * Everything between the Winsock layer and the far guest's socket is exercised for real: the
 * shared ring, the frame format, the provider contract, the transport and the router itself.
 *
 * This is the check to run when multiplayer "does nothing" and you need to know which side of
 * the ring the packets stop at; the emulator adds only the guest-pointer marshalling on top.
 *
 * Usage: bun tools/net-loopback.ts [router-url]
 */

import { hostToIp, ipToString } from "../src/net/nic-contract";
import { SOCK_DGRAM, SOCK_STREAM, errorOf, isError } from "../src/worker/core/net/net-stack";
import { HeadlessGuest, loadProvider, waitFor } from "./net-guest";

const routerUrl = process.argv[2] ?? "https://bottleship-net.uetuluk.workers.dev";

let failures = 0;
function report(name: string, ok: boolean, detail = ""): void {
    console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? `  ${detail}` : ""}`);
    if (!ok) failures++;
}

const provider = await loadProvider(routerUrl);
console.log(`router   ${routerUrl}`);
console.log(`provider ${provider.name} ${provider.version} (contract v${provider.contract})`);

const alice = await HeadlessGuest.join(provider, routerUrl, "alice");
const bob = await HeadlessGuest.join(provider, routerUrl, "bob", alice.room);
await waitFor(() => alice.nic.linkUp && bob.nic.linkUp, "both links up");
await waitFor(() => alice.nic.peers().length > 0, "alice sees bob");
console.log(`room     ${alice.room}   alice=${alice.address} bob=${bob.address}`);

// ── unicast ──────────────────────────────────────────────────────────────────
const listener = bob.stack.open(SOCK_DGRAM);
bob.stack.bind(listener, 2300);
const sender = alice.stack.open(SOCK_DGRAM);
alice.stack.bind(sender, 2301);

const started = Date.now();
alice.stack.sendTo(sender, bob.nic.localHost, 2300, new TextEncoder().encode("hello from alice"));
await waitFor(() => { bob.stack.pump(); return bob.stack.readable(listener); }, "bob receives the datagram");
const rtt = Date.now() - started;

const out = new Uint8Array(256);
const received = bob.stack.recvFrom(listener, out);
if (typeof received === "number") {
    report("unicast datagram", false, `error ${errorOf(received)}`);
} else {
    const payload = new TextDecoder().decode(out.subarray(0, received.length));
    report("unicast datagram", payload === "hello from alice" && received.host === alice.nic.localHost,
        `${rtt}ms from ${ipToString(hostToIp(received.host))}:${received.port}`);
}

// ── broadcast (the LAN discovery path) ───────────────────────────────────────
const discovery = bob.stack.open(SOCK_DGRAM);
bob.stack.bind(discovery, 47624);
const announcer = alice.stack.open(SOCK_DGRAM);
alice.stack.bind(announcer, 47624);
alice.stack.setBroadcast(announcer, true);
alice.stack.sendTo(announcer, 0xff, 47624, new TextEncoder().encode("any games?"));
try {
    await waitFor(() => { bob.stack.pump(); return bob.stack.readable(discovery); }, "broadcast reaches bob");
    report("broadcast discovery", true);
} catch {
    report("broadcast discovery", false, "not delivered");
}

// ── stream handshake and data ────────────────────────────────────────────────
const server = bob.stack.open(SOCK_STREAM);
bob.stack.bind(server, 7000);
bob.stack.listen(server, 5);
const client = alice.stack.open(SOCK_STREAM);
const connectResult = alice.stack.connect(client, bob.nic.localHost, 7000);
report("connect reports it is in progress", isError(connectResult) && errorOf(connectResult) === 10035);

try {
    await waitFor(() => { bob.stack.pump(); return bob.stack.readable(server); }, "bob sees the connection");
    const accepted = bob.stack.accept(server);
    await waitFor(() => { alice.stack.pump(); return alice.stack.writable(client); }, "alice's connect completes");
    report("stream handshake", typeof accepted !== "number");

    if (typeof accepted !== "number") {
        alice.stack.send(client, new TextEncoder().encode("stream payload"));
        await waitFor(() => { bob.stack.pump(); return bob.stack.readable(accepted.id); }, "stream data arrives");
        const length = bob.stack.recv(accepted.id, out);
        report("stream data", new TextDecoder().decode(out.subarray(0, length)) === "stream payload");
    }
} catch (error) {
    report("stream handshake", false, String(error));
}

console.log(`\nnic      alice ${JSON.stringify(alice.nic.stats())}`);
console.log(`nic      bob   ${JSON.stringify(bob.nic.stats())}`);

alice.close();
bob.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
