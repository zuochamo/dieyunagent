/** Shared modality helpers for custom & supplier models (text / vision / speech). */
(function () {
  const MODALITY_LABELS = {
    text: { label: '文本', short: '文本' },
    vision: { label: '全模态', short: '全模态' },
    speech: { label: '语音', short: '语音' }
  };

  const MODALITY_OPTIONS = ['text', 'vision', 'speech'];

  function normalizeModalitySetting(value, kind) {
    if (value === 'vision' || value === 'text' || value === 'speech') return value;
    if (kind === 'vision') return 'vision';
    if (kind === 'speech') return 'speech';
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

  function isSupplierModelEnabled(supplier, modelId) {
    if (!supplier || !modelId) return false;
    const map = supplier.enabledModels || {};
    const keys = Object.keys(map);
    if (!keys.length) return true;
    if (map[modelId] === false) return false;
    return map[modelId] === true;
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
          apiConfig: {
            baseUrl: String(supplier.baseUrl || '').trim(),
            apiKey: String(supplier.apiKey || '').trim()
          }
        };
      }
    }
    return null;
  }

  function pickVisionModel(settings) {
    const s = settings && typeof settings === 'object' ? settings : {};
    const customVision = (s.customModels || []).find(
      (m) => m && m.kind === 'vision' && m.name && m.baseUrl
    );
    if (customVision) {
      return {
        model: String(customVision.name).trim(),
        route: `custom:${customVision.id}`,
        source: 'custom',
        apiConfig: {
          baseUrl: String(customVision.baseUrl || '').trim(),
          apiKey: String(customVision.apiKey || '').trim()
        }
      };
    }
    const supplierHit = findSupplierModelByModality(s, 'vision');
    if (supplierHit) return { ...supplierHit, source: 'supplier' };
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
        apiConfig: {
          baseUrl: String(customSpeech.baseUrl || '').trim(),
          apiKey: String(customSpeech.apiKey || '').trim()
        }
      };
    }
    const supplierHit = findSupplierModelByModality(s, 'speech');
    if (supplierHit) return { ...supplierHit, source: 'supplier' };
    return null;
  }

  function getVisionApiConfigFromSettings(settings) {
    const pick = pickVisionModel(settings);
    if (!pick) return { baseUrl: '', apiKey: '', model: '' };
    return {
      baseUrl: String(pick.apiConfig?.baseUrl || '').trim(),
      apiKey: String(pick.apiConfig?.apiKey || '').trim(),
      model: String(pick.model || '').trim()
    };
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

  function modelSupportsMultimodalInSettings(settings, modelId, route) {
    const id = String(modelId || '').trim();
    if (!id) return false;
    const routeStr = String(route || '');
    if (/^custom-vision|^auto-vision|custom:vision/.test(routeStr)) return true;

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
    for (const modelId of keys) {
      const kind = getSupplierModelModality(supplier, modelId);
      if (kind === 'vision') vision += 1;
      if (kind === 'speech') speech += 1;
    }
    const parts = [];
    if (vision) parts.push(`全模态×${vision}`);
    if (speech) parts.push(`语音×${speech}`);
    return parts.join(' · ');
  }

  function resolveChatCompletionsEndpoint(baseUrl) {
    const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(raw)) return raw;
    if (/\/v1$/i.test(raw)) return `${raw}/chat/completions`;
    return `${raw}/v1/chat/completions`;
  }

  window.ModelCapabilities = {
    MODALITY_LABELS,
    MODALITY_OPTIONS,
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
    pickVisionModel,
    pickSpeechModel,
    getVisionApiConfigFromSettings,
    getSpeechApiConfigFromSettings,
    modelSupportsMultimodalInSettings,
    supplierModalitySummary,
    resolveChatCompletionsEndpoint
  };
})();
