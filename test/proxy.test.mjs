// v0.4（契约 §10）：进程内假 CONNECT 代理 + https 假上游（自签证书只在本测试里用 ca 选项信任，不动全局校验）。
// 覆盖：代理流式 / TLS 校验 / 超时 / 中断；llm 经代理；stream_options 不认时重试；
// app 层：上游实价（ticks）、按单价推算、停止时粗估、无单价 → cost_partial、会话 / 列表 / 用量 / system_costs、
// 同步 xAI 价格、管理员新建 xAI 模型默认代理、代理地址与单价校验、汇率设置。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { openDb, getSettings } from '../server/db.mjs';
import { hashPassword } from '../server/auth.mjs';
import { createApp } from '../server/app.mjs';
import { nowIso, HttpError } from '../server/util.mjs';
import { nodeToCard } from '../server/chub.mjs';
import { createLlm } from '../server/llm.mjs';
import { createProxyFetch } from '../server/proxy.mjs';
import { createCostService } from '../server/costs.mjs';
import { createModelService, loadOrCreateSecret, encryptSecret } from '../server/models.mjs';
import { tmpDir, cleanupTmp, listenFree, Client, parseSse } from './helpers.mjs';

const PORTS = [44989, 44988, 44987, 44986, 44985, 44984, 44983, 44982];
const FAKE_KEY = 'xai-mock-' + 'q'.repeat(24) + 'W7v6';
let dir, CA, upstream, upPort, proxy, proxyUrl, appServer, base, db, svc, ids = {};
const upLog = [];
const connectLog = [];
let lastSlowRes = null;

function makeCert(d) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(d, 'k.pem'), '-out', path.join(d, 'c.pem'), '-days', '1',
    '-subj', '/CN=api.fake-upstream.com', '-addext', 'subjectAltName=DNS:api.x.ai,DNS:api.fake-upstream.com'], { stdio: 'ignore' });
  return { key: readFileSync(path.join(d, 'k.pem')), cert: readFileSync(path.join(d, 'c.pem')) };
}

const LM_LIST = { models: [
  { id: 'grok-ok', aliases: [], prompt_text_token_price: 12500, cached_prompt_text_token_price: 2000, completion_text_token_price: 25000 },
  { id: 'grok-4.7', aliases: [], prompt_text_token_price: 20000, cached_prompt_text_token_price: 5000, completion_text_token_price: 60000 },
] };

function startUpstream(tlsOpts) {
  return https.createServer(tlsOpts, (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      upLog.push({ method: req.method, url: req.url, host: req.headers.host, auth: req.headers.authorization, body });
      if (req.method === 'GET' && req.url === '/v1/language-models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(LM_LIST)); return; }
      if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
      const m = body.model;
      if (m === 'no-opts' && body.stream_options) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options' } }));
        return;
      }
      if (!body.stream) {
        // 契约 §19.2：整卡翻译按编号发 JSON、要求按编号回 JSON；这里每条都回「这是译文」（保留占位符）。
        let content = '这是译文';
        try {
          const ids = JSON.parse(body.messages?.at(-1)?.content || '');
          if (ids && typeof ids === 'object' && !Array.isArray(ids)) {
            content = JSON.stringify(Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, `这是译文${(String(v).match(/\{\{[^}]*\}\}/g) || []).join('')}`])));
          }
        } catch { /* 开场白单独翻译：纯文本 */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: m, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 400, completion_tokens: 100, prompt_cache_hit_tokens: 0 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      chunk({ model: m, choices: [{ delta: { role: 'assistant', content: '' } }] });
      if (m === 'empty-billed') { // 只出思考 token、可见正文为空，但已回 usage（已扣费）
        chunk({ model: m, choices: [{ delta: {}, finish_reason: 'stop' }] });
        chunk({ model: m, choices: [], usage: { prompt_tokens: 300, completion_tokens: 0, completion_tokens_details: { reasoning_tokens: 40 } } });
        res.end('data: [DONE]\n\n');
        return;
      }
      chunk({ model: m, choices: [{ delta: { content: '你好，' } }] });
      if (m === 'slow-stream') { lastSlowRes = res; return; } // 只吐一段就挂着
      chunk({ model: m, choices: [{ delta: { content: `我是${m}` } }] });
      chunk({ model: m, choices: [{ delta: {}, finish_reason: 'stop' }] });
      const usage = m === 'grok-ok' ? { prompt_tokens: 192, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 128 }, cost_in_usd_ticks: 1206000 }
        : m === 'reasoning' ? { prompt_tokens: 100, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 57 } }
          : m === 'no-usage' ? null
            : { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 };
      if (usage) chunk({ model: m, choices: [], usage });
      res.end('data: [DONE]\n\n');
    });
  });
}

/** 假 CONNECT 代理：deny.example.com → 403；hang.example.com → 不回；其他主机一律接到假上游（模拟代理侧解析）。 */
function startProxy() {
  const srv = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  srv.tunnels = new Set(); // CONNECT 之后的 socket 不归 server 管，收尾时自己关
  srv.on('connect', (req, client, head) => {
    connectLog.push(req.url);
    srv.tunnels.add(client);
    client.on('close', () => srv.tunnels.delete(client));
    client.on('error', () => {});
    const host = req.url.replace(/:\d+$/, '');
    if (host === 'deny.example.com') { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    if (host === 'hang.example.com') return;
    const up = net.connect(upPort, '127.0.0.1', () => {
      srv.tunnels.add(up);
      up.on('close', () => srv.tunnels.delete(up));
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => client.destroy());
    client.on('close', () => up.destroy());
  });
  return srv;
}

const NODES = {
  'tester/en': { fullPath: 'tester/en', name: 'En', tagline: 'x', avatar_url: 'https://avatars.charhub.io/a/e.webp', topics: [], nsfw_image: false,
    definition: { name: 'En', first_message: 'Hello there, {{user}}! Nice to meet you today.' } },
  'tester/zh': { fullPath: 'tester/zh', name: 'Zh', tagline: 'x', avatar_url: 'https://avatars.charhub.io/a/z.webp', topics: [], nsfw_image: false,
    definition: { name: 'Zh', first_message: '你好，{{user}}！' } },
};
const fakeChub = {
  async search() { return { items: Object.values(NODES).map(nodeToCard), page: 1, has_more: false }; },
  async character(p) { if (!NODES[p]) throw new HttpError(404, 'x'); return structuredClone(NODES[p]); },
};

function addModel(name, model, { base_url = 'https://api.x.ai/v1', proxy = true, currency = 'USD', pin = null, pc = null, pout = null, enabled = 1 } = {}) {
  const max = db.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM models').get().m;
  return Number(db.prepare(`INSERT INTO models(name, provider, base_url, api_key_env, api_key_enc, model, enabled, sort, extra_json, proxy_url, currency, price_in, price_in_cached, price_out, created_at)
    VALUES (?, '测试', ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`)
    .run(name, base_url, svc._enc(FAKE_KEY), model, enabled, max + 1, proxy ? proxyUrl : null, currency, pin, pc, pout, nowIso()).lastInsertRowid);
}

before(async () => {
  dir = tmpDir('unit-proxy');
  const tlsOpts = makeCert(dir);
  CA = tlsOpts.cert;
  upstream = startUpstream(tlsOpts);
  upPort = await listenFree(upstream, PORTS);
  proxy = startProxy();
  const pPort = await listenFree(proxy, PORTS);
  proxyUrl = `http://127.0.0.1:${pPort}`;

  const d = path.join(dir, 'app'); mkdirSync(d, { recursive: true });
  db = openDb(path.join(d, 'aichat.sqlite'));
  const ins = db.prepare('INSERT INTO users(username, password_hash, display_name, is_admin, role, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run('boss', hashPassword('boss-pass-1'), '老板', 1, 'super', null, nowIso());
  ins.run('ops', hashPassword('ops-pass-11'), '运营', 1, 'admin', 1, nowIso());
  ins.run('alice', hashPassword('alice-pass-1'), '爱丽丝', 0, 'tenant', 2, nowIso());
  const secretFile = path.join(d, 'secret.key');
  const lookup = async (h) => {
    if (h === 'nodns.example.com') throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    if (h === 'slowdns.example.com') return new Promise(() => {}); // 永不返回：模拟本地 DNS 超时
    return [{ address: h === 'evil.example.com' ? '127.0.0.1' : '93.184.216.34', family: 4 }];
  };
  svc = createModelService({ db, secretFile, lookup });
  const key = loadOrCreateSecret(secretFile);
  svc._enc = (p) => encryptSecret(p, key);
  // 默认模型（翻译用）：DeepSeek 式 usage、人民币单价、上游不认 stream_options
  ids.ds = addModel('DS 式', 'no-opts', { base_url: 'https://api.fake-upstream.com/v1', currency: 'CNY', pin: 2, pc: 0.04, pout: 8 });
  ids.grok = addModel('Grok', 'grok-ok', { pin: 1.25, pc: 0.2, pout: 2.5 });
  ids.reason = addModel('思考', 'reasoning', { pin: 2, pc: 0.5, pout: 6 });
  ids.slow = addModel('慢', 'slow-stream', { base_url: 'https://api.fake-upstream.com/v1', currency: 'CNY', pin: 2, pc: 0.04, pout: 8 });
  ids.empty = addModel('只思考', 'empty-billed', { pin: 2, pc: 0.5, pout: 6 });
  ids.noprice = addModel('无单价', 'no-usage', { base_url: 'https://api.fake-upstream.com/v1' });
  db.prepare("UPDATE settings SET value = ? WHERE key = 'default_model_id'").run(String(ids.ds));
  // 默认 guard（只做字面量检查）+ 只信任测试 CA 的代理 fetch
  const llm = createLlm({ models: svc, proxyFetch: createProxyFetch({ ca: CA, connectTimeoutMs: 2000 }), firstByteTimeoutMs: 3000, idleTimeoutMs: 3000 });
  const app = createApp({ db, chub: fakeChub, llm, models: svc, avatars: { get: async () => ({ type: 'image/png', buf: Buffer.from('x') }) },
    config: { publicDir: path.join(d, 'pub'), deepseekModel: 'fake' } });
  appServer = http.createServer(app.handle);
  const port = await listenFree(appServer, PORTS);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  for (const t of proxy?.tunnels || []) t.destroy();
  for (const s of [appServer, proxy, upstream]) {
    if (!s) continue;
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
  db?.close();
  cleanupTmp(dir);
});

async function login(u, p) { const c = new Client(base); assert.equal((await c.post('/api/login', { username: u, password: p })).status, 200); return c; }

// ---------- 代理本身 ----------
test('代理：CONNECT 隧道 + TLS（只信测试 CA）取 JSON；隧道目标是原主机名:443，不在本地解析', async () => {
  const pf = createProxyFetch({ ca: CA });
  connectLog.length = 0;
  const r = await pf('https://api.x.ai/v1/language-models', { proxyUrl, headers: { Authorization: 'Bearer t' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).models.length, 2);
  assert.deepEqual(connectLog, ['api.x.ai:443']);
  assert.equal(upLog[upLog.length - 1].host, 'api.x.ai');
});

test('代理：证书照常校验——不给 ca 拒绝自签；主机名不在证书里也拒绝；全局校验没被关', async () => {
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
  await assert.rejects(createProxyFetch()('https://api.x.ai/v1/language-models', { proxyUrl }), (e) => /self[- ]signed|unable to verify|certificate/i.test(`${e.code} ${e.message}`));
  await assert.rejects(createProxyFetch({ ca: CA })('https://other.example.com/v1/language-models', { proxyUrl }), (e) => e.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
});

test('代理：CONNECT 被拒 / 代理不回（超时）/ 非 https 目标 / 非本机代理', async () => {
  const pf = createProxyFetch({ ca: CA, connectTimeoutMs: 300 });
  await assert.rejects(pf('https://deny.example.com/x', { proxyUrl }), (e) => e.code === 'EPROXYCONNECT' && e.proxy_status === 403);
  const t0 = Date.now();
  await assert.rejects(pf('https://hang.example.com/x', { proxyUrl }), (e) => e.code === 'EPROXYTIMEOUT');
  assert.ok(Date.now() - t0 < 2000);
  await assert.rejects(pf('http://api.x.ai/x', { proxyUrl }), TypeError);
  await assert.rejects(pf('https://api.x.ai/x', { proxyUrl: 'http://10.0.0.1:3128' }), HttpError);
});

test('代理：流式逐段到达；中途 Abort 立即中断读取并断开上游连接', async () => {
  const pf = createProxyFetch({ ca: CA });
  const ac = new AbortController();
  lastSlowRes = null;
  const r = await pf('https://api.fake-upstream.com/v1/chat/completions', { proxyUrl, method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'slow-stream', stream: true }), signal: ac.signal });
  const reader = r.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /data:/, '上游还没结束就能读到第一段');
  const upClosed = new Promise((resolve) => { const s = lastSlowRes; if (!s) return resolve(); s.on('close', resolve); });
  ac.abort();
  await assert.rejects((async () => { for (;;) { const x = await reader.read(); if (x.done) throw new Error('ended without abort'); } })());
  await Promise.race([upClosed, new Promise((_, rej) => setTimeout(() => rej(new Error('上游连接没断')), 2000))]);
  // 已中断的 signal 直接拒绝
  await assert.rejects(pf('https://api.x.ai/v1/language-models', { proxyUrl, signal: AbortSignal.abort() }));
});

// ---------- llm 经代理 ----------
test('llm：模型配了 proxy_url 就走代理；usage 带 ticks；默认安全检查放行（不做本地 DNS）', async () => {
  const llm = createLlm({ models: svc, proxyFetch: createProxyFetch({ ca: CA }) });
  connectLog.length = 0;
  const r = await llm.streamChat([{ role: 'user', content: 'hi' }], { model: svc.byId(ids.grok) });
  assert.equal(r.text, '你好，我是grok-ok');
  assert.deepEqual({ usage: r.usage, tin: r.tokens_in, cached: r.tokens_in_cached, out: r.tokens_out, ticks: r.cost_ticks, id: r.model_id },
    { usage: true, tin: 192, cached: 128, out: 6, ticks: 1206000, id: ids.grok });
  assert.deepEqual(connectLog, ['api.x.ai:443']);
  const call = upLog[upLog.length - 1];
  assert.equal(call.auth, `Bearer ${FAKE_KEY}`);
  assert.deepEqual(call.body.stream_options, { include_usage: true });
  // 字面量内网地址即便配了代理也拒（不发出去）
  const bad = { ...svc.byId(ids.grok), base_url: 'https://10.0.0.1/v1' };
  const n = upLog.length;
  await assert.rejects(llm.streamChat([{ role: 'user', content: 'x' }], { model: bad }), (e) => e.code === 'upstream');
  assert.equal(upLog.length, n);
});

test('llm：上游不认 stream_options → 去掉重试一次，之后记住不再带', async () => {
  const llm = createLlm({ models: svc, proxyFetch: createProxyFetch({ ca: CA }) });
  const n = upLog.length;
  const r = await llm.streamChat([{ role: 'user', content: 'hi' }], { model: svc.byId(ids.ds) });
  assert.equal(r.text, '你好，我是no-opts');
  assert.equal(r.tokens_in_cached, 600);
  const calls = upLog.slice(n);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].body.stream_options);
  assert.equal(calls[1].body.stream_options, undefined);
  await llm.streamChat([{ role: 'user', content: 'hi' }], { model: svc.byId(ids.ds) });
  assert.equal(upLog.length - n, 3, '第二次直接不带');
});

test('llm：经代理的流式也有超时（首字节后空闲超时 → timeout），部分文本带回', async () => {
  const llm = createLlm({ models: svc, proxyFetch: createProxyFetch({ ca: CA }), firstByteTimeoutMs: 1000, idleTimeoutMs: 300 });
  await assert.rejects(llm.streamChat([{ role: 'user', content: 'x' }], { model: svc.byId(ids.slow) }), (e) => e.code === 'timeout' && e.partial === '你好，' && e.usage === false);
});

// ---------- app 层计费 ----------
test('会话消费：xAI 实价（upstream，= ticks）；DeepSeek 式按人民币单价推算（estimate）；会话合计与列表', async () => {
  const u = await login('alice', 'alice-pass-1');
  const chat = (await u.post('/api/chats', { path: 'tester/zh', model_id: ids.grok })).json.chat;
  assert.equal(chat.cost_usd, 0);
  assert.equal(chat.cost_partial, false, '开场白不算');
  let ev = parseSse((await u.post(`/api/chats/${chat.id}/messages`, { content: '你好' })).text);
  let done = ev.find((e) => e.event === 'done').data;
  assert.equal(done.message.cost_source, 'upstream');
  assert.equal(done.message.cost_usd, 0.0001206);
  assert.equal(done.message.tokens_in, 192);
  assert.equal(done.message.tokens_out, 6);
  assert.equal(done.chat_cost_usd, 0.000121);
  assert.equal(done.chat_cost_partial, false);
  assert.equal(db.prepare('SELECT tokens_in_cached FROM messages WHERE id = ?').get(done.message.id).tokens_in_cached, 128);

  await u.patch(`/api/chats/${chat.id}`, { model_id: ids.ds });
  ev = parseSse((await u.post(`/api/chats/${chat.id}/messages`, { content: '再来' })).text);
  done = ev.find((e) => e.event === 'done').data;
  // (400×2 + 600×0.04 + 200×8)/1e6 元 × 0.14
  const ds = ((400 * 2 + 600 * 0.04 + 200 * 8) / 1e6) * 0.14;
  assert.equal(done.message.cost_source, 'estimate');
  assert.ok(Math.abs(done.message.cost_usd - ds) < 1e-12);
  assert.equal(done.chat_cost_usd, Math.round((0.0001206 + ds) * 1e6) / 1e6);

  const got = (await u.get(`/api/chats/${chat.id}`)).json;
  assert.equal(got.chat.cost_usd, done.chat_cost_usd);
  assert.equal(got.chat.cost_partial, false);
  const [greet, , a1, , a2] = got.messages;
  assert.deepEqual({ c: greet.cost_usd, s: greet.cost_source }, { c: null, s: null });
  assert.deepEqual([a1.cost_source, a2.cost_source], ['upstream', 'estimate']);
  assert.ok(!('cost_usd' in got.messages[1]), '用户消息不带计费字段');
  const item = (await u.get('/api/chats')).json.items.find((x) => x.id === chat.id);
  assert.equal(item.cost_usd, done.chat_cost_usd);

  // 用量：usage_daily 累加花费
  const day = db.prepare('SELECT cost_usd FROM usage_daily WHERE user_id = 3').get();
  assert.ok(Math.abs(day.cost_usd - (0.0001206 + ds)) < 1e-12);
});

test('思考 token 另计（xAI）：按输出价计费；没单价 → cost null 且会话 cost_partial', async () => {
  const u = await login('alice', 'alice-pass-1');
  const chat = (await u.post('/api/chats', { path: 'tester/zh', model_id: ids.reason })).json.chat;
  let done = parseSse((await u.post(`/api/chats/${chat.id}/messages`, { content: '想一想' })).text).find((e) => e.event === 'done').data;
  assert.equal(done.message.cost_source, 'estimate');
  assert.ok(Math.abs(done.message.cost_usd - (100 * 2 + 64 * 6) / 1e6) < 1e-12);
  assert.equal(db.prepare('SELECT tokens_reasoning FROM messages WHERE id = ?').get(done.message.id).tokens_reasoning, 57);

  await u.patch(`/api/chats/${chat.id}`, { model_id: ids.noprice });
  done = parseSse((await u.post(`/api/chats/${chat.id}/messages`, { content: '再说' })).text).find((e) => e.event === 'done').data;
  assert.deepEqual({ c: done.message.cost_usd, s: done.message.cost_source }, { c: null, s: null });
  assert.equal(done.chat_cost_partial, true);
  const got = (await u.get(`/api/chats/${chat.id}`)).json.chat;
  assert.equal(got.cost_partial, true);
  assert.ok(got.cost_usd > 0);
});

test('停止生成：上游没给 usage → 按字数粗估（输入 = 提示词，输出 = 已生成），标 estimate，用量照记', async () => {
  const u = await login('alice', 'alice-pass-1');
  const chat = (await u.post('/api/chats', { path: 'tester/zh', model_id: ids.slow })).json.chat;
  const before = db.prepare('SELECT COALESCE(SUM(messages),0) AS n, COALESCE(SUM(cost_usd),0) AS c FROM usage_daily WHERE user_id = 3').get();
  const ac = new AbortController();
  const r = await fetch(`${base}/api/chats/${chat.id}/messages`, { method: 'POST', signal: ac.signal, headers: { cookie: u.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ content: '你好呀' }) });
  const reader = r.body.getReader();
  let buf = '';
  while (!buf.includes('event: delta')) buf += new TextDecoder().decode((await reader.read()).value);
  ac.abort();
  let row;
  for (let i = 0; i < 50 && !row; i++) {
    await new Promise((res) => setTimeout(res, 50));
    row = db.prepare("SELECT * FROM messages WHERE chat_id = ? AND role = 'assistant' AND model IS NOT NULL").get(chat.id);
  }
  assert.ok(row, '停止后部分回复应保存');
  assert.equal(row.content, '你好，');
  assert.equal(row.cost_source, 'estimate');
  assert.equal(row.tokens_out, 3, '「你好，」→ 2 个汉字 + 1 个标点（按 4 字符 1 token 向上取整）');
  assert.ok(row.tokens_in > 10, '输入按提示词字数粗估');
  const expect = ((row.tokens_in * 2 + row.tokens_out * 8) / 1e6) * 0.14;
  assert.ok(Math.abs(row.cost_usd - expect) < 1e-12);
  const afterU = db.prepare('SELECT COALESCE(SUM(messages),0) AS n, COALESCE(SUM(cost_usd),0) AS c FROM usage_daily WHERE user_id = 3').get();
  assert.equal(afterU.n, before.n + 1);
  assert.ok(Math.abs(afterU.c - before.c - row.cost_usd) < 1e-12);
  lastSlowRes?.destroy();
});

test('上游已回 usage 但正文为空：不存空消息，token 与花费照记进 usage_daily（不占每日条数）', async () => {
  const u = await login('alice', 'alice-pass-1');
  const chat = (await u.post('/api/chats', { path: 'tester/zh', model_id: ids.empty })).json.chat;
  const before = db.prepare('SELECT COALESCE(SUM(messages),0) AS n, COALESCE(SUM(tokens_in),0) AS ti, COALESCE(SUM(tokens_out),0) AS tout, COALESCE(SUM(cost_usd),0) AS c FROM usage_daily WHERE user_id = 3').get();
  const ev = parseSse((await u.post(`/api/chats/${chat.id}/messages`, { content: '想想' })).text);
  const err = ev.find((e) => e.event === 'error');
  assert.ok(err, '应回 error 事件');
  assert.equal(err.data.code, 'upstream');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND role = 'assistant' AND model IS NOT NULL").get(chat.id).n, 0, '不存空消息');
  const after = db.prepare('SELECT COALESCE(SUM(messages),0) AS n, COALESCE(SUM(tokens_in),0) AS ti, COALESCE(SUM(tokens_out),0) AS tout, COALESCE(SUM(cost_usd),0) AS c FROM usage_daily WHERE user_id = 3').get();
  assert.equal(after.n, before.n, '不占每日条数');
  assert.equal(after.ti - before.ti, 300);
  assert.equal(after.tout - before.tout, 0);
  // xAI 思考 token 另计：(300×2 + 40×6)/1e6
  assert.ok(Math.abs(after.c - before.c - (300 * 2 + 40 * 6) / 1e6) < 1e-12, `${after.c - before.c}`);
});

test('system_costs.tokens_out 与计价口径一致：completion 已含思考的厂商不重复加，xAI 另计的才加', () => {
  const costs = createCostService({ db });
  const openaiLike = { id: null, base_url: 'https://api.openai-like.example.com/v1', currency: 'USD', price_in: 1, price_out: 2 };
  const xai = { id: null, base_url: 'https://api.x.ai/v1', currency: 'USD', price_in: 1, price_out: 2 };
  const r = { usage: true, tokens_in: 10, tokens_out: 120, tokens_reasoning: 80 };
  costs.recordSystem('test', openaiLike, null, r);
  let row = db.prepare('SELECT * FROM system_costs ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.tokens_out, 120, 'completion_tokens 已含思考，不重复计');
  assert.ok(Math.abs(row.cost_usd - (10 * 1 + 120 * 2) / 1e6) < 1e-12);
  costs.recordSystem('test', xai, null, { usage: true, tokens_in: 10, tokens_out: 7, tokens_reasoning: 57 });
  row = db.prepare('SELECT * FROM system_costs ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.tokens_out, 64, 'xAI 思考另计');
  assert.ok(Math.abs(row.cost_usd - (10 * 1 + 64 * 2) / 1e6) < 1e-12);
  db.prepare('DELETE FROM system_costs WHERE model_id IS NULL').run(); // 不影响后面按 kind 计数的用例
});

test('翻译开场白与后台测试的花费记 system_costs，不算进会话；super 用量页看得到，admin 看不到', async () => {
  const u = await login('alice', 'alice-pass-1');
  const r = await u.get('/api/characters/tester/en');
  assert.equal(r.status, 200, r.text);
  // 契约 §19.2：详情秒开，后台整卡翻译；轮询到翻译完成
  let ch = r.json.character;
  for (let i = 0; i < 100 && ch.translate_status === 'pending'; i++) {
    await new Promise((res) => setTimeout(res, 20));
    ch = (await u.get('/api/characters/tester/en')).json.character;
  }
  assert.equal(ch.translate_status, 'ok');
  assert.match(ch.greeting_zh, /^这是译文/);
  const tr = db.prepare("SELECT * FROM system_costs WHERE kind = 'translate'").all();
  assert.ok(tr.length >= 1);
  for (const x of tr) {
    assert.equal(x.user_id, 3);
    assert.equal(x.model_id, ids.ds);
    assert.equal(x.cost_source, 'estimate');
    assert.ok(Math.abs(x.cost_usd - ((400 * 2 + 100 * 8) / 1e6) * 0.14) < 1e-12);
  }
  const chat = (await u.post('/api/chats', { path: 'tester/en' })).json.chat;
  assert.equal(chat.cost_usd, 0, '翻译不算进会话');

  const boss = await login('boss', 'boss-pass-1');
  const t = await boss.post(`/api/admin/models/${ids.grok}/test`);
  assert.equal(t.json.ok, true);
  assert.equal(t.json.cost_source, 'upstream');
  assert.equal(t.json.cost_usd, 0.0001206);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM system_costs WHERE kind = 'test'").get().n, 1);

  const us = (await boss.get('/api/admin/usage?days=7')).json;
  const row = us.items.find((x) => x.username === 'alice');
  assert.ok(row.cost_usd > 0);
  assert.equal(typeof us.total_cost_usd, 'number');
  assert.ok(us.system_costs.translate_usd > 0);
  assert.equal(us.system_costs.test_usd, 0.000121);
  assert.equal(us.system_costs.count, tr.length + 1);
  const ops = await login('ops', 'ops-pass-11');
  const uo = (await ops.get('/api/admin/usage?days=7')).json;
  assert.equal(uo.system_costs, undefined);
  assert.ok(uo.items.find((x) => x.username === 'alice').cost_usd > 0, 'admin 看自己建的租户的花费');
});

test('本人会话接口：列表与详情带花费', async () => {
  const user = await login('alice', 'alice-pass-1');
  const list = (await user.get('/api/chats')).json.items;
  assert.ok(list.length > 0);
  for (const c of list) { assert.equal(typeof c.cost_usd, 'number'); assert.equal(typeof c.cost_partial, 'boolean'); }
  const priced = list.find((c) => c.cost_usd > 0);
  const one = (await user.get(`/api/chats/${priced.id}`)).json;
  assert.equal(one.chat.cost_usd, priced.cost_usd);
  const a = one.messages.find((m) => m.role === 'assistant' && m.cost_source);
  assert.ok(a && typeof a.cost_usd === 'number' && a.tokens_in > 0);
});

test('同步 xAI 价格：只限 super、只对 api.x.ai 模型；走代理；价格 ÷10000 写入', async () => {
  const boss = await login('boss', 'boss-pass-1');
  const ops = await login('ops', 'ops-pass-11');
  const u = await login('alice', 'alice-pass-1');
  const id = addModel('Grok 4.7', 'grok-4.7');
  assert.equal((await u.post(`/api/admin/models/${id}/sync-price`)).status, 403);
  assert.equal((await ops.post(`/api/admin/models/${id}/sync-price`)).status, 403);
  assert.equal((await boss.post(`/api/admin/models/${ids.ds}/sync-price`)).status, 400, '非 xAI');
  assert.equal((await boss.post('/api/admin/models/99999/sync-price')).status, 404);
  connectLog.length = 0;
  const r = await boss.post(`/api/admin/models/${id}/sync-price`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.synced, { currency: 'USD', price_in: 2, price_in_cached: 0.5, price_out: 6 });
  assert.deepEqual({ c: r.json.model.currency, i: r.json.model.price_in, k: r.json.model.price_in_cached, o: r.json.model.price_out, s: r.json.model.can_sync_price },
    { c: 'USD', i: 2, k: 0.5, o: 6, s: true });
  assert.deepEqual(connectLog, ['api.x.ai:443']);
  const unknown = addModel('未知', 'grok-nope');
  assert.equal((await boss.post(`/api/admin/models/${unknown}/sync-price`)).status, 502);
  assert.ok(!r.text.includes(FAKE_KEY));
});

test('管理：新建 xAI 模型没填代理 → 默认 127.0.0.1:42001（不做本地 DNS）；代理地址与单价校验；改代理；汇率设置', async () => {
  const boss = await login('boss', 'boss-pass-1');
  const c = await boss.post('/api/admin/models', { name: 'Grok 新', provider: 'xAI', base_url: 'https://api.x.ai/v1', model: 'grok-4.7', api_key: 'xai-new-key-9876', price_in: '2', price_in_cached: 0.5, price_out: 6 });
  assert.equal(c.status, 200, c.text);
  const m = c.json.model;
  assert.equal(m.proxy_url, 'http://127.0.0.1:42001');
  assert.deepEqual([m.currency, m.price_in, m.price_in_cached, m.price_out, m.can_sync_price], ['USD', 2, 0.5, 6, true]);
  const bad = async (b) => (await boss.post('/api/admin/models', { name: 'X', base_url: 'https://ok.example.com/v1', model: 'x-1', api_key: 'sk-x-12345678', ...b })).status;
  assert.equal(await bad({ proxy_url: 'http://10.0.0.2:3128' }), 400);
  assert.equal(await bad({ proxy_url: 'http://proxy.example.com:8080' }), 400);
  assert.equal(await bad({ proxy_url: 'https://127.0.0.1:42001' }), 400);
  assert.equal(await bad({ currency: 'EUR' }), 400);
  assert.equal(await bad({ price_in: -1 }), 400);
  assert.equal(await bad({ price_out: 'abc' }), 400);
  // 有代理：本地 DNS 尽力而为——解析成功且是内网 → 拦（防借代理探测内网端口）；解析失败 / 超时 → 放行（本地 DNS 可能被污染）
  assert.equal(await bad({ base_url: 'https://evil.example.com/v1', proxy_url: proxyUrl }), 400, '代理模型：本地解析到内网照拦');
  assert.equal(await bad({ base_url: 'https://nodns.example.com/v1', proxy_url: proxyUrl, model: 'x-2' }), 200, '代理模型：本地解析失败放行');
  const t0 = Date.now();
  assert.equal(await bad({ base_url: 'https://slowdns.example.com/v1', proxy_url: proxyUrl, model: 'x-3' }), 200, '代理模型：本地解析超时放行');
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(await bad({ base_url: 'https://evil.example.com/v1' }), 400, '直连仍做 DNS 内网检查');
  assert.equal(await bad({ base_url: 'https://127.0.0.1/v1', proxy_url: proxyUrl }), 400);
  assert.equal(await bad({ base_url: 'https://svc.internal/v1', proxy_url: proxyUrl }), 400);
  const plain = await boss.post('/api/admin/models', { name: 'Plain', base_url: 'https://ok.example.com/v1', model: 'p-1', api_key: 'sk-plain-1234', currency: 'cny', price_in: 1, price_out: 2 });
  assert.equal(plain.status, 200, plain.text);
  assert.equal(plain.json.model.proxy_url, null, '非 xAI 不自动加代理');
  assert.equal(plain.json.model.currency, 'CNY');
  assert.equal(plain.json.model.can_sync_price, false);
  // PATCH：改代理、清空价格、清代理（改回直连要过 DNS 检查）
  const p1 = await boss.patch(`/api/admin/models/${m.id}`, { proxy_url: 'http://localhost:42002', price_in_cached: '' });
  assert.equal(p1.status, 200, p1.text);
  assert.equal(p1.json.model.proxy_url, 'http://localhost:42002');
  assert.equal(p1.json.model.price_in_cached, null);
  assert.equal((await boss.patch(`/api/admin/models/${m.id}`, { proxy_url: 'http://192.168.1.2:1' })).status, 400);
  const ev = await boss.post('/api/admin/models', { name: 'Ev', base_url: 'https://nodns.example.com/v1', model: 'e-1', api_key: 'sk-ev-12345678', proxy_url: proxyUrl });
  assert.equal(ev.status, 200, ev.text);
  assert.equal((await boss.patch(`/api/admin/models/${ev.json.model.id}`, { proxy_url: '' })).status, 400, '去掉代理后要过严格 DNS 检查（解析不了 → 拒）');
  // 直连模型改成走代理（不改地址）：同样做尽力而为的 DNS 检查
  const direct = await boss.post('/api/admin/models', { name: 'Dir', base_url: 'https://ok.example.com/v1', model: 'd-1', api_key: 'sk-dir-12345678' });
  assert.equal(direct.status, 200, direct.text);
  db.prepare("UPDATE models SET base_url = 'https://evil.example.com/v1' WHERE id = ?").run(direct.json.model.id); // 模拟 DNS 之后变成内网
  assert.equal((await boss.patch(`/api/admin/models/${direct.json.model.id}`, { proxy_url: proxyUrl })).status, 400);
  assert.equal((await boss.patch(`/api/admin/models/${m.id}`, { proxy_url: null })).status, 200);
  // 汇率
  assert.equal((await boss.patch('/api/admin/settings', { cny_to_usd: 0 })).status, 400);
  assert.equal((await boss.patch('/api/admin/settings', { cny_to_usd: 'x' })).status, 400);
  const s = await boss.patch('/api/admin/settings', { cny_to_usd: 0.138 });
  assert.equal(s.json.settings.cny_to_usd, 0.138);
  assert.equal(getSettings(db).cny_to_usd, 0.138);
  assert.equal((await boss.get('/api/admin/settings')).json.settings.cny_to_usd, 0.138);
  await boss.patch('/api/admin/settings', { cny_to_usd: '0.14' });
  const ops = await login('ops', 'ops-pass-11');
  assert.equal((await ops.patch('/api/admin/settings', { cny_to_usd: 1 })).status, 403);
  // 普通接口不泄露代理 / 单价
  const u = await login('alice', 'alice-pass-1');
  const pub = await u.get('/api/models');
  for (const k of ['proxy_url', '127.0.0.1', 'price_in', 'currency']) assert.ok(!pub.text.includes(k), k);
});

test('XAI_API_KEY 变量只能绑 api.x.ai（契约 §10.1 ALLOWED_KEY_ENVS）', async () => {
  const boss = await login('boss', 'boss-pass-1');
  const ok = await boss.post('/api/admin/models', { name: 'Grok 变量', base_url: 'https://api.x.ai/v1', model: 'grok-4.7', api_key_env: 'XAI_API_KEY' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.model.key_source, 'env');
  assert.equal(ok.json.model.proxy_url, 'http://127.0.0.1:42001');
  const steal = await boss.post('/api/admin/models', { name: 'X', base_url: 'https://attacker.example.com/v1', model: 'grok-4.7', api_key_env: 'XAI_API_KEY' });
  assert.equal(steal.status, 400);
  assert.equal((await boss.patch(`/api/admin/models/${ids.ds}`, { api_key_env: 'XAI_API_KEY' })).status, 400, '别的主机不能改用 XAI 变量');
});
