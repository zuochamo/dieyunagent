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

## 发布签名（必读）

手机版升级靠「同包名 + 同签名」覆盖安装。**签名一旦变化，所有已安装设备升级时都会被 Android
拒绝，提示「软件冲突 / 应用未安装」，只能卸载重装（会丢掉已保存的连接地址）。**

所以发布密钥固定在：

```text
mobile-app/android/keys/dieyun-mobile-release.keystore   （不进版本库，清理脚本也不会动它）
```

口令与别名放在本地未跟踪的 `signing.properties`（模板见 `signing.properties.example`）。
命令行打包（`build-manual.ps1`）与 Android Studio（`app/build.gradle`）读同一份配置，两条路径出的
包签名一致；配置缺失时直接报错中止，**不会**再静默新建密钥。

换机器时先恢复密钥再打包：

```powershell
copy Y:\keys\dieyun-mobile-release.keystore mobile-app\android\keys\
copy Y:\keys\signing.properties mobile-app\android\
```

当前发布证书 SHA-256：
`d925c8e71c091c46630ae1c503ecd6dc3e4e07049ce3ff6c7799ee110da2470c`
（每次打包会打印该指纹，可用来确认没有换签；与 `apksigner verify --print-certs <apk>` 对照。）

> 2026-09-19 之前发布过的包用的是另一把密钥（已随工作区清理丢失）。装过那批版本的手机会一直
> 提示「软件冲突」，需卸载一次再装；9/19 之后的版本共用当前证书，可以直接覆盖升级。

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
