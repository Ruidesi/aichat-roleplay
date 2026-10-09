// 加固回归：头像缓存（查询串、总量上限、流式限长）、并发绕过每日上限、登录耗时一致 + 按 IP 锁、同名 cookie、demux 首字节超时。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { openDb } from '../server/db.mjs';
import { hashPassword, LoginLimiter, LOGIN_IP_MAX_FAILS, countSessionCookies } from '../server/auth.mjs';
import { createApp } from '../server/app.mjs';
import { HttpError, nowIso } from '../server/util.mjs';
import { checkAvatarUrl, createAvatarCache } from '../server/chub.mjs';
import { startServer } from '../server/net.mjs';
import { tmpDir, cleanupTmp, pickPort, Client } from './helpers.mjs';

let dir;
before(() => { dir = tmpDir('unit-hard'); });
after(() => cleanupTmp(dir));

function countFiles(d) {
  if (!existsSync(d)) return 0;
  let n = 0;
  for (const sub of readdirSync(d)) n += readdirSync(path.join(d, sub)).length;
  return n;
}

const imgResponse = (bytes, { len = true } = {}) => new Response(new Uint8Array(bytes), {
  status: 200,
  headers: { 'content-type': 'image/png', ...(len ? { 'content-length': String(bytes) } : {}) },
});

test('头像地址去掉查询串：拼不同查询串只回源一次、只存一份', async () => {
  assert.equal(checkAvatarUrl('https://avatars.charhub.io/a/b.webp?junk=1#x'), 'https://avatars.charhub.io/a/b.webp');
  let calls = 0;
  const d = path.join(dir, 'av1');
  const cache = createAvatarCache({ dir: d, fetchImpl: async () => { calls++; return imgResponse(100); } });
  for (const q of ['?junk=1', '?junk=2', '?junk=3', '']) {
    const r = await cache.get('https://avatars.charhub.io/avatars/x/avatar.webp' + q);
    assert.equal(r.buf.length, 100);
  }
  assert.equal(calls, 1);
  assert.equal(countFiles(d), 2); // 图 + .type
});

test('头像缓存总量超上限按 LRU 淘汰；重启后索引能重建', async () => {
  const d = path.join(dir, 'av2');
  const mk = () => createAvatarCache({ dir: d, maxBytes: 1000, fetchImpl: async () => imgResponse(300) });
  const cache = mk();
  await cache.get('https://avatars.charhub.io/1.png');
  await cache.get('https://avatars.charhub.io/2.png');
  await cache.get('https://avatars.charhub.io/3.png');
  await cache.get('https://avatars.charhub.io/1.png'); // 1 变成最近使用
  await cache.get('https://avatars.charhub.io/4.png'); // 超了 → 淘汰最久没用的 2
  const st = cache.stats();
  assert.ok(st.bytes <= 1000, JSON.stringify(st));
  assert.equal(st.files, 3);
  assert.equal(countFiles(d), 6);
  const again = mk();
  assert.equal(again.stats().files, 3);
  assert.ok(again.stats().bytes <= 1000);
});

test('头像没有 content-length 也会边读边计数，超限立即中止', async () => {
  const d = path.join(dir, 'av3');
  const cache = createAvatarCache({ dir: d, maxItemBytes: 1000, fetchImpl: async () => imgResponse(5000, { len: false }) });
  await assert.rejects(cache.get('https://avatars.charhub.io/big.png'), (e) => e instanceof HttpError && e.message === '头像太大');
  const cache2 = createAvatarCache({ dir: d, maxItemBytes: 1000, fetchImpl: async () => imgResponse(5000) });
  await assert.rejects(cache2.get('https://avatars.charhub.io/big2.png'), /头像太大/);
  assert.equal(countFiles(d), 0);
});

test('按 IP 的总失败计数：换用户名撒网也会被锁', () => {
  const l = new LoginLimiter();
  for (let i = 0; i < LOGIN_IP_MAX_FAILS; i++) l.fail(`u${i}`, '1.2.3.4');
  assert.equal(l.isLocked('someone-new', '1.2.3.4'), true);
  assert.equal(l.isLocked('someone-new', '5.6.7.8'), false);
});

test('同名 cookie 计数', () => {
  assert.equal(countSessionCookies('ac_sid=a; x=1'), 1);
  assert.equal(countSessionCookies('ac_sid=a; ac_sid=b'), 2);
  assert.equal(countSessionCookies(''), 0);
});

// ---------- 进程内 app ----------
const NODE = { fullPath: 't/c', name: 'C', tagline: '', avatar_url: 'https://avatars.charhub.io/a/c.webp', topics: [], nsfw_image: false,
  definition: { name: 'C', first_message: '你好' } };
const fakeChub = { async search() { return { items: [], page: 1, has_more: false }; }, async character() { return structuredClone(NODE); } };
const slowLlm = {
  async streamChat(messages, { onDelta }) {
    await new Promise((r) => setTimeout(r, 150));
    onDelta('好');
    return { text: '好', tokens_in: 1, tokens_out: 1, model: 'fake' };
  },
  async complete() { return { text: '你好', tokens_in: 1, tokens_out: 1 }; },
};

let appRuns = 0;
async function withApp(fn) {
  const d = path.join(dir, `app-${Math.random().toString(36).slice(2)}`);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(d, { recursive: true });
  const db = openDb(path.join(d, 'aichat.sqlite'));
  db.prepare('INSERT INTO users(username, password_hash, display_name, is_admin, daily_limit, created_at) VALUES (?, ?, ?, 0, 1, ?)')
    .run('lim', hashPassword('lim-pass-123'), 'L', nowIso());
  const app = createApp({ db, chub: fakeChub, llm: slowLlm, avatars: { get: async () => ({ type: 'image/png', buf: Buffer.from('x') }) },
    config: { publicDir: path.join(d, 'pub'), deepseekModel: 'fake' } });
  // 每次换一个端口：fetch 连接池里上一个实例的旧连接不会被复用到新实例上。
  const all = [44985, 44986, 44987, 44988, 44989, 44983, 44984];
  const k = appRuns++ % all.length;
  const port = await pickPort([...all.slice(k), ...all.slice(0, k)]);
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${port}`, db); } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
}

test('每日上限 1：多个会话并发发消息只放行 1 条', async () => {
  await withApp(async (base, db) => {
    const c = new Client(base);
    assert.equal((await c.post('/api/login', { username: 'lim', password: 'lim-pass-123' })).status, 200);
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await c.post('/api/chats', { path: 't/c' })).json.chat.id);
    const rs = await Promise.all(ids.map((id) => c.post(`/api/chats/${id}/messages`, { content: '嗨' })));
    const codes = rs.map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 429, 429, 429, 429, 429]);
    const row = db.prepare('SELECT messages FROM usage_daily').get();
    assert.equal(row.messages, 1);
    // 在途计数已释放：再发仍按已用 1 条判 429，而不是卡住
    assert.equal((await c.post(`/api/chats/${ids[0]}/messages`, { content: '再来' })).status, 429);
  });
});

test('登录：用户名不存在也跑 scrypt，耗时与存在的账号同一量级', async () => {
  await withApp(async (base) => {
    const time = async (username) => {
      const t = process.hrtime.bigint();
      const r = await new Client(base).post('/api/login', { username, password: 'wrong-pass' });
      assert.equal(r.status, 401);
      return Number(process.hrtime.bigint() - t) / 1e6;
    };
    await time('lim'); await time('nobody-x'); // 预热
    const known = [], unknown = [];
    for (let i = 0; i < 3; i++) { known.push(await time('lim')); unknown.push(await time(`nobody-${i}`)); }
    const med = (a) => a.sort((x, y) => x - y)[1];
    assert.ok(med(unknown) > med(known) * 0.4, `unknown=${med(unknown)}ms known=${med(known)}ms`);
  });
});

test('同名 ac_sid 有多份（疑似被其它端口塞 cookie）时不认会话', async () => {
  await withApp(async (base) => {
    const c = new Client(base);
    assert.equal((await c.post('/api/login', { username: 'lim', password: 'lim-pass-123' })).status, 200);
    assert.equal((await c.get('/api/me')).status, 200);
    const r = await fetch(base + '/api/me', { headers: { cookie: `ac_sid=attacker; ${c.cookie}` } });
    assert.equal(r.status, 200); // v0.9 F9：/api/me 未登录回 200 {user:null}
    assert.equal((await r.json()).user, null);
    const r2 = await fetch(base + '/api/chats', { headers: { cookie: `ac_sid=attacker; ${c.cookie}` } });
    assert.equal(r2.status, 401);
  });
});

test('https demux：建连后不发数据，超时被服务端断开', async (t) => {
  const ssl = path.join(dir, 'ssl');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(ssl, { recursive: true });
  const g = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', path.join(ssl, 'chat.example.com.key'), '-out', path.join(ssl, 'chat.example.com_bundle.pem')], { stdio: 'ignore' });
  if (g.status !== 0) { t.skip('没有 openssl'); return; }
  const port = await pickPort([44983, 44984, 44985, 44986, 44987, 44988, 44989]);
  const srv = startServer({ handle: (req, res) => res.end('ok'), port, sslDir: ssl, host: '127.0.0.1', firstByteTimeoutMs: 300, label: 'test' });
  await new Promise((r) => (srv.listening ? r() : srv.once('listening', r)));
  try {
    const started = Date.now();
    const closedAfter = await new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('error', () => {});
      s.on('close', () => resolve(Date.now() - started));
      setTimeout(() => { s.destroy(); reject(new Error('连接没有被断开')); }, 3000);
    });
    assert.ok(closedAfter < 2000, `${closedAfter}ms`);
    // 正常请求不受影响（明文分支）
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/healthz', agent: false }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(b)); }).on('error', reject);
    });
    assert.equal(body, 'ok');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
