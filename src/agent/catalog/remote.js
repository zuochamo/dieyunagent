'use strict';

/**
 * 远端工作工具：ssh（连接/端口转发/切远端工作空间）/ worktree（并行副本）。
 * 执行端与 IPC 共用 `src/ssh/actions.js` / `src/worktree/actions.js`；动作清单就是各自的 schema enum。
 */

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
          // 这份 enum 就是 ssh 动作的**唯一清单**：tool-validate 的白名单从它派生
          // （`tool-validate.js#toolActionEnum('ssh')`），执行分派见 tool-bridge-main.js。
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
          // 同 ssh：这份 enum 是 worktree 动作的唯一清单，校验从它派生。
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

module.exports = {
  SSH_TOOL,
  WORKTREE_TOOL
};
