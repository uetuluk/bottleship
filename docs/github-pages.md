# GitHub Pages fork

In Settings → Pages, select **GitHub Actions** as the build source. Enable Actions
on the fork, then push to `main` or run **Deploy GitHub Pages** manually.

The workflow builds for `/<repository-name>/`. A project-scoped service worker
adds the cross-origin isolation headers needed by SharedArrayBuffer. The first
visit reloads once before starting the application. Use a WebGPU-capable browser
with service workers enabled.

This deployment provides local game import. Upstream's hosted demo bundles are
not in the repository, so the deployed demo catalog is empty. Import your own
GTA2 folder or WGB using the interface. Browser storage is origin-specific; files
and saves imported on the upstream site do not automatically appear here.

## DirectPlay patch

`DirectPlayLobbyCreateW` is registered by name and ordinal 5 with five stdcall
arguments (20 bytes of stack cleanup), matching
[Wine's export table](https://github.com/wine-mirror/wine/blob/master/dlls/dplayx/dplayx.spec).
It uses the existing ANSI lobby creation implementation as a compatibility bridge.
This resolves the missing export; it does **not** implement Unicode lobby
interfaces or establish GTA2 gameplay compatibility.

Local production build:

```sh
bun install --frozen-lockfile
VITE_BASE_PATH=/bottleship/ VITE_GITHUB_PAGES=true bun run build
```
