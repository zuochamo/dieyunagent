# Build and Release

This document describes how to build and publish Dieyun Agent release artifacts.

## Requirements

- Windows 10/11
- Node.js LTS
- Rust toolchain with Cargo
- Android SDK, only needed when building the mobile app
- `COS_SECRET_ID` and `COS_SECRET_KEY`, only needed when uploading to Tencent COS

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

### Remote Agent pack (`resources/remote-gateway-pack`)

`npm run build:*` runs `npm run pack:remote-gateway:lite` first and copies `build/remote-gateway-pack` into the installer via `extraResources`.

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