/**
 * Recognising a `.wgb` link.
 *
 * The extension lives in the URL *path*, so a query or fragment must not hide it:
 * a token-gated host hands out `https://host/apps/game.wgb?token=…`, and testing the
 * whole string with `endsWith(".wgb")` would route that down the raw-PE loader instead
 * of the bundle loader. Matches `WgbCache.keyForUrl`, which also keys on the path.
 */

/** Path part of a URL or bare path — everything before `?` or `#`. */
export function urlPath(url: string): string {
    const end = Math.min(
        url.indexOf("?") === -1 ? url.length : url.indexOf("?"),
        url.indexOf("#") === -1 ? url.length : url.indexOf("#"),
    );
    return url.slice(0, end);
}

/** True when `url` points at a `.wgb` bundle, query string and fragment notwithstanding. */
export function isWgbUrl(url: string): boolean {
    return urlPath(url).toLowerCase().endsWith(".wgb");
}

/** Filename a URL would be cached under (`…/game.wgb?token=x` → `game.wgb`). */
export function wgbFilenameFromUrl(url: string): string {
    const parts = urlPath(url).split("/");
    return parts[parts.length - 1] || "game.wgb";
}
