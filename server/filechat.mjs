// 上传文件快速开聊（契约 §17）：上传暂存、上下文策略（整份 / 检索）、零依赖 BM25、提示词组装、花费预估。
// 纯逻辑为主；HTTP、权限、计费落库在 app.mjs。
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './util.mjs';
import { applyMacros, userCallName, SAFETY_RULE, HISTORY_MAX_CHARS, truncate } from './prompt.mjs';
import { estimateTokens, estimateUsd, round6 } from './pricing.mjs';

export const FULL_MAX_CHARS = 150_000; // ≤ 15 万字：整份放进 system
export const CHUNK_CHARS = 1500;
export const CHUNK_OVERLAP = 150;
export const RETRIEVE_TOP = 20;
export const RETRIEVE_BUDGET_CHARS = 30_000;
export const HEAD_CHARS = 3000;
export const UPLOAD_TTL_MS = 60 * 60 * 1000; // upload_id 暂存 1 小时
export const UPLOADS_PER_USER = 3; // 每个账号最多同时保留几个还没用的 upload_id（新建时删掉最旧的）
export const INDEX_CACHE_SIZE = 10;
export const FILE_INSTRUCTION_MAX = 2000;
export const RETRIEVAL_NOTICE = '文件较大，AI 会按你的问题查阅相关段落';
const UPLOAD_ID_RE = /^[0-9a-f]{32}$/;

export const FILE_RULES = [
  '根据上面的资料与用户对话；资料里没有写到的内容，要明确说明这是你的推测。',
  '遵守「说明」里的玩法（例如扮演资料里的某个人物、当旁白带用户推进剧情，或者回答问题）；没有说明时，就把资料当背景自由对话。',
  '用户消息中全角括号（…）内是用户角色的动作与神态，括号外是说出口的话。',
  '用简体中文回复，除非用户用别的语言提问。',
];

export const modeFor = (chars) => (chars > FULL_MAX_CHARS ? 'retrieval' : 'full');

// ---------- 上传暂存（DATA_DIR/uploads/<id>.json，1 小时） ----------

export function createUploadStore(dir, { ttlMs = UPLOAD_TTL_MS, perUser = UPLOADS_PER_USER } = {}) {
  const fileOf = (id) => path.join(dir, `${id}.json`);
  const byUser = new Map(); // userId → [id…]（旧 → 新；只记本进程建的，重启后靠 1 小时过期清理）
  async function put(userId, parsed) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const id = randomBytes(16).toString('hex');
    const rec = { user_id: userId, created_at: Date.now(), files: parsed.files, text: parsed.text, total_chars: parsed.total_chars, truncated: !!parsed.truncated };
    await writeFile(fileOf(id), JSON.stringify(rec), { mode: 0o600 });
    const list = (byUser.get(userId) || []).filter((x) => x !== id);
    list.push(id);
    while (list.length > perUser) { const old = list.shift(); await rm(fileOf(old), { force: true }).catch(() => {}); }
    byUser.set(userId, list);
    return id;
  }
  /** 只认本人的、没过期的；其余一律 null。 */
  async function get(userId, id) {
    if (!UPLOAD_ID_RE.test(String(id || ''))) return null;
    let rec;
    try { rec = JSON.parse(await readFile(fileOf(id), 'utf8')); } catch { return null; }
    if (!rec || rec.user_id !== userId) return null;
    if (Date.now() - rec.created_at > ttlMs) { await rm(fileOf(id), { force: true }).catch(() => {}); return null; }
    return rec;
  }
  const remove = (id) => {
    if (!UPLOAD_ID_RE.test(String(id || ''))) return Promise.resolve();
    for (const [u, list] of byUser) { const i = list.indexOf(id); if (i >= 0) { list.splice(i, 1); if (!list.length) byUser.delete(u); break; } }
    return rm(fileOf(id), { force: true }).catch(() => {});
  };
  async function sweep() {
    let names = [];
    try { names = await readdir(dir); } catch { return 0; }
    let n = 0;
    for (const f of names) {
      if (!/^[0-9a-f]{32}\.json$/.test(f)) continue;
      try {
        const st = await stat(path.join(dir, f));
        if (Date.now() - st.mtimeMs > ttlMs) { await rm(path.join(dir, f), { force: true }); n += 1; }
      } catch { /* 并发删了 */ }
    }
    return n;
  }
  return { put, get, remove, sweep };
}

// ---------- 切块 ----------

/** 按段落切块（约 1500 字/块，块与块重叠 150 字）。 */
export function chunkText(text, { size = CHUNK_CHARS, overlap = CHUNK_OVERLAP } = {}) {
  const src = String(text || '');
  if (!src) return [];
  const paras = src.split(/\n/);
  const pieces = [];
  for (const p of paras) {
    if (p.length <= size) { pieces.push(p); continue; }
    for (let i = 0; i < p.length; i += size - overlap) pieces.push(p.slice(i, i + size));
  }
  const chunks = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && cur.length + 1 + p.length > size) {
      chunks.push(cur);
      const tail = cur.slice(-overlap);
      cur = tail + '\n' + p;
    } else {
      cur = cur ? `${cur}\n${p}` : p;
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.filter((c) => c.trim());
}

// ---------- BM25（中文二字切分 + 英文按词） ----------

const STOP = new Set(['the', 'and', 'of', 'to', 'a', 'in', 'is', 'it', 'that', 'for', 'on', 'was', 'with', 'as', 'at', 'be', 'this', 'are', 'by', 'or']);

/** 分词：连续汉字 → 二字切分（单字就单字）；字母数字 → 小写词（去掉极常见虚词）。 */
export function tokenize(text) {
  const out = [];
  const s = String(text || '').toLowerCase();
  for (const m of s.matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    if (/^\p{Script=Han}+$/u.test(w)) {
      const cs = [...w];
      if (cs.length === 1) out.push(cs[0]);
      else for (let i = 0; i < cs.length - 1; i++) out.push(cs[i] + cs[i + 1]);
    } else if (w.length >= 2 && !STOP.has(w)) out.push(w);
    else if (/^\d$/.test(w)) out.push(w);
  }
  return out;
}

export function buildIndex(chunks) {
  const docs = [];
  const df = new Map();
  let totalLen = 0;
  for (const c of chunks) {
    const toks = tokenize(c);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    docs.push({ tf, len: toks.length });
    totalLen += toks.length;
  }
  return { docs, df, n: docs.length, avgdl: docs.length ? totalLen / docs.length : 0 };
}

/** 返回按得分从高到低的 [{idx, score}]（只含得分 > 0 的）。 */
export function searchIndex(index, query, { top = RETRIEVE_TOP, k1 = 1.2, b = 0.75 } = {}) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !index.n) return [];
  const scores = [];
  for (let i = 0; i < index.docs.length; i++) {
    const d = index.docs[i];
    let s = 0;
    for (const t of terms) {
      const f = d.tf.get(t);
      if (!f) continue;
      const n = index.df.get(t) || 0;
      const idf = Math.log(1 + (index.n - n + 0.5) / (n + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / (index.avgdl || 1))));
    }
    if (s > 0) scores.push({ idx: i, score: s });
  }
  scores.sort((x, y) => y.score - x.score || x.idx - y.idx);
  return scores.slice(0, top);
}

/** 按 chat 缓存倒排索引（LRU，最多 10 个），懒加载。 */
export function createIndexCache({ size = INDEX_CACHE_SIZE } = {}) {
  const m = new Map();
  return {
    get(chatId, loadChunks) {
      if (m.has(chatId)) { const v = m.get(chatId); m.delete(chatId); m.set(chatId, v); return v; }
      const chunks = loadChunks();
      const v = { chunks, index: buildIndex(chunks) };
      m.set(chatId, v);
      while (m.size > size) m.delete(m.keys().next().value);
      return v;
    },
    drop(chatId) { m.delete(chatId); },
    get size() { return m.size; },
  };
}

/** 检索：返回按原文顺序排好的片段 [{idx, text}]，总长不超过 budget。 */
export function retrieve({ chunks, index }, query, { top = RETRIEVE_TOP, budget = RETRIEVE_BUDGET_CHARS } = {}) {
  const hits = searchIndex(index, query, { top });
  const picked = [];
  let used = 0;
  for (const h of hits) {
    const t = chunks[h.idx];
    if (used + t.length > budget && picked.length) continue;
    picked.push({ idx: h.idx, text: t });
    used += t.length;
  }
  return picked.sort((a, b) => a.idx - b.idx);
}

// ---------- 提示词 ----------

/** 首条 AI 消息 / 重新生成首条时附在最后的引导（不存库）。 */
export function kickoffText(instruction) {
  return instruction
    ? '（系统提示：用户刚上传了上面的资料，并给了「说明」。请先用一两句话简短确认你已读完资料，然后按说明直接开场。）'
    : '（系统提示：用户刚上传了上面的资料，没有给说明。请先用一句话概括资料的内容，然后问用户想聊什么。）';
}

/** 检索用的查询：最近 2 条用户消息 + 本条。 */
export function retrievalQuery(history, extra = '') {
  const users = history.filter((h) => h.role === 'user').slice(-3).map((h) => h.content);
  return [...users, extra].filter(Boolean).join('\n');
}

/**
 * 组装文件会话的 messages。system 顺序：开场说明 → 资料（整份或开头 + 相关片段）→ 说明（instruction）→ 对话规则 →
 * 附加系统提示 → 用户。整份模式的资料段在最前且逐字不变，便于上游前缀缓存。
 * @param {object} p
 * @param {{text:string, mode:'full'|'retrieval', files:object[], total_chars:number}} p.file
 * @param {{idx:number,text:string}[]} [p.snippets]  检索模式命中的片段
 * @param {object} p.settings  {instruction, system_prompt, post_history_instructions}（已叠加本会话设定）
 * @param {object} p.user
 * @param {{role:string,content:string}[]} p.history
 * @param {string} [p.extraUser]  附在最后、不存库的一条用户消息（首条引导）
 */
export function buildFileMessages({ file, snippets = [], settings = {}, user = {}, history = [], extraUser = '' }) {
  const name = userCallName(user);
  const m = (t) => applyMacros(t, { char: '资料助手', user: name }).trim();
  const names = (file.files || []).filter((f) => f.ok).map((f) => `《${f.name}》`).join('、');
  const parts = [`你正在与用户围绕他上传的资料${names ? ` ${names}` : ''}进行对话。`];
  if (file.mode === 'retrieval') {
    parts.push(`【资料说明】资料很长（共 ${file.total_chars} 字），下面只给出资料开头，以及与当前对话最相关的片段（按原文顺序）。`);
    parts.push(`<资料开头>\n${String(file.text || '').slice(0, HEAD_CHARS)}\n</资料开头>`);
    parts.push(snippets.length
      ? `<相关片段>\n${snippets.map((s) => `【片段 ${s.idx + 1}】\n${s.text}`).join('\n\n')}\n</相关片段>`
      : '<相关片段>\n（没有找到与当前问题直接相关的段落）\n</相关片段>');
  } else {
    parts.push(`<资料>\n${file.text || ''}\n</资料>`);
  }
  const instruction = m(settings.instruction);
  if (instruction) parts.push(`【说明】\n${instruction}`);
  parts.push(`【对话规则】\n${FILE_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n')}`);
  parts.push(`【硬性底线】${SAFETY_RULE}`);
  const sp = m(settings.system_prompt);
  if (sp) parts.push(`【附加规则】\n${sp}`);
  const personaDesc = m(user?.persona_desc);
  parts.push(`【用户】用户的称呼是「${name}」。${personaDesc ? `\n${personaDesc}` : ''}`);
  const system = parts.join('\n\n');

  const picked = [];
  let total = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    const content = String(h.content || '');
    if (picked.length > 0 && total + content.length > HISTORY_MAX_CHARS) break;
    total += content.length;
    picked.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content });
  }
  picked.reverse();
  const messages = [{ role: 'system', content: system }, ...picked];
  if (extraUser) messages.push({ role: 'user', content: extraUser });
  const phi = m(settings.post_history_instructions);
  if (phi) messages.push({ role: 'system', content: phi });
  return messages;
}

/** 会话标题：首个文件名（多个文件加「等 N 个文件」）。 */
export function fileChatTitle(files) {
  const ok = (files || []).filter((f) => f.ok);
  const first = ok[0]?.name || (files || [])[0]?.name || '文件';
  return truncate(ok.length > 1 ? `${first} 等 ${ok.length} 个文件` : first, 100);
}

// ---------- 花费预估 ----------

/**
 * 每条消息大约花费（美元）。整份模式：资料段在前缀缓存里（首条按未命中计 first_message_usd）；
 * 检索模式：每轮约 3 万字片段 + 3000 字开头 + 历史，按未命中计。输出按 400 token 估。
 */
export function estimateForModel(m, { text, total_chars, mode }, { cnyToUsd, at } = {}) {
  const ratio = total_chars ? estimateTokens(String(text).slice(0, 200_000)) / Math.min(total_chars, 200_000) : 1;
  const extra = 3000; // 规则、说明、历史（约）
  const out = 400;
  let first;
  let per;
  if (mode === 'retrieval') {
    const tin = Math.round((RETRIEVE_BUDGET_CHARS + HEAD_CHARS) * ratio) + extra;
    first = estimateUsd(m, { tokens_in: tin, tokens_in_cached: 0, tokens_out: out }, cnyToUsd, at);
    per = estimateUsd(m, { tokens_in: tin, tokens_in_cached: Math.round(HEAD_CHARS * ratio), tokens_out: out }, cnyToUsd, at);
  } else {
    const doc = Math.round(total_chars * ratio);
    first = estimateUsd(m, { tokens_in: doc + extra, tokens_in_cached: 0, tokens_out: out }, cnyToUsd, at);
    per = estimateUsd(m, { tokens_in: doc + extra, tokens_in_cached: doc, tokens_out: out }, cnyToUsd, at);
  }
  return { per_message_usd: per === null ? null : round6(per), first_message_usd: first === null ? null : round6(first) };
}

export function parseInstruction(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, '一句话说明格式不正确');
  const s = v.replace(/\r\n/g, '\n').trim();
  if (s.length > FILE_INSTRUCTION_MAX) throw new HttpError(400, `一句话说明太长，最多 ${FILE_INSTRUCTION_MAX} 字`);
  return s;
}
