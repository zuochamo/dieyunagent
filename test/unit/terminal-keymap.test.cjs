'use strict';

const fs = require('fs');
const path = require('path');

const RENDERER_DIR = path.join(__dirname, '..', '..', 'src', 'renderer');
const SCREEN_SRC = fs.readFileSync(path.join(RENDERER_DIR, 'terminal-screen.js'), 'utf8');
const TERM_SRC = fs.readFileSync(path.join(RENDERER_DIR, 'renderer-terminal.js'), 'utf8');

/**
 * 回归点：本机（无 PTY 的管道 shell）不能收到行编辑 / 控制序列。
 * 实测 cmd.exe 会把 `\x1b[A` 当命令文本（`'←[A' 不是内部或外部命令`），
 * 而 AltGr（Windows 上是 Ctrl+Alt）打出来的可打印字符以前会被静默丢掉。
 *
 * 渲染端脚本是浏览器全局脚本，按仓库既有做法用 new Function + 假 DOM 驱动（见
 * trace-checkpoint-delta.test.cjs 的同类做法）。
 */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeElement(id) {
  const handlers = new Map();
  return {
    id,
    hidden: false,
    className: '',
    textContent: '',
    value: '',
    scrollTop: 0,
    scrollHeight: 100,
    clientHeight: 100,
    children: [],
    attrs: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, fn) {
      const list = handlers.get(type) || [];
      list.push(fn);
      handlers.set(type, list);
    },
    dispatch(type, event) {
      (handlers.get(type) || []).forEach((fn) => fn(event || {}));
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    appendChild(child) {
      this.children.push(child);
      this.firstChild = this.children[0];
      return child;
    },
    contains() {
      return true;
    },
    focus() {
      document.activeElement = this;
    }
  };
}

function loadTerminalPane({ session }) {
  const pane = makeElement('terminal-pane');
  const out = makeElement('terminal-output');
  const sink = makeElement('terminal-ime-sink');
  const meta = makeElement('terminal-meta');
  const restart = makeElement('terminal-restart');
  const byId = { 'terminal-pane': pane, 'terminal-output': out, 'terminal-ime-sink': sink, 'terminal-meta': meta, 'terminal-restart': restart };

  const docHandlers = new Map();
  const document = {
    activeElement: null,
    getElementById: (id) => byId[id] || null,
    querySelector: () => null,
    createTextNode: (data) => ({ kind: 'text', data }),
    createElement: (tag) => makeElement(tag),
    addEventListener(type, fn) {
      const list = docHandlers.get(type) || [];
      list.push(fn);
      docHandlers.set(type, list);
    }
  };

  const writes = [];
  const diecloud = {
    terminalStart: async () => ({ ok: true, ...session }),
    terminalStop: async () => ({ ok: true }),
    terminalDetach: async () => ({ ok: true }),
    terminalWrite: async (payload) => {
      writes.push(payload.data);
      return { ok: true };
    },
    onTerminalData: () => () => {},
    onTerminalExit: () => () => {}
  };

  const win = { diecloud };
  const mod = new Function(
    'window',
    'document',
    'currentSessionId',
    'isSidePanelOpen',
    'getSidePanelTab',
    'createTerminalScreen',
    'isChatNearBottom',
    `${SCREEN_SRC}\n${TERM_SRC}\nreturn { initTerminalPane, ensureTerminalSession, handleTerminalKeydown };`
  )(win, document, 's1', () => true, () => 'terminal', win.createTerminalScreen, () => true);

  mod.initTerminalPane();
  // 焦点落在可编辑宿主上（真实路径是 mousedown → focusTerminalSink）
  pane.dispatch('focusin', { target: sink });

  return {
    mod,
    writes,
    meta,
    press(key, opts = {}) {
      const event = {
        key,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
        keyCode: 0,
        defaultPrevented: false,
        preventDefault() {
          event.defaultPrevented = true;
        },
        ...opts
      };
      (docHandlers.get('keydown') || []).forEach((fn) => fn(event));
      return event;
    }
  };
}

describe('terminal 按键映射：本机不发控制序列，AltGr 不被吞', () => {
  it('SSH（PTY）下行编辑 / 控制键按终端惯例转发', async () => {
    const t = loadTerminalPane({ session: { remote: true, host: 'h', username: 'u', cwd: '/srv' } });
    await t.mod.ensureTerminalSession(false, 's1');
    t.writes.length = 0;

    t.press('ArrowUp');
    t.press('Home');
    t.press('c', { ctrlKey: true });
    t.press('f', { altKey: true });
    await flush();

    expect(t.writes).toEqual(['\u001b[A', '\u001b[H', '\x03', '\u001bf']);
  });

  it('本机（管道 shell）只转发文本、回车、退格、Tab', async () => {
    const t = loadTerminalPane({ session: { remote: false, cwd: 'C:/ws' } });
    await t.mod.ensureTerminalSession(false, 's1');
    t.writes.length = 0;

    t.press('ArrowUp');
    t.press('Delete');
    t.press('c', { ctrlKey: true });
    t.press('f', { altKey: true });
    await flush();
    expect(t.writes).toEqual([]);

    t.press('l');
    t.press('s');
    t.press('Tab');
    t.press('Backspace');
    t.press('Enter');
    await flush();
    expect(t.writes).toEqual(['l', 's', '\t', '\x7f', '\r\n']);
  });

  it('AltGr 字符两种会话都必须送达（德/波兰键盘的 @ \\ { } ~ | ）', async () => {
    for (const session of [{ remote: true, host: 'h', username: 'u' }, { remote: false, cwd: 'C:/ws' }]) {
      const t = loadTerminalPane({ session });
      await t.mod.ensureTerminalSession(false, 's1');
      t.writes.length = 0;

      t.press('@', { ctrlKey: true, altKey: true });
      t.press('\\', { ctrlKey: true, altKey: true });
      await flush();
      expect(t.writes).toEqual(['@', '\\']);
    }
  });

  it('Ctrl+V 交给 paste 事件，不自己发 0x16', async () => {
    const t = loadTerminalPane({ session: { remote: true, host: 'h', username: 'u' } });
    await t.mod.ensureTerminalSession(false, 's1');
    t.writes.length = 0;

    t.press('v', { ctrlKey: true });
    await flush();
    expect(t.writes).toEqual([]);
  });
});
