# Build and Release

This document describes how to build and publish Dieyun Agent release artifacts.

## Requirements

- Windows 10/11
- Node.js LTS
- Rust toolchain with Cargo
- An ELF `strip`-capable tool for the bundled Linux Node runtime (see below; the rustup toolchain's `rust-objcopy` is enough)
- Android SDK, only needed when building the mobile app
- `COS_SECRET_ID` and `COS_SECRET_KEY`, only needed when uploading to Tencent COS

### Bundled Linux Node runtime is stripped at pack time

`npm run pack:remote-gateway` (and `npm run pack:headless`) drop the official Node binary into `bin/node`; it ships **with symbol tables** — 93.9 MB, of which `.symtab` + `.strtab` + `.debug_*` are 13.6 MB that every user pays for and nothing uses. `scripts/lib/node-linux-runtime.cjs` strips it in place after extraction/reuse (`--strip-all`, idempotent), yielding 80.3 MB. Verified on a real Linux host after stripping: `--version`, `Intl`/ICU, `crypto`, `zlib` all work, and the `.gnu.version_r` glibc floor check still reads 2.28.

Tool resolution order (single source: `resolveElfStrip()`): `DIEYUN_ELF_STRIP` → `llvm-strip` / `llvm-objcopy` / `strip` / `x86_64-linux-gnu-strip` on `PATH` → the rustup toolchain's `rust-objcopy`/`llvm-objcopy`. If none is found the pack step **fails** instead of silently shipping a 13.6 MB larger binary; `rustup component add llvm-tools` or `set DIEYUN_ELF_STRIP=<strip>` fixes it. The `resources/remote-gateway-pack/bin/node` budget in `scripts/after-pack-win-icon.cjs` (86 MB) is the second net.

### Linux core binary is stored once per package

On Windows the local sidecar is a PE (`resources/dieyun-core/dieyun-core.exe`) and the remote-injection pack carries a Linux ELF, so both exist. On Linux they would be **the same ELF**, so `build.linux` ships no separate `extraResources` entry: the pack's `bin/dieyun-core` *is* the local sidecar, resolved from `src/core-bridge-path.js` (that candidate is only consulted off Windows, so a Windows build can never pick up a Linux core). `scripts/after-pack-win-icon.cjs` asserts the file exists at one of the two documented locations and, on Linux, that it really is an ELF. Regression test: `test/unit/core-bridge-path.test.cjs`.

## Install Dependencies

```powershell
npm install
```

## Full Release

```powershell
.\build-installer.bat 0.0.29
```

The release script updates the PC and mobile version numbers, builds the Windows installer, builds the Android APK, publishes to `Y:\client-electron\updates-published`, and uploads to Tencent COS.

## Build Windows Installer Only

```powershell
npm run build:nsis
```

The installer artifacts are written to `dist/`:

- `dieyunagent-Setup-<version>.exe`
- `dieyunagent-Setup-<version>.exe.blockmap`
- `latest.yml`

### Native modules are not rebuilt (both platforms)

`scripts/build-desktop.cjs` passes `--config.npmRebuild=false` on Windows as well as Linux. Everything we ship is either pure JS or an N-API prebuild (`koffi`, `uiohook-napi`), which Electron 44 loads as-is; `node-gyp-build` prefers a `build/Release` artifact if one exists, otherwise the shipped `prebuilds/` — verified by packaging with `node_modules/uiohook-napi/build` removed and then loading `koffi` (real `kernel32` call) and `uiohook-napi` inside the packaged Electron. `cpu-features` (the only module that actually needed a gyp rebuild) is no longer packaged. Leaving the rebuild on costs time and network: it fetches Node headers via node-gyp and, on this network, hangs rather than fails. If a future dependency genuinely needs an Electron-ABI rebuild, drop the flag for that build instead of changing the default.

### Installer Size Budget and Artifact Pruning

Two guards keep the installer from drifting upward (2026-11: it had reached 159.5 MB):

- **Size budget** — `scripts/after-pack-win-icon.cjs` prints a size table for `resources/` (and each of its children) on every build, on both platforms, and **fails the build** when a budget in `SIZE_BUDGETS_MB` is exceeded. Numbers live only there: raise them deliberately, with a reason, instead of adding a size allowlist elsewhere.
- **Artifact pruning** — `scripts/build-desktop.cjs` keeps only the newest N versions of the install artifacts (`dieyunagent-Setup-*.exe`, `dieyunagent_*_amd64.deb`, `AppImage` + blockmaps) after a successful build; default 2 (current + previous, so delta-update testing still works). Only files matching those names are touched — directories such as `win-unpacked/`, `mobile/`, `optional/` are left alone. `node scripts/build-desktop.cjs --prune-only [--keep-artifacts N]` prunes without building.

What the `build.files` exclusions are for (keep this list truthful — a wrong entry ships a broken app):

- `koffi` and `uiohook-napi` ship per-platform prebuilds; only `win32_x64` + `linux_x64` are kept (both, not one) because `build.win.files` / `build.linux.files` are **not** merged into the global `files` list — a platform-only negative list is treated as "ignore everything" and electron-builder prepends `**/*`, which silently packs the whole repo (including `target/`). Keep platform differences out of `package.json` `files`.
- `mermaid` and `xlsx` are loaded by the renderer as **prebuilt single files** (`dist/mermaid.min.js`, `dist/xlsx.full.min.js` via `<script src>`). Their npm dependencies (d3/dayjs/dompurify/es-toolkit…, codepage/cfb/…) are therefore dead weight in the package; nothing in `src/` `require`s them. If someone starts `require('xlsx')` or `require('mermaid')` from the main process, restore those entries first.
- `cpu-features` is `ssh2`'s optional accelerator with a pure-JS fallback; not shipped.
- `playwright-core` has no native binaries, so it stays **inside** the asar (only `.node` files need `asarUnpack`); its `lib/vite` (trace-viewer UI) and `bin/` are excluded.

### Remote Agent pack (`resources/remote-gateway-pack`)

`npm run build:*` runs `npm run pack:remote-gateway` first and copies `build/remote-gateway-pack` into the installer via `extraResources`.

electron-builder always drops the **root** `node_modules` of a copied directory, so the pack's runtime dependency (`ws`) needs its own `extraResources` entry pointing at `build/remote-gateway-pack/node_modules`. Without it the installer ships an incomplete Remote Agent pack, and SSH remote workspaces fail at injection time with `REMOTE_GATEWAY_PACK_INCOMPLETE` (surfaced as「远程 Agent 安装包不完整」).

`npm run verify:remote-pack` checks this at the end of every build using the shared manifest in `src/remote/remote-pack-layout.js`. If it reports missing files, fix `package.json` → `build.extraResources` rather than shipping the artifact.

### No Bundled Credential Layer

Installers no longer embed any credential layer: the `pack:deploy-defaults` step and its `resources/deploy-packaged.json` were removed together with the 叠云 Open API MCP subsystem (2026-11). File layers are now just `~/.dieyun/deploy.json` → repo `deploy.local.json`, both gitignored and local-only.

MCP endpoints and keys are per-service: saved from the settings page into `mcp-secrets.json` (safeStorage-encrypted under the app's userData dir). Nothing secret should be added to `extraResources` — asar and extraResources are not encrypted, so anything shipped that way can be extracted from the installer.

## Publish Existing Artifacts

```powershell
scripts\publish-updates-to-y.bat
node scripts\upload-updates-cos.mjs
```

Use these commands only when `dist/latest.yml` and the matching installer artifacts already exist.