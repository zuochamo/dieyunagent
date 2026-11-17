'use strict';

/**
 * 本机与网页工具：fs_* / host_exec / host_proc / web_search / web_fetch。
 * 拆目录只为一件事：加一个工具时动**一个域文件**，不必在 2600 行单文件里找位置。
 * 对外入口仍然是 `src/agent/tool-catalog.js`（barrel 重导出，导出名未改）。
 */
const { LOCAL_PATH_HINT } = require('./params');

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
        '把图片文件发送到默认打印机（打印永远发生在叠云这台机器上）。filePath 填绝对路径，或仅填文件名（如 123.jpg，相对工作空间根目录）；' +
        'SSH 会话里给远端路径也可以：会先把文件取回本机临时副本再打印（返回 localCopy 路径）。' +
        LOCAL_PATH_HINT +
        '不要用 host_exec 调 mspaint 拼路径。',
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
        '远程 detached 的输出落在远端 /tmp/dieyun-host-proc/ 下，路径在返回值里。' +
        '默认在会话工作空间所在机器执行：SSH 会话里就是远端主机。要在叠云这台机器上跑（例：本机有 GUI/本机装了某工具/本机桌面文件），设 local=true。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          cwd: {
            type: 'string',
            description:
              '工作目录（相对工作空间或绝对路径）；写 local: 前缀可指定本机目录，例 local:C:\\Users\\me'
          },
          local: {
            type: 'boolean',
            description:
              'true = 在叠云这台机器上执行（缺省跟随会话工作空间；SSH 会话里默认是远端主机）。本机命令的 cwd 用本机路径'
          },
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
          id: {
            type: 'string',
            description:
              'host_exec 返回的 handle，如 hostproc-3（本机）/ sshproc-3（SSH 远端）。句柄前缀自己决定去哪张表（output/kill 必填其一）'
          },
          local: {
            type: 'boolean',
            description:
              'list 用：true 看本机那张表（SSH 会话里起过本机后台进程时用）。output/kill 认句柄前缀，通常不必给'
          },
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
        '要让用户在回答里看到某张图（包括你用脚本生成、落盘的图），也用它读一次：能识图时这张图会一并显示在正式回答里，不用让用户自己去翻文件。' +
        LOCAL_PATH_HINT,
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
        '整文件写入。仅用于新建文件，或改动太大无法用 fs_edit 唯一替换时覆盖整文件。已有源码优先 fs_edit。' +
        LOCAL_PATH_HINT,
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
      description: '列出目录内容。' + LOCAL_PATH_HINT,
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


module.exports = {
  HOST_TOOLS,
  WEB_TOOLS
};
