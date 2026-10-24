/**
 * Midtown Madness 2 (retail): the parts the trial does not have.
 *
 *  - the logo movie plays in its MCIWnd window, centred on a black screen, with sound,
 *    and a key press ends it;
 *  - with Play Music switched on (it is off by default) the menu score plays through
 *    DirectMusic: a segment is sounding, its notes reach instruments, the mix carries it;
 *  - London loads and a Circuit race against seven opponents runs under keyboard input,
 *    with the race score playing.
 *
 * Every check fails when the piece it guards is missing, and a run in which a piece was
 * never observed fails as "not judged" instead of passing.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { harness, closeHarnessConnection } from "../../harness";
import { decodePng } from "../../png-diff";

const wgb = process.env.WGB;
if (!wgb) throw new Error("WGB must point to the repacked Midtown Madness 2 bundle");
/** The bundle's gameId as an OPFS container name. */
// Run in a dedicated disposable origin/profile, with a lawfully obtained game and any
// licence handled by its owner. The scenario never erases saves or accepts agreements.
if (!process.env.BS_TAB) throw new Error("BS_TAB must identify a dedicated regression tab");
const out = resolve("logs", process.env.BS_TAB ?? "midtown-madness-2", "midtown-madness-2");
mkdirSync(out, { recursive: true });

// Menu controls, in 640x480 guest pixels.
const OPTIONS = { x: 498, y: 22 };
const RIGHT_ARROW_2 = { x: 521, y: 330 };   // AUDIO on the options screen, RACES on the main menu
const PLAY_MUSIC = { x: 63, y: 137 };
const NEXT = { x: 525, y: 447 };            // DONE / SELECT VEHICLE / GO DRIVE
const BACK = { x: 330, y: 447 };
const CIRCUIT = { x: 110, y: 158 };
const NEXT_LOCATION = { x: 624, y: 230 };
const MENU_WIDTH = 640;
const VK_ESCAPE = 0x1b;
const VK_UP = 0x26;
const RACING_PRESENTS_PER_SECOND = 8;

interface Screen { width: number; height: number; presentSerial: number }
interface Png { width: number; height: number; data: Uint8Array }

async function step(what: string, chain: ReturnType<typeof harness>): Promise<Record<string, unknown>> {
    const r = await chain.run();
    if (!r.ok) throw new Error(`${what}: ${JSON.stringify(r.error)}`);
    return r.named as Record<string, unknown>;
}

async function screen(): Promise<Screen> {
    return ((await step("state", harness().state(["screen"]))).state as { screen: Screen }).screen;
}

async function capture(label: string): Promise<Png> {
    const shot = (await step(label, harness().shot())).shot as { base64: string };
    const bytes = Buffer.from(shot.base64, "base64");
    await Bun.write(resolve(out, `${label}.png`), bytes);
    return decodePng(new Uint8Array(bytes));
}

/** Share of non-black pixels in the rectangle given as fractions of the picture. */
function lit(png: Png, x0: number, y0: number, x1: number, y1: number): number {
    let n = 0, total = 0;
    for (let y = Math.floor(y0 * png.height); y < Math.floor(y1 * png.height); y++) {
        for (let x = Math.floor(x0 * png.width); x < Math.floor(x1 * png.width); x++) {
            const i = (y * png.width + x) * 4;
            if (png.data[i]! + png.data[i + 1]! + png.data[i + 2]! > 24) n++;
            total++;
        }
    }
    return total ? n / total : 0;
}

async function waitFor(what: string, timeoutMs: number, test: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await test()) return;
        await harness().sleep(200).run();
    }
    throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

const click = (p: { x: number; y: number }, settleMs: number): ReturnType<typeof harness> =>
    harness().move(p.x, p.y).sleep(500).clickHold(p.x, p.y, 250).sleep(settleMs);

interface Music {
    ports: Array<{
        active: boolean;
        notes: { notes: number; noInstrument: number; noRegion: number };
        segments: Array<{ primary: boolean; started: boolean; pattern: string | null }>;
    }>;
}

/** The pattern the primary segment is playing, after checking its notes can sound. */
async function musicPlaying(where: string): Promise<string> {
    const music = (await step("dmusicState", harness().call("dmusicState"))).dmusicState as Music;
    const port = music.ports.find((p) => p.active);
    if (!port) throw new Error(`${where}: no active DirectMusic port`);
    const primary = port.segments.find((s) => s.primary && s.started);
    if (!primary?.pattern) throw new Error(`${where}: no primary segment is playing a pattern: ${JSON.stringify(port.segments)}`);
    if (port.notes.notes === 0) throw new Error(`${where}: the score has played no note`);
    // A handful of notes on the GM drum kit are expected to be silent without gm.dls.
    const lost = port.notes.noInstrument + port.notes.noRegion;
    if (lost > port.notes.notes * 0.1) throw new Error(`${where}: ${lost} of ${port.notes.notes + lost} notes could not sound`);
    return primary.pattern;
}

async function masterPeak(): Promise<number> {
    const signal = (await step("audioSignal", harness().call("audioSignal", {}))).audioSignal as
        { worklet?: { master?: { peakMilli: number } } };
    return signal.worklet?.master?.peakMilli ?? 0;
}

try {
    await step("boot", harness().reload().sleep(1500).openWgb(wgb).sleep(8000));

    // The logo movie: 320x240 in the middle of the 640x480 screen, nothing around it.
    await step("movie", harness().call("audioSignal", { reset: true }).sleep(4000));
    const windows = ((await step("windows", harness().state(["windows"]))).state as { windows: Array<{ cls: string; w: number; h: number }> }).windows;
    const movieWindow = windows.find((w) => w.cls === "MCIWndClass");
    if (!movieWindow) throw new Error("no MCIWnd window: the logo movie was not played");
    if (movieWindow.w !== 322 || movieWindow.h !== 242) {
        throw new Error(`the movie window is ${movieWindow.w}x${movieWindow.h}, not the 320x240 movie in a one-pixel border`);
    }
    const movie = await capture("movie");
    const centre = lit(movie, 0.3, 0.3, 0.7, 0.7);
    const border = lit(movie, 0, 0, 1, 0.2);
    if (centre < 0.5) throw new Error(`the middle of the screen is ${(centre * 100).toFixed(0)}% lit during the movie`);
    if (border > 0.02) throw new Error(`${(border * 100).toFixed(0)}% of the area above the movie is lit: it is not on a black screen`);
    const moviePeak = await masterPeak();
    if (moviePeak === 0) throw new Error("the logo movie is silent");
    await step("skip", harness().key(VK_ESCAPE, { down: true }).sleep(300).key(VK_ESCAPE, { up: true }));

    const serial = (await screen()).presentSerial;
    await waitFor("the main menu", 20_000, async () => (await screen()).presentSerial - serial > 60);
    await harness().sleep(3000).run();
    if (lit(await capture("menu"), 0, 0, 1, 1) < 0.5) throw new Error("main menu is mostly black");

    // Play Music is off on a fresh profile: switch it on, then the menu has a score.
    await step("options", click(OPTIONS, 4000));
    await step("audio", click(RIGHT_ARROW_2, 4000));
    await step("play music", click(PLAY_MUSIC, 1000));
    await capture("audio-options");
    await step("done", click(NEXT, 3000));
    await step("back", click(BACK, 4000).call("audioSignal", { reset: true }).sleep(5000));
    const menuPattern = await musicPlaying("menu");
    const menuPeak = await masterPeak();
    if (menuPeak === 0) throw new Error("the menu score is playing in DirectMusic, yet nothing reaches the mix");

    // London, Circuit: seven opponents on the grid.
    await step("races", click(RIGHT_ARROW_2, 5000));
    await step("circuit", click(CIRCUIT, 1500));
    await step("london", click(NEXT_LOCATION, 1500));
    await capture("races");
    await step("select vehicle", click(NEXT, 7000));
    await step("go drive", harness().clickHold(NEXT.x, NEXT.y, 250));
    await waitFor("the loading screen", 30_000, async () => (await screen()).width !== MENU_WIDTH);
    let before = (await screen()).presentSerial;
    await waitFor("the race to start presenting", 180_000, async () => {
        await harness().sleep(1000).run();
        const now = (await screen()).presentSerial;
        const racing = now - before > RACING_PRESENTS_PER_SECOND;
        before = now;
        return racing;
    });
    await harness().sleep(8000).run();

    const drive = await step("drive", harness().key(VK_UP, { down: true }).sleep(2500).call("sceneProbe")
        .sleep(4000).key(VK_UP, { up: true }).call("report"));
    const motion = (drive.sceneProbe as { motion: number }).motion;
    const report = drive.report as {
        crash: unknown;
        stubs: Array<{ api: string }>;
        gpuErrors: { total: number };
    };
    await Bun.write(resolve(out, "report.json"), JSON.stringify(report, null, 2));
    if (lit(await capture("race"), 0, 0, 1, 1) < 0.5) throw new Error("the race view is mostly black");
    const racePattern = await musicPlaying("race");

    if (report.crash) throw new Error(`guest crash: ${JSON.stringify(report.crash).slice(0, 400)}`);
    if (report.stubs.length) throw new Error(`unimplemented API: ${report.stubs.map((s) => s.api).join(", ")}`);
    if (report.gpuErrors.total) throw new Error(`${report.gpuErrors.total} GPU error(s)`);
    if (motion < 5) throw new Error(`the view did not move under acceleration (motion ${motion.toFixed(2)})`);

    console.log(`OK — Midtown Madness 2 played its logo movie (peak ${moviePeak / 1000}), the menu score ` +
        `("${menuPattern}", peak ${menuPeak / 1000}), then a London Circuit race (motion ${motion.toFixed(1)}) ` +
        `to "${racePattern}"; evidence: ${out}`);
} finally {
    try {
        await harness().key(VK_UP, { down: false, up: true }).perfProfile({ enable: false }).pause().run();
    } finally { closeHarnessConnection(); }
}
