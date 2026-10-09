// 提示词组装（契约 §5「提示词组装」）。纯函数，便于单元测试。

export const DEFAULT_SYSTEM = '你正在进行沉浸式角色扮演。你扮演 {{char}}，与 {{user}} 对话。请完全代入角色，按照下面的设定自然地回应。';
export const LANGUAGE_RULE = '始终使用简体中文回复，保持角色口吻；不要替用户说话或行动；用 *星号* 描述动作。';
// 契约 §18.1：语音输入整理出的「（动作）说道：台词」格式。
export const BRACKET_RULE = '用户消息中全角括号（…）内是用户角色的动作与神态，括号外是说出口的话。';
// 硬性底线（契约 §8.4）：不论模型、不论 nsfw 开关都加。
export const SAFETY_RULE = '所有角色及情节中的人物均为成年人；任何涉及未成年人的性内容一律拒绝，并以角色口吻自然转开话题。';
// 剧情卡（契约 §12.1）：角色名当作「叙述者」口吻。
export const DEFAULT_SYSTEM_SCENARIO = '你正在主持一场沉浸式互动故事「{{char}}」，与 {{user}} 一起推进剧情。请按照下面的世界与剧情设定自然地叙述与回应。';
export const NARRATOR_RULE = '你是这个故事的叙述者与所有 NPC 的扮演者。';
export const EXAMPLE_MAX_CHARS = 2000;
export const HISTORY_MAX_CHARS = 24000;

/** 宏替换：{{char}}/<BOT> → 角色名，{{user}}/<USER> → 用户称呼（不区分大小写）。 */
export function applyMacros(text, { char = '', user = '' } = {}) {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/\{\{\s*char\s*\}\}/gi, () => char)
    .replace(/<BOT>/gi, () => char)
    .replace(/\{\{\s*user\s*\}\}/gi, () => user)
    .replace(/<USER>/gi, () => user)
    .replace(/\{\{\s*original\s*\}\}/gi, '');
}

/** 用户在聊天中的称呼：persona_name 优先，其次 display_name，再次 username。 */
export function userCallName(user) {
  return String(user?.persona_name || user?.display_name || user?.username || '用户').trim() || '用户';
}

export function truncate(s, max) {
  const t = String(s || '');
  return t.length > max ? t.slice(0, max) + '……' : t;
}

/**
 * 组装发给模型的 messages。
 * @param {object} p
 * @param {object} p.definition  chub 的 definition（card_json）
 * @param {string} p.charName
 * @param {object} p.user        users 行
 * @param {{role:string,content:string}[]} p.history  按时间正序，最后一条通常是用户消息
 * @param {'character'|'scenario'} [p.kind]  剧情卡按叙述者口吻
 * @param {string[]} [p.lore]  世界书命中的条目内容（已按 insertion_order 排好、已做宏替换），注入「相关设定」段
 */
export function buildMessages({ definition = {}, charName = '', user = {}, history = [], kind = 'character', lore = [] }) {
  const d = definition || {};
  const name = userCallName(user);
  const m = (t) => applyMacros(t, { char: charName, user: name }).trim();

  const scenario = kind === 'scenario';
  const parts = [];
  parts.push(m(d.system_prompt) || m(scenario ? DEFAULT_SYSTEM_SCENARIO : DEFAULT_SYSTEM));
  if (scenario) {
    parts.push(NARRATOR_RULE);
    parts.push(`【故事】${charName}`);
    if (m(d.personality)) parts.push(`【世界与剧情设定】\n${m(d.personality)}`);
    if (m(d.tavern_personality)) parts.push(`【叙述风格】\n${m(d.tavern_personality)}`);
  } else {
    parts.push(`【角色】${charName}`);
    if (m(d.personality)) parts.push(`【角色描述】\n${m(d.personality)}`);
    if (m(d.tavern_personality)) parts.push(`【性格】\n${m(d.tavern_personality)}`);
  }
  if (m(d.scenario)) parts.push(`【场景】\n${m(d.scenario)}`);
  const loreText = (Array.isArray(lore) ? lore : []).map((t) => String(t || '').trim()).filter(Boolean);
  if (loreText.length) parts.push(`【相关设定】\n${loreText.join('\n\n')}`);
  const personaDesc = m(user?.persona_desc);
  parts.push(`【用户】你对面的用户称呼是「${name}」。${personaDesc ? `\n${personaDesc}` : ''}`);
  const ex = m(d.example_dialogs);
  if (ex) parts.push(`【示例对话（仅供参考语气）】\n${truncate(ex, EXAMPLE_MAX_CHARS)}`);
  parts.push(`【语言与格式规则】${LANGUAGE_RULE}${BRACKET_RULE}`);
  parts.push(`【硬性底线】${SAFETY_RULE}`);
  const system = parts.join('\n\n');

  // 历史从新往旧装，总长约 HISTORY_MAX_CHARS 截断；至少保留最后一条。
  const picked = [];
  let total = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    const content = m(h.content);
    if (picked.length > 0 && total + content.length > HISTORY_MAX_CHARS) break;
    total += content.length;
    picked.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content });
  }
  picked.reverse();

  const messages = [{ role: 'system', content: system }, ...picked];
  const phi = m(d.post_history_instructions);
  if (phi) messages.push({ role: 'system', content: phi });
  return messages;
}
