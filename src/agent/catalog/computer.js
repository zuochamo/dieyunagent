'use strict';

/**
 * 屏幕与摄像头工具：computer（看/操作屏幕）/ camera_look（手机）/ desktop_camera_look（本机 UVC）。
 * 动作枚举的唯一来源是 `src/computer/actions.js`；画面不落盘的文案在 `src/agent/vision-image.js`。
 */
const { COMPUTER_ACTIONS_TEXT } = require('../../computer/actions');

const COMPUTER_TOOL = {
  type: 'function',
  function: {
    name: 'computer',
    description:
      '控制本机屏幕（OS 级电脑控制）：截屏、移动/点击鼠标、键盘输入、滚动、拖拽、等待、列窗口/切窗口。' +
      '坐标系 = 你最近一次看到的那张图的像素（左上角为原点）；多显示器时默认落在你看到的那块屏，可用 display 指定。' +
      '正确用法：先 action=screenshot 看清画面，再发动作；每个输入动作都会自动返回最新截图，据此决定下一步，不要凭记忆连点。' +
      '结果里的三个事实要当真：applied=true 表示动作确实执行了；changed=false 表示画面与上次看到的完全一样' +
      '（这一下没有可见反应，不要重复点同一处，换个思路）；stable=false 表示界面还在变化（加载中），先等再看。' +
      '要等界面就用 wait_until（condition=changed 等画面变化 / stable 等界面稳定），不要用 wait 猜毫秒数；' +
      '它超时会返回 timedOut=true（等的东西没发生）—— 这是「上一步大概没生效」的信号，别原样重复。' +
      '不知道该点哪里时先 list_windows 看窗口清单（比截图省 token），要切窗口用 activate_window + handle；' +
      '小字/小目标用 screenshot 的 region 裁出来看：裁出的区域就是新坐标系，之后的 click 坐标相对那块区域（要回整屏坐标就再截一次整屏）。' +
      '需要区间选择/多选/复制时用 modifiers（按住 shift / ctrl / alt）。' +
      `action 取值：${COMPUTER_ACTIONS_TEXT}。` +
      '无法操作需要管理员权限的窗口（UIPI）；首次操作鼠标/键盘会请求用户批准。' +
      '本工具操作的是「叠云运行的这台机器」的物理屏幕（target 缺省 = local），与会话工作空间在本机还是 SSH 远端无关；' +
      '要看/操作 SSH 主机自己的屏幕（服务器上那个弹窗、那台开发机的桌面），传 target=remote：' +
      '远端必须有图形会话且装了截图/注入工具（Linux: scrot|imagemagick + xdotool，Wayland: grim + ydotool，macOS: cliclick），' +
      '探不到会如实告诉你缺什么、怎么装；远端 Windows 暂未接入。' +
      'remote 下 list_windows / activate_window 不支持（没有窗口枚举通道）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: COMPUTER_ACTIONS_TEXT },
        target: {
          type: 'string',
          description:
            'local（默认）= 叠云这台机器的屏幕；remote = 当前会话 SSH 工作空间那台主机的屏幕（需要远端有图形会话与截图/注入工具）'
        },
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          description:
            '[x, y] 截图像素坐标。move/drag 必填（drag 为起点）；click 家族省略 = 在当前光标位置点击；scroll 可选（先移过去再滚）'
        },
        to: { type: 'array', items: { type: 'number' }, description: 'drag：终点坐标 [x, y]' },
        button: { type: 'string', description: 'click/drag 用的鼠标键：left（默认）| right | middle' },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description:
            '动作期间按住的修饰键：shift | ctrl | alt | win（click 家族与 drag 可用）。例：shift 点击 = 选中一段区间；ctrl 点击 = 多选；ctrl 拖拽 = 复制'
        },
        region: {
          type: 'array',
          items: { type: 'number' },
          description:
            'screenshot：只截这块区域 [x, y, 宽, 高]（相对你最近一次看到的那张图）。裁出的是 1:1 像素，小字看得清；之后点击坐标就相对这块区域'
        },
        condition: {
          type: 'string',
          description:
            'wait_until：changed（等画面发生变化，默认）| stable（等界面连续两帧不再变化）。超时会返回 timedOut=true'
        },
        handle: {
          type: 'number',
          description: 'activate_window：list_windows 返回的窗口句柄（必须在最近一次清单里）'
        },
        text: { type: 'string', description: 'type：要输入的文本（支持中文；\\n 会按回车键发送）。type 必填' },
        key: {
          type: 'string',
          description:
            'key：组合键，如 "ctrl+c"、"alt+f4"、"win"、"enter"、"ctrl+shift+esc"。支持 win/ctrl/alt/shift 修饰键。key 必填'
        },
        direction: { type: 'string', description: 'scroll：up | down（默认 down）' },
        amount: { type: 'number', description: 'scroll：滚动格数（默认 3）' },
        ms: {
          type: 'number',
          description: 'wait：等待毫秒（50–10000）；wait_until：超时上限（默认 8000，最多 20000）'
        },
        display: { type: 'number', description: '多显示器时的屏幕序号（0 = 主屏）；默认沿用你最近一次截图的屏幕' }
      },
      required: ['action']
    }
  }
};

/**
 * 内网 agent 互通（`src/peer/`）。三个工具分工刻意保持最小：
 * - `peer_list`   只读：谁在线、谁和我在同一个项目、谁已经声明在改哪些文件/任务；
 * - `peer_send`   发一句话给某个对端 agent（可等它跑完一轮再回）；
 * - `peer_claim`  建议式租约（声明 / 查询 / 释放），减少两人同时改同一个文件。
 *
 * 为什么不给「列对端会话 / 读对端历史」的工具：跨机器读别人的会话上下文等于
 * 绕过「消息即接口」这条边界，也让人无法判断哪句话是对自己说的。要上下文就让对方说。
 */

const CAMERA_TOOL = {
  type: 'function',
  function: {
    name: 'camera_look',
    description:
      '让用户的手机摄像头拍一张现实世界的照片，图片会作为视觉输入附到下一轮（你随后就能看见）。' +
      '这是唯一能看到「真实世界」的工具：屏幕里的东西用 computer / browser 截图，桌面上的物品、用户本人、房间与现场用这个。' +
      'focus 选摄像头：face = 前置，看用户本人（表情、是否在、手上拿着什么）；desk / scene = 后置，看桌面与周围环境（默认）。' +
      '一次只拍一张，不常开、不做视频流，每次拍摄手机上都会有可见提示，所以只在真的需要看的时候调用。' +
      '必须如实对待结果：ok=false 时你**没有**拿到任何画面，不要编造看到的内容；' +
      'CAMERA_NO_DEVICE = 手机没连上（让用户去手机端连电脑）；CAMERA_NO_BRIDGE = 手机连着但页面拿不到相机（改用叠云 App 打开）；' +
      'CAMERA_DENIED = 用户在手机上拒了相机权限（重试无用，让用户去系统设置里开）；' +
      'CAMERA_TIMEOUT = 手机在但没拍成（可以再试一次，连续两次失败就改用文字问用户）。' +
      '照片是「刚才那一刻」，不要拿上一次的画面推断现在；需要新画面就再拍。',
    parameters: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          description: 'face = 前置看人 | desk = 后置看桌面/手上的东西（默认）| scene = 后置看周围环境'
        }
      }
    }
  }
};

/**
 * 本机摄像头（桌面 UVC：OBSBOT Tiny 2、普通 USB 摄像头等）。
 *
 * 与 `camera_look` 的分工：那颗是**手机**（随身、能拿起来对着别处），这颗是**电脑上那台**
 * （固定机位、分辨率稳定、不用手机在旁边）。两者都是「一次一张、不常开」，
 * 抓帧实现见 `agent/desktop-camera-source.js`。
 *
 * 为什么单独成一个工具而不是给 camera_look 加 source 参数：设备在哪、失败怎么修、
 * 额度怎么计都是两套（手机要连、本机要 ffmpeg），合在一个工具里模型会把
 * 「手机没连上」和「没装 ffmpeg」混成同一句话。
 */
const DESKTOP_CAMERA_TOOL = {
  type: 'function',
  function: {
    name: 'desktop_camera_look',
    description:
      '用这台电脑上接的摄像头（如 OBSBOT Tiny 2 等 USB 摄像头）抓一张现实画面，图片会作为视觉输入附到下一轮。' +
      '和 camera_look 的区别：那颗是手机（得用户把手机连上来、能拿起来对着别处），这颗是电脑上固定那台（不用手机）。' +
      '适合「看一眼我桌上」「我现在什么状态」「这个实物长什么样」；屏幕里的东西仍然用 computer / browser 截图。' +
      '一次只抓一张，不常开、不做视频流。必须如实对待结果：ok=false 时你**没有**拿到任何画面，不要编造看到的内容；' +
      'DESKTOP_CAMERA_NO_DEVICE = 没找到摄像头（让用户确认插好/没被禁用）；' +
      'DESKTOP_CAMERA_NO_FFMPEG = 本机没有 ffmpeg（让用户装，或改用 camera_look / computer）；' +
      'DESKTOP_CAMERA_BUSY / TIMEOUT = 摄像头被别的程序占着（可以再试一次，别连拍）。' +
      '画面是「刚才那一刻」，不要拿上一次的画面推断现在。',
    parameters: {
      type: 'object',
      properties: {}
    }
  }
};

module.exports = {
  COMPUTER_TOOL,
  CAMERA_TOOL,
  DESKTOP_CAMERA_TOOL
};
