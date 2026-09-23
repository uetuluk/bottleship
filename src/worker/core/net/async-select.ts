/**
 * WSAAsyncSelect's network-event record: which FD_* notifications a socket owes its window.
 *
 * Winsock posts each event once and then holds it until the application calls the matching
 * re-enabling function — recv/recvfrom for FD_READ, accept for FD_ACCEPT, a send that failed
 * with WSAEWOULDBLOCK for FD_WRITE. A re-enabling call on a socket whose condition still holds
 * posts again at once, which is how a game that reads one datagram per FD_READ drains a queue.
 * Games written against these rules (one read per message, sends deferred to FD_WRITE) stall
 * or flood if the record is wrong in either direction, so this follows it exactly.
 *
 * Data-only like NetStack: the owner supplies the post sink and drives poll() on a timer, so
 * the semantics are unit-testable without a window manager.
 */

import {
    SELECT_CLOSED,
    SELECT_CONNECTING,
    SELECT_DATA,
    SELECT_PENDING,
    SELECT_WRITABLE,
    WSAECONNRESET,
    type NetStack,
} from "./net-stack";

export const FD_READ = 0x01;
export const FD_WRITE = 0x02;
export const FD_OOB = 0x04;
export const FD_ACCEPT = 0x08;
export const FD_CONNECT = 0x10;
export const FD_CLOSE = 0x20;

/** Post `msg` to `hwnd` with wParam = socket and lParam = WSAMAKESELECTREPLY(event, error). */
export type SelectPost = (hwnd: number, msg: number, socket: number, lParam: number) => void;

interface Registration {
    hwnd: number;
    msg: number;
    events: number;
    /** Events that may post now; each is cleared when it posts and set by its re-enabler. */
    armed: number;
}

export class AsyncSelect {
    private registrations = new Map<number, Registration>();

    constructor(private readonly stack: NetStack, private readonly post: SelectPost) {}

    get active(): boolean {
        return this.registrations.size > 0;
    }

    has(socket: number): boolean {
        return this.registrations.has(socket);
    }

    /**
     * WSAAsyncSelect: replaces any earlier registration; events 0 cancels. Conditions that
     * already hold are reported straight away — a readable socket gets FD_READ and a writable
     * one FD_WRITE, exactly as if they had just become so.
     */
    select(socket: number, hwnd: number, msg: number, events: number): void {
        if (events === 0 || hwnd === 0) {
            this.registrations.delete(socket);
            return;
        }
        let armed = events & ~FD_CONNECT;
        // A connect already under way still owes its completion.
        if (this.stack.selectState(socket) & SELECT_CONNECTING) armed |= FD_CONNECT;
        this.registrations.set(socket, { hwnd, msg, events, armed });
        this.evaluate(socket);
    }

    forget(socket: number): void {
        this.registrations.delete(socket);
    }

    /** A socket accept() created inherits the listening socket's registration. */
    inherit(listener: number, accepted: number): void {
        const parent = this.registrations.get(listener);
        if (!parent) return;
        this.registrations.set(accepted, {
            hwnd: parent.hwnd,
            msg: parent.msg,
            events: parent.events,
            armed: parent.events & ~(FD_CONNECT | FD_ACCEPT),
        });
        this.evaluate(accepted);
    }

    /** The application called an event's re-enabling function. */
    reenable(socket: number, events: number): void {
        const registration = this.registrations.get(socket);
        if (!registration) return;
        registration.armed |= events;
        this.evaluate(socket);
    }

    poll(): void {
        for (const socket of this.registrations.keys()) this.evaluate(socket);
    }

    describe(): Array<Record<string, unknown>> {
        return [...this.registrations].map(([socket, r]) => ({
            socket,
            hwnd: `0x${r.hwnd.toString(16)}`,
            msg: `0x${r.msg.toString(16)}`,
            events: r.events,
            armed: r.armed,
        }));
    }

    private evaluate(socket: number): void {
        const r = this.registrations.get(socket);
        if (!r) return;
        const state = this.stack.selectState(socket);
        if (state < 0) {
            this.registrations.delete(socket);
            return;
        }
        const due = r.events & r.armed;
        if (due === 0) return;

        if ((due & FD_CONNECT) && !(state & SELECT_CONNECTING)) {
            if (state & SELECT_WRITABLE) {
                this.fire(r, socket, FD_CONNECT, 0);
            } else if (state & SELECT_CLOSED) {
                // A refused connect reports through FD_CONNECT alone, never FD_CLOSE.
                this.fire(r, socket, FD_CONNECT, this.stack.socketError(socket));
                r.armed &= ~FD_CLOSE;
                return;
            }
        }
        if ((due & FD_ACCEPT) && (state & SELECT_PENDING)) this.fire(r, socket, FD_ACCEPT, 0);
        if ((due & FD_READ) && (state & SELECT_DATA)) this.fire(r, socket, FD_READ, 0);
        if ((due & FD_WRITE) && (state & SELECT_WRITABLE)) this.fire(r, socket, FD_WRITE, 0);
        // Close is reported once the data before it has been read, and only once.
        if ((due & FD_CLOSE) && (state & SELECT_CLOSED) && !(state & SELECT_DATA)) {
            const error = this.stack.socketError(socket);
            this.fire(r, socket, FD_CLOSE, error === WSAECONNRESET ? error : 0);
        }
    }

    private fire(r: Registration, socket: number, event: number, error: number): void {
        r.armed &= ~event;
        this.post(r.hwnd, r.msg, socket, ((error & 0xffff) << 16 | event) >>> 0);
    }
}
