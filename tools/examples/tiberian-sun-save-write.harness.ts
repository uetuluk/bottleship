/** Regression: Tiberian Sun writes its save as an OLE compound file (StgCreateDocfile + OleSaveToStream).
 * TS_WGB=/path/to/tiberian-sun.wgb bun tools/harness.ts run tools/examples/tiberian-sun-save-write.harness.ts
 * Set BS_VITE_PORT/BS_LOG_PORT/BS_CDP_PORT when using an isolated worktree stack.
 */
import { harness } from "../harness";

const game = process.env.TS_WGB;
if (!game) throw new Error("Set TS_WGB to the local Tiberian Sun .wgb path");

// Reach the in-mission Save Game dialog (separate runs: each chain has a 300 s ceiling).
const opened = await harness()
    .openWgb(game)
    .sleep(16000)
    .expectSurfaceNonBlack("primary")
    .clickHold(270, 310, 1200, { approach: true }).sleep(6000)
    .clickHold(400, 409, 1200, { approach: true }).sleep(4000)
    .clickHold(478, 359, 1200, { approach: true }).sleep(20000)
    .keyHold("Escape", 350).sleep(3000)
    .clickHold(157, 113, 1200, { approach: true }).sleep(4000)
    .call("findControl", "Save")
    .run();
if (!opened.ok) throw new Error(JSON.stringify(opened.error));

// Type a description and press Save; the docfile layer logs the file it wrote.
const saved = await harness()
    .clickHold(226, 261, 800, { approach: true }).sleep(800)
    .type("Test1").sleep(500)
    .logCapture('docfile: wrote "[^"]+"', 16)
    .clickHold(298, 291, 800, { approach: true }).sleep(6000)
    .logCaptureRead()
    .state(["windows"])
    .run();
await Bun.write("logs/harness/ts-save-write.json", JSON.stringify(saved, null, 2));
if (!saved.ok) throw new Error(JSON.stringify(saved.error));

const captured = JSON.stringify(saved.steps.find((s) => s.cmd === "logCaptureRead")?.result ?? "");
const file = /docfile: wrote \\"([^\\"]+)\\"/.exec(captured)?.[1];
if (!file) throw new Error("no docfile was written by the Save click");
const windows = (saved.named.state as { windows: Array<{ title: string; visible: boolean }> }).windows;
if (!windows.some((w) => w.visible && /Mission Saved/i.test(w.title))) {
    throw new Error("game did not report \"Mission Saved\"");
}

const check = await harness().fsStat(`C:\\${file}`).fsRead(`C:\\${file}`).run();
const stat = check.steps[0].result as { exists: boolean; size: number };
const head = Buffer.from((check.steps[1].result as { content: string }).content, "base64").subarray(0, 8).toString("hex");
if (!stat.exists || head !== "d0cf11e0a1b11ae1") throw new Error(`bad save ${file}: ${JSON.stringify(stat)} magic=${head}`);
console.log(JSON.stringify({ ok: true, file, size: stat.size, magic: head }, null, 2));
