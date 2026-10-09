// 系统 / 操作日志（契约 §11）：统一写入 log()、保留期清理、查询（只给 super 的接口用）。
// 只记「谁在什么时候做了什么」：不记聊天内容、上游正文、key、密码、cookie。
// 写日志失败绝不影响业务：一律 try/catch 吞掉并 console.error。
// 本模块不 import db.mjs（db.mjs 迁移完要用 writeLog 记 system.migrate，避免循环依赖）。
import { HttpError, nowIso, sgDay, str } from './util.mjs';

export const LOG_LEVELS = ['info', 'warn', 'error'];
export const LOG_PAGE_SIZE = 50;
export const DEFAULT_LOG_RETENTION_DAYS = 90;
export const MIN_LOG_RETENTION_DAYS = 1;
export const MAX_LOG_RETENTION_DAYS = 3650;

/** 类型分组（前端下拉分组用）。 */
export const LOG_GROUPS = [
  { prefix: 'auth.', name: '登录与密码' },
  { prefix: 'user.', name: '账号' },
  { prefix: 'invite.', name: '邀请码' },
  { prefix: 'model.', name: '模型' },
  { prefix: 'shelf.', name: '精选货架' },
  { prefix: 'settings.', name: '站点设置' },
  { prefix: 'card.', name: '自建卡' },
  { prefix: 'chat.', name: '会话' },
  { prefix: 'message.', name: '消息' },
  { prefix: 'llm.', name: '对话服务' },
  { prefix: 'voice.', name: '语音输入' },
  { prefix: 'crawler.', name: '抓取' },
  { prefix: 'system.', name: '系统' },
];

/** kind → 中文名（契约 §11.2）。 */
export const LOG_KINDS = {
  'auth.login': '登录',
  'auth.lockout': '登录锁定',
  'auth.logout': '退出登录',
  'auth.password_change': '修改密码',
  'user.create': '创建账号',
  'user.update': '修改账号',
  'user.disable': '停用账号',
  'user.enable': '启用账号',
  'user.delete': '删除账号',
  'user.register': '邀请码注册',
  'user.reset_code_issued': '签发重置码',
  'user.password_reset': '用重置码重设密码',
  'invite.create': '新建邀请码',
  'invite.disable': '停用邀请码',
  'model.create': '添加模型',
  'model.update': '修改模型',
  'model.delete': '删除模型',
  'model.disable': '停用模型',
  'model.enable': '启用模型',
  'model.sync_price': '同步模型价格',
  'shelf.create': '新建货架',
  'shelf.update': '修改货架',
  'shelf.delete': '删除货架',
  'shelf.add_item': '货架添加角色',
  'shelf.remove_item': '货架移除角色',
  'shelf.reorder': '货架调整顺序',
  'settings.update': '修改设置',
  'card.create': '新建自建卡',
  'card.update': '修改自建卡',
  'card.delete': '删除自建卡',
  'card.fork': '拷贝二创',
  'card.import': '导入卡片',
  'chat.delete': '删除会话',
  'chat.file_create': '上传文件开聊',
  'chat.override_update': '修改本会话设定',
  'chat.rewind': '修改前文后重新回复',
  'message.delete': '删除消息',
  'llm.error': '对话服务出错',
  'voice.error': '语音识别出错',
  'crawler.phase_start': '抓取阶段开工',
  'crawler.phase_pause': '抓取阶段暂停',
  'crawler.pause_all': '暂停全部抓取',
  'crawler.resume_all': '恢复全部抓取',
  'crawler.config': '修改抓取配置',
  'crawler.exit_disable': '停用抓取出口',
  'crawler.exit_enable': '启用抓取出口',
  'system.start': '服务启动',
  'system.migrate': '数据库升级',
  'system.retention': '清理过期日志',
};

export const kindName = (kind) => LOG_KINDS[kind] || kind;

// ---------- 防泄漏兜底：detail 里出现这些键名一律丢掉；超长字符串截断 ----------
const SECRET_KEY_RE = /^(password|password_hash|new_password|old_password|api_key|api_key_enc|key|secret|cookie|token|token_hash|authorization)$/i;
const MAX_STR = 500;
const MAX_DEPTH = 5;

export function sanitizeDetail(v, depth = 0) {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === 'string') return v.length > MAX_STR ? `${v.slice(0, MAX_STR)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return Number(v);
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => sanitizeDetail(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEY_RE.test(k)) continue;
      out[k] = sanitizeDetail(x, depth + 1);
    }
    return out;
  }
  return String(v).slice(0, MAX_STR);
}

/** 字段变更：返回 {field, label, from, to}，前端按「label：from → to」显示。 */
export const change = (field, label, from, to) => ({ field, label, from: from ?? null, to: to ?? null });

/**
 * 写一条日志。失败只 console.error，不抛。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{level?:string, kind:string, actor?:{id?:number,display_name?:string,username?:string,name?:string}|null,
 *   actor_id?:number|null, actor_name?:string|null, target_type?:string|null, target_id?:number|string|null,
 *   ip?:string|null, summary:string, detail?:object|null, at?:string}} e
 * @returns {number|null} 新行 id
 */
export function writeLog(db, e) {
  try {
    const level = LOG_LEVELS.includes(e?.level) ? e.level : 'info';
    const kind = str(e?.kind, 64) || 'system.unknown';
    const a = e?.actor || null;
    const actorId = e?.actor_id !== undefined ? e.actor_id : (a?.id ?? null);
    const actorName = e?.actor_name !== undefined ? e.actor_name : (a ? (a.display_name || a.username || a.name || null) : null);
    let detail = null;
    if (e?.detail !== undefined && e?.detail !== null) {
      const s = sanitizeDetail(e.detail);
      detail = JSON.stringify(s);
      if (detail.length > 20000) detail = JSON.stringify({ truncated: true });
    }
    const tid = e?.target_id;
    const r = db.prepare(`INSERT INTO logs(at, level, kind, actor_id, actor_name, target_type, target_id, ip, summary, detail_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      e?.at || nowIso(), level, kind,
      Number.isInteger(Number(actorId)) && actorId !== null && actorId !== '' ? Number(actorId) : null,
      actorName === null || actorName === undefined ? null : str(actorName, 64),
      e?.target_type ? str(e.target_type, 32) : null,
      tid === null || tid === undefined || tid === '' ? null : (Number.isInteger(Number(tid)) ? Number(tid) : str(tid, 200)),
      e?.ip ? str(e.ip, 64) : null,
      str(e?.summary, 300) || kindName(kind),
      detail,
    );
    return Number(r.lastInsertRowid);
  } catch (err) {
    console.error('[log] 写日志失败：', err?.message || err);
    return null;
  }
}

/** 当前保留天数（settings.log_retention_days，非法值回落 90）。 */
export function retentionDays(db) {
  try {
    const v = db.prepare("SELECT value FROM settings WHERE key = 'log_retention_days'").get()?.value;
    return parseRetentionDays(v, { fallback: true });
  } catch { return DEFAULT_LOG_RETENTION_DAYS; }
}

/** 1–3650 的整数；fallback=true 时非法值回落默认值，否则抛 400。 */
export function parseRetentionDays(v, { fallback = false } = {}) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);
  if (Number.isInteger(n) && n >= MIN_LOG_RETENTION_DAYS && n <= MAX_LOG_RETENTION_DAYS) return n;
  if (fallback) return DEFAULT_LOG_RETENTION_DAYS;
  throw new HttpError(400, `日志保留天数必须是 ${MIN_LOG_RETENTION_DAYS}–${MAX_LOG_RETENTION_DAYS} 的整数`);
}

/**
 * 清理超过保留期的日志；删了就记一条 system.retention。失败不抛。
 * @returns {number} 删除条数
 */
export function purgeOldLogs(db, { now = Date.now() } = {}) {
  try {
    const days = retentionDays(db);
    const cutoff = new Date(now - days * 86400000).toISOString();
    const n = Number(db.prepare('DELETE FROM logs WHERE at < ?').run(cutoff).changes || 0);
    if (n > 0) {
      writeLog(db, { kind: 'system.retention', summary: `清理了 ${n} 条超过 ${days} 天的日志`, detail: { deleted: n, retention_days: days, before: cutoff } });
    }
    return n;
  } catch (err) {
    console.error('[log] 清理日志失败：', err?.message || err);
    return 0;
  }
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** 新加坡日期 YYYY-MM-DD → 当天 00:00（新加坡）的 Date。 */
function sgDayStart(day, label) {
  const d = new Date(`${day}T00:00:00+08:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(d.getTime()) || sgDay(d) !== day) throw new HttpError(400, `${label}格式不正确`);
  return d;
}

function rowView(r) {
  let detail = null;
  if (r.detail_json) { try { detail = JSON.parse(r.detail_json); } catch { detail = null; } }
  return {
    id: r.id,
    at: r.at,
    level: r.level,
    kind: r.kind,
    kind_name: kindName(r.kind),
    actor: r.actor_id === null && r.actor_name === null ? null : { id: r.actor_id ?? null, name: r.actor_name ?? null },
    target_type: r.target_type ?? null,
    target_id: r.target_id ?? null,
    ip: r.ip ?? null,
    summary: r.summary,
    detail,
  };
}

/** GET /api/admin/logs 的查询（契约 §11.3）。params 是 URLSearchParams。 */
export function queryLogs(db, params) {
  const where = [];
  const vals = [];
  const kind = str(params.get('kind'), 64).trim();
  if (kind) {
    if (!/^[a-z_]+(\.[a-z_]*)?$/.test(kind)) throw new HttpError(400, '类型参数不正确');
    if (kind.endsWith('.')) {
      where.push("kind LIKE ? ESCAPE '\\'"); vals.push(`${likeEscape(kind)}%`);
    } else {
      // 精确匹配；不带点的写法（如 user）也当前缀用。
      where.push("(kind = ? OR kind LIKE ? ESCAPE '\\')"); vals.push(kind, `${likeEscape(kind)}.%`);
    }
  }
  const level = str(params.get('level'), 16).trim();
  if (level) {
    if (!LOG_LEVELS.includes(level)) throw new HttpError(400, '级别参数不正确');
    where.push('level = ?'); vals.push(level);
  }
  const actorId = str(params.get('actor_id'), 32).trim();
  if (actorId) {
    if (!/^\d{1,15}$/.test(actorId)) throw new HttpError(400, '账号参数不正确');
    where.push('actor_id = ?'); vals.push(Number(actorId));
  }
  const q = str(params.get('q'), 200).trim();
  if (q) {
    const pat = `%${likeEscape(q)}%`;
    where.push("(summary LIKE ? ESCAPE '\\' OR actor_name LIKE ? ESCAPE '\\')"); vals.push(pat, pat);
  }
  const from = str(params.get('from'), 20).trim();
  if (from) { where.push('at >= ?'); vals.push(sgDayStart(from, '开始日期').toISOString()); }
  const to = str(params.get('to'), 20).trim();
  if (to) { where.push('at < ?'); vals.push(new Date(sgDayStart(to, '结束日期').getTime() + 86400000).toISOString()); }
  const page = Math.min(100000, Math.max(1, parseInt(params.get('page') || '1', 10) || 1));
  const rows = db.prepare(`SELECT * FROM logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`).all(...vals, LOG_PAGE_SIZE + 1, (page - 1) * LOG_PAGE_SIZE);
  return { items: rows.slice(0, LOG_PAGE_SIZE).map(rowView), page, has_more: rows.length > LOG_PAGE_SIZE };
}

/** GET /api/admin/logs/kinds：已定义的类型 + 库里出现过但不在表里的类型。 */
export function logKinds(db) {
  const items = Object.entries(LOG_KINDS).map(([kind, name]) => ({ kind, name, group: `${kind.split('.')[0]}.` }));
  try {
    for (const r of db.prepare('SELECT DISTINCT kind FROM logs').all()) {
      if (!LOG_KINDS[r.kind]) items.push({ kind: r.kind, name: r.kind, group: `${String(r.kind).split('.')[0]}.` });
    }
  } catch { /* 表不在也给静态列表 */ }
  return { items, groups: LOG_GROUPS };
}
