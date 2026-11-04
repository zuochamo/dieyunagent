'use strict';

// engine 参数文案的唯一来源（引擎契约与决策见 src/browser/engine-target.js）
const { ENGINE_PARAM_SCHEMA } = require('../browser/engine-target');
// ref 参数文案的唯一来源（ref origin 身份见 src/browser/ref-namespace.js）
const { REF_PARAM_SCHEMA } = require('../browser/ref-namespace');
// computer 动作枚举的唯一来源（schema 里的 action 取值由它拼出，避免与执行端漂移）
const { COMPUTER_ACTIONS_TEXT } = require('../computer/actions');
// 「这个工具名是不是 MCP 服务注册出来的」唯一判定（Main 与 Renderer 共用）：
// mcp_manage / mcp_tool_schema 虽同前缀，但不是远端工具，判定细则在 mcp/tool-name.js。
const { isMcpServerToolName, MCP_BUILTIN_TOOL_NAMES } = require('../mcp/tool-name');
// mcp_manage 的动作清单唯一来源（apply() 按它分派；schema enum 与校验都从这里取）
const { MCP_MANAGE_ACTIONS } = require('../mcp/manage');

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
        '长任务（编译/打包/渲染/训练，几分钟级）设 waitMs=180000：到点仍未结束会自动转后台继续跑（不会杀进程），' +
        '返回 handle + 已产生的输出，再用 host_proc action=output 续读、action=kill 结束。' +
        'detached=true 的返回体会带 handle（本机 hostproc-N / SSH 远端 sshproc-N），之后可用 host_proc 查看/读输出/结束；' +
        '远程 detached 的输出落在远端 /tmp/dieyun-host-proc/ 下，路径在返回值里。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          cwd: { type: 'string', description: '工作目录（相对工作空间或绝对路径）' },
          detached: {
            type: 'boolean',
            description: 'true 时后台启动，不等待进程结束（GUI/守护进程必用）'
          },
          timeoutMs: { type: 'number', description: '可选超时（毫秒，上限 600000），仅 detached=false 时有效' },
          verify: {
            type: 'boolean',
            description:
              '这条命令是不是在验证改动（测试 / 类型检查 / lint / 构建 / 冒烟脚本 / 编译）。请**显式给出 true 或 false**：' +
              '收尾「本轮做完了没」的验收提示靠它判断你验过没有 —— 代码不再按命令名猜（`make verify`、`npm run smoke` 这类自有脚本猜不出来）'
          },
          waitMs: {
            type: 'number',
            description:
              '长任务的等待窗口（毫秒，上限 600000）。到时未结束则转后台继续运行并返回 handle（不会杀进程），再用 host_proc action=output 读增量输出'
          }
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
        '管理由 host_exec 启动的进程：action=list 列出仍在运行的进程（含 handle、PID、命令、存活状态）；' +
        'action=output 读取该进程的输出（detached 与「waitMs 转后台」的进程都能读，可读增量、可等待新输出）；' +
        'action=kill 用 handle 或 pid 结束进程树。' +
        '只能操作本会话经 host_exec 启动的进程，不能结束任意系统进程。用于跟进长任务进度、清理未退出的 GUI/后台进程。' +
        'SSH 远端工作空间同样可用（远端句柄形如 sshproc-3，kill 按独立进程组结束整棵树）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list（默认）| output | kill' },
          id: { type: 'string', description: 'host_exec 返回的 handle，如 hostproc-3（output/kill 必填其一）' },
          pid: { type: 'number', description: '进程 PID（须是 host_exec 启动过的）' },
          includeFinished: {
            type: 'boolean',
            description: 'list：是否附带已结束的进程，默认 false（只看存活）'
          },
          tailBytes: {
            type: 'number',
            description: 'output：只返回尾部多少字节（默认 32768，用于长日志）'
          },
          offset: {
            type: 'number',
            description: 'output：从上次返回的 offset 之后继续读（增量跟进）'
          },
          waitMs: {
            type: 'number',
            description: 'output：等待新输出或进程退出最多多少毫秒（默认 0，不等待；上限 120000）'
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
        '想重新看某张图片（例如历史消息里 [附件图 …] 标注的路径）时设 encoding=base64：图片会作为视觉输入附到下一轮，不会返回 base64 文本。' +
        '要让用户在回答里看到某张图（包括你用脚本生成、落盘的图），也用它读一次：能识图时这张图会一并显示在正式回答里，不用让用户自己去翻文件。',
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
        'GET 抓取 http/https 网页或 API 正文。HTML 会自动抽取正文（去掉导航/页脚/广告）。禁止内网/localhost。需要读具体 URL、核验搜索结果、整理政策/文档/攻略时用，不要伪造内容。',
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
        '联网搜索，返回结构化结果（标题、URL、摘要）。默认引擎 bing（国内可直连、最稳），中文/英文都直接用。需要正文时加 fetchTop=2~3，一次拿到结果页正文，省掉后续多轮 web_fetch。某引擎失败（限流/验证码/解析不到）就换 engine 或改关键词，不要重复同一 query。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          engine: {
            type: 'string',
            description: '可选：bing（默认）|baidu|google|duckduckgo。google 需代理且易被限流'
          },
          site: {
            type: 'string',
            description: '可选：限定站点域名，如 gov.cn、github.com'
          },
          page: {
            type: 'number',
            description: '可选：页码，从 1 开始（duckduckgo 不支持翻页）'
          },
          fetchTop: {
            type: 'number',
            description: '可选：0-3，搜完顺手抓前 N 条正文（带此参数就不用再单独 web_fetch）'
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
            description: '可选：把截图保存到该路径（相对工作空间或绝对路径，须在白名单内）'
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
            description: '保存路径（相对工作空间或绝对路径，须在白名单内）；省略时存到系统下载目录'
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
            description: '保存路径（相对工作空间或绝对路径，须在白名单内）；省略时存到系统下载目录'
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
      '只给 filePath 无法定位符号，读整个文件请用 fs_read_file。' +
      '比 fs_read_file 读整个文件更省上下文。' +
      '本地走 LSP/结构索引；SSH 工作区自动降级为远程结构索引 → 远程 grep，仍返回带行号代码体（降级精度略低）。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '文件路径；只按 name 全库找时可省略（不能只给路径）' },
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
      'Language Server 定位（TS/JS/TSX/Python/Rust/Go/C/C++/CUDA；Rust/Go 需本机已装 rust-analyzer/gopls，C/C++ 需 clangd）。' +
      'C/C++（含 UE5 工程）要拿到准确跳转，项目里需要有 compile_commands.json（UE 在 Intermediate/ 下），否则 clangd 只能做文本级推断。' +
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
      'find_symbol：按符号名（query）。' +
      'module_deps：文件 import 依赖（path 可空=全库边）。callers/callees：静态调用关系（name，可选 path）。' +
      'impact：改某文件沿 import 可能波及谁（path）。lsp_callers：精确引用（本地 LSP；SSH 用远程 rg 补强）。' +
      '精确字符串用 grep；语义代码片段用 codebase_search；已打开行列跳转用 lsp。',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description:
            'find_symbol | module_deps | callers | callees | impact | lsp_callers'
        },
        query: { type: 'string', description: 'find_symbol：符号名' },
        name: { type: 'string', description: 'callers / callees / lsp_callers：符号名' },
        path: {
          type: 'string',
          description: '文件相对路径；module_deps/impact 的起点，或给 callers 消歧'
        },
        kind: { type: 'string', description: 'find_symbol：可选 function 或 class' },
        limit: { type: 'number', description: 'find_symbol 返回条数，默认 20' },
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

const AGENTS_MD_PROPOSE_TOOL = {
  type: 'function',
  function: {
    name: 'agents_md_propose',
    description:
      '向当前工作空间 .dieyun/AGENTS.md 做分段增量更新（项目地图：命令、目录、规范、坑点等）。' +
      '**同主题已有条目时用 merge 并入，不要追加第二条**；新增用 append；整段重写用 replace。' +
      '设置里可开 Diff 预览后再采纳。也可以 fs_edit 该文件。',
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
          enum: ['append', 'merge', 'replace'],
          description:
            'append 追加（默认）；merge 用 content 替换 anchor 命中的那一条（同主题合并的唯一方式）；replace 替换该 section 全文'
        },
        anchor: {
          type: 'string',
          description: 'merge 时必填：目标条目的开头片段（如 "**CameraCut"），在该 section 内按前缀匹配'
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

// —— 记忆工具：让「读记忆 / 纠错」发生在对话内，而不是只能等自动注入 ——
//
// 记忆系统的老问题是「写得多、读得少」：每轮只自动注入 8+5 条，模型想不起别的只能认。
// 这两个工具把检索与纠错交回模型：recall 按需拉原始条目（带 id），forget 把记错的
// 那条软归档（可恢复，非物理删除）。都在轮内完成，不需要新增表或界面。
const MEMORY_RECALL_TOOL = {
  type: 'function',
  function: {
    name: 'memory_recall',
    description:
      '按需检索长期记忆（项目级 + 用户级），返回带 id 的条目。' +
      '自动注入每轮只带最相关的几条；需要想起更多细节、或确认「之前定过什么」时用它。' +
      '只有本次召回/注入出现过的 id 才能用于 memory_forget。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的主题，自然语言即可' },
        scope: {
          type: 'string',
          enum: ['all', 'project', 'global'],
          description: '检索范围：默认 all（项目 + 用户级）'
        },
        limit: { type: 'number', description: '返回条数上限（默认 8，最多 12）' }
      },
      required: ['query']
    }
  }
};

const MEMORY_FORGET_TOOL = {
  type: 'function',
  function: {
    name: 'memory_forget',
    description:
      '归档（软删除、可恢复）用户明确说记错了的记忆条目。' +
      '只接受本次请求里通过 memory_recall 或自动注入出现过的 id；' +
      '不要用它自行清理「看起来没用」的记忆。',
    parameters: {
      type: 'object',
      properties: {
        memoryIds: {
          type: 'array',
          items: { type: 'number' },
          description: '要归档的记忆 id（来自本次召回结果）'
        },
        reason: { type: 'string', description: '为何归档（写进审计日志，帮助事后复盘）' }
      },
      required: ['memoryIds']
    }
  }
};

// —— 会话检索工具：翻「以前聊过什么」 ——
//
// 记忆工具读的是**归纳后的结论**（长期记忆 / 项目记忆），这个读的是**原始对话**：
// 别的会话里人和模型实际说过什么，以及被压缩摘要吞掉的那段原文。
//
// 为什么只给一个工具而不是一套：记忆库是 distilled 的，会话是 raw 的，raw 侧只需要
// 「按字面找」——没有事件流、没有父子 trace，多给几个入口只会变成查不到东西的 schema。
const SESSION_RECALL_TOOL = {
  type: 'function',
  function: {
    name: 'session_recall',
    description:
      '检索既往会话的原始对话，成员按字面匹配返回带会话 id 的摘录。' +
      '用于「上次这个报错我们怎么处理的」「之前定过什么方案」这类归纳记忆里没有的细节。' +
      '默认只搜当前工作空间；folded=true 时连被压缩摘要吞掉的原文一起搜。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的关键词或短语，字面匹配（不必写成句子）' },
        scope: {
          type: 'string',
          enum: ['workspace', 'session'],
          description: 'workspace = 当前工作空间内所有会话；session = 只看当前会话（默认 workspace）'
        },
        folded: {
          type: 'boolean',
          description: '是否同时检索压缩归档里被折叠的原文（默认 false）'
        },
        limit: { type: 'number', description: '返回条数上限（默认 12，最多 20）' }
      },
      required: ['query']
    }
  }
};

const MEMORY_TOOLS = [MEMORY_RECALL_TOOL, MEMORY_FORGET_TOOL];

const PLAN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'plan_create',
      description:
        '创建计划（写入 plans.json）。两种形态二选一：' +
        '①定时（RRULE）：能确定时间规则就直接给 rrule 或 onceAt（确定、不再额外解析），只有拿到的是自然语言、无法确定时间规则时才省略它们交解析器推断；' +
        '②目标型（给 goal）：没有时间规则、"做到某某条件成立为止"的长任务用它 —— 计划会一轮轮自动续跑，每轮由模型跑 goal 检查、直到申请完成或预算用完。' +
        '用户说「每天 X 点…发到当前对话」时，计划会投递到当前会话。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '计划名称（简短中文）'
          },
          goal: {
            type: 'object',
            description:
              '目标型计划（"一直做到 X 成立"）。给了它就不要再给 rrule/onceAt。' +
              '检查命令决定「做没做完」能不能被机器核对，所以要先和用户确认一条**现在会失败、做完会通过**的命令；' +
              '确实没有可执行的检查（例如主观目标）就传空数组 checks: []，那是未验证模式：照样能跑，但完成申请不会被代码核对。' +
              '预算（轮次/时长）不在这里设：沿用默认值，用户可在「定时任务 → 目标」里改。',
            properties: {
              checks: {
                type: 'array',
                items: { type: 'string' },
                description:
                  '每项一条检查命令（原样执行，退出码 0 = 通过），如 "npm test"、"cargo build"。别写解释性文字，也别把多条命令拼成一段'
              },
              cwd: {
                type: 'string',
                description: '检查命令的工作目录（可选，留空 = 计划运行的工作空间）'
              }
            },
            required: ['checks']
          },
          rrule: {
            type: 'string',
            description:
              'iCalendar RRULE（不含 RRULE: 前缀），与 onceAt 二选一。如 每天9:00 → FREQ=DAILY;BYHOUR=9;BYMINUTE=0；每周一9:00 → FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0；每30分钟 → FREQ=MINUTELY;INTERVAL=30；每2小时 → FREQ=HOURLY;INTERVAL=2；总共跑5次加 ;COUNT=5'
          },
          onceAt: {
            type: 'string',
            description:
              '仅执行一次时的 ISO8601 本地时间，与 rrule 二选一。如 2026-05-26T09:00:00'
          },
          prompt: {
            type: 'string',
            description:
              '计划要完成的任务说明（完整、可执行）：定时型写「到点做什么」；目标型写「什么状态算达成」，它是每一轮交接班的依据'
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
          },
          workspace: {
            type: 'string',
            description:
              '可选：计划执行时使用的工作空间（本地绝对路径，如 E:\\\\project）。留空 = 跟随执行时当前打开的工作空间'
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
      description:
        '列出所有已保存的计划（定时 / 目标型）。目标型计划额外给出：跑了几轮、声明的检查、最后一条检查事实、是否已收尾（outcome）。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_delete',
      description:
        '删除指定 id 的计划（含目标型）。注意它连运行记录一起删；目标型只是「别再跑了、但保留已跑事实」时，' +
        '让用户在「定时任务 → 目标」面板里停用，或用 plan_cancel 先中止当前这一轮',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '计划 id' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_run',
      description:
        '立刻手动执行一次指定计划（等价于界面上的「立即运行」，不等定时点）。' +
        '执行是异步的：起跑后结果出现在计划绑定的会话里，别在这里等它跑完。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '计划 id（先用 plan_list 取）' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_cancel',
      description:
        '中止某个计划正在跑的那一次执行（计划本身保留，下次到点照常触发）。' +
        '只在用户明确要停的时候用，别用它顺手清后台任务。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '计划 id（先用 plan_list 取）' }
        },
        required: ['id']
      }
    }
  }
];

/**
 * 目标型计划（plans trigger=goal）专用工具：**只在计划轮次里**给模型（见 plan-agent-runner）。
 *
 * 为什么它们必须是工具、不能是调度器的固定步骤：**节奏是语义判断** —— 什么时候跑哪条检查、
 * 跑几次，取决于模型刚改了什么、哪条检查便宜。写成「每轮无条件跑一条命令」既会吃掉整晚预算，
 * 也把「怎么验证」硬编码成了代码策略。代码只留两件事：跑命令、核对主张与事实。
 */
const GOAL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'goal_check',
      description:
        '在目标型计划的一轮里跑一次检查命令，并把结果作为「事实」记到计划上（退出码、超时、被沙箱/审批拒绝、输出尾部）。' +
        '什么时候跑、跑哪条由你决定：目标声明了检查就按声明跑（用 check_id）；没声明时自己给一条能失败的命令。' +
        '事实是 goal_finish 的唯一依据 —— 没有通过的事实，完成申请会被打回。',
      parameters: {
        type: 'object',
        properties: {
          check_id: {
            type: 'string',
            description: '已声明检查的 id（与 command 二选一；给了 id 就用它的命令，命令由计划持有）'
          },
          command: {
            type: 'string',
            description: '要执行的检查命令（退出码 0 = 通过）；check_id 缺省时必填'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'goal_finish',
      description:
        '为目标型计划的这一轮申请收尾。complete = 目标已达成：代码会核对事实（最近一次检查必须通过；' +
        '声明了检查时每条的最新结果都要通过），对不上就被打回并回灌失败事实；' +
        'blocked = 有具体卡点做不下去、需要人处理。不确定就先 goal_check 再取一次事实，别提前宣布完成。',
      parameters: {
        type: 'object',
        properties: {
          outcome: {
            type: 'string',
            enum: ['complete', 'blocked'],
            description: 'complete = 目标达成；blocked = 卡住需要人处理'
          },
          note: {
            type: 'string',
            description: '一句话：完成时指向哪条检查/证据；阻塞时写确切卡点（人早上据此接手）'
          }
        },
        required: ['outcome']
      }
    }
  }
];

/**
 * MCP 工具的两个入口，刻意合并在一个工具里（不新增第二个工具）：
 * - `agentName`：已知名字，查完整 JSON Schema（本轮工具表里的 schema 被折叠时用）。
 * - `query`：不知道叫什么 / 本轮工具表里没有它时，按自然语言检索「全部已启用 MCP 服务」。
 *
 * 为什么必须有 query：本轮 mcp_* 工具是按用户提问召回的子集（见 renderer-tool-defs.js），
 * 任务中途换向时新工具不会自己冒出来。没有 query 这条路，一次召回 miss 就等于该工具
 * 整轮不存在 —— 模型连「有这个工具」都不知道，无法补救。
 */
const MCP_TOOL_SCHEMA_TOOL = {
  type: 'function',
  function: {
    name: 'mcp_tool_schema',
    description:
      '查 MCP 工具。两种用法：① agentName=已知工具名，返回完整 JSON Schema（嵌套字段被折叠时用）；' +
      '② query=你现在要做的事，在全部已启用 MCP 服务里检索工具，返回命中工具的 schema —— ' +
      '返回的 agentName 可直接当工具名调用，不必等它出现在工具列表里。' +
      '本轮工具列表只是召回来的子集，缺工具先用 query 找。',
    parameters: {
      type: 'object',
      properties: {
        agentName: { type: 'string', description: 'MCP agent 工具名，如 mcp_server_tool' },
        query: {
          type: 'string',
          description: '要完成的事情（自然语言或关键词），如「查上个月开票收入」「看某表结构」'
        }
      }
    }
  }
};

/**
 * 管理 MCP **服务本身**（不是调用它们的工具）：装、改、启停、删。
 *
 * 与 `mcp_tool_schema` 的分工：那个查「工具叫什么、参数什么」，这个管「服务在不在、连不连得上」。
 * 之前装服务只有设置页一条路（`mcp:add` 只收 stdio），远端 HTTP 服务连正规入口都没有 ——
 * 于是「让 Agent 自己把某台 Open API 接进来」是不可能的。执行端走 mcp/manage.js 的
 * `applyToolRequest`，与 IPC 共用同一份 store 与同一次运行时重挂。
 */
const MCP_MANAGE_TOOL = {
  type: 'function',
  function: {
    name: 'mcp_manage',
    description:
      '管理 MCP 服务本身（装/改/启停/删），不是调用它们的工具。' +
      'action=list 看现有服务与启停状态；add 新增；update 改 URL/命令/Token/环境变量；' +
      'enable 启停；remove 删除自定义服务；restore 恢复被移除的预装服务；' +
      'request_credential 让界面上弹出该服务的凭据输入框（由用户亲手填，你永远拿不到明文）；' +
      'check_update 查该 npx 包的最新版本；install_package 把它装到本地后离线可用；upgrade_package 升到指定/最新版本；repair_env 打开环境修复（缺 VS Build Tools 等）。' +
      '远端服务：transport=streamable-http + url，鉴权头不是 Authorization 时给 authHeaderName（如 X-API-Key）并把密钥放 token；' +
      '本地服务：command + args。改动会立即重建 MCP 会话，下一轮工具表里即出现（或消失）该服务的工具；' +
      '具体工具名用 mcp_tool_schema 查。**不知道密钥时不要向用户索要明文**，用 request_credential。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          // 枚举只有一份：mcp/manage.js 的 MCP_MANAGE_ACTIONS（apply() 按它分派）。
          // 在这里抄一份就会漂移 —— 加了动作忘了改 schema，模型永远调不到。
          enum: [...MCP_MANAGE_ACTIONS],
          description: '要做的操作'
        },
        id: {
          type: 'string',
          description: '服务 id（字母开头，仅字母/数字/_/-），用短名即可，如 daizhang、pg-prod'
        },
        name: { type: 'string', description: 'add 时的显示名（必填）' },
        description: { type: 'string', description: '可选说明，会显示在设置页' },
        transport: {
          type: 'string',
          enum: ['stdio', 'streamable-http'],
          description: 'add/update 时选传输方式；省略时按是否给 url 判断'
        },
        url: { type: 'string', description: '远端服务端点，如 http://192.168.31.62:3011/api/open-api/mcp' },
        authHeaderName: {
          type: 'string',
          description: '鉴权请求头名，默认 Authorization；叠云 Open API 系列用 X-API-Key'
        },
        token: { type: 'string', description: '鉴权值：加密存进凭据库（mcp-secrets.json），不写进 mcp.json' },
        command: { type: 'string', description: 'stdio 服务的启动命令，如 npx' },
        args: { type: 'array', items: { type: 'string' }, description: 'stdio 服务的启动参数' },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'update 时覆盖环境变量；只允许服务自己声明过的键（如 mcp-postgres 的 DATABASE_URL）'
        },
        enabled: { type: 'boolean', description: 'enable 时用：true 启用（默认）/ false 停用' },
        reason: {
          type: 'string',
          description: 'request_credential 时用：一句话说明为什么要这个凭据，会显示在输入框上方'
        },
        version: { type: 'string', description: 'upgrade_package 时用：目标版本号；省略则升到 npm latest' },
        repairKind: {
          type: 'string',
          enum: ['windows-vctools', 'npm-cache-busy'],
          description: 'repair_env 时用：要修的问题类型（来自安装失败的诊断）'
        }
      },
      required: ['action']
    }
  }
};

/**
 * 判断模型是否「工具调用能力弱」——只依据可量化的规模信号，禁止按厂商名（deepseek/mimo/qwen 等）
 * 一刀切：同一厂商既有弱模型也有强模型，命中厂商子串会误伤强模型（如 DeepSeek-V4.1-Flash）。
 * 命中条件：模型 id 标注了 ≤8B 参数量，或带 tiny/small/nano/micro/mini 等小模型后缀。
 */function isWeakToolCallerModel(modelId) {
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
              description: { type: 'string', description: '可选说明' },
              preview: { type: 'string', description: '可选预览：代码片段 / ASCII 布局 / 配置示例，等宽展示，供用户并排对比各选项的实际样子' }
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

/**
 * 会话级操作：新建对话 + 把工作空间挂上去（可带第一条任务）。
 *
 * 为什么是 RENDERER_ONLY_TOOLS：会话列表、当前会话、工作空间视图三者都是 Renderer 的状态，
 * Main 单方面建行/切工作空间只会让 UI 与账本脱钩。渲染器侧的执行体直接复用「新对话」按钮那条
 * 单源流程（renderer-chat-history.js 的 createNewSession），这里不重复一遍建会话 + 绑工作空间的顺序。
 */
const SESSION_TOOL = {
  type: 'function',
  function: {
    name: 'session_new',
    description:
      '新建一个对话，并把它的工作空间设到指定目录（可顺带把第一条任务发进去）。' +
      '适用：用户说「开个新对话做这件事」「换到 <某目录> 继续」「这个项目单独开一个会话」，' +
      '或当前对话已被别的任务占住、需要干净起点（新对话会按该目录重新加载 AGENTS.md / 记忆 / 索引）。' +
      '效果：立即切到新对话并挂上工作空间；原对话的消息与工作空间不受影响，可从历史列表切回。' +
      '只想改当前对话的工作空间、不新建对话时，用 session_set_workspace，不要用本工具。' +
      '传 prompt 时本轮应就此收尾：任务在新的对话里独立执行，你在这里继续调工具不会再影响它。',
    parameters: {
      type: 'object',
      properties: {
        workspacePath: {
          type: 'string',
          description:
            '工作空间的绝对路径（例如 D:\\UE5-Tutorial-Course），或远端工作区 URI：ssh://<用户名>@<主机>/<远端路径>' +
            '（例如 ssh://dieyunx@192.168.31.62/run/media/dieyunx/dieyunserver/dieyuntools）。' +
            '远端 URI 必须带 //，不要写成 ssh:主机:/路径 或 user@host:/path——那不是合法工作空间，挂上后整条对话的 cwd 都是错的。' +
            '省略则沿用当前对话的工作空间。'
        },
        title: {
          type: 'string',
          description: '新对话的标题，写清项目或任务，便于在历史列表里辨认。省略则先留空，历史列表用首条消息充当标题。'
        },
        prompt: {
          type: 'string',
          description: '可选：新对话的第一条消息，会立即发送并开始执行。用户已把任务说清时，把任务原样写进来。'
        }
      },
      required: []
    }
  }
};

/**
 * 「把当前对话的工作空间换到指定目录」——一个名字，两种执行现场：
 *
 * - **桌面**（Renderer 执行，见 `renderer-workspace-ssh.js#applySessionWorkspaceFromTool`）：
 *   会话列表、当前会话、工作空间视图都是渲染器的状态，Main 单方面改绑定只会让 UI 与账本脱钩，
 *   所以列在 RENDERER_ONLY_TOOLS 里，Main 收到只做反委托。执行体复用「工作空间选择器」
 *   那条流程（改视图 + 写会话行 + 重载 AGENTS/索引 + 重启终端），不另写一份。
 * - **外部频道**（Main 执行，见 `channels/workspace-switch.js`）：没有 UI 可点，只能在 Main 落绑定，
 *   并额外限制候选（频道默认 + 本机已有会话的工作空间）——群聊里任何人都能发消息，
 *   不能让一句话把 Agent 指到系统目录。
 *
 * 与 `session_new` 的分工：本工具**不动当前会话**（消息与历史留着），只是换它绑定的目录；
 * 要一个干净起点、新开对话才用 session_new。
 */
const SESSION_WORKSPACE_TOOL = {
  type: 'function',
  function: {
    name: 'session_set_workspace',
    description:
      '把**当前这条对话**的工作空间换到指定目录（不新建对话，消息与历史仍留在本会话）。' +
      '适用：用户说「切到 XX 项目」「这个事在 XX 目录做」「换个工作空间」——他要的是在本会话里换项目。' +
      '外部频道（企业微信等）里只能切到本机已有会话用过的项目或该频道默认目录，不在范围内时会返回可选列表，' +
      '别自己编路径；不知道有哪些候选就先不传参数调用一次。' +
      '传 "default" 表示回到默认工作空间。' +
      '切换从下一轮生效：本轮已装配的系统提示、AGENTS.md、索引仍是原目录的，需要在新目录干活就本轮收尾，下一轮再做。',
    parameters: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description:
            '目标工作空间的绝对路径（如 F:\\dieyundaizhang），外部频道里也可用项目目录名（如 dieyundaizhang，需唯一）；' +
            '传 "default" 回到默认工作空间；留空则只返回候选清单、不做切换。'
        }
      },
      required: []
    }
  }
};

/**
 * 只读并发调研子 Agent。
 * 只注入给「协调者」——Agent 主循环、Explore 模式、Plan 的 explore 阶段；
 * 研究子 Agent 的工具集 = Explore 白名单，白名单不含本工具，递归被物理切断（深度恒为 1）。
 * Main 执行（见 src/agent/subagent-runner.js），不属于 RENDERER_ONLY_TOOLS。
 */
const SUBAGENT_TOOL = {
  type: 'function',
  function: {
    name: 'subagent',
    description:
      '派出一个只读研究子 Agent 并行调研一个明确问题（读文件 / 搜索 / 查符号 / 联网）。' +
      '需要分别摸清多个互不依赖的模块或多个事实来源时，一次并发发多个调用，比自己串行读快得多。' +
      '子 Agent 只读、不改工作区、不能再派子 Agent。' +
      '返回的是结论与证据路径的摘要（不是全量过程）；过程可在对话里展开那张折叠卡片查看。' +
      '已经让子 Agent 查过的东西不要自己再查一遍。' +
      '若返回 reason="limit"（或摘要里写明「达到轮次/工具预算被截断」），说明这次调研没跑完：' +
      '摘要只是它已完成的发现，不要当成完整结论 —— 缩小问题范围后重派，或自己补查缺口。',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            '这次调研要回答的单一问题，写清边界与期望产出（例如「X 模块的鉴权入口在哪、被谁调用」）。'
        },
        label: { type: 'string', description: '简短标签，用于在界面上区分多路子 Agent' },
        hints: {
          type: 'array',
          items: { type: 'string' },
          description: '已知线索或起点路径，减少子 Agent 的重复探索'
        },
        continueFrom: {
          type: 'string',
          description:
            '追问模式：填上次结果返回的 subagentId，子 Agent 会带着上次的完整对话继续调研本次 task（仍只读、深度不变）'
        }
      },
      required: ['task']
    }
  }
};

const GRAPH_TOOLS = [GRAPH_TOOL];

/**
 * OS 级电脑控制（截屏 + 鼠标键盘注入）。单一工具、action 枚举（Anthropic computer use 同构）：
 * 每个输入动作后自动截图走视觉管线回传，模型「动一下看一眼」，不需要显式补 screenshot。
 * 注入条件：permissions.osControl 开关（renderer-tool-defs），审批与档位判定在 gateway。
 */
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
      '无法操作需要管理员权限的窗口（UIPI）；首次操作鼠标/键盘会请求用户批准。本工具操作的是叠云所在机器的物理屏幕。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: COMPUTER_ACTIONS_TEXT },
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
const PEER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'peer_list',
      description:
        '列出内网里在线的其他 Agent（同一局域网、已配对）。返回每台的名称、地址、是否与我同一个项目、' +
        '以及它已经声明在改的文件/任务租约。开新活之前先看一眼：有人正在改同一个文件时，优先走消息商量而不是硬改。',
      parameters: {
        type: 'object',
        properties: {
          refresh: {
            type: 'boolean',
            description: 'true = 先主动广播一次宣告再列（对方刚上线时用），默认 false'
          },
          sameProjectOnly: { type: 'boolean', description: '只看和我同一个项目（同一 git remote）的对端' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'peer_send',
      description:
        '给内网另一台 Agent 发消息（按名称或 peerId 指定对端）。对方会收到一条带来源的来信，' +
        '并在其项目上下文里自行处理。expectReply=true 时本调用会等对方跑完一轮并把它的最终答复作为结果返回；' +
        '不等就用默认值，让对方稍后回你。一次只问一件事，别连发；重复追问同一个问题会被对方当噪音。' +
        '长内容（代码、diff、大段日志）请用文件路径传递，不要塞进消息体。',
      parameters: {
        type: 'object',
        properties: {
          peer: { type: 'string', description: '对端名称或 peerId（用 peer_list 查）；也可用 host+port 直连' },
          host: { type: 'string', description: '直连时用：对端 IP' },
          port: { type: 'number', description: '直连时用：对端 peer 服务端口' },
          text: { type: 'string', description: '要发的内容（包含背景、要什么、期望产出）' },
          expectReply: { type: 'boolean', description: 'true = 等对方跑完一轮再返回；默认 false' },
          timeoutMs: { type: 'number', description: '等待回复的超时（毫秒），仅 expectReply=true 时生效' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'peer_claim',
      description:
        '同项目协同的建议式租约：声明「我要改这个文件 / 我要做这个任务」，让同项目的其他 Agent 看见并避让。' +
        '它不是锁——不会阻止写入，冲突仍以 git/worktree 为准；但它能让对方在动手前先来问你。' +
        'action=list 查全部租约；acquire 申请（已有人持有时返回冲突与持有者）；release 释放。' +
        '改完就释放，别长期占着。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'acquire | release | list' },
          kind: { type: 'string', description: 'file（默认）| task' },
          key: {
            type: 'string',
            description: 'file：工作区相对路径（如 src/peer/wire.js）；task：简短任务标识'
          },
          note: { type: 'string', description: '为什么要占它 / 打算怎么改，给对方判断依据' }
        },
        required: ['action']
      }
    }
  }
];

/**
 * 手机摄像头（现实世界视觉）。
 *
 * 为什么是「拍一张」而不是「开一路视频」：见 browser-vision 的相机来源注释与
 * AGENTS 的减法原则 —— 视频流的成本（带宽/电量/上下文）与隐私代价都不需要付，
 * 模型真正需要的是「此刻这里长什么样」，一张就够，不够再拍。
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
 * SSH：连服务器 / 端口转发 / 把工作空间切到远端。
 *
 * 为什么 Agent 需要它：远端能力原先只挂在设置页的连接面板上（`ssh:connect` 等 6 个 IPC），
 * Agent 只有本机 fs/host_exec —— 用户说「连上 192.168.1.9 看下磁盘」只能自己点界面。
 * 执行端走 `src/ssh/actions.js`（与 IPC 同一份实现：别名解析、凭据库、租约、端口转发清理）。
 *
 * 密钥/密码**不经过模型**：能连上靠 ~/.ssh/config 的 IdentityFile 或本机已保存的凭据；
 * 需要密码时让用户去「连接」面板保存一次，再重连。
 */
const SSH_TOOL = {
  type: 'function',
  function: {
    name: 'ssh',
    description:
      'SSH 远程主机：连接、查看连接状态、端口转发、把当前工作空间切到远端目录。' +
      'action=list 看 ~/.ssh/config 里的可用别名与当前连接态；connect 连上（profile=别名，或 host/username）；' +
      'disconnect 断开；port_forward 管本地端口转发；use_workspace 把工作空间切到远端路径后 fs_* / host_exec 都作用于远端；' +
      'browse 列远端目录，home 取远端家目录。密码/私钥必须是本机已保存的（不接收明文密钥参数）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'status', 'connect', 'disconnect', 'port_forward', 'use_workspace', 'browse', 'home'],
          description: '要做的操作，默认 status'
        },
        profile: {
          type: 'string',
          description: 'connect 时用：~/.ssh/config 里的 Host 别名（推荐，私钥/跳板自动带上）'
        },
        host: { type: 'string', description: 'connect 时用：主机名或 IP（没有别名时给这个）' },
        port: { type: 'number', description: 'connect 时用：端口，默认 22' },
        username: { type: 'string', description: 'connect 时用：登录用户' },
        authType: {
          type: 'string',
          enum: ['auto', 'key', 'password', 'agent', 'keyboard-interactive'],
          description: '认证方式，默认 auto（agent → 私钥 → 密码）'
        },
        privateKeyPath: { type: 'string', description: 'key 认证时可指定私钥路径；省略则用别名/已存凭据里的' },
        remotePath: {
          type: 'string',
          description: 'connect 后顺手切到的工作空间路径，或 use_workspace 的目标远端目录'
        },
        force: { type: 'boolean', description: 'disconnect 时用：连有会话租约的连接也强制断开' },
        forwardAction: {
          type: 'string',
          enum: ['list', 'add', 'remove'],
          description: 'port_forward 的子操作，默认 list'
        },
        id: { type: 'string', description: 'port_forward remove 时用：转发条目 id' },
        localPort: { type: 'number', description: 'port_forward add 时用：本地端口（0 = 自动分配）' },
        remoteHost: { type: 'string', description: 'port_forward add 时用：远端目标地址，默认 127.0.0.1' },
        remotePort: { type: 'number', description: 'port_forward add 时用：远端目标端口' },
        path: { type: 'string', description: 'browse 时用：远端目录，默认 /' },
        acceptNewHostKey: {
          type: 'boolean',
          description:
            'connect 时用：首次连接信任该主机指纹。**必须先问过用户并得到明确同意**才能置 true —— ' +
            '指纹第一次出现时工具会连失败并把指纹回给你，那是让你拿去问人的，不是让你自己决定的'
        }
      },
      required: ['action']
    }
  }
};

/**
 * Worktree（并行副本）：给一次改动开独立分支/目录、跑完再决定写回主工作区。
 *
 * 为什么 Agent 需要它：设置页里 13 个 `worktree:*` 通道一直是人在点，Agent 只会直接改主工作区 ——
 * 「先开副本再改，别动我当前分支」这种要求它做不到。执行端走 `src/worktree/actions.js`（与 IPC 同一份）。
 */
const WORKTREE_TOOL = {
  type: 'function',
  function: {
    name: 'worktree',
    description:
      'Git worktree（副本）管理：在独立分支/目录里干活，再预览并写回主工作区。' +
      'action=list 列当前副本；create 为一次运行新建副本（runId 相同则同属一次运行）；list_runs 看历次运行的副本与占用；' +
      'preview_run 看这次运行改了什么；apply_run 把改动写回主工作区；cleanup_run 清理（可先存档）；prune 删过期分支；remove 删单个副本。' +
      '只在本地 Git 工作空间可用（SSH 远程工作区走会话自带的远端副本）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'remove', 'list_runs', 'preview_run', 'apply_run', 'cleanup_run', 'prune'],
          description: '要做的操作'
        },
        runId: { type: 'string', description: '一次运行的 id（create / preview_run / apply_run / cleanup_run 用）' },
        roleId: { type: 'string', description: 'create 时用：这条副本承担的职责名（如 reviewer / fixer）' },
        baseRef: { type: 'string', description: 'create 时用：基线引用，默认 HEAD' },
        path: { type: 'string', description: 'remove 时用：副本目录路径（先 action=list 取）' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'apply_run 时用：只写回这些文件；省略表示全部'
        },
        changeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'apply_run 时用：只写回这些改动 id（来自 preview_run）'
        },
        forceConflict: { type: 'boolean', description: 'apply_run 时用：冲突也强制写回（默认 false）' },
        allowOverwriteMainDirty: {
          type: 'boolean',
          description: 'apply_run 时用：主工作区有未提交改动时也覆盖（默认 false）'
        },
        archive: { type: 'boolean', description: 'cleanup_run 时用：先存档再清理，默认 true' },
        allowDiscardUncommitted: {
          type: 'boolean',
          description: 'cleanup_run 时用：允许丢弃副本里未提交的改动（默认 false，先跟用户确认）'
        },
        deleteBranches: { type: 'boolean', description: 'cleanup_run 时用：连分支一起删（默认 false）' },
        keep: {
          type: 'number',
          description:
            'prune 时用：保留最近 N 个 dieyun 分支不删。**省略等于 0 = 把已合并的历史分支全删**，' +
            '所以不确定就先传 5 这类小数字'
        }
      },
      required: ['action']
    }
  }
};

/**
 * 删除技能：`skills:delete` 通道一直只有设置页按钮，Agent 能建技能却不能收。
 * 判定/删除的唯一实现在 `src/agent-home.js#deleteUserSkill`（与 IPC 同一份：
 * 只删扫描根内、非根本身、非种子技能，且目录里必须真有 SKILL.md）。
 */
const SKILL_DELETE_TOOL = {
  type: 'function',
  function: {
    name: 'skill_delete',
    description:
      '删除一个技能目录（用户自建 / 工作空间内的技能）。预装内置技能与技能根目录不可删。' +
      '只在用户明确要删时用；删之前先确认目录里就是他说的那个技能（可用 fs_read_file 看 SKILL.md）。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '技能目录绝对路径（技能列表里显示的那个目录）' }
      },
      required: ['dir']
    }
  }
};

const ALL_STATIC_TOOLS = HOST_TOOLS.concat(
  WEB_TOOLS,
  BROWSER_TOOLS,
  [CODEBASE_TOOL, GREP_TOOL, GLOB_TOOL, READ_SYMBOL_TOOL, LSP_TOOL],
  GRAPH_TOOLS,
  [AGENTS_MD_PROPOSE_TOOL, SKILL_CREATE_TOOL, SKILL_DELETE_TOOL],
  MEMORY_TOOLS,
  [SESSION_RECALL_TOOL],
  PLAN_TOOLS,
  [MCP_TOOL_SCHEMA_TOOL, MCP_MANAGE_TOOL, CLARIFY_TOOL, SESSION_TOOL, SESSION_WORKSPACE_TOOL, SUBAGENT_TOOL],
  [COMPUTER_TOOL],
  [CAMERA_TOOL],
  [SSH_TOOL],
  [WORKTREE_TOOL],
  PEER_TOOLS
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

// 只认渲染器能做的事：确认卡片、会话/工作空间切换。Main 收到这些名字只做反委托，不自己执行。
// session_set_workspace 同时在频道里由 Main 自己执行（见 CHANNEL_RUNTIME_TOOL_NAMES）：
// 「换工作空间的真相」分属两边 —— 桌面归渲染器视图，频道归 Main 的会话绑定，各写各的那一份。
const RENDERER_ONLY_TOOLS = ['agent_clarify', 'session_new', 'session_set_workspace'];

// 外部频道（Main 后台跑、没有 UI）额外需要的工具：换工作空间只能靠模型显式调用。
// 不进 PLAN_RUNTIME_TOOL_NAMES（计划的工作空间由计划自己定）。
const CHANNEL_RUNTIME_TOOL_NAMES = ['session_set_workspace'];

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
  AGENTS_MD_PROPOSE_TOOL,
  SKILL_CREATE_TOOL,
  SKILL_DELETE_TOOL,
  MEMORY_TOOLS,
  PLAN_TOOLS,
  GOAL_TOOLS,
  MCP_TOOL_SCHEMA_TOOL,
  MCP_MANAGE_TOOL,
  SSH_TOOL,
  WORKTREE_TOOL,
  isMcpServerToolName,
  MCP_BUILTIN_TOOL_NAMES,
  CLARIFY_TOOL,
  SESSION_TOOL,
  SUBAGENT_TOOL,
  SESSION_WORKSPACE_TOOL,
  COMPUTER_TOOL,
  CAMERA_TOOL,
  ALL_STATIC_TOOLS,
  PLAN_RUNTIME_TOOL_NAMES,
  CHANNEL_RUNTIME_TOOL_NAMES,
  RENDERER_ONLY_TOOLS,
  getToolByName,
  toolsByNames,
  isWeakToolCallerModel,
  slimMcpInputSchema,
  compactMcpToolDef
};
