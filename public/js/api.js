// 与服务端通信。所有错误统一抛 ApiError（message 已是中文）。
import { zh } from '/i18n/zh.js';

export class ApiError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.status = status;
    this.code = code || ''; // 例如 refused / upstream / timeout（契约 §8.4）
  }
}

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }
// 首次登录未改初始密码：服务端除少数接口外一律 403 code=must_change_password（契约 §13.3）
let onMustChange = null;
export function setMustChangeHandler(fn) { onMustChange = fn; }
function checkMustChange(err) {
  if (err && err.status === 403 && err.code === 'must_change_password' && onMustChange) onMustChange();
}

async function readError(res) {
  let msg = '';
  let code = '';
  try {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const j = await res.json();
      msg = j && j.error;
      code = (j && typeof j.code === 'string' && j.code) || '';
    }
  } catch { /* 忽略 */ }
  if (!msg) msg = res.status >= 500 ? zh.server_error : zh.network_error;
  return new ApiError(msg, res.status, code);
}

export async function api(method, path, body, opts = {}) {
  const init = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin', signal: opts.signal };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new ApiError(zh.network_error, 0);
  }
  if (!res.ok) {
    const err = await readError(res);
    if (res.status === 401 && !opts.allow401 && onUnauthorized) onUnauthorized();
    checkMustChange(err);
    throw err;
  }
  if (res.status === 204) return {};
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return {};
  return res.json();
}

export const get = (p, o) => api('GET', p, undefined, o);
export const post = (p, b = {}, o) => api('POST', p, b, o);
export const patch = (p, b = {}, o) => api('PATCH', p, b, o);
export const put = (p, b = {}, o) => api('PUT', p, b, o);
export const del = (p, o) => api('DELETE', p, undefined, o);

/** 上传二进制 / 文件（头像、导入卡片）：原始请求体 + 对应 Content-Type，返回 JSON */
export async function upload(path, body, contentType, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': contentType || 'application/octet-stream' },
      body,
      signal: opts.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new ApiError(zh.network_error, 0);
  }
  if (!res.ok) {
    const err = await readError(res);
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    checkMustChange(err);
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : {};
}

// chub 路径（含 /）按段编码
export const encPath = (p) => String(p || '').split('/').map(encodeURIComponent).join('/');

/**
 * POST 一个 SSE 流（fetch + ReadableStream）。
 * onEvent(eventName, data) 对每个事件回调；返回 Promise，流结束时 resolve。
 * HTTP 非 2xx 时抛 ApiError；中断时抛 AbortError。
 */
export async function postStream(path, body, { signal, onEvent }) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body || {}),
      signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new ApiError(zh.network_error, 0);
  }
  if (!res.ok) {
    const err = await readError(res);
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    checkMustChange(err);
    throw err;
  }
  await readSse(res, signal, onEvent);
}

/**
 * POST JSON，服务端按习惯可能回 JSON，也可能回 SSE（契约 §17.4「SSE 或同步均可」）。
 * 回 JSON 时返回解析后的对象；回 SSE 时逐个事件交给 onEvent，结束后返回 {}。
 */
export async function postJsonOrStream(path, body, { signal, onEvent } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body || {}),
      signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new ApiError(zh.network_error, 0);
  }
  if (!res.ok) {
    const err = await readError(res);
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    checkMustChange(err);
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) { await readSse(res, signal, onEvent || (() => {})); return {}; }
  if (ct.includes('application/json')) return res.json();
  return {};
}

/**
 * 上传 FormData（多文件），带上传进度。onProgress(0–100)；上传完成、等待服务端处理时回调 onProgress(null)。
 */
export function uploadForm(path, form, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100))); };
      xhr.upload.onload = () => onProgress(null);
    }
    const abort = () => xhr.abort();
    if (signal) signal.addEventListener('abort', abort, { once: true });
    xhr.onabort = () => { const a = new Error('aborted'); a.name = 'AbortError'; reject(a); };
    xhr.onerror = () => reject(new ApiError(zh.network_error, 0));
    xhr.ontimeout = () => reject(new ApiError(zh.network_error, 0));
    xhr.onload = () => {
      if (signal) signal.removeEventListener('abort', abort);
      let j = null;
      const ct = xhr.getResponseHeader('content-type') || '';
      if (ct.includes('application/json')) { try { j = JSON.parse(xhr.responseText); } catch { j = null; } }
      if (xhr.status >= 200 && xhr.status < 300) { resolve(j || {}); return; }
      const msg = (j && j.error) || (xhr.status >= 500 ? zh.server_error : zh.network_error);
      const err = new ApiError(msg, xhr.status, (j && typeof j.code === 'string' && j.code) || '');
      if (xhr.status === 401 && onUnauthorized) onUnauthorized();
      checkMustChange(err);
      reject(err);
    };
    xhr.send(form);
  });
}

async function readSse(res, signal, onEvent) {
  if (!res.body) throw new ApiError(zh.server_error, res.status);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const flush = (block) => {
    let event = 'message';
    const data = [];
    for (const raw of block.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i === -1 ? line : line.slice(0, i);
      let val = i === -1 ? '' : line.slice(i + 1);
      if (val.startsWith(' ')) val = val.slice(1);
      if (field === 'event') event = val;
      else if (field === 'data') data.push(val);
    }
    if (!data.length) return;
    const text = data.join('\n');
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { text }; }
    onEvent(event, parsed);
  };
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      if (signal && signal.aborted) { const a = new Error('aborted'); a.name = 'AbortError'; throw a; }
      throw new ApiError(zh.network_error, 0);
    }
    const { value, done } = chunk;
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      flush(block);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) flush(buf);
}
