#!/usr/bin/env python3
"""Ensure critical cross-module renderer symbols exist after modularization."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIR = ROOT / "src/renderer"
HTML = DIR / "index.html"

CRITICAL = [
    "sendMessage",
    "buildAgentTools",
    "executeAgentTool",
    "chatCompletionWithToolsViaRust",
    "fetchChatCompletion",
    "cloneAttachmentSnapshot",
    "resolveSkillTaxonomy",
    "normalizeSkillsCategoryFilter",
    "loadEnabledSkillIds",
    "isSkillEnabled",
    "DEFAULT_ENABLED_SKILL_IDS",
    "loadPluginsUI",
    "connectGateway",
    "gatewayCall",
    "renderAssistantBubbleContent",
    "updateSessionRunProgress",
    "initRendererApp",
    "initComposerFormUI",
    "initAgentLoopUI",
    "initChatRenderUI",
    "initSkillsUI",
    "parseDiffFromSummary",
    "estimateMessagesTokensViaMain",
    "buildCompletionMessages",
    "dispatchAgentRunEvent",
    "buildSessionChatHistoryBlock",
]

NAMESPACE_CRITICAL = [
    ("DieyunGateway", "gatewayCall"),
    ("DieyunGateway", "connectGateway"),
    ("DieyunChat", "appendBubble"),
    ("DieyunChat", "renderChatFromMessages"),
    ("DieyunComposer", "getComposerAgentMode"),
    ("DieyunAgent", "sendMessage"),
    ("DieyunAgent", "runAgentCompletion"),
    ("DieyunAgent", "buildAgentTools"),
    ("DieyunWorkspace", "renderChangesPane"),
]

BOOTSTRAP_DOMAINS = [
    "DieyunChat",
    "DieyunSettings",
    "DieyunWorkspace",
    "DieyunComposer",
    "DieyunAgent",
]


def script_paths():
    html = HTML.read_text(encoding="utf-8")
    out = []
    for src in re.findall(r'src="([^"]+\.js)"', html):
        if src.startswith("./"):
            p = DIR / src[2:]
        elif src.startswith("../"):
            p = (DIR / src).resolve()
        else:
            continue
        out.append(p)
    return out


def all_defs():
    defs = set()
    for p in script_paths():
        if not p.exists():
            continue
        t = p.read_text(encoding="utf-8")
        for m in re.finditer(r"^function (\w+)", t, re.M):
            defs.add(m.group(1))
        for m in re.finditer(r"^async function (\w+)", t, re.M):
            defs.add(m.group(1))
        for kind in ("const", "let", "var"):
            for m in re.finditer(rf"^{kind} (\w+)", t, re.M):
                defs.add(m.group(1))
        for m in re.finditer(r"window\.(\w+)\s*=", t):
            defs.add(m.group(1))
    return defs


def namespace_register_text():
    files = [
        DIR / "core" / "namespace-register.js",
        DIR / "agent" / "trace-store.js",
        DIR / "agent" / "worktree-ui.js",
    ]
    return "\n".join(p.read_text(encoding="utf-8") for p in files if p.exists())


def check_namespaces():
    ns_js = DIR / "core" / "namespaces.js"
    if not ns_js.exists():
        return ["missing core/namespaces.js"]
    if "DieyunNamespaces" not in ns_js.read_text(encoding="utf-8"):
        return ["DieyunNamespaces helper not defined"]
    text = namespace_register_text()
    missing = []
    for ns, symbol in NAMESPACE_CRITICAL:
        if f"'{ns}'" not in text and f'"{ns}"' not in text:
            missing.append(f"{ns}.{symbol} (namespace block)")
            continue
        if symbol not in text:
            missing.append(f"{ns}.{symbol}")
    return missing


def check_bootstrap():
    boot = DIR / "core" / "bootstrap.js"
    domain = DIR / "core" / "domain-bootstrap.js"
    missing = []
    if not boot.exists():
        return ["missing core/bootstrap.js"]
    if "DieyunBootstrap" not in boot.read_text(encoding="utf-8"):
        missing.append("DieyunBootstrap helper")
    if not domain.exists():
        missing.append("missing core/domain-bootstrap.js")
        return missing
    text = domain.read_text(encoding="utf-8")
    for dom in BOOTSTRAP_DOMAINS:
        if f"id: '{dom}'" not in text and f'id: "{dom}"' not in text:
            missing.append(f"bootstrap domain {dom}")
    return missing


def main():
    defs = all_defs()
    missing = [name for name in CRITICAL if name not in defs]
    ns_missing = check_namespaces()
    boot_missing = check_bootstrap()
    missing.extend(ns_missing)
    missing.extend(boot_missing)
    if missing:
        print("Missing critical symbols:")
        for m in missing:
            print(" ", m)
        return 1
    print(f"OK: {len(CRITICAL)} critical symbols present")
    print(f"OK: {len(NAMESPACE_CRITICAL)} namespace exports registered")
    print(f"OK: {len(BOOTSTRAP_DOMAINS)} bootstrap domains registered")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
