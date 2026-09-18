/**
 * Game library catalog — fetched from public/games-catalog.json instead of being
 * baked into the JS bundle, so ops can add/hide a game (flip "enabled") by editing
 * a file on the server, no rebuild required. Fetch failure/missing file = empty catalog.
 */
import type { GameEntry } from "./library/GameSelectScreen";

interface GamesCatalogFileEntry extends GameEntry {
    enabled?: boolean;
}

let cached: GameEntry[] | null = null;

export async function loadGamesCatalog(): Promise<GameEntry[]> {
    if (cached) return cached;
    try {
        const resp = await fetch(`${import.meta.env.BASE_URL}games-catalog.json`);
        const entries: GamesCatalogFileEntry[] = resp.ok ? await resp.json() : [];
        cached = entries.filter((g) => g.enabled !== false);
    } catch {
        cached = [];
    }
    return cached;
}
