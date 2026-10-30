'use strict';

/**
 * 文案表契约：中英两份必须**键集合一致**。
 *
 * 实测过的坑：给「朗读」加了中文文案却忘了英文那份，英文界面下会直接显示 key
 * （`tts_read`）或退回拼音式半吊子，而且没人会去点一遍所有语言才发现。
 */
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-i18n.js');

/** 从源码里取 I18N_MESSAGES 的键集合（不执行文件，避免 DOM 依赖）。 */
function keysByLanguage(source) {
  const start = source.indexOf('const I18N_MESSAGES');
  const body = source.slice(start);
  const result = {};
  // 语言块：'zh-CN': { ... } / en: { ... }
  const blockRe = /(?:\s{2}'zh-CN':|\s{2}en:)\s*\{([\s\S]*?)\n {2}\}/g;
  let block;
  while ((block = blockRe.exec(body))) {
    const lang = block[0].trim().startsWith("'zh-CN'") ? 'zh-CN' : 'en';
    const keys = [];
    const keyRe = /^\s{4}([a-z0-9_]+):/gm;
    let key;
    while ((key = keyRe.exec(block[1]))) keys.push(key[1]);
    result[lang] = keys;
  }
  return result;
}

describe('renderer-i18n 文案表', () => {
  const source = fs.readFileSync(SRC, 'utf8');
  const keys = keysByLanguage(source);

  it('解析出中英两个语言块', () => {
    expect(keys['zh-CN']?.length || 0).toBeGreaterThan(100);
    expect(keys.en?.length || 0).toBeGreaterThan(100);
  });

  it('两种语言的键集合完全一致（漏翻会在这里红）', () => {
    const zh = [...keys['zh-CN']].sort();
    const en = [...keys.en].sort();
    expect(en.filter((k) => !zh.includes(k))).toEqual([]);
    expect(zh.filter((k) => !en.includes(k))).toEqual([]);
  });

  it('朗读相关文案在中英两边都在（英文界面不能冒中文/key）', () => {
    const needed = [
      'tts_read',
      'tts_stop',
      'tts_btn_title',
      'tts_btn_title_stop',
      'tts_fail_title',
      'tts_empty_text',
      'tts_empty_bubble',
      'tts_no_model_title',
      'tts_no_model_hint',
      'tts_audio_error',
      'tts_auto_read_label',
      'tts_auto_read_hint_on',
      'tts_auto_read_hint_off'
    ];
    for (const key of needed) {
      expect(keys['zh-CN']).toContain(key);
      expect(keys.en).toContain(key);
    }
  });
});
