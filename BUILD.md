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

### Optional: Bundle Default Credentials

Copy `deploy.defaults.example.json` to `deploy.packaged.json` (gitignored) and fill in the `openApi` keys. `npm run pack:deploy-defaults` runs before `electron-builder` and injects it as `resources/deploy-packaged.json` via `extraResources`.

At runtime this is the lowest-priority file layer, so `~/.dieyun/deploy.json` and `deploy.local.json` still override it.

If the source file is missing, the script writes an empty object and warns: the build continues and no stale keys leak into the next installer. If the file exists but is not valid JSON, the build fails on purpose, so a broken credential layer is never shipped.

Run this through the npm scripts above. Calling `electron-builder` directly skips the step and `build/deploy-packaged.json` may not exist.

Note: asar and extraResources are not encrypted — keys shipped this way can be extracted from the installer. Use only for internal read-only services that accept this trade-off.

## Publish Existing Artifacts

```powershell
scripts\publish-updates-to-y.bat
node scripts\upload-updates-cos.mjs
```

Use these commands only when `dist/latest.yml` and the matching installer artifacts already exist.