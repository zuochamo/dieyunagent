#!/usr/bin/env python3
"""Detect duplicate top-level declarations across renderer script load order."""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
html = (ROOT / "src/renderer/index.html").read_text(encoding="utf-8")
scripts = []
for src in re.findall(r'src="([^"]+\.js)"', html):
    if src.startswith("./dist/"):
        # 构建产物（agent-bundle.js 等），由 scripts/build-agent-bundle.cjs 生成，源代码不在此扫描
        continue
    if src.startswith("./"):
        scripts.append(ROOT / "src/renderer" / src[2:])
    elif src.startswith("../"):
        scripts.append(ROOT / "src" / src[3:])
    else:
        scripts.append(ROOT / src)

decls = {}
bugs = []
for p in scripts:
    label = str(p.relative_to(ROOT)).replace("\\", "/")
    if not p.exists():
        bugs.append(f"MISSING {label}")
        continue
    t = p.read_text(encoding="utf-8")
    stripped = t.strip()
    if stripped.startswith("(function") and stripped.endswith("}());"):
        continue
    for kind in ("const", "let"):
        for m in re.finditer(rf"^{kind} (\w+)", t, re.M):
            name = m.group(1)
            if name in decls:
                bugs.append(f"DUP {kind} {name}: {decls[name]} + {label}")
            decls[name] = label
    for m in re.finditer(r"^function (\w+)", t, re.M):
        name = m.group(1)
        if name in decls:
            bugs.append(f"DUP function {name}: {decls[name]} + {label}")
        decls[name] = label

# window 导出必须指向一个真实存在的顶层声明。
# 原来只查「重复声明」，查不出「删掉函数却忘了删 window.X = 函数名」这类残留：
# 严格模式下读取未声明标识符会抛 ReferenceError，直接中断整个脚本的加载，
# 但表象只是「某个功能整体失效」，很难定位。
all_names = set(decls.keys())
for p in scripts:
    if not p.exists():
        continue
    t = p.read_text(encoding="utf-8")
    for m in re.finditer(r"^(?:async )?function (\w+)", t, re.M):
        all_names.add(m.group(1))
    for m in re.finditer(r"^(?:var|let|const) (\w+)", t, re.M):
        all_names.add(m.group(1))
    for m in re.finditer(r"window\.(\w+)\s*=", t):
        all_names.add(m.group(1))

exports_checked = 0
JS_LITERALS = {"null", "true", "false", "undefined", "NaN", "Infinity"}
for p in scripts:
    if not p.exists():
        continue
    label = str(p.relative_to(ROOT)).replace("\\", "/")
    t = p.read_text(encoding="utf-8")
    for m in re.finditer(r"window\.(\w+)\s*=\s*(\w+)\s*;", t):
        name = m.group(2)
        if name in JS_LITERALS:
            continue
        # 短名多半是函数内的局部变量 / 参数（p、el、text…），静态上无法与「未声明的全局」区分；
        # 这里只校验长标识符（真实函数名的形态），宁可漏报也不误报。
        if len(name) < 8:
            continue
        exports_checked += 1
        if name not in all_names:
            bugs.append(f"UNRESOLVED window.{m.group(1)} = {name}: {label}")

if bugs:
    print("Issues found:")
    for b in bugs:
        print(" ", b)
    sys.exit(1)
else:
    print("No duplicate const/let/function across script load order")
    print(f"OK: {exports_checked} window exports resolve to a declaration")
