# Handoff — Tiberian Sun "save freezes the instance"

Worktree: `.claude/worktrees/ts-save-crash`, branch `worktree-ts-save-crash`, based on `c2ff0f6`.
Nothing is committed. **Freeze fix verified live on 2026-09-20.** Quality gate clean;
**868 tests pass across 81 files**. Scope confirmed by the user: fix the freeze only;
standard Edit-control text entry and save-file persistence verification are deferred.

---

## 1. The bug, root-caused

Saving in Command & Conquer: Tiberian Sun freezes the emulator at 0 FPS with **no fault** —
which is why nothing ever showed up in the logs.

It is a **livelock caused by the suspended-callback-frame pin**, not a crash.

`CallbackManager.allocateSuspendedFrame` (`callback-manager.ts:794`) calls
`scheduler.pinCurrentThread()` for every frame it pushes, and `releaseFrame` (`:871`) unpins.
The scheduler refuses preemption while pinned, at three gates:

- `scheduler.ts:702` — `onThunkBoundary` step 5
- `scheduler.ts:907` — `preemptAtTickBoundary` step 7
- `thunk-dispatcher.ts:2538` — cross-thread async completion skips `requestSwitchToThread`

TS's save dialog runs a WndProc that **polls** state the winmm timer thread (T2, callback
`0x6a4e10`) produces. Measured live at the freeze:

```
3 live frames on T1, strictly nested (0x11ff4b4 > 0x11ff190 > 0x11ff140)
  DispatchMessageW -> CallWindowProcA -> CallWindowProcA
T1: RUNNING, kernelPinCount = 3     T2: READY, kernelPinCount = 0, in runQueue
thunkTrace: WaitForSingleObject(0x3000c)->0 / ReleaseMutex(0x3000c)->1  ... 5 mutexes, forever
```

The mutexes are genuinely uncontended (`describeHandle` => `mutex(owner=none)`, signaled), so
`WAIT_OBJECT_0` is **correct** — there is no mutex bug. The wait never blocks, so T1 never
leaves `RUNNING`, so the existing escape hatch (`state === WAITING`, added for the Diablo II
"File Read Error") never fires, so the pin never lifts, so T2 never runs, so the polled state
never changes.

**Proof:** setting `T1.kernelPinCount = 0` in the live worker flipped `currentThreadId` 1 → 2
instantly and T2 resumed its timer callback.

### The pin protects our plumbing, not a Windows semantic

The comment at `callback-manager.ts:794` ("On real Windows, APIs like EnumWindows are
synchronous — the callback runs on the calling thread with no preemption points") is wrong as a
statement about Windows: those callbacks are ordinary ring-3 code, preemptible at any interrupt.
"Synchronous" means same-thread-before-return, not non-preemptible. So pinning across
*arbitrary guest code inside a callback* is over-broad by construction.

A second opinion (Fable) traced what actually breaks on a mid-callback switch. Verified safe:
frame resolution is by `frameId` with an owner-thread check (`:520`, `:541`), completion is a
direct per-frame register restore (`:578`), `lastExpectedEspAfterReturn` is per-thread via
`onThreadSwitch`, `redirectStackToSpinLoop` writes the owner's own stack. Two real dependencies:

- **U1** — the host-macrotask dialog pump (`dialog.ts:979` `pumpStep`, fired from `setTimeout`)
  calls `invokeCallback` and writes **live** `cpu.reg32[4]` / `instruction_pointer`
  (`callback-manager.ts:1179-1189`) with no current-thread guard anywhere in `dialog.ts`
  (zero grep hits for `getCurrentThreadId`). The pin is what keeps the owner current.
- **U2** — two **global** frame lookups: `getTopSuspendedFrameId()` and
  `hasSavedThunkContext()` (global `frameStackDepth > 0`). Once two threads can hold live
  frames at once, these hand thread B thread A's frame.

Full Fable analysis is summarized in §5.

---

## 2. What is DONE and verified

### 2a. Orphaned-frame reaping — real bug, but NOT the freeze
`callback-manager.ts`: `reapUnwoundFrames()`, called from `allocateSuspendedFrame`.
The x86 stack grows down, so nested frames on one thread must have strictly decreasing entry
ESPs; a frame at or above an incoming one was unwound past without returning through its stub
(SEH unwind / longjmp / modal teardown) and is provably dead. Reaping it releases its pin and
pending callbacks.

Verified live: the frame stack went from **8 deep with an ESP inversion** to **3 deep and
strictly nested**. Also refactored the duplicated pending-callback cleanup into
`releasePendingCallbacksForFrame()`.

**Be clear about this:** it fixes a genuine leak, but the game still froze afterwards. It is
adjacent to the freeze, not its cause. Keep it; do not present it as the fix.

Tests: `tools/tests/callback-frame-reap.test.ts` (4 tests — nesting preserved, orphan reaped
with pins balanced, stack strictly decreasing, cross-thread frames untouched).

### 2b. `callbackFrames()` harness verb
`src/worker/harness/cmds/callback-frames.ts`, wired in `harness/commands.ts`, DSL verb in
`src/harness/dsl.ts`. Self-judging like `asyncParked()`; returns frames + per-thread
`kernelPinCount` vs `liveFrames` + a `verdict` distinguishing `ORPHANED_FRAMES` (ESP inversion)
from `PIN_STARVATION` (pinned RUNNING thread with a READY peer).

This would have made the whole diagnosis one command. **Smoke-tested in the live emulator**; it shares the public frame snapshot API used by `report()`.

### 2c. WGB cache poisoning — unrelated bug found on the way
`runtime/filesystem/wgb-cache.ts`. `downloadToSyncSource` only rejected a stream `< 22` bytes
despite having `Content-Length`. Worse: requesting a bundle path that doesn't exist makes Vite's
SPA fallback answer **HTTP 200 with `index.html`** (exactly 1549 bytes, `Content-Length` matching
its body), so a length check alone cannot catch it. That HTML got cached as the bundle and every
later launch failed `EOCD not found`, unrecoverable without wiping OPFS by hand.

Added `Content-Length` match + ZIP magic-byte (`PK\x03\x04`) checks to all three download paths,
matching the invariant `stageInBackground` already enforced.

> Possible overlap with the `wgb-url-loading` worktree — reconcile before merging.

### 2d. Harness ports are env-overridable
`BS_VITE_PORT` / `BS_LOG_PORT` / `BS_CDP_PORT` in `tools/cdp-core.ts`, `vite.config.ts`,
`tools/log-server/log-server.ts`, `src/utils/log-client.ts` (via a `define`). Chrome's profile
dir is suffixed per CDP port so two Chromes don't share a singleton. Lets worktrees run parallel
stacks. This worktree used **5274 / 3101 / 9433**.

---

## 3. Stage 1 — COMPLETE and verified against the live game

All of Fable's Stage 1 is implemented. Typecheck clean; **868 tests pass across 81 files**.

### Kernel-transition preemption escape (`scheduler.ts`)
Field `kernelTransitionAtBoundary` (`:148`), set at the top of six guest sync primitives —
`sleepWithContext`, `waitForObjectsWithContext`, `setEvent`, `pulseEvent`, `releaseMutex`,
`releaseSemaphore` — read and cleared at the top of `onThunkBoundary` (`:662`), and also cleared
in `onThunkEnter` (`:720`) so it cannot leak across thunks. The step-5 gate (`:701`) reads:

```ts
const canPreemptCallback = kernelTransition && current?.id === boundaryThreadId
    && current.callbackFramePinCount === current.kernelPinCount;
if (current && current.kernelPinCount > 0 && current.state === ThreadState.RUNNING && !canPreemptCallback) return;
```

Three guards, and the third is the important one: `callbackFramePinCount === kernelPinCount`
means the escape applies **only when every pin on the thread is a callback-frame pin**. If an SEH
critical-runtime or `callGuestFunctionSync` pin is also held — the two genuinely unsafe
nested-runtime sections — preemption is still refused. That is a structural safety property, not
an enumeration of thunk ids, and it is what makes this safe where a blanket forced switch (option
C) would corrupt.

It **never creates** a switch: one still requires `switchRequested` / quantum expiry. Precedent:
`Sleep(0)` already escapes this exact gate by going `READY` before the boundary (`:1797`).

### Pin ownership fixed (`scheduler.ts:2940`)
`pinCallbackFrame(threadId)` / `unpinCallbackFrame(threadId)` take an **explicit thread id** and
maintain the separate `callbackFramePinCount`. This replaces `unpinCurrentThread()` in
`releaseFrame`, which unpinned whoever happened to be *current* rather than the frame's owner —
latent before, but an active bug once a thread can be preempted mid-callback.

### U2 closed — both global lookups thread-scoped (`callback-manager.ts`)
`getTopSuspendedFrameId()` returns the innermost frame owned by the calling thread;
`hasSavedThunkContextForThread(tid)` replaces the global `frameStackDepth > 0` at its call sites
(`thunk-dispatcher.ts:1949`, `:2649`). `hasInFlightCallbacksForThread` likewise.

### U1 mitigated — owner guard in `invokeCallback`
A frame whose `frameThreadId !== currentThreadId`, or whose owner cannot be woken, is now
rejected (`{callbackId: 0}` + `reportCallbackFrameFatal`) **before** any CPU register or stack
access. Turns silent cross-thread corruption into a diagnosable error.

### Tests
`tools/tests/scheduler-state-machine.test.ts` covers: uncontended mutex release lets a due peer
run inside a callback (the TS repro shape); a critical-runtime/timer pin still defers; releasing
another thread's frame balances *its* pins; an ordinary guest boundary retains the pin; a syscall
without a due switch cannot unpin a *later* guest boundary; an async-restore early return
consumes the permission. `tools/tests/callback-frame-reap.test.ts` adds thread-scoped frame
ownership and the two `invokeCallback` rejection paths.

### Deliberately SKIPPED from Stage 1
The third pin gate (`thunk-dispatcher.ts:2538`) and the tick gate (`scheduler.ts:906`) still
refuse unconditionally while pinned. With the step-5 fix, quantum expiry can switch at a sync
boundary, so a readied peer does get picked up. Revisit if starvation persists.

**Live save-dialog open/cancel/resume verification passed.** See §7.

---

## 4. How to reproduce and test

```bash
cd .claude/worktrees/ts-save-crash
BS_VITE_PORT=5274 BS_LOG_PORT=3101 bun run dev:logs &
BS_VITE_PORT=5274 BS_LOG_PORT=3101 bun run dev &
BS_VITE_PORT=5274 BS_LOG_PORT=3101 BS_CDP_PORT=9433 bun tools/harness.ts up
TS_WGB=/Users/uetuluk/Downloads/tiberian-sun.wgb BS_VITE_PORT=5274 BS_LOG_PORT=3101 BS_CDP_PORT=9433 bun tools/harness.ts run tools/examples/tiberian-sun-save.harness.ts
```

Bundle: `/Users/uetuluk/Downloads/tiberian-sun.wgb` (1.7 GB), loaded via the disk-stream route
`openWgb("/Users/uetuluk/Downloads/tiberian-sun.wgb")` → `/__wgb/?path=…`. Do **not** use
`openWgb("tiberian-sun")` — that resolves to `/apps/tiberian-sun.wgb`, which 404s into the SPA
fallback (see §2c).

Path to the repro: TS/Firestorm chooser → **Tiberian Sun** disc → main menu → **Skirmish** →
setup dialog → **OK** → in-game → save.

### Driving the UI (hard-won, don't relearn)
- TS **ignores a click that teleports onto a hotspot.** It needs real cursor motion into the
  control first, then a press held across several guest frames (it polls `GetAsyncKeyState`, so
  a same-tick down+up is never observed). `clickHold(x, y, holdMs, { approach: true })` encodes this, `click(label)` does **not** work for TS's own UI.
- Guest-screen mapping for the 800x600 canvas in a 2000x1254 screenshot:
  `guest_x = (shot_x - 339) * 0.605`, `guest_y = (shot_y - 170) * 0.605`.
  Calibrated from two confirmed hits (Serial/Modem, Skirmish). My first estimate was a row off.
- The chooser and menus are **static** — `tickFrames` times out there. Use `sleep`.

### What to measure
`bun tools/harness.ts callbackFrames` (after a reload so the verb loads). Fixed looks like
`frameStackDepth` returning to ~0 and `kernelPinCount` tracking `liveFrames`. Broken shows
`verdict: PIN_STARVATION`. Also watch for the reap line:
```
[CALLBACK] Reaping unwound suspended frame <id> (<source>) T1: entry ESP=… <= incoming …
```

---

## 5. Fable's staged plan (Stage 2, not started)

Retire the frame pin entirely for **all ~40** `saveSuspendedThunkContext` sources, keeping
`pinCurrentThread` only for the two genuinely unsafe nested-runtime sections — SEH dispatch
(`thunk-dispatcher.ts:3985`, scratch stack + single-slot `activeCriticalRuntime`) and
`callGuestFunctionSync` (`hle-lib/sync-guest-call.ts:56`, nested `run_guest_until` wasm loop
under an outer JS snapshot).

1. Make pump dispatch owner-aware: `pumpStep` must not touch the CPU unless owner is current;
   otherwise enqueue a per-thread deferred dispatch and wake the owner. `CallbackCoordinator`
   (`callback-coord.ts`) already has an unused queue with no producers — give entries an
   `ownerThreadId` and dispatch only when `current === owner`, mirroring
   `tryDispatchTimerThreadCallbacks` (`scheduler.ts:2073`).
2. Move the pumpPark (`scheduler.ts:858`) ahead of the `runQueue.length === 0` gate. A
   frame-owning thread at the spin loop has nothing to execute regardless of peers.
3. Delete pin/unpin from `allocateSuspendedFrame` / `releaseFrame` / `resetSuspendedFrames`;
   fix the `kernelPinCount` comment in `scheduler/types.ts:191`.
4. Warn-only tripwire at step 7 (model: `NONPREEMPT_SAFETY`, `scheduler.ts:918`) counting
   consecutive pinned-RUNNING defers with READY peers; warn at ~1000. **Do not make it a forced
   switch** — that corrupts the two genuine pins.

### Corollary worth verifying independently
Because the spin-loop/pumpPark handling sits entirely inside `if (this.runQueue.length === 0)`
(`scheduler.ts:825`), a frame-owning thread at the spin loop with a READY peer hits step 7 and
returns without switching. Prediction: **any** game with a modal dialog and a winmm timer thread
starves its mixer for the dialog's lifetime — check `timerDispatchStats.deferStreak`. Stage 1
does not touch this.

### Latent hazard to look for
pumpPark'd T1 → timer wakes T2 → switch to T2 → T2 blocks → `pumpStep` macrotask fires with T2
current → `wakeCurrentThreadForCallbackDispatch` returns false but is ignored → CPU written under
T2. Grep dialog-heavy sessions for `Suspended frame thread mismatch` / `Invalid transition
WAITING->WAITING`.

Fable also notes the WASM hypercall tier handles uncontended `WaitForSingleObject`/`ReleaseMutex`
with no JS boundary at all (`vendor/v86/src/rust/cpu/hypercall.rs:1900-2013`). TS happened to
fall through to JS; **another game's polling loop may not**, and Stage 1 would not catch it.
Mitigation: a starvation counter in `handle_wait_for_single_object` / `handle_release_mutex`
mirroring `handle_sleep` (`hypercall.rs:2016`, uses `OFF_HC_HAS_RUNNABLE_PEERS`) so N consecutive
WASM-handled sync calls with runnable peers fall through to JS. Pure-guest polling
(`while(!flag)`) never hits a thunk at all and remains uncovered — the tick gate at `:907` is
still pin-gated.

---

## 6. Worktree gotchas

- `vendor/v86` is a real directory containing links to entries in the main checkout,
  excluding `.git`. This permits both Vite imports and Git status without toggling a root
  symlink. Treat those linked sources/builds as shared; do not edit them for this patch.
  A normal initialized submodule remains preferable for independent v86 development.
- `public/apps/external-wgb` → `~/Downloads/wgb` symlink was created here too.
- `src/worker/modules/{d3d9,gdi32,kernel32,user32}/index.ts` and
  `reference-argcounts.generated.ts` show as modified — that is **generated-file churn** from
  `generate-index` / `generate-reference-argcounts`, not hand edits.
- The three `tmp-*.ts` probes were replaced by
  `tools/examples/tiberian-sun-save.harness.ts` and removed. `HarnessChain.clickHold`
  now supports `{ approach: true }` for motion before pressing a polled control.

---

## 7. Live verification — PASS for the freeze scope

Final worker build, ports **5274 / 3101 / 9433**, local Downloads WGB:

1. Booted the chooser, selected Tiberian Sun, opened Skirmish, pressed OK, and entered a match.
2. Opened Options → Save Game. The Save button was enumerable and the dialog rendered.
3. `callbackFrames()` observed T1 **READY**, with three strictly nested live frames
   (IDs 125/126/127, ESPs `0x11ff4b4`, `0x11ff190`, `0x11ff140`) and three frame pins.
   T2 was **RUNNING**, with its separate timer pin. A following report observed T1 running
   and T2 waiting, demonstrating that both threads continued to be scheduled.
4. Clicked Cancel (`382,291`), then Resume Mission (`157,196`). All suspended frames and
   frame pins cleared. `callbackFrames()` reported depth **0**, both sampled kernel pin
   counts **0**, no inversions, and `ok: no suspended callback frames`.
5. `tickFrames(60)` advanced present serial **1780 → 1840 in 490.64 ms**. Reports recorded
   **no guest faults**. A timer pin can legitimately appear in a later snapshot while T2
   executes; it is not a leaked frame pin.

The original pinned-RUNNING mutex-polling livelock is resolved. The diagnostic labels a
pinned callback with a ready peer as **POSSIBLE_PIN_STARVATION** because a single snapshot
cannot prove a stall; use repeated samples plus a responsive UI or frame progress.

An earlier test also reached the game's empty-description validation prompt, proving the
save dialog handled input. No actual save file was written: ordinary Edit keyboard text entry
is separately incomplete, and the user explicitly requested keeping this work focused on the
freeze. **Do not reopen text-entry work as a prerequisite to closing this patch.**

One reload attempt stopped during CRT startup at EIP `0x8664`, with zero pins and no surface.
A fresh harness `reload` followed by a separate load booted normally. This is distinct from
the save-dialog freeze; don't accept `openWgb.loaded` alone as proof that the guest started.
The regression script checks the primary surface and expected controls before continuing.

### Repeatable regression

```bash
TS_WGB=/Users/uetuluk/Downloads/tiberian-sun.wgb \
BS_VITE_PORT=5274 BS_LOG_PORT=3101 BS_CDP_PORT=9433 \
bun tools/harness.ts run tools/examples/tiberian-sun-save.harness.ts
```

The script records `logs/harness/ts-save-open.json` and `ts-save-resume.json`, checks that
callback depth returns to zero, and requires 60 presents after resuming. The same sequence
was executed through the harness REPL for the measurements above.

### Validation and remaining scope

- Mandatory generation/signature/struct/typecheck gate passed.
- `bun test tools/tests/`: **868 pass, 0 fail**, 81 files.
- No changes to standard Edit text-entry behavior.
- Stage 2 (fully preemptible callback pumps, pure guest polling, WASM-only polling) is deferred.
- Existing WGB cache/port changes and generated-file churn from the original handoff remain
  in the worktree; reconcile the cache overlap before merging. No commit has been made.
