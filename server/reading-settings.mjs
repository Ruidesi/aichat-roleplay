// 用户阅读设定：落库只存白名单值，返回完整且安全的对象。
import { HttpError } from './util.mjs';

export const READING_DEFAULTS = Object.freeze({
  font_scale: 1,
  font_size: 16,
  font_family: 'system',
  font_weight: 400,
  line_height: 1.6,
  letter_spacing: 0,
});

const finiteBetween = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const RULES = {
  font_scale: { valid: (v) => finiteBetween(v, 0.85, 1.3), error: '字体比例须为 0.85 至 1.3 的数字' },
  font_size: { valid: (v) => Number.isInteger(v) && v >= 14 && v <= 28, error: '字号须为 14 至 28 的整数' },
  font_family: { valid: (v) => ['system', 'sans', 'serif', 'mono'].includes(v), error: '字体须选择系统、无衬线、衬线或等宽字体' },
  font_weight: { valid: (v) => [400, 500, 600].includes(v), error: '字重须为 400、500 或 600' },
  line_height: { valid: (v) => finiteBetween(v, 1.2, 2.4), error: '行高须为 1.2 至 2.4 的数字' },
  letter_spacing: { valid: (v) => finiteBetween(v, -0.5, 2), error: '字间距须为 -0.5 至 2 的数字' },
};

/** 旧账号、损坏 JSON 与非法单项均安全回落；未知字段不进入客户端。 */
export function readingSettingsFromJson(raw) {
  let saved = null;
  try { if (typeof raw === 'string') saved = JSON.parse(raw); } catch { /* 损坏的旧值使用默认值 */ }
  const out = { ...READING_DEFAULTS };
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out;
  for (const key of Object.keys(READING_DEFAULTS)) {
    if (Object.hasOwn(saved, key) && RULES[key].valid(saved[key])) out[key] = saved[key];
  }
  return out;
}

/** PATCH 任意合法子集合并当前值；null 完整重置；验证全部成功后才可写库。 */
export function mergeReadingSettings(raw, patch) {
  if (patch === null) return { ...READING_DEFAULTS };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, '阅读设定须为对象或 null');
  const out = readingSettingsFromJson(raw);
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(RULES, key)) throw new HttpError(400, '阅读设定包含不支持的参数');
    if (!RULES[key].valid(patch[key])) throw new HttpError(400, RULES[key].error);
    out[key] = patch[key];
  }
  return out;
}
