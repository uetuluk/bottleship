/**
 * Window-message histogram — counts (path, hwnd, msg) triples flowing through
 * PostMessage / DispatchMessage / SendMessage / CallWindowProc while armed.
 * Answers "which message is the guest pumping 40k times a second, to which
 * window, by which path — and who posts it" without a log capture (a broad log
 * regex amplifies a message storm). Each post key keeps one sampled JS stack.
 *
 * Zero-cost when disarmed: call sites check `msgStats.active` before note().
 */

/** peekKeep = a PeekMessage(PM_NOREMOVE) that returned the message (left queued). */
export type MsgPath = "post" | "peekKeep" | "dispatch" | "send" | "callproc";

class MsgStatsRegistry {
    active = false;
    private counts = new Map<string, number>();
    private postStacks = new Map<string, string>();
    private startedMs = 0;

    start(): void {
        this.counts.clear();
        this.postStacks.clear();
        this.startedMs = performance.now();
        this.active = true;
    }

    stop(): void {
        this.active = false;
    }

    note(path: MsgPath, hwnd: number, msg: number): void {
        const key = `${path}:${hwnd >>> 0}:${msg >>> 0}`;
        this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
        if (path === "post" && !this.postStacks.has(key)) {
            const stack = new Error().stack ?? "";
            this.postStacks.set(key, stack.split("\n").slice(2, 10).map((l) => l.trim()).join(" <- "));
        }
    }

    snapshot(top: number): { elapsedMs: number; total: number; rows: Array<{ path: string; hwnd: number; msg: number; count: number; perSec: number; postedFrom?: string }> } {
        const elapsedMs = this.startedMs ? performance.now() - this.startedMs : 0;
        let total = 0;
        const rows = [...this.counts.entries()].map(([key, count]) => {
            total += count;
            const [path, hwnd, msg] = key.split(":");
            return {
                path,
                hwnd: Number(hwnd),
                msg: Number(msg),
                count,
                perSec: elapsedMs > 0 ? Math.round((count * 1000) / elapsedMs) : 0,
                postedFrom: this.postStacks.get(key),
            };
        });
        rows.sort((a, b) => b.count - a.count);
        return { elapsedMs: Math.round(elapsedMs), total, rows: rows.slice(0, top) };
    }
}

export const msgStats = new MsgStatsRegistry();
