// 权限、CSRF、限额、归属等：进程内起 app，chub 与模型用假的（不出网）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { openDb } from '../server/db.mjs';
import { hashPassword } from '../server/auth.mjs';
import { createApp } from '../server/app.mjs';
import { HttpError, nowIso } from '../server/util.mjs';
import { nodeToCard } from '../server/chub.mjs';
import { tmpDir, cleanupTmp, pickPort, Client, parseSse } from './helpers.mjs';

const NODES = {
  'tester/safe-girl': { fullPath: 'tester/safe-girl', name: 'Safe Girl', tagline: 'hi', avatar_url: 'https://avatars.charhub.io/a/safe.webp', topics: ['Female'], nsfw_image: false,
    definition: { name: 'Safe Girl', first_message: '你好，{{user}}！我是 {{char}}。', personality: '友好', description: '作者说明' } },
  'tester/spicy': { fullPath: 'tester/spicy', name: 'Spicy', tagline: 'x', avatar_url: 'https://avatars.charhub.io/a/spicy.webp', topics: ['NSFW'], nsfw_image: true,
    definition: { name: 'Spicy', first_message: '嗨' } },
};

const fakeChub = {
  async search({ nsfw }) {
    const items = Object.values(NODES).map(nodeToCard).filter((c) => nsfw || !c.nsfw);
    return { items, page: 1, has_more: false };
  },
  async character(p) {
    const n = NODES[p];
    if (!n) throw new HttpError(404, '没有找到这个角色');
    return structuredClone(n);
  },
};

let lastPrompt = null;
const fakeLlm = {
  async streamChat(messages, { onDelta }) {
    lastPrompt = messages;
    for (const t of ['*微笑* ', '你好', '呀']) onDelta(t);
    return { text: '*微笑* 你好呀', tokens_in: 10, tokens_out: 5, model: 'fake' };
  },
  async complete() { return { text: '译文', tokens_in: 1, tokens_out: 1 }; },
};

let server, dir, base, db;
const admin = () => new Client(base);

before(async () => {
  dir = tmpDir('unit-perm');
  db = openDb(path.join(dir, 'aichat.sqlite'));
  const ins = db.prepare('INSERT INTO users(username, password_hash, display_name, is_admin, created_at) VALUES (?, ?, ?, ?, ?)');
  ins.run('boss', hashPassword('boss-pass-1'), '老板', 1, nowIso());
  ins.run('alice', hashPassword('alice-pass-1'), '爱丽丝', 0, nowIso());
  db.exec("UPDATE users SET role = 'super' WHERE is_admin = 1"); // 契约 §9：鉴权看 role，测试里的管理员是超级管理员
  ins.run('bob', hashPassword('bob-pass-12'), '鲍勃', 0, nowIso());
  const app = createApp({ db, chub: fakeChub, llm: fakeLlm, avatars: { get: async () => ({ type: 'image/png', buf: Buffer.from('x') }) },
    config: { publicDir: path.join(dir, 'pub'), deepseekModel: 'fake' } });
  const port = await pickPort([44989, 44988, 44987, 44986]);
  server = http.createServer(app.handle);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  cleanupTmp(dir);
});

async function login(name, pw) {
  // 管理员直接开的号首次登录要先改密（契约 §13.3，见 invites.test.mjs）；这里的用例与之无关，直接清掉标记。
  db.prepare('UPDATE users SET must_change_password = 0 WHERE username = ?').run(name);
  const c = new Client(base);
  const r = await c.post('/api/login', { username: name, password: pw });
  assert.equal(r.status, 200, r.text);
  return c;
}

test('未登录 401；登录后 /api/me 有用户与站点名', async () => {
  const c = new Client(base);
  // v0.9 F9：只有 GET /api/me 未登录回 200 {user:null}；其余接口（含 /api/me 的写接口与登录记录）照旧 401
  const anon = await c.get('/api/me');
  assert.equal(anon.status, 200);
  assert.equal(anon.json.user, null);
  assert.equal(typeof anon.json.site_name, 'string');
  assert.equal((await c.patch('/api/me', { display_name: 'x' })).status, 401);
  assert.equal((await c.post('/api/me/password', { old_password: 'a', new_password: 'bbbbbbbbb' })).status, 401);
  assert.equal((await c.get('/api/me/logins')).status, 401);
  assert.equal((await c.get('/api/chats')).status, 401);
  assert.equal((await c.get('/api/admin/crawler/status')).status, 401);
  assert.equal((await c.get('/api/home')).status, 401);
  assert.equal((await c.get('/api/admin/users')).status, 401);
  const a = await login('alice', 'alice-pass-1');
  const me = await a.get('/api/me');
  assert.equal(me.json.user.username, 'alice');
  assert.equal(me.json.site_name, 'AI 角色聊天');
  assert.ok(!('password_hash' in me.json.user));
});

test('普通用户调所有管理接口都是 403，管理员可以', async () => {
  const a = await login('alice', 'alice-pass-1');
  const calls = [
    ['GET', '/api/admin/users'], ['POST', '/api/admin/users', { username: 'x1', password: '12345678' }],
    ['PATCH', '/api/admin/users/1', { disabled: 1 }], ['DELETE', '/api/admin/users/3'],
    ['GET', '/api/admin/usage?days=7'], ['GET', '/api/admin/shelves'], ['POST', '/api/admin/shelves', { title: 't' }],
    ['PATCH', '/api/admin/shelves/1', { title: 't' }], ['DELETE', '/api/admin/shelves/1'],
    ['POST', '/api/admin/shelves/1/items', { path: 'tester/safe-girl' }], ['DELETE', '/api/admin/shelves/1/items/tester/safe-girl'],
    ['POST', '/api/admin/shelves/1/order', { paths: [] }], ['GET', '/api/admin/settings'], ['PATCH', '/api/admin/settings', { site_name: 'x' }],
  ];
  for (const [m, p, b] of calls) {
    const r = await a.req(m, p, b);
    assert.equal(r.status, 403, `${m} ${p} → ${r.status}`);
    assert.ok(r.json?.error);
  }
  const boss = await login('boss', 'boss-pass-1');
  assert.equal((await boss.get('/api/admin/users')).status, 200);
  assert.equal((await boss.get('/api/admin/settings')).json.settings.default_daily_limit, 0);
});

test('CSRF：跨站 Origin 拒绝；同源与无 Origin 放行；有请求体必须是 JSON', async () => {
  const a = await login('alice', 'alice-pass-1');
  const host = new URL(base).host;
  assert.equal((await a.patch('/api/me', { persona_name: 'P' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await a.patch('/api/me', { persona_name: 'P' }, { origin: 'null' })).status, 403);
  assert.equal((await a.patch('/api/me', { persona_name: 'P' }, { origin: `http://${host}` })).status, 200);
  const r = await fetch(base + '/api/me', { method: 'PATCH', headers: { cookie: a.cookie, 'content-type': 'text/plain' }, body: '{"persona_name":"Q"}' });
  assert.equal(r.status, 415);
  await a.patch('/api/me', { persona_name: '' });
});

test('登录失败 5 次锁 10 分钟（按用户名+IP）', async () => {
  const c = new Client(base);
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/login', { username: 'bob', password: 'wrong' })).status, 401);
  const r = await c.post('/api/login', { username: 'bob', password: 'bob-pass-12' });
  assert.equal(r.status, 429);
  assert.match(r.json.error, /10 分钟/);
});

test('nsfw 关的用户打不开 nsfw 角色、搜索里也看不到；打开后可以', async () => {
  const a = await login('alice', 'alice-pass-1');
  const s = await a.get('/api/search?q=');
  assert.ok(s.json.items.every((c) => !c.nsfw));
  assert.equal((await a.get('/api/characters/tester/spicy')).status, 403);
  assert.equal((await a.post('/api/chats', { path: 'tester/spicy' })).status, 403);
  const ok = await a.get('/api/characters/tester/safe-girl');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.character.greeting_zh, '你好，爱丽丝！我是 Safe Girl。');
  assert.equal(ok.json.character.creator_notes, '作者说明');
  assert.match(ok.json.character.avatar, /^\/api\/avatar\?u=/);
  assert.equal((await a.patch('/api/me', { nsfw_enabled: 1 })).json.user.nsfw_enabled, 1);
  assert.equal((await a.get('/api/characters/tester/spicy')).status, 200);
  await a.patch('/api/me', { nsfw_enabled: 0 });
});

test('会话只能看自己的；SSE 流程、编辑、删除及其后消息', async () => {
  const a = await login('alice', 'alice-pass-1');
  const b = await login('boss', 'boss-pass-1');
  const created = await a.post('/api/chats', { path: 'tester/safe-girl' });
  assert.equal(created.status, 200, created.text);
  const id = created.json.chat.id;
  assert.equal((await b.get(`/api/chats/${id}`)).status, 404);
  assert.equal((await b.post(`/api/chats/${id}/messages`, { content: 'hi' })).status, 404);
  assert.equal((await b.del(`/api/chats/${id}`)).status, 404);

  const r = await a.post(`/api/chats/${id}/messages`, { content: '你好' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const ev = parseSse(r.text);
  assert.equal(ev[0].event, 'user');
  assert.equal(ev[0].data.message.content, '你好');
  assert.equal(ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), '*微笑* 你好呀');
  const done = ev.find((e) => e.event === 'done');
  assert.equal(done.data.message.role, 'assistant');
  assert.equal(lastPrompt[0].role, 'system');
  assert.equal(lastPrompt[lastPrompt.length - 1].content, '你好');

  const rg = parseSse((await a.post(`/api/chats/${id}/regenerate`)).text);
  assert.ok(rg.find((e) => e.event === 'done'));
  assert.ok(!rg.find((e) => e.event === 'user'));

  const detail = await a.get(`/api/chats/${id}`);
  assert.deepEqual(detail.json.messages.map((m) => m.role), ['assistant', 'user', 'assistant']);
  const [greet, userMsg] = detail.json.messages;
  assert.equal((await b.patch(`/api/messages/${userMsg.id}`, { content: 'x' })).status, 404);
  assert.equal((await a.patch(`/api/messages/${userMsg.id}`, { content: '改过的' })).json.message.content, '改过的');
  assert.equal((await b.del(`/api/messages/${userMsg.id}`)).status, 404);
  assert.equal((await a.del(`/api/messages/${userMsg.id}`)).status, 200);
  const after = await a.get(`/api/chats/${id}`);
  assert.deepEqual(after.json.messages.map((m) => m.id), [greet.id]);
  const list = await a.get('/api/chats');
  assert.equal(list.json.items[0].id, id);
  assert.equal(list.json.items[0].character.path, 'tester/safe-girl');
});

test('每日限额：0 不限；设为 1 后第二条 429；用量有记录', async () => {
  const boss = await login('boss', 'boss-pass-1');
  const users = (await boss.get('/api/admin/users')).json.items;
  const bob = users.find((u) => u.username === 'bob');
  // bob 被上一个用例锁了，换个账号
  const cu = await boss.post('/api/admin/users', { username: 'carol', password: 'carol-pass-1', display_name: '卡罗' });
  assert.equal(cu.status, 200, cu.text);
  assert.equal((await boss.post('/api/admin/users', { username: 'carol', password: 'carol-pass-1' })).status, 409);
  assert.equal((await boss.post('/api/admin/users', { username: 'd', password: 'short' })).status, 400);
  assert.ok(bob);
  const c = await login('carol', 'carol-pass-1');
  const chat = (await c.post('/api/chats', { path: 'tester/safe-girl' })).json.chat;
  assert.equal((await boss.patch(`/api/admin/users/${cu.json.user.id}`, { daily_limit: 1 })).json.user.daily_limit, 1);
  assert.equal((await c.post(`/api/chats/${chat.id}/messages`, { content: '一' })).status, 200);
  const r = await c.post(`/api/chats/${chat.id}/messages`, { content: '二' });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, '今天的消息额度已用完');
  await boss.patch(`/api/admin/users/${cu.json.user.id}`, { daily_limit: null });
  await boss.patch('/api/admin/settings', { default_daily_limit: 1 });
  assert.equal((await c.post(`/api/chats/${chat.id}/messages`, { content: '三' })).status, 429);
  await boss.patch('/api/admin/settings', { default_daily_limit: 0 });
  assert.equal((await c.post(`/api/chats/${chat.id}/messages`, { content: '四' })).status, 200);
  const usage = (await boss.get('/api/admin/usage?days=7')).json.items.find((x) => x.username === 'carol');
  assert.equal(usage.messages, 2);
  assert.equal(usage.tokens_in, 20);
});

test('管理员：停用账号后会话立即失效；不能停用/删除自己；货架增删排序', async () => {
  const boss = await login('boss', 'boss-pass-1');
  const id = (await boss.post('/api/admin/users', { username: 'dave', password: 'dave-pass-1' })).json.user.id;
  const d = await login('dave', 'dave-pass-1');
  assert.equal((await d.get('/api/me')).status, 200);
  await boss.patch(`/api/admin/users/${id}`, { disabled: 1 });
  assert.equal((await d.get('/api/me')).json.user, null);
  assert.equal((await new Client(base).post('/api/login', { username: 'dave', password: 'dave-pass-1' })).status, 403);
  const me = (await boss.get('/api/me')).json.user;
  assert.equal((await boss.patch(`/api/admin/users/${me.id}`, { disabled: 1 })).status, 400);
  assert.equal((await boss.del(`/api/admin/users/${me.id}`)).status, 400);
  assert.equal((await boss.del(`/api/admin/users/${id}`)).status, 200);

  const sh = (await boss.post('/api/admin/shelves', { title: '编辑推荐' })).json.shelf;
  await boss.post(`/api/admin/shelves/${sh.id}/items`, { path: 'tester/safe-girl' });
  const s2 = (await boss.post(`/api/admin/shelves/${sh.id}/items`, { path: 'tester/spicy' })).json.shelf;
  assert.deepEqual(s2.items.map((x) => x.path), ['tester/safe-girl', 'tester/spicy']);
  const s3 = (await boss.post(`/api/admin/shelves/${sh.id}/order`, { paths: ['tester/spicy', 'tester/safe-girl'] })).json.shelf;
  assert.deepEqual(s3.items.map((x) => x.path), ['tester/spicy', 'tester/safe-girl']);
  // nsfw 关的用户首页货架里看不到 nsfw 角色
  const a = await login('alice', 'alice-pass-1');
  const home = (await a.get('/api/home')).json;
  assert.deepEqual(home.shelves[0].items.map((x) => x.path), ['tester/safe-girl']);
  assert.ok(Array.isArray(home.hot));
  const s4 = (await boss.del(`/api/admin/shelves/${sh.id}/items/tester/spicy`)).json.shelf;
  assert.deepEqual(s4.items.map((x) => x.path), ['tester/safe-girl']);
  assert.equal((await boss.del(`/api/admin/shelves/${sh.id}`)).status, 200);
  const st = (await boss.patch('/api/admin/settings', { site_name: '新加坡聊天', allow_user_chub_search: 0 })).json.settings;
  assert.equal(st.site_name, '新加坡聊天');
  assert.equal((await a.get('/api/search?q=')).status, 403);
  assert.equal((await boss.get('/api/search?q=')).status, 200);
  await boss.patch('/api/admin/settings', { site_name: 'AI 角色聊天', allow_user_chub_search: 1 });
});

test('改密码：旧密码错 400；新密码太短 400；成功后用新密码登录', async () => {
  const a = await login('alice', 'alice-pass-1');
  assert.equal((await a.post('/api/me/password', { old_password: 'x', new_password: 'newpass-123' })).status, 400);
  assert.equal((await a.post('/api/me/password', { old_password: 'alice-pass-1', new_password: 'short' })).status, 400);
  assert.equal((await a.post('/api/me/password', { old_password: 'alice-pass-1', new_password: 'newpass-123' })).status, 200);
  assert.equal((await a.get('/api/me')).status, 200, '当前设备保持登录');
  await login('alice', 'newpass-123');
  await a.post('/api/me/password', { old_password: 'newpass-123', new_password: 'alice-pass-1' });
});

test('未知 /api 路径 404 JSON；/healthz；登出后 401', async () => {
  const a = await login('alice', 'alice-pass-1');
  const r = await a.get('/api/nope');
  assert.equal(r.status, 404);
  assert.ok(r.json.error);
  assert.deepEqual((await a.get('/healthz')).json, { ok: true });
  assert.equal((await a.post('/api/logout')).json.ok, true);
  assert.equal((await a.get('/api/me')).json.user, null);
});
