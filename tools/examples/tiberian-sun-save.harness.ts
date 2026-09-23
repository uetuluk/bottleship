/** Regression for callback-pin starvation when opening Tiberian Sun's save dialog.
 * TS_WGB=/path/to/tiberian-sun.wgb bun tools/harness.ts run tools/examples/tiberian-sun-save.harness.ts
 * Set BS_VITE_PORT/BS_LOG_PORT/BS_CDP_PORT when using an isolated worktree stack.
 */
import { harness } from "../harness";

const game = process.env.TS_WGB;
if (!game) throw new Error("Set TS_WGB to the local Tiberian Sun .wgb path");
const opened = await harness()
    .openWgb(game)
    .sleep(10000)
    .expectSurfaceNonBlack("primary")
    .clickHold(270, 310, 1200, { approach: true }).sleep(6000)
    .clickHold(400, 409, 1200, { approach: true }).sleep(4000)
    .call("findControl", "OK")
    .clickHold(478, 359, 1200, { approach: true }).sleep(20000)
    .keyHold("Escape", 350).sleep(3000)
    .call("findControl", "Save Game")
    .clickHold(157, 113, 1200, { approach: true }).sleep(4000)
    .call("findControl", "Save")
    .callbackFrames()
    .report()
    .run();
await Bun.write("logs/harness/ts-save-open.json", JSON.stringify(opened, null, 2));
if (!opened.ok) throw new Error(JSON.stringify(opened.error));

// The dialog must handle Cancel, unwind its callbacks, and return to a rendering game.
const resumed = await harness()
    .clickHold(382, 291, 600, { approach: true }).sleep(2500)
    .call("findControl", "Resume Mission")
    .clickHold(157, 196, 600, { approach: true }).sleep(2500)
    .callbackFrames()
    .report()
    .tickFrames(60, { timeoutMs: 30000 })
    .state(["screen", "threads"])
    .run();
await Bun.write("logs/harness/ts-save-resume.json", JSON.stringify(resumed, null, 2));
if (!resumed.ok) throw new Error(JSON.stringify(resumed.error));
const frames = resumed.named.callbackFrames as { depth: number };
if (frames.depth !== 0) throw new Error(`Dialog left ${frames.depth} suspended callback frames`);
console.log(JSON.stringify({ ok: true, frames, screen: resumed.named.state, rendered: resumed.named.tickFrames }, null, 2));
