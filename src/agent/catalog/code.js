'use strict';

/**
 * 代码检索 / 结构工具：codebase_search / grep / glob / read_symbol / lsp / graph。
 * 这些工具的判定与执行分别在 `src/index`、`src/lsp`、Rust `graph`；这里只有 schema。
 */

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
      '语义检索用 codebase_search。' +
      '要搜本机文件：path 写 local: 前缀（例 local:C:\\Users\\me\\logs），pattern 仍按字面/正则写。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的字符串；默认按字面匹配' },
        glob: { type: 'string', description: '可选文件过滤，如 **/*.js、*.rs' },
        path: { type: 'string', description: '可选子目录，相对工作空间根；要搜本机目录写 local: 前缀' },
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
      '本地走 LSP/结构索引；SSH 工作区自动降级为远程结构索引 → 远程 grep，仍返回带行号代码体（降级精度略低）。' +
      '不支持 local: 本机路径（本机文件不在会话索引里）：读本机文件用 fs_read_file。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '文件路径；只按 name 全库找时可省略（不能只给路径）' },
        name: { type: 'string', description: '符号名（函数/类/方法），如 prepSystemPrompt' },
        line: { type: 'number', description: '1-based 行号：读包含该行的最小符号' },
        maxLines: { type: 'number', description: '最多返回行数，默认 400，上限 2000' },
      },
      anyOf: [
        { required: ['filePath', 'name'] },
        { required: ['filePath', 'line'] },
        { required: ['name'] }
      ],
      required: []
    }
  }
};

const GLOB_TOOL = {
  type: 'function',
  function: {
    name: 'glob',
    description:
      '按 glob 模式列出工作空间内的文件路径（不含内容）。找某个文件名、某类扩展名时用这个，不要递归 fs_list_dir。' +
      '要列本机文件：pattern 写 local: 前缀的绝对 pattern（例 local:C:\\Users\\me\\logs\\**\\*.log）。',
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
          enum: [
            'workspaceSymbol',
            'documentSymbol',
            'goToDefinition',
            'typeDefinition',
            'goToImplementation',
            'findReferences',
            'hover'
          ],
          // 枚举是**唯一来源**：`tool-validate.js` 从 schema 读取（不再自己写一份数组）。
          // 加新 operation = 只改这里（描述、枚举、执行端分派三处对齐由 check:js 与夹具兜住）。
          description:
            'workspaceSymbol：全库按名搜符号（只要 query）。' +
            'documentSymbol：列出文件内符号大纲（只要 filePath）。' +
            'goToDefinition / typeDefinition / goToImplementation / findReferences / hover：需要 filePath + line。'
        },
        filePath: { type: 'string', description: '文件路径；workspaceSymbol 时可省略' },
        line: { type: 'number', description: '1-based 行号；workspaceSymbol/documentSymbol 不需要' },
        character: { type: 'number', description: '1-based 列号（UTF-16），默认 1' },
        query: { type: 'string', description: 'workspaceSymbol：要搜的符号名' }
      },
      allOf: [
        {
          if: { properties: { operation: { const: 'workspaceSymbol' } }, required: ['operation'] },
          then: { required: ['query'] }
        },
        {
          if: { properties: { operation: { not: { enum: ['workspaceSymbol'] } } }, required: ['operation'] },
          then: { required: ['filePath'] }
        },
        {
          if: {
            properties: { operation: { not: { enum: ['workspaceSymbol', 'documentSymbol'] } } },
            required: ['operation']
          },
          then: { required: ['line'] }
        }
      ],
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
            'find_symbol | module_deps | callers | callees | impact | lsp_callers（callers/callees 的返回带 callGraphBuilt：false 表示该工作区还没建调用图，此时空列表不代表「没有调用方」）'
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


const GRAPH_TOOLS = [GRAPH_TOOL];

/**
 * OS 级电脑控制（截屏 + 鼠标键盘注入）。单一工具、action 枚举（Anthropic computer use 同构）：
 * 每个输入动作后自动截图走视觉管线回传，模型「动一下看一眼」，不需要显式补 screenshot。
 * 注入条件：permissions.osControl 开关（renderer-tool-defs），审批与档位判定在 gateway。
 */

module.exports = {
  CODEBASE_TOOL,
  GREP_TOOL,
  GLOB_TOOL,
  READ_SYMBOL_TOOL,
  LSP_TOOL,
  GRAPH_TOOL,
  GRAPH_TOOLS
};
