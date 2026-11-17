'use strict';

/**
 * 浏览器工具（37 个，catalog 里最大的一块）：导航 / 快照 / 交互 / 观测 / 视口 / 权限。
 * 引擎契约与 ref 身份都不在这里定义，只引用它们的唯一来源。
 */
const { ENGINE_PARAM_SCHEMA } = require('../../browser/engine-target');
const { REF_PARAM_SCHEMA } = require('../../browser/ref-namespace');
const { LOCAL_PATH_HINT, FRAME_PARAM, FORCE_PARAM, SNAPSHOT_MODE_PARAM, ANNOTATE_PARAM } = require('./params');

const BROWSER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description:
        '在内嵌浏览器打开页面。支持 http/https，以及工作空间白名单内的本地 HTML（file://、绝对/相对路径如 index.html）。需要交互式浏览、登录、填表、预览本地页面时优先于 web_fetch。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'http/https URL，或本地路径（如 index.html、D:\\\\site\\\\index.html、file:///D:/site/index.html）'
          },
          engine: ENGINE_PARAM_SCHEMA,
          waitUntil: { type: 'string', description: 'load 或 domcontentloaded' },
          timeoutMs: { type: 'number', description: '导航超时毫秒，默认 60000' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_reload',
      description: '刷新当前浏览器页面。',
      parameters: {
        type: 'object',
        properties: {
          engine: ENGINE_PARAM_SCHEMA,
          waitUntil: { type: 'string', description: 'load 或 domcontentloaded' },
          timeoutMs: { type: 'number', description: '超时毫秒，默认 60000' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_back',
      description: '浏览器后退到上一页。',
      parameters: {
        type: 'object',
        properties: {
          engine: ENGINE_PARAM_SCHEMA,
          waitUntil: { type: 'string' },
          timeoutMs: { type: 'number' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_forward',
      description: '浏览器前进到下一页。',
      parameters: {
        type: 'object',
        properties: {
          engine: ENGINE_PARAM_SCHEMA,
          waitUntil: { type: 'string' },
          timeoutMs: { type: 'number' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description:
        '获取当前浏览器页面的可交互元素列表（ref）与文本摘要。点击/输入前必须先 snapshot 拿到 ref；页面跳转或 DOM 大变后需重新 snapshot。可选 delayMs 等待 SPA 渲染。返回体含 coverage（扫描/收录/过滤数）与 frames（iframe 清单）；filteredVisible/omitted 很大时用 mode=all 或 browser_frames 细化。',
      parameters: {
        type: 'object',
        properties: {
          interactive: { type: 'boolean', description: '仅返回可交互元素，默认 true' },
          delayMs: { type: 'number', description: 'snapshot 前等待毫秒（SPA 页面建议 300–1500）' },
          maxElements: { type: 'number', description: '最多返回元素数，默认 120' },
          mode: SNAPSHOT_MODE_PARAM,
          frame: FRAME_PARAM,
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_a11y_snapshot',
      description:
        '获取页面或指定 frame 的可访问性（a11y）树：角色、名称、状态。DOM 混乱或 snapshot 找不到元素时可用；不返回可点击 ref，需配合 browser_snapshot 或 selector。',
      parameters: {
        type: 'object',
        properties: {
          maxNodes: { type: 'number', description: '最多返回节点数，默认 200' },
          delayMs: { type: 'number', description: '扫描前等待毫秒' },
          frame: FRAME_PARAM,
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_network',
      description:
        '查看浏览器最近 HTTP(S) 请求（HAR-lite）。用于调试 API 失败、登录接口、页面加载问题。action=list（默认）或 clear；可 filter urlPattern、errorsOnly。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list | clear，默认 list' },
          limit: { type: 'number', description: '最多返回条数，默认 50' },
          urlPattern: { type: 'string', description: 'URL 子串或正则过滤' },
          errorsOnly: { type: 'boolean', description: '仅 4xx/5xx 或失败请求' },
          sinceMs: { type: 'number', description: '仅最近 N 毫秒内的请求' },
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_console',
      description:
        '查看浏览器页面的 console 输出与运行时错误（未捕获异常、未处理 Promise 拒绝）。这是验收前端改动/排查白屏的关键信号：页面"看起来正常"但实际在报错时，用它确认。action=list（默认）或 clear；errorsOnly 只看 error。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list | clear，默认 list' },
          limit: { type: 'number', description: '最多返回条数，默认 50' },
          level: { type: 'string', description: '只看某个等级：debug | info | log | warn | error' },
          errorsOnly: { type: 'boolean', description: '仅 error 级（含未捕获异常/未处理拒绝）' },
          urlPattern: { type: 'string', description: '按来源 URL 子串或正则过滤' },
          sinceMs: { type: 'number', description: '仅最近 N 毫秒内的记录' },
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description:
        '在浏览器页面点击元素。必须先 browser_snapshot 拿到 ref（如 ref-0@s1），再传入 ref 点击；每次页面变化后需重新 snapshot（旧 ref 会明确报 ref 已失效，不会错点别的元素）。不要用 host_open_url 代替 browser_navigate。可选 button=right 做右键、clickCount=2 做双击——本工具已覆盖，勿另找专用工具。目标被遮挡时会回报遮挡者；确需强点设 force=true。',
      parameters: {
        type: 'object',
        properties: {
          ref: REF_PARAM_SCHEMA,
          selector: { type: 'string', description: 'CSS 选择器（与 ref 二选一）' },
          button: { type: 'string', description: 'left | right | middle，默认 left' },
          clickCount: { type: 'number', description: '1 或 2（双击），默认 1' },
          frame: FRAME_PARAM,
          force: FORCE_PARAM,
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: '向输入框输入文本。默认追加到现有内容；清空后重填设 clear=true。',
      parameters: {
        type: 'object',
        properties: {
          ref: REF_PARAM_SCHEMA,
          selector: { type: 'string' },
          text: { type: 'string', description: '要输入的文本' },
          clear: { type: 'boolean', description: '输入前是否清空，默认 false（追加到现有内容）' },
          frame: FRAME_PARAM,
          force: FORCE_PARAM,
          engine: ENGINE_PARAM_SCHEMA
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_select_option',
      description:
        '选择 <select> 下拉框选项。先 browser_snapshot 获取 select 的 ref 及 options；传 value（option 的 value）或 label（可见文本）之一。',
      parameters: {
        type: 'object',
        properties: {
          ref: REF_PARAM_SCHEMA,
          selector: { type: 'string', description: 'CSS 选择器，如 select#country' },
          value: { type: 'string', description: 'option 的 value 属性' },
          label: { type: 'string', description: 'option 的可见文本（与 value 二选一）' },
          frame: FRAME_PARAM,
          force: FORCE_PARAM,
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_hover',
      description: '悬停在元素上（下拉菜单、tooltip、hover 态预览）。需 ref 或 selector。',
      parameters: {
        type: 'object',
        properties: {
          ref: REF_PARAM_SCHEMA,
          selector: { type: 'string', description: 'CSS 选择器' },
          frame: FRAME_PARAM,
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_drag',
      description: '拖拽元素（滑块、排序列表、拖放 UI）。起始 ref/selector 必填；目标 toRef/toSelector 或相对位移 dx/dy。',
      parameters: {
        type: 'object',
        properties: {
          ref: REF_PARAM_SCHEMA,
          selector: { type: 'string', description: '起始 CSS 选择器' },
          toRef: REF_PARAM_SCHEMA,
          toSelector: { type: 'string', description: '目标 CSS 选择器' },
          dx: { type: 'number', description: '相对起始元素中心的水平位移（像素）' },
          dy: { type: 'number', description: '相对起始元素中心的垂直位移（像素）' },
          frame: FRAME_PARAM,
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: '滚动页面或指定元素。',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', description: 'up|down|left|right，默认 down' },
          amount: { type: 'number', description: '像素，默认 400' },
          ref: REF_PARAM_SCHEMA,
          selector: { type: 'string' },
          frame: FRAME_PARAM,
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_press_key',
      description:
        '在浏览器页面按下键盘键，可带修饰键组合：Control+A 全选、Control+C/V 复制粘贴、Control+Enter 提交、Shift+Tab 反向切换、Escape 关闭弹层。',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description:
              '键名，默认 Enter。如 Enter | Tab | Escape | Backspace | Delete | ArrowUp | Home | A'
          },
          modifiers: {
            type: 'array',
            items: { type: 'string' },
            description:
              "修饰键数组：control/shift/alt/meta（同义 ctrl、cmd、command、option、win）。例 ['control'] 表示 Control+key"
          },
          frame: FRAME_PARAM,
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description:
        '截取浏览器页面或单个元素截图（PNG base64）。可传 ref/selector 仅截元素区域。给 filePath 时会同时把 PNG 落盘作为验收留证（返回 path）。annotate=true 会在图上叠加 ref 编号方框，便于核对元素位置。',
      parameters: {
        type: 'object',
        properties: {
          ref: REF_PARAM_SCHEMA,
          selector: { type: 'string', description: 'CSS 选择器（元素截图）' },
          fullPage: { type: 'boolean', description: '是否整页截图' },
          filePath: {
            type: 'string',
            description:
              '可选：把截图保存到该路径（相对工作空间或绝对路径，须在白名单内）。' + LOCAL_PATH_HINT
          },
          frame: FRAME_PARAM,
          annotate: ANNOTATE_PARAM,
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_pdf',
      description:
        '把当前浏览器页面导出为 PDF 并保存到本地，返回文件路径（二进制不进模型上下文）。适合报告归档、页面留存。省略 filePath 时存到系统下载目录。注意：Playwright 引擎仅在无头模式支持导出，可见窗口下 auto 会回退到 BrowserView。',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description:
              '保存路径（相对工作空间或绝对路径，须在白名单内）；省略时存到系统下载目录。' + LOCAL_PATH_HINT
          },
          format: { type: 'string', description: '纸张尺寸，如 A4、Letter，默认 A4' },
          landscape: { type: 'boolean', description: '是否横向，默认 false' },
          printBackground: { type: 'boolean', description: '是否打印背景色，默认 true' },
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_evaluate',
      description:
        '在指定 frame 执行 JavaScript 并返回结果（JSON 文本，超长会截断）。用于读取页面数据、调用页面内 API、或 snapshot/ref 覆盖不到的精确操作。返回值自动做 DOM 安全序列化（DOM 节点转 {tag,id,class,text}，函数/循环引用兜底），执行出错会返回 {error,stack,line}。高危：可读写页面与同源数据（含登录态），仅在确有必要时使用，不要执行来源不明的脚本。',
      parameters: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: 'JS 源码；支持 return 与 await（内部包裹在 async IIFE 中执行）'
          },
          maxChars: { type: 'number', description: '返回 JSON 最大字符数，默认 32000' },
          timeoutMs: { type: 'number', description: '超时毫秒，默认 15000，上限 60000' },
          frame: FRAME_PARAM,
          engine: ENGINE_PARAM_SCHEMA
        },
        required: ['script']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait_for',
      description:
        '等待浏览器页面达到条件。适合 SPA 加载、点击后等待文本/元素/URL/网络空闲。kind 可为 selector、text、url、load、networkidle。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'selector | text | url | load | networkidle，默认 selector' },
          value: { type: 'string', description: '等待的选择器/文本/URL 片段；也可用 selector/text/url 字段' },
          selector: { type: 'string' },
          text: { type: 'string' },
          url: { type: 'string' },
          state: { type: 'string', description: 'visible、attached、load、domcontentloaded，默认 visible' },
          frame: FRAME_PARAM,
          timeoutMs: { type: 'number', description: '超时毫秒，默认 30000' },
          intervalMs: { type: 'number', description: 'BrowserView 轮询间隔毫秒，默认 300' },
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_tabs',
      description:
        '管理浏览器标签页/新窗口。action=list/new/open/switch/close。BrowserView 支持多标签（后台标签保留页面状态）；页面 window.open 的链接会登记为「待打开标签」，用 action=open 传 tabId 打开，不会劫持当前页。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list | new | open | switch | close，默认 list' },
          tabId: { type: 'string', description: 'browser_tabs 返回的 tab id，如 tab-0' },
          url: { type: 'string', description: 'new/open 时打开的 URL' },
          waitUntil: { type: 'string' },
          timeoutMs: { type: 'number' },
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_downloads',
      description:
        '查看或等待浏览器下载结果。点击下载按钮后调用 action=wait，可返回下载文件路径；action=list 查看最近下载，action=clear 清空记录。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list | wait | clear，默认 list' },
          timeoutMs: { type: 'number', description: '等待下载超时毫秒，默认 30000' },
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_upload_file',
      description:
        '给网页上传本地文件。目标可以是 file input，也可以是其容器（自动找内部 file input）或拖拽上传区（自动派发 drop）。优先 browser_snapshot 取 ref，也可传 CSS selector。auto 模式默认用 Playwright。',
      parameters: {
        type: 'object',
        properties: {
          ref: REF_PARAM_SCHEMA,
          selector: { type: 'string', description: 'CSS 选择器，如 input[type=file]' },
          filePath: { type: 'string', description: '要上传的本地文件路径，可为相对工作空间路径' },
          mime: { type: 'string', description: '可选 MIME 类型' },
          frame: FRAME_PARAM,
          timeoutMs: { type: 'number' },
          engine: ENGINE_PARAM_SCHEMA
        },
        required: ['filePath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_observe',
      description:
        '一次性观察页面：返回当前 URL、标题、文本摘要、可交互元素 refs、viewport、截图与事件时间线摘要。复杂网页任务优先用它替代 snapshot+screenshot。',
      parameters: {
        type: 'object',
        properties: {
          interactive: { type: 'boolean', description: '是否只返回可交互元素，默认 true' },
          maxElements: { type: 'number', description: '最多元素数，默认 120' },
          delayMs: { type: 'number', description: '观察前等待毫秒' },
          screenshot: { type: 'boolean', description: '是否包含截图 base64，默认 true' },
          fullPage: { type: 'boolean', description: '截图是否整页' },
          mode: SNAPSHOT_MODE_PARAM,
          frame: FRAME_PARAM,
          annotate: ANNOTATE_PARAM,
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_expect',
      description:
        '对页面做结构化断言（一次可多条），返回逐条 pass/fail 与 actual。这是"验收"的推荐方式：比 browser_evaluate 自写脚本更明确，且断言未通过会被标记为验收未通过。kind 可选 visible / hidden / text / value / count / url。',
      parameters: {
        type: 'object',
        properties: {
          assertions: {
            type: 'array',
            description: '断言列表，最多 20 条',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '可选标识，回显在结果里' },
                kind: {
                  type: 'string',
                  description: 'visible | hidden | text | value | count | url'
                },
                ref: REF_PARAM_SCHEMA,
                selector: {
                  type: 'string',
                  description: 'CSS 选择器（visible/hidden/text/value 与 count 用；与 ref 二选一）'
                },
                expected: {
                  type: 'string',
                  description: '期望值：text/value/url 为文本，count 为数字'
                },
                match: { type: 'string', description: 'contains（默认）| equals' },
                op: { type: 'string', description: 'count 专用：equals（默认）| gte | lte' }
              },
              required: ['kind']
            }
          },
          timeoutMs: { type: 'number', description: '超时毫秒，默认 15000，上限 60000' },
          frame: FRAME_PARAM,
          engine: ENGINE_PARAM_SCHEMA
        },
        required: ['assertions']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_visual_diff',
      description:
        '视觉回归验收：把当前页面（或元素）截图与基准图逐像素比较，返回变化比例并输出 diff 图（不进模型上下文）。首次调用创建基准，再次调用即比较。基准文件名会带上引擎标记，所以不同引擎各有一份基准、不会互相覆盖（跨引擎比较无从发生）；比较只在「同引擎 + 同视口」下才有意义，换了视口会判为尺寸变化而不做逐像素比较。',
      parameters: {
        type: 'object',
        properties: {
          baselinePath: {
            type: 'string',
            description:
              '基准图路径；会按引擎自动加标记（base.png → base.browserview.png），已带标记的路径原样使用 —— 把上次返回的路径传回即可。省略时按目标生成稳定文件名落在工作区，保证同目标多次调用比的是同一张'
          },
          filePath: { type: 'string', description: 'diff 图保存路径；省略时落到默认产物目录' },
          ref: REF_PARAM_SCHEMA,
          selector: { type: 'string', description: '只比较该元素（CSS 选择器）' },
          threshold: {
            type: 'number',
            description: '判定"有变化"的变化像素比例阈值，默认 0.005（即 0.5%）'
          },
          fullPage: { type: 'boolean', description: '整页截图；需与基准创建时一致' },
          reset: { type: 'boolean', description: 'true 时用当前截图重建基准' },
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_viewport',
      description:
        '覆盖浏览器视口尺寸做设备仿真/响应式验收。BrowserView 默认随面板尺寸、Playwright 默认 1280×800，同一页面因此渲染不同；做响应式或跨引擎一致性验收前先显式设置视口。设置会同时镜像到另一引擎（auto 中途换引擎后仍按同一尺寸渲染）。reset=true 恢复默认。',
      parameters: {
        type: 'object',
        properties: {
          width: { type: 'number', description: '视口宽（120–4096）' },
          height: { type: 'number', description: '视口高（120–4096）' },
          deviceScaleFactor: { type: 'number', description: '像素比，默认 1（仅 BrowserView 生效）' },
          mobile: { type: 'boolean', description: '移动端布局，默认 false（仅 BrowserView 生效）' },
          reset: { type: 'boolean', description: 'true 时清除覆盖、恢复默认视口' },
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_status',
      description: '查询浏览器当前 URL、标题、引擎与视口状态。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: '关闭浏览器会话（内嵌视图与 Playwright）。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_import_storage',
      description:
        '向内嵌浏览器导入 Cookie 和/或 localStorage（须用户在本机弹窗确认）。localStorage 仅写入当前已打开页面的同源。不支持 javascript: URL。导入后建议 browser_reload。',
      parameters: {
        type: 'object',
        properties: {
          cookies: {
            type: 'array',
            description: 'Cookie 数组，每项含 name、value、domain 或 url，可选 path/secure/httpOnly/expires',
            items: { type: 'object' }
          },
          localStorage: {
            type: 'object',
            description: '键值对象，写入当前页 origin 的 localStorage'
          },
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_export_storage',
      description:
        '导出当前浏览器分区的登录态（Cookie + 当前页同源 localStorage），须用户在本机弹窗确认。browser_import_storage 的反向操作，用于跨会话/跨工具传递登录态。结果含敏感凭据，请勿写入日志或提交版本库。',
      parameters: {
        type: 'object',
        properties: {
          cookies: { type: 'boolean', description: '是否导出 Cookie，默认 true' },
          localStorage: { type: 'boolean', description: '是否导出当前页同源 localStorage，默认 true' },
          url: { type: 'string', description: '可选：只导出该 URL 同源 Cookie' },
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_cookies',
      description:
        '细粒度读写当前浏览器分区的 Cookie（list/set/delete）。用于查看登录态、单独设置某个 token 后 reload、或清理指定 Cookie。整包导入导出请用 browser_import_storage / browser_export_storage。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list（默认）| set | delete' },
          url: {
            type: 'string',
            description: '限定来源 URL；list/delete 建议提供，用于定位域与作用域'
          },
          name: { type: 'string', description: '单条 Cookie 名称（set/delete 单条时使用）' },
          value: { type: 'string', description: 'set 时的 Cookie 值' },
          domain: { type: 'string', description: 'set/delete 时的域，如 example.com' },
          path: { type: 'string', description: 'Cookie path，默认 /' },
          secure: { type: 'boolean' },
          httpOnly: { type: 'boolean' },
          sameSite: { type: 'string', description: 'lax | strict | none' },
          cookies: {
            type: 'array',
            description:
              '批量操作：Cookie 数组，每项含 name、value、domain 或 url，可选 path/secure/httpOnly/sameSite',
            items: { type: 'object' }
          },
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_dialog',
      description:
        '查看/处理页面 JS 对话框（alert / confirm / prompt / beforeunload）。默认策略 auto 会自动接受并记录，页面不会因弹窗卡死；需要自己决定先设 policy=manual 再 action=handle。页面操作"点了没反应"时先用它 list 排查是否被弹窗挡住。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list（默认）| handle | policy' },
          accept: { type: 'boolean', description: 'handle 时是否接受，默认 true' },
          promptText: { type: 'string', description: 'prompt 对话框要填入的文本' },
          policy: { type: 'string', description: 'auto（默认，自动接受）| accept | dismiss | manual' },
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_route',
      description:
        '拦截并改写网页请求（mock 接口 / 改响应或请求头 / 阻断资源）。add 后立即生效，按 urlPattern（支持 * 通配）从上到下取首个匹配规则。type=fulfill 造响应、abort 断请求、modifyHeaders 改请求头、continue 仅透传。用完记得 clear。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list（默认）| add | remove | clear' },
          urlPattern: {
            type: 'string',
            description: 'URL 匹配，如 */api/user* 或 https://x.com/api/*；默认 *（全部）'
          },
          type: { type: 'string', description: 'fulfill（默认）| abort | modifyHeaders | continue' },
          status: { type: 'number', description: 'fulfill 时的响应状态码，默认 200' },
          body: { type: 'string', description: 'fulfill 时的响应体文本（JSON 直接给字符串）' },
          headers: { type: 'object', description: '响应头（fulfill）或请求头（modifyHeaders）' },
          contentType: {
            type: 'string',
            description: 'fulfill 时的 Content-Type，默认 application/json; charset=utf-8'
          },
          errorReason: { type: 'string', description: 'abort 时的失败原因，默认 failed' },
          id: { type: 'string', description: 'remove 时的规则 id（如 route-0）' },
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_emulate',
      description:
        '模拟设备环境与权限：定位（geolocation）、时区（timezone）、语言（locale）、权限授权（permissions）。用于验收需要定位/通知的页面，或复现特定时区/语言下的问题。默认策略仍是拒绝这些权限，只有显式授予才放行；action=reset 恢复默认。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'set（默认）| reset | status' },
          geolocation: {
            type: 'object',
            description: '定位：{ latitude, longitude, accuracy? }；latitude -90~90，longitude -180~180',
            properties: {
              latitude: { type: 'number' },
              longitude: { type: 'number' },
              accuracy: { type: 'number' }
            }
          },
          timezone: { type: 'string', description: 'IANA 时区，如 Asia/Shanghai' },
          locale: { type: 'string', description: '语言环境，如 zh-CN / en-US' },
          permissions: {
            type: 'array',
            items: { type: 'string' },
            description:
              '要模拟授予的权限：geolocation | notifications | clipboard-read | clipboard-sanitized-write | midi'
          },
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_har_export',
      description:
        '把浏览器最近网络请求记录导出为 HAR 1.2 文件并返回路径（不进模型上下文）。仅含方法/状态/耗时等摘要，不含请求头与响应体；可用 DevTools 打开。配合 browser_network 排查完问题后归档。',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description:
              '保存路径（相对工作空间或绝对路径，须在白名单内）；省略时存到系统下载目录。' + LOCAL_PATH_HINT
          },
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_frames',
      description:
        '列出当前页面所有 iframe/frame 及其可定位标识（path / name / url / index）。当 snapshot 提示内容在子 frame、或点击/读取元素报 FRAME_NOT_FOUND 时，先用本工具定位 frame，再把 path/name/url 传给其它浏览器工具的 frame 参数。跨域 frame 也能列出。',
      parameters: {
        type: 'object',
        properties: {
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_timeline',
      description:
        '读取页面事件时间线摘要：页面侧真实事件（click / input / keydown / change / submit / navigate，capture 阶段含 iframe 内）+ Agent 侧动作。用于回答"刚才操作后发生了什么""点了为什么没反应"。action=read 读取（默认 list），action=clear 清空。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list（默认）| clear' },
          limit: { type: 'number', description: '最多返回条数，默认 80，上限 300' },
          sinceMs: { type: 'number', description: '只返回最近 N 毫秒内的事件' },
          type: { type: 'string', description: '按事件类型过滤，如 click | input | keydown' },
          types: {
            type: 'array',
            items: { type: 'string' },
            description: '按多个事件类型过滤（与 type 二选一）'
          },
          source: {
            type: 'string',
            description: '按事件来源过滤：agent（Agent 动作）| page（页面真实事件）；不传为全部'
          },
          frame: {
            type: 'string',
            description: '按事件所在 frame 过滤（子串匹配）：页面侧为 main | iframe，Agent 侧为 path=0.1 等'
          },
          urlPattern: { type: 'string', description: '按事件 URL 过滤：正则（如 /checkout/）或普通子串，忽略大小写' },
          includeInput: {
            type: 'boolean',
            description: '是否保留 input 事件及其内容原文；默认 false（input 事件整条省略）'
          },
          engine: ENGINE_PARAM_SCHEMA
        }
      }
    }
  }
];

/**
 * 浏览器「专用」工具：验收 / 调试 / 凭据 / 导出 类。只有确实在做浏览器任务时才用得上，
 * 因此与 BROWSER_CORE_TOOLS 分开导出，由 renderer 按会话状态决定是否注册进 schema。
 * BROWSER_TOOLS 仍保持全量（测试与弱模型白名单继续消费它），不改变既有语义。
 */
const BROWSER_ADVANCED_TOOL_NAMES = Object.freeze([
  'browser_visual_diff',
  'browser_viewport',
  'browser_emulate',
  'browser_route',
  'browser_dialog',
  'browser_har_export',
  'browser_cookies',
  'browser_import_storage',
  'browser_export_storage',
  'browser_pdf'
]);

const BROWSER_ADVANCED_TOOLS = BROWSER_TOOLS.filter((t) =>
  BROWSER_ADVANCED_TOOL_NAMES.includes(t && t.function && t.function.name)
);

const BROWSER_CORE_TOOLS = BROWSER_TOOLS.filter(
  (t) => !BROWSER_ADVANCED_TOOL_NAMES.includes(t && t.function && t.function.name)
);


module.exports = {
  BROWSER_TOOLS,
  BROWSER_ADVANCED_TOOL_NAMES,
  BROWSER_ADVANCED_TOOLS,
  BROWSER_CORE_TOOLS
};
