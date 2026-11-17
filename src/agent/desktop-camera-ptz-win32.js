'use strict';

/**
 * 本机云台的 **Windows 传输层**：DirectShow `IAMCameraControl` 的唯一一份 COM 管道。
 *
 * 为什么是这个接口：OBSBOT Tiny 2 这类带云台的 UVC 摄像头，pan / tilt / zoom 就是
 * 标准 UVC Camera Terminal 控制，Windows 把它映射成 `IAMCameraControl` 的
 * Pan / Tilt / Zoom 属性（单位是**度**，上下限由设备自己给）。不需要厂商 SDK，
 * 也不需要装 OBSBOT Center —— 那条路要开窗口、拿鼠标拖摇杆，窗口一挪 DPI 一变就失准。
 *
 * 为什么不走 ffmpeg：ffmpeg 没有 PTZ 能力（`desktop-camera-source.js` 只用它取帧）。
 *
 * 为什么每个动作都「开一次 / 用完就放」：实测打开（BindToObject + QueryInterface）
 * 约 20ms，一次 Set 约 2ms；而长驻 COM 句柄要跨轮次管理引用计数与设备插拔，
 * 得不偿失。**持有源滤镜不影响 ffmpeg 抓帧**（已实测：持有期间 ffmpeg 仍能正常出一帧），
 * 所以「先转、再拍」两步之间不需要任何协作。
 *
 * 引用计数纪律：枚举器 / moniker / 属性包全部显式 Release；只有被采用的
 * filter 与 IAMCameraControl 交给 session.close() 释放。
 */

const PROPS = Object.freeze({ pan: 0, tilt: 1, zoom: 3 });

/** `IAMCameraControl::Set/Get` 的 flags：手动（自动挡下设备会自己动，写了也不算数）。 */
const CONTROL_MANUAL = 2;

/**
 * 一次会话在设备上报错时的可读映射（HRESULT → 人话）。
 * 只留实测会遇到的几个；其余原样带 hr 交给上层拼进错误文案。
 */
const HR_MESSAGES = Object.freeze({
  '0x80070005': '没有权限打开这个摄像头（可能被别的程序独占）',
  '0x8007001f': '设备当前不响应（可能被别的程序独占，或刚插拔）',
  '0x80070002': '找不到这个设备（可能已经拔出）',
  '0x80070015': '设备还没准备好（刚插上时常见，稍等一下再试）',
  '0x80004005': '设备驱动返回了失败（这个控制它可能不支持）'
});

let bindings = null;

/** HRESULT → '0x%08x' */
function hrText(hr) {
  return '0x' + (hr >>> 0).toString(16).padStart(8, '0');
}

function comError(stage, hr) {
  const key = hrText(hr).toLowerCase();
  const known = HR_MESSAGES[key];
  const e = new Error(known || `${stage} 失败（HRESULT ${hrText(hr)}）`);
  e.code = 'COM_FAILED';
  e.hr = hr;
  e.stage = stage;
  return e;
}

/**
 * koffi 绑定（惰性单例）。非 Windows 调用方不该走到这里 —— 上层按平台分派。
 *
 * `CoInitializeEx(STA)` 只调一次也不调 `CoUninitialize`：这是进程级、按线程的初始化，
 * 反初始化会让后续调用（例如别的模块也在用 COM）失去公寓；留着初始化是安全的。
 */
function getBindings() {
  if (bindings) return bindings;
  const koffi = require('koffi');

  koffi.struct('dieyun_ptz_GUID', {
    Data1: 'uint32',
    Data2: 'uint16',
    Data3: 'uint16',
    Data4: koffi.array('uint8_t', 8)
  });
  // VARIANT 在 x64 下 24 字节：8 字节头 + 16 字节联合（BSTR 指针在偏移 8）。
  koffi.struct('dieyun_ptz_VARIANT', {
    vt: 'uint16',
    r1: 'uint16',
    r2: 'uint16',
    r3: 'uint16',
    data: 'void *',
    extra: 'uint64'
  });

  const ole32 = koffi.load('ole32.dll');
  const oleaut32 = koffi.load('oleaut32.dll');

  const PTR = koffi.pointer('void');
  const GUID_T = 'dieyun_ptz_GUID *';

  const proto = {
    CreateClassEnumerator: koffi.proto(
      `int32 __stdcall ptz_CreateClassEnumerator(void *self, ${GUID_T} clsid, _Out_ void **out, uint32 flags)`
    ),
    Next: koffi.proto('int32 __stdcall ptz_Next(void *self, uint32 celt, _Out_ void **out, void *fetched)'),
    BindToObject: koffi.proto(
      `int32 __stdcall ptz_BindToObject(void *self, void *pbc, void *left, ${GUID_T} riid, _Out_ void **out)`
    ),
    BindToStorage: koffi.proto(
      `int32 __stdcall ptz_BindToStorage(void *self, void *pbc, void *left, ${GUID_T} riid, _Out_ void **out)`
    ),
    QueryInterface: koffi.proto(`int32 __stdcall ptz_QueryInterface(void *self, ${GUID_T} riid, _Out_ void **out)`),
    Release: koffi.proto('int32 __stdcall ptz_Release(void *self)'),
    Read: koffi.proto('int32 __stdcall ptz_Read(void *self, str16 name, _Out_ dieyun_ptz_VARIANT *v, void *errlog)'),
    GetRange: koffi.proto(
      'int32 __stdcall ptz_GetRange(void *self, int32 prop, _Out_ int32 *mn, _Out_ int32 *mx, _Out_ int32 *step, _Out_ int32 *dflt, _Out_ int32 *caps)'
    ),
    Get: koffi.proto('int32 __stdcall ptz_Get(void *self, int32 prop, _Out_ int32 *value, _Out_ int32 *flags)'),
    Set: koffi.proto('int32 __stdcall ptz_Set(void *self, int32 prop, int32 value, int32 flags)')
  };

  /** vtbl 第 index 项（0=QueryInterface 1=AddRef 2=Release 3=…）。 */
  function method(self, index) {
    const vtbl = koffi.decode(self, PTR);
    return koffi.decode(vtbl, index * 8, PTR);
  }
  function invoke(self, index, spec, ...args) {
    return koffi.call(method(self, index), spec, self, ...args);
  }

  const CoInitializeEx = ole32.func('int32 __stdcall CoInitializeEx(void *reserved, uint32 coinit)');
  const CoCreateInstance = ole32.func(
    `int32 __stdcall CoCreateInstance(${GUID_T} clsid, void *outer, uint32 ctx, ${GUID_T} iid, _Out_ void **out)`
  );
  const SysStringLen = oleaut32.func('uint32 __stdcall SysStringLen(void *bstr)');
  const SysFreeString = oleaut32.func('void __stdcall SysFreeString(void *bstr)');

  const COINIT_APARTMENTTHREADED = 2;
  const CLSCTX_INPROC_SERVER = 1;

  const coInit = CoInitializeEx(null, COINIT_APARTMENTTHREADED);
  // S_FALSE(1) = 已初始化；RPC_E_CHANGED_MODE(0x80010106) = 别的模块用了 MTA，两种都能继续用。
  if (coInit !== 0 && coInit !== 1 && (coInit >>> 0) !== 0x80010106) throw comError('CoInitializeEx', coInit);

  bindings = {
    koffi,
    PTR,
    proto,
    invoke,
    CoCreateInstance,
    SysStringLen,
    SysFreeString,
    CLSCTX_INPROC_SERVER,
    CLSID_SystemDeviceEnum: guid('{62BE5D10-60EB-11d0-BD3B-00A0C911CE86}'),
    IID_ICreateDevEnum: guid('{29840822-5B84-11D0-BD3B-00A0C911CE86}'),
    CLSID_VideoInputDeviceCategory: guid('{860BB310-5D01-11D0-BD3B-00A0C911CE86}'),
    IID_IBaseFilter: guid('{56a86895-0ad4-11ce-b03a-0020af0ba770}'),
    IID_IPropertyBag: guid('{55272A00-42CB-11CE-8135-00AA004BB851}'),
    IID_IAMCameraControl: guid('{C6E13370-30AC-11d0-A18C-00A0C9118956}')
  };
  return bindings;
}

/** '{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}' → koffi 可传的 GUID 结构体实例。 */
function guid(text) {
  const m = String(text).match(/^\{?([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}?$/i);
  if (!m) throw new Error(`bad GUID: ${text}`);
  const tail = (m[4] + m[5]).replace(/[^0-9a-f]/gi, '');
  const bytes = [];
  for (let i = 0; i < 16; i += 2) bytes.push(parseInt(tail.slice(i, i + 2), 16));
  return {
    Data1: parseInt(m[1], 16),
    Data2: parseInt(m[2], 16),
    Data3: parseInt(m[3], 16),
    Data4: bytes
  };
}

/**
 * 枚举视频输入设备（DirectShow 设备分类）。
 *
 * 名字用的是 `FriendlyName`：它和 ffmpeg 的 dshow 设备名是**同一个字符串**
 * （`OBSBOT Tiny 2 StreamCamera`），所以「用户选的那台」与「取帧那台」是同一个口径。
 *
 * @returns {{ devices: Array<{ name: string, moniker: any }>, release(): void }}
 */
function enumerateVideoDevices() {
  const b = getBindings();
  const { invoke, proto } = b;

  const created = [];
  const release = () => {
    while (created.length) {
      const ptr = created.pop();
      try {
        invoke(ptr, 2, proto.Release);
      } catch {
        /* 释放失败不改变结果 */
      }
    }
  };

  const devEnum = [null];
  const hrCreate = b.CoCreateInstance(
    b.CLSID_SystemDeviceEnum,
    null,
    b.CLSCTX_INPROC_SERVER,
    b.IID_ICreateDevEnum,
    devEnum
  );
  if (hrCreate !== 0 || !devEnum[0]) throw comError('CoCreateInstance(SystemDeviceEnum)', hrCreate);
  created.push(devEnum[0]);

  const enumMoniker = [null];
  const hrEnum = invoke(devEnum[0], 3, proto.CreateClassEnumerator, b.CLSID_VideoInputDeviceCategory, enumMoniker, 0);
  // S_FALSE(1) = 这一类里一台设备都没有：不是错误。
  if (hrEnum !== 0 || !enumMoniker[0]) {
    release();
    return { devices: [], release() {} };
  }
  created.push(enumMoniker[0]);

  const devices = [];
  for (;;) {
    const one = [null];
    const hrNext = invoke(enumMoniker[0], 3, proto.Next, 1, one, null);
    if (hrNext !== 0 || !one[0]) break;
    created.push(one[0]);

    const bag = [null];
    const hrBag = invoke(one[0], 9, proto.BindToStorage, null, null, b.IID_IPropertyBag, bag);
    if (hrBag !== 0 || !bag[0]) continue;
    created.push(bag[0]);

    const v = {};
    const hrRead = invoke(bag[0], 3, proto.Read, 'FriendlyName', v, null);
    if (hrRead !== 0 || v.vt !== 8 || !v.data) continue;
    let name = '';
    try {
      // 为什么不用 `decode(ptr, 'str16')`：koffi 2.x 对裸 `str16` 指针解码会崩（实测访问违例）；
      // `char16_t` + `SysStringLen` 是同一份内存的安全读法。
      name = b.koffi.decode(v.data, 'char16_t', b.SysStringLen(v.data));
    } finally {
      b.SysFreeString(v.data);
    }
    const trimmed = String(name || '').trim();
    if (trimmed) devices.push({ name: trimmed, moniker: one[0] });
  }

  return { devices, release };
}

/** 当前有几台视频输入设备（名字数组）。 */
function listDeviceNames() {
  const res = enumerateVideoDevices();
  try {
    return res.devices.map((d) => d.name);
  } finally {
    res.release();
  }
}

/**
 * 打开一台设备的云台会话。
 *
 * @param {string} deviceName `FriendlyName`（与 ffmpeg 的 dshow 设备名同口径）
 * @returns {{ readAll(): object, write(values: object): void, close(): void }}
 */
function openSession(deviceName) {
  const b = getBindings();
  const { invoke, proto } = b;
  const wanted = String(deviceName || '').trim();
  if (!wanted) {
    const e = new Error('没有指定摄像头');
    e.code = 'NO_DEVICE';
    throw e;
  }

  const res = enumerateVideoDevices();
  try {
    const hit =
      res.devices.find((d) => d.name === wanted) || res.devices.find((d) => d.name.includes(wanted)) || null;
    if (!hit) {
      const e = new Error(`找不到名为「${wanted}」的视频输入设备`);
      e.code = 'NO_DEVICE';
      e.devices = res.devices.map((d) => d.name);
      throw e;
    }
    // moniker 只在 BindToObject 这一刻需要：绑出来的 filter 自带引用，
    // 所以 finally 里把枚举器和 moniker 全部放掉是安全的。
    const filter = [null];
    const hrFilter = invoke(hit.moniker, 8, proto.BindToObject, null, null, b.IID_IBaseFilter, filter);
    if (hrFilter !== 0 || !filter[0]) throw comError('BindToObject(IBaseFilter)', hrFilter);

    const cam = [null];
    const hrCam = invoke(filter[0], 0, proto.QueryInterface, b.IID_IAMCameraControl, cam);
    if (hrCam !== 0 || !cam[0]) {
      try {
        invoke(filter[0], 2, proto.Release);
      } catch {
        /* ignore */
      }
      const e = new Error('NO_PTZ');
      e.code = 'NO_PTZ';
      e.hr = hrCam;
      throw e;
    }

    const state = { closed: false };
    // 这两个指针是我们唯一持有的 COM 对象；moniker 由枚举器带着，这里只管自己的引用。
    const owned = [cam[0], filter[0]];

    return {
      /** @returns {{ position: object, ranges: object, supports: object }} */
      read() {
        if (state.closed) throw comError('read', 0x80004005);
        const position = {};
        const ranges = {};
        const supports = {};
        for (const [key, prop] of Object.entries(PROPS)) {
          const mn = [0];
          const mx = [0];
          const step = [0];
          const dflt = [0];
          const caps = [0];
          const hrRange = invoke(cam[0], 3, proto.GetRange, prop, mn, mx, step, dflt, caps);
          const value = [0];
          const flags = [0];
          const hrGet = invoke(cam[0], 5, proto.Get, prop, value, flags);
          const ok = hrRange === 0 && hrGet === 0 && mx[0] > mn[0];
          supports[key] = ok;
          if (!ok) continue;
          ranges[key] = { min: mn[0], max: mx[0], step: step[0], default: dflt[0] };
          position[key] = value[0];
        }
        return { position, ranges, supports };
      },

      write(values) {
        if (state.closed) throw comError('write', 0x80004005);
        for (const [key, raw] of Object.entries(values || {})) {
          const prop = PROPS[key];
          if (prop === undefined || raw === undefined || raw === null) continue;
          const hr = invoke(cam[0], 4, proto.Set, prop, Math.round(Number(raw)), CONTROL_MANUAL);
          if (hr !== 0) throw comError(`IAMCameraControl::Set(${key})`, hr);
        }
      },

      close() {
        if (state.closed) return;
        state.closed = true;
        for (const ptr of owned) {
          try {
            invoke(ptr, 2, proto.Release);
          } catch {
            /* ignore */
          }
        }
      }
    };
  } finally {
    // 枚举到的其它 moniker / 枚举器：现在就能放（session 只借用了被选中的那一个）。
    res.release();
  }
}

module.exports = {
  listDeviceNames,
  openSession
};
