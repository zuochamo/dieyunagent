#!/usr/bin/env python3
"""本地 core 直连验证：定义点通道是否在**本地工作区**同样生效。

不经过 app（app 的 core 二进制被它自己占着，无法 repack），直接用
`target/release/dieyun-core.exe serve-stdio` 跑同一份代码路径：
建代码索引 → 建结构索引 → 按名找定义，比较索引排序与 grep 排序。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')

CORE = r'E:\dieyunagent\target\release\dieyun-core.exe'
SRC = [r'E:\dieyunagent\src\gateway', r'E:\dieyunagent\src\remote']
ROOT = os.path.join(os.environ['TEMP'], 'dy-local-probe')
WS = os.path.join(ROOT, 'ws')
DATA = os.path.join(ROOT, 'data')
DB = os.path.join(DATA, 'index.sqlite')
N = 15
LIMIT = 5


def setup():
    for p in (WS, DATA):
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
    os.makedirs(WS)
    os.makedirs(DATA)
    for src in SRC:
        shutil.copytree(src, os.path.join(WS, os.path.basename(src)),
                        ignore=shutil.ignore_patterns('node_modules', '.git'))


class Core:
    def __init__(self):
        self.proc = subprocess.Popen(
            [CORE, '--data-dir', DATA, 'serve-stdio'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding='utf-8', errors='replace', bufsize=1)
        self.seq = 0

    def call(self, method, params, timeout=900):
        self.seq += 1
        self.proc.stdin.write(json.dumps({"id": self.seq, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError('core 退出')
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get('id') != self.seq:
                continue
            if msg.get('error'):
                err = msg['error']
                raise RuntimeError('%s: %s' % (err.get('code'), err.get('message')))
            return msg.get('result', msg)

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def rel(p):
    return os.path.relpath(p, WS).replace('\\', '/')


def sample_symbols():
    """从拷贝过来的真实源码里机械抽样：定义点 + 至少 8 字符的名字。"""
    out = []
    pats = [
        re.compile(r'^(?:async )?function ([A-Za-z_$][\w$]{7,})\s*\('),
        re.compile(r'^(?:const|let|var) ([A-Za-z_$][\w$]{7,})\s*=\s*(?:async\s*)?\('),
        re.compile(r'^\s{2}([A-Za-z_$][\w$]{7,})\s*\([^)]*\)\s*\{$'),
    ]
    for dirpath, _dirs, files in os.walk(WS):
        for f in sorted(files):
            if not f.endswith('.js'):
                continue
            path = os.path.join(dirpath, f)
            with open(path, encoding='utf-8', errors='replace') as fh:
                for i, line in enumerate(fh, 1):
                    for p in pats:
                        m = p.match(line)
                        if m:
                            out.append({'name': m.group(1), 'path': rel(path), 'line': i})
                            break
    # 同名只留第一个（定义点），等距抽样
    seen, uniq = set(), []
    for s in out:
        if s['name'] in seen:
            continue
        seen.add(s['name'])
        uniq.append(s)
    step = max(1, len(uniq) // N)
    return [uniq[i] for i in range(0, len(uniq), step)][:N]


def grep_rank(name, expect):
    """无索引基线：按出现次数排序（agent 没有索引时会 grep 名字，按命中数猜文件）。"""
    counts = []
    token = re.compile(r'(?<![\w$])' + re.escape(name) + r'(?![\w$])')
    for dirpath, _dirs, files in os.walk(WS):
        for f in files:
            if not f.endswith('.js'):
                continue
            path = os.path.join(dirpath, f)
            with open(path, encoding='utf-8', errors='replace') as fh:
                n = len(token.findall(fh.read()))
            if n:
                counts.append((n, rel(path)))
    counts.sort(key=lambda x: (-x[0], x[1]))
    top = [p for _n, p in counts[:LIMIT]]
    return top.index(expect) + 1 if expect in top else 0


def main():
    setup()
    core = Core()
    ws_params = {'workspaceRoot': WS}
    core.call('core.configure', {
        'data_dir': DATA,
        'workspace_roots': [WS],
        'index_db_path': DB,
        'embedding': {'model': '', 'baseUrl': '', 'dimensions': 0, 'apiKey': '', 'authMode': 'none'},
    })
    t = time.time()
    core.call('codebase.index.start', {**ws_params, 'force': True, 'vectors': False})
    while True:
        st = core.call('codebase.status', ws_params)
        if not st.get('indexing'):
            break
        time.sleep(0.2)
    t_code = time.time() - t
    t = time.time()
    core.call('graph.index.start', {**ws_params, 'force': True, 'calls': False})
    while True:
        gs = core.call('graph.status', ws_params)
        if not gs.get('indexing'):
            break
        time.sleep(0.2)
    t_graph = time.time() - t
    print('库：%d 文件 / %d 片段 · 结构索引 %d 符号（建库 %.1fs，建图 %.1fs）' % (
        st.get('fileCount') or 0, st.get('chunkCount') or 0, gs.get('symbolCount') or 0, t_code, t_graph))

    syms = sample_symbols()
    print('抽样 %d 个符号（来自 %s）' % (len(syms), ', '.join(os.path.basename(s) for s in SRC)))
    ranks, g_ranks = [], []
    for s in syms:
        res = core.call('codebase.search', {**ws_params, 'query': s['name'], 'limit': LIMIT})
        paths = [r['path'] for r in (res.get('results') or [])]
        r = paths.index(s['path']) + 1 if s['path'] in paths else 0
        g = grep_rank(s['name'], s['path'])
        ranks.append(r)
        g_ranks.append(g)
        print('  %-32s %-42s 索引=%s grep=%s' % (s['name'], s['path'], r or 'miss', g or 'miss'))

    def mrr(xs):
        return sum(1.0 / x for x in xs if x) / max(1, len(xs))

    n = len(ranks)
    print('\n索引：hit@1 %d/%d · hit@%d %d/%d · MRR %.2f' % (
        sum(1 for r in ranks if r == 1), n, LIMIT,
        sum(1 for r in ranks if 0 < r <= LIMIT), n, mrr(ranks)))
    print('grep：hit@1 %d/%d · hit@%d %d/%d · MRR %.2f' % (
        sum(1 for r in g_ranks if r == 1), n, LIMIT,
        sum(1 for r in g_ranks if 0 < r <= LIMIT), n, mrr(g_ranks)))
    core.close()


if __name__ == '__main__':
    main()
