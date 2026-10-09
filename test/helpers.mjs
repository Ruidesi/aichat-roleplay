// 测试公用：端口挑选、临时目录、简单的 cookie 客户端、SSE 解析。
import net from 'node:net';
import { mkdirSync, rmSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.mjs';

function tryListen(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

/** 通配地址和 127.0.0.1 都能绑上才算空闲（别人只占 127.0.0.1 时，通配地址也能绑上）。 */
export async function portFree(port) {
  return (await tryListen(port, '127.0.0.1')) && (await tryListen(port));
}

export async function pickPort(candidates) {
  for (const p of candidates) if (await portFree(p)) return p;
  throw new Error('44982–44989 都被占用了');
}

/** 每个测试文件一个独立的临时目录：.tmp-backend/<name>-<pid>。 */
export function tmpDir(name) {
  const dir = path.join(ROOT, '.tmp-backend', `${name}-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupTmp(dir) {
  rmSync(dir, { recursive: true, force: true });
  try { rmdirSync(path.dirname(dir)); } catch { /* 还有别的测试在用 */ }
}

export class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.bodies = []; }
  async req(method, p, body, headers = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(this.base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) { const m = /ac_sid=([^;]*)/.exec(sc); if (m) this.cookie = m[1] ? `ac_sid=${m[1]}` : ''; }
    const text = await r.text();
    this.bodies.push(text);
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  }
  get(p, h) { return this.req('GET', p, undefined, h); }
  post(p, b = {}, h) { return this.req('POST', p, b, h); }
  patch(p, b = {}, h) { return this.req('PATCH', p, b, h); }
  del(p, h) { return this.req('DELETE', p, undefined, h); }
}

export function parseSse(text) {
  const events = [];
  for (const block of text.split(/\n\n/)) {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length) { let d = data.join('\n'); try { d = JSON.parse(d); } catch { /* keep */ } events.push({ event, data: d }); }
  }
  return events;
}

/** 在候选端口里挑一个能 listen 上的（并行测试抢端口时遇到 EADDRINUSE 自动换下一个）。返回端口号。 */
export async function listenFree(server, candidates, host = '127.0.0.1') {
  for (const p of candidates) {
    if (!(await portFree(p))) continue;
    const ok = await new Promise((resolve) => {
      const onErr = () => resolve(false);
      server.once('error', onErr);
      server.listen(p, host, () => { server.off('error', onErr); resolve(true); });
    });
    if (ok) return p;
  }
  throw new Error('44982–44989 都被占用了');
}
