import { zh } from '/i18n/zh.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * 把消息文本转成安全的 HTML：先转义，再把 *动作* 变成灰色斜体。
 * streaming=true 时，末尾未闭合的 *… 也先按动作显示。
 */
export function formatMessage(text, streaming = false, { paren = false } = {}) {
  let h = esc(text);
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/\*([^*\n]+)\*/g, '<em class="act">$1</em>');
  if (streaming) h = h.replace(/\*([^*\n]+)$/, '<em class="act">$1</em>');
  // 契约 §18.1：用户消息里全角括号（…）是动作 / 神态，显示为灰色斜体（括号保留）
  if (paren) h = h.replace(/（[^（）\n<>]*）/g, (m) => `<em class="act paren">${m}</em>`);
  return h;
}

export function tagLabel(tag) {
  const k = String(tag || '').toLowerCase();
  return zh.tags[k] || tag;
}

export function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
}

function toDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

export function timeAgo(v) {
  const d = toDate(v);
  if (!d) return '';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return zh.time.just_now;
  if (diff < 3600) return Math.floor(diff / 60) + ' ' + zh.time.minutes;
  if (diff < 86400) return Math.floor(diff / 3600) + ' ' + zh.time.hours;
  if (diff < 172800) return zh.time.yesterday;
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' ' + zh.time.days;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function fmtDateTime(v) {
  const d = toDate(v);
  if (!d) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function initial(name) {
  const s = String(name || '').trim();
  return s ? [...s][0].toUpperCase() : '?';
}

export const isTouch = () => matchMedia('(pointer: coarse)').matches;

// chub 路径（含 /）放进地址栏时按段编码
export const encodeHashPath = (p) => String(p || '').split('/').map(encodeURIComponent).join('/');
export const decodeHashPath = (p) => String(p || '').split('/').map((s) => { try { return decodeURIComponent(s); } catch { return s; } }).join('/');

// 列表预览行：去掉动作星号、压缩空白
export const previewText = (s) => String(s || '').replace(/\*+/g, '').replace(/\s+/g, ' ').trim();

// 去掉 HTML 标签与 Markdown 图片/链接语法（链接保留文字），用于显示第三方原文
export function stripMarkup(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 账号身份（契约 §9）：super / admin / tenant。旧接口没有 role 字段时按 is_admin 回退（旧版管理员即全部权限）
export function roleOf(u) {
  if (!u) return '';
  if (u.role === 'super' || u.role === 'admin' || u.role === 'tenant') return u.role;
  const a = u.is_admin;
  return a === true || a === 1 || a === '1' ? 'super' : 'tenant';
}
export const isManager = (u) => { const r = roleOf(u); return r === 'super' || r === 'admin'; };
export const isSuper = (u) => roleOf(u) === 'super';

/* ---------- 金额（契约 §10.4：统一美元，$ 前缀） ---------- */
// 取数：null / '' / 非数 / 负数 都当「算不出」返回 null
export function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 美元金额：0 → $0；< $0.01 → 4 位有效数字（$0.000845）；< $1 → 最多 4 位小数（$0.0123）；
 * 其余 → 2 位小数带千分位（$1,234.56）。≥ $0.01 时至少 2 位小数（$0.50），末尾多余的 0 只去到第 2 位小数为止。算不出返回 ''。
 */
export function fmtUsd(v) {
  const n = numOrNull(v);
  if (n == null) return '';
  if (n === 0) return '$0';
  const trim = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  if (n < 0.01) {
    const d = Math.min(12, Math.max(0, 3 - Math.floor(Math.log10(n))));
    const s = trim(n.toFixed(d));
    return '$' + (s === '0' ? n.toExponential(3) : s);
  }
  if (n < 1) return '$' + n.toFixed(4).replace(/(\.\d\d\d*?)0+$/, '$1'); // 至少两位小数：$0.50、$0.0123
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 带「约」前缀的金额（estimate / cost_partial 时）。算不出返回 ''。 */
export function fmtCost(v, approx = false) {
  const s = fmtUsd(v);
  return s ? (approx ? zh.cost.approx + s : s) : '';
}

/** 计数：1,234（不缩写，用于输入 / 输出量） */
export const fmtInt = (v) => (Number(v) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

/** 单价显示：USD → $1.25，CNY → ¥2（每百万 token，原币种，不换算） */
export function fmtPrice(v, currency) {
  const n = numOrNull(v);
  if (n == null) return '';
  const s = String(+n.toFixed(6));
  return (String(currency).toUpperCase() === 'CNY' ? '¥' : '$') + s;
}
