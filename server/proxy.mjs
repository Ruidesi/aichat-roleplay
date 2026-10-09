// 出站 HTTP CONNECT 代理（契约 §10.1），零依赖：
//   http.request(CONNECT 目标:443) → 拿到隧道 socket → tls.connect({socket, servername}) 照常校验证书 → 在 TLS 上发 HTTP/1.1 请求。
// 返回标准 Response（body 是 Web 流，支持 SSE 逐段读取），与 fetch / pinnedFetch 通用。超时与中断都走 AbortSignal。
import http from 'node:http';
import tls from 'node:tls';
import { Readable } from 'node:stream';
import { HttpError } from './util.mjs';

export const DEFAULT_PROXY_URL = 'http://127.0.0.1:42001';
const CONNECT_TIMEOUT_MS = 15000;

/**
 * 代理地址只允许本机：http://127.0.0.1:<port> 或 http://localhost:<port>。
 * 返回规范化地址（http://host:port），空值返回 null，其他抛 400。
 */
export function checkProxyUrl(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.length > 100) throw new HttpError(400, '出站代理地址不正确');
  // 按原文严格匹配（不让 URL 规范化把 0x7f000001、127.1 之类变成 127.0.0.1）。
  const m = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})\/?$/i.exec(s);
  if (!m) {
    if (!/^http:\/\//i.test(s)) throw new HttpError(400, '出站代理只支持 http://127.0.0.1:端口 或 http://localhost:端口');
    throw new HttpError(400, '出站代理只支持本机地址（127.0.0.1 或 localhost）并且必须带端口');
  }
  const host = m[1].toLowerCase();
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, '出站代理端口不正确');
  return `http://${host}:${port}`;
}

function abortError(signal) {
  return signal?.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' });
}

/** 建隧道 + TLS 握手，返回已握手的 TLSSocket。 */
function openTunnel(proxy, target, { ca, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let done = false;
    let tunnelSocket = null;
    let tlsSocket = null;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (err) {
        try { req.destroy(); } catch { /* ignore */ }
        tlsSocket?.destroy();
        tunnelSocket?.destroy();
        reject(err);
      } else resolve(val);
    };
    const onAbort = () => finish(abortError(signal));
    const timer = setTimeout(() => finish(Object.assign(new Error('proxy connect timeout'), { code: 'EPROXYTIMEOUT' })), timeoutMs);
    const authority = `${target.hostname.includes(':') ? `[${target.hostname}]` : target.hostname}:${target.port || 443}`;
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: 'CONNECT',
      path: authority,
      headers: { Host: authority },
      agent: false,
    });
    req.on('connect', (res, socket, head) => {
      tunnelSocket = socket;
      if (res.statusCode !== 200) {
        return finish(Object.assign(new Error(`proxy CONNECT failed: ${res.statusCode}`), { code: 'EPROXYCONNECT', proxy_status: res.statusCode }));
      }
      if (head && head.length) socket.unshift(head);
      // 证书照常校验（rejectUnauthorized 默认 true）；ca 只给测试用来信任自签证书。
      tlsSocket = tls.connect({ socket, servername: target.hostname, ALPNProtocols: ['http/1.1'], ...(ca ? { ca } : {}) });
      tlsSocket.once('secureConnect', () => finish(null, tlsSocket));
      tlsSocket.once('error', (e) => finish(e));
    });
    req.on('error', (e) => finish(e));
    req.on('response', (res) => { res.resume(); finish(Object.assign(new Error('proxy did not tunnel'), { code: 'EPROXYCONNECT' })); });
    if (signal) {
      if (signal.aborted) { finish(abortError(signal)); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  });
}

/**
 * @param {object} [o]
 * @param {string|Buffer|Array} [o.ca]  额外信任的根证书（只给测试用）；不影响全局校验
 * @param {number} [o.connectTimeoutMs]  建隧道 + TLS 握手的超时
 * @returns {(url:string, init:{proxyUrl:string, method?:string, headers?:object, body?:string, signal?:AbortSignal}) => Promise<Response>}
 */
export function createProxyFetch({ ca, connectTimeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  return async function proxyFetch(url, { proxyUrl, method = 'GET', headers = {}, body, signal } = {}) {
    const target = new URL(url);
    if (target.protocol !== 'https:') throw new TypeError('only https is allowed');
    const proxy = new URL(checkProxyUrl(proxyUrl) || '');
    if (signal?.aborted) throw abortError(signal);
    const sock = await openTunnel(proxy, target, { ca, signal, timeoutMs: connectTimeoutMs });
    return new Promise((resolve, reject) => {
      const h = { ...headers, Host: target.host, Connection: 'close' };
      if (body !== undefined && body !== null) h['Content-Length'] = Buffer.byteLength(body);
      let settled = false;
      const onAbort = () => { const e = abortError(signal); req.destroy(e); sock.destroy(); if (!settled) { settled = true; reject(e); } };
      // 在已握手的 TLS socket 上发 HTTP/1.1（明文协议走加密通道 = HTTPS）。
      const req = http.request({
        method,
        host: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        headers: h,
        // 不传 agent：只有 agent 为空时 http.request 才用 createConnection（agent:false 会新建 Agent 而忽略它，直连目标）。
        createConnection: () => sock,
      }, (res) => {
        settled = true;
        const rh = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((x) => rh.append(k, x));
          else if (v !== undefined) rh.set(k, String(v));
        }
        const status = res.statusCode || 502;
        const noBody = method === 'HEAD' || status === 204 || status === 205 || status === 304;
        const cleanup = () => { signal?.removeEventListener?.('abort', onAbort); sock.destroy(); };
        res.once('end', cleanup);
        res.once('close', cleanup);
        if (noBody) res.resume();
        try {
          resolve(new Response(noBody ? null : Readable.toWeb(res), { status: status >= 200 && status <= 599 ? status : 502, statusText: res.statusMessage || '', headers: rh }));
        } catch (e) { res.destroy(); cleanup(); reject(e); }
      });
      req.on('error', (e) => {
        sock.destroy();
        signal?.removeEventListener?.('abort', onAbort);
        if (!settled) { settled = true; reject(signal?.aborted ? abortError(signal) : e); }
      });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (body !== undefined && body !== null) req.end(body); else req.end();
    });
  };
}
