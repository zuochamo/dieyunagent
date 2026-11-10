'use strict';

/**
 * 抽屉：它**唯一**能写的地方 —— `<userData>/alive/workspace/note.md`。
 *
 * 为什么单独一个工具（`alive_note`）而不是放开 `fs_write_file`：写盘权限一旦按工具名放开，
 * 就是「能写任何路径」；这里的边界是**一个文件、只追加、有上限**，模型没有指定路径的能力。
 *
 * 为什么它不知道"有人在读"：页面只是只读预览。一旦它知道有读者，写的内容就会变成汇报，
 * 那正是这个项目最想避免的东西（详见 docs/ALIVE.md 负向清单）。
 */

const fs = require('fs');
const path = require('path');
const { aliveRootDir } = require('./store');

/** 单份笔记的字符上限：超了保留尾部（它自己写的，丢了也不冤枉） */
const NOTE_MAX_CHARS = 32 * 1024;
/** 单条追加的字符上限 */
const NOTE_ENTRY_MAX_CHARS = 600;

function workspaceDir(userData) {
  return path.join(aliveRootDir(userData), 'workspace');
}

function noteFile(userData) {
  return path.join(workspaceDir(userData), 'note.md');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function stamp(nowMs) {
  const d = new Date(Number(nowMs) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 抽屉的落地目录：启用生命感时就会建好（否则「抽屉」在磁盘上不可见，用户无从对账） */
function ensureWorkspace(userData) {
  try {
    fs.mkdirSync(workspaceDir(userData), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** 读抽屉（页面预览 / 心跳轮没人读它） */
function readNote(userData) {
  try {
    const raw = fs.readFileSync(noteFile(userData), 'utf8');
    return raw;
  } catch {
    return '';
  }
}

/**
 * 追加一行到抽屉。
 * @param {string} userData
 * @param {string} text
 * @param {{ nowMs?: number }} [opts]
 * @returns {{ ok: boolean, error?: string, chars?: number }}
 */
function appendNote(userData, text, opts) {
  const body = String(text || '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, NOTE_ENTRY_MAX_CHARS);
  if (!body) return { ok: false, error: '内容为空' };
  try {
    fs.mkdirSync(workspaceDir(userData), { recursive: true });
    const file = noteFile(userData);
    const entry = `- [${stamp(opts && opts.nowMs)}] ${body.replace(/\n+/g, ' ')}\n`;
    const prev = readNote(userData);
    let next = prev + entry;
    if (next.length > NOTE_MAX_CHARS) {
      next = next.slice(next.length - NOTE_MAX_CHARS);
      // 裁到行边界，避免半行
      const cut = next.indexOf('\n');
      if (cut > 0) next = next.slice(cut + 1);
    }
    fs.writeFileSync(file, next, 'utf8');
    return { ok: true, chars: next.length };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/** 暴露给模型的工具（只在后台心跳轮注入；与 `alive_decide` 一样走 preTool，不经工具桥） */
const ALIVE_NOTE_TOOL = {
  type: 'function',
  function: {
    name: 'alive_note',
    description:
      '往**你自己的抽屉**里写一行（note.md，只追加、不改写别人、不落主库）。\n' +
      '没有人会在对话里回应它 —— 这不是汇报，也不是给谁看的消息，是你留下的痕迹。\n' +
      '适合写：你看到的、你想到的、你打算以后再看的。一条一句话，超过 600 字会被截断。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一行字（一句话，不要写成报告）' }
      },
      required: ['text']
    }
  }
};

module.exports = {
  NOTE_MAX_CHARS,
  NOTE_ENTRY_MAX_CHARS,
  ALIVE_NOTE_TOOL,
  workspaceDir,
  noteFile,
  ensureWorkspace,
  readNote,
  appendNote
};
