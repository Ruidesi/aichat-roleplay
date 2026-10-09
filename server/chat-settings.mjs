// 本会话设定（契约 §20.1）：中途改人物的一切信息，只影响这个会话、从下一条回复起生效。
// chats.card_override_json 只存与原卡不同的字段（同构于 V2 data），persona_override_json 存本会话专用的称呼与人设。
// 提示词组装时：原卡（中文优先）→ 叠加 override。纯函数为主，HTTP 与权限在 app.mjs。
import { HttpError } from './util.mjs';
import { normalizeCardData, normalizeLorebook, LIMITS as CARD_LIMITS } from './cards.mjs';

/** 能改的字段（V2 data 命名）与中文名。开场白属于已发生的对话，不在这里改。 */
export const OVERRIDE_FIELDS = ['name', 'description', 'personality', 'scenario', 'mes_example', 'system_prompt', 'post_history_instructions', 'character_book'];
export const OVERRIDE_LABELS = {
  name: '名字', description: '人物描述', personality: '性格', scenario: '场景', mes_example: '对话示例',
  system_prompt: '系统提示', post_history_instructions: '历史后提示', character_book: '世界书',
  instruction: '一句话说明', persona_name: '我的称呼', persona_desc: '我的人设',
};
/** 文件会话（契约 §17）能改的：一句话说明与资料以外的规则（附加系统提示 / 历史后提示）。 */
export const FILE_OVERRIDE_FIELDS = ['instruction', 'system_prompt', 'post_history_instructions'];
export const PERSONA_NAME_MAX = 40;
export const PERSONA_DESC_MAX = 2000;
export const INSTRUCTION_MAX = 2000;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const parse = (s) => { try { const v = s ? JSON.parse(s) : null; return isObj(v) ? v : null; } catch { return null; } };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** V2 data（+ name）→ 只取可改字段，空串 / null 规范化。 */
export function pickFields(data, fields = OVERRIDE_FIELDS) {
  const out = {};
  for (const k of fields) {
    if (k === 'character_book') out[k] = data?.character_book ? normalizeLorebook(data.character_book) : null;
    else out[k] = typeof data?.[k] === 'string' ? data[k] : '';
  }
  return out;
}

/**
 * 用户提交的设定 → 只存与 base 不同的字段（契约「只存与原卡不同的字段」）。
 * input 里没给的字段视为不改（等于 base）。超长回 400（与编辑自建卡同一套上限）。
 * @returns {object|null} override（没有差异时 null）
 */
export function diffOverride(base, input, { fields = OVERRIDE_FIELDS } = {}) {
  if (input === null || input === undefined) return null;
  if (!isObj(input)) throw new HttpError(400, '设定格式不正确');
  const out = {};
  for (const k of fields) {
    if (input[k] === undefined) continue;
    let v;
    if (k === 'name') {
      v = typeof input.name === 'string' ? input.name.trim() : '';
      if (!v) throw new HttpError(400, '名字不能为空');
      if (v.length > CARD_LIMITS.name) throw new HttpError(400, `名字太长，最多 ${CARD_LIMITS.name} 字`);
    } else if (k === 'instruction') {
      v = typeof input.instruction === 'string' ? input.instruction.replace(/\r\n/g, '\n').trim() : '';
      if (v.length > INSTRUCTION_MAX) throw new HttpError(400, `一句话说明太长，最多 ${INSTRUCTION_MAX} 字`);
    } else if (k === 'character_book') {
      v = normalizeCardData({ character_book: input.character_book }, { strict: true }).character_book;
    } else {
      v = normalizeCardData({ [k]: input[k] }, { strict: true })[k];
    }
    if (!same(v, base[k])) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** 叠加：base ← override（只覆盖 override 里有的字段）。 */
export function applyOverride(base, override) {
  const out = { ...base };
  if (isObj(override)) for (const [k, v] of Object.entries(override)) if (k in base || OVERRIDE_FIELDS.includes(k) || FILE_OVERRIDE_FIELDS.includes(k)) out[k] = v;
  return out;
}

/** override 叠到 chub 风格的 definition 上（提示词组装用 buildMessages 认的字段名）。 */
export function overrideDefinition(def, override) {
  const d = { ...(def || {}) };
  if (!isObj(override)) return d;
  const map = { description: 'personality', personality: 'tavern_personality', scenario: 'scenario', mes_example: 'example_dialogs', system_prompt: 'system_prompt', post_history_instructions: 'post_history_instructions' };
  for (const [k, dk] of Object.entries(map)) if (override[k] !== undefined) d[dk] = override[k];
  return d;
}

/** 本会话人设：{name, desc}，与默认（「我的」里的设置）相同则不存。 */
export function normalizePersona(input, defaults) {
  if (input === null || input === undefined) return null;
  if (!isObj(input)) throw new HttpError(400, '人设格式不正确');
  const name = typeof input.name === 'string' ? input.name.trim() : (defaults.name || '');
  const desc = typeof input.desc === 'string' ? input.desc.replace(/\r\n/g, '\n').trim() : (defaults.desc || '');
  if (name.length > PERSONA_NAME_MAX) throw new HttpError(400, `称呼太长，最多 ${PERSONA_NAME_MAX} 字`);
  if (desc.length > PERSONA_DESC_MAX) throw new HttpError(400, `人设太长，最多 ${PERSONA_DESC_MAX} 字`);
  if (name === (defaults.name || '') && desc === (defaults.desc || '')) return null;
  return { name, desc };
}

/** 用户的默认人设（「我的」）：称呼 = persona_name，没填时显示名。 */
export const personaDefaults = (user) => ({ name: String(user?.persona_name || '').trim(), desc: String(user?.persona_desc || '').trim(), display_name: user?.display_name || user?.username || '' });

/** 套上本会话人设后的「用户」（buildMessages 用 persona_name / persona_desc）。 */
export function userWithPersona(user, persona) {
  if (!isObj(persona)) return user;
  return { ...user, persona_name: persona.name || '', persona_desc: persona.desc || '' };
}

export const chatOverride = (c) => parse(c?.card_override_json);
export const chatPersona = (c) => parse(c?.persona_override_json);
