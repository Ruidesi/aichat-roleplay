// 自建角色卡 / 剧情卡（契约 §12）：字段规范化（Tavern V2 data 结构）、世界书命中、导入导出解析、头像文件存取。
// 纯函数为主，便于单元测试；HTTP 与权限在 app.mjs。
import crypto from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile, rename, unlink, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './util.mjs';
import { isPng, readTextChunks, withTextChunk, solidPng, stripPngMetadata } from './png.mjs';
import { applyMacros } from './prompt.mjs';

export const CARD_KINDS = ['character', 'scenario'];
export const VISIBILITIES = ['private', 'public'];
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_BYTES = 12 * 1024 * 1024;
export const LORE_BUDGET_CHARS = 4000;
export const LORE_SCAN_MESSAGES = 4;

/** 文本字段与上限（字数）。用户编辑超限 → 400；导入 / 拷贝的外来数据超限 → 截断。 */
export const TEXT_FIELDS = {
  description: 30000,
  personality: 8000,
  scenario: 8000,
  first_mes: 10000,
  mes_example: 12000,
  system_prompt: 8000,
  post_history_instructions: 8000,
  creator_notes: 8000,
};
const FIELD_LABELS = {
  description: '人物描述', personality: '性格', scenario: '场景', first_mes: '开场白', mes_example: '对话示例',
  system_prompt: '系统提示', post_history_instructions: '历史后提示', creator_notes: '作者说明',
};
export const LIMITS = {
  name: 60, tagline: 200, tags: 20, tag: 30, greetings: 20, greeting: 10000,
  entries: 500, keys: 50, key: 100, entryContent: 20000, entryName: 100, extensionsBytes: 64 * 1024, cardBytes: 3 * 1024 * 1024,
};

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const toText = (v) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean') ? String(v) : '');

function fit(v, max, label, strict) {
  const s = toText(v).replace(/\r\n/g, '\n');
  if (s.length <= max) return s;
  if (strict) throw new HttpError(400, `${label}太长，最多 ${max} 字`);
  return s.slice(0, max);
}

/** 标签：数组或逗号分隔字符串 → 去空去重的字符串数组。 */
export function normalizeTags(v, { strict = false } = {}) {
  const arr = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/[,，]/) : []);
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const t = toText(x).trim().slice(0, LIMITS.tag);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  if (out.length > LIMITS.tags) {
    if (strict) throw new HttpError(400, `标签最多 ${LIMITS.tags} 个`);
    out.length = LIMITS.tags;
  }
  return out;
}

const toKeys = (v) => {
  const arr = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/[,，]/) : []);
  return arr.map((x) => toText(x).trim().slice(0, LIMITS.key)).filter(Boolean).slice(0, LIMITS.keys);
};
const toBool = (v, dflt = false) => (v === undefined || v === null ? dflt : v === true || v === 1 || v === '1' || v === 'true');
const toInt = (v, dflt = 100) => { const n = Number(v); return Number.isFinite(n) ? Math.max(-1e6, Math.min(1e6, Math.trunc(n))) : dflt; };

/**
 * 世界书规范化：兼容 Tavern V2 character_book、chub embedded_lorebook（同 V2）、SillyTavern world info
 * （entries 为对象、key / keysecondary / order / disable）。返回 {name?, entries:[...]} 或 null（没有条目）。
 */
export function normalizeLorebook(lb, { strict = false } = {}) {
  if (!isObj(lb)) return null;
  const raw = Array.isArray(lb.entries) ? lb.entries : (isObj(lb.entries) ? Object.values(lb.entries) : []);
  if (raw.length > LIMITS.entries && strict) throw new HttpError(400, `世界书条目最多 ${LIMITS.entries} 条`);
  const entries = [];
  for (const e of raw.slice(0, LIMITS.entries)) {
    if (!isObj(e)) continue;
    const content = fit(e.content, LIMITS.entryContent, '世界书条目内容', strict);
    const keys = toKeys(e.keys ?? e.key);
    const secondary = toKeys(e.secondary_keys ?? e.keysecondary);
    const constant = toBool(e.constant);
    if (!content.trim() && !keys.length) continue;
    const pos = e.position === 'after_char' ? 'after_char' : 'before_char';
    entries.push({
      name: toText(e.name ?? e.comment).slice(0, LIMITS.entryName),
      keys,
      secondary_keys: secondary,
      content,
      enabled: e.enabled !== undefined ? toBool(e.enabled, true) : !toBool(e.disable),
      insertion_order: toInt(e.insertion_order ?? e.order, 100),
      case_sensitive: toBool(e.case_sensitive ?? e.extensions?.case_sensitive),
      constant,
      selective: toBool(e.selective),
      position: pos,
    });
  }
  if (!entries.length) return null;
  const out = { entries };
  const name = toText(lb.name).trim().slice(0, 100);
  if (name) out.name = name;
  return out;
}

function normalizeExtensions(v) {
  if (!isObj(v)) return {};
  try {
    const s = JSON.stringify(v);
    return s.length <= LIMITS.extensionsBytes ? JSON.parse(s) : {};
  } catch { return {}; }
}

/**
 * 卡片设定 → 规范 V2 data（不含 name / tags 等列字段）。
 * src 里没给的字段取 base（PATCH 时 base = 旧数据）。
 */
export function normalizeCardData(src, { base = {}, strict = false } = {}) {
  const s = isObj(src) ? src : {};
  const pick = (k) => (s[k] !== undefined ? s[k] : base[k]);
  const out = {};
  for (const [k, max] of Object.entries(TEXT_FIELDS)) out[k] = fit(pick(k), max, FIELD_LABELS[k], strict);
  const ag = pick('alternate_greetings');
  const greetings = Array.isArray(ag) ? ag : [];
  if (greetings.length > LIMITS.greetings && strict) throw new HttpError(400, `备选开场白最多 ${LIMITS.greetings} 条`);
  out.alternate_greetings = greetings.slice(0, LIMITS.greetings).map((g) => fit(g, LIMITS.greeting, '备选开场白', strict)).filter((g) => g.trim());
  const book = s.character_book !== undefined ? s.character_book : base.character_book;
  out.character_book = normalizeLorebook(book, { strict });
  out.extensions = normalizeExtensions(s.extensions !== undefined ? s.extensions : base.extensions);
  return out;
}

/** 列字段（名称、简介、标签、成人、可见性、类型）。base 为旧行（PATCH），新建时为空。 */
export function normalizeCardMeta(b, { base = null, strict = true } = {}) {
  const out = {};
  if (b.name !== undefined || !base) {
    const name = fit(b.name, LIMITS.name, '名字', strict).trim();
    if (!name) throw new HttpError(400, '名字不能为空');
    out.name = name;
  }
  if (b.tagline !== undefined || !base) out.tagline = fit(b.tagline, LIMITS.tagline, '一句话简介', strict).trim();
  if (b.tags !== undefined || !base) out.tags_json = JSON.stringify(normalizeTags(b.tags, { strict }));
  if (b.nsfw !== undefined || !base) out.nsfw = toBool(b.nsfw) ? 1 : 0;
  if (b.visibility !== undefined || !base) {
    const v = b.visibility === undefined || b.visibility === null || b.visibility === '' ? 'private' : String(b.visibility);
    if (!VISIBILITIES.includes(v)) throw new HttpError(400, '可见性不正确');
    out.visibility = v;
  }
  if (b.kind !== undefined || !base) {
    const k = b.kind === undefined || b.kind === null || b.kind === '' ? 'character' : String(b.kind);
    if (!CARD_KINDS.includes(k)) throw new HttpError(400, '卡片类型不正确');
    out.kind = k;
  }
  return out;
}

/** 请求体里的设定字段：允许放在 data 里，也允许平铺在顶层（顶层优先）。 */
export function cardDataFromBody(b) {
  const nested = isObj(b.data) ? b.data : {};
  const flat = {};
  for (const k of [...Object.keys(TEXT_FIELDS), 'alternate_greetings', 'character_book', 'extensions']) if (b[k] !== undefined) flat[k] = b[k];
  return { ...nested, ...flat };
}

/** chub definition（characters.card_json）→ V2 data。chub 的 personality = 角色描述，tavern_personality = 性格。 */
export function chubDefinitionToData(def, { greetingZh = '' } = {}) {
  const d = isObj(def) ? def : {};
  return normalizeCardData({
    description: d.personality || '',
    personality: d.tavern_personality || '',
    scenario: d.scenario || '',
    first_mes: (greetingZh && greetingZh.trim()) ? greetingZh : (d.first_message || ''),
    mes_example: d.example_dialogs || '',
    system_prompt: d.system_prompt || '',
    post_history_instructions: d.post_history_instructions || '',
    creator_notes: d.description || '',
    alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [],
    character_book: d.embedded_lorebook || d.character_book || null,
    extensions: {},
  });
}

/** V2 data → buildMessages 认的 definition（沿用 chub 的字段名）。 */
export function dataToDefinition(data) {
  const d = isObj(data) ? data : {};
  return {
    personality: d.description || '',
    tavern_personality: d.personality || '',
    scenario: d.scenario || '',
    first_message: d.first_mes || '',
    example_dialogs: d.mes_example || '',
    system_prompt: d.system_prompt || '',
    post_history_instructions: d.post_history_instructions || '',
    character_book: d.character_book || null,
  };
}

/**
 * 世界书命中（契约 §12.1）：扫描最近 4 条消息；enabled 条目 keys 命中（默认不区分大小写，case_sensitive 时区分）即注入；
 * selective 且有 secondary_keys 时还要命中任一次要关键词；constant 条目总是注入（优先占预算）；
 * 结果按 insertion_order 升序；总长上限约 4000 字（放不下的条目跳过）。返回条目内容数组。
 */
export function selectLore(book, history, { budget = LORE_BUDGET_CHARS, scan = LORE_SCAN_MESSAGES, macros = null } = {}) {
  const entries = Array.isArray(book?.entries) ? book.entries : [];
  if (!entries.length) return [];
  const recent = (Array.isArray(history) ? history : []).slice(-scan).map((h) => String(h?.content || '')).join('\n');
  const lower = recent.toLowerCase();
  const has = (k, cs) => (cs ? recent.includes(k) : lower.includes(k.toLowerCase()));
  const hit = [];
  entries.forEach((e, i) => {
    if (!e || e.enabled === false || !String(e.content || '').trim()) return;
    if (e.constant) { hit.push({ e, i, constant: true }); return; }
    const keys = (e.keys || []).filter(Boolean);
    if (!keys.length || !keys.some((k) => has(k, e.case_sensitive))) return;
    const sec = (e.secondary_keys || []).filter(Boolean);
    if (e.selective && sec.length && !sec.some((k) => has(k, e.case_sensitive))) return;
    hit.push({ e, i, constant: false });
  });
  const order = (a, b) => (a.e.insertion_order ?? 100) - (b.e.insertion_order ?? 100) || a.i - b.i;
  const chosen = [];
  let used = 0;
  for (const x of [...hit.filter((h) => h.constant).sort(order), ...hit.filter((h) => !h.constant).sort(order)]) {
    const text = (macros ? applyMacros(x.e.content, macros) : String(x.e.content)).trim();
    if (!text) continue;
    if (used + text.length > budget) continue;
    used += text.length;
    chosen.push({ ...x, text });
  }
  return chosen.sort(order).map((x) => x.text);
}

// ---------- 图片与上传 ----------

/** 文件头魔数 → png | jpg | webp；其他返回 null。 */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (isPng(buf)) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}
export const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** EXIF（APP1 "Exif\0\0" 段的内容）里 IFD0 的方向标签 0x0112 → 1–8；读不到返回 0。 */
function exifOrientation(seg) {
  try {
    const t = 6; // "Exif\0\0" 之后是 TIFF 头
    if (seg.toString('latin1', 0, 6) !== 'Exif\0\0' || seg.length < t + 8) return 0;
    const le = seg.toString('latin1', t, t + 2) === 'II';
    if (!le && seg.toString('latin1', t, t + 2) !== 'MM') return 0;
    const u16 = (o) => (le ? seg.readUInt16LE(o) : seg.readUInt16BE(o));
    const u32 = (o) => (le ? seg.readUInt32LE(o) : seg.readUInt32BE(o));
    const ifd = t + u32(t + 4);
    if (ifd + 2 > seg.length) return 0;
    const n = u16(ifd);
    for (let i = 0; i < n && i < 512; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > seg.length) return 0;
      if (u16(e) === 0x0112 && u16(e + 2) === 3) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 0; }
    }
  } catch { /* 读不到就当没有 */ }
  return 0;
}

/** 只含方向标签的最小 APP1 段（去掉 EXIF 其余内容后仍保持手机照片的朝向）。 */
function orientationApp1(v) {
  const body = Buffer.from([
    0x45, 0x78, 0x69, 0x66, 0, 0, // "Exif\0\0"
    0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, // TIFF 大端头，IFD0 偏移 8
    0, 1, // 1 个条目
    0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, v, 0, 0, // Orientation SHORT ×1
    0, 0, 0, 0, // 没有下一个 IFD
  ]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/**
 * JPEG 去元数据：去掉 APP1（EXIF/XMP，只按需补回方向）、APP3–APP13、APP15、COM，以及 EOI 之后的附加数据；
 * 保留 APP0（JFIF）、APP2 里的 ICC 色彩配置、APP14（Adobe 色彩变换）与全部图像数据段。结构不对抛 Error。
 */
export function stripJpegMetadata(buf) {
  const n = buf.length;
  if (n < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('JPEG 文件头不正确');
  const out = [buf.subarray(0, 2)];
  let orientation = 0;
  let wroteOrientation = false;
  let pos = 2;
  let ended = false;
  while (pos < n) {
    if (buf[pos] !== 0xff) throw new Error('JPEG 段结构不正确');
    while (pos + 1 < n && buf[pos + 1] === 0xff) pos++; // 填充字节
    if (pos + 1 >= n) break;
    const m = buf[pos + 1];
    if (m === 0xd9) { out.push(buf.subarray(pos, pos + 2)); ended = true; break; }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { out.push(buf.subarray(pos, pos + 2)); pos += 2; continue; }
    if (pos + 4 > n) throw new Error('JPEG 被截断');
    const len = buf.readUInt16BE(pos + 2);
    if (len < 2 || pos + 2 + len > n) throw new Error('JPEG 段长度越界');
    const seg = buf.subarray(pos, pos + 2 + len);
    const payload = seg.subarray(4);
    let keep;
    if (m === 0xe1) { if (!orientation) orientation = exifOrientation(payload); keep = false; }
    else if (m === 0xe2) keep = payload.toString('latin1', 0, 12) === 'ICC_PROFILE\0';
    else if (m === 0xe0 || m === 0xee) keep = true;
    else if ((m >= 0xe3 && m <= 0xef) || m === 0xfe) keep = false;
    else keep = true; // SOFn / DHT / DQT / DRI / SOS / DNL …
    // 方向信息放在第一个图像相关段（帧头 / 量化表 / 哈夫曼表 / 扫描）前面，APP0 之后。
    if (!wroteOrientation && orientation > 1 && keep && m !== 0xe0 && m !== 0xe2 && m !== 0xee) { out.push(orientationApp1(orientation)); wroteOrientation = true; }
    if (keep) out.push(seg);
    pos += 2 + len;
    if (m === 0xda) {
      // 熵编码数据：一直到下一个不是 FF00 / RSTn / 填充的标记
      const start = pos;
      for (;;) {
        const i = buf.indexOf(0xff, pos);
        if (i < 0 || i + 1 >= n) { pos = n; break; }
        const b = buf[i + 1];
        if (b === 0x00 || (b >= 0xd0 && b <= 0xd7) || b === 0xff) { pos = i + 1; continue; }
        pos = i;
        break;
      }
      out.push(buf.subarray(start, pos));
    }
  }
  if (!ended) throw new Error('JPEG 被截断');
  return Buffer.concat(out);
}

/** WebP 去元数据：去掉 EXIF / XMP 与未知块，VP8X 里对应标志位清零，重写 RIFF 长度。结构不对抛 Error。 */
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
export function stripWebpMetadata(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') throw new Error('WebP 文件头不正确');
  const end = Math.min(buf.length, 8 + buf.readUInt32LE(4));
  const parts = [];
  let pos = 12;
  while (pos + 8 <= end) {
    const type = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const total = 8 + size + (size & 1);
    if (pos + 8 + size > end) throw new Error('WebP 块长度越界');
    if (WEBP_KEEP.has(type)) {
      let chunk = Buffer.from(buf.subarray(pos, Math.min(pos + total, end)));
      if (chunk.length < total) chunk = Buffer.concat([chunk, Buffer.alloc(total - chunk.length)]);
      if (type === 'VP8X' && size >= 1) chunk[8] &= ~(0x08 | 0x04); // EXIF / XMP 标志
      parts.push(chunk);
    }
    pos += total;
  }
  if (!parts.some((c) => ['VP8 ', 'VP8L', 'VP8X'].includes(c.toString('latin1', 0, 4)))) throw new Error('WebP 缺少图像数据');
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

/**
 * 头像落盘前去元数据（PNG 文本块含原始角色卡 chara/ccv3、JPEG EXIF/GPS、WebP EXIF/XMP）。
 * 返回 {buf, ext}；不是支持的图片或结构损坏 → HttpError 400。
 */
export function sanitizeAvatar(buf) {
  const ext = sniffImage(buf);
  if (!ext) throw new HttpError(400, '只支持 PNG、JPEG、WebP 图片');
  try {
    const clean = ext === 'png' ? stripPngMetadata(buf) : ext === 'jpg' ? stripJpegMetadata(buf) : stripWebpMetadata(buf);
    return { buf: clean, ext };
  } catch {
    throw new HttpError(400, '图片已损坏，无法读取');
  }
}

/**
 * 最小 multipart/form-data 解析：返回第一个带文件名（或名为 file / avatar / card）的部分 {name, filename, contentType, data}。
 * 没有就返回 null。
 */
export function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
  if (!m) return null;
  const boundary = Buffer.from(`--${m[1] || m[2]}`, 'latin1');
  let pos = buf.indexOf(boundary);
  const parts = [];
  while (pos >= 0 && parts.length < 20) {
    let start = pos + boundary.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // 结束
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    const next = buf.indexOf(boundary, start);
    if (next < 0) break;
    let end = next;
    if (buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;
    const part = buf.subarray(start, end);
    const sep = part.indexOf('\r\n\r\n');
    if (sep >= 0) {
      const head = part.toString('utf8', 0, sep);
      const data = part.subarray(sep + 4);
      const disp = /content-disposition:([^\r\n]*)/i.exec(head)?.[1] || '';
      const name = /\bname="([^"]*)"/i.exec(disp)?.[1] || '';
      const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1];
      const ct = (/content-type:\s*([^\r\n;]*)/i.exec(head)?.[1] || '').trim().toLowerCase();
      parts.push({ name, filename, contentType: ct, data });
    }
    pos = next;
  }
  return parts.find((p) => p.filename !== undefined) || parts.find((p) => ['file', 'avatar', 'card'].includes(p.name)) || null;
}

/** 上传请求体 → {data, contentType}（multipart 取文件部分，否则原样）。 */
export function uploadPayload(buf, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.startsWith('multipart/form-data')) {
    const p = parseMultipart(buf, contentType);
    if (!p) throw new HttpError(400, '没有找到上传的文件');
    return { data: p.data, contentType: p.contentType };
  }
  return { data: buf, contentType: ct.split(';')[0].trim() };
}

// ---------- 导入 ----------

/** Tavern 卡 JSON（V1 / V2 / V3）→ {data, name, tags, tagline, nsfw, kind}。 */
export function parseCardJson(obj) {
  if (!isObj(obj)) throw new HttpError(400, '无法识别的角色卡');
  const spec = String(obj.spec || '');
  const d = (spec.startsWith('chara_card_v') && isObj(obj.data)) ? obj.data : (isObj(obj.data) && obj.data.name !== undefined ? obj.data : obj);
  const name = toText(d.name ?? obj.name ?? obj.char_name).trim();
  const hasAny = name || d.description || d.first_mes || d.personality || d.scenario || d.char_persona;
  if (!hasAny) throw new HttpError(400, '无法识别的角色卡');
  const src = {
    description: d.description ?? d.char_persona ?? '',
    personality: d.personality ?? '',
    scenario: d.scenario ?? d.world_scenario ?? '',
    first_mes: d.first_mes ?? d.char_greeting ?? '',
    mes_example: d.mes_example ?? d.example_dialogue ?? '',
    system_prompt: d.system_prompt ?? '',
    post_history_instructions: d.post_history_instructions ?? '',
    creator_notes: d.creator_notes ?? obj.creatorcomment ?? '',
    alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [],
    character_book: d.character_book ?? null,
    extensions: isObj(d.extensions) ? d.extensions : {},
  };
  const data = normalizeCardData(src, { strict: false });
  const tags = normalizeTags(d.tags ?? obj.tags);
  const ours = isObj(data.extensions.aichat) ? data.extensions.aichat : {};
  const kind = CARD_KINDS.includes(ours.kind) ? ours.kind : 'character';
  const nsfw = ours.nsfw !== undefined ? toBool(ours.nsfw) : tags.some((t) => t.toLowerCase() === 'nsfw');
  const tagline = toText(ours.tagline).trim().slice(0, LIMITS.tagline);
  delete data.extensions.aichat; // 我们自己的元数据只在导入时读一次，不留在卡里
  return { data, name: (name || '未命名角色').slice(0, LIMITS.name), tags, tagline, nsfw, kind };
}

/**
 * 导入：上传 JSON 或带 chara / ccv3 文本块的 PNG。
 * 返回 parseCardJson 的结果 + avatar（PNG 本身即头像；超过 5MB 不存，warnings 里说明）。
 */
export function parseImport(buf, contentType) {
  const { data: body } = uploadPayload(buf, contentType);
  if (!body.length) throw new HttpError(400, '没有收到文件');
  if (isPng(body)) {
    let texts;
    // 只取 chara / ccv3，其余文本块不解压（防压缩炸弹）；解压总量有上限。
    try { texts = readTextChunks(body, { keywords: ['ccv3', 'chara'] }); } catch { throw new HttpError(400, 'PNG 文件已损坏或过大'); }
    const raw = texts.get('ccv3') || texts.get('chara');
    if (!raw) throw new HttpError(400, '这张 PNG 里没有角色卡数据');
    let obj;
    try { obj = JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8')); } catch { throw new HttpError(400, 'PNG 里的角色卡数据无法识别'); }
    const card = parseCardJson(obj);
    const warnings = [];
    let avatar = { buf: body, ext: 'png' };
    if (body.length > AVATAR_MAX_BYTES) { avatar = null; warnings.push('图片超过 5MB，未保存为头像'); }
    return { ...card, avatar, warnings };
  }
  if (sniffImage(body)) throw new HttpError(400, '只支持带角色卡数据的 PNG 图片');
  let obj;
  try { obj = JSON.parse(body.toString('utf8').replace(/^﻿/, '')); } catch { throw new HttpError(400, '文件格式不正确，请上传角色卡 JSON 或 PNG'); }
  return { ...parseCardJson(obj), avatar: null, warnings: [] };
}

// ---------- 导出 ----------

/** 导出为 Tavern V2 JSON 对象。我们自己的 kind / 简介 / 成人标记放 extensions.aichat，导回来能还原。 */
export function exportCardJson(row, data, { creator = '' } = {}) {
  const d = isObj(data) ? data : {};
  const tags = (() => { try { return JSON.parse(row.tags_json || '[]'); } catch { return []; } })();
  const out = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: row.name,
      description: d.description || '',
      personality: d.personality || '',
      scenario: d.scenario || '',
      first_mes: d.first_mes || '',
      mes_example: d.mes_example || '',
      creator_notes: d.creator_notes || '',
      system_prompt: d.system_prompt || '',
      post_history_instructions: d.post_history_instructions || '',
      alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [],
      tags,
      creator,
      character_version: '',
      extensions: { ...(isObj(d.extensions) ? d.extensions : {}), aichat: { kind: row.kind, tagline: row.tagline || '', nsfw: !!row.nsfw } },
    },
  };
  if (d.character_book && Array.isArray(d.character_book.entries) && d.character_book.entries.length) {
    out.data.character_book = {
      ...(d.character_book.name ? { name: d.character_book.name } : {}),
      extensions: {},
      entries: d.character_book.entries.map((e, i) => ({
        id: i + 1,
        keys: e.keys || [],
        secondary_keys: e.secondary_keys || [],
        content: e.content || '',
        enabled: e.enabled !== false,
        insertion_order: e.insertion_order ?? 100,
        case_sensitive: !!e.case_sensitive,
        constant: !!e.constant,
        selective: !!e.selective,
        position: e.position === 'after_char' ? 'after_char' : 'before_char',
        name: e.name || '',
        comment: e.name || '',
        extensions: {},
      })),
    };
  }
  return out;
}

/** PNG 导出：头像是 PNG 就在它上面写 chara 块；否则（无头像 / jpg / webp）用纯色占位图。 */
export function exportCardPng(json, avatarBuf) {
  const b64 = Buffer.from(JSON.stringify(json), 'utf8').toString('base64');
  let basePng = isPng(avatarBuf) ? avatarBuf : null;
  if (basePng) {
    try { return withTextChunk(basePng, 'chara', b64, { removeKeywords: ['ccv3'] }); } catch { basePng = null; }
  }
  return withTextChunk(solidPng(), 'chara', b64);
}

/** Content-Disposition：ASCII 兜底名 + RFC 5987 的 UTF-8 名。 */
export function attachmentHeader(name, ext) {
  const safe = String(name || 'card').replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 80) || 'card';
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["%;\\]/g, '_') || 'card';
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${safe}.${ext}`)}`;
}

// ---------- 头像文件 ----------
export const AVATAR_FILE_RE = /^(\d{1,12})-([0-9a-f]{16})\.(png|jpg|webp)$/;

/** 头像存 DATA_DIR/card-avatars/<id%1000>/<id>-<随机>.ext；文件名只由我们生成，读取前再按正则校验（防路径穿越）。 */
export function createCardAvatarStore(dir) {
  mkdirSync(dir, { recursive: true });
  const pathOf = (file) => {
    const m = AVATAR_FILE_RE.exec(String(file || ''));
    if (!m) return null;
    return path.join(dir, String(Number(m[1]) % 1000), file);
  };
  async function save(cardId, buf, ext) {
    if (!IMAGE_MIME[ext]) throw new HttpError(400, '只支持 PNG、JPEG、WebP 图片');
    const file = `${cardId}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
    const fp = pathOf(file);
    mkdirSync(path.dirname(fp), { recursive: true });
    const tmp = `${fp}.${process.pid}.tmp`;
    await writeFile(tmp, buf, { mode: 0o600 });
    await rename(tmp, fp);
    return file;
  }
  async function read(file) {
    const fp = pathOf(file);
    if (!fp) return null;
    try {
      const buf = await readFile(fp);
      const ext = AVATAR_FILE_RE.exec(file)[3];
      return { buf, type: IMAGE_MIME[ext] };
    } catch { return null; }
  }
  async function copy(file, newCardId) {
    const src = pathOf(file);
    if (!src) return null;
    const ext = AVATAR_FILE_RE.exec(file)[3];
    const nf = `${newCardId}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
    const dst = pathOf(nf);
    mkdirSync(path.dirname(dst), { recursive: true });
    try { await copyFile(src, dst); return nf; } catch { return null; }
  }
  async function remove(file) {
    const fp = pathOf(file);
    if (fp) await unlink(fp).catch(() => {});
  }
  return { save, read, copy, remove, pathOf, dir };
}
