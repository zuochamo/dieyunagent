# 叠云AI Android App

第一版是原生 Android WebView 壳，业务界面复用电脑端内网 PWA：

- 扫码或粘贴 PC 端「手机连接」地址
- 保存上次连接
- WebView 打开手机端频道
- 支持重连、换电脑
- PWA 任务完成事件会通过 `DieyunApp.notify()` 转为 Android 本地通知
- 启动后自动读取 PC 同一更新目录下的 `mobile-latest.json`，发现新版时提示下载 APK

## 构建

手机版版本号在 `gradle.properties` 中维护：

```properties
MOBILE_VERSION_CODE=2
MOBILE_VERSION_NAME=0.1.1
MOBILE_UPDATE_BASE_URL=http://192.168.31.62:3099/
```

推荐用 Android Studio 打开本目录：

```text
mobile-app/android
```

然后执行 `Build > Build APK(s)`。

命令行环境需要 Gradle：

```bash
cd mobile-app/android
gradle :app:assembleDebug
```

当前仓库也提供了一个不依赖 Gradle 的 Windows 手工打包脚本，使用 `ANDROID_HOME` 下的 SDK 工具：

```powershell
cd mobile-app/android
.\build-manual.ps1
```

产物：

```text
apk-build/run-<时间戳>/dieyun-mobile-<版本号>.apk
dist/mobile/dieyun-mobile-<版本号>.apk
dist/mobile/mobile-latest.json
```

执行 PC 端发布脚本时，会把 `dist/mobile` 下的 APK 和 `mobile-latest.json` 一起复制到 PC 端同一个更新发布目录。

## 使用

1. 电脑端打开「手机连接」弹窗。
2. 手机安装 APK。
3. App 内扫码，或复制弹窗里的连接地址后粘贴。
4. 点击「连接」进入移动频道。

扫码按钮调用手机上已安装的扫码应用；如果没有扫码应用，使用粘贴连接地址即可。
