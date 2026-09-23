/**
 * Bundle-link recognition (src/wgb-url.ts).
 *
 * `loadApp` routes a URL to the bundle loader or the raw-PE loader on this one
 * predicate, and both ways of getting it wrong are silent: a token-gated link
 * (`…/game.wgb?token=…`) read as a PE fails with "Not a DOS executable", and the dev
 * disk-stream route (`/__wgb/?path=…`) carries its `.wgb` in the query, where a naive
 * path test cannot see it.
 */
import { describe, expect, test } from "bun:test";
import { isWgbUrl, urlPath, wgbFilenameFromUrl } from "../../src/wgb-url";

describe("isWgbUrl", () => {
    test("plain bundle links", () => {
        expect(isWgbUrl("/apps/re-volt-demo.wgb")).toBe(true);
        expect(isWgbUrl("https://host/apps/game.wgb")).toBe(true);
        expect(isWgbUrl("https://host/apps/GAME.WGB")).toBe(true);
    });

    test("a query or fragment does not hide the extension", () => {
        expect(isWgbUrl("https://host/apps/game.wgb?token=abc")).toBe(true);
        expect(isWgbUrl("https://host/apps/game.wgb?v=2&token=abc")).toBe(true);
        expect(isWgbUrl("https://host/apps/game.wgb#frag")).toBe(true);
    });

    test("the dev disk-stream route is a bundle", () => {
        expect(isWgbUrl(`/__wgb/?path=${encodeURIComponent("/tmp/game.wgb")}`)).toBe(true);
        expect(isWgbUrl(`http://localhost:5174/__wgb/?path=${encodeURIComponent("C:\\g\\game.wgb")}`)).toBe(true);
    });

    test("non-bundles", () => {
        expect(isWgbUrl("https://host/game.exe")).toBe(false);
        expect(isWgbUrl("/apps/game.zip")).toBe(false);
        // ".wgb" only inside the query of an unrelated route is not a bundle link.
        expect(isWgbUrl("https://host/download?file=game.wgb")).toBe(false);
    });
});

describe("urlPath / wgbFilenameFromUrl", () => {
    test("strips query and fragment", () => {
        expect(urlPath("https://host/a/b.wgb?x=1#y")).toBe("https://host/a/b.wgb");
        expect(urlPath("/a/b.wgb")).toBe("/a/b.wgb");
    });

    test("filename matches the OPFS cache key", () => {
        expect(wgbFilenameFromUrl("https://host/apps/re-volt.wgb?token=abc")).toBe("re-volt.wgb");
        expect(wgbFilenameFromUrl("/apps/byo/My Game.wgb")).toBe("My Game.wgb");
    });
});
