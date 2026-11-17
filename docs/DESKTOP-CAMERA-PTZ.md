# 本机云台（`desktop_camera_ptz`）：把镜头转过去，再拍

> 一句话：`desktop_camera_ptz` 只负责**朝向**，`desktop_camera_look` 只负责**画面**。
> 想「转到那边看一眼」= 先转，再拍。转完不拍，什么都没看见。

## 1. 它为什么不是「给 `desktop_camera_look` 加个 pan 参数」

抓帧与转云台是两条完全不同的失败路径：

| | 取帧（`desktop_camera_look`） | 转云台（`desktop_camera_ptz`） |
|---|---|---|
| 传输 | ffmpeg（`dshow` / `avfoundation` / `v4l2`） | Windows `IAMCameraControl`（COM）/ Linux `v4l2-ctl` |
| 缺什么会失败 | 没 ffmpeg、设备被独占 | 这台摄像头没有电机、平台没接入、驱动不暴露 pan/tilt |
| 产物 | 一张 JPEG（进视觉通道、不落盘） | 一个**读回来**的绝对位置 |

合成一个工具，模型会把「没装 ffmpeg」和「这台没云台」写成同一句话。
分开之后 trace 里也能看清：它到底转过去了没有。

## 2. 语义（`src/agent/desktop-camera-ptz.js`）

| action | 干什么 | 备注 |
|---|---|---|
| `status` | 只读 `{position, ranges, supports}` | 不动；`ranges` 是设备自己报的上下限 |
| `move` | 转到绝对角度（`pan` / `tilt` / `zoom`） | 只写给了的轴 |
| `step` | 在当前读数上相对转（`pan_delta` / `tilt_delta`） | 绝对值和相对值同轴都给 → 绝对值优先 |
| `center` | `pan=0, tilt=0` | 不动 zoom |

返回：

```jsonc
{
  "ok": true,
  "device": "OBSBOT Tiny 2 StreamCamera",
  "backend": "DirectShow IAMCameraControl",
  "before": { "pan": 0, "tilt": -5, "zoom": 0 },
  "target": { "pan": 2, "tilt": -4 },
  "after":  { "pan": 2, "tilt": -3, "zoom": 0 },   // ← 只能按这个理解朝向
  "ranges": { "pan": { "min": -130, "max": 130, "step": 1 } },
  "settled": true,   // 动作结束时是否已停稳（连续两次读数相同）
  "reached": true,   // 是否到位（容差 1 个 step）
  "note": "…"
}
```

三条硬约束（写在模块头注释里，改代码前先读）：

1. **只报实测**：先读 → 再写 → 再读回并轮询到停稳。写成功只代表指令下发成功。
2. **不猜范围**：上下限取设备的 `GetRange`（Windows）/ `--list-ctrls`（Linux）。
   越界回 `DESKTOP_CAMERA_PTZ_OUT_OF_RANGE` 并把真实范围还回去 —— **不静默夹取**，
   否则模型会以为「转到 200° 了」。
3. **不假装支持**：没电机 → `DESKTOP_CAMERA_PTZ_NO_PTZ`；macOS → `DESKTOP_CAMERA_PTZ_UNSUPPORTED`。

## 3. 平台

### Windows：DirectShow `IAMCameraControl`（`desktop-camera-ptz-win32.js`）

Tiny 2 的 pan / tilt / zoom 是**标准 UVC Camera Terminal 控制**，Windows 自带映射，
不需要厂商 SDK、也不需要开 OBSBOT Center 用鼠标拖摇杆。

COM 用 koffi 直调（与 `src/computer/win32-input.js` 同一套做法）：

```
CoCreateInstance(CLSID_SystemDeviceEnum) → ICreateDevEnum::CreateClassEnumerator
  → IEnumMoniker → IMoniker::BindToStorage(IPropertyBag) → FriendlyName   // 设备名
  → IMoniker::BindToObject(IBaseFilter) → QI(IAMCameraControl)            // 云台接口
  → GetRange / Get / Set(CameraControl_Flags_Manual)
```

`FriendlyName` 与 ffmpeg 的 dshow 设备名是**同一个字符串**，所以「转哪台」与「拍哪台」同源。
虚拟摄像头（`OBS Virtual Camera`）会出现在枚举里但不算「能转的设备」
（`desktop-camera-source.js#BACKENDS.win32.isVirtual`，注意那条正则写的是 `\bobs\b`
而不是 `obs` —— OBSBOT 是真货）。

实测（本机 OBSBOT Tiny 2，2026-11-17）：

| 事实 | 数值 |
|---|---|
| pan 范围 | −130 … 130（度，step 1） |
| tilt 范围 | −90 … 90 |
| zoom 范围 | 0 … 100 |
| 打开接口（BindToObject + QI） | ≈ 20 ms |
| 一次 `Set` | ≈ 2 ms |
| ffmpeg 抓一帧 | ≈ 600 ms |
| **持有源滤镜时 ffmpeg 能否抓帧** | **能**（所以「先转再拍」不需要任何协作/互斥） |

两个实现坑（踩过了，别重走）：

- koffi `2.x` 对裸 `str16` 指针做 `decode` 会**直接崩**（访问违例）；读 BSTR 要用
  `koffi.decode(ptr, 'char16_t', SysStringLen(ptr))`。
- `koffi.decode(ptr, type, n)` 的第三个参数是**长度**，取 vtbl 第 n 项要用
  `koffi.decode(vtbl, n * 8, type)`（顺序是 `(ptr, offset, type)`）。

### Linux：`v4l2-ctl`

- 读：`v4l2-ctl -d /dev/videoN --list-ctrls`（弧秒），写：`--set-ctrl pan_absolute=…,tilt_absolute=…`
- 单位在平台边界换算：**上层永远只看到「度」**（1° = 3600 弧秒）。
- 「能转的设备」= 有 `pan_absolute` 的节点（同一台摄像头常同时注册采集节点与 metadata 节点）。
- `zoom_absolute` 各驱动单位不一致，所以 Linux **不声明 zoom 支持**（`supports.zoom === false`）。

### macOS

未接入（没有 `v4l2-ctl`，也没做 AVFoundation 的 PTZ 通道）。如实回 `UNSUPPORTED`。

## 4. 权限与边界

- 开关：**共用** `permissions.desktopCamera`（设置 →「本机权限」里那个本机摄像头，默认关）。
  转的是同一台摄像头、同一间屋子，「能拍」与「能不让它拍」是同一件事；
  多开一个开关只会造出「能拍但不能转 1°」这种没有安全收益的状态。
- 关卡：`guardrails-shared.js#PERMISSION_GATED_TOOLS`（执行前再确认一次，接口关掉就是关掉）。
- **生命感心跳轮拿不到它**：`ALIVE_READ_ONLY_TOOL_NAMES` 是只读清单，移动物理姿态是写。
  见 [`ALIVE.md`](ALIVE.md) 负向清单里对应的那条。
- 数字：`agent-limits.js` 的 `desktopCameraPtzSettleTimeoutMs` / `desktopCameraPtzPollMs` /
  `desktopCameraPtzCommandTimeoutMs`（模块里不留数字）。
- 并发：一次一动（`DESKTOP_CAMERA_PTZ_BUSY`）。它**不进** workspace 写队列
  （`MUTATING_TOOL_NAMES` 是「改工作区」的串行队列，云台不碰工作区）。

## 5. 和 AI 追踪打架怎么办

Tiny 2 开着 AI 追踪时，人一动它自己就转，你 Set 的位会被抢回去。表现是
`settled: true` 但 `reached: false`（停在离目标几度的地方），或 `settled: false`（一直在动）。
**这不是 bug**，处理方式是：按 `after` 理解画面，别按 `target`；
需要稳定画面就先关掉追踪（用户侧），或把 `status` 的读数当事实接受。

## 6. 负向清单（别加回来）

- ❌ 在模块里写死 ±130/±90（设备自己会给，写死就会在别的机型上错）
- ❌ 「Set 返回 0 就算转到了」（不读回就是编造）
- ❌ 转完自动接管成「顺手拍一张」（拍照是另一个工具的单一职责；trace 也分不清了）
- ❌ 给心跳轮加 `desktop_camera_ptz`（AI 不能在你不在时转动镜头）
- ❌ 用 `computer` 拖 OBSBOT Center 的摇杆当默认方案（窗口位置 + DPI + 追踪三重不稳，
  只在没有电机的机型上才会是唯一选择 —— 而那种机型本来也转不动）
- ❌ 把云台动作塞进 `desktop_camera_look` 当参数（失败路径不同，见 §1）
