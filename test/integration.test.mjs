// 集成测试：起真服务（PORT=44982 起），用真 chub 与真 DeepSeek 走一遍完整流程。
// 需要外网；key 只在本进程内读来做「响应里不得出现」的检查，不打印。
// 此用例默认选择「DeepSeek 专业」（deepseek-v4-pro），运行前确认账户和模型可用。
// 设 IT_DEEPSEEK_FAST=1 时额外用「DeepSeek 快速」真发一句（可选的额外模型验证）。
const TRY_FAST = process.env.IT_DEEPSEEK_FAST === '1';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../server/config.mjs';
import { readKeyFromEnvFile, looksChinese } from '../server/llm.mjs';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpDir, cleanupTmp, pickPort, Client, parseSse } from './helpers.mjs';

const KEYS_FILE = process.env.AI_KEYS_FILE || path.join(ROOT, 'config/ai-keys.env');
const KEY = readKeyFromEnvFile(KEYS_FILE);
// 本机 key 文件里所有 key 的值（只在本进程里用来做「响应 / 日志里不得出现」的检查，不打印）
const ALL_KEYS = (() => {
  let text = '';
  try { text = readFileSync(KEYS_FILE, 'utf8'); } catch { return []; }
  return [...text.matchAll(/^\s*(?:export\s+)?([A-Z0-9_]*_KEY)\s*=/gm)].map((m) => readKeyFromEnvFile(KEYS_FILE, m[1])).filter((v) => v && v.length >= 12);
})();
const ADMIN_PW = 'it-admin-' + Math.random().toString(36).slice(2, 10);
const USER_PW = 'it-user-pass-1';

let child, dir, base, port, skipReason = '';
let logs = '';
const clients = [];
const newClient = () => { const c = new Client(base); clients.push(c); return c; };

async function waitHealthy(ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(base + '/healthz'); if (r.ok) return; } catch { /* 还没起来 */ }
    if (child.exitCode !== null) throw new Error('服务启动失败：\n' + logs);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('服务启动超时：\n' + logs);
}

before(async () => {
  dir = tmpDir('int');
  const pub = path.join(dir, 'public');
  mkdirSync(pub, { recursive: true });
  writeFileSync(path.join(pub, 'index.html'), '<!doctype html><title>fake</title><p>FAKE-INDEX</p>');
  writeFileSync(path.join(pub, 'app.js'), 'export const x = 1;');
  // 候选覆盖全部开发口；都被占用时整组跳过（写明原因），不要报成功能失败。
  try { port = await pickPort([44982, 44983, 44984, 44985, 44986, 44987, 44988, 44989]); } catch (e) { skipReason = '开发口 44982–44989 都被占用，跳过集成测试'; return; }
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: path.join(dir, 'data'), PUBLIC_DIR: pub, ADMIN_BOOTSTRAP_PASSWORD: ADMIN_PW, AI_KEYS_FILE: KEYS_FILE, MODEL_SEED_PROBE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  await waitHealthy();
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    process.kill(child.pid, 'SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    if (child.exitCode === null) process.kill(child.pid, 'SIGKILL');
  }
  cleanupTmp(dir);
});

function httpsGet(p) {
  return new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port, path: p, rejectUnauthorized: false }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

function rawGet(p, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location }); }).on('error', reject);
  });
}

test('完整流程（真 chub + 真 DeepSeek）', { timeout: 300000 }, async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  assert.ok(KEY, '本机没有配置 DeepSeek key，无法跑集成测试');
  const admin = newClient();
  const user = newClient();

  await t.test('同端口 https + 明文浏览器导航 308 跳 https + healthz 不跳', async () => {
    if (existsSync(path.join(ROOT, 'config/ssl/chat.example.com.key'))) {
      const r = await httpsGet('/healthz');
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.body), { ok: true });
    }
    const nav = await rawGet('/c/abc', { host: `chat.example.com:${port}`, accept: 'text/html' });
    assert.equal(nav.status, 308);
    assert.equal(nav.location, `https://chat.example.com:${port}/c/abc`);
    assert.equal((await rawGet('/healthz', { host: `chat.example.com:${port}`, accept: 'text/html' })).status, 200);
    assert.equal((await rawGet('/api/chats', { host: `chat.example.com:${port}`, accept: 'application/json' })).status, 401);
  });

  await t.test('静态文件与 SPA 回退', async () => {
    const c = newClient();
    assert.match((await c.get('/')).text, /FAKE-INDEX/);
    assert.match((await c.get('/chat/12')).text, /FAKE-INDEX/);
    assert.equal((await c.get('/app.js')).text, 'export const x = 1;');
    assert.match((await c.get('/../../etc/passwd')).text, /FAKE-INDEX/);
    assert.equal((await c.get('/api/unknown')).status, 404);
  });

  await t.test('管理员登录并开普通账号', async () => {
    const r = await admin.post('/api/login', { username: 'admin', password: ADMIN_PW });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.user.is_admin, 1);
    assert.equal(r.json.user.role, 'super', '首次启动建的 admin 是超级管理员');
    const cu = await admin.post('/api/admin/users', { username: 'sguser', password: USER_PW, display_name: '小明' });
    assert.equal(cu.status, 200, cu.text);
    const lr = await user.post('/api/login', { username: 'sguser', password: USER_PW });
    assert.equal(lr.status, 200);
    assert.equal(lr.json.user.nsfw_enabled, 0);
    // 契约 §13.3：管理员直接开的号首次登录必须先改密码，改之前其他接口一律 403
    assert.equal(lr.json.user.must_change_password, true);
    const blocked = await user.get('/api/home');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.code, 'must_change_password');
    const pw = await user.post('/api/me/password', { old_password: USER_PW, new_password: `${USER_PW}-new` });
    assert.equal(pw.status, 200, pw.text);
    assert.equal(pw.json.user.must_change_password, false);
  });

  let proId;
  await t.test('全站默认模型与翻译模型切到「DeepSeek 专业」（真调用只走 deepseek-v4-pro）', async () => {
    const pro = (await admin.get('/api/admin/models')).json.items.find((m) => m.model === 'deepseek-v4-pro');
    assert.ok(pro && pro.enabled, '没有启用的 DeepSeek 专业');
    proId = pro.id;
    const r = await admin.patch('/api/admin/settings', { default_model_id: pro.id, translate_model_id: pro.id, voice_format_model_id: pro.id });
    assert.equal(r.status, 200, r.text);
  });

  let hot;
  await t.test('首页有热门', async () => {
    const r = await user.get('/api/home');
    assert.equal(r.status, 200, r.text);
    hot = r.json.hot;
    assert.ok(hot.length > 0, '热门为空');
    for (const c of hot) {
      assert.equal(c.nsfw, false);
      assert.ok(c.path && c.name);
      assert.match(c.avatar, /^\/api\/avatar\?u=/);
    }
  });

  await t.test('搜索', async () => {
    const r = await user.get('/api/search?q=detective&sort=download_count&page=1');
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.items.length > 0);
    assert.equal(r.json.page, 1);
    assert.equal(typeof r.json.has_more, 'boolean');
    assert.ok(r.json.items.every((c) => !c.nsfw));
    assert.equal((await user.get('/api/search?sort=bad')).status, 400);
  });

  await t.test('头像代理', async () => {
    const r = await fetch(base + hot[0].avatar, { headers: { cookie: user.cookie } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^image\//);
    assert.match(r.headers.get('cache-control'), /max-age=604800/);
    await r.arrayBuffer();
    assert.equal((await user.get('/api/avatar?u=' + encodeURIComponent('http://169.254.169.254/'))).status, 403);
  });

  let character;
  await t.test('角色详情带中文开场白', async () => {
    for (const c of hot.slice(0, 6)) {
      const r = await user.get('/api/characters/' + c.path);
      assert.equal(r.status, 200, r.text);
      if (r.json.character.greeting.trim()) { character = r.json.character; break; }
    }
    assert.ok(character, '前 6 个热门角色都没有开场白');
    // 契约 §19.2：详情秒开（原文），后台整卡翻译，≤2 分钟内完成；轮询到翻译结束
    const t1 = Date.now();
    while (character.translate_status === 'pending' && Date.now() - t1 < 120000) {
      await new Promise((r) => setTimeout(r, 1500));
      character = (await user.get('/api/characters/' + character.path)).json.character;
    }
    assert.ok(['ok', 'partial'].includes(character.translate_status), `翻译状态：${character.translate_status}`);
    assert.ok(character.data && character.data_zh, '详情没有全部设定（原文 + 译文）');
    assert.ok(character.name_zh, '没有中文名');
    assert.ok(character.greeting_zh.trim());
    assert.ok(looksChinese(character.greeting_zh), '开场白没有翻译成中文');
    assert.ok(!/\{\{(char|user)\}\}/i.test(character.greeting_zh));
    // 第二次走缓存
    const t0 = Date.now();
    const again = await user.get('/api/characters/' + character.path);
    assert.equal(again.json.character.greeting_zh, character.greeting_zh);
    assert.ok(Date.now() - t0 < 3000, '缓存没有生效');
  });

  let chatId;
  await t.test('新建会话，第一条是中文开场白', async () => {
    const r = await user.post('/api/chats', { path: character.path });
    assert.equal(r.status, 200, r.text);
    chatId = r.json.chat.id;
    const d = await user.get(`/api/chats/${chatId}`);
    assert.equal(d.json.messages.length, 1);
    assert.equal(d.json.messages[0].role, 'assistant');
    assert.equal(d.json.messages[0].content, character.greeting_zh);
  });

  await t.test('发消息收到中文 SSE 回复', async () => {
    const r = await user.post(`/api/chats/${chatId}/messages`, { content: '*轻轻挥手* 你好，很高兴认识你。你今天在做什么？' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const ev = parseSse(r.text);
    assert.equal(ev[0].event, 'user');
    assert.ok(ev.filter((e) => e.event === 'delta').length > 1, '不是流式');
    const err = ev.find((e) => e.event === 'error');
    assert.ok(!err, err && err.data.error);
    const done = ev.find((e) => e.event === 'done');
    assert.ok(done, '没有 done 事件');
    assert.ok(looksChinese(done.data.message.content), '回复不是中文');
    // v0.4（契约 §10）：DeepSeek 不给实价 → 按人民币单价推算，> 0
    assert.equal(done.data.message.cost_source, 'estimate');
    assert.ok(done.data.message.cost_usd > 0, `cost_usd=${done.data.message.cost_usd}`);
    assert.ok(done.data.message.tokens_in > 0 && done.data.message.tokens_out > 0);
    assert.ok(done.data.chat_cost_usd > 0);
    const cd = (await user.get(`/api/chats/${chatId}`)).json.chat;
    assert.equal(cd.cost_partial, false);
    assert.ok(cd.cost_usd > 0);
    assert.equal(ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join('').trim(), done.data.message.content);
  });

  await t.test('重新生成', async () => {
    const before = (await user.get(`/api/chats/${chatId}`)).json.messages;
    const r = await user.post(`/api/chats/${chatId}/regenerate`);
    const ev = parseSse(r.text);
    const done = ev.find((e) => e.event === 'done');
    assert.ok(done, JSON.stringify(ev.find((e) => e.event === 'error')));
    assert.ok(looksChinese(done.data.message.content));
    const after = (await user.get(`/api/chats/${chatId}`)).json.messages;
    assert.equal(after.length, before.length);
    assert.notEqual(after[after.length - 1].id, before[before.length - 1].id);
  });

  await t.test('会话列表', async () => {
    const r = await user.get('/api/chats');
    assert.equal(r.json.items[0].id, chatId);
    assert.equal(r.json.items[0].character.path, character.path);
    assert.ok(r.json.items[0].last_message);
  });

  await t.test('管理员建货架，用户首页能看到；用量有记录', async () => {
    const sh = await admin.post('/api/admin/shelves', { title: '编辑推荐' });
    assert.equal(sh.status, 200, sh.text);
    const add = await admin.post(`/api/admin/shelves/${sh.json.shelf.id}/items`, { path: character.path });
    assert.equal(add.status, 200, add.text);
    const home = (await user.get('/api/home')).json;
    assert.equal(home.shelves[0].title, '编辑推荐');
    assert.equal(home.shelves[0].items[0].path, character.path);
    const usage = (await admin.get('/api/admin/usage?days=7')).json.items.find((x) => x.username === 'sguser');
    assert.equal(usage.messages, 2);
    assert.ok(usage.tokens_in > 0 && usage.tokens_out > 0);
  });

  await t.test('v0.2 模型：/api/models 只列启用的且不泄露接口地址 / key / 变量名', async () => {
    const r = await user.get('/api/models');
    assert.equal(r.status, 200, r.text);
    const names = r.json.items.map((m) => m.name);
    assert.ok(names.includes('DeepSeek 快速') && names.includes('DeepSeek 专业'), names.join(','));
    for (const m of r.json.items) assert.deepEqual(Object.keys(m).sort(), ['id', 'name', 'provider']);
    for (const bad of ['https://', 'api.deepseek.com', '_API_KEY', 'base_url', 'key_hint', ...ALL_KEYS.map((k) => k.slice(-8))]) assert.ok(!r.text.includes(bad), '泄露了 ' + bad.slice(0, 4));
    assert.equal(r.json.default_model_id, proId, '全站默认已切到 DeepSeek 专业');
    const adm = await admin.get('/api/admin/models');
    assert.equal(adm.status, 200);
    for (const k of ALL_KEYS) assert.ok(!adm.text.includes(k), '管理列表回了完整 key');
    assert.ok(adm.json.items.every((m) => m.key_set === true), '预置项的 key 都在');
    assert.ok(adm.json.items.filter((m) => m.key_source === 'env').every((m) => m.key_hint === ''), '中央密钥文件的 key 不回末 4 位');
  });

  await t.test('v0.2 模型：真 DeepSeek 发一句；切换会话模型后 messages.model 跟着变', async () => {
    const list = (await user.get('/api/models')).json.items;
    const fast = list.find((m) => m.name === 'DeepSeek 快速');
    const pro = list.find((m) => m.name === 'DeepSeek 专业');
    const cr = await user.post('/api/chats', { path: character.path, model_id: fast.id });
    assert.equal(cr.status, 200, cr.text);
    assert.deepEqual(cr.json.chat.model, { id: fast.id, name: fast.name });
    const id = cr.json.chat.id;
    if (!TRY_FAST) {
      // 快速版上游故障期间不真调：只验证会话模型能切换，真发一句走专业版
      const sw = await user.patch(`/api/chats/${id}`, { model_id: pro.id });
      assert.equal(sw.status, 200, sw.text);
      assert.equal(sw.json.chat.model.id, pro.id);
      const ev = parseSse((await user.post(`/api/chats/${id}/messages`, { content: '用一句话打个招呼' })).text);
      const err = ev.find((e) => e.event === 'error');
      assert.ok(!err, err && JSON.stringify(err.data));
      const done = ev.find((e) => e.event === 'done');
      assert.ok(done && done.data.message.content.trim());
      const ro = new DatabaseSync(path.join(dir, 'data', 'aichat.sqlite'), { readOnly: true });
      try {
        assert.equal(ro.prepare('SELECT model FROM messages WHERE id = ?').get(done.data.message.id).model, 'deepseek-v4-pro');
        assert.equal(ro.prepare('SELECT model_id FROM chats WHERE id = ?').get(id).model_id, pro.id);
      } finally { ro.close(); }
      return;
    }
    const say = async () => {
      const ev = parseSse((await user.post(`/api/chats/${id}/messages`, { content: '用一句话打个招呼' })).text);
      const err = ev.find((e) => e.event === 'error');
      assert.ok(!err, err && JSON.stringify(err.data));
      const done = ev.find((e) => e.event === 'done');
      assert.ok(done && done.data.message.content.trim());
      return done.data.message.id;
    };
    const m1 = await say();
    const sw = await user.patch(`/api/chats/${id}`, { model_id: pro.id });
    assert.equal(sw.status, 200, sw.text);
    assert.equal(sw.json.chat.model.id, pro.id);
    const m2 = await say();
    const ro = new DatabaseSync(path.join(dir, 'data', 'aichat.sqlite'), { readOnly: true });
    try {
      const q = ro.prepare('SELECT model FROM messages WHERE id = ?');
      assert.equal(q.get(m1).model, 'deepseek-flash');
      assert.equal(q.get(m2).model, 'deepseek-v4-pro');
      assert.equal(ro.prepare('SELECT model_id FROM chats WHERE id = ?').get(id).model_id, pro.id);
    } finally { ro.close(); }
    assert.equal((await user.get(`/api/chats/${id}`)).json.chat.model.id, pro.id);
  });

  await t.test('v0.2 模型：普通用户不能用停用的模型；管理员测试接口能通', async () => {
    const all = (await admin.get('/api/admin/models')).json.items;
    const off = all.find((m) => !m.enabled);
    if (off) {
      assert.equal((await user.post('/api/chats', { path: character.path, model_id: off.id })).status, 400);
      assert.equal((await user.patch('/api/me', { default_model_id: off.id })).status, 400);
      const c = (await user.get('/api/chats')).json.items[0];
      assert.equal((await user.patch(`/api/chats/${c.id}`, { model_id: off.id })).status, 400);
    }
    const probe = all.find((m) => m.model === (TRY_FAST ? 'deepseek-flash' : 'deepseek-v4-pro'));
    const tr = await admin.post(`/api/admin/models/${probe.id}/test`);
    assert.equal(tr.json.ok, true, JSON.stringify(tr.json));
    assert.ok(tr.json.sample && tr.json.latency_ms > 0);
    assert.equal((await user.post(`/api/admin/models/${probe.id}/test`)).status, 403);
  });

  await t.test('普通用户调 admin 接口 403', async () => {
    assert.equal((await user.get('/api/admin/users')).status, 403);
    assert.equal((await user.post('/api/admin/users', { username: 'hack', password: '12345678' })).status, 403);
    assert.equal((await user.get('/api/admin/settings')).status, 403);
  });

  await t.test('nsfw 关的用户打不开 nsfw 角色', async () => {
    await admin.patch('/api/me', { nsfw_enabled: 1 });
    const r = await admin.get('/api/search?tag=NSFW&sort=download_count&page=1');
    assert.equal(r.status, 200, r.text);
    const spicy = r.json.items.find((c) => c.nsfw);
    assert.ok(spicy, '没搜到 nsfw 角色');
    const denied = await user.get('/api/characters/' + spicy.path);
    assert.equal(denied.status, 403);
    assert.ok(denied.json.error);
    assert.equal((await user.post('/api/chats', { path: spicy.path })).status, 403);
  });

  await t.test('v0.4：真 xAI 经 42001 代理一句（cost_source=upstream，与 ticks 推出的单价一致）；同步 xAI 价格', async (tt) => {
    if (!readKeyFromEnvFile(KEYS_FILE, 'XAI_API_KEY')) { tt.skip('本机没有 XAI_API_KEY'); return; }
    const grok = (await admin.get('/api/admin/models')).json.items.find((m) => m.model === 'grok-4.20-0309-non-reasoning');
    assert.ok(grok, '没有预置 Grok 快速');
    assert.equal(grok.proxy_url, 'http://127.0.0.1:42001');
    assert.equal(grok.enabled, 1);
    const cr = await user.post('/api/chats', { path: character.path, model_id: grok.id });
    assert.equal(cr.status, 200, cr.text);
    const ev = parseSse((await user.post(`/api/chats/${cr.json.chat.id}/messages`, { content: '用一句话打个招呼' })).text);
    const err = ev.find((e) => e.event === 'error');
    assert.ok(!err, err && JSON.stringify(err.data));
    const done = ev.find((e) => e.event === 'done').data;
    assert.ok(done.message.content.trim());
    assert.equal(done.message.cost_source, 'upstream');
    assert.ok(done.message.cost_usd > 0);
    const ro = new DatabaseSync(path.join(dir, 'data', 'aichat.sqlite'), { readOnly: true });
    let row;
    try { row = ro.prepare('SELECT * FROM messages WHERE id = ?').get(done.message.id); } finally { ro.close(); }
    assert.equal(row.cost_source, 'upstream');
    assert.equal(row.cost_usd, done.message.cost_usd);
    // ticks 是整数：cost_usd × 1e10 必须是整数；且与「按 xAI 公布单价 + 实际 token 数」推出来的一致
    assert.ok(Math.abs(row.cost_usd * 1e10 - Math.round(row.cost_usd * 1e10)) < 1e-3, 'cost_usd 不是整数 tick');
    const miss = row.tokens_in - (row.tokens_in_cached || 0);
    const expect = (miss * grok.price_in + (row.tokens_in_cached || 0) * grok.price_in_cached + (row.tokens_out + (row.tokens_reasoning || 0)) * grok.price_out) / 1e6;
    assert.ok(Math.abs(expect - row.cost_usd) < 1e-9, `ticks 实价 ${row.cost_usd} 与单价推算 ${expect} 不一致`);
    const cd = (await user.get(`/api/chats/${cr.json.chat.id}`)).json.chat;
    assert.equal(cd.cost_usd, Math.round(row.cost_usd * 1e6) / 1e6);
    // 同步价格（走同样的代理）
    const sp = await admin.post(`/api/admin/models/${grok.id}/sync-price`);
    assert.equal(sp.status, 200, sp.text);
    assert.deepEqual([sp.json.model.currency, sp.json.model.price_in > 0, sp.json.model.price_out > 0], ['USD', true, true]);
    assert.equal((await user.post(`/api/admin/models/${grok.id}/sync-price`)).status, 403);
  });

  await t.test('真模型调用次数（诊断输出：翻译计费笔数 + AI 回复条数）', async (tt) => {
    const ro = new DatabaseSync(path.join(dir, 'data', 'aichat.sqlite'), { readOnly: true });
    try {
      const sys = ro.prepare('SELECT COUNT(*) AS n FROM system_costs').get().n;
      const replies = ro.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND model IS NOT NULL").get().n;
      tt.diagnostic(`system_costs ${sys} 笔，AI 回复 ${replies} 条`);
    } finally { ro.close(); }
  });

  await t.test('所有响应与服务日志里都没有 key', async () => {
    const prefix = KEY.slice(0, 12);
    for (const c of clients) {
      for (const b of c.bodies) {
        assert.ok(!b.includes(KEY), '响应里出现了 key');
        assert.ok(!b.includes(prefix), '响应里出现了 key 前缀');
      }
    }
    assert.ok(!logs.includes(prefix), '服务日志里出现了 key');
    for (const k of ALL_KEYS) {
      for (const c of clients) for (const b of c.bodies) assert.ok(!b.includes(k) && !b.includes(k.slice(0, 12)), '响应里出现了某个 key');
      assert.ok(!logs.includes(k.slice(0, 12)), '服务日志里出现了某个 key');
    }
  });
});
