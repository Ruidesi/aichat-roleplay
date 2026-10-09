// 同端口 http/https demux（样板：project-registry/server.mjs）+ 明文浏览器导航跳 https。
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 只对浏览器导航（GET/HEAD + Accept 含 text/html + Host 是域名 + 非 upgrade）做 308 跳 https；
 * /healthz、API、curl、IP/localhost 访问一律放行。返回 true 表示已响应。
 */
export function redirectPlainToHttps(req, res) {
  if (req.socket.encrypted) return false;
  const host = String(req.headers.host || '');
  const name = host.replace(/:\d+$/, '');
  if (!name || name === 'localhost' || name.startsWith('[') || /^[\d.]+$/.test(name)) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.headers.upgrade) return false;
  if (!String(req.headers.accept || '').includes('text/html')) return false;
  if ((req.url || '').split('?')[0] === '/healthz') return false;
  const target = `https://${host}${req.url}`;
  res.writeHead(308, { Location: target, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`Redirecting to ${target}\n`);
  return true;
}

export const FIRST_BYTE_TIMEOUT_MS = 10000;

export function startServer({ handle, port, sslDir, label = 'AI 角色聊天', host, firstByteTimeoutMs = FIRST_BYTE_TIMEOUT_MS }) {
  const httpServer = http.createServer((req, res) => { if (redirectPlainToHttps(req, res)) return; handle(req, res); });
  httpServer.on('clientError', (e, socket) => { if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
  const keyFile = path.join(sslDir, 'chat.example.com.key');
  const certFile = path.join(sslDir, 'chat.example.com_bundle.pem');
  if (existsSync(keyFile) && existsSync(certFile)) {
    const httpsServer = https.createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, handle);
    httpsServer.on('tlsClientError', () => { /* 忽略握手失败 */ });
    // 首字节 0x16 = TLS ClientHello → https；否则 http。同一端口。
    const demux = net.createServer((socket) => {
      socket.on('error', () => socket.destroy());
      // 首字节到之前 http/https 的 headersTimeout 还没接管：10 秒不发数据就断开，防慢速连接耗尽描述符。
      const onIdle = () => socket.destroy();
      socket.setTimeout(firstByteTimeoutMs, onIdle);
      socket.once('data', (chunk) => {
        socket.setTimeout(0);
        socket.off('timeout', onIdle); // 交给 http/https server 自带的 headersTimeout/requestTimeout
        socket.pause();
        socket.unshift(chunk);
        (chunk[0] === 0x16 ? httpsServer : httpServer).emit('connection', socket);
        process.nextTick(() => socket.resume());
      });
    });
    demux.on('close', () => { httpServer.close(); httpsServer.close(); });
    demux.listen(port, host, () => console.log(`${label} http(s)://0.0.0.0:${port}`));
    return demux;
  }
  httpServer.listen(port, host, () => console.log(`${label} http://0.0.0.0:${port}（无证书，仅 http）`));
  return httpServer;
}
