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
import { getVirtualNic } from "../core/net/virtual-nic";
import {
    NetStack,
    SOCK_DGRAM,
    SOCK_STREAM,
    WSAEAFNOSUPPORT,
    WSAEFAULT,
    WSAEHOSTUNREACH,
    WSAEMSGSIZE,
    WSAENOTSOCK,
    errorOf,
    isError,
} from "../core/net/net-stack";
import { hostToIp, resolveDestination } from "../../net/nic-contract";

const INVALID_SOCKET = -1;
const SOCKET_ERROR = -1;
const AF_INET = 2;
const SOCKADDR_IN_SIZE = 16;

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

const FIONREAD = 0x4004667f;
const FIONBIO = 0x8004667e;

/** One packet's worth of staging, reused so recv/send do not allocate per call. */
const scratch = new Uint8Array(64 * 1024);

let stack: NetStack | null = null;

export function getNetStack(): NetStack {
    if (!stack) stack = new NetStack(getVirtualNic());
    return stack;
}

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

    return {
        socket: open,
        WSASocketA: open,
        WSASocketW: open,

        closesocket: (_ctx, _mem, args) => settle(getNetStack().close(args[0] >>> 0), 0),

        bind: (_ctx, _mem, args) => {
            const stack = getNetStack();
            stack.pump();
            const name = readSockaddr(args[1] >>> 0, args[2] >>> 0);
            if (!name) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            return settle(stack.bind(args[0] >>> 0, name.port), 0);
        },

        connect: (_ctx, _mem, args) => {
            const stack = getNetStack();
            stack.pump();
            const name = readSockaddr(args[1] >>> 0, args[2] >>> 0);
            if (!name) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            const host = destinationHost(name.addr);
            if (host === null) {
                setLastError(WSAEHOSTUNREACH);
                return SOCKET_ERROR;
            }
            return settle(stack.connect(args[0] >>> 0, host, name.port), 0);
        },

        listen: (_ctx, _mem, args) => settle(getNetStack().listen(args[0] >>> 0, args[1] | 0), 0),

        accept: (_ctx, _mem, args) => {
            const stack = getNetStack();
            stack.pump();
            const result = stack.accept(args[0] >>> 0);
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
            const to = readSockaddr(args[4] >>> 0, args[5] >>> 0);
            if (!to) return settle(stack.send(args[0] >>> 0, payload));
            const host = destinationHost(to.addr);
            if (host === null) {
                setLastError(WSAEHOSTUNREACH);
                return SOCKET_ERROR;
            }
            const sent = stack.sendTo(args[0] >>> 0, host, to.port, payload);
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
            const result = stack.recvFrom(args[0] >>> 0, scratch.subarray(0, length), peek);
            if (typeof result === "number") {
                setLastError(errorOf(result));
                return SOCKET_ERROR;
            }
            if (result.length > 0 && Mem.writeBytes(bufPtr, scratch.subarray(0, result.length)) !== result.length) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            if (!writeSockaddrOut(args[4] >>> 0, args[5] >>> 0, hostToIp(result.host), result.port)) {
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
            let value = 0;
            if (level === SOL_SOCKET) {
                switch (option) {
                    case SO_BROADCAST: value = getNetStack().getBroadcast(socket) ? 1 : 0; break;
                    // How a game learns the outcome of a non-blocking connect.
                    case SO_ERROR: value = getNetStack().failed(socket) ? 10061 : 0; break;
                    case SO_TYPE: value = GUEST_SOCK_DGRAM; break;
                    case SO_SNDBUF:
                    case SO_RCVBUF: value = 65536; break;
                    default: value = 0; break;
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
            if (!writeSockaddrOut(args[1] >>> 0, args[2] >>> 0, getVirtualNic().localIp, stack.localPort(args[0] >>> 0))) {
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
            if (!writeSockaddrOut(args[1] >>> 0, args[2] >>> 0, hostToIp(remote.host), remote.port)) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
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
    if (stack) stack.reset();
    Logger.log(LogCategory.SYSTEM, "[net] socket state reset");
}

export { WSAENOTSOCK };
