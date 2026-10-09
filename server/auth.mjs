// 密码（scrypt）、会话（cookie ac_sid，30 天滑动）、登录失败锁定。
import crypto from 'node:crypto';
import { nowIso } from './util.mjs';
import { readingSettingsFromJson } from './reading-settings.mjs';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const SESSION_REFRESH_MS = 24 * 3600 * 1000; // 距上次续期超过 1 天才写库
export const COOKIE_NAME = 'ac_sid';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, n, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const got = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
    return crypto.timingSafeEqual(expected, got);
  } catch {
    return false;
  }
}

/** 登录时用户名不存在也要对它跑一次 scrypt，耗时与真实账号一致。启动时随机生成一次。 */
export const DUMMY_HASH = hashPassword(crypto.randomBytes(24).toString('base64'));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

export function sessionCookie(token, req, maxAgeSec) {
  // 线上一律是 https（明文导航会被 308 跳走）；本机 http 调试时不加 Secure，否则浏览器存不下。
  const secure = req.socket?.encrypted ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, nowIso(), Date.now() + SESSION_TTL_MS);
  return token;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function destroyUserSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** 根据 cookie 找当前用户；会话滑动续期。返回 { user, token, refreshed } 或 null。 */
/** 请求头里同名 ac_sid 出现的次数。>1 说明有人从同主机其它端口塞了同名 cookie（cookie 覆盖 / 会话固定）。 */
export function countSessionCookies(header) {
  let n = 0;
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i >= 0 && part.slice(0, i).trim() === COOKIE_NAME) n++;
  }
  return n;
}

export function lookupSession(db, req) {
  // 同名 cookie 多份时分不清哪份是本站发的，一律不认，防被强行登进别人的账号。
  if (countSessionCookies(req.headers.cookie) > 1) return null;
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token || token.length > 200) return null;
  const h = sha256(token);
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(h);
  if (!s) return null;
  const now = Date.now();
  if (s.expires_at < now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h);
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  if (!user || user.disabled || user.deleted_at) return null; // 契约 §12.4：软删的账号不能登录
  let refreshed = false;
  if (now + SESSION_TTL_MS - s.expires_at > SESSION_REFRESH_MS) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(now + SESSION_TTL_MS, h);
    refreshed = true;
  }
  return { user, token, refreshed };
}

export function purgeExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

// ---- 登录失败锁定：按 用户名+IP，连续 5 次失败锁 10 分钟 ----
export const LOGIN_MAX_FAILS = 5;
export const LOGIN_LOCK_MS = 10 * 60 * 1000;

// 另加按 IP 的总失败计数：10 分钟窗口内失败 30 次锁该 IP 10 分钟，防换用户名撒网。
export const LOGIN_IP_MAX_FAILS = 30;

export class LoginLimiter {
  constructor() { this.map = new Map(); this.ipMap = new Map(); }
  key(username, ip) { return `${String(username).toLowerCase()}|${ip}`; }
  ipLocked(ip) {
    const e = this.ipMap.get(ip);
    if (!e) return false;
    const now = Date.now();
    if (e.lockedUntil > now) return true;
    if (e.lockedUntil || e.windowStart + LOGIN_LOCK_MS < now) this.ipMap.delete(ip);
    return false;
  }
  /** 返回 true = 这次失败让该 IP 刚好进入锁定。 */
  ipFail(ip) {
    const now = Date.now();
    let e = this.ipMap.get(ip);
    if (!e || e.windowStart + LOGIN_LOCK_MS < now) e = { fails: 0, windowStart: now, lockedUntil: 0 };
    e.fails += 1;
    let justLocked = false;
    if (e.fails >= LOGIN_IP_MAX_FAILS) { justLocked = !(e.lockedUntil > now); e.lockedUntil = now + LOGIN_LOCK_MS; }
    this.ipMap.set(ip, e);
    if (this.ipMap.size > 10000) {
      for (const [k, v] of this.ipMap) if (v.lockedUntil < now && v.windowStart + LOGIN_LOCK_MS < now) this.ipMap.delete(k);
    }
    return justLocked;
  }
  isLocked(username, ip) {
    if (this.ipLocked(ip)) return true;
    const e = this.map.get(this.key(username, ip));
    if (!e || !e.lockedUntil) return false;
    if (e.lockedUntil > Date.now()) return true;
    this.map.delete(this.key(username, ip));
    return false;
  }
  /** 记一次失败。返回这次失败触发的锁定：{ user: 用户名+IP 刚被锁, ip: 整个 IP 刚被锁 }（给日志 auth.lockout 用）。 */
  fail(username, ip) {
    const ipLocked = this.ipFail(ip);
    const k = this.key(username, ip);
    const e = this.map.get(k) || { fails: 0, lockedUntil: 0 };
    e.fails += 1;
    let userLocked = false;
    if (e.fails >= LOGIN_MAX_FAILS) { e.lockedUntil = Date.now() + LOGIN_LOCK_MS; e.fails = 0; userLocked = true; }
    this.map.set(k, e);
    if (this.map.size > 10000) this.sweep();
    return { user: userLocked, ip: ipLocked };
  }
  succeed(username, ip) { this.map.delete(this.key(username, ip)); }
  sweep() {
    const now = Date.now();
    for (const [k, e] of this.map) if (!e.lockedUntil || e.lockedUntil < now) this.map.delete(k);
  }
}

/** 账号角色（契约 §9）：super | admin | tenant。未知值一律按 tenant 处理（最小权限）。 */
export function roleOf(u) {
  const r = u?.role;
  return r === 'super' || r === 'admin' ? r : 'tenant';
}

export function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name || u.username,
    role: roleOf(u),
    is_admin: roleOf(u) !== 'tenant' ? 1 : 0, // 兼容旧前端；鉴权一律看 role
    nsfw_enabled: u.nsfw_enabled ? 1 : 0,
    persona_name: u.persona_name || '',
    persona_desc: u.persona_desc || '',
    default_model_id: u.default_model_id ?? null,
    must_change_password: !!u.must_change_password, // 契约 §13.3：首次登录强制改密
    voice_auto_send: !!u.voice_auto_send, // 契约 §18.3：语音识别后直接发送（默认关）
    reading_settings: readingSettingsFromJson(u.reading_settings_json),
  };
}

export const USERNAME_RE = /^[A-Za-z0-9_.-]{2,32}$/;
