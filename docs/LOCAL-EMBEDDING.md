# 向量后端：本地推理优先

> **状态**：已实施（2026-11-17）。取代「只支持远端 OpenAI 兼容端点」的旧形态。
> **代码**：`crates/dieyun-core/src/embedding/`（`local.rs` 本地推理 / `remote.rs` 远端端点 / `mod.rs` provider 判定）、`src/agent/embedding-config.js`（装配唯一入口）、`src/codebase/embedding-client.js`（薄 RPC 封装）。

---

## 1. 一句话

`provider = auto` 时**能用本地就用本地**（毫秒级、无网络、无端点吞吐依赖），否则退回远端端点；`local` / `remote` 可显式钉住。

## 2. 为什么会退回去（历史约束，别再犯）

进程内 ONNX 推理曾经存在（Rust `builtin-ort` feature + Node `local-embedding.js`），2026-08-27 的 `6386411`「slim Windows installer and make BGE an optional download」把它删了，理由是**安装包体积**（模型 103MB + onnxruntime dylib）。本次恢复时继承那次的结论：

- `ort` 用 **`load-dynamic`**：构建期不下载 onnxruntime，也不往产物目录拷 dylib；
- 模型与运行时**都由宿主按需提供**，缺任一个就退回远端；`models/` 仍不进安装包（`.gitignore` 已忽略 `models/**/*.onnx`）。

## 3. provider 判定（唯一入口 `EmbeddingConfig::plan`）

| `provider` | 本地可用 | 远端配齐 | 结果 |
|---|---|---|---|
| `auto`（默认/未知取值） | ✅ | — | `Local` |
| `auto` | ❌ | ✅ | `Remote` |
| `auto` | ❌ | ❌ | `Disabled(原因)` |
| `local` | ✅ | — | `Local` |
| `local` | ❌ | — | `Disabled(原因)`：**不**偷偷换远端 |
| `remote` | — | ✅ | `Remote` |

「本地可用」= 编译期带 `local-embed` feature + 模型目录里有 `onnx/*.onnx` 与 `tokenizer.json` + onnxruntime dylib 能加载。三者任一缺失都会在 `embedding.status.localReason` 里给出人话原因。

## 4. 本地推理口径

- 模型：`bge-base-zh-v1.5`，**768 维**，量化 ONNX（`model_quantized.onnx`，103MB）。
- 池化：**CLS + L2 归一化**（BGE 官方口径）。被删掉的那版用的是 mean pooling——同一个模型换池化，向量空间就变了，混用**不会报错、只会让相似度变差**。签名里因此带 `|cls`，存量库能被判为「口径不同」而重建，而不是悄悄降质。
- 分词：直接读模型自带的 `tokenizer.json`（`tokenizers` crate），不自己实现 WordPiece。
- 输入：`input_ids` / `attention_mask` / **`token_type_ids`（全 0）**——bge 的 ONNX 图把 `token_type_embeddings` 声明成必需输入，少喂这一路会直接 `Missing Input: token_type_ids`。
- 形状：**固定补到 512**。不按批内最长补：量化模型的 attention 对掩码位有数值泄漏，批内最长一变，同一段文本的向量就变。
- 并发：进程内 `Session` 池（`min(核数, 4)`），每个 session 的 intra-op 线程按核数摊开。

### 4.1 一个必须知道的事实：换批次形状会轻微改变向量

实测（2026-11-17，本机 1.20 运行时装机验证）：**同一批次形状重跑 → 逐位一致**；**批量 3 → 单条** → 同一段文本余弦 ≈ **0.98**。原因是量化 kernel 的累加顺序随 batch 规模变化，不是我们的池化/分词错。

因此：

- 索引（批量）与查询（单条）之间必然存在这个量级的差异 —— 任何「逐位相等」的假设都是错的；
- 向量缓存（`index/vector_cache.rs`，键 = 内容哈希）存「算出来的那一个」，**不跨形状比对**，所以不受影响；
- 回归测试按形状分开断言（`local.rs` 那条用例），别把它改成 `assert_eq` 跨形状比较。

真机数据：单条 512 token 的量化 base 模型在本机约 30–60ms（4 个 session 并发摊开）。

## 5. 放置位置（可选下载的落点）

| 变量 | 作用 |
|---|---|
| `DIEYUN_MODELS_DIR` | 模型根目录（开发时指向仓库 `models/`）；缺省 `<userData>/models` |
| `DIEYUN_ORT_LIB` | onnxruntime 动态库路径；缺省找 `<模型根>/onnxruntime/onnxruntime.dll`（或 `.so` / `.dylib`），再退到 `ort` 的平台默认名（PATH / 同目录 / 系统库） |

目录形状：

```
<models>/
  bge-base-zh-v1.5/
    tokenizer.json  config.json  tokenizer_config.json  vocab.txt
    onnx/model_quantized.onnx
  onnxruntime/onnxruntime.dll        # 可选：不给就走系统加载
```

## 6. 远端 Linux core 怎么办

打包远端 core 时用 `cargo build -p dieyun-core --no-default-features`（或 `--no-default-features --features ...`）关掉 `local-embed`：产物里就没有 ORT 依赖，glibc 下限与静态化前提都不受影响。远端主机要不要本地推理是那台机器的事，所以推送配置时显式 `allowLocal: false`（`gateway/rpc.js` / `remote-index-core.js`），不拿宿主机的模型目录替它声明。

## 7. 已删除的三层补偿（别再搬回来）

远端独占时代，为了「端点一慢就整轮饿死」加过：

1. 全进程并发闸门 `EMBED_CONCURRENCY` + `EMBED_INFLIGHT`；
2. 给交互查询预留名额的批量闸门 `EMBED_BATCH_INFLIGHT`；
3. `INTERACTIVE_EMBED_BUDGET_MS` + `EMBEDDING_TOO_SLOW` + `counts_as_query_latency` 的「预判太慢就不发」，以及 Node 侧同款（`embedding-client.js` 的往返测量、闸门、串行队列 `embedding-queue.js`、查询缓存）。

本地推理毫秒级且无网络，这些层的根因消失，于是整体删除。现在只剩：

- `BATCH_FANOUT`（远端批量扇出窗口，纯粹别把端点打爆）；
- 远端请求超时 `EMBED_REQUEST_TIMEOUT_MS`（传输层必需，不是补偿）；
- Node 侧 `embeddingChannelLikelyAvailable`（**粗判**「值不值得发一次 RPC」，权威判定仍在 Rust）。

## 8. 负向清单

- **不要**在 Node 侧自己打 embedding 端点。文档向量（建库 / 记忆写入）与查询向量必须出自同一后端，否则向量空间不同 → 相似度静默变差。
- **不要**给 `local` 加「不可用就偷偷用远端」的回落：显式选择被静默替换，是最难查的一类现象。
- **不要**改池化方式而不动签名（`bge-base-zh-v1.5@768|cls`）：签名是存量库判「口径不同」的唯一依据。
- **不要**把模型或 dylib 塞回安装包（见 §2）。
- **不要**在调用点再写一份「有没有向量通道」的判定；`embedding.status` 是唯一自述。

## 9. 测试

```bash
cargo test -p dieyun-core --lib embedding      # provider 判定 / 签名 / 批规划 / 本地探活
cargo build -p dieyun-core --no-default-features   # 远端产物形态（无 ORT）
npm run test:unit
npm run test:local-gateway-smoke
```

真跑一次本地推理（模型 + 运行时都在才跑，否则跳过）：

```powershell
$env:DIEYUN_MODELS_DIR = 'E:\dieyunagent\models'
$env:DIEYUN_ORT_LIB = "$env:APPDATA\dieyunagent\models\onnxruntime\onnxruntime.dll"
cargo test -p dieyun-core --lib embedding::local -- --nocapture --test-threads=1
```
