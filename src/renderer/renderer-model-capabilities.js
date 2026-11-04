/** Shared modality helpers for custom & supplier models (text / vision / speech / tts). */
(function () {
  /**
   * 模态标签**唯一一份**（设置页的标签、徽标、供应商行摘要都从这里取）。
   *
   * speech 与 tts 必须分开：前者是「语音转文字」（Composer 麦克风 →
   * /v1/audio/transcriptions），后者是「文字转语音」（朗读 →
   * chat/completions 出音频）。混成一个「语音」档位，用户给语音档位填 TTS 模型后
   * 麦克风转写会 404、朗读也拿不到音色配置 —— 这正是本次拆开的原因。
   */
  const MODALITY_LABELS = {
    text: { label: '文本', short: '文本' },
    vision: { label: '全模态', short: '全模态' },
    speech: { label: '语音转写', short: '转写' },
    tts: { label: '语音合成', short: '合成' }
  };

  const MODALITY_OPTIONS = ['text', 'vision', 'speech', 'tts'];

  /**
   * 「新增模型 / 新增供应商」的默认模态：全模态（vision）。
   *
   * 与 `normalizeModalitySetting` 的兜底（text）**刻意分开**，别合并：
   *   - 那一处兜底读的是**历史设置**——从没标注过模态的老供应商模型按 text 算，
   *     与 Main 侧 `model-runtime-by-tier.declaredModality` 同判据；改成 vision 会让
   *     纯文本模型也被当成能识图，浏览器截图 / 图片附件注进去直接 400。
   *   - 这一处是**创建**：用户加完模型不该再逐个点标签，默认给全模态，
   *     默认不限制识图能力。
   */
  const DEFAULT_MODALITY = 'vision';

  /** 不能当对话模型用的模态（与 Main 侧 model-api-config.js#isNonChatModality 同判据）。 */
  const NON_CHAT_MODALITIES = new Set(['speech', 'tts']);

  function isNonChatModality(kind) {
    return NON_CHAT_MODALITIES.has(String(kind == null ? '' : kind).trim());
  }

  /**
   * 「供应商 / 自定义模型 → { baseUrl, apiKey }」的单一来源是
   * src/agent/model-api-config.js（经 dist/agent-bundle.js 在 index.html 中先于本文件加载）。
   * 本文件只负责 modality 维度的「挑哪个」，不再自己实现取字段/裁剪规则。
   */
  function sharedModelApiConfig() {
    return (typeof window !== 'undefined' && window.DieyunModelApiConfig) || null;
  }

  /**
   * `source` 用于一并透传请求修饰字段（headers / authMode / userAgent）。
   * 只取 baseUrl + apiKey 会静默丢掉用户配的自定义头与 User-Agent。
   */
  function apiConfigOf(baseUrl, apiKey, source) {
    const shared = sharedModelApiConfig();
    if (shared && typeof shared.asConfig === 'function') {
      const extra =
        typeof shared.requestOptionsFrom === 'function'
          ? shared.requestOptionsFrom(source)
          : undefined;
      return shared.asConfig(baseUrl, apiKey, undefined, extra);
    }
    return { baseUrl: String(baseUrl || '').trim(), apiKey: String(apiKey || '').trim() };
  }

  function supplierApiConfig(supplier) {
    return apiConfigOf(supplier && supplier.baseUrl, supplier && supplier.apiKey, supplier);
  }

  function customModelApiConfig(model) {
    return apiConfigOf(model && model.baseUrl, model && model.apiKey, model);
  }

  function normalizeModalitySetting(value, kind) {
    if (value === 'vision' || value === 'text' || value === 'speech' || value === 'tts') return value;
    if (kind === 'vision') return 'vision';
    if (kind === 'speech') return 'speech';
    if (kind === 'tts') return 'tts';
    return 'text';
  }

  function effectiveCustomModelKind(model) {
    if (!model) return 'text';
    return normalizeModalitySetting(model.modalitySetting, model.kind);
  }

  function customModelSupportsMultimodal(model) {
    return effectiveCustomModelKind(model) === 'vision';
  }

  function describeCustomModelModality(model) {
    const kind = effectiveCustomModelKind(model);
    const meta = MODALITY_LABELS[kind] || MODALITY_LABELS.text;
    return { label: meta.label, short: meta.short, kind };
  }

  function describeSupplierModelModality(modality) {
    const kind = normalizeModalitySetting(modality);
    const meta = MODALITY_LABELS[kind] || MODALITY_LABELS.text;
    return { label: meta.label, short: meta.short, kind };
  }

  /** 判据单一来源同 renderer-model-runtime.js：委托 model-api-config，勿复写。 */
  function isSupplierModelEnabled(supplier, modelId) {
    const shared = sharedModelApiConfig();
    if (shared && typeof shared.isSupplierModelEnabled === 'function') {
      return shared.isSupplierModelEnabled(supplier, modelId);
    }
    if (!supplier || !modelId) return false;
    const map = supplier.enabledModels || {};
    if (!Object.keys(map).length) return true;
    return map[modelId] !== false;
  }

  function getSupplierModelModality(supplier, modelId) {
    if (!supplier || !modelId) return 'text';
    const map = supplier.modelModalities && typeof supplier.modelModalities === 'object' ? supplier.modelModalities : {};
    return normalizeModalitySetting(map[modelId]);
  }

  function supplierModelSupportsMultimodal(supplier, modelId) {
    if (!isSupplierModelEnabled(supplier, modelId)) return false;
    return getSupplierModelModality(supplier, modelId) === 'vision';
  }

  function parseBuiltinRoute(route) {
    const routeStr = String(route || '');
    if (!routeStr.startsWith('builtin:')) return null;
    const rest = routeStr.slice('builtin:'.length);
    const idx = rest.indexOf(':');
    if (idx >= 0) {
      return { supplierId: rest.slice(0, idx), modelId: rest.slice(idx + 1) };
    }
    return { supplierId: null, modelId: rest };
  }

  function findSupplierModelByModality(settings, modality) {
    const s = settings && typeof settings === 'object' ? settings : {};
    for (const supplier of s.modelSuppliers || []) {
      if (!supplier || !String(supplier.baseUrl || '').trim()) continue;
      const modalityMap = supplier.modelModalities || {};
      const modelIds = new Set([
        ...Object.keys(supplier.enabledModels || {}),
        ...Object.keys(modalityMap)
      ]);
      for (const modelId of modelIds) {
        if (!modelId || !isSupplierModelEnabled(supplier, modelId)) continue;
        if (getSupplierModelModality(supplier, modelId) !== modality) continue;
        return {
          model: modelId,
          supplierId: supplier.id,
          route: `builtin:${supplier.id}:${modelId}`,
          apiConfig: supplierApiConfig(supplier)
        };
      }
    }
    return null;
  }

  function pickSpeechModel(settings) {
    const s = settings && typeof settings === 'object' ? settings : {};
    const customSpeech = (s.customModels || []).find(
      (m) => m && m.kind === 'speech' && m.name && m.baseUrl
    );
    if (customSpeech) {
      return {
        model: String(customSpeech.name).trim(),
        route: `custom:${customSpeech.id}`,
        source: 'custom',
        apiConfig: customModelApiConfig(customSpeech)
      };
    }
    const supplierHit = findSupplierModelByModality(s, 'speech');
    if (supplierHit) return { ...supplierHit, source: 'supplier' };
    return null;
  }

  function getSpeechApiConfigFromSettings(settings) {
    const pick = pickSpeechModel(settings);
    if (pick) {
      return {
        baseUrl: String(pick.apiConfig?.baseUrl || '').trim(),
        apiKey: String(pick.apiConfig?.apiKey || '').trim(),
        model: String(pick.model || '').trim()
      };
    }
    const s = settings && typeof settings === 'object' ? settings : {};
    return {
      baseUrl: String(s.speechBaseUrl || s.baseUrl || '').trim(),
      apiKey: String(s.speechApiKey || s.apiKey || '').trim(),
      model: String(s.speechWhisperModel || 'whisper-1').trim() || 'whisper-1'
    };
  }

  /**
   * 「朗读用哪个模型」唯一入口 —— 与 `pickSpeechModel` **不可互相兜底**。
   *
   * 只认 `kind: 'tts'`：转写模型（`speech`）走的是 `/v1/audio/transcriptions`，
   * 拿不到音频，把它塞进朗读只会再多一个 404。
   *
   * @returns {{ model: string, route: string, source: 'custom'|'supplier',
   *             apiConfig: object, voice: string, format: string } | null}
   */
  function pickTtsModel(settings) {
    const s = settings && typeof settings === 'object' ? settings : {};
    const customTts = (s.customModels || []).find(
      (m) => m && m.kind === 'tts' && m.name && m.baseUrl
    );
    if (customTts) {
      return {
        model: String(customTts.name).trim(),
        route: `custom:${customTts.id}`,
        source: 'custom',
        apiConfig: customModelApiConfig(customTts),
        voice: String(customTts.voice || '').trim(),
        format: String(customTts.format || '').trim()
      };
    }
    const supplierHit = findSupplierModelByModality(s, 'tts');
    if (supplierHit) return { ...supplierHit, source: 'supplier', voice: '', format: '' };
    return null;
  }

  /**
   * 朗读请求配置（未配置朗读模型时返回 null —— UI 据此不显示「朗读」按钮）。
   * 一并带出 headers / authMode / userAgent：否则「设置的测试」与真实朗读头不同。
   */
  function getTtsApiConfigFromSettings(settings) {
    const pick = pickTtsModel(settings);
    if (!pick) return null;
    return {
      ...pick.apiConfig,
      baseUrl: String(pick.apiConfig?.baseUrl || '').trim(),
      apiKey: String(pick.apiConfig?.apiKey || '').trim(),
      model: String(pick.model || '').trim(),
      voice: pick.voice || '',
      format: pick.format || ''
    };
  }

  function modelSupportsMultimodalInSettings(settings, modelId, route) {
    const id = String(modelId || '').trim();
    if (!id) return false;
    const routeStr = String(route || '');

    const s = settings && typeof settings === 'object' ? settings : {};
    const custom = (s.customModels || []).find((m) => m && (m.name === id || m.id === id));
    if (custom) return customModelSupportsMultimodal(custom);

    const parsed = parseBuiltinRoute(routeStr);
    if (parsed?.modelId) {
      const supplier = parsed.supplierId
        ? (s.modelSuppliers || []).find((row) => row.id === parsed.supplierId)
        : null;
      if (supplier) return supplierModelSupportsMultimodal(supplier, parsed.modelId);
    }

    for (const supplier of s.modelSuppliers || []) {
      if (supplierModelSupportsMultimodal(supplier, id)) return true;
    }
    return false;
  }

  function supplierModalitySummary(supplier) {
    if (!supplier) return '';
    const enabled = supplier.enabledModels || {};
    const keys = Object.keys(enabled).filter((k) => enabled[k] !== false);
    if (!keys.length) return '';
    let vision = 0;
    let speech = 0;
    let tts = 0;
    for (const modelId of keys) {
      const kind = getSupplierModelModality(supplier, modelId);
      if (kind === 'vision') vision += 1;
      if (kind === 'speech') speech += 1;
      if (kind === 'tts') tts += 1;
    }
    const parts = [];
    if (vision) parts.push(`全模态×${vision}`);
    if (speech) parts.push(`转写×${speech}`);
    if (tts) parts.push(`合成×${tts}`);
    return parts.join(' · ');
  }

  function resolveChatCompletionsEndpoint(baseUrl) {
    // 端点拼接单一来源 llm-request（与 Main 侧同一份实现）
    return window.LlmRequest.resolveLlmEndpoint(baseUrl, 'chat');
  }

  window.ModelCapabilities = {
    MODALITY_LABELS,
    MODALITY_OPTIONS,
    DEFAULT_MODALITY,
    isNonChatModality,
    normalizeModalitySetting,
    effectiveCustomModelKind,
    customModelSupportsMultimodal,
    describeCustomModelModality,
    describeSupplierModelModality,
    isSupplierModelEnabled,
    getSupplierModelModality,
    supplierModelSupportsMultimodal,
    parseBuiltinRoute,
    findSupplierModelByModality,
    pickSpeechModel,
    getSpeechApiConfigFromSettings,
    pickTtsModel,
    getTtsApiConfigFromSettings,
    modelSupportsMultimodalInSettings,
    supplierModalitySummary,
    resolveChatCompletionsEndpoint
  };
})();
