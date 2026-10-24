import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, utimes, symlink, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LogManager } from "../log-manager";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "bs-log-test-"));
    roots.push(root);
    return root;
}
async function file(root: string, name: string, size: number, ageDays: number) {
    const path = join(root, name);
    await writeFile(path, new Uint8Array(size));
    const time = new Date(Date.now() - ageDays * 86400000);
    await utimes(path, time, time);
    return path;
}

test("stats include nested traces and bundles without following directory links", async () => {
    const root = await fixture(), outside = await fixture();
    await mkdir(join(root, "session"));
    await file(root, "root.log", 10, 1);
    await file(root, "session/frame.png", 20, 2);
    await file(root, "session/game.wgb", 30, 3);
    await file(outside, "unrelated.log", 1000, 4);
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const stats = await new LogManager(root).getStats();
    expect(stats.totalFiles).toBe(3);
    expect(stats.totalSize).toBe(60);
    expect(stats.oldestFile).toBe(join(root, "session/game.wgb"));
});

test("cleanup is recursive, preserves the newest evidence per session and excludes bundles", async () => {
    const root = await fixture();
    await mkdir(join(root, "a")); await mkdir(join(root, "b"));
    const old = await file(root, "a/old.json.gz", 30, 30);
    const recentA = await file(root, "a/current.log", 40, 20);
    const recentB = await file(root, "b/frame.png", 50, 30);
    const bundle = await file(root, "a/game.wgb", 60, 30);
    const source = await file(root, "a/test.ts", 70, 30);
    const manager = new LogManager(root);
    const options = { maxAgeDays: 14, maxTotalSizeMB: 0, keepRecent: 1 };
    const preview = await manager.cleanup({ ...options, dryRun: true });
    expect(preview.deleted).toEqual([old]);
    expect(preview.totalFreed).toBe(30);
    expect((await manager.getStats()).totalSize).toBe(250);
    expect(await manager.cleanup(options)).toEqual(preview);
    expect((await manager.getStats()).totalSize).toBe(220);
    for (const path of [recentA, recentB, bundle, source]) expect((await readFile(path)).length).toBeGreaterThan(0);
});

test("size pressure deletes oldest diagnostics first and invalid limits never delete", async () => {
    const root = await fixture();
    const older = await file(root, "older.log", 32, 2);
    const newer = await file(root, "newer.png", 32, 1);
    const manager = new LogManager(root);
    await expect(manager.cleanup({ maxTotalSizeMB: NaN })).rejects.toThrow("finite");
    expect((await manager.getStats()).totalFiles).toBe(2);
    const result = await manager.cleanup({ maxAgeDays: 30, maxTotalSizeMB: 32 / 1048576, keepRecent: 0 });
    expect(result).toEqual({ deleted: [older], totalFreed: 32 });
    expect((await readFile(newer)).length).toBe(32);
});
