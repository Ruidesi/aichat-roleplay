// 静态文件 + SPA 回退：未知的非 /api 路径一律回 index.html。
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { HttpError, BASE_HEADERS } from './util.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function sendFile(req, res, file, { html = false } = {}) {
  const buf = await readFile(file);
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': buf.length,
    // 无构建、无哈希文件名：一律协商缓存，发布后立即生效。
    'Cache-Control': 'no-cache',
    ...(html ? { 'X-Frame-Options': 'SAMEORIGIN' } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

export async function serveStatic(req, res, url, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '不支持的请求方式');
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, '地址不正确'); }
  if (rel.includes('\0')) throw new HttpError(400, '地址不正确');
  const root = path.resolve(publicDir);
  const target = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  if (target === root || target.startsWith(root + path.sep)) {
    try {
      const st = await stat(target);
      if (st.isFile()) return sendFile(req, res, target, { html: target.endsWith('.html') });
      if (st.isDirectory()) {
        const idx = path.join(target, 'index.html');
        const s2 = await stat(idx).catch(() => null);
        if (s2?.isFile()) return sendFile(req, res, idx, { html: true });
      }
    } catch { /* 不存在：走 SPA 回退 */ }
  }
  const index = path.join(root, 'index.html');
  const si = await stat(index).catch(() => null);
  if (!si?.isFile()) throw new HttpError(404, '页面不存在');
  return sendFile(req, res, index, { html: true });
}
