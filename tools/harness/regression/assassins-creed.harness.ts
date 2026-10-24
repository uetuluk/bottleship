import { harness } from "../../harness";

async function run(chain: ReturnType<typeof harness>) {
    const result = await chain.run();
    if (!result.ok) {
        await harness().report().run();
        throw new Error(JSON.stringify(result.error));
    }
    return result;
}

async function press(vk: number, after = 120) {
    await run(harness().key(vk, { down: true }).sleep(450).key(vk, { up: true }).tickFrames(after));
}

// AC_FROM_SCENE validates an already loaded 3D scene; the boot arm needs an existing profile.
if (process.env.AC_FROM_SCENE !== "1") {
    const wgb = process.env.WGB;
    if (!wgb) throw new Error("Set WGB to the full Assassin's Creed bundle URL");
    let boot = harness().call("resetWorkerFlags");
    if (process.env.AC_SPLIT === "0") boot = boot.call("setWorkerFlag", "__d3d9Split", false);
    await run(boot.clearModals().openWgb(wgb, { io: { mode: "stream" } }).tickFrames(1200));
    await run(harness().shot({ save: "ac-regress-title.png" }));
    await press(13);
    await press(40, 30);
    await press(40, 30);
    await press(13);
    await run(harness().shot({ save: "ac-regress-menu.png" }));
    await press(13);
}

type Frame = { drawCalls: Array<{ rtSurfacePtr: number; isRHW: boolean; vertexCount: number }> };
let frame: Frame | undefined;
for (let i = 0; i < 30; i++) {
    await run(harness().tickFrames(30).shot({ save: `ac-regress-scene-${i}.png` }));
    const result = await run(harness().call("captureFrame", { backend: "d3d9", timeoutMs: 30000 }));
    frame = result.named.captureFrame as Frame;
    if (frame.drawCalls.filter(draw => !draw.isRHW && draw.vertexCount > 4).length >= 500) break;
}
if (!frame || frame.drawCalls.filter(draw => !draw.isRHW && draw.vertexCount > 4).length < 500) {
    throw new Error("The 3D scene did not render; menus and loading screens do not satisfy this scenario");
}
const before = await run(harness().report().call("rtGallery").call("d3d9Census"));
const report = before.named.report as { faults: unknown[]; stubs: unknown[]; gpuErrors: { total: number } };
if (report.faults.length || report.stubs.length || report.gpuErrors.total) throw new Error("Guest or GPU errors during the 3D scene");
const census = before.named.d3d9Census as { shaderUnsupported: number; shaderApproximated: number };
if (census.shaderUnsupported || census.shaderApproximated) throw new Error("Unsupported or approximated scene shaders");
const worldTargets = new Set(frame.drawCalls.filter(draw => !draw.isRHW && draw.vertexCount > 4)
    .map(draw => `0x${draw.rtSurfacePtr.toString(16)}`));
const targets = before.named.rtGallery as Array<{ handle: string; gpuFormat: string; uniform: boolean; nan: number }>;
if (!targets.some(target => worldTargets.has(target.handle) && target.gpuFormat === "bgra8unorm" && !target.uniform && !target.nan)) {
    throw new Error("No world color target contains rendered geometry");
}
await run(harness().key(87, { down: true }).tickFrames(90).key(87, { up: true })
    .moveRelative(80, 0).tickFrames(60).shot({ save: "ac-regress-movement.png" }).report());
console.log("Scene geometry rendered without guest/GPU faults; movement window completed");
