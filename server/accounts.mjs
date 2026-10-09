// 邀请码注册 + 密码自主（契约 §13）与「我的登录记录」（契约 §14）的纯工具：
// 生成邀请码 / 重置码、限流器、邀请码状态与视图、UA 解析、登录记录查询。路由与写库在 app.mjs。
import crypto from 'node:crypto';
import { HttpError, str } from './util.mjs';

// ---------- 码 ----------
/** 去掉易混字符 0 O 1 I L 的大写字母 + 数字（31 个）。 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LEN = 10;
export const RESET_CODE_LEN = 8;
export const RESET_CODE_TTL_MS = 24 * 3600 * 1000;

export function randomCode(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

/** 用户输入的码：去空白与横线、转大写；格式不对返回 ''。 */
export function normalizeCode(v, len) {
  const s = str(v, 64).replace(/[\s-]+/g, '').toUpperCase();
  if (s.length !== len) return '';
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return '';
  return s;
}

// ---------- 邀请码参数 ----------
export const INVITE_NOTE_MAX = 100;
export const INVITE_MAX_USES = 10000;
export const INVITE_MAX_DAYS = 3650;
export const PUBLIC_BASE_URL_DEFAULT = 'http://localhost:44982';

/** 备注：必填，去首尾空白后 1–100 字（按字符计）。 */
export function parseInviteNote(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  const n = [...s].length;
  if (!n || n > INVITE_NOTE_MAX) throw new HttpError(400, `请填写备注（1–${INVITE_NOTE_MAX} 字）`);
  return s;
}

/** 账号备注（可空）：null / '' = 清空；最多 100 字。 */
export function parseUserNote(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new HttpError(400, '备注格式不正确');
  const s = v.trim();
  if ([...s].length > INVITE_NOTE_MAX) throw new HttpError(400, `备注最多 ${INVITE_NOTE_MAX} 字`);
  return s || null;
}

export function parseMaxUses(v) {
  if (v === undefined || v === null || v === '') return 1;
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);
  if (!Number.isInteger(n) || n < 1 || n > INVITE_MAX_USES) throw new HttpError(400, `使用次数必须是 1–${INVITE_MAX_USES} 的整数`);
  return n;
}

/**
 * 过期时间：expires_in_days（1–3650 的整数）或 expires_at（ISO 时间；纯日期 YYYY-MM-DD = 新加坡时间当天 23:59:59.999）。
 * 两个都给以 expires_at 为准；都没给 400。必须晚于现在、且不超过 3650 天。返回 UTC ISO。
 */
export function parseInviteExpiry(b, now = Date.now()) {
  let t;
  if (b.expires_at !== undefined && b.expires_at !== null && b.expires_at !== '') {
    const s = str(b.expires_at, 64).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) t = Date.parse(`${s}T23:59:59.999+08:00`);
    // 不带时区的日期时间一律按新加坡时间（+08:00）解析，不依赖服务器本地时区（v0.9 F8）。
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(s)) t = Date.parse(`${s}+08:00`);
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) t = Date.parse(s);
    else t = NaN;
    if (!Number.isFinite(t)) throw new HttpError(400, '到期时间格式不正确');
  } else if (b.expires_in_days !== undefined && b.expires_in_days !== null && b.expires_in_days !== '') {
    const v = b.expires_in_days;
    const d = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);
    if (!Number.isInteger(d) || d < 1 || d > INVITE_MAX_DAYS) throw new HttpError(400, `有效天数必须是 1–${INVITE_MAX_DAYS} 的整数`);
    t = now + d * 86400000;
  } else {
    throw new HttpError(400, '请设置有效期');
  }
  if (t <= now) throw new HttpError(400, '到期时间必须晚于现在');
  if (t > now + INVITE_MAX_DAYS * 86400000 + 86400000) throw new HttpError(400, `有效期最长 ${INVITE_MAX_DAYS} 天`);
  return new Date(t).toISOString();
}

export const INVITE_STATUS_NAMES = {
  active: '有效',
  used_up: '已用完',
  expired: '已过期',
  disabled: '已停用',
  creator_inactive: '创建者账号已停用',
};

/** 创建者账号还能发邀请：存在、未停用、未删除、仍是管理员或超管。 */
export const creatorActive = (c) => !!c && !c.disabled && !c.deleted_at && (c.role === 'admin' || c.role === 'super');

/** 邀请码状态。优先级：停用 > 创建者失效 > 过期 > 用完 > 有效。 */
export function inviteStatus(inv, creator, now = Date.now()) {
  if (inv.disabled_at) return 'disabled';
  if (!creatorActive(creator)) return 'creator_inactive';
  if (Date.parse(inv.expires_at) <= now) return 'expired';
  if (inv.used_count >= inv.max_uses) return 'used_up';
  return 'active';
}

/** 对外（公开注册页）的失败原因：不泄露备注与创建者。 */
export const INVITE_PUBLIC_REASONS = {
  not_found: '邀请码不存在',
  disabled: '邀请码已停用',
  creator_inactive: '邀请码已失效',
  expired: '邀请码已过期',
  used_up: '邀请码已用完',
  format: '邀请码格式不正确',
};

export function inviteLink(base, code) {
  return `${String(base || PUBLIC_BASE_URL_DEFAULT).replace(/\/+$/, '')}/#/register?code=${code}`;
}

// ---------- 限流（注册：按 IP，10 分钟内失败 10 次锁 30 分钟）----------
export class FailLimiter {
  constructor({ max, windowMs, lockMs, maxKeys = 10000 }) {
    this.max = max; this.windowMs = windowMs; this.lockMs = lockMs; this.maxKeys = maxKeys; this.map = new Map();
  }
  isLocked(key) {
    const e = this.map.get(key);
    if (!e) return false;
    const now = Date.now();
    if (e.lockedUntil > now) return true;
    if (e.lockedUntil || e.windowStart + this.windowMs < now) this.map.delete(key);
    return false;
  }
  /** 记一次失败；返回 true = 这次刚好进入锁定。 */
  fail(key) {
    const now = Date.now();
    let e = this.map.get(key);
    if (!e || (e.lockedUntil && e.lockedUntil <= now) || e.windowStart + this.windowMs < now) e = { fails: 0, windowStart: now, lockedUntil: 0 };
    e.fails += 1;
    let just = false;
    if (e.fails >= this.max && !(e.lockedUntil > now)) { e.lockedUntil = now + this.lockMs; just = true; }
    this.map.set(key, e);
    if (this.map.size > this.maxKeys) {
      for (const [k, v] of this.map) if (!(v.lockedUntil > now) && v.windowStart + this.windowMs < now) this.map.delete(k);
    }
    return just;
  }
}
export const REGISTER_MAX_FAILS = 10;
export const REGISTER_WINDOW_MS = 10 * 60 * 1000;
export const REGISTER_LOCK_MS = 30 * 60 * 1000;

// ---------- 登录记录（契约 §14）----------
export const UA_MAX = 300;
export const uaOf = (req) => str(req?.headers?.['user-agent'], UA_MAX);

/** UA → 「Chrome · Windows」「Safari · iPhone」之类的简短中文描述。 */
export function deviceOf(ua) {
  const s = String(ua || '');
  if (!s.trim()) return '未知设备';
  if (/^(curl|wget|python|node|go-http|okhttp|java|axios|undici|postman)/i.test(s)) return '命令行或程序';
  let os = '';
  if (/iPhone/.test(s)) os = 'iPhone';
  else if (/iPad/.test(s)) os = 'iPad';
  else if (/HarmonyOS|OpenHarmony/i.test(s)) os = '鸿蒙';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Macintosh|Mac OS X/.test(s)) os = 'Mac';
  else if (/Linux/i.test(s)) os = 'Linux';
  let browser = '';
  if (/MicroMessenger/i.test(s)) browser = '微信';
  else if (/EdgA?\/|EdgiOS\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/SamsungBrowser/.test(s)) browser = '三星浏览器';
  else if (/HuaweiBrowser/.test(s)) browser = '华为浏览器';
  else if (/Firefox\/|FxiOS\//.test(s)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = 'Safari';
  else if (/AppleWebKit/.test(s) && (os === 'iPhone' || os === 'iPad')) browser = 'App 内浏览器';
  if (browser && os) return `${browser} · ${os}`;
  return browser || os || '其他设备';
}

export const LOGIN_RECORD_KINDS = ['auth.login', 'auth.lockout', 'user.password_reset', 'user.register'];
export const LOGIN_PAGE_SIZE = 30;
const EVENT_NAMES = { login: '登录', lockout: '登录锁定', password_reset: '用重置码设置新密码', register: '邀请码注册' };
const REASON_NAMES = { 密码错误: '密码错误', 停用: '账号停用', 锁定: '尝试过多被锁' };

/** GET /api/me/logins：只看自己（target_type=user 且 target_id=自己），不返回原始 detail。 */
export function queryMyLogins(db, userId, pageParam) {
  const page = Math.min(100000, Math.max(1, parseInt(pageParam || '1', 10) || 1));
  const rows = db.prepare(`SELECT id, at, kind, ip, detail_json FROM logs
    WHERE target_type = 'user' AND target_id = ? AND kind IN (${LOGIN_RECORD_KINDS.map(() => '?').join(', ')})
    ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`).all(Number(userId), ...LOGIN_RECORD_KINDS, LOGIN_PAGE_SIZE + 1, (page - 1) * LOGIN_PAGE_SIZE);
  const items = rows.slice(0, LOGIN_PAGE_SIZE).map((r) => {
    let d = {};
    try { d = JSON.parse(r.detail_json || '{}') || {}; } catch { d = {}; }
    let result = 'success';
    let reason;
    let event = 'login';
    if (r.kind === 'auth.lockout') { result = 'locked'; reason = REASON_NAMES.锁定; event = 'lockout'; }
    else if (r.kind === 'user.password_reset') event = 'password_reset';
    else if (r.kind === 'user.register') event = 'register';
    else if (d.result === 'fail') {
      if (d.reason === '锁定') { result = 'locked'; reason = REASON_NAMES.锁定; }
      else { result = 'fail'; reason = REASON_NAMES[d.reason] || '登录失败'; }
    }
    return {
      at: r.at,
      result,
      ...(reason ? { reason } : {}),
      event,
      event_name: EVENT_NAMES[event],
      ip: r.ip ?? null,
      device: deviceOf(d.user_agent),
    };
  });
  return { items, page, has_more: rows.length > LOGIN_PAGE_SIZE };
}
