# Game bundles (`.wgb`)

BottleShip runs a game from a **`.wgb`** bundle — a *store-only* (uncompressed) ZIP that
packages a game together with the metadata the engine needs to boot it. This document covers
the format and the tools for creating and inspecting bundles, plus how to bring your own games.

## What's in a bundle

```
game.wgb  (store-only ZIP)
├── manifest.json      # how to boot: exe, resolution, RAM, OS, args, flags
├── registry.json      # registry keys seeded into the HLE registry at boot
└── <game files>       # the executable and its data/assets
```

- **`manifest.json`** drives everything the engine needs that isn't in the files themselves:
  the entry `.exe`, display resolution and color depth, guest RAM, the emulated OS version,
  command-line args, and behavior flags (e.g. skipping intro videos). Persistence policy —
  which paths are durable (saves/config) vs. ephemeral (caches/temp) — is declared here too.
- **`registry.json`** seeds the HLE registry (install paths, product keys the game checks,
  video/audio settings) so the game finds what it expects on first run.

> Don't hand-edit `registry.json` — backslash escaping is easy to get wrong. Generate bundles
> with the tools below, which serialize JSON correctly.

## Creating a bundle: `make-wgb`

The high-level, one-step creator. Point it at a game directory and pass a few flags:

```bash
bun tools/make-wgb.ts <game-dir> <out.wgb> \
  --name "My Game" --exe game.exe \
  --width 640 --height 480 --bpp 16 \
  --ram 128 --os win98 \
  --reg-path "Software\\Vendor\\Game" --reg-install "C:\\Game" \
  --skip-video
```

It generates `manifest.json` + `registry.json` and packs everything in one step. Common flags:

| Flag | Meaning |
|------|---------|
| `--exe` | entry executable |
| `--width` / `--height` / `--bpp` | display mode |
| `--ram` | guest RAM (MB) |
| `--os` | `win95` \| `win98` \| `winnt` \| `win2k` \| `winxp` |
| `--reg-path` / `--reg-hive` / `--reg-install` | registry seed for the game's install key |
| `--args` | command-line arguments |
| `--skip-video` | make MCI/Bink/Smacker intros complete instantly |
| `--codepage` / `--lcid` | locale for non-Western titles |

## Inspecting & patching: `wgb.ts`

A unified archive tool for existing bundles:

```bash
bun tools/wgb.ts list    game.wgb          # list entries (alias: ls)
bun tools/wgb.ts cat     game.wgb manifest.json
bun tools/wgb.ts extract game.wgb ./out    # (alias: x)
bun tools/wgb.ts replace game.wgb path/in/zip local-file
bun tools/wgb.ts patch-manifest game.wgb …  # (alias: pm)
```

## Bringing your own game

BottleShip is the engine; you supply games you legally own. Three ways to get a game in:

1. **Load File…** in the UI — drop a `.wgb`, a raw game folder, or an installer.
2. **GOG installer → ROM.** Drag in a GOG Inno Setup installer; BottleShip parses it
   in-browser (a built-in Inno reader plus a WASM LZMA decoder) and builds a bundle. GOG's
   DRM-free installers make this a clean path — buy the game, drop the installer, play. See
   [`docs/gog-import.md`](gog-import.md).
3. **`make-wgb`** from a game directory you already have, as above.
4. **From a URL** — paste a direct link to a `.wgb` in the Add-Game dialog's *From URL*
   field, or open `?game=dev&load=<url-encoded link>`. See below.

## Loading a bundle from a URL

A `.wgb` link loads directly, from any origin:

```
https://bottleship.pages.dev/?game=dev&load=https%3A%2F%2Fmy-host%2Fapps%2Fgame.wgb
```

The loader streams the bundle with HTTP Range reads instead of downloading it whole, so the
game starts before the transfer finishes, and it caches the result in OPFS — the bundle then
shows up in your library and replays offline. Requirements on the host:

- **Range support** — `Accept-Ranges: bytes` and real `206` responses. A server that
  ignores `Range` and returns the whole file breaks the streaming reader.
- **CORS + CORP**, for a host that isn't the app's own origin. The app page is cross-origin
  isolated (COOP/COEP `require-corp`, needed for `SharedArrayBuffer`), so a cross-origin
  bundle must send `Access-Control-Allow-Origin` *and*
  `Cross-Origin-Resource-Policy: cross-origin`, and answer the `OPTIONS` preflight that a
  `Range` request triggers.

The link may carry a query string (`…/game.wgb?token=…`); the extension is read from the
URL path, and the query is excluded from the cache key.

## Hosting bundles on Cloudflare

[`functions/apps/[[path]].ts`](../functions/apps/%5B%5Bpath%5D%5D.ts) is a Cloudflare Pages
Function that serves bundles out of an R2 bucket with everything above already in place.

1. Create an R2 bucket and bind it to the Pages project as **`APPS`**
   (Settings → Bindings → R2 bucket).
2. Upload bundles — the object key is the filename the URL ends in:
   ```bash
   wrangler r2 object put <bucket>/game.wgb --file ./game.wgb --remote
   ```
   `https://<project>.pages.dev/apps/game.wgb` now serves it.

### Gating access with a token

Set the Pages secret **`APPS_TOKEN`** (Settings → Environment variables → *Encrypt*) and
every request must present that value:

```
https://<project>.pages.dev/apps/game.wgb?token=<APPS_TOKEN>
```

`Authorization: Bearer <token>` works too, but the query form is the one to hand out: the
emulator fetches the URL it is given, so the token rides along through the Range reads with
no extra plumbing, and the link can be pasted into *From URL* as-is. Without the token the
Function answers `401` for every key, including ones that do not exist, so the bucket's
contents stay private. Leave `APPS_TOKEN` unset to keep a bucket public.

The token is a bearer secret in a URL: it is visible in browser history and in the logs of
anything the link passes through, and it does not expire. Treat it as "unlisted, not
secret" — rotate it by changing the secret, which invalidates every link at once.

## A note on distribution

The bundled/showcase set is limited to content that is legal to redistribute (freeware,
shareware, demo episodes). Commercial games are **bring-your-own** — BottleShip does not ship
their files. Keep your own bundles out of the repository.
