// v0.4 计费与代理地址（契约 §10）：计价公式、各家 usage 解析、ticks 换算、CNY 换算、代理 URL 校验、粗估 token、xAI 价格表换算。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUsage, ticksToUsd, estimateUsd, costOf, estimateTokens, xaiPriceFromList, presetPriceFor, reasoningBilledSeparately,
  hasPrice, round6, roundUsd, PRICE_PRESETS, USD_PER_TICK, isDeepseekPeak, priceFactorAt, DEEPSEEK_OFFPEAK_RATIO,
} from '../server/pricing.mjs';
import { checkProxyUrl, DEFAULT_PROXY_URL } from '../server/proxy.mjs';
import { parsePrice } from '../server/models.mjs';
import { HttpError } from '../server/util.mjs';

const near = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('ticks 换算：1 tick = 1e-10 美元；契约实测 1206000 ticks ≈ $0.0001206', () => {
  assert.equal(USD_PER_TICK, 1e-10);
  near(ticksToUsd(1206000), 0.0001206);
  near(ticksToUsd(1e10), 1);
  // 同一次调用按 grok-4.20 单价推算应与上游实价一致：192 输入（128 缓存）+ 6 输出
  const grok = { base_url: 'https://api.x.ai/v1', currency: 'USD', ...PRICE_PRESETS['api.x.ai grok-4.20-0309-non-reasoning'] };
  near(estimateUsd(grok, { tokens_in: 192, tokens_in_cached: 128, tokens_out: 6, tokens_reasoning: 0 }), 0.0001206);
});

test('usage 解析：DeepSeek / OpenAI 式 / xAI / Kimi / 无 usage', () => {
  // DeepSeek：prompt_cache_hit_tokens
  assert.deepEqual(parseUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, total_tokens: 1050 }),
    { tokens_in: 1000, tokens_in_cached: 800, tokens_out: 50, tokens_reasoning: 0, cost_ticks: null });
  // OpenAI / 通义 / 豆包 / 智谱：prompt_tokens_details.cached_tokens + completion_tokens_details.reasoning_tokens
  assert.deepEqual(parseUsage({ prompt_tokens: 300, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 80 } }),
    { tokens_in: 300, tokens_in_cached: 100, tokens_out: 120, tokens_reasoning: 80, cost_ticks: null });
  // xAI：同上 + cost_in_usd_ticks（思考 token 不含在 completion_tokens 里）
  assert.deepEqual(parseUsage({ prompt_tokens: 192, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 128 }, completion_tokens_details: { reasoning_tokens: 57 }, cost_in_usd_ticks: 1206000 }),
    { tokens_in: 192, tokens_in_cached: 128, tokens_out: 7, tokens_reasoning: 57, cost_ticks: 1206000 });
  // Kimi：顶层 cached_tokens
  assert.equal(parseUsage({ prompt_tokens: 50, completion_tokens: 5, cached_tokens: 20 }).tokens_in_cached, 20);
  // 缓存数不能超过输入数；负数 / 非数字当 0；ticks 非法当 null
  const odd = parseUsage({ prompt_tokens: 10, completion_tokens: -3, prompt_cache_hit_tokens: 99, cost_in_usd_ticks: 'x' });
  assert.deepEqual(odd, { tokens_in: 10, tokens_in_cached: 10, tokens_out: 0, tokens_reasoning: 0, cost_ticks: null });
  assert.equal(parseUsage({ prompt_tokens: 1, completion_tokens: 1, cost_in_usd_ticks: '123' }).cost_ticks, 123);
  assert.equal(parseUsage(null), null);
  assert.equal(parseUsage('x'), null);
});

test('计价公式：未命中×输入价 + 命中×缓存价 + 输出×输出价；缓存价空就按输入价；没单价返回 null', () => {
  const m = { base_url: 'https://api.example.com/v1', currency: 'USD', price_in: 2, price_in_cached: 0.5, price_out: 6 };
  // (700×2 + 300×0.5 + 100×6)/1e6 = (1400+150+600)/1e6
  near(estimateUsd(m, { tokens_in: 1000, tokens_in_cached: 300, tokens_out: 100 }), 2150 / 1e6);
  near(estimateUsd({ ...m, price_in_cached: null }, { tokens_in: 1000, tokens_in_cached: 300, tokens_out: 100 }), (1000 * 2 + 100 * 6) / 1e6);
  assert.equal(estimateUsd({ ...m, price_in: null }, { tokens_in: 1, tokens_out: 1 }), null);
  assert.equal(estimateUsd({ ...m, price_out: null }, { tokens_in: 1, tokens_out: 1 }), null);
  assert.equal(hasPrice({ price_in: 0, price_out: 0 }), true, '0 元是合法单价（免费模型）');
  assert.equal(hasPrice({}), false);
});

test('CNY 换算：人民币单价 × 汇率；汇率非法时回落 0.14', () => {
  const ds = { base_url: 'https://api.deepseek.com', currency: 'CNY', price_in: 2, price_in_cached: 0.04, price_out: 8 };
  const u = { tokens_in: 1000, tokens_in_cached: 600, tokens_out: 200 };
  const cny = (400 * 2 + 600 * 0.04 + 200 * 8) / 1e6;
  const peak = '2026-10-15T02:00:00.000Z'; // 北京周四 10:00（非节假日），DeepSeek 高峰
  near(estimateUsd(ds, u, 0.14, peak), cny * 0.14);
  near(estimateUsd(ds, u, 0.2, peak), cny * 0.2);
  near(estimateUsd(ds, u, -1, peak), cny * 0.14);
  near(estimateUsd(ds, u, 'abc', peak), cny * 0.14);
});

test('DeepSeek 分时：北京时间工作日 9-12、14-18 高峰价，其余（含周末、法定节假日、午休、晚上）半价；其他厂商不分时', () => {
  const ds = { base_url: 'https://api.deepseek.com', currency: 'CNY', price_in: 2, price_in_cached: 0.04, price_out: 8 };
  const u = { tokens_in: 3000, tokens_in_cached: 2000, tokens_out: 200 };
  const full = ((1000 * 2 + 2000 * 0.04 + 200 * 8) / 1e6) * 0.14; // = $0.0005152
  near(full, 0.0005152);
  // 北京时间 = UTC+8
  const bj = (s) => new Date(`${s}+08:00`).toISOString();
  assert.equal(isDeepseekPeak(bj('2026-10-15T09:00:00')), true, '周四 9:00');
  assert.equal(isDeepseekPeak(bj('2026-10-15T11:59:59')), true);
  assert.equal(isDeepseekPeak(bj('2026-10-15T12:00:00')), false, '午休');
  assert.equal(isDeepseekPeak(bj('2026-10-15T14:00:00')), true);
  assert.equal(isDeepseekPeak(bj('2026-10-15T18:00:00')), false, '傍晚');
  assert.equal(isDeepseekPeak(bj('2026-10-15T08:59:59')), false);
  assert.equal(isDeepseekPeak(bj('2026-10-16T10:00:00')), true, '周五');
  assert.equal(isDeepseekPeak(bj('2026-10-17T10:00:00')), false, '周六');
  assert.equal(isDeepseekPeak(bj('2026-10-18T15:00:00')), false, '周日');
  near(estimateUsd(ds, u, 0.14, bj('2026-10-15T10:00:00')), full);
  near(estimateUsd(ds, u, 0.14, bj('2026-10-17T21:00:00')), full / 2); // 周六晚上 $0.0002576
  near(costOf(ds, { ...u, tokens_reasoning: 0, cost_ticks: null }, { at: bj('2026-10-15T03:00:00') }).cost_usd, full / 2);
  // 中国法定节假日全天空闲：国庆 10-01（周四）10:00 = 2026-10-01T02:00Z，系数 0.5
  assert.equal(isDeepseekPeak("2026-10-01T02:00:00Z"), false, "国庆");
  assert.equal(priceFactorAt("https://api.deepseek.com", "2026-10-01T02:00:00Z"), 0.5);
  assert.equal(isDeepseekPeak(bj("2026-10-07T15:00:00")), false, "国庆最后一天");
  assert.equal(isDeepseekPeak(bj("2026-10-08T10:00:00")), true, "节后周四恢复高峰");
  assert.equal(isDeepseekPeak(bj("2026-02-16T10:00:00")), false, "春节");
  near(estimateUsd(ds, u, 0.14, bj("2026-10-01T10:00:00")), full / 2);
  assert.equal(priceFactorAt('https://api.deepseek.com/v1', bj('2026-10-03T10:00:00')), DEEPSEEK_OFFPEAK_RATIO);
  // 其他厂商不分时
  const glm = { base_url: 'https://open.bigmodel.cn/api/paas/v4', currency: 'CNY', price_in: 8, price_out: 28 };
  near(estimateUsd(glm, u, 0.14, bj('2026-10-03T21:00:00')), estimateUsd(glm, u, 0.14, bj('2026-10-01T10:00:00')));
  assert.equal(priceFactorAt('https://api.x.ai/v1', bj('2026-10-03T21:00:00')), 1);
  // 上游实价不受分时影响
  assert.equal(costOf(ds, { ...u, tokens_reasoning: 0, cost_ticks: 1206000 }, { at: bj('2026-10-03T21:00:00') }).cost_source, 'upstream');
});

test('思考 token：xAI 另计并按输出价计费；OpenAI 式已含在 completion_tokens 里不重复算', () => {
  const xai = { base_url: 'https://api.x.ai/v1', currency: 'USD', price_in: 2, price_in_cached: 0.5, price_out: 6 };
  const u = { tokens_in: 100, tokens_in_cached: 0, tokens_out: 7, tokens_reasoning: 57 };
  assert.equal(reasoningBilledSeparately(xai.base_url, u), true);
  near(estimateUsd(xai, u), (100 * 2 + (7 + 57) * 6) / 1e6);
  const oai = { ...xai, base_url: 'https://api.openai-like.example.com/v1' };
  const u2 = { tokens_in: 100, tokens_in_cached: 0, tokens_out: 120, tokens_reasoning: 80 };
  assert.equal(reasoningBilledSeparately(oai.base_url, u2), false);
  near(estimateUsd(oai, u2), (100 * 2 + 120 * 6) / 1e6);
  // 别家思考数大于 completion：显然另计
  assert.equal(reasoningBilledSeparately(oai.base_url, { tokens_out: 5, tokens_reasoning: 50 }), true);
});

test('costOf：有 ticks → upstream；否则有单价 → estimate；都没有 → null；粗估的 token 不会标 upstream', () => {
  const m = { base_url: 'https://api.x.ai/v1', currency: 'USD', price_in: 1.25, price_in_cached: 0.2, price_out: 2.5 };
  const u = { tokens_in: 192, tokens_in_cached: 128, tokens_out: 6, tokens_reasoning: 0, cost_ticks: 1206000 };
  assert.deepEqual(costOf(m, u), { cost_usd: 0.0001206, cost_source: 'upstream' });
  assert.deepEqual(costOf({}, u), { cost_usd: 0.0001206, cost_source: 'upstream' }, '有实价时不需要单价');
  const e = costOf(m, { ...u, cost_ticks: null });
  assert.equal(e.cost_source, 'estimate');
  near(e.cost_usd, 0.0001206);
  assert.equal(costOf(m, u, { usageEstimated: true }).cost_source, 'estimate');
  assert.deepEqual(costOf({ base_url: 'https://x.example.com' }, { ...u, cost_ticks: null }), { cost_usd: null, cost_source: null });
  assert.deepEqual(costOf(m, null), { cost_usd: null, cost_source: null });
  assert.equal(roundUsd(0.00012345678912345), 0.0001234568);
  assert.equal(round6(0.0001234), 0.000123);
  assert.equal(round6(null), 0);
});

test('粗估 token：中文 1 字 ≈ 1 token，英文 4 字符 ≈ 1 token', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('你好世界'), 4);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('*微笑* hi'), 2 + Math.ceil(5 / 4));
  assert.equal(estimateTokens(null), 0);
});

test('预置单价表：按 主机+模型ID 匹配；DeepSeek 为人民币；xAI 与 /language-models 一致', () => {
  assert.deepEqual(presetPriceFor('https://api.deepseek.com', 'deepseek-flash'), { currency: 'CNY', price_in: 2, price_in_cached: 0.04, price_out: 8 });
  assert.equal(presetPriceFor('https://api.deepseek.com/v1', 'deepseek-v4-pro').price_out, 27);
  assert.deepEqual(presetPriceFor('https://api.x.ai/v1', 'grok-4.7'), { currency: 'USD', price_in: 2, price_in_cached: 0.5, price_out: 6 });
  assert.equal(presetPriceFor('https://evil.example.com', 'deepseek-flash'), null, '换了主机不认');
  assert.equal(presetPriceFor('https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-character-260628'), null, '豆包官方价查不到，留空');
});

test('xAI /language-models 换算：价格字段 ÷ 10000 = 美元/百万 token；按 id 或别名匹配', () => {
  const list = { models: [
    { id: 'grok-4.20-0309-non-reasoning', aliases: ['grok-4.20-non-reasoning'], prompt_text_token_price: 12500, cached_prompt_text_token_price: 2000, completion_text_token_price: 25000 },
    { id: 'grok-4.7', aliases: [], prompt_text_token_price: 20000, cached_prompt_text_token_price: 5000, completion_text_token_price: 60000 },
  ] };
  assert.deepEqual(xaiPriceFromList(list, 'grok-4.7'), { currency: 'USD', price_in: 2, price_in_cached: 0.5, price_out: 6, matched_id: 'grok-4.7' });
  assert.deepEqual(xaiPriceFromList(list, 'grok-4.20-non-reasoning'), { currency: 'USD', price_in: 1.25, price_in_cached: 0.2, price_out: 2.5, matched_id: 'grok-4.20-0309-non-reasoning' });
  assert.equal(xaiPriceFromList(list, 'grok-x'), null);
  assert.equal(xaiPriceFromList({}, 'grok-4.7'), null);
  assert.equal(xaiPriceFromList({ models: [{ id: 'g', prompt_text_token_price: 'x', completion_text_token_price: 1 }] }, 'g'), null);
});

test('代理地址校验：只许 http://127.0.0.1:端口 或 http://localhost:端口', () => {
  assert.equal(DEFAULT_PROXY_URL, 'http://127.0.0.1:42001');
  assert.equal(checkProxyUrl('http://127.0.0.1:42001'), 'http://127.0.0.1:42001');
  assert.equal(checkProxyUrl(' http://localhost:8080/ '), 'http://localhost:8080');
  assert.equal(checkProxyUrl('http://LOCALHOST:80'), 'http://localhost:80');
  assert.equal(checkProxyUrl(''), null);
  assert.equal(checkProxyUrl(null), null);
  assert.equal(checkProxyUrl(undefined), null);
  for (const bad of ['https://127.0.0.1:42001', 'http://10.0.0.1:3128', 'http://proxy.example.com:3128', 'http://127.0.0.1', 'http://localhost',
    'http://127.0.0.2:42001', 'http://[::1]:42001', 'socks5://127.0.0.1:1080', 'http://u:p@127.0.0.1:42001', 'http://127.0.0.1:42001/x',
    'http://127.0.0.1:42001?a=1', 'http://127.0.0.1:0', 'http://127.0.0.1:70000', 'http://0x7f000001:42001', 'garbage']) {
    assert.throws(() => checkProxyUrl(bad), HttpError, bad);
  }
});

test('单价输入：空 = null；非负数字；字符串数字可以；其他 400', () => {
  assert.equal(parsePrice(null), null);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice(0), 0);
  assert.equal(parsePrice('1.25'), 1.25);
  for (const bad of [-1, 'abc', '1e3', Infinity, NaN, 1e9, {}, true]) assert.throws(() => parsePrice(bad), HttpError, String(bad));
});
