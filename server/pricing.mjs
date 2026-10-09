// 计费（契约 §10.2）：各家 usage 解析、上游实价（xAI ticks）、按单价推算、CNY→USD、预置单价表。纯函数，无 IO。

/** xAI：1 tick = 1e-10 美元（docs.x.ai/developers/cost-tracking：1 USD = 10^10 ticks）。 */
export const USD_PER_TICK = 1e-10;
export const DEFAULT_CNY_TO_USD = 0.14;
export const CURRENCIES = ['USD', 'CNY'];

/**
 * 预置单价（每百万 token，按 currency）。10-01 查官方价格页：
 * - DeepSeek：api-docs.deepseek.com/zh-cn/quick_start/pricing（有高峰/空闲两档，空闲为高峰的一半）。这里存高峰价，
 *   推算时按调用时刻折算（见 deepseekPeakFactor：北京时间周一至周五 9-12、14-18 为高峰，其余按一半）。
 *   中国法定节假日全天按空闲价（见 DEEPSEEK_OFFPEAK_DAYS）。
 * - 智谱：docs.bigmodel.cn/cn/guide/start/pricing（GLM-5.2 不分档）
 * - 通义：help.aliyun.com/zh/model-studio/qwen-flash-character（北京地域）
 * - 小米 MiMo：mimo.mi.com/docs/zh-CN/price/pay-as-you-go（国内，api.xiaomimimo.com）
 * - xAI：GET https://api.x.ai/v1/language-models（价格字段 ÷ 10000 = 美元/百万 token），与 docs.x.ai/docs/models 一致
 * - 豆包 doubao-seed-character、Kimi k3：官方页拿不到确切单价，留空。
 * 键：`主机 模型ID`。
 */
export const PRICE_PRESETS = {
  'api.deepseek.com deepseek-flash': { currency: 'CNY', price_in: 2, price_in_cached: 0.04, price_out: 8 },
  'api.deepseek.com deepseek-v4-pro': { currency: 'CNY', price_in: 9, price_in_cached: 0.3, price_out: 27 },
  'open.bigmodel.cn glm-5.2': { currency: 'CNY', price_in: 8, price_in_cached: 2, price_out: 28 },
  'dashscope.aliyuncs.com qwen-flash-character': { currency: 'CNY', price_in: 0.25, price_in_cached: 0.05, price_out: 1.5 },
  'api.xiaomimimo.com mimo-v2.6-flash': { currency: 'CNY', price_in: 1, price_in_cached: 0.02, price_out: 2 },
  'api.x.ai grok-4.20-0309-non-reasoning': { currency: 'USD', price_in: 1.25, price_in_cached: 0.2, price_out: 2.5 },
  'api.x.ai grok-4.20-0309-reasoning': { currency: 'USD', price_in: 1.25, price_in_cached: 0.2, price_out: 2.5 },
  'api.x.ai grok-4.7': { currency: 'USD', price_in: 2, price_in_cached: 0.5, price_out: 6 },
};

export const hostOfUrl = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
export const isXaiUrl = (u) => hostOfUrl(u) === 'api.x.ai';

/**
 * DeepSeek 分时计价（官方价格页 10-01）：北京时间（UTC+8）周一至周五 9:00-12:00、14:00-18:00 为高峰价，
 * 其余时段（工作日早晚、凌晨、周末、中国法定节假日全天）为高峰价的一半。
 * 调休上班的周六周日官方仍算周末（空闲），不特别处理。
 */
export const DEEPSEEK_OFFPEAK_RATIO = 0.5;
const BJ_OFFSET_MS = 8 * 3600 * 1000;
/**
 * 中国法定节假日放假日（北京日期 YYYY-MM-DD），按国务院办公厅 2026 年放假安排。
 * 每年底国务院公布次年安排后在这里补上；未列入的年份节假日按工作日算（会偏高）。
 */
const dayRange = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(from + "T00:00:00Z") + i * 86400000).toISOString().slice(0, 10));
export const DEEPSEEK_OFFPEAK_DAYS = new Set([
  ...dayRange("2026-01-01", 3), // 元旦 01-01 至 01-03
  ...dayRange("2026-02-15", 9), // 春节 02-15 至 02-23
  ...dayRange("2026-04-04", 3), // 清明 04-04 至 04-06
  ...dayRange("2026-05-01", 5), // 劳动节 05-01 至 05-05
  ...dayRange("2026-06-19", 3), // 端午 06-19 至 06-21
  ...dayRange("2026-09-25", 3), // 中秋 09-25 至 09-27
  ...dayRange("2026-10-01", 7), // 国庆 10-01 至 10-07
]);
export const isDeepseekUrl = (u) => hostOfUrl(u) === 'api.deepseek.com';

/** 北京时间 at 是否在 DeepSeek 高峰时段。at 可为 Date / ISO 字符串 / 毫秒；无效时按当前时间。 */
export function isDeepseekPeak(at) {
  let t = at instanceof Date ? at.getTime() : (typeof at === 'number' ? at : Date.parse(at ?? ''));
  if (!Number.isFinite(t)) t = Date.now();
  const d = new Date(t + BJ_OFFSET_MS); // 用 UTC 访问器读出北京时间
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  if (DEEPSEEK_OFFPEAK_DAYS.has(d.toISOString().slice(0, 10))) return false; // 法定节假日全天空闲
  const h = d.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/** 该模型在 at 时刻的单价系数：DeepSeek 空闲时段 0.5，其余 1。 */
export function priceFactorAt(baseUrl, at) {
  if (!isDeepseekUrl(baseUrl)) return 1;
  return isDeepseekPeak(at) ? 1 : DEEPSEEK_OFFPEAK_RATIO;
}

/** 模型行（base_url + model）对应的预置单价；没有返回 null。 */
export function presetPriceFor(baseUrl, model) {
  return PRICE_PRESETS[`${hostOfUrl(baseUrl)} ${String(model || '')}`] || null;
}

const nonNeg = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0; };

/**
 * 解析 OpenAI 兼容 usage（各家字段）：
 * - 输入/输出：prompt_tokens / completion_tokens（兼容 input_tokens / output_tokens）
 * - 缓存命中：DeepSeek prompt_cache_hit_tokens；OpenAI / xAI / 通义 / 豆包 / 智谱 prompt_tokens_details.cached_tokens；Kimi 顶层 cached_tokens
 * - 思考：completion_tokens_details.reasoning_tokens（兼容 output_tokens_details）
 * - 实价：xAI cost_in_usd_ticks
 * 返回 null 表示没有 usage。
 */
export function parseUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const tokens_in = nonNeg(u.prompt_tokens ?? u.input_tokens);
  const tokens_out = nonNeg(u.completion_tokens ?? u.output_tokens);
  const cachedRaw = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? u.cached_tokens;
  const tokens_in_cached = Math.min(nonNeg(cachedRaw), tokens_in);
  const tokens_reasoning = nonNeg(u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens);
  const t = u.cost_in_usd_ticks;
  const cost_ticks = (typeof t === 'number' || (typeof t === 'string' && /^\d+$/.test(t))) && Number.isFinite(Number(t)) && Number(t) >= 0 ? Number(t) : null;
  return { tokens_in, tokens_in_cached, tokens_out, tokens_reasoning, cost_ticks };
}

/** ticks → 美元。 */
export const ticksToUsd = (ticks) => Number(ticks) * USD_PER_TICK;

/**
 * 思考 token 是否在 completion_tokens 之外另计：
 * xAI 实测 completion_tokens=7、reasoning_tokens=57（另计，按输出价计费）；OpenAI 式 completion_tokens 已含思考。
 * 规则：api.x.ai 一律另计；其他家只有 reasoning > completion 时（显然不可能被包含）才另计。
 */
export function reasoningBilledSeparately(baseUrl, usage) {
  if (isXaiUrl(baseUrl)) return true;
  return (usage?.tokens_reasoning || 0) > (usage?.tokens_out || 0);
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** 模型有没有可用的单价（输入、输出两档必填；缓存档可空，空就按输入价）。 */
export function hasPrice(m) {
  const pi = num(m?.price_in), po = num(m?.price_out);
  return Number.isFinite(pi) && pi >= 0 && Number.isFinite(po) && po >= 0 && pi !== null && po !== null;
}

/**
 * 按单价推算（美元）：(未命中输入×price_in + 命中×(price_in_cached ?? price_in) + 计费输出×price_out)/1e6，CNY 乘汇率。
 * 计费输出 = completion_tokens（+ 另计的思考 token）。没有单价返回 null。
 * at：计费时刻（消息 created_at；省略 = 当前时间），DeepSeek 按时段折算（priceFactorAt）。
 */
export function estimateUsd(m, usage, cnyToUsd = DEFAULT_CNY_TO_USD, at = undefined) {
  if (!hasPrice(m) || !usage) return null;
  const pi = num(m.price_in), po = num(m.price_out);
  const pc = num(m.price_in_cached);
  const cachedPrice = Number.isFinite(pc) && pc !== null && pc >= 0 ? pc : pi;
  const cached = Math.min(usage.tokens_in_cached || 0, usage.tokens_in || 0);
  const miss = (usage.tokens_in || 0) - cached;
  const out = (usage.tokens_out || 0) + (reasoningBilledSeparately(m.base_url, usage) ? (usage.tokens_reasoning || 0) : 0);
  let v = ((miss * pi + cached * cachedPrice + out * po) / 1e6) * priceFactorAt(m.base_url, at);
  if (String(m.currency || 'USD').toUpperCase() === 'CNY') {
    const r = Number(cnyToUsd);
    v *= Number.isFinite(r) && r > 0 ? r : DEFAULT_CNY_TO_USD;
  }
  return v;
}

/**
 * 一次调用的费用：上游给了 ticks → upstream；否则按单价 → estimate；都没有 → null。
 * usageEstimated=true 时（token 是按字数粗估的）一律标 estimate，不会是 upstream。
 */
export function costOf(m, usage, { cnyToUsd = DEFAULT_CNY_TO_USD, usageEstimated = false, at } = {}) {
  if (!usage) return { cost_usd: null, cost_source: null };
  if (!usageEstimated && usage.cost_ticks !== null && usage.cost_ticks !== undefined) {
    return { cost_usd: roundUsd(ticksToUsd(usage.cost_ticks)), cost_source: 'upstream' };
  }
  const v = estimateUsd(m, usage, cnyToUsd, at);
  if (v === null || !Number.isFinite(v)) return { cost_usd: null, cost_source: null };
  return { cost_usd: roundUsd(v), cost_source: 'estimate' };
}

/** 存库精度：1e-10（= 1 tick）。 */
export const roundUsd = (v) => Math.round(Number(v) * 1e10) / 1e10;
/** 对外合计精度：$0.000001（契约 §10.3）。 */
export const round6 = (v) => Math.round(Number(v || 0) * 1e6) / 1e6;

/** 粗估 token：中文（及日韩）1 字 ≈ 1 token，其余 4 字符 ≈ 1 token。 */
export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  const rest = s.length - cjk;
  return cjk + Math.ceil(Math.max(0, rest) / 4);
}

/** xAI /language-models 的价格字段（÷10000 = 美元/百万 token）→ 单价。找不到该模型返回 null。 */
export function xaiPriceFromList(list, modelId) {
  const items = Array.isArray(list?.models) ? list.models : Array.isArray(list?.data) ? list.data : Array.isArray(list) ? list : [];
  const id = String(modelId || '');
  const hit = items.find((x) => x?.id === id) || items.find((x) => Array.isArray(x?.aliases) && x.aliases.includes(id));
  if (!hit) return null;
  const conv = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round((n / 10000) * 1e6) / 1e6 : null; };
  const price_in = conv(hit.prompt_text_token_price);
  const price_out = conv(hit.completion_text_token_price);
  if (price_in === null || price_out === null) return null;
  return { currency: 'USD', price_in, price_in_cached: conv(hit.cached_prompt_text_token_price), price_out, matched_id: hit.id };
}
