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
    "skillDomainId",
    "normalizeSkillsCategoryFilter",
    "loadEnabledSkillIds",
    "isSkillEnabled",
    "DEFAULT_ENABLED_SKILL_IDS",
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
    # 「索引」面板把代码片段索引与结构索引合并成一个页签：这三处是合并外壳的
    # 唯一入口（tab 名 index、两个索引的 shown 扇出、rail busy 合成）。
    # 缺任何一个侧栏就会退化成半残页面，故列为关键符号。
    "initIndexPanel",
    "onIndexPanelShown",
    "applyIndexRailBusy",
]

NAMESPACE_CRITICAL = [
    ("DieyunGateway", "gatewayCall"),
    ("DieyunGateway", "connectGateway"),
    ("DieyunChat", "appendBubble"),
    ("DieyunChat", "renderChatFromMessages"),
    ("DieyunComposer", "resolveComposerModelForSend"),
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

# agent-bundle-entry.js 注册的命名空间里，**渲染层真在吃它的全局**的那些。
# 缺一个不会报构建错、也不会被下面的 all_defs 抓到（这些全局是 bundle 运行时挂上去的），
# 只会在真跑起来时炸在第一处调用点 —— 2026-11-17 就是这样：删 SSE 注册时连带删掉了后面
# 一百多行 register，点开历史会话报 `unpackMessageMeta is not defined`（DieyunSessionContext 没了）。
CRITICAL_BUNDLE_NAMESPACES = [
    "DieyunSessionContext",
    "DieyunSessionTranscript",
    "DieyunAgentSystemPrompt",
    "DieyunContextSignals",
    "DieyunRunEvents",
    "DieyunGuardrailsShared",
    "DieyunToolCatalog",
    "DieyunPlannerToolFilters",
    "DieyunAgentRoundText",
    "DieyunReviewerJson",
    "DieyunReasoningBackfill",
]

BUNDLE_ENTRY = DIR / "agent" / "agent-bundle-entry.js"


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


def check_bundle_registration():
    """agent-bundle-entry.js：require 了却没 register，或者关键命名空间整块没了。

    这条栏杆的存在理由：bundle 层把 `compat` 名单镜像成 window.* 全局，删注册**不会**报错
    （没人 require、没被 all_defs 扫到），只会在真跑起来时炸在第一处调用点。
    """
    if not BUNDLE_ENTRY.exists():
        return ["missing agent/agent-bundle-entry.js"]
    text = BUNDLE_ENTRY.read_text(encoding="utf-8")
    missing = []
    requires = re.findall(r"^const (\w+) = require\('([^']+)'\);", text, re.M)
    reg_at = text.find("register(")
    region = text[reg_at:] if reg_at >= 0 else ""
    for name, module in requires:
        if not re.search(rf"\b{re.escape(name)}\b", region):
            missing.append(
                f"agent-bundle-entry: require 了 {module}（{name}）但 register 没有引用它 —— "
                f"该模块对应的 window.* 全局会静默消失"
            )
    for ns in CRITICAL_BUNDLE_NAMESPACES:
        if not re.search(rf"register\(\s*['\"]{re.escape(ns)}['\"]", text):
            missing.append(f"agent-bundle-entry: 缺少命名空间注册 {ns}")
    return missing


def main():
    defs = all_defs()
    missing = [name for name in CRITICAL if name not in defs]
    ns_missing = check_namespaces()
    boot_missing = check_bootstrap()
    bundle_missing = check_bundle_registration()
    missing.extend(ns_missing)
    missing.extend(boot_missing)
    missing.extend(bundle_missing)
    if missing:
        print("Missing critical symbols:")
        for m in missing:
            print(" ", m)
        return 1
    print(f"OK: {len(CRITICAL)} critical symbols present")
    print(f"OK: {len(NAMESPACE_CRITICAL)} namespace exports registered")
    print(f"OK: {len(BOOTSTRAP_DOMAINS)} bootstrap domains registered")
    print(f"OK: {len(CRITICAL_BUNDLE_NAMESPACES)} critical agent-bundle namespaces registered")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
