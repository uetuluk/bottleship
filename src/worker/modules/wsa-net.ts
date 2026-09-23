/**
 * Live Winsock implementation over the virtual NIC.
 *
 * The stub path in wsa-stub-shared.ts stays exactly as it was: with no network provider
 * attached a game still starts up, resolves names to loopback and finds nothing to talk to.
 * When a provider is attached and the link is up, socket() hands out an id from this layer
 * instead, and every later call recognises its own ids and does real I/O.
 *
 * Marshalling lives here rather than in NetStack so the stack stays free of guest pointers
 * and remains unit-testable (tools/tests/net-stack.test.ts).
 */

import { Mem } from "../core/memory/mem-accessor";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { System } from "../core/system";
import { TimeService } from "../runtime/time";
import { TimerKind } from "../core/scheduler/types";
import { getVirtualNic } from "../core/net/virtual-nic";
import {
    getNetStack,
    FAMILY_INET,
    FAMILY_IPX,
    SOCK_DGRAM,
    SOCK_STREAM,
    WSAEAFNOSUPPORT,
    WSAEFAULT,
    WSAEHOSTUNREACH,
    WSAEINVAL,
    WSAEMSGSIZE,
    WSAENOTSOCK,
    WSAEWOULDBLOCK,
    errorOf,
    isError,
} from "../core/net/net-stack";
import { AsyncSelect, FD_ACCEPT, FD_CONNECT, FD_READ, FD_WRITE } from "../core/net/async-select";
import { VLAN_BROADCAST_HOST, VLAN_PREFIX, hostToIp, resolveDestination } from "../../net/nic-contract";

const INVALID_SOCKET = -1;
const SOCKET_ERROR = -1;
const AF_INET = 2;
const AF_IPX = 6;
const SOCKADDR_IN_SIZE = 16;
const SOCKADDR_IPX_SIZE = 14;

const WSAEPROTONOSUPPORT = 10043;
const WSAESOCKTNOSUPPORT = 10044;
const WSAENOPROTOOPT = 10042;

/** socket(AF_IPX, SOCK_DGRAM, NSPROTO_IPX + n) opens an IPX socket sending packet type n. */
const NSPROTO_IPX = 1000;
const IPX_PTYPE = 0x4000;
const IPX_FILTERTYPE = 0x4001;
const IPX_STOPFILTERPTYPE = 0x4003;
const IPX_MAXSIZE = 0x4006;
const IPX_ADDRESS = 0x4007;
const IPX_MAX_ADAPTER_NUM = 0x400d;
const IPX_ADDRESS_DATA_SIZE = 24;
/** IPX_ADDRESS_DATA.linkspeed is in 100 bps units: a 10 Mbit LAN. */
const IPX_LINK_SPEED = 100000;

/** Winsock SOCK_* values; the guest passes these to socket(). */
const GUEST_SOCK_STREAM = 1;
const GUEST_SOCK_DGRAM = 2;

const SOL_SOCKET = 0xffff;
const SO_REUSEADDR = 0x0004;
const SO_BROADCAST = 0x0020;
const SO_SNDBUF = 0x1001;
const SO_RCVBUF = 0x1002;
const SO_ERROR = 0x1007;
const SO_TYPE = 0x1008;
const SO_MAX_MSG_SIZE = 0x2003;

const FIONREAD = 0x4004667f;
const FIONBIO = 0x8004667e;

/** One packet's worth of staging, reused so recv/send do not allocate per call. */
const scratch = new Uint8Array(64 * 1024);

/** True when a provider is attached and has given us an address. */
export function netLinkUp(): boolean {
    return getVirtualNic().linkUp;
}

/** True when this socket id was handed out by the live stack rather than the offline stub. */
export function netOwns(socket: number): boolean {
    return getVirtualNic().attached && getNetStack().has(socket >>> 0);
}

/** Our LAN address as the four bytes a hostent's h_addr_list wants, or null when offline. */
export function netLocalAddrBytes(): Uint8Array | null {
    const nic = getVirtualNic();
    if (!nic.linkUp) return null;
    const ip = nic.localIp;
    return new Uint8Array([(ip >>> 24) & 0xff, (ip >>> 16) & 0xff, (ip >>> 8) & 0xff, ip & 0xff]);
}

// ─── sockaddr_in marshalling ─────────────────────────────────────────────────

interface SockAddr {
    port: number;
    /** IPv4 address in host byte order. */
    addr: number;
}

/** sin_port and sin_addr are network byte order inside the struct; the rest is little-endian. */
function readSockaddr(ptr: number, len: number): SockAddr | null {
    if (!ptr || len < 8) return null;
    const bytes = Mem.readBytes(ptr, 8);
    if (!bytes) return null;
    const family = bytes[0]! | (bytes[1]! << 8);
    if (family !== AF_INET && family !== 0) return null;
    return {
        port: ((bytes[2]! << 8) | bytes[3]!) & 0xffff,
        addr: ((bytes[4]! << 24) | (bytes[5]! << 16) | (bytes[6]! << 8) | bytes[7]!) >>> 0,
    };
}

function writeSockaddr(ptr: number, addr: number, port: number): boolean {
    if (!ptr) return false;
    const bytes = new Uint8Array(SOCKADDR_IN_SIZE);
    bytes[0] = AF_INET;
    bytes[2] = (port >>> 8) & 0xff;
    bytes[3] = port & 0xff;
    bytes[4] = (addr >>> 24) & 0xff;
    bytes[5] = (addr >>> 16) & 0xff;
    bytes[6] = (addr >>> 8) & 0xff;
    bytes[7] = addr & 0xff;
    return Mem.writeBytes(ptr, bytes) === SOCKADDR_IN_SIZE;
}

/** Fill a caller's sockaddr + its length-in/out, honouring a buffer smaller than the struct. */
function writeSockaddrOut(namePtr: number, lenPtr: number, addr: number, port: number): boolean {
    if (!namePtr || !lenPtr) return true;  // both optional on accept/recvfrom
    const avail = Mem.readInt32(lenPtr) ?? 0;
    if (avail < SOCKADDR_IN_SIZE) return false;
    if (!writeSockaddr(namePtr, addr, port)) return false;
    return Mem.writeUint32(lenPtr, SOCKADDR_IN_SIZE);
}

/**
 * Which peer a guest address refers to. Loopback and our own address both mean "this guest",
 * which keeps a game that connects to 127.0.0.1 working exactly as it did offline.
 */
function destinationHost(addr: number): number | null {
    const nic = getVirtualNic();
    if ((addr >>> 24) === 127) return nic.localHost;
    if (addr === nic.localIp) return nic.localHost;
    return resolveDestination(addr);
}

// ─── SOCKADDR_IPX marshalling ────────────────────────────────────────────────
//
// The room is one IPX network. Its number is the LAN's IPv4 prefix and each guest's node
// address a locally administered MAC carrying its LAN address (02:00:0a:4d:00:HH), so an IPX
// address maps onto a host octet with no lookup table and reads sensibly in a packet dump.

const IPX_NODE_BROADCAST = 0xff;

function writeIpxNet(out: Uint8Array, off: number): void {
    out[off] = (VLAN_PREFIX >>> 24) & 0xff;
    out[off + 1] = (VLAN_PREFIX >>> 16) & 0xff;
    out[off + 2] = (VLAN_PREFIX >>> 8) & 0xff;
    out[off + 3] = VLAN_PREFIX & 0xff;
}

function writeIpxNode(out: Uint8Array, off: number, host: number): void {
    const ip = hostToIp(host);
    out[off] = 0x02;
    out[off + 1] = 0x00;
    out[off + 2] = (ip >>> 24) & 0xff;
    out[off + 3] = (ip >>> 16) & 0xff;
    out[off + 4] = (ip >>> 8) & 0xff;
    out[off + 5] = ip & 0xff;
}

interface IpxAddr {
    /** Destination host octet, or null for a node or network nobody in the room answers to. */
    host: number | null;
    socket: number;
}

function readSockaddrIpx(ptr: number, len: number): IpxAddr | null {
    if (!ptr || len < SOCKADDR_IPX_SIZE) return null;
    const b = Mem.readBytes(ptr, SOCKADDR_IPX_SIZE);
    if (!b) return null;
    const family = b[0]! | (b[1]! << 8);
    if (family !== AF_IPX) return null;
    const socket = ((b[12]! << 8) | b[13]!) & 0xffff;
    const net = ((b[2]! << 24) | (b[3]! << 16) | (b[4]! << 8) | b[5]!) >>> 0;
    // Network 0 means "this network"; any other than ours would need an IPX router.
    if (net !== 0 && net !== VLAN_PREFIX) return { host: null, socket };
    let broadcast = true;
    for (let i = 6; i < 12; i++) if (b[i] !== IPX_NODE_BROADCAST) broadcast = false;
    if (broadcast) return { host: VLAN_BROADCAST_HOST, socket };
    if (b[6] !== 0x02 || b[7] !== 0x00) return { host: null, socket };
    const ip = ((b[8]! << 24) | (b[9]! << 16) | (b[10]! << 8) | b[11]!) >>> 0;
    return { host: destinationHost(ip), socket };
}

function writeSockaddrIpxOut(namePtr: number, lenPtr: number, host: number, socket: number): boolean {
    if (!namePtr || !lenPtr) return true;
    const avail = Mem.readInt32(lenPtr) ?? 0;
    if (avail < SOCKADDR_IPX_SIZE) return false;
    const bytes = new Uint8Array(SOCKADDR_IPX_SIZE);
    bytes[0] = AF_IPX;
    writeIpxNet(bytes, 2);
    writeIpxNode(bytes, 6, host);
    bytes[12] = (socket >>> 8) & 0xff;
    bytes[13] = socket & 0xff;
    if (Mem.writeBytes(namePtr, bytes) !== SOCKADDR_IPX_SIZE) return false;
    return Mem.writeUint32(lenPtr, SOCKADDR_IPX_SIZE);
}

/** Either family's peer address, sized to what the socket speaks. */
function writePeerOut(socket: number, namePtr: number, lenPtr: number, host: number, port: number): boolean {
    return getNetStack().family(socket) === FAMILY_IPX
        ? writeSockaddrIpxOut(namePtr, lenPtr, host, port)
        : writeSockaddrOut(namePtr, lenPtr, hostToIp(host), port);
}

/** IPX_ADDRESS: the one adapter this guest has, on the room's network. */
function writeIpxAddressData(ptr: number, len: number): number {
    if (len < IPX_ADDRESS_DATA_SIZE) return WSAEFAULT;
    const adapter = Mem.readInt32(ptr) ?? -1;
    if (adapter !== 0) return WSAEINVAL;
    const out = new Uint8Array(IPX_ADDRESS_DATA_SIZE);
    const view = new DataView(out.buffer);
    writeIpxNet(out, 4);
    writeIpxNode(out, 8, getVirtualNic().localHost);
    out[14] = 0;  // wan
    out[15] = 1;  // status: up
    view.setInt32(16, getVirtualNic().mtu, true);
    view.setUint32(20, IPX_LINK_SPEED, true);
    return Mem.writeBytes(ptr, out) === IPX_ADDRESS_DATA_SIZE ? 0 : WSAEFAULT;
}

// ─── WSAAsyncSelect ──────────────────────────────────────────────────────────

const WM_NULL = 0;
/** How often registered sockets are re-examined; the network moves between guest calls. */
const ASYNC_SELECT_POLL_MS = 5;

let asyncSelect: AsyncSelect | null = null;
let asyncSelectTimer = 0;

function postSelectEvent(hwnd: number, msg: number, socket: number, lParam: number): void {
    const system = System.getInstance();
    system.windowManager.postMessage(hwnd, msg, socket, lParam);
    system.scheduler.wakeMessageWaiters();
}

function getAsyncSelect(): AsyncSelect {
    if (!asyncSelect) asyncSelect = new AsyncSelect(getNetStack(), postSelectEvent);
    return asyncSelect;
}

/** Keep the poll running exactly while some socket has a registration. */
function syncAsyncSelectTimer(): void {
    const wheel = System.getInstance().scheduler.timerWheel;
    const wanted = asyncSelect?.active ?? false;
    if (wanted && asyncSelectTimer === 0) {
        asyncSelectTimer = wheel.add(ASYNC_SELECT_POLL_MS, true, TimerKind.NET_POLL, pollAsyncSelect,
            TimeService.getInstance().nowMs());
    } else if (!wanted && asyncSelectTimer !== 0) {
        wheel.cancel(asyncSelectTimer);
        asyncSelectTimer = 0;
    }
}

function pollAsyncSelect(): void {
    if (System.getInstance().isExiting) return;
    netPump();
    asyncSelect?.poll();
    syncAsyncSelectTimer();
}

/** A re-enabling Winsock call happened on a live socket (see AsyncSelect). */
function reenable(socket: number, events: number): void {
    asyncSelect?.reenable(socket, events);
}

/** Registrations, for the harness. */
export function netAsyncSelectState(): Array<Record<string, unknown>> {
    return asyncSelect?.describe() ?? [];
}

// ─── exports ─────────────────────────────────────────────────────────────────

export function makeNetSocketExports(setLastError: (code: number) => void): Record<string, ThunkImplementation> {
    /** Map a stack result onto Winsock's "SOCKET_ERROR plus WSAGetLastError" convention. */
    const settle = (result: number, success: number = result): number => {
        if (isError(result)) {
            setLastError(errorOf(result));
            return SOCKET_ERROR;
        }
        setLastError(0);
        return success;
    };

    const open: ThunkImplementation = (_ctx, _mem, args) => {
        const af = args[0] | 0;
        const type = args[1] | 0;
        const protocol = args[2] | 0;
        if (af === AF_IPX) return openIpx(type, protocol);
        if (af !== AF_INET && af !== 0) {
            setLastError(WSAEAFNOSUPPORT);
            return INVALID_SOCKET;
        }
        const mapped = type === GUEST_SOCK_STREAM ? SOCK_STREAM : type === GUEST_SOCK_DGRAM ? SOCK_DGRAM : 0;
        if (mapped === 0) {
            setLastError(WSAEAFNOSUPPORT);
            return INVALID_SOCKET;
        }
        const id = getNetStack().open(mapped);
        if (isError(id)) {
            setLastError(errorOf(id));
            return INVALID_SOCKET;
        }
        setLastError(0);
        return id;
    };

    /** IPX is datagrams only here; SPX (SOCK_SEQPACKET/SOCK_STREAM over NSPROTO_SPX) is not offered. */
    const openIpx = (type: number, protocol: number): number => {
        if (type !== GUEST_SOCK_DGRAM) {
            setLastError(WSAESOCKTNOSUPPORT);
            return INVALID_SOCKET;
        }
        if (protocol !== 0 && (protocol < NSPROTO_IPX || protocol > NSPROTO_IPX + 255)) {
            setLastError(WSAEPROTONOSUPPORT);
            return INVALID_SOCKET;
        }
        const stack = getNetStack();
        const id = stack.open(SOCK_DGRAM, FAMILY_IPX);
        if (isError(id)) {
            setLastError(errorOf(id));
            return INVALID_SOCKET;
        }
        stack.setIpxPacketType(id, protocol === 0 ? 0 : protocol - NSPROTO_IPX);
        setLastError(0);
        return id;
    };

    /** The sockaddr a call names, in the socket's own family: host octet (or null) plus port. */
    const readTarget = (socket: number, ptr: number, len: number): { host: number | null; port: number } | null => {
        if (getNetStack().family(socket) === FAMILY_IPX) {
            const ipx = readSockaddrIpx(ptr, len);
            return ipx ? { host: ipx.host, port: ipx.socket } : null;
        }
        const name = readSockaddr(ptr, len);
        return name ? { host: destinationHost(name.addr), port: name.port } : null;
    };

    return {
        socket: open,
        WSASocketA: open,
        WSASocketW: open,

        closesocket: (_ctx, _mem, args) => {
            const socket = args[0] >>> 0;
            asyncSelect?.forget(socket);
            return settle(getNetStack().close(socket), 0);
        },

        bind: (_ctx, _mem, args) => {
            const stack = getNetStack();
            stack.pump();
            const socket = args[0] >>> 0;
            // Only the port (IPX: socket number) is ours to choose; the address is the adapter's.
            const name = readTarget(socket, args[1] >>> 0, args[2] >>> 0);
            if (!name) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            return settle(stack.bind(socket, name.port), 0);
        },

        connect: (_ctx, _mem, args) => {
            const stack = getNetStack();
            stack.pump();
            const socket = args[0] >>> 0;
            const name = readTarget(socket, args[1] >>> 0, args[2] >>> 0);
            if (!name) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            if (name.host === null) {
                setLastError(WSAEHOSTUNREACH);
                return SOCKET_ERROR;
            }
            const result = stack.connect(socket, name.host, name.port);
            reenable(socket, FD_CONNECT | FD_WRITE);
            return settle(result, 0);
        },

        listen: (_ctx, _mem, args) => settle(getNetStack().listen(args[0] >>> 0, args[1] | 0), 0),

        accept: (_ctx, _mem, args) => {
            const stack = getNetStack();
            stack.pump();
            const listener = args[0] >>> 0;
            const result = stack.accept(listener);
            reenable(listener, FD_ACCEPT);
            if (typeof result === "number") {
                setLastError(errorOf(result));
                return INVALID_SOCKET;
            }
            const namePtr = args[1] >>> 0;
            const lenPtr = args[2] >>> 0;
            if (namePtr && !writeSockaddrOut(namePtr, lenPtr, hostToIp(result.host), result.port)) {
                stack.close(result.id);
                setLastError(WSAEFAULT);
                return INVALID_SOCKET;
            }
            asyncSelect?.inherit(listener, result.id);
            setLastError(0);
            return result.id;
        },

        send: (_ctx, _mem, args) => {
            const stack = getNetStack();
            stack.pump();
            const length = args[2] | 0;
            const payload = readPayload(args[1] >>> 0, length);
            if (!payload) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            const sent = stack.send(args[0] >>> 0, payload);
            if (sent === -WSAEWOULDBLOCK) reenable(args[0] >>> 0, FD_WRITE);
            return settle(sent, sent);
        },

        sendto: (_ctx, _mem, args) => {
            const stack = getNetStack();
            stack.pump();
            const length = args[2] | 0;
            const payload = readPayload(args[1] >>> 0, length);
            if (!payload) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            const socket = args[0] >>> 0;
            const toPtr = args[4] >>> 0;
            const to = toPtr ? readTarget(socket, toPtr, args[5] >>> 0) : null;
            if (toPtr && !to) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            if (!to) return settle(stack.send(socket, payload));
            if (to.host === null) {
                // IPX has no unreachable reply: a datagram for a node nobody is goes out and is lost.
                if (stack.family(socket) === FAMILY_IPX) return settle(payload.length, payload.length);
                setLastError(WSAEHOSTUNREACH);
                return SOCKET_ERROR;
            }
            const sent = stack.sendTo(socket, to.host, to.port, payload);
            if (sent === -WSAEWOULDBLOCK) reenable(socket, FD_WRITE);
            return settle(sent, sent);
        },

        recv: (_ctx, _mem, args) => {
            const stack = getNetStack();
            stack.pump();
            const bufPtr = args[1] >>> 0;
            const length = Math.min(args[2] | 0, scratch.length);
            if (length < 0 || !bufPtr) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            const peek = (args[3] & 0x2) !== 0;  // MSG_PEEK
            const received = stack.recv(args[0] >>> 0, scratch.subarray(0, length), peek);
            reenable(args[0] >>> 0, FD_READ);
            if (isError(received)) {
                setLastError(errorOf(received));
                return SOCKET_ERROR;
            }
            if (received > 0 && Mem.writeBytes(bufPtr, scratch.subarray(0, received)) !== received) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            setLastError(0);
            return received;
        },

        recvfrom: (_ctx, _mem, args) => {
            const stack = getNetStack();
            stack.pump();
            const bufPtr = args[1] >>> 0;
            const length = Math.min(args[2] | 0, scratch.length);
            if (length < 0 || !bufPtr) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            const peek = (args[3] & 0x2) !== 0;
            const socket = args[0] >>> 0;
            const result = stack.recvFrom(socket, scratch.subarray(0, length), peek);
            reenable(socket, FD_READ);
            if (typeof result === "number") {
                setLastError(errorOf(result));
                return SOCKET_ERROR;
            }
            if (result.length > 0 && Mem.writeBytes(bufPtr, scratch.subarray(0, result.length)) !== result.length) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            if (!writePeerOut(socket, args[4] >>> 0, args[5] >>> 0, result.host, result.port)) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            if (result.truncated) {
                // The data stays in the caller's buffer; Winsock still reports the overflow.
                setLastError(WSAEMSGSIZE);
                return SOCKET_ERROR;
            }
            setLastError(0);
            return result.length;
        },

        shutdown: (_ctx, _mem, args) => settle(getNetStack().shutdown(args[0] >>> 0, args[1] | 0), 0),

        setsockopt: (_ctx, _mem, args) => {
            const socket = args[0] >>> 0;
            const level = args[1] | 0;
            const option = args[2] | 0;
            const valuePtr = args[3] >>> 0;
            const value = valuePtr ? (Mem.readInt32(valuePtr) ?? 0) : 0;
            if (level === SOL_SOCKET) {
                if (option === SO_BROADCAST) getNetStack().setBroadcast(socket, value !== 0);
                else if (option === SO_REUSEADDR) getNetStack().setReuseAddr(socket, value !== 0);
            } else if (level === NSPROTO_IPX) {
                const stack = getNetStack();
                if (stack.family(socket) !== FAMILY_IPX) {
                    setLastError(WSAENOPROTOOPT);
                    return SOCKET_ERROR;
                }
                if (option === IPX_PTYPE) stack.setIpxPacketType(socket, value);
                else if (option === IPX_FILTERTYPE) stack.setIpxFilter(socket, value & 0xff);
                else if (option === IPX_STOPFILTERPTYPE) stack.setIpxFilter(socket, -1);
                // IPX_DSTYPE, IPX_EXTENDED_ADDRESS, IPX_RECVHDR and friends shape headers this
                // transport never exposes; accepting them leaves datagrams as the game expects.
            }
            // Buffer sizes, linger, nodelay and friends are accepted and ignored: our link has
            // no send window to tune and no Nagle to disable.
            setLastError(0);
            return 0;
        },

        getsockopt: (_ctx, _mem, args) => {
            const socket = args[0] >>> 0;
            const level = args[1] | 0;
            const option = args[2] | 0;
            const valuePtr = args[3] >>> 0;
            const lenPtr = args[4] >>> 0;
            if (!valuePtr || !lenPtr) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            const stack = getNetStack();
            let value = 0;
            if (level === SOL_SOCKET) {
                switch (option) {
                    case SO_BROADCAST: value = stack.getBroadcast(socket) ? 1 : 0; break;
                    // How a game learns the outcome of a non-blocking connect.
                    case SO_ERROR: value = stack.socketError(socket); break;
                    case SO_TYPE: value = stack.type(socket) === SOCK_STREAM ? GUEST_SOCK_STREAM : GUEST_SOCK_DGRAM; break;
                    case SO_SNDBUF:
                    case SO_RCVBUF: value = 65536; break;
                    case SO_MAX_MSG_SIZE: value = getVirtualNic().mtu; break;
                    default: value = 0; break;
                }
            } else if (level === NSPROTO_IPX) {
                if (stack.family(socket) !== FAMILY_IPX) {
                    setLastError(WSAENOPROTOOPT);
                    return SOCKET_ERROR;
                }
                switch (option) {
                    case IPX_ADDRESS: {
                        const error = writeIpxAddressData(valuePtr, Mem.readInt32(lenPtr) ?? 0);
                        if (error !== 0 || !Mem.writeUint32(lenPtr, IPX_ADDRESS_DATA_SIZE)) {
                            setLastError(error || WSAEFAULT);
                            return SOCKET_ERROR;
                        }
                        setLastError(0);
                        return 0;
                    }
                    case IPX_PTYPE: value = stack.getIpxPacketType(socket); break;
                    case IPX_MAXSIZE: value = getVirtualNic().mtu; break;
                    case IPX_MAX_ADAPTER_NUM: value = 1; break;
                    default:
                        setLastError(WSAENOPROTOOPT);
                        return SOCKET_ERROR;
                }
            }
            if (!Mem.writeUint32(valuePtr, value) || !Mem.writeUint32(lenPtr, 4)) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            setLastError(0);
            return 0;
        },

        ioctlsocket: (_ctx, _mem, args) => {
            const socket = args[0] >>> 0;
            const command = args[1] >>> 0;
            const argPtr = args[2] >>> 0;
            const stack = getNetStack();
            stack.pump();
            if (command === FIONBIO) {
                stack.setNonBlocking(socket, (argPtr ? (Mem.readInt32(argPtr) ?? 0) : 0) !== 0);
                setLastError(0);
                return 0;
            }
            if (command === FIONREAD) {
                if (!argPtr || !Mem.writeUint32(argPtr, stack.available(socket))) {
                    setLastError(WSAEFAULT);
                    return SOCKET_ERROR;
                }
                setLastError(0);
                return 0;
            }
            setLastError(0);
            return 0;
        },

        getsockname: (_ctx, _mem, args) => {
            const stack = getNetStack();
            const socket = args[0] >>> 0;
            if (!writePeerOut(socket, args[1] >>> 0, args[2] >>> 0, getVirtualNic().localHost, stack.localPort(socket))) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            setLastError(0);
            return 0;
        },

        getpeername: (_ctx, _mem, args) => {
            const remote = getNetStack().remote(args[0] >>> 0);
            if (!remote) {
                setLastError(10057); // WSAENOTCONN
                return SOCKET_ERROR;
            }
            if (!writePeerOut(args[0] >>> 0, args[1] >>> 0, args[2] >>> 0, remote.host, remote.port)) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            setLastError(0);
            return 0;
        },

        WSAAsyncSelect: (_ctx, _mem, args) => {
            const socket = args[0] >>> 0;
            const hwnd = args[1] >>> 0;
            const msg = args[2] >>> 0;
            const events = args[3] >>> 0;
            const stack = getNetStack();
            stack.pump();
            if (events !== 0 && (hwnd === 0 || msg === WM_NULL)) {
                setLastError(WSAEINVAL);
                return SOCKET_ERROR;
            }
            // Registering makes the socket non-blocking, and it stays so after a cancel.
            stack.setNonBlocking(socket, true);
            getAsyncSelect().select(socket, hwnd, msg, events);
            syncAsyncSelectTimer();
            setLastError(0);
            return 0;
        },

        WSAIoctl: (_ctx, _mem, args) => {
            const socket = args[0] >>> 0;
            const code = args[1] >>> 0;
            const outBuf = args[4] >>> 0;
            const outLen = args[5] >>> 0;
            const returnedPtr = args[6] >>> 0;
            const stack = getNetStack();
            stack.pump();

            let returned = 0;
            if (code === FIONREAD && outBuf && outLen >= 4) {
                if (!Mem.writeUint32(outBuf, stack.available(socket))) {
                    setLastError(WSAEFAULT);
                    return SOCKET_ERROR;
                }
                returned = 4;
            } else if (code === FIONBIO) {
                const inBuf = args[2] >>> 0;
                stack.setNonBlocking(socket, (inBuf ? (Mem.readInt32(inBuf) ?? 0) : 0) !== 0);
            }
            if (returnedPtr && !Mem.writeUint32(returnedPtr, returned)) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            setLastError(0);
            return 0;
        },
    };
}

function readPayload(ptr: number, length: number): Uint8Array | null {
    if (length < 0) return null;
    if (length === 0) return scratch.subarray(0, 0);
    if (!ptr) return null;
    return Mem.readBytes(ptr, length);
}

/** Readiness for select(); returns null when the socket is not ours so the stub can answer. */
export function netReadiness(socket: number): { read: boolean; write: boolean; except: boolean } | null {
    if (!netOwns(socket)) return null;
    const stack = getNetStack();
    return { read: stack.readable(socket), write: stack.writable(socket), except: stack.failed(socket) };
}

/** Pump the stack from outside a socket call, so a game polling only via select sees data. */
export function netPump(): void {
    if (getVirtualNic().attached) getNetStack().pump();
}

export function netReset(): void {
    if (asyncSelectTimer !== 0) {
        System.getInstance().scheduler?.timerWheel.cancel(asyncSelectTimer);
        asyncSelectTimer = 0;
    }
    asyncSelect = null;
    getNetStack().reset();
    Logger.log(LogCategory.SYSTEM, "[net] socket state reset");
}

export { WSAENOTSOCK };
