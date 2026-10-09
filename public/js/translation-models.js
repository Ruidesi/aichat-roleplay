// 翻译模型独立于聊天模型：CLI 虚拟模型只用于翻译，不写入 modelsCache。
import { get } from '/js/api.js';

let cached = null;
let generation = 0;

export function translationModelId(value) {
  if (!/^-?\d+$/.test(String(value ?? ''))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && (id > 0 || id === -4505 || id === -4507) ? id : null;
}

export function clearTranslationModelsCache() { cached = null; generation++; }

export async function loadTranslationModels(force = false) {
  if (!force && cached && Date.now() - cached.at < 60000) return cached.data;
  const seq = ++generation;
  const response = await get('/api/translation/models');
  const data = {
    items: Array.isArray(response?.items) ? response.items.filter((m) => m && m.enabled !== 0 && m.enabled !== false && translationModelId(m.id) != null) : [],
    default_model_id: translationModelId(response?.default_model_id),
    translate_backend: response?.translate_backend === 'cli' ? 'cli' : 'api',
  };
  if (seq === generation) cached = { at: Date.now(), data };
  return data;
}
