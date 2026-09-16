'use strict';

/**
 * 简易 YAML frontmatter（支持 description / description_zh 的 | 与 > 多行块）
 * @param {string} content
 */
function parseFrontmatter(content) {
  const raw = String(content);
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { meta: {}, body: raw.trim() };
  const body = raw.slice(m[0].length).trim();
  const meta = {};
  const lines = m[1].split(/\r?\n/).map((ln) => ln.replace(/\r$/, ''));
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const keyMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) {
      i += 1;
      continue;
    }
    const key = keyMatch[1];
    let rest = keyMatch[2].trim();
    if ((key === 'metadata' || key === 'triggers') && !rest) {
      i += 1;
      while (i < lines.length && !/^[a-zA-Z0-9_-]+:\s/.test(lines[i])) {
        i += 1;
      }
      continue;
    }
    if (rest === '|' || rest === '>') {
      const block = [];
      i += 1;
      while (i < lines.length) {
        const ln = lines[i];
        if (/^[a-zA-Z0-9_-]+:\s/.test(ln)) break;
        block.push(ln);
        i += 1;
      }
      meta[key] = block.join('\n').trim();
      continue;
    }
    if ((rest.startsWith('"') && rest.endsWith('"')) || (rest.startsWith("'") && rest.endsWith("'"))) {
      rest = rest.slice(1, -1);
    }
    meta[key] = rest;
    i += 1;
  }
  return { meta, body };
}

/**
 * @param {object} meta
 */
function pickDescriptionEn(meta) {
  return String(meta.description || meta.description_en || '').trim();
}

/**
 * @param {object} meta
 */
function pickDescriptionZh(meta) {
  return String(meta.description_zh || meta.descriptionZh || meta['description-zh'] || '').trim();
}

/**
 * @param {object} meta
 * @param {string} [body]
 * @param {number} [maxLen]
 */
function formatBilingualBlurb(meta, body, maxLen) {
  const en = pickDescriptionEn(meta);
  const zh = pickDescriptionZh(meta);
  let text = '';
  if (zh && en) text = `${zh}\n${en}`;
  else if (zh) text = zh;
  else if (en) text = en;
  else if (body) text = body.replace(/\s+/g, ' ').trim().slice(0, maxLen || 280);
  else text = '暂无简介';
  if (maxLen > 0 && text.length > maxLen) {
    return `${text.slice(0, maxLen).trim()}…`;
  }
  return text;
}

module.exports = {
  parseFrontmatter,
  pickDescriptionEn,
  pickDescriptionZh,
  formatBilingualBlurb
};
