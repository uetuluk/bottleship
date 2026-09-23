/** Overlay directory listing: files created at a drive root must enumerate (FindFirstFile). */
import { describe, expect, test } from "bun:test";
import { OpfsOverlay } from "../../src/worker/runtime/filesystem/vfs";

function overlayWith(paths: string[]): OpfsOverlay {
    const overlay = new OpfsOverlay();
    const entries = (overlay as unknown as { entries: Map<string, { size: number; kind: string; path: string }> }).entries;
    for (const path of paths) entries.set(path.toLowerCase(), { size: 10, kind: "file", path });
    return overlay;
}

describe("OpfsOverlay.listDirectory", () => {
    test("lists files and subdirectories directly under the drive root", () => {
        const overlay = overlayWith(["C:\\SAVE0029.SAV", "C:\\SAVES\\A.SAV"]);
        const names = overlay.listDirectory("C:\\").map((e) => [e.name, e.kind, e.path]).sort();
        expect(names).toEqual([["SAVE0029.SAV", "file", "C:\\SAVE0029.SAV"], ["SAVES", "dir", "C:\\SAVES"]]);
        expect(overlay.listDirectory("C:").map((e) => e.name).sort()).toEqual(["SAVE0029.SAV", "SAVES"]);
    });

    test("lists a subdirectory with or without a trailing separator", () => {
        const overlay = overlayWith(["C:\\SAVES\\A.SAV", "C:\\SAVESX\\B.SAV"]);
        expect(overlay.listDirectory("C:\\SAVES").map((e) => e.name)).toEqual(["A.SAV"]);
        expect(overlay.listDirectory("C:\\SAVES\\").map((e) => e.name)).toEqual(["A.SAV"]);
    });
});
