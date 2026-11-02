#!/usr/bin/env python3
"""SSH 双会话索引耗时测量的远端驱动（由 scripts/verify-index-timing-ssh.cjs 上传并执行）。

为什么是 Python 而不是 Node：远端主机不一定装了 node，python3 基本都有；
驱动只做一件事——按 JSON-RPC 行协议跟 `dieyun-core serve-stdio` 说话。

三次测量（同一份项目、同一个 data_dir，两份独立索引库 = 两个 SSH 会话）：

    A-冷启动      新库 + 空缓存   → 片段要建、向量全量真算
    B-第二个会话  新库 + 热缓存   → 片段要建、向量应全部复用（0 次请求端点）
    C-同库重建    同一个库 + force → 片段要重建、向量走缓存

每行输出一个 JSON 对象（stdout），调用方按行解析。
"""

import json
import os
import subprocess
import sys
import time


def parse_args(argv):
    args = {}
    for item in argv:
        key, _, value = item.lstrip('-').partition('=')
        args[key] = value
    return args


def die(message):
    print(json.dumps({"error": message}), flush=True)
    sys.exit(3)


class Core:
    def __init__(self, exe, data_dir):
        os.makedirs(data_dir, exist_ok=True)
        # 显式 UTF-8：core 说 UI 消息是 UTF-8，Windows 上 text=True 会按本地码页（GBK）解码而炸
        self.proc = subprocess.Popen(
            [exe, '--data-dir', data_dir, 'serve-stdio'],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding='utf-8',
            errors='replace',
            bufsize=1,
        )
        self.seq = 0

    def call(self, method, params, timeout=1800):
        self.seq += 1
        rid = self.seq
        self.proc.stdin.write(json.dumps({"id": rid, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while True:
            line = self.proc.stdout.readline()
            if not line:
                die("core 进程退出（%s）" % method)
            if time.time() > deadline:
                die("超时（%s）" % method)
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("id") != rid:
                continue
            if msg.get("error"):
                err = msg["error"]
                die("%s 失败: %s %s" % (method, err.get("code"), err.get("message")))
            return msg.get("result")

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=30)
        except Exception:  # noqa: BLE001
            self.proc.kill()


def main():
    # Windows 控制台的默认码页打不出中文标签，显式 UTF-8
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:  # noqa: BLE001
        pass
    args = parse_args(sys.argv[1:])
    for required in ('core', 'ws', 'data', 'db_a', 'db_b', 'embed-url', 'model', 'dims'):
        if not args.get(required):
            die("缺少参数 --%s" % required)

    core = Core(args['core'], args['data'])
    ws = args['ws']
    dims = int(args['dims'])

    def configure(db_path):
        core.call("core.configure", {
            "data_dir": args['data'],
            "workspace_roots": [ws],
            "index_db_path": db_path,
            "embedding": {
                "model": args['model'],
                "baseUrl": args['embed-url'],
                "dimensions": dims,
                "apiKey": args.get('api-key', ''),
                "authMode": args.get('auth-mode', 'none'),
            },
        })

    def status():
        return core.call("codebase.status", {"workspaceRoot": ws})

    def drop(db_path):
        for suffix in ('', '-wal', '-shm'):
            try:
                os.remove(db_path + suffix)
            except OSError:
                pass

    def db_size(db_path):
        # 建完就地读，WAL 还没 checkpoint：只 stat 主文件会得到「库只有 4KB」这种假数字
        total = 0
        for suffix in ('', '-wal'):
            if os.path.exists(db_path + suffix):
                total += os.path.getsize(db_path + suffix)
        return total

    def build(label, db_path, force):
        configure(db_path)
        before = status()
        started = time.time()
        core.call("codebase.index.start", {"workspaceRoot": ws, "force": force, "vectors": True})
        saw_running = False
        while True:
            st = status()
            if st.get("indexing"):
                saw_running = True
            elif saw_running or time.time() - started > 5:
                break
            if time.time() - started > 3600:
                die("%s 建库超时" % label)
            time.sleep(0.05)
        print(json.dumps({
            "label": label,
            "elapsedMs": int((time.time() - started) * 1000),
            "fileCount": st.get("fileCount"),
            "chunkCount": st.get("chunkCount"),
            "vectorCount": st.get("vectorCount"),
            "vectorsReused": st.get("vectorsReused"),
            "vectorsEmbedded": st.get("vectorsEmbedded"),
            "dbBytes": db_size(db_path),
            "wasIndexed": bool(before.get("indexed")),
        }), flush=True)

    drop(args['db_a'])
    drop(args['db_b'])
    build("A-冷启动", args['db_a'], True)
    build("B-第二个会话", args['db_b'], True)
    build("C-同库重建", args['db_a'], True)

    hit = core.call("codebase.search", {"workspaceRoot": ws, "query": "function", "limit": 3})
    print(json.dumps({"search": {"vectorSearch": hit.get("vectorSearch"), "hits": len(hit.get("results") or [])}}),
          flush=True)
    core.close()


if __name__ == '__main__':
    main()
