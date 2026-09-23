# Multiplayer

BottleShip can give a guest a real network adapter. The emulator ships the device; the network
itself comes from a *provider* loaded at runtime from a URL, so nothing about rooms, routers or
peer connections lives in this repo.

```
?net=https://bottleship-net.uetuluk.workers.dev
```

With no `?net=` parameter nothing is loaded and Winsock behaves exactly as it always has:
sockets exist, resolve to loopback, and find nobody.

## Layers

| Layer | Where | Responsibility |
| --- | --- | --- |
| Winsock | `src/worker/modules/wsa-net.ts` | Guest pointers ↔ stack calls: sockaddr, buffers, fd_sets, WSA error codes |
| Transport | `src/worker/core/net/net-stack.ts` | Ports, datagram queues, stream connections, readiness |
| Device | `src/worker/core/net/virtual-nic.ts` | Frames in and out of the shared ring |
| Ring | `src/net/nic-ring.ts` | Lock-free SharedArrayBuffer transport across the worker boundary |
| Link | `src/net/net-link.ts` | Loads the provider, pumps the ring, mirrors room state into the control block |
| Provider | loaded from `?net=` | Rooms, relays, peer-to-peer connections — anything below the frame |

The provider never sees guest memory or the emulator; it exchanges frames and status. The
contract it must satisfy is `src/net/provider-contract.ts`, and the frame format it must speak
is `src/net/nic-contract.ts`. Both are versioned, and a mismatch is refused at connect time
rather than producing garbled packets.

## Addressing

Guests share a `10.77.0.0/24` virtual LAN. Each gets a host octet on join, so a guest is
`10.77.0.1`, `10.77.0.2` and so on. `10.77.0.255` and `255.255.255.255` both broadcast to the
whole room, which is how LAN-era games discover each other. Loopback and the guest's own
address route back into the guest, so a game that talks to `127.0.0.1` keeps working.

The same room is also one **IPX network**. Its network number is the LAN prefix (`0a 4d 00 00`)
and each guest's node address is a locally administered MAC carrying its LAN address
(`02:00:0a:4d:00:HH`), so `IPX_ADDRESS` and `getsockname` report an address every peer can
answer, and a node of `ff:ff:ff:ff:ff:ff` broadcasts to the room.

`gethostbyname` reports the guest's LAN address once a link is up — games resolve their own
name to decide what address to advertise to peers, and answering `127.0.0.1` there makes a
host that nobody can join.

## Console control

`window.net` is installed whenever the app starts:

```js
await net.connect("https://bottleship-net.uetuluk.workers.dev")   // create a room
await net.connect("https://…", "brisk-otter-glad")                // join one
net.status()        // { room, address, peers: [{ address, nick, direct, rttMs }], state }
net.disconnect()
```

`?room=<code>` joins a specific room on load, `?nick=<name>` sets the name peers see.

## Debugging

| Tool | Answers |
| --- | --- |
| `harness().net()` | Is the link up, what is our address, how many frames moved, is the ring dropping? |
| `harness().netSockets()` | What has the guest actually bound, and is anything readable it is not reading? Each row carries its `WSAAsyncSelect` registration and which events are still armed |
| `bun tools/net-loopback.ts [router]` | Does the whole chain work — two guests, real stack, real router — outside the browser? |
| `harness().call("dplay")` | Per DirectPlay object: provider connected, sessions enumeration found, open session, peers, roster, queued messages |
| `bun tools/dplay-peer.ts <room> --host/--enum/--join` | A headless DirectPlay host, enumerator or joiner to test a guest's DirectPlay against |

`bun tools/net-peer.ts <room> --ipx <socket>` logs every IPX datagram the room sends to that
socket number (`--ipx-hello` also broadcasts one a second), which shows whether an IPX game is
announcing itself before a second instance is involved.

`netPing()` is the call that separates "the link is broken" from "the game is not using it":
it is answered by the peer's stack, not by any game, so it works before a socket is opened.
`bun tools/net-peer.ts <room> --echo 2300` puts a headless guest in a room to ping against.

When developing this code, note that editing anything under `src/` while connected triggers a
Vite reload, which orphans the link and leaves the worker without a NIC — reconnect after the
reload rather than chasing a phantom bug.

`net()` distinguishes the three failure shapes quickly: `attached:false` means no provider was
ever handed to the worker (no `?net=`); `attached:true, linkUp:false` means the provider loaded
but has not joined a room; `linkUp:true` with `txFrames:0` means the guest never sent anything,
so the problem is above the device, in the game's own network code or in Winsock.

## Known limits

- **No blocking sockets.** Every call completes or returns `WSAEWOULDBLOCK` immediately,
  because the worker runs the x86 loop and a blocking call would stall every guest thread, not
  just the caller's. Games driven by `select`/`WSAAsyncSelect` are unaffected; a game that
  expects a blocking `recv` to sleep will spin instead. Parking the calling guest thread
  through the async-thunk path (CLAUDE.md §3.5) is the faithful fix.
- **Streams are not TCP.** The link under them delivers reliably and in order, so connection
  setup and teardown are implemented and retransmission, windowing and congestion control are
  not. The one place ordering can break — a stream switching between relay and direct path —
  is handled by a sequence number and a small reorder window.

## WSAAsyncSelect

A registered socket gets its `FD_*` notifications as window messages
(`src/worker/core/net/async-select.ts`), following Winsock's record-and-re-enable rules: each
event posts once and waits for its re-enabling call — `recv`/`recvfrom` for `FD_READ`, `accept`
for `FD_ACCEPT`, a send that failed with `WSAEWOULDBLOCK` for `FD_WRITE` — and a re-enabling call
on a socket that is still ready posts again at once. Registration itself reports conditions that
already hold (a bound datagram socket gets its `FD_WRITE`), `FD_CONNECT` carries a refused
connection's error, and `FD_CLOSE` waits until the data in front of it has been read. Sockets are
re-examined every 5 ms while any registration exists, so traffic arriving while the game sits in
its message loop still wakes it.

## IPX

`socket(AF_IPX, SOCK_DGRAM, NSPROTO_IPX + n)` opens an IPX datagram socket sending packet type
`n`; its frames travel as NIC protocol 111 with the packet type in the header, in a socket-number
space of their own. Implemented: `SOCKADDR_IPX` everywhere an address crosses the ABI, dynamic
socket numbers from 0x4000, `SO_BROADCAST`, `IPX_PTYPE`, `IPX_FILTERTYPE`/`IPX_STOPFILTERPTYPE`,
`IPX_ADDRESS` (one adapter), `IPX_MAXSIZE` and `IPX_MAX_ADAPTER_NUM`. A datagram for a node or
network nobody in the room owns is sent and lost, as on a real segment. SPX is not offered.

## DirectPlay

`dplayx` carries DirectPlay over the same device, as its TCP/IP service provider
(`src/worker/modules/dplayx/`): `dplay-wire.ts` is the MS-DPDX framing, `dplay-sp.ts` the
session engine (name server, roster, message queue) and `directplay4.ts` the `IDirectPlay4A`
marshalling. Each DirectPlay object is an independent peer.

- **Discovery.** A host's name server answers `EnumSessions` on UDP 47624; enumeration
  broadcasts to the room, or unicasts when the connection carries a `DPAID_INet` address.
  `DPENUMSESSIONS_ASYNC` returns the cache and re-polls; a synchronous enumeration parks the
  calling thread for the timeout through the async-thunk path.
- **Sessions.** Peer-to-peer, as DirectPlay's default: the host admits joiners and hands out
  slots, then every peer talks to every other directly on one socket in 2300–2400.
  `Open(DPOPEN_JOIN)` parks the caller until the host answers (or returns `DPERR_CONNECTING`
  under `DPOPEN_RETURNSTATUS`).
- **Messages.** Anything past the 1400-byte MTU is fragmented with `DPSP_MSG_PACKET` and
  reassembled in any order. A full transmit ring defers datagrams in order rather than dropping
  them; there is no retransmission, because the link below is reliable.
- **Limits.** No host migration: a host leaving (or vanishing from the room) ends the session
  with `DPSYS_SESSIONLOST`. Lobby launching, secure sessions, chat and group-in-group
  membership are not implemented. EnumConnections lists only the TCP/IP provider; a game that
  initializes another provider's GUID gets the same LAN transport.
