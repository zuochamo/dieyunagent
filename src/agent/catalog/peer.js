'use strict';

/**
 * 内网 agent 互通工具：peer_*（发现、发消息、租约）。
 * 语义全在 `src/peer/`；未启用时执行端回结构化错误，工具本身始终在表里。
 */

const PEER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'peer_list',
      description:
        '列出内网里在线的其他 Agent（同一局域网、已配对）。返回每台的名称、它自报的工作身份、地址、是否与我同一个项目、' +
        '以及它已经声明在改的文件/任务租约；同时返回本机身份（me）和当前打开的**房间**（rooms，含 roomId）。' +
        '开新活之前先看一眼：有人正在改同一个文件时，优先走消息商量而不是硬改。',
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
        '**只给 roomId、不给 peer/host = 发给房间里所有人**（逐台返回结果，部分失败也算成功）。' +
        '长内容（代码、diff、大段日志）请用文件路径传递，不要塞进消息体。',
      parameters: {
        type: 'object',
        properties: {
          peer: {
            type: 'string',
            description:
              '对端名称或 peerId（用 peer_list 查）；也可用 host+port 直连。给了 roomId 时可省略 = 发给房间里所有人'
          },
          host: { type: 'string', description: '直连时用：对端 IP' },
          port: { type: 'number', description: '直连时用：对端 peer 服务端口' },
          text: { type: 'string', description: '要发的内容（包含背景、要什么、期望产出）' },
          expectReply: { type: 'boolean', description: 'true = 等对方跑完一轮再返回；默认 false' },
          timeoutMs: { type: 'number', description: '等待回复的超时（毫秒），仅 expectReply=true 时生效' },
          roomId: {
            type: 'string',
            description:
              '可选：以某个房间的名义发（房间 id 见 Bot 面板）。**给了 roomId 又不给 peer 就是发给房间里所有人**（扇出）。' +
              '房间已结束时会被拒；对端不是房间成员也会被拒。'
          }
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

module.exports = {
  PEER_TOOLS
};
