// v0.2 模型选择（契约 §8）：加密、SSRF、预置、解析顺序、拒答识别；进程内假上游测流式 / 拒答 / 审核截断 / 超时；进程内 app 测新接口。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { statSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { openDb, getSettings } from '../server/db.mjs';
import { hashPassword } from '../server/auth.mjs';
import { createApp } from '../server/app.mjs';
import { HttpError, nowIso } from '../server/util.mjs';
import { nodeToCard } from '../server/chub.mjs';
import { createLlm, isRefusal, upstreamError, REFUSED_MESSAGE, createSafeLookup, createPinnedFetch } from '../server/llm.mjs';
import { buildMessages, SAFETY_RULE } from '../server/prompt.mjs';
import {
  createModelService, seedModels, loadOrCreateSecret, encryptSecret, decryptSecret,
  isPrivateIp, checkBaseUrlSyntax, checkBaseUrl, parseExtra, PRESETS,
} from '../server/models.mjs';
import { tmpDir, cleanupTmp, listenFree, Client, parseSse } from './helpers.mjs';

const PORTS = [44989, 44988, 44987, 44986, 44985, 44984, 44983, 44982];
const FAKE_KEY = 'sk-mock-' + 'k'.repeat(24) + 'Z9y8';
let dir;
before(() => { dir = tmpDir('unit-models'); });
after(() => cleanupTmp(dir));

// ---------- 纯函数 ----------
test('key 加密：AES-256-GCM 往返；密钥文件 0600；换密钥解不开；同明文每次密文不同', () => {
  const f = path.join(dir, 'sec', 'secret.key');
  const k = loadOrCreateSecret(f);
  assert.equal(k.length, 32);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.ok(loadOrCreateSecret(f).equals(k), '第二次读到的必须是同一把');
  const a = encryptSecret('sk-abc', k);
  assert.notEqual(a, encryptSecret('sk-abc', k));
  assert.ok(!a.includes('sk-abc'));
  assert.equal(decryptSecret(a, k), 'sk-abc');
  assert.throws(() => decryptSecret(a, Buffer.alloc(32, 1)));
  const parts = a.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decryptSecret(parts.join('.'), k));
  // 截短的认证标签（4 字节）必须被拒
  const short = a.split('.');
  short[2] = short[2].slice(0, 6);
  assert.throws(() => decryptSecret(short.join('.'), k), '截短的 GCM 标签不能通过');
  const badIv = a.split('.');
  badIv[1] = badIv[1].slice(0, 8);
  assert.throws(() => decryptSecret(badIv.join('.'), k));
});

test('密钥文件已存在但权限是 0644：读的时候收紧成 0600', () => {
  const f = path.join(dir, 'sec', 'copied.key');
  writeFileSync(f, 'ab'.repeat(32) + '\n', { mode: 0o644 });
  chmodSync(f, 0o644);
  const k = loadOrCreateSecret(f);
  assert.equal(k.toString('hex'), 'ab'.repeat(32));
  assert.equal(statSync(f).mode & 0o777, 0o600);
});

test('SSRF：内网 / 环回 / 链路本地 / 映射地址都算私有', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', 'not-an-ip']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.14.200.50', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
});

test('SSRF：接口地址必须 https、不带账号、不指向内网', async () => {
  assert.equal(checkBaseUrlSyntax('https://api.example.com/v1/'), 'https://api.example.com/v1');
  for (const u of ['http://api.example.com', 'ftp://x.com', 'https://user:pw@api.example.com', 'https://127.0.0.1/v1', 'https://localhost:8443',
    'https://10.0.0.5', 'https://[::1]/v1', 'https://169.254.169.254/latest', 'https://0x7f000001/', 'https://2130706433/', 'https://svc.internal/v1',
    'https://intranet/v1', 'https://a.com/v1?x=1', 'not a url', '']) {
    assert.throws(() => checkBaseUrlSyntax(u), HttpError, u);
  }
  // DNS 解析到内网也不行
  const lookup = async (h) => (h === 'evil.example.com' ? [{ address: '127.0.0.1', family: 4 }] : h === 'mixed.example.com'
    ? [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
  await assert.rejects(checkBaseUrl('https://evil.example.com/v1', { lookup }), /内网/);
  await assert.rejects(checkBaseUrl('https://mixed.example.com/v1', { lookup }), /内网/);
  assert.equal(await checkBaseUrl('https://ok.example.com/v1', { lookup }), 'https://ok.example.com/v1');
  await assert.rejects(checkBaseUrl('https://nx.example.com', { lookup: async () => { throw new Error('ENOTFOUND'); } }), /解析/);
});

test('拒答识别：400/403 + 审核关键词、451 一律算 refused；参数校验错误不算', () => {
  assert.ok(isRefusal(400, '{"error":{"message":"Content Exists Risk","type":"invalid_request_error"}}'));
  assert.ok(isRefusal(451, 'blocked'.replace('blocked', 'sensitive words')));
  assert.ok(isRefusal(451, '{"error":{"message":"blocked"}}'), '451 本身就是拦截，不看正文');
  assert.equal(upstreamError(451, '').code, 'refused');
  assert.ok(isRefusal(400, '{"error":{"code":"data_inspection_failed","message":"Input data may contain inappropriate content."}}'));
  assert.ok(isRefusal(400, '{"error":{"message":"violates our content policy"}}'));
  assert.ok(isRefusal(400, '{"error":{"code":"content_filter"}}'));
  assert.ok(isRefusal(403, '{"error":"内容违规"}'));
  // 普通参数错误：正文里有 content / 安全 字样也不能当拒答
  assert.ok(!isRefusal(400, '{"error":{"message":"Invalid request: messages[1].content must be a string"}}'));
  assert.equal(upstreamError(400, '{"error":{"message":"Invalid request: messages[1].content must be a string"}}').code, 'upstream');
  assert.ok(!isRefusal(400, '{"error":{"message":"content too long, max context length is 65536"}}'));
  assert.ok(!isRefusal(400, '{"error":{"message":"安全起见，请检查请求参数"}}'));
  assert.ok(isRefusal(403, '{"error":"输入内容可能包含敏感信息"}'));
  assert.ok(!isRefusal(500, 'Content Exists Risk'));
  assert.ok(!isRefusal(400, '{"error":"invalid model"}'));
  assert.equal(upstreamError(400, 'Content Exists Risk').code, 'refused');
  assert.equal(upstreamError(400, 'Content Exists Risk').message, REFUSED_MESSAGE);
  assert.equal(upstreamError(401, 'bad key').code, 'upstream');
  assert.equal(upstreamError(500, '').code, 'upstream');
  assert.equal(upstreamError(504, '').code, 'timeout');
});

test('出站连接时再查 DNS：解析到内网就不连（防 DNS 重绑定）', async () => {
  const fake = (addrs) => (h, o, cb) => cb(null, addrs);
  const call = (lk, opts) => new Promise((resolve) => lk('x.example.com', opts, (err, a, fam) => resolve({ err, a, fam })));
  let r = await call(createSafeLookup(fake([{ address: '127.0.0.1', family: 4 }])), { all: true });
  assert.equal(r.err?.code, 'EPRIVATEADDR');
  r = await call(createSafeLookup(fake([{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.2', family: 4 }])), {});
  assert.equal(r.err?.code, 'EPRIVATEADDR', '混了一个内网地址也整体拒绝');
  r = await call(createSafeLookup(fake([{ address: '93.184.216.34', family: 4 }])), { all: true });
  assert.deepEqual(r.a, [{ address: '93.184.216.34', family: 4 }]);
  r = await call(createSafeLookup(fake([{ address: '93.184.216.34', family: 4 }])), {});
  assert.equal(r.a, '93.184.216.34');
  assert.equal(r.fam, 4);
  // 真的发请求：localhost 解析成环回 → 连接前就被拒，不会连上本机端口
  const pf = createPinnedFetch();
  await assert.rejects(pf('https://localhost:44989/v1/chat/completions', { method: 'POST', body: '{}' }), (e) => e.code === 'EPRIVATEADDR');
  await assert.rejects(pf('http://api.example.com/'), TypeError);
  // 校验时是公网、连接时变成内网：连接用的 lookup 每次都重新判断
  let n = 0;
  const flip = createSafeLookup((h, o, cb) => cb(null, [{ address: n++ === 0 ? '93.184.216.34' : '127.0.0.1', family: 4 }]));
  assert.equal((await call(flip, {})).a, '93.184.216.34');
  assert.equal((await call(flip, {})).err?.code, 'EPRIVATEADDR');
});

test('附加参数：只收 JSON 对象，不许改 model/messages/stream', () => {
  assert.equal(parseExtra({ thinking: { type: 'disabled' } }), '{"thinking":{"type":"disabled"}}');
  assert.equal(parseExtra('{"top_p":0.8}'), '{"top_p":0.8}');
  assert.equal(parseExtra(''), null);
  assert.equal(parseExtra({}), null);
  for (const v of ['[1]', 'x', '1', { model: 'x' }, { messages: [] }, { stream: false }]) assert.throws(() => parseExtra(v), HttpError);
});

test('提示词：硬性底线规则一律加上（不论 nsfw）', () => {
  assert.match(SAFETY_RULE, /未成年人/);
  for (const nsfw of [0, 1]) {
    const msgs = buildMessages({ definition: { personality: 'x' }, charName: 'C', user: { display_name: 'U', nsfw_enabled: nsfw }, history: [{ role: 'user', content: 'hi' }] });
    assert.ok(msgs[0].content.includes(SAFETY_RULE));
  }
});

// ---------- 预置 ----------
function keysFileWith(vars) {
  const f = path.join(dir, `keys-${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(f, Object.entries(vars).map(([k, v]) => `export ${k}="${v}"`).join('\n') + '\n');
  return f;
}

test('预置：只插 key 存在的；DeepSeek 快速为全站默认且启用；其他停用；只跑一次', () => {
  const d = path.join(dir, 'seed1'); mkdirSync(d, { recursive: true });
  const db = openDb(path.join(d, 'a.sqlite'));
  const kf = keysFileWith({ DEEPSEEK_API_KEY: FAKE_KEY, GLM_API_KEY: 'glm-fake-key', KIMI_API_KEY: 'kimi-fake' /* 没有 KIMI_API_BASE_URL → 不插 */ });
  const ins = seedModels(db, { keysFile: kf });
  assert.deepEqual(ins.map((m) => m.name), ['DeepSeek 快速', 'DeepSeek 专业', '智谱 GLM']);
  const rows = db.prepare('SELECT * FROM models ORDER BY sort').all();
  assert.equal(rows[0].model, 'deepseek-flash');
  assert.equal(rows[1].model, 'deepseek-v4-pro');
  assert.deepEqual(rows.map((r) => r.enabled), [1, 1, 0]);
  assert.deepEqual(JSON.parse(rows[0].extra_json), { thinking: { type: 'disabled' } });
  assert.equal(rows[0].api_key_env, 'DEEPSEEK_API_KEY');
  assert.equal(rows[0].api_key_enc, null);
  assert.equal(getSettings(db).default_model_id, rows[0].id);
  assert.deepEqual(seedModels(db, { keysFile: kf }), []);
  // 管理员删光了也不会再预置
  db.exec('DELETE FROM models');
  assert.deepEqual(seedModels(db, { keysFile: kf }), []);
  db.close();
  assert.ok(PRESETS.every((p) => p.model && p.keyEnv));
  assert.ok(!PRESETS.some((p) => p.model === 'glm-5.3-flash'), 'glm-5.3-flash 关不掉思考，不能预置');
});

test('解析顺序：会话 → 用户默认 → 全站默认 → 第一个启用的；停用自动回落', () => {
  const d = path.join(dir, 'resolve'); mkdirSync(d, { recursive: true });
  const db = openDb(path.join(d, 'a.sqlite'));
  const add = (name, enabled, sort) => Number(db.prepare("INSERT INTO models(name, provider, base_url, api_key_env, model, enabled, sort, created_at) VALUES (?, 'P', 'https://x.example.com', 'X_KEY', ?, ?, ?, ?)")
    .run(name, name, enabled, sort, nowIso()).lastInsertRowid);
  const a = add('A', 1, 1), b = add('B', 1, 2), c = add('C', 1, 3), off = add('OFF', 0, 0);
  const svc = createModelService({ db });
  const user = { default_model_id: null };
  assert.equal(svc.forChat({ model_id: null }, user).id, a, '什么都没设 → 第一个启用的');
  db.prepare("UPDATE settings SET value = ? WHERE key = 'default_model_id'").run(String(b));
  assert.equal(svc.forChat({ model_id: null }, user).id, b, '全站默认');
  assert.equal(svc.forChat({ model_id: null }, { default_model_id: c }).id, c, '用户默认优先于全站');
  assert.equal(svc.forChat({ model_id: a }, { default_model_id: c }).id, a, '会话模型最优先');
  assert.equal(svc.forChat({ model_id: off }, { default_model_id: c }).id, c, '会话模型停用 → 回落用户默认');
  assert.equal(svc.forChat({ model_id: off }, { default_model_id: off }).id, b, '都停用 → 全站默认');
  db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(b);
  assert.equal(svc.forChat({ model_id: 999 }, { default_model_id: off }).id, a, '全站默认也停用 → 第一个启用的');
  db.exec('UPDATE models SET enabled = 0');
  assert.equal(svc.forChat({ model_id: a }, user), null);
  assert.throws(() => svc.requireEnabled(off), HttpError);
  assert.equal(svc.requireEnabled(null), null);
  db.close();
});

// ---------- 进程内假上游 ----------
// 按请求里的 model 字段决定行为：ok-* 正常流式（回显模型名）；risk 回 400 Content Exists Risk；filter 先吐两段再 content_filter；
// slow 不回；err500 回 500；sse-error 流里给 error 对象。
const upstreamLog = [];
function startUpstream() {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      upstreamLog.push({ url: req.url, auth: req.headers.authorization, body });
      const m = body.model;
      if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
      if (m === 'risk') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Content Exists Risk', type: 'invalid_request_error', param: null, code: 'invalid_request_error' } }));
        return;
      }
      if (m === 'bad-400-content') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid request: messages[1].content must be a string', type: 'invalid_request_error' } }));
        return;
      }
      if (m === 'blocked-451') { res.writeHead(451, { 'content-type': 'application/json' }); res.end('{"error":{"message":"blocked"}}'); return; }
      if (m === 'err500') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"boom"}}'); return; }
      if (m === 'slow') return; // 永远不回
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: m, choices: [{ message: { content: `你好，我是${m}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (m === 'sse-error') { chunk({ model: m, choices: [{ delta: { content: '前半' } }] }); chunk({ error: { message: 'Content Exists Risk' } }); res.end(); return; }
      chunk({ model: m, choices: [{ delta: { role: 'assistant', content: '' } }] });
      chunk({ model: m, choices: [{ delta: { content: '你好，' } }] });
      chunk({ model: m, choices: [{ delta: { content: `我是${m}` } }] });
      if (m === 'filter') { chunk({ model: m, choices: [{ delta: {}, finish_reason: 'content_filter' }] }); res.end('data: [DONE]\n\n'); return; }
      chunk({ model: m, choices: [{ delta: {}, finish_reason: 'stop' }] });
      chunk({ model: m, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } });
      res.end('data: [DONE]\n\n');
    });
  });
  return srv;
}

function addMockModel(db, svc, { name, model, enabled = 1, extra = null }, upBase) {
  const max = db.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM models').get().m;
  // 直接写库（绕过 SSRF 校验，因为假上游在 127.0.0.1）；key 走加密存库
  return Number(db.prepare('INSERT INTO models(name, provider, base_url, api_key_env, api_key_enc, model, enabled, sort, extra_json, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)')
    .run(name, '测试', upBase, svc._enc(FAKE_KEY), model, enabled, max + 1, extra ? JSON.stringify(extra) : null, nowIso()).lastInsertRowid);
}

const NODES = {
  'tester/girl': { fullPath: 'tester/girl', name: 'Girl', tagline: 'hi', avatar_url: 'https://avatars.charhub.io/a/g.webp', topics: [], nsfw_image: false,
    definition: { name: 'Girl', first_message: '你好，{{user}}！' } },
};
const fakeChub = {
  async search() { return { items: Object.values(NODES).map(nodeToCard), page: 1, has_more: false }; },
  async character(p) { if (!NODES[p]) throw new HttpError(404, 'x'); return structuredClone(NODES[p]); },
};

let up, upBase, appServer, base, db, svc, ids = {};
let logs = [];
before(async () => {
  up = startUpstream();
  const upPort = await listenFree(up, PORTS);
  upBase = `http://127.0.0.1:${upPort}/v1`;
  const d = path.join(dir, 'app'); mkdirSync(d, { recursive: true });
  db = openDb(path.join(d, 'aichat.sqlite'));
  const ins = db.prepare('INSERT INTO users(username, password_hash, display_name, is_admin, created_at) VALUES (?, ?, ?, ?, ?)');
  ins.run('boss', hashPassword('boss-pass-1'), '老板', 1, nowIso());
  ins.run('alice', hashPassword('alice-pass-1'), '爱丽丝', 0, nowIso());
  db.exec("UPDATE users SET role = 'super' WHERE is_admin = 1"); // 契约 §9：鉴权看 role，测试里的管理员是超级管理员
  const secretFile = path.join(d, 'secret.key');
  // 管理接口的 DNS 用假的：*.example.com 解析成公网地址，evil.example.com 解析成环回
  const lookup = async (h) => [{ address: h === 'evil.example.com' ? '127.0.0.1' : '93.184.216.34', family: 4 }];
  svc = createModelService({ db, secretFile, lookup });
  const key = loadOrCreateSecret(secretFile);
  svc._enc = (p) => encryptSecret(p, key);
  ids.a = addMockModel(db, svc, { name: '甲', model: 'ok-a', extra: { thinking: { type: 'disabled' }, top_p: 0.5 } }, upBase);
  ids.b = addMockModel(db, svc, { name: '乙', model: 'ok-b' }, upBase);
  ids.off = addMockModel(db, svc, { name: '停用', model: 'ok-off', enabled: 0 }, upBase);
  ids.risk = addMockModel(db, svc, { name: '拒答', model: 'risk' }, upBase);
  ids.filter = addMockModel(db, svc, { name: '截断', model: 'filter' }, upBase);
  ids.slow = addMockModel(db, svc, { name: '慢', model: 'slow' }, upBase);
  ids.err = addMockModel(db, svc, { name: '坏', model: 'err500' }, upBase);
  ids.sseErr = addMockModel(db, svc, { name: '流错', model: 'sse-error' }, upBase);
  const llm = createLlm({ models: svc, checkUpstream: null, firstByteTimeoutMs: 400, idleTimeoutMs: 400 });
  const app = createApp({ db, chub: fakeChub, llm, models: svc, avatars: { get: async () => ({ type: 'image/png', buf: Buffer.from('x') }) },
    config: { publicDir: path.join(d, 'pub'), deepseekModel: 'fake' } });
  appServer = http.createServer(app.handle);
  const port = await listenFree(appServer, PORTS);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((r) => appServer.close(r));
  up.closeAllConnections?.();
  await new Promise((r) => up.close(r));
  db.close();
});

async function login(u, p) { const c = new Client(base); assert.equal((await c.post('/api/login', { username: u, password: p })).status, 200); return c; }

test('llm：按模型的 base_url / 解密后的 key / extra 浅合并调用；流式拼接；用量与真实模型 ID', async () => {
  const llm = createLlm({ models: svc, checkUpstream: null });
  upstreamLog.length = 0;
  const deltas = [];
  const r = await llm.streamChat([{ role: 'user', content: '用一句话打个招呼' }], { model: svc.byId(ids.a), onDelta: (t) => deltas.push(t) });
  assert.equal(r.text, '你好，我是ok-a');
  assert.equal(deltas.join(''), r.text);
  assert.equal(r.model, 'ok-a');
  assert.equal(r.tokens_in, 11);
  assert.equal(r.tokens_out, 7);
  const call = upstreamLog[0];
  assert.equal(call.auth, `Bearer ${FAKE_KEY}`);
  assert.equal(call.body.model, 'ok-a');
  assert.deepEqual(call.body.thinking, { type: 'disabled' });
  assert.equal(call.body.top_p, 0.5);
  assert.equal(call.body.stream, true);
  assert.equal(call.body.max_tokens, 1024);
  const c = await llm.complete([{ role: 'user', content: 'x' }], { model: svc.byId(ids.b) });
  assert.equal(c.text, '你好，我是ok-b');
});

test('llm：400 Content Exists Risk → refused；content_filter → refused 且带已生成部分；流内 error → refused；500 → upstream；超时 → timeout', async () => {
  const llm = createLlm({ models: svc, checkUpstream: null, firstByteTimeoutMs: 300, idleTimeoutMs: 300 });
  const run = (id) => llm.streamChat([{ role: 'user', content: 'x' }], { model: svc.byId(id) });
  await assert.rejects(run(ids.risk), (e) => e.code === 'refused' && e.message === REFUSED_MESSAGE && e.partial === '');
  await assert.rejects(run(ids.filter), (e) => e.code === 'refused' && e.partial === '你好，我是filter');
  await assert.rejects(run(ids.sseErr), (e) => e.code === 'refused' && e.partial === '前半');
  await assert.rejects(run(ids.err), (e) => e.code === 'upstream' && !/boom/.test(e.message));
  // 参数校验错误（正文含 messages[1].content）是配置问题，不能报成拒答；451 本身就是拦截
  const bad400 = addMockModel(db, svc, { name: '参数错', model: 'bad-400-content', enabled: 0 }, upBase);
  const b451 = addMockModel(db, svc, { name: '451', model: 'blocked-451', enabled: 0 }, upBase);
  try {
    await assert.rejects(run(bad400), (e) => e.code === 'upstream' && e.message !== REFUSED_MESSAGE);
    await assert.rejects(run(b451), (e) => e.code === 'refused');
  } finally {
    db.prepare('DELETE FROM models WHERE id IN (?, ?)').run(bad400, b451);
  }
  const t0 = Date.now();
  await assert.rejects(run(ids.slow), (e) => e.code === 'timeout');
  assert.ok(Date.now() - t0 < 3000);
});

test('llm：默认检查会拦住指向内网的接口地址（防 SSRF / DNS 重绑定）', async () => {
  const llm = createLlm({ models: svc }); // 不关检查
  upstreamLog.length = 0;
  await assert.rejects(llm.streamChat([{ role: 'user', content: 'x' }], { model: svc.byId(ids.a) }), (e) => e.code === 'upstream');
  assert.equal(upstreamLog.length, 0, '请求不该发出去');
});

test('GET /api/models 只列启用的，不泄露 base_url / key / env 名；/api/me 带 default_model_id', async () => {
  const u = await login('alice', 'alice-pass-1');
  const r = await u.get('/api/models');
  assert.equal(r.status, 200);
  assert.ok(r.json.items.length > 0);
  assert.ok(!r.json.items.some((m) => m.id === ids.off), '停用的不该列出');
  for (const m of r.json.items) assert.deepEqual(Object.keys(m).sort(), ['id', 'name', 'provider']);
  for (const bad of ['127.0.0.1', '/v1', FAKE_KEY, FAKE_KEY.slice(-4), 'api_key', 'base_url', 'secret']) assert.ok(!r.text.includes(bad), bad);
  assert.equal(r.json.default_model_id, ids.a);
  assert.equal((await u.get('/api/me')).json.user.default_model_id, null);
});

test('普通用户不能用停用模型；默认模型设置与清除', async () => {
  const u = await login('alice', 'alice-pass-1');
  assert.equal((await u.patch('/api/me', { default_model_id: ids.off })).status, 400);
  assert.equal((await u.patch('/api/me', { default_model_id: 99999 })).status, 400);
  assert.equal((await u.patch('/api/me', { default_model_id: 'abc' })).status, 400);
  assert.equal((await u.post('/api/chats', { path: 'tester/girl', model_id: ids.off })).status, 400);
  const ok = await u.patch('/api/me', { default_model_id: ids.b });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.default_model_id, ids.b);
  const chat = (await u.post('/api/chats', { path: 'tester/girl' })).json.chat;
  assert.deepEqual(chat.model, { id: ids.b, name: '乙' }, '新会话用用户默认');
  assert.equal(db.prepare('SELECT model_id FROM chats WHERE id = ?').get(chat.id).model_id, ids.b, '新建时把解析出的模型写进 chats.model_id');
  assert.equal((await u.patch(`/api/chats/${chat.id}`, { model_id: ids.off })).status, 400);
  assert.equal((await u.patch('/api/me', { default_model_id: null })).json.user.default_model_id, null);
  const chat2 = (await u.post('/api/chats', { path: 'tester/girl', model_id: ids.a })).json.chat;
  assert.equal(chat2.model.id, ids.a);
});

test('切换会话模型后，下一条回复用新模型，messages.model 写真实模型 ID', async () => {
  const u = await login('alice', 'alice-pass-1');
  const chat = (await u.post('/api/chats', { path: 'tester/girl', model_id: ids.a })).json.chat;
  let ev = parseSse((await u.post(`/api/chats/${chat.id}/messages`, { content: '用一句话打个招呼' })).text);
  assert.equal(ev.find((e) => e.event === 'done').data.message.content, '你好，我是ok-a');
  const sw = await u.patch(`/api/chats/${chat.id}`, { model_id: ids.b });
  assert.equal(sw.status, 200);
  assert.deepEqual(sw.json.chat.model, { id: ids.b, name: '乙' });
  ev = parseSse((await u.post(`/api/chats/${chat.id}/messages`, { content: '再打个招呼' })).text);
  assert.equal(ev.find((e) => e.event === 'done').data.message.content, '你好，我是ok-b');
  const models = db.prepare("SELECT model FROM messages WHERE chat_id = ? AND role = 'assistant' AND model IS NOT NULL ORDER BY id").all(chat.id).map((r) => r.model);
  assert.deepEqual(models, ['ok-a', 'ok-b']);
  const got = (await u.get(`/api/chats/${chat.id}`)).json;
  assert.deepEqual(got.chat.model, { id: ids.b, name: '乙' });
  const list = (await u.get('/api/chats')).json.items.find((x) => x.id === chat.id);
  assert.deepEqual(list.model, { id: ids.b, name: '乙' });
  // 会话的模型被停用 → 自动回落，不报错
  db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(ids.b);
  try {
    const fb = (await u.get(`/api/chats/${chat.id}`)).json.chat.model;
    assert.equal(fb.id, ids.a);
    ev = parseSse((await u.post(`/api/chats/${chat.id}/messages`, { content: '还在吗' })).text);
    assert.equal(ev.find((e) => e.event === 'done').data.message.content, '你好，我是ok-a');
  } finally { db.prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(ids.b); }
});

test('SSE 错误带 code：refused（部分照存）/ upstream / timeout', async () => {
  const u = await login('alice', 'alice-pass-1');
  const send = async (modelId) => {
    const chat = (await u.post('/api/chats', { path: 'tester/girl', model_id: modelId })).json.chat;
    const r = await u.post(`/api/chats/${chat.id}/messages`, { content: '你好' });
    assert.equal(r.status, 200);
    return { chat, ev: parseSse(r.text) };
  };
  let { ev } = await send(ids.risk);
  let err = ev.find((e) => e.event === 'error');
  assert.deepEqual({ error: err.data.error, code: err.data.code }, { error: '这个模型拒绝了这条内容，可以换个模型再试', code: 'refused' });
  assert.ok(!ev.some((e) => e.event === 'done'));
  let chat;
  ({ ev, chat } = await send(ids.filter));
  err = ev.find((e) => e.event === 'error');
  assert.equal(err.data.code, 'refused');
  assert.equal(err.data.message.content, '你好，我是filter', '已生成的部分照常保存并回给前端');
  const msgs = (await u.get(`/api/chats/${chat.id}`)).json.messages;
  assert.equal(msgs[msgs.length - 1].content, '你好，我是filter');
  assert.equal(db.prepare('SELECT model FROM messages WHERE id = ?').get(msgs[msgs.length - 1].id).model, 'filter');
  ({ ev } = await send(ids.err));
  assert.equal(ev.find((e) => e.event === 'error').data.code, 'upstream');
  ({ ev } = await send(ids.slow));
  assert.equal(ev.find((e) => e.event === 'error').data.code, 'timeout');
});

test('管理：列表只给 key_set / key_hint；新建校验 SSRF；改 key 留空不改；测试；排序；默认；删除在用的改停用', async () => {
  const a = await login('boss', 'boss-pass-1');
  const u = await login('alice', 'alice-pass-1');
  for (const [m, p] of [['GET', '/api/admin/models'], ['POST', '/api/admin/models'], ['PATCH', `/api/admin/models/${ids.a}`], ['DELETE', `/api/admin/models/${ids.a}`], ['POST', `/api/admin/models/${ids.a}/test`], ['POST', '/api/admin/models/order']]) {
    assert.equal((await u.req(m, p, m === 'GET' || m === 'DELETE' ? undefined : {})).status, 403, `${m} ${p}`);
  }
  const list = await a.get('/api/admin/models');
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes(FAKE_KEY), '管理列表也不能回完整 key');
  assert.ok(!list.text.includes('api_key_enc'));
  const ma = list.json.items.find((m) => m.id === ids.a);
  assert.equal(ma.key_set, true);
  assert.equal(ma.key_hint, FAKE_KEY.slice(-4));
  assert.equal(ma.key_source, 'stored');
  assert.equal(ma.base_url, upBase);
  assert.equal(ma.model, 'ok-a');

  const bad = async (body) => (await a.post('/api/admin/models', { name: 'X', model: 'x-1', api_key: 'sk-new-key-1234', ...body })).status;
  assert.equal(await bad({ base_url: 'http://api.example.com/v1' }), 400);
  assert.equal(await bad({ base_url: 'https://127.0.0.1/v1' }), 400);
  assert.equal(await bad({ base_url: 'https://10.0.0.8/v1' }), 400);
  assert.equal(await bad({ base_url: 'https://localhost/v1' }), 400);
  assert.equal(await bad({ base_url: 'https://[::1]/v1' }), 400);
  assert.equal(await bad({ base_url: 'https://evil.example.com/v1' }), 400, 'DNS 指向环回');
  assert.equal(await bad({ base_url: 'https://ok.example.com/v1', extra_json: '[1]' }), 400);
  assert.equal(await bad({ base_url: 'https://ok.example.com/v1', api_key: '' }), 400, '新建必须给 key');
  const created = await a.post('/api/admin/models', { name: '新模型', provider: '某家', base_url: 'https://ok.example.com/v1/', model: 'new-1', api_key: 'sk-new-key-1234', extra_json: '{"top_p":0.9}' });
  assert.equal(created.status, 200, created.text);
  const nm = created.json.model;
  assert.equal(nm.base_url, 'https://ok.example.com/v1');
  assert.equal(nm.key_hint, '1234');
  assert.ok(!created.text.includes('sk-new-key-1234'));
  const enc = db.prepare('SELECT api_key_enc, api_key_env FROM models WHERE id = ?').get(nm.id);
  assert.ok(enc.api_key_enc && !enc.api_key_enc.includes('sk-new'), '库里是密文');
  assert.equal(enc.api_key_env, null);
  // 改名，key 留空 = 不改
  const p1 = await a.patch(`/api/admin/models/${nm.id}`, { name: '新模型2', api_key: '' });
  assert.equal(p1.json.model.name, '新模型2');
  assert.equal(db.prepare('SELECT api_key_enc FROM models WHERE id = ?').get(nm.id).api_key_enc, enc.api_key_enc);
  assert.equal((await a.patch(`/api/admin/models/${nm.id}`, { base_url: 'https://169.254.169.254/' })).status, 400);
  assert.equal((await a.patch(`/api/admin/models/${nm.id}`, { api_key_env: 'bad name' })).status, 400);
  // 防把 key 送到别的服务器：改了主机必须重填密钥；变量名只认预置的；变量来源的 key 只能发往它本来的主机
  const moved = await a.patch(`/api/admin/models/${nm.id}`, { base_url: 'https://other.example.com/v1' });
  assert.equal(moved.status, 400);
  assert.match(moved.json.error, /改了接口地址需要重新填写密钥/);
  assert.equal(db.prepare('SELECT base_url FROM models WHERE id = ?').get(nm.id).base_url, 'https://ok.example.com/v1');
  assert.equal((await a.patch(`/api/admin/models/${nm.id}`, { base_url: 'https://ok.example.com/v2' })).status, 200, '同主机换路径不用重填');
  const moved2 = await a.patch(`/api/admin/models/${nm.id}`, { base_url: 'https://other.example.com/v1', api_key: 'sk-other-key-5678' });
  assert.equal(moved2.status, 200, moved2.text);
  assert.equal(moved2.json.model.key_hint, '5678');
  assert.equal((await a.patch(`/api/admin/models/${nm.id}`, { api_key_env: 'ANTHROPIC_API_KEY' })).status, 400, '非预置变量名');
  assert.equal((await a.patch(`/api/admin/models/${nm.id}`, { api_key_env: 'DEEPSEEK_API_KEY' })).status, 400, 'DeepSeek 的 key 不能发往别的主机');
  assert.equal(await bad({ base_url: 'https://attacker.example.com/v1', api_key: '', api_key_env: 'DEEPSEEK_API_KEY' }), 400);
  assert.equal(await bad({ base_url: 'https://attacker.example.com/v1', api_key: '', api_key_env: 'OPENAI_API_KEY' }), 400);
  const envRow = await a.post('/api/admin/models', { name: 'DS 变量', model: 'deepseek-flash', base_url: 'https://api.deepseek.com', api_key_env: 'DEEPSEEK_API_KEY' });
  assert.equal(envRow.status, 200, envRow.text);
  assert.equal(envRow.json.model.key_source, 'env');
  assert.equal(envRow.json.model.key_hint, '');
  const steal = await a.patch(`/api/admin/models/${envRow.json.model.id}`, { base_url: 'https://attacker.example.com/v1' });
  assert.equal(steal.status, 400, '变量来源的行改地址不填密钥必须拒');
  const kept = db.prepare('SELECT base_url, api_key_env FROM models WHERE id = ?').get(envRow.json.model.id);
  assert.deepEqual({ ...kept }, { base_url: 'https://api.deepseek.com', api_key_env: 'DEEPSEEK_API_KEY' });
  assert.equal((await a.patch(`/api/admin/models/${envRow.json.model.id}`, { name: 'DS 变量 2' })).status, 200);
  assert.equal((await a.del(`/api/admin/models/${envRow.json.model.id}`)).status, 200);
  assert.equal((await a.patch('/api/admin/models/99999', { name: 'x' })).status, 404);

  // 测试按钮
  const t1 = await a.post(`/api/admin/models/${ids.a}/test`);
  assert.equal(t1.json.ok, true);
  assert.equal(typeof t1.json.latency_ms, 'number');
  assert.match(t1.json.sample, /ok-a/);
  const t2 = await a.post(`/api/admin/models/${ids.risk}/test`);
  assert.equal(t2.json.ok, false);
  assert.ok(t2.json.error);
  const t3 = await a.post(`/api/admin/models/${ids.off}/test`);
  assert.equal(t3.json.ok, true, '停用的也能测');

  // 排序
  const order = [ids.b, ids.a, ...list.json.items.map((m) => m.id).filter((x) => x !== ids.a && x !== ids.b)];
  const o = await a.post('/api/admin/models/order', { ids: order });
  assert.equal(o.status, 200);
  assert.deepEqual(o.json.items.slice(0, 2).map((m) => m.id), [ids.b, ids.a]);
  assert.equal((await u.get('/api/models')).json.default_model_id, ids.b, '没设全站默认 → 第一个启用的');

  // 全站默认
  assert.equal((await a.patch('/api/admin/settings', { default_model_id: ids.off })).status, 400);
  const s = await a.patch('/api/admin/settings', { default_model_id: ids.a });
  assert.equal(s.json.settings.default_model_id, ids.a);
  assert.equal((await u.get('/api/models')).json.default_model_id, ids.a);
  assert.equal((await a.get('/api/admin/models')).json.items.find((m) => m.id === ids.a).is_default, true);

  // 删除：没人用 → 真删；有会话在用 → 改停用
  const del1 = await a.del(`/api/admin/models/${nm.id}`);
  assert.deepEqual(del1.json, { ok: true, deleted: true });
  assert.equal(db.prepare('SELECT 1 FROM models WHERE id = ?').get(nm.id), undefined);
  const del2 = await a.del(`/api/admin/models/${ids.a}`);
  assert.deepEqual(del2.json, { ok: true, disabled: true });
  assert.equal(db.prepare('SELECT enabled FROM models WHERE id = ?').get(ids.a).enabled, 0);
  assert.ok(!(await u.get('/api/models')).json.items.some((m) => m.id === ids.a));
  db.prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(ids.a);
});

test('没有任何启用的模型：生成回 SSE error（upstream），不崩', async () => {
  const u = await login('alice', 'alice-pass-1');
  const chat = (await u.post('/api/chats', { path: 'tester/girl' })).json.chat;
  const saved = db.prepare('SELECT id, enabled FROM models').all();
  db.exec('UPDATE models SET enabled = 0');
  try {
    assert.equal((await u.get('/api/models')).json.items.length, 0);
    const ev = parseSse((await u.post(`/api/chats/${chat.id}/messages`, { content: 'hi' })).text);
    assert.equal(ev.find((e) => e.event === 'error').data.code, 'upstream');
  } finally {
    for (const r of saved) db.prepare('UPDATE models SET enabled = ? WHERE id = ?').run(r.enabled, r.id);
  }
});
