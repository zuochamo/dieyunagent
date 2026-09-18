'use strict';

const HOST_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'host_open_url',
      description: '在系统默认浏览器中打开 http/https 链接',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整 URL，如 https://example.com' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'host_print_image',
      description:
        '将工作空间内的图片文件发送到默认打印机。filePath 填绝对路径，或仅填文件名（如 123.jpg，相对工作空间根目录）。不要用 host_exec 调 mspaint 拼路径。',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: '图片路径，例如 C:\\folder\\123.jpg 或 123.jpg'
          }
        },
        required: ['filePath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'host_exec',
      description:
        '在本机执行 Shell 命令，工作目录默认为当前工作空间（用 cwd 参数指定子目录，勿用 cd xxx &&）。' +
        'Windows 下实际为 cmd.exe：分号 ; 会切断命令，禁止 python -c "a; b" 这类写法，请写临时 .py 再 python 运行。' +
        '启动 GUI/长期运行程序（如 pythonw main.py）请设 detached=true，并用 cwd 指向项目目录，不要 start /B（会超时）。' +
        'Windows GUI 推荐：command=pythonw main.py，cwd=项目目录，detached=true。' +
        'detached=true 的返回体会带 handle（进程句柄），之后可用 host_proc 查看/结束。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          cwd: { type: 'string', description: '工作目录（相对工作空间或绝对路径）' },
          detached: {
            type: 'boolean',
            description: 'true 时后台启动，不等待进程结束（GUI/守护进程必用）'
          },
          timeoutMs: { type: 'number', description: '可选超时（毫秒），仅 detached=false 时有效' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'host_proc',
      description:
        '管理由 host_exec 启动的进程：action=list 列出仍在运行的进程（含 host_exec detached 返回的 handle、PID、命令、存活状态）；action=kill 用 handle 或 pid 结束进程树。只能结束本会话经 host_exec 启动的进程，不能结束任意系统进程。用于清理未退出的 GUI/后台进程。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list（默认）| kill' },
          id: { type: 'string', description: 'kill：host_exec 返回的 handle，如 hostproc-3' },
          pid: { type: 'number', description: 'kill：进程 PID（须是 host_exec 启动过的）' },
          includeFinished: {
            type: 'boolean',
            description: 'list：是否附带已结束的进程，默认 false（只看存活）'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fs_read_file',
      description:
        '读取工作空间、~/.dieyun/workspace 或白名单目录内的文件；文本默认 utf8。改已有文件前先读，再用 fs_edit。' +
        '想重新看某张图片（例如历史消息里 [附件图 …] 标注的路径）时设 encoding=base64：图片会作为视觉输入附到下一轮，不会返回 base64 文本。',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: '文件路径（相对路径相对于当前工作空间或 ~/.dieyun/workspace）'
          },
          encoding: {
            type: 'string',
            description:
              '编码，默认 utf8；想「看图」时设 base64（图片会附到下一轮作为视觉输入，不返回 base64 文本）；其它二进制文件也用 base64'
          },
          offset: { type: 'number', description: '读取起始字节偏移（可选，用于大文件分块）' },
          maxBytes: { type: 'number', description: '最多读取字节数（省略则约 64KB；可用 offset 续读，上限 16MB）' }
        },
        required: ['filePath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fs_edit',
      description:
        '对已有文本文件做字面量替换（优先于 fs_write_file）。oldString/oldText 必须从最近一次 fs_read_file 原文复制，且对调用时的原文件匹配（不要按上一处改动递增匹配）。同一文件多处不相交改动请一次调用，放入 edits[]。默认要求唯一匹配；单处多命中时扩大上下文或设 replaceAll=true。oldText 尽量短但须唯一，不要垫大段未改区域。不要用此工具新建文件。不要用 apply_patch 或 host_exec 改文件。',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: '文件路径（相对路径相对于当前工作空间或 ~/.dieyun/workspace）'
          },
          oldString: {
            type: 'string',
            description: '要替换的原文片段（须唯一，除非 replaceAll）。与 edits 二选一或同时提供（会一并应用）'
          },
          newString: {
            type: 'string',
            description: '替换后的文本（空字符串表示删除该片段）'
          },
          replaceAll: {
            type: 'boolean',
            description: '仅当只有一处替换时生效：为 true 时替换全部匹配；默认 false'
          },
          edits: {
            type: 'array',
            description:
              '同一文件的多处不相交替换。每项对原文件匹配，禁止重叠。邻近改动请合并为一条。',
            items: {
              type: 'object',
              properties: {
                oldText: { type: 'string', description: '原文片段，须在原文件中唯一' },
                newText: { type: 'string', description: '替换后的文本' }
              },
              required: ['oldText', 'newText']
            }
          }
        },
        required: ['filePath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fs_write_file',
      description:
        '整文件写入。仅用于新建文件，或改动太大无法用 fs_edit 唯一替换时覆盖整文件。已有源码优先 fs_edit。',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: '文件路径（相对路径相对于当前工作空间或 ~/.dieyun/workspace）'
          },
          content: { type: 'string', description: '写入内容' }
        },
        required: ['filePath', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fs_list_dir',
      description: '列出目录内容',
      parameters: {
        type: 'object',
        properties: {
          dirPath: { type: 'string', description: '目录绝对路径' }
        },
        required: ['dirPath']
      }
    }
  }
];

const WEB_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'GET 抓取 http/https 网页或 API 正文（HTML 转纯文本）。禁止内网/localhost。需要读具体 URL、核验搜索结果、整理餐馆/商品/政策/攻略推荐时用此工具，不要伪造内容。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整 http/https URL' },
          maxChars: {
            type: 'number',
            description: '返回最大字符数，默认 12000'
          }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '联网搜索关键词，返回结构化结果（标题、URL、摘要）和搜索页摘录。中文默认百度，英文默认必应；可指定 engine：baidu|bing|google|duckduckgo。用户问最新资讯/事实/政策/本地推荐/餐馆/商品时必须优先调用；拿到结构化 URL 后应继续 web_fetch 1-3 个最相关页面再下结论。没有新 URL 时不要重复相同搜索。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          engine: {
            type: 'string',
            description: '可选：baidu、bing、google、duckduckgo'
          },
          maxChars: { type: 'number', description: '返回最大字符数，默认 12000' }
        },
        required: ['query']
      }
    }
  }
];

/**
 * frame 定位参数：所有目标类/观测类浏览器工具共用同一语义。
 * 单一来源，避免每个工具各写一套描述导致模型用法不一致。
 */
const FRAME_PARAM = {
  type: 'string',
  description:
    '目标 frame：省略或 "main" 为顶层；"0"、"0.1" 为 frame 路径（按文档顺序的 iframe 下标链）；"/正则/" 匹配 frame URL；含 "/" 或 "://" 视为 URL 子串；其它视为 frame 的 name。先用 browser_frames 看 frame 树。'
};
const FORCE_PARAM = {
  type: 'boolean',
  description: '目标被遮挡时仍强制点击/输入（默认 false：会先重试到超时，再明确回报被谁遮挡）'
};
const SNAPSHOT_MODE_PARAM = {
  type: 'string',
  description:
    'interactive（默认，语义化可交互元素）| all（额外含无 role 但 cursor:pointer 的可点容器，如 Vue @click 的 div、菜单项）| dom（所有可见元素，纯结构视图）'
};
const ANNOTATE_PARAM = {
  type: 'boolean',
  description: 'true 时在截图上叠加 ref 编号方框，便于像素级核对元素位置（截完自动清除，不污染页面）'
};

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
          engine: {
            type: 'string',
            description: 'auto | browserview | playwright（后备，使用本机 Edge/Chrome）'
          },
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
          engine: { type: 'string', description: 'auto | browserview | playwright' },
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
          engine: { type: 'string' },
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
          engine: { type: 'string' },
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
          engine: { type: 'string', description: 'auto | browserview | playwright（本机 Edge/Chrome）' }
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
          engine: { type: 'string', description: 'auto | browserview | playwright' }
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
          engine: { type: 'string', description: 'auto | browserview | playwright' }
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
          engine: { type: 'string', description: 'auto | browserview | playwright' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description:
        '在浏览器页面点击元素。必须先 browser_snapshot 拿到 ref（如 ref-0），再传入 ref 点击；每次页面变化后需重新 snapshot。不要用 host_open_url 代替 browser_navigate。可选 button=right 做右键、clickCount=2 做双击——本工具已覆盖，勿另找专用工具。目标被遮挡时会回报遮挡者；确需强点设 force=true。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'browser_snapshot 返回的 ref，如 ref-0' },
          selector: { type: 'string', description: 'CSS 选择器（与 ref 二选一）' },
          button: { type: 'string', description: 'left | right | middle，默认 left' },
          clickCount: { type: 'number', description: '1 或 2（双击），默认 1' },
          frame: FRAME_PARAM,
          force: FORCE_PARAM,
          engine: { type: 'string', description: 'auto | browserview | playwright（本机 Edge/Chrome）' }
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
          ref: { type: 'string' },
          selector: { type: 'string' },
          text: { type: 'string', description: '要输入的文本' },
          clear: { type: 'boolean', description: '输入前是否清空，默认 false（追加到现有内容）' },
          frame: FRAME_PARAM,
          force: FORCE_PARAM,
          engine: { type: 'string' }
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
          ref: { type: 'string', description: 'browser_snapshot 返回的 select ref' },
          selector: { type: 'string', description: 'CSS 选择器，如 select#country' },
          value: { type: 'string', description: 'option 的 value 属性' },
          label: { type: 'string', description: 'option 的可见文本（与 value 二选一）' },
          frame: FRAME_PARAM,
          force: FORCE_PARAM,
          engine: { type: 'string', description: 'auto | browserview | playwright' }
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
          ref: { type: 'string', description: 'browser_snapshot 返回的元素 ref' },
          selector: { type: 'string', description: 'CSS 选择器' },
          frame: FRAME_PARAM,
          engine: { type: 'string', description: 'auto | browserview | playwright' }
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
          ref: { type: 'string', description: '起始元素 ref' },
          selector: { type: 'string', description: '起始 CSS 选择器' },
          toRef: { type: 'string', description: '目标元素 ref' },
          toSelector: { type: 'string', description: '目标 CSS 选择器' },
          dx: { type: 'number', description: '相对起始元素中心的水平位移（像素）' },
          dy: { type: 'number', description: '相对起始元素中心的垂直位移（像素）' },
          frame: FRAME_PARAM,
          engine: { type: 'string', description: 'auto | browserview | playwright' }
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
          ref: { type: 'string' },
          selector: { type: 'string' },
          frame: FRAME_PARAM,
          engine: { type: 'string' }
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
          engine: { type: 'string' }
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
          ref: { type: 'string', description: 'browser_snapshot 返回的元素 ref（元素截图）' },
          selector: { type: 'string', description: 'CSS 选择器（元素截图）' },
          fullPage: { type: 'boolean', description: '是否整页截图' },
          filePath: {
            type: 'string',
            description: '可选：把截图保存到该路径（相对工作空间或绝对路径，须在白名单内）'
          },
          frame: FRAME_PARAM,
          annotate: ANNOTATE_PARAM,
          engine: { type: 'string' }
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
            description: '保存路径（相对工作空间或绝对路径，须在白名单内）；省略时存到系统下载目录'
          },
          format: { type: 'string', description: '纸张尺寸，如 A4、Letter，默认 A4' },
          landscape: { type: 'boolean', description: '是否横向，默认 false' },
          printBackground: { type: 'boolean', description: '是否打印背景色，默认 true' },
          engine: { type: 'string', description: 'auto | browserview | playwright' }
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
          engine: { type: 'string', description: 'auto | browserview | playwright' }
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
          engine: { type: 'string', description: 'auto | browserview | playwright' }
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
          engine: { type: 'string' }
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
          engine: { type: 'string' }
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
          ref: { type: 'string', description: 'browser_snapshot 返回的 file input ref' },
          selector: { type: 'string', description: 'CSS 选择器，如 input[type=file]' },
          filePath: { type: 'string', description: '要上传的本地文件路径，可为相对工作空间路径' },
          mime: { type: 'string', description: '可选 MIME 类型' },
          frame: FRAME_PARAM,
          timeoutMs: { type: 'number' },
          engine: { type: 'string', description: 'auto | browserview | playwright' }
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
          engine: { type: 'string' }
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
                ref: { type: 'string', description: 'browser_snapshot 的 ref（visible/hidden/text/value 用）' },
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
          engine: { type: 'string', description: 'auto | browserview | playwright' }
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
        '视觉回归验收：把当前页面（或元素）截图与基准图逐像素比较，返回变化比例并输出 diff 图（不进模型上下文）。首次调用创建基准，再次调用即比较。硬约束：只有同引擎 + 同视口才有可比性，跨引擎会被直接拒绝。',
      parameters: {
        type: 'object',
        properties: {
          baselinePath: {
            type: 'string',
            description: '基准图路径；省略时按 引擎+目标 自动取稳定文件名（同目标多次调用比的是同一张）'
          },
          filePath: { type: 'string', description: 'diff 图保存路径；省略时存到系统下载目录' },
          ref: { type: 'string', description: '只比较该元素（browser_snapshot 的 ref）' },
          selector: { type: 'string', description: '只比较该元素（CSS 选择器）' },
          threshold: {
            type: 'number',
            description: '判定"有变化"的变化像素比例阈值，默认 0.005（即 0.5%）'
          },
          fullPage: { type: 'boolean', description: '整页截图；需与基准创建时一致' },
          reset: { type: 'boolean', description: 'true 时用当前截图重建基准' },
          engine: { type: 'string', description: 'auto | browserview | playwright' }
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
          engine: { type: 'string', description: 'auto | browserview | playwright' }
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
          engine: { type: 'string', description: 'localStorage 写入时使用的引擎，默认 auto' }
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
          engine: { type: 'string', description: 'localStorage 读取使用的引擎，默认 auto' }
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
          engine: { type: 'string' }
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
          engine: { type: 'string' }
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
          engine: { type: 'string' }
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
          engine: { type: 'string' }
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
            description: '保存路径（相对工作空间或绝对路径，须在白名单内）；省略时存到系统下载目录'
          },
          engine: { type: 'string', description: 'auto | browserview | playwright' }
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
          engine: { type: 'string', description: 'auto | browserview | playwright（本机 Edge/Chrome）' }
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
          engine: { type: 'string', description: 'auto | browserview | playwright' }
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

const CODEBASE_TOOL = {
  type: 'function',
  function: {
    name: 'codebase_search',
    description:
      '在代码索引中做语义/关键词检索，适合「这段逻辑在哪」「类似实现」。精确字符串、符号名、报错原文用 grep；按文件名模式列路径用 glob。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要检索的代码、函数、模块或问题关键词' },
        limit: { type: 'number', description: '返回片段数量，默认 8，最多 48' },
        workspaceRoot: { type: 'string', description: '可选工作空间路径；默认当前工作空间' }
      },
      required: ['query']
    }
  }
};

const GREP_TOOL = {
  type: 'function',
  function: {
    name: 'grep',
    description:
      '在工作空间内按字面字符串或正则搜索文件内容，返回命中行 path:line。' +
      '查确切标识符、报错原文、import 路径时用这个，不要用 host_exec 调 rg/findstr。' +
      '需要看「命中处为什么这么写」时设 context（如 3），一次拿到前后文，避免再读一次文件。' +
      '语义检索用 codebase_search。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的字符串；默认按字面匹配' },
        glob: { type: 'string', description: '可选文件过滤，如 **/*.js、*.rs' },
        path: { type: 'string', description: '可选子目录，相对工作空间根' },
        regex: { type: 'boolean', description: 'true 时 pattern 按正则；默认 false' },
        caseInsensitive: { type: 'boolean', description: '忽略大小写' },
        context: { type: 'number', description: '命中行前后各返回 N 行，默认 0，上限 10' },
        beforeContext: { type: 'number', description: '仅向前 N 行上下文（覆盖 context），上限 10' },
        afterContext: { type: 'number', description: '仅向后 N 行上下文（覆盖 context），上限 10' },
        multiline: {
          type: 'boolean',
          description: 'true 时跨行匹配（如多行 import / JSX 片段），pattern 需按正则写（配合 regex 或 . 通配）'
        },
        type: { type: 'string', description: '按文件类型过滤，如 rust、go、ts、py、json（等价 rg -t）' },
        count: { type: 'boolean', description: 'true 时只返回命中总数（count），不返回具体行' },
        maxResults: { type: 'number', description: '最多返回条数，默认 50，上限 200' }
      },
      required: ['pattern']
    }
  }
};

const READ_SYMBOL_TOOL = {
  type: 'function',
  function: {
    name: 'read_symbol',
    description:
      '按符号读取代码体，返回带行号的原文与 path，可直接用于 fs_edit。' +
      'filePath+name：读该文件里的符号；filePath+line：读包含该行的最内层符号；只给 name：全库找同名符号。' +
      '比 fs_read_file 读整个文件更省上下文。' +
      '本地走 LSP/结构索引；SSH 工作区自动降级为远程结构索引 → 远程 grep，仍返回带行号代码体（降级精度略低）。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '文件路径；只按 name 全库找时可省略' },
        name: { type: 'string', description: '符号名（函数/类/方法），如 prepSystemPrompt' },
        line: { type: 'number', description: '1-based 行号：读包含该行的最小符号' },
        maxLines: { type: 'number', description: '最多返回行数，默认 400，上限 2000' }
      }
    }
  }
};

const GLOB_TOOL = {
  type: 'function',
  function: {
    name: 'glob',
    description:
      '按 glob 模式列出工作空间内的文件路径（不含内容）。找某个文件名、某类扩展名时用这个，不要递归 fs_list_dir。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '如 **/*.ts、src/**/*.js、*.md' },
        maxResults: { type: 'number', description: '最多返回条数，默认 80，上限 400' }
      },
      required: ['pattern']
    }
  }
};

const LSP_TOOL = {
  type: 'function',
  function: {
    name: 'lsp',
    description:
      'Language Server 定位（TS/JS/TSX/Python/Rust/Go；Rust/Go 需本机已装 rust-analyzer/gopls）。' +
      'SSH 工作区优先用远程 Language Server；不可用时依次降级：workspaceSymbol → 远程结构索引，其他 operation → 远程 grep（结果带 degraded: true，属非语义匹配）。' +
      'workspaceSymbol：全库按名搜符号，只需 query（可选 filePath 指定语言），返回 path:line 与 kind——还不知道符号在哪个文件时首选。' +
      'documentSymbol：列出某文件内的符号大纲，只需 filePath。' +
      'goToDefinition / typeDefinition / goToImplementation / findReferences / hover：需要 filePath + line（character 默认 1）。' +
      'line/character 均为 1-based（UTF-16）。按名搜符号的通用替代是 graph（find_symbol，全语言但无相关度排序）。',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description:
            'workspaceSymbol | documentSymbol | goToDefinition | typeDefinition | goToImplementation | findReferences | hover'
        },
        filePath: { type: 'string', description: '文件路径；workspaceSymbol 时可省略' },
        line: { type: 'number', description: '1-based 行号；workspaceSymbol/documentSymbol 不需要' },
        character: { type: 'number', description: '1-based 列号（UTF-16），默认 1' },
        query: { type: 'string', description: 'workspaceSymbol：要搜的符号名' }
      },
      required: ['operation']
    }
  }
};

const GRAPH_TOOL = {
  type: 'function',
  function: {
    name: 'graph',
    description:
      '结构索引查询（JS/TS/Python/Go/Rust）。用 operation 选择动作，不要为同一类查询换工具名。' +
      'find_symbol：按符号名（query）。semantic_find：按自然语言描述（需 embedding）。' +
      'module_deps：文件 import 依赖（path 可空=全库边）。callers/callees：静态调用关系（name，可选 path）。' +
      'impact：改某文件沿 import 可能波及谁（path）。lsp_callers：精确引用（本地 LSP；SSH 用远程 rg 补强）。' +
      '精确字符串用 grep；语义代码片段用 codebase_search；已打开行列跳转用 lsp。',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description:
            'find_symbol | semantic_find | module_deps | callers | callees | impact | lsp_callers'
        },
        query: { type: 'string', description: 'find_symbol / semantic_find：符号名或描述' },
        name: { type: 'string', description: 'callers / callees / lsp_callers：符号名' },
        path: {
          type: 'string',
          description: '文件相对路径；module_deps/impact 的起点，或给 callers 消歧'
        },
        kind: { type: 'string', description: 'find_symbol / semantic_find：可选 function 或 class' },
        limit: { type: 'number', description: 'find_symbol / semantic_find 返回条数，默认 20' },
        depth: { type: 'number', description: 'module_deps / impact 展开层数' },
        symbolId: { type: 'number', description: '可选 graph 符号 id' },
        persist: {
          type: 'boolean',
          description: 'lsp_callers：是否写入结构索引，默认 true'
        },
        workspaceRoot: { type: 'string', description: '可选工作空间路径' }
      },
      required: ['operation']
    }
  }
};

const PLAYBOOK_PROPOSE_TOOL = {
  type: 'function',
  function: {
    name: 'playbook_propose',
    description:
      '将当前任务的可复用工作流保存为 Playbook 草稿（SOP：目标、步骤、命令、验收等），写入 `.dieyun/playbooks/_drafts/`。' +
      '用户可在预览中确认入库。也可以直接 fs_edit / fs_write_file 维护该目录。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Playbook 标题，如「发布 Windows 安装包」' },
        domain: {
          type: 'string',
          description: '领域分类，如 deploy、testing、general（默认 general）'
        },
        goal: { type: 'string', description: '任务目标（1–3 句）' },
        steps: {
          type: 'string',
          description: '确认步骤（Markdown 有序/无序列表，按执行顺序）'
        },
        commands: { type: 'string', description: '可选：关键 shell 命令（不含 ``` 包裹）' },
        acceptance: { type: 'string', description: '可选：验收标准' },
        pitfalls: { type: 'string', description: '可选：踩坑与注意事项' },
        relatedFiles: { type: 'string', description: '可选：关联文件路径（每行一个）' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：标签，便于召回'
        }
      },
      required: ['title', 'goal', 'steps']
    }
  }
};

const AGENTS_MD_PROPOSE_TOOL = {
  type: 'function',
  function: {
    name: 'agents_md_propose',
    description:
      '向当前工作空间 .dieyun/AGENTS.md 做分段增量更新（项目地图：命令、目录、规范、坑点等）。' +
      '按 section 追加或替换，避免整文件覆盖。设置里可开 Diff 预览后再采纳。也可以 fs_edit 该文件。',
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['overview', 'structure', 'commands', 'conventions', 'testing', 'architecture', 'gotchas'],
          description: '要更新的区块'
        },
        content: {
          type: 'string',
          description: '要写入的 Markdown 条目或短段落（建议以 - 开头的列表项）'
        },
        action: {
          type: 'string',
          enum: ['append', 'replace'],
          description: 'append 追加（默认）；replace 替换该 section 正文'
        },
        reason: {
          type: 'string',
          description: '可选：为何记录此项'
        }
      },
      required: ['section', 'content']
    }
  }
};

const SKILL_CREATE_TOOL = {
  type: 'function',
  function: {
    name: 'skill_create',
    description:
      '在用户主目录 ~/.dieyun/skills 创建新技能（写入 SKILL.md）。创建后提示用户在「技能列表」中启用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能显示名称（英文文件夹名会自动派生）' },
        description: { type: 'string', description: '一句话简介，写入 frontmatter' },
        content: { type: 'string', description: 'SKILL.md 正文（Markdown）' }
      },
      required: ['name', 'description']
    }
  }
};

const PLAN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'plan_create',
      description:
        '创建定时计划（写入 plans.json，RRULE 调度）。能确定时间规则时请直接给出 rrule 或 onceAt（确定、不再额外解析）；只有拿到的是自然语言、无法确定时间规则时才省略它们，交由解析器推断。用户说「每天 X 点…发到当前对话」时，计划会投递到当前会话。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '计划名称（简短中文）'
          },
          rrule: {
            type: 'string',
            description:
              'iCalendar RRULE（不含 RRULE: 前缀），与 onceAt 二选一。如 每天9:00 → FREQ=DAILY;BYHOUR=9;BYMINUTE=0；每周一9:00 → FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0；每30分钟 → FREQ=MINUTELY;INTERVAL=30'
          },
          onceAt: {
            type: 'string',
            description:
              '仅执行一次时的 ISO8601 本地时间，与 rrule 二选一。如 2026-05-26T09:00:00'
          },
          prompt: {
            type: 'string',
            description: '到点后交给 AI 执行的任务说明（完整、可执行）'
          },
          description: {
            type: 'string',
            description: '用户对定时任务的完整描述（自然语言兜底，缺 rrule/onceAt 时据此解析）'
          },
          skillIds: {
            type: 'array',
            items: { type: 'string' },
            description: '可选关联技能 id 列表'
          },
          todos: {
            type: 'array',
            items: { type: 'string' },
            description: '可选 TODO 清单，每项是一个可执行检查项'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_list',
      description: '列出所有已保存的定时计划',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_delete',
      description: '删除指定 id 的定时计划',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '计划 id' }
        },
        required: ['id']
      }
    }
  }
];

const MCP_TOOL_SCHEMA_TOOL = {
  type: 'function',
  function: {
    name: 'mcp_tool_schema',
    description:
      '查询 MCP 工具的完整 JSON Schema。mcp_* 工具列表已含常用参数；仅当嵌套对象被折叠或仍缺字段时再调用。',
    parameters: {
      type: 'object',
      properties: {
        agentName: { type: 'string', description: 'MCP agent 工具名，如 mcp_server_tool' }
      },
      required: ['agentName']
    }
  }
};

/**
 * 判断模型是否「工具调用能力弱」——只依据可量化的规模信号，禁止按厂商名（deepseek/mimo/qwen 等）
 * 一刀切：同一厂商既有弱模型也有强模型，命中厂商子串会误伤强模型（如 DeepSeek-V4.1-Flash）。
 * 命中条件：模型 id 标注了 ≤8B 参数量，或带 tiny/small/nano/micro/mini 等小模型后缀。
 */
function isWeakToolCallerModel(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (!m) return false;
  // 参数量标记（1.8b / 7b / 8b …）：仅 ≤8B 视为弱；排除 8x7b 这类 MoE 总参数写法
  for (const token of m.match(/(?<![x*])\d+(?:[._]\d+)?\s*b(?![a-z0-9])/g) || []) {
    const n = parseFloat(token.replace(/[._](?=\d)/g, '.').replace(/\s*b$/, ''));
    if (Number.isFinite(n) && n > 0 && n <= 8) return true;
  }
  // 显式小模型标记：要求被分隔符/边界包裹，避免 MiniMax 等强模型被误伤
  if (/(^|[-_/.: ])(tiny|small|nano|micro|mini)$/.test(m)) return true;
  if (/(^|[-_/.: ])(tinyllama|phi-?2|gemma-?1?2b)([-_/.: ]|$)/.test(m)) return true;
  return false;
}

function slimMcpProp(prop, depth) {
  if (!prop || typeof prop !== 'object') return { type: 'string' };
  const out = {};
  if (prop.type) out.type = prop.type;
  if (prop.description) {
    out.description = String(prop.description).replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  if (Array.isArray(prop.enum) && prop.enum.length && prop.enum.length <= 16) {
    out.enum = prop.enum;
  }
  const nestedObject = prop.type === 'object' || (prop.properties && typeof prop.properties === 'object');
  if (prop.type === 'array' && prop.items && depth < 2) {
    out.items = slimMcpProp(prop.items, depth + 1);
  } else if (nestedObject && depth < 1) {
    out.properties = slimMcpProperties(prop.properties, depth + 1);
    if (Array.isArray(prop.required) && prop.required.length) out.required = prop.required.slice();
  } else if (nestedObject) {
    out.type = out.type || 'object';
    out.description = `${out.description || '对象'}（嵌套字段见 mcp_tool_schema）`;
  }
  return out;
}

function slimMcpProperties(properties, depth) {
  const src = properties && typeof properties === 'object' ? properties : {};
  const out = {};
  for (const key of Object.keys(src)) {
    out[key] = slimMcpProp(src[key], depth);
  }
  return out;
}

/** Keep required + first-level types so models do not call mcp_* with {}. */
function slimMcpInputSchema(schema) {
  const src = schema && typeof schema === 'object' ? schema : {};
  if (src.type && src.type !== 'object' && !src.properties) {
    return { type: src.type, description: String(src.description || '').slice(0, 120) };
  }
  const out = {
    type: 'object',
    properties: slimMcpProperties(src.properties, 0)
  };
  if (Array.isArray(src.required) && src.required.length) out.required = src.required.slice();
  if (src.additionalProperties === false) out.additionalProperties = false;
  return out;
}

function compactMcpToolDef(entry) {
  const fn = entry.tool && entry.tool.function ? entry.tool.function : {};
  const shortDesc = String(fn.description || (entry.candidate && entry.candidate.description) || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
  const rawSchema =
    fn.parameters && typeof fn.parameters === 'object'
      ? fn.parameters
      : { type: 'object', properties: {} };
  const parameters = slimMcpInputSchema(rawSchema);
  const hasProps = Object.keys(parameters.properties || {}).length > 0;
  return {
    type: 'function',
    function: {
      name: fn.name,
      description: hasProps ? shortDesc : `${shortDesc}（无列出参数时用 mcp_tool_schema）`,
      parameters
    }
  };
}

const CLARIFY_TOOL = {
  type: 'function',
  function: {
    name: 'agent_clarify',
    description:
      '思考或执行中信息不明确、存在多种互斥理解或需用户确认时调用。会在对话中展示表格选项。禁止因对话已压缩/折叠就询问「本轮做什么」——先根据压缩摘要、折叠历史、近轮原文和工作区恢复任务。禁止臆测。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '需要确认的问题' },
        options: {
          type: 'array',
          description: '选项列表，2～8 项',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string', description: '选项标题' },
              description: { type: 'string', description: '可选说明' }
            },
            required: ['id', 'label']
          }
        },
        allowMultiple: { type: 'boolean', description: '是否允许多选，默认 false' },
        inputPlaceholder: { type: 'string', description: '补充输入框占位提示，默认「补充说明或手动输入…」' }
      },
      required: ['question', 'options']
    }
  }
};

const GRAPH_TOOLS = [GRAPH_TOOL];

const ALL_STATIC_TOOLS = HOST_TOOLS.concat(
  WEB_TOOLS,
  BROWSER_TOOLS,
  [CODEBASE_TOOL, GREP_TOOL, GLOB_TOOL, READ_SYMBOL_TOOL, LSP_TOOL],
  GRAPH_TOOLS,
  [PLAYBOOK_PROPOSE_TOOL, AGENTS_MD_PROPOSE_TOOL, SKILL_CREATE_TOOL],
  PLAN_TOOLS,
  [MCP_TOOL_SCHEMA_TOOL, CLARIFY_TOOL]
);

const BY_NAME = Object.create(null);
for (const t of ALL_STATIC_TOOLS) {
  const n = t && t.function && t.function.name;
  if (n) BY_NAME[n] = t;
}

const PLAN_RUNTIME_TOOL_NAMES = [
  'host_exec',
  'fs_read_file',
  'fs_edit',
  'fs_write_file',
  'fs_list_dir',
  'web_fetch',
  'web_search'
];

const RENDERER_ONLY_TOOLS = ['agent_clarify'];

function getToolByName(name) {
  return BY_NAME[String(name || '')] || null;
}

function toolsByNames(names) {
  return (names || []).map(getToolByName).filter(Boolean);
}

module.exports = {
  HOST_TOOLS,
  WEB_TOOLS,
  BROWSER_TOOLS,
  BROWSER_CORE_TOOLS,
  BROWSER_ADVANCED_TOOLS,
  BROWSER_ADVANCED_TOOL_NAMES,
  CODEBASE_TOOL,
  GREP_TOOL,
  GLOB_TOOL,
  READ_SYMBOL_TOOL,
  LSP_TOOL,
  GRAPH_TOOL,
  GRAPH_TOOLS,
  PLAYBOOK_PROPOSE_TOOL,
  AGENTS_MD_PROPOSE_TOOL,
  SKILL_CREATE_TOOL,
  PLAN_TOOLS,
  MCP_TOOL_SCHEMA_TOOL,
  CLARIFY_TOOL,
  ALL_STATIC_TOOLS,
  PLAN_RUNTIME_TOOL_NAMES,
  RENDERER_ONLY_TOOLS,
  getToolByName,
  toolsByNames,
  isWeakToolCallerModel,
  slimMcpInputSchema,
  compactMcpToolDef
};
