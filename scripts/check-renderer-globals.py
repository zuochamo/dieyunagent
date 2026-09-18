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

if bugs:
    print("Issues found:")
    for b in bugs:
        print(" ", b)
    sys.exit(1)
else:
    print("No duplicate const/let/function across script load order")
