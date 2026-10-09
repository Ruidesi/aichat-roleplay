// 44970 目录授权 API 读取器：只读 GET/HEAD /raw，接口与 nasReader 兼容（read/size/close）。
// 密钥只在服务端内存与 Authorization 头里；不进 URL、日志、错误信息、返回值。
// 失败分两类：404 = 图片不存在（不兜底）；其余抛 fallback 错误，由调用方这一次改走 SMB。
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { HttpError } from './util.mjs';
import { MIRROR_IMAGE_MAX_BYTES } from './mirror-images.mjs';

export const NAS_API_DEFAULT_BASE = 'http://127.0.0.1:44970/openapi/v1';
const KEY_RE = /^nasc_[A-Za-z0-9]{4,32}_[A-Za-z0-9_-]{16,128}$/;
const RETRY_STATUS = new Set([429, 502, 503]);
const RESET_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'UND_ERR_CLOSED']);
const ERROR_BODY_MAX = 64 * 1024;

const notFound = () => Object.assign(new HttpError(404, '没有找到这张图片', 'image_not_found'), { reason: 'not_found' });
// breaker=false：与 44970 健康无关（路径不合法、排队满、主动中止、没配密钥），不计入熔断。
function fallback(reason, { status = 0, breaker = true } = {}) {
  return Object.assign(new Error('NAS 接口暂时不可用，改走 SMB'), { fallback: true, reason, status, breaker });
}

/** 从 env 文件文本里取 NAS_API_KEY；格式不对返回 null。 */
export function parseNasApiKey(text) {
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?NAS_API_KEY\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    const v = m[1].replace(/^(['"])(.*)\1$/, '$2');
    return KEY_RE.test(v) ? v : null;
  }
  return null;
}

/** rel（相对 mirrorImageDir）→ API 路径；不合法返回 null。 */
export function nasApiPath(remoteRoot, rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 1024 || /[\x00-\x1f\x7f\\]/.test(rel)) return null;
  const parts = rel.split('/');
  if (parts.some(p => !p || p.startsWith('.'))) return null; // 含 . / .. / 点开头的段
  const full = `${remoteRoot}/${parts.join('/')}`;
  return full.length <= 1024 ? full : null;
}

function retryAfterMs(value, attempt) {
  const base = 200 * 2 ** attempt + Math.floor(Math.random() * 100);
  if (!value) return base;
  const s = Number(value);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(3000, Math.max(100, ms)) : base;
}

export function createNasApiReader({ baseUrl = NAS_API_DEFAULT_BASE, keyFile, remoteRoot, maxConcurrent = 16, maxPending = 512,
  timeoutMs = 6000, maxBytes = MIRROR_IMAGE_MAX_BYTES, fetch: fetchImpl = globalThis.fetch, now = Date.now,
  logger = console, warnIntervalMs = 5 * 60 * 1000, keyRetryMs = 60 * 1000 } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/?#]+(\/[^?#]*)?$/.test(base)) throw new TypeError('NAS 接口地址不正确');
  const root = String(remoteRoot || '').replace(/\/+$/, '');
  if (!root || root.length > 900 || /[\x00-\x1f\x7f\\]/.test(root) || root.split('/').some(p => !p || p.startsWith('.'))) throw new TypeError('NAS 授权目录不正确');
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 24) throw new RangeError('并发参数不正确');
  if (typeof fetchImpl !== 'function') throw new TypeError('缺少 fetch');
  let key = null, keyCheckedAt = 0, keyLoading = null, closed = false, active = 0;
  const queue = [], controllers = new Set(), warned = new Map();
  const counters = { requests: 0, retries: 0, resets: 0, fallbacks: 0 };

  function warn(kind, message) {
    const t = now();
    if (t - (warned.get(kind) ?? -Infinity) < warnIntervalMs) return;
    warned.set(kind, t);
    try { logger?.warn?.(`[nas-api] ${message}`); } catch { /* 日志失败不影响读取 */ }
  }
  function loadKeySync() {
    keyCheckedAt = now();
    try { key = parseNasApiKey(readFileSync(keyFile, 'utf8')); } catch { key = null; }
  }
  async function reloadKey() {
    // 并发 401 只读一次文件；用户换了密钥不必重启。
    keyLoading ||= (async () => {
      keyCheckedAt = now();
      try { key = parseNasApiKey(await readFile(keyFile, 'utf8')); } catch { key = null; }
    })().finally(() => { keyLoading = null; });
    await keyLoading;
    return key;
  }
  async function currentKey() {
    if (key) return key;
    if (keyFile && now() - keyCheckedAt >= keyRetryMs) await reloadKey();
    return key;
  }
  if (keyFile) loadKeySync();

  function acquire(signal) {
    if (closed) return Promise.reject(fallback('closed', { breaker: false }));
    if (signal?.aborted) return Promise.reject(fallback('aborted', { breaker: false }));
    if (active < maxConcurrent) { active++; return Promise.resolve(); }
    if (queue.length >= maxPending) return Promise.reject(fallback('queue_full', { breaker: false }));
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, signal, onAbort: null };
      item.onAbort = () => { const i = queue.indexOf(item); if (i >= 0) queue.splice(i, 1); reject(fallback('aborted', { breaker: false })); };
      signal?.addEventListener('abort', item.onAbort, { once: true });
      queue.push(item);
    });
  }
  function release() {
    const next = queue.shift();
    if (next) { next.signal?.removeEventListener('abort', next.onAbort); next.resolve(); } else active--;
  }

  async function drainSmall(res) {
    // 错误回应体很小，读完让连接留在池里复用；过大才放弃。
    try {
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > ERROR_BODY_MAX) await res.body?.cancel();
      else await res.arrayBuffer();
    } catch { /* ignore */ }
  }
  async function readBody(res, declared) {
    const chunks = []; let length = 0;
    for await (const chunk of res.body) {
      length += chunk.byteLength;
      if (length > maxBytes) throw notFound();
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
    if (declared !== null && length !== declared) throw fallback('length');
    return Buffer.concat(chunks, length);
  }

  async function request(method, rel, signal) {
    const apiPath = nasApiPath(root, rel);
    if (!apiPath) throw fallback('invalid_path', { breaker: false });
    let token = await currentKey();
    if (!token) { warn('no_key', '密钥文件缺失或格式不对，镜像图片改走 SMB'); throw fallback('no_key', { breaker: false }); }
    await acquire(signal);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    controllers.add(controller);
    const deadline = now() + timeoutMs;
    const url = `${base}/raw?path=${encodeURIComponent(apiPath)}`;
    const stopped = () => timedOut ? fallback('timeout') : fallback(closed ? 'closed' : 'aborted', { breaker: false });
    let retried401 = false, resetRetried = false, retries = 0;
    try {
      for (;;) {
        if (controller.signal.aborted) throw stopped();
        let res;
        counters.requests++;
        try {
          res = await fetchImpl(url, { method, headers: { authorization: `Bearer ${token}` }, signal: controller.signal, redirect: 'manual' });
        } catch (e) {
          if (controller.signal.aborted) throw stopped();
          const code = e?.cause?.code || e?.code;
          // 复用连接上被对端断开（44970/NAS 工作进程重启）：GET/HEAD 幂等，直接重试一次。
          if (!resetRetried && RESET_CODES.has(code)) { resetRetried = true; counters.resets++; continue; }
          throw fallback(code === 'ECONNREFUSED' ? 'refused' : 'network');
        }
        const status = res.status;
        if (status === 200) {
          const raw = res.headers.get('content-length');
          const declared = raw === null ? null : /^\d+$/.test(raw) ? Number(raw) : NaN;
          if (Number.isNaN(declared)) { await drainSmall(res); throw fallback('length'); }
          if (declared !== null && declared > maxBytes) { await res.body?.cancel().catch(() => {}); throw notFound(); }
          if (method === 'HEAD') {
            if (declared === null) throw fallback('length');
            return declared;
          }
          try { return await readBody(res, declared); } catch (e) {
            if (e?.status === 404 || e?.fallback) { await res.body?.cancel().catch(() => {}); throw e; }
            if (controller.signal.aborted) throw stopped();
            throw fallback('length'); // 中途断开/长度不符：不发半截
          }
        }
        await drainSmall(res);
        if (status === 404 || status === 413) throw notFound();
        if (status === 401) {
          if (!retried401) {
            retried401 = true;
            const fresh = await reloadKey();
            if (fresh && fresh !== token) { token = fresh; continue; }
          }
          warn('401', '密钥无效、已作废或已过期（401），镜像图片改走 SMB');
          throw fallback('unauthorized', { status });
        }
        if (status === 403) { warn('403', '密钥没有这个目录的授权或来源不允许（403），镜像图片改走 SMB'); throw fallback('forbidden', { status }); }
        if (RETRY_STATUS.has(status) && retries < 2) {
          const wait = retryAfterMs(res.headers.get('retry-after'), retries);
          if (now() + wait >= deadline) throw fallback('busy', { status });
          retries++; counters.retries++;
          await new Promise(resolve => {
            const t = setTimeout(done, wait);
            function done() { clearTimeout(t); controller.signal.removeEventListener('abort', done); resolve(); }
            controller.signal.addEventListener('abort', done, { once: true });
          });
          continue;
        }
        throw fallback(RETRY_STATUS.has(status) ? 'busy' : `http_${status}`, { status, breaker: status !== 400 });
      }
    } catch (e) {
      if (e?.fallback) counters.fallbacks++;
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      controllers.delete(controller);
      release();
    }
  }

  return {
    read: (rel, { signal } = {}) => request('GET', rel, signal),
    size: (rel, { signal } = {}) => request('HEAD', rel, signal),
    available: () => !closed && !!key,
    stats: () => ({ active, queued: queue.length, keyLoaded: !!key, ...counters }),
    close() {
      closed = true;
      for (const c of controllers) c.abort();
      for (const item of queue.splice(0)) { item.signal?.removeEventListener('abort', item.onAbort); item.reject(fallback('closed', { breaker: false })); }
      return Promise.resolve();
    },
  };
}
