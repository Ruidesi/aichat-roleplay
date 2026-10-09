// v0.9（契约 §15）：抓取监控代理。全部对着本测试自己起的假控制服务（44982–44989），绝不碰真实 17990。
// 覆盖：权限（tenant 403 / 未登录 401 / admin 只读 / super 可写）、Bearer 转发、token 不外泄、路径白名单（防路径注入）、
// 配置白名单、上游不在线 / 超时 / 鉴权失败 / 响应过大、本机路径脱敏、写操作日志、CSRF。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
import { openDb } from '../server/db.mjs';
import { hashPassword } from '../server/auth.mjs';
import { createApp } from '../server/app.mjs';
import { nowIso } from '../server/util.mjs';
import { loadConfig } from '../server/config.mjs';
import { parseControlUrl, scrubPaths, sanitizeConfigPatch, createCrawlerClient } from '../server/crawler.mjs';
import { tmpDir, cleanupTmp, listenFree, Client, portFree } from './helpers.mjs';

const PORTS = [44989, 44988, 44987, 44986, 44985, 44984, 44983, 44982];
const TOKEN = 'T0KEN-for-tests-' + 'a1b2c3d4e5f6a7b8c9d0';
const STATUS = {
  running: true, pid: 4242, phases: { list: { state: 'done' }, card: { state: 'running', etaSec: 100 } },
  storage: { db: { path: '/Volumes/EXAMPLE/aichat-mirror/mirror.sqlite', bytes: 10 }, nasDir: '/Users/someone/mnt/nas2/m2/aichat-mirror', nas: { path: '/Users/someone/mnt/x', free: 5 },
    spool: { dir: '/Volumes/EXAMPLE/aichat-mirror/spool', pendingFiles: 3, pendingBytes: 300, lastError: '读取 /Volumes/EXAMPLE/aichat-mirror/spool/item.part 失败' } },
  pool: { dir: '/Users/someone/.local/aichat-proxy', total: 68, error: 'ENOENT: open /Users/someone/.local/aichat-proxy/pool.json' },
  config: { per_exit_rps: 1, file: '/Volumes/EXAMPLE/aichat-mirror/crawler-config.json' },
  events: [{ kind: 'x', detail: { url: 'https://api.chub.ai/search?page=1' } }],
};

let dir, db, server, base, ctl, ctlPort, tokenFile;
const who = {};
const seen = []; // 假控制服务收到的请求
let ctlMode = 'ok';

function startControl() {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
      const send = (code, obj, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'x-secret-header': 'leak-me', ...extra }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: '未授权' });
      if (ctlMode === 'slow') return; // 不回应 → 超时
      if (ctlMode === 'huge') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(`{"x":"${'a'.repeat(5 * 1024 * 1024)}"}`); return; }
      if (ctlMode === 'err500') return send(500, { error: 'boom at /Users/someone/secret/file.js' });
      if (req.method === 'GET' && req.url === '/status') return send(200, STATUS);
      if (req.method === 'GET' && req.url === '/exits') return send(200, { pool: { dir: '/Users/someone/.local/aichat-proxy', total: 68 }, exits: [{ id: 'direct', name: '直连' }, { id: '7001', name: 'n1' }] });
      if (req.method === 'PUT' && req.url === '/config') {
        const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (b.per_exit_rps === 999) return send(400, { error: 'per_exit_rps: 应为 0.01–100' });
        return send(200, { ok: true, config: { ...b, file: '/Volumes/EXAMPLE/x.json' } });
      }
      if (req.method === 'POST' && /^\/exits\/9999\//.test(req.url)) return send(404, { error: '没有出口 9999' });
      if (req.method === 'POST') return send(200, { ok: true, path: req.url });
      return send(404, { error: '没有这个接口' });
    });
  });
}

async function login(c, u, p) {
  db.prepare('UPDATE users SET must_change_password = 0 WHERE username = ?').run(u);
  const r = await c.post('/api/login', { username: u, password: p });
  assert.equal(r.status, 200, r.text);
  return c;
}

before(async () => {
  dir = tmpDir('unit-crawler');
  tokenFile = path.join(dir, 'crawler-control.token');
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  ctl = startControl();
  ctlPort = await listenFree(ctl, PORTS);
  db = openDb(path.join(dir, 'aichat.sqlite'));
  const ins = db.prepare('INSERT INTO users(username, password_hash, display_name, is_admin, role, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run('root', hashPassword('root-pass-1'), '超管', 1, 'super', nowIso());
  ins.run('adm', hashPassword('adm-pass-12'), '管理', 1, 'admin', nowIso());
  ins.run('ten', hashPassword('ten-pass-12'), '租户', 0, 'tenant', nowIso());
  const app = createApp({ db, chub: { async search() { return { items: [] }; } }, llm: {}, avatars: { get: async () => ({ type: 'image/png', buf: Buffer.from('x') }) },
    config: { publicDir: path.join(dir, 'pub'), deepseekModel: 'fake', dataDir: dir, crawlerControlUrl: `http://127.0.0.1:${ctlPort}`, crawlerTokenFile: tokenFile } });
  server = http.createServer(app.handle);
  base = `http://127.0.0.1:${await listenFree(server, PORTS.filter((p) => p !== ctlPort))}`;
  who.super = await login(new Client(base), 'root', 'root-pass-1');
  who.admin = await login(new Client(base), 'adm', 'adm-pass-12');
  who.tenant = await login(new Client(base), 'ten', 'ten-pass-12');
});

after(async () => {
  ctl.closeAllConnections?.();
  await new Promise((r) => ctl.close(r));
  await new Promise((r) => server.close(r));
  db.close();
  cleanupTmp(dir);
});

const lastLog = (kind) => db.prepare('SELECT * FROM logs WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind);
const allBodies = () => [who.super, who.admin, who.tenant].flatMap((c) => c.bodies).join('\n');

test('配置：默认指向本机 17990 与 token 文件；控制地址只认本机回环 http（其他一律视为未配置）', () => {
  const c = loadConfig({});
  assert.equal(c.crawlerControlUrl, 'http://127.0.0.1:17990');
  assert.match(c.crawlerTokenFile, /config\/crawler-control\.token$/);
  assert.equal(loadConfig({ CRAWLER_CONTROL_URL: 'http://127.0.0.1:44989', CRAWLER_CONTROL_TOKEN_FILE: '/x/t' }).crawlerTokenFile, '/x/t');
  assert.deepEqual(parseControlUrl('http://127.0.0.1:17990'), { host: '127.0.0.1', port: 17990 });
  assert.deepEqual(parseControlUrl('http://localhost:17990/'), { host: '127.0.0.1', port: 17990 });
  for (const bad of ['https://127.0.0.1:17990', 'http://10.0.0.1:17990', 'http://evil.com:17990', 'http://127.0.0.1:17990/status', 'http://u:p@127.0.0.1:1', 'http://127.0.0.1:1?x=1', 'file:///etc/passwd', '', null]) {
    assert.equal(parseControlUrl(bad), null, String(bad));
  }
});

test('权限：未登录 401、tenant 403；admin 能看 status / exits；写接口 admin 403 且不转发', async () => {
  const anon = new Client(base);
  assert.equal((await anon.get('/api/admin/crawler/status')).status, 401);
  assert.equal((await who.tenant.get('/api/admin/crawler/status')).status, 403);
  assert.equal((await who.tenant.get('/api/admin/crawler/exits')).status, 403);
  const r = await who.admin.get('/api/admin/crawler/status');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.online, true);
  assert.equal(r.json.can_control, false);
  assert.equal(r.json.data.pool.total, 68);
  assert.equal((await who.admin.get('/api/admin/crawler/exits')).json.data.exits.length, 2);
  const n = seen.length;
  for (const [m, p, b] of [
    ['POST', '/api/admin/crawler/phase/card/start'], ['POST', '/api/admin/crawler/pause-all'], ['POST', '/api/admin/crawler/resume-all'],
    ['PUT', '/api/admin/crawler/config', { per_exit_rps: 2 }], ['POST', '/api/admin/crawler/exits/7001/disable'],
  ]) {
    assert.equal((await who.admin.req(m, p, b ?? {})).status, 403, `${m} ${p}`);
    assert.equal((await who.tenant.req(m, p, b ?? {})).status, 403, `${m} ${p}`);
    assert.equal((await anon.req(m, p, b ?? {})).status, 401, `${m} ${p}`);
  }
  assert.equal(seen.length, n, '越权写请求一条都没转发到控制服务');
  assert.equal((await who.super.get('/api/admin/crawler/status')).json.can_control, true);
});

test('转发：带 Bearer token；本机路径全部去掉；上游响应头不回传；token 不出现在任何响应里', async () => {
  seen.length = 0;
  const r = await who.super.get('/api/admin/crawler/status');
  assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
  assert.equal(seen[0].url, '/status');
  const d = r.json.data;
  assert.equal(d.pool.dir, undefined);
  assert.equal(d.storage.nasDir, undefined);
  assert.equal(d.storage.db.path, undefined);
  assert.equal(d.storage.db.bytes, 10);
  assert.equal(d.storage.spool.dir, undefined);
  assert.equal(d.storage.spool.pendingFiles, 3);
  assert.equal(d.storage.spool.pendingBytes, 300);
  assert.match(d.storage.spool.lastError, /\[本机路径\]/);
  assert.equal(d.config.file, undefined);
  assert.equal(d.config.per_exit_rps, 1);
  assert.equal(d.events[0].detail.url, 'https://api.chub.ai/search?page=1', '普通网址不动');
  assert.ok(!/\/Users\/|\/Volumes\//.test(r.text), r.text);
  assert.match(d.pool.error, /\[本机路径\]/);
  assert.equal(r.headers.get('x-secret-header'), null);
  const ex = await who.super.get('/api/admin/crawler/exits');
  assert.ok(!/\/Users\//.test(ex.text));
  assert.ok(!allBodies().includes(TOKEN.slice(0, 12)), 'token 不外泄');
});

test('super 写操作：路径用固定模板拼，阶段 / 动作 / 出口白名单；配置只放行已知键；各记 crawler.* 日志且不含 token', async () => {
  seen.length = 0;
  let r = await who.super.post('/api/admin/crawler/phase/gallery-img/start');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([seen[0].method, seen[0].url, seen[0].auth], ['POST', '/phase/gallery-img/start', `Bearer ${TOKEN}`]);
  assert.equal(lastLog('crawler.phase_start').level, 'info');
  assert.equal((await who.super.post('/api/admin/crawler/phase/list/pause')).status, 200);
  assert.equal(seen.at(-1).url, '/phase/list/pause');
  assert.equal((await who.super.post('/api/admin/crawler/pause-all')).status, 200);
  assert.equal(seen.at(-1).url, '/pause-all');
  assert.equal((await who.super.post('/api/admin/crawler/resume-all')).status, 200);
  assert.equal(seen.at(-1).url, '/resume-all');
  assert.equal((await who.super.post('/api/admin/crawler/exits/7001/disable')).status, 200);
  assert.equal(seen.at(-1).url, '/exits/7001/disable');
  assert.equal((await who.super.post('/api/admin/crawler/exits/direct/enable', { reset_group: true })).status, 200);
  assert.equal(seen.at(-1).url, '/exits/direct/enable?reset_group=1');
  assert.equal((await who.super.post('/api/admin/crawler/exits/07001/enable')).status, 200);
  assert.equal(seen.at(-1).url, '/exits/7001/enable', '端口号规范化');
  // 路径注入 / 非白名单：本地直接 404，一条都不转发
  const n = seen.length;
  for (const p of [
    '/api/admin/crawler/phase/bogus/start', '/api/admin/crawler/phase/card/stop', '/api/admin/crawler/phase/..%2Fconfig/start',
    '/api/admin/crawler/phase/card%2F..%2F..%2Fpool/start', '/api/admin/crawler/phase/card%3Fx=1/start', '/api/admin/crawler/phase/card%23/start',
    '/api/admin/crawler/exits/..%2Fpause-all/disable', '/api/admin/crawler/exits/70000/disable', '/api/admin/crawler/exits/abc/disable',
    '/api/admin/crawler/exits/7001/reset', '/api/admin/crawler/exits/7001%2F..%2F..%2Fpause-all/enable',
  ]) {
    const x = await who.super.post(p);
    assert.equal(x.status, 404, `${p}：${x.text}`);
  }
  assert.equal((await who.super.post('/api/admin/crawler/phase/card/start/extra')).status, 404);
  assert.equal((await who.super.post('/api/admin/crawler/pool/reset-outage')).status, 404, '不在契约里的上游接口不开放');
  assert.equal((await who.super.get('/api/admin/crawler/config')).status, 405, '只开放 PUT');
  assert.equal(seen.length, n);
  // 配置
  r = await who.super.req('PUT', '/api/admin/crawler/config', { per_exit_rps: 2, hosts: { 'api.chub.ai': { max_rps: null, enabled: true } }, phase_max_workers: { card: 64 } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(JSON.parse(seen.at(-1).body), { per_exit_rps: 2, hosts: { 'api.chub.ai': { max_rps: null, enabled: true } }, phase_max_workers: { card: 64 } });
  assert.equal(r.json.result.config.file, undefined, '回包同样去路径');
  const cl = lastLog('crawler.config');
  assert.deepEqual(JSON.parse(cl.detail_json).patch.phase_max_workers, { card: 64 });
  for (const bad of [{}, { evil: 1 }, { per_exit_rps: '2' }, { per_exit_rps: [1] }, { hosts: { 'evil.com': { max_rps: 1 } } }, { hosts: { api: { token: 'x' } } },
    { phase_max_workers: { bogus: 1 } }, { phase_max_workers: { card: '1' } }, { file: '/tmp/x' }, { disabled_exits: [] }, { phases: {} }]) {
    const x = await who.super.req('PUT', '/api/admin/crawler/config', bad);
    assert.equal(x.status, 400, JSON.stringify(bad));
  }
  assert.equal(seen.filter((s) => s.method === 'PUT').length, 1, '不合法的配置不转发');
  // 上游校验失败：把抓取器的中文说明转回，记 warn
  r = await who.super.req('PUT', '/api/admin/crawler/config', { per_exit_rps: 999 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /per_exit_rps/);
  assert.equal(lastLog('crawler.config').level, 'warn');
  r = await who.super.post('/api/admin/crawler/exits/9999/disable');
  assert.equal(r.status, 404);
  assert.equal(r.json.error, '没有出口 9999');
  // 日志里没有 token
  const dump = JSON.stringify(db.prepare("SELECT * FROM logs WHERE kind LIKE 'crawler.%'").all());
  assert.ok(!dump.includes(TOKEN.slice(0, 12)));
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM logs WHERE kind LIKE 'crawler.%'").get().n >= 9);
});

test('CSRF：写接口跨站 Origin 403、非 JSON 415，均不转发', async () => {
  const n = seen.length;
  assert.equal((await who.super.post('/api/admin/crawler/pause-all', {}, { origin: 'https://evil.example' })).status, 403);
  const r = await fetch(`${base}/api/admin/crawler/pause-all`, { method: 'POST', headers: { cookie: who.super.cookie, 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(r.status, 415);
  assert.equal(seen.length, n);
});

test('上游不在线 / 超时 / 鉴权失败 / 出错 / 响应过大：查看回 200 {online:false}，写操作 503 / 502，都不泄露细节', async () => {
  // 鉴权失败：token 文件内容不对
  writeFileSync(tokenFile, 'wrong-token-0000000000\n');
  let r = await who.admin.get('/api/admin/crawler/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.online, false);
  assert.match(r.json.message, /拒绝访问/);
  // 没有 token 文件
  rmSync(tokenFile);
  r = await who.admin.get('/api/admin/crawler/status');
  assert.deepEqual([r.json.online, r.json.message], [false, '抓取服务未运行']);
  r = await who.super.post('/api/admin/crawler/pause-all');
  assert.equal(r.status, 503);
  assert.equal(r.json.error, '抓取服务未运行');
  assert.equal(lastLog('crawler.pause_all').level, 'warn');
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  // 上游 500：通用说明，不透传上游正文
  ctlMode = 'err500';
  r = await who.super.post('/api/admin/crawler/resume-all');
  assert.equal(r.status, 502);
  assert.equal(r.json.error, '抓取服务出错');
  r = await who.admin.get('/api/admin/crawler/status');
  assert.deepEqual([r.status, r.json.online], [200, false]);
  assert.ok(!r.text.includes('/Users/'));
  // 响应过大
  ctlMode = 'huge';
  r = await who.admin.get('/api/admin/crawler/status');
  assert.deepEqual([r.status, r.json.online], [200, false]);
  ctlMode = 'ok';
  // 超时（客户端单测，超时设短）
  ctlMode = 'slow';
  const slow = createCrawlerClient({ url: `http://127.0.0.1:${ctlPort}`, tokenFile, timeoutMs: 200 });
  const t = await slow.request('GET', '/status');
  assert.deepEqual(t, { offline: true, message: '抓取服务响应超时' });
  ctl.closeAllConnections?.();
  ctlMode = 'ok';
  // 端口上没人监听
  let free = null;
  for (const p of PORTS) if (p !== ctlPort && !base.endsWith(`:${p}`) && (await portFree(p))) { free = p; break; }
  if (free) {
    const off = createCrawlerClient({ url: `http://127.0.0.1:${free}`, tokenFile });
    assert.deepEqual(await off.request('GET', '/status'), { offline: true, message: '抓取服务未运行' });
  }
  // 地址不是本机回环：不发请求
  const bad = createCrawlerClient({ url: 'http://example.com:17990', tokenFile });
  assert.equal(bad.configured, false);
  assert.deepEqual(await bad.request('GET', '/status'), { offline: true, message: '抓取服务未运行' });
  assert.ok(!allBodies().includes(TOKEN.slice(0, 12)));
});

test('scrubPaths / sanitizeConfigPatch 单测', () => {
  assert.deepEqual(scrubPaths({ a: { path: '/x/y', dir: null, n: 1, s: 'see /Volumes/EXAMPLE/a.db and ~/x/y' }, file: '/a' }), { a: { n: 1, s: 'see [本机路径] and [本机路径]' } });
  assert.deepEqual(scrubPaths([{ nasDir: '/Users/x' }, 'ok']), [{}, 'ok']);
  assert.deepEqual(sanitizeConfigPatch({ use_direct: false, hosts: { images: { enabled: false } } }), { use_direct: false, hosts: { images: { enabled: false } } });
  assert.throws(() => sanitizeConfigPatch([]));
  assert.throws(() => sanitizeConfigPatch({ __proto__: { x: 1 }, per_exit_rps: 1, constructor: 1 }));
});

test('SSD暂存配置：super转发且记录，admin只读，未知路径及字符串容量不转发', async () => {
  const patch = { file_spool_enabled: true, spool_max_gb: 250, spool_reserve_gb: 64, spool_drain_paused: false };
  let r = await who.super.req('PUT', '/api/admin/crawler/config', patch);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(JSON.parse(seen.at(-1).body), patch);
  assert.deepEqual(JSON.parse(lastLog('crawler.config').detail_json).patch, patch);
  assert.equal(r.json.result.config.file, undefined);
  const n = seen.length;
  assert.equal((await who.admin.req('PUT', '/api/admin/crawler/config', patch)).status, 403);
  for (const bad of [{ spool_max_gb: '250' }, { spool_dir: '/tmp/private' }, { spool_drain_paused_by_all: true }]) {
    assert.equal((await who.super.req('PUT', '/api/admin/crawler/config', bad)).status, 400);
  }
  assert.equal(seen.length, n, '越权及未授权配置不转发');
});
