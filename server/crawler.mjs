// 抓取监控（契约 §15）：转发到本机抓取器控制接口（默认 http://127.0.0.1:17990）。
// 安全要点：
// - 目标只能是本机回环地址（配置项来自环境变量，不来自请求）；请求路径一律用固定模板 + 白名单参数拼出。
// - token 每次请求时从文件读，只放进上游 Authorization 头：不缓存、不进日志、不进错误信息、不回传上游响应头。
// - 上游响应体限大小、请求有超时；回给前端前去掉本机路径（存储挂载点、配置文件位置等）。
import http from 'node:http';
import fs from 'node:fs';
import { HttpError } from './util.mjs';

export const CRAWLER_OFFLINE = '抓取服务未运行';
export const CRAWLER_PHASES = ['list', 'card', 'avatar', 'fullimg', 'gallery-meta', 'gallery-img'];
export const CRAWLER_PHASE_ACTIONS = ['start', 'pause'];
export const CRAWLER_EXIT_ACTIONS = ['disable', 'enable'];
export const CRAWLER_PHASE_NAMES = {
  list: '枚举角色列表', card: '角色卡详情', avatar: '头像', fullimg: '卡图原图', 'gallery-meta': '图集信息', 'gallery-img': '图集图片',
};
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

// PUT /config 允许的顶层键（与抓取器 control.mjs 的可改键一致）；数值范围由抓取器自己校验。
export const CRAWLER_CONFIG_KEYS = [
  'per_exit_rps', 'per_exit_concurrency', 'global_max_concurrency', 'global_max_rps',
  'use_direct', 'direct_rps', 'direct_concurrency', 'prefer_cheap', 'cheap_only', 'group_by_ip',
  'cooldown_base_ms', 'cooldown_max_ms', 'neterr_before_cooldown', 'remove_after', 'remove_ms',
  'http_fail_before_cooldown', 'resource_fail_after', 'file_concurrency', 'write_queue_max_mb',
  'phase_max_workers', 'hosts',
  'file_spool_enabled', 'spool_max_gb', 'spool_reserve_gb', 'spool_drain_paused',
];
const HOST_KEYS = ['per_exit_rps', 'per_exit_concurrency', 'max_concurrency', 'max_rps', 'use_direct', 'direct_rps', 'direct_concurrency', 'enabled'];
const HOST_NAMES = ['api.chub.ai', 'avatars.charhub.io', 'images.characterhub.org', 'api', 'avatars', 'images'];

/** 控制地址只认 http://127.0.0.1:<端口> / http://localhost:<端口>（不带路径、账号、查询）；否则返回 null（视为未配置）。 */
export function parseControlUrl(s) {
  let u;
  try { u = new URL(String(s || '')); } catch { return null; }
  if (u.protocol !== 'http:' || u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  const host = u.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost') return null;
  const port = Number(u.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: '127.0.0.1', port };
}

const PATH_KEYS = new Set(['path', 'dir', 'nasDir', 'file']);
const ABS_PATH_RE = /(?:~|\/(?:Users|Volumes|private|home|tmp|var|opt|mnt|System|Library|etc|root))(?:\/[^\s"'，。；、)\]}]*)+/g;
/** 去掉本机路径：路径类键直接删掉，其余字符串里出现的绝对路径替换成占位。 */
export function scrubPaths(v, depth = 0) {
  if (depth > 20) return null;
  if (typeof v === 'string') return v.replace(ABS_PATH_RE, '[本机路径]');
  if (Array.isArray(v)) return v.map((x) => scrubPaths(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (PATH_KEYS.has(k) && (typeof x === 'string' || x === null)) continue;
      out[k] = scrubPaths(x, depth + 1);
    }
    return out;
  }
  return v;
}

/** PUT /api/admin/crawler/config 的请求体：只放行已知键与结构（数值由抓取器再校验）。 */
export function sanitizeConfigPatch(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, '请求格式不正确');
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    if (!CRAWLER_CONFIG_KEYS.includes(k)) throw new HttpError(400, `不支持的配置项：${String(k).slice(0, 40)}`);
    if (k === 'phase_max_workers') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, '各阶段并发上限格式不正确');
      out[k] = {};
      for (const [p, n] of Object.entries(v)) {
        if (!CRAWLER_PHASES.includes(p)) throw new HttpError(400, `未知阶段：${String(p).slice(0, 40)}`);
        if (typeof n !== 'number') throw new HttpError(400, '各阶段并发上限必须是数字');
        out[k][p] = n;
      }
    } else if (k === 'hosts') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, '按站点配置格式不正确');
      out[k] = {};
      for (const [h, hv] of Object.entries(v)) {
        if (!HOST_NAMES.includes(h)) throw new HttpError(400, `未知站点：${String(h).slice(0, 60)}`);
        if (!hv || typeof hv !== 'object' || Array.isArray(hv)) throw new HttpError(400, '按站点配置格式不正确');
        out[k][h] = {};
        for (const [hk, x] of Object.entries(hv)) {
          if (!HOST_KEYS.includes(hk)) throw new HttpError(400, `不支持的站点配置项：${String(hk).slice(0, 40)}`);
          if (x !== null && typeof x !== 'number' && typeof x !== 'boolean') throw new HttpError(400, '配置值必须是数字、开关或留空');
          out[k][h][hk] = x;
        }
      }
    } else {
      if (typeof v !== 'number' && typeof v !== 'boolean' && v !== null) throw new HttpError(400, '配置值必须是数字或开关');
      out[k] = v;
    }
  }
  if (!Object.keys(out).length) throw new HttpError(400, '没有要修改的配置');
  return out;
}

/**
 * 控制接口客户端。request() 结果：
 *   {ok:true, status, json}     上游 2xx
 *   {ok:false, status, error}   上游回了 4xx/5xx（error 已脱敏）
 *   {offline:true, message}     连不上 / 超时 / 没有 token / 鉴权失败 / 响应不是 JSON
 */
export function createCrawlerClient({ url, tokenFile, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  const target = parseControlUrl(url);
  const readToken = () => {
    try {
      const t = fs.readFileSync(tokenFile, 'utf8').trim();
      return t && /^[\x21-\x7e]{16,512}$/.test(t) ? t : null;
    } catch { return null; }
  };
  function request(method, pathname, body) {
    if (!target) return Promise.resolve({ offline: true, message: CRAWLER_OFFLINE });
    const token = readToken();
    if (!token) return Promise.resolve({ offline: true, message: CRAWLER_OFFLINE });
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      const req = http.request({
        host: target.host, port: target.port, path: pathname, method, agent: false,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
        },
      }, (res) => {
        const chunks = [];
        let n = 0;
        res.on('data', (c) => {
          n += c.length;
          if (n > maxBytes) { res.destroy(); finish({ offline: true, message: '抓取服务返回的数据过大' }); return; }
          chunks.push(c);
        });
        res.on('error', () => finish({ offline: true, message: CRAWLER_OFFLINE }));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 非 JSON */ }
          const status = res.statusCode || 0;
          if (status === 401 || status === 403) return finish({ offline: true, message: '抓取服务拒绝访问（控制口令不匹配）' });
          if (status >= 200 && status < 300) {
            if (json === null) return finish({ offline: true, message: CRAWLER_OFFLINE });
            return finish({ ok: true, status, json });
          }
          // 4xx：抓取器自己的校验信息（中文、不含凭据），截短并去路径后转给前端；5xx 一律通用说明。
          const msg = status < 500 && json && typeof json.error === 'string' ? scrubPaths(json.error).slice(0, 300) : '抓取服务出错';
          finish({ ok: false, status, error: msg });
        });
      });
      req.setTimeout(timeoutMs, () => { req.destroy(); finish({ offline: true, message: '抓取服务响应超时' }); });
      req.on('error', () => finish({ offline: true, message: CRAWLER_OFFLINE }));
      if (data) req.write(data);
      req.end();
    });
  }
  return { request, configured: !!target };
}
