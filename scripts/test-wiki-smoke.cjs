'use strict';

/**
 * Wiki service unit smoke (no Gateway).
 * Run: node scripts/test-wiki-smoke.cjs
 */

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  slugify,
  parseFrontmatter,
  buildPageMarkdown,
  listWikiPages,
  readWikiPage,
  writeWikiPage,
  recallWikiPages,
  WIKI_ROOT
} = require('../src/wiki/wiki-service');

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL', msg);
  } else {
    console.log('ok', msg);
  }
}

async function makeStorage(root) {
  return {
    async mkdir(rel) {
      await fs.mkdir(path.join(root, rel), { recursive: true });
    },
    async listDir(rel) {
      const dir = path.join(root, rel);
      const names = await fs.readdir(dir, { withFileTypes: true });
      const out = [];
      for (const ent of names) {
        const st = await fs.stat(path.join(dir, ent.name));
        out.push({
          name: ent.name,
          isDirectory: ent.isDirectory(),
          size: st.size,
          mtimeMs: st.mtimeMs
        });
      }
      return out;
    },
    async readText(rel) {
      return fs.readFile(path.join(root, rel), 'utf8');
    },
    async writeText(rel, data) {
      const full = path.join(root, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, String(data || ''), 'utf8');
    }
  };
}

async function main() {
  assert(slugify('Hello World') === 'hello-world', 'slugify hello-world');
  assert(slugify('SSH 远程索引') === 'ssh', 'slugify keep ascii parts');

  const md = buildPageMarkdown({
    title: 'SSH 远程索引',
    body: '# SSH 远程索引\n\n用 Remote Agent 建索引。',
    tags: ['ssh', 'index']
  });
  const parsed = parseFrontmatter(md);
  assert(parsed.meta.title === 'SSH 远程索引', 'frontmatter title');
  assert(/用 Remote Agent/.test(parsed.body), 'frontmatter body');

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dieyun-wiki-'));
  const storage = await makeStorage(tmp);
  const w1 = await writeWikiPage(storage, {
    title: 'SSH Index',
    body: '# SSH Index\n\nRemote Agent index notes.'
  });
  assert(w1.slug === 'ssh-index', `write slug got ${w1.slug}`);
  assert(w1.path === `${WIKI_ROOT}/ssh-index.md`, 'write path');

  await writeWikiPage(storage, {
    slug: 'deploy',
    title: 'Deploy',
    body: '# Deploy\n\nShip packages to COS.'
  });

  const pages = await listWikiPages(storage);
  assert(pages.length === 2, `list pages ${pages.length}`);
  assert(pages.every((p) => p.slug !== 'readme'), 'skip readme');

  const page = await readWikiPage(storage, 'ssh-index');
  assert(page.title === 'SSH Index' || /SSH Index/.test(page.markdown), 'read title');

  const hit = recallWikiPages(pages, 'remote agent index', 8);
  assert(hit.length >= 1 && hit.some((p) => p.slug === 'ssh-index'), 'recall keyword');

  const catalog = recallWikiPages(pages, 'zzzz-no-match', 8);
  assert(catalog.length === 0, 'recall no-hit returns empty (no fallback inject)');

  const emptyQ = recallWikiPages(pages, '', 8);
  assert(emptyQ.length === 0, 'empty query returns empty');

  await fs.rm(tmp, { recursive: true, force: true });

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nwiki-smoke: ALL OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
