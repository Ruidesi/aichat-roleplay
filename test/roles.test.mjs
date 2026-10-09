// 三层权限（契约 §9）：super / admin A / admin B / tenant(A 建) / tenant(B 建) 五个身份 × 所有管理接口的权限矩阵，
// 以及可见范围、越权 404 不泄露存在性、最后一个 super 保护、create-admin.mjs --role。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { openDb } from '../server/db.mjs';
import { hashPassword } from '../server/auth.mjs';
import { createApp } from '../server/app.mjs';
import { HttpError, nowIso } from '../server/util.mjs';
import { nodeToCard } from '../server/chub.mjs';
import { ROOT } from '../server/config.mjs';
import { tmpDir, cleanupTmp, listenFree, Client, parseSse } from './helpers.mjs';

const NODES = {
  'tester/safe-girl': { fullPath: 'tester/safe-girl', name: 'Safe Girl', tagline: 'hi', avatar_url: 'https://avatars.charhub.io/a/safe.webp', topics: ['Female'], nsfw_image: false,
    definition: { name: 'Safe Girl', first_message: '你好，{{user}}！', personality: '友好' } },
  'tester/other': { fullPath: 'tester/other', name: 'Other', tagline: 'o', avatar_url: 'https://avatars.charhub.io/a/o.webp', topics: [], nsfw_image: false,
    definition: { name: 'Other', first_message: '嗨' } },
};
const fakeChub = {
  async search() { return { items: Object.values(NODES).map(nodeToCard), page: 1, has_more: false }; },
  async character(p) { if (!NODES[p]) throw new HttpError(404, '没有找到这个角色'); return structuredClone(NODES[p]); },
};
const fakeLlm = {
  async streamChat(messages, { onDelta }) { onDelta('好的'); return { text: '好的', tokens_in: 7, tokens_out: 3, model: 'fake-model' }; },
  async complete() { return { text: '译文', tokens_in: 1, tokens_out: 1 }; },
};

const PORTS = [44989, 44988, 44987, 44986, 44985, 44984, 44983, 44982];
let server, dir, base, db;
const id = {}; // 各账号 id
const who = {}; // 已登录的客户端
const chat = {}; // 各身份的一个会话 id

async function login(name, pw) {
  // 管理员直接开的号首次登录要先改密（契约 §13.3，见 invites.test.mjs）；这里的用例与之无关，直接清掉标记。
  db.prepare('UPDATE users SET must_change_password = 0 WHERE username = ?').run(name);
  const c = new Client(base);
  const r = await c.post('/api/login', { username: name, password: pw });
  assert.equal(r.status, 200, `${name} 登录：${r.text}`);
  return c;
}

before(async () => {
  dir = tmpDir('unit-roles');
  db = openDb(path.join(dir, 'aichat.sqlite'));
  const t = nowIso();
  id.super = Number(db.prepare("INSERT INTO users(username, password_hash, display_name, is_admin, role, created_at) VALUES ('root', ?, '超管', 1, 'super', ?)")
    .run(hashPassword('root-pass-1'), t).lastInsertRowid);
  const app = createApp({ db, chub: fakeChub, llm: fakeLlm, avatars: { get: async () => ({ type: 'image/png', buf: Buffer.from('x') }) },
    config: { publicDir: path.join(dir, 'pub'), deepseekModel: 'fake' } });
  server = http.createServer(app.handle);
  base = `http://127.0.0.1:${await listenFree(server, PORTS)}`;

  // 超管建两个管理员；管理员各建一个租户（都走接口，created_by 由服务端写）
  who.super = await login('root', 'root-pass-1');
  for (const [k, name] of [['adminA', 'adma'], ['adminB', 'admb']]) {
    const r = await who.super.post('/api/admin/users', { username: name, password: `${name}-pass-1`, display_name: name.toUpperCase(), role: 'admin' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.user.role, 'admin');
    assert.equal(r.json.user.created_by, id.super);
    assert.equal(r.json.user.created_by_name, '超管');
    id[k] = r.json.user.id;
    who[k] = await login(name, `${name}-pass-1`);
  }
  for (const [k, owner, name] of [['tenantA', 'adminA', 'ta'], ['tenantB', 'adminB', 'tb']]) {
    const r = await who[owner].post('/api/admin/users', { username: name, password: `${name}-pass-12`, display_name: name.toUpperCase() });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.user.role, 'tenant');
    assert.equal(r.json.user.created_by, id[owner]);
    id[k] = r.json.user.id;
    who[k] = await login(name, `${name}-pass-12`);
  }
  // 每个身份都聊一句（所有角色都能聊天，也都计用量）
  for (const k of ['super', 'adminA', 'adminB', 'tenantA', 'tenantB']) {
    const c = await who[k].post('/api/chats', { path: 'tester/safe-girl' });
    assert.equal(c.status, 200, c.text);
    chat[k] = c.json.chat.id;
    const ev = parseSse((await who[k].post(`/api/chats/${chat[k]}/messages`, { content: `${k} 说你好` })).text);
    assert.ok(ev.find((e) => e.event === 'done'), `${k} 能聊天`);
  }
});

after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  cleanupTmp(dir);
});

const IDS = ['super', 'adminA', 'adminB', 'tenantA', 'tenantB'];
/** 逐格断言：expect 是 {身份: 状态码}。返回每个身份的响应。 */
async function matrix(label, method, p, body, expect) {
  const out = {};
  for (const k of IDS) {
    if (expect[k] === undefined) continue;
    const r = await who[k].req(method, typeof p === 'function' ? p(k) : p, typeof body === 'function' ? body(k) : body);
    assert.equal(r.status, expect[k], `${label}：${k} ${method} → ${r.status} ${r.text.slice(0, 200)}`);
    if (r.status >= 400) assert.ok(r.json?.error, `${label}：${k} 有中文错误`);
    out[k] = r;
  }
  return out;
}
const row = (s, a, b, ta, tb) => ({ super: s, adminA: a, adminB: b, tenantA: ta, tenantB: tb });

test('/api/me 带 role，is_admin 兼容 = role!==tenant', async () => {
  const want = { super: ['super', 1], adminA: ['admin', 1], adminB: ['admin', 1], tenantA: ['tenant', 0], tenantB: ['tenant', 0] };
  for (const k of IDS) {
    const u = (await who[k].get('/api/me')).json.user;
    assert.deepEqual([u.role, u.is_admin], want[k], k);
  }
});

test('矩阵：账号列表与可见范围', async () => {
  const r = await matrix('列账号', 'GET', '/api/admin/users', undefined, row(200, 200, 200, 403, 403));
  const names = (k) => r[k].json.items.map((u) => u.username).sort();
  assert.deepEqual(names('super'), ['adma', 'admb', 'root', 'ta', 'tb']);
  assert.deepEqual(names('adminA'), ['ta']);
  assert.deepEqual(names('adminB'), ['tb']);
  const ta = r.super.json.items.find((u) => u.username === 'ta');
  assert.deepEqual([ta.role, ta.created_by, ta.created_by_name, ta.is_admin], ['tenant', id.adminA, 'ADMA', 0]);
  const root = r.super.json.items.find((u) => u.username === 'root');
  assert.deepEqual([root.role, root.created_by, root.created_by_name], ['super', null, null]);
  for (const u of r.super.json.items) assert.ok(!('password_hash' in u));
});

test('矩阵：建账号（admin 只能建租户，created_by=自己；super 可建 admin/tenant，建 super 只能走脚本）', async () => {
  let n = 0;
  const uname = (k) => `new${k.toLowerCase()}${++n}`;
  await matrix('建租户', 'POST', '/api/admin/users', (k) => ({ username: uname(k), password: 'xxxx-pass-1' }), row(200, 200, 200, 403, 403));
  await matrix('建管理员 role', 'POST', '/api/admin/users', (k) => ({ username: uname(k), password: 'xxxx-pass-1', role: 'admin' }), row(200, 403, 403, 403, 403));
  await matrix('建管理员 is_admin', 'POST', '/api/admin/users', (k) => ({ username: uname(k), password: 'xxxx-pass-1', is_admin: true }), row(200, 403, 403, 403, 403));
  await matrix('建超管', 'POST', '/api/admin/users', (k) => ({ username: uname(k), password: 'xxxx-pass-1', role: 'super' }), row(403, 403, 403, 403, 403));
  await matrix('角色乱填', 'POST', '/api/admin/users', (k) => ({ username: uname(k), password: 'xxxx-pass-1', role: 'god' }), row(400, 403, 403, 403, 403));
  // admin 显式传 role:'tenant' 可以；建出来 created_by = 自己
  const r = await who.adminA.post('/api/admin/users', { username: 'explicit-t', password: 'xxxx-pass-1', role: 'tenant' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.user.role, r.json.user.created_by], ['tenant', id.adminA]);
  // 库里不存在被 admin 建出来的 admin / super
  const bad = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role <> 'tenant' AND created_by IN (?, ?)").get(id.adminA, id.adminB).n;
  assert.equal(bad, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'super'").get().n, 1);
  // 清理：admin 删自己建的
  for (const u of db.prepare('SELECT id, created_by FROM users WHERE username LIKE ?').all('new%')) {
    const owner = u.created_by === id.adminA ? 'adminA' : u.created_by === id.adminB ? 'adminB' : 'super';
    assert.equal((await who[owner].del(`/api/admin/users/${u.id}`)).status, 200);
  }
  assert.equal((await who.adminA.del(`/api/admin/users/${r.json.user.id}`)).status, 200);
});

test('矩阵：改账号——范围外一律 404，且与不存在的账号回应完全一致', async () => {
  const dn = { display_name: '改名' };
  await matrix('改 tenantA', 'PATCH', `/api/admin/users/${id.tenantA}`, dn, row(200, 200, 404, 403, 403));
  await matrix('改 tenantB', 'PATCH', `/api/admin/users/${id.tenantB}`, dn, row(200, 404, 200, 403, 403));
  await matrix('改 adminA', 'PATCH', `/api/admin/users/${id.adminA}`, dn, row(200, 404, 404, 403, 403));
  await matrix('改 adminB', 'PATCH', `/api/admin/users/${id.adminB}`, dn, row(200, 404, 404, 403, 403));
  await matrix('改 super', 'PATCH', `/api/admin/users/${id.super}`, dn, row(200, 404, 404, 403, 403));
  await matrix('改不存在', 'PATCH', '/api/admin/users/987654', dn, row(404, 404, 404, 403, 403));
  // 不泄露存在性：越权与不存在的响应体一模一样
  const outOfScope = await who.adminA.patch(`/api/admin/users/${id.tenantB}`, dn);
  const missing = await who.adminA.patch('/api/admin/users/987654', dn);
  assert.equal(outOfScope.text, missing.text);
  // 越权时数据没有被改
  assert.equal(db.prepare('SELECT display_name FROM users WHERE id = ?').get(id.adminB).display_name, '改名');
  await who.super.patch(`/api/admin/users/${id.adminA}`, { display_name: 'ADMA' });
  await who.super.patch(`/api/admin/users/${id.adminB}`, { display_name: 'ADMB' });
  await who.super.patch(`/api/admin/users/${id.super}`, { display_name: '超管' });
  await who.adminA.patch(`/api/admin/users/${id.tenantA}`, { display_name: 'TA' });
  await who.adminB.patch(`/api/admin/users/${id.tenantB}`, { display_name: 'TB' });

  // 其他字段：每日限额、停用、重置密码——admin 只能对自己建的租户做
  await matrix('设限额', 'PATCH', `/api/admin/users/${id.tenantA}`, { daily_limit: 9 }, row(200, 200, 404, 403, 403));
  assert.equal(db.prepare('SELECT daily_limit FROM users WHERE id = ?').get(id.tenantA).daily_limit, 9);
  await who.adminA.patch(`/api/admin/users/${id.tenantA}`, { daily_limit: null });
  await matrix('越权停用', 'PATCH', `/api/admin/users/${id.tenantA}`, { disabled: 1 }, row(undefined, undefined, 404, 403, 403));
  await matrix('越权重置密码', 'PATCH', `/api/admin/users/${id.tenantA}`, { password: 'hacked-pass-1' }, row(undefined, undefined, 404, 403, 403));
  assert.equal((await who.tenantA.get('/api/me')).status, 200, '越权尝试没有影响 tenantA');
});

test('admin 不能改 role（含 is_admin）；super 可以 admin↔tenant，降级后权限立即收回', async () => {
  await matrix('admin 改自己租户 role', 'PATCH', `/api/admin/users/${id.tenantA}`, { role: 'admin' }, row(undefined, 403, 404, 403, 403));
  await matrix('admin 改 is_admin', 'PATCH', `/api/admin/users/${id.tenantA}`, { is_admin: 1 }, row(undefined, 403, 404, 403, 403));
  await matrix('admin 改 role=tenant 也不行', 'PATCH', `/api/admin/users/${id.tenantA}`, { role: 'tenant' }, row(undefined, 403, undefined, undefined, undefined));
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(id.tenantA).role, 'tenant');
  // super 不能把人升为 super
  assert.equal((await who.super.patch(`/api/admin/users/${id.tenantA}`, { role: 'super' })).status, 403);

  // super 把 adminB 降为租户 → adminB 立刻进不了管理接口；再升回来恢复
  const d = await who.super.patch(`/api/admin/users/${id.adminB}`, { role: 'tenant' });
  assert.equal(d.status, 200);
  assert.deepEqual([d.json.user.role, d.json.user.is_admin], ['tenant', 0]);
  assert.equal((await who.adminB.get('/api/admin/users')).status, 403);
  assert.equal((await who.adminB.get('/api/me')).json.user.role, 'tenant');
  // 降级时他建的租户转给执行操作的超管（与删除管理员一致）
  assert.equal(db.prepare('SELECT created_by FROM users WHERE id = ?').get(id.tenantB).created_by, id.super);
  const u = await who.super.patch(`/api/admin/users/${id.adminB}`, { is_admin: 1 }); // 旧前端字段也认
  assert.deepEqual([u.json.user.role, u.json.user.is_admin], ['admin', 1]);
  assert.equal((await who.adminB.get('/api/admin/users')).json.items.length, 0, '升回后原来的租户已归超管');
  db.prepare('UPDATE users SET created_by = ? WHERE id = ?').run(id.adminB, id.tenantB); // 还原，后续用例仍按 B 建 tb
});

test('矩阵：删账号——范围外 404；admin 能删自己建的租户', async () => {
  const mk = async (owner, name) => (await who[owner].post('/api/admin/users', { username: name, password: 'xxxx-pass-1' })).json.user.id;
  const xa = await mk('adminA', 'del-a');
  const xb = await mk('adminB', 'del-b');
  await matrix('删 A 的租户（越权）', 'DELETE', `/api/admin/users/${xa}`, undefined, row(undefined, undefined, 404, 403, 403));
  await matrix('删 B 的租户（越权）', 'DELETE', `/api/admin/users/${xb}`, undefined, row(undefined, 404, undefined, 403, 403));
  await matrix('删 adminB', 'DELETE', `/api/admin/users/${id.adminB}`, undefined, row(undefined, 404, 404, 403, 403));
  await matrix('删 super', 'DELETE', `/api/admin/users/${id.super}`, undefined, row(400, 404, 404, 403, 403));
  await matrix('删不存在', 'DELETE', '/api/admin/users/987654', undefined, row(404, 404, 404, 403, 403));
  assert.equal((await who.adminA.del(`/api/admin/users/${xa}`)).status, 200);
  assert.equal((await who.adminB.del(`/api/admin/users/${xb}`)).status, 200);
  // 契约 §12.4：删账号是软删——行还在、deleted_at 有值；再删 / 再改都按不存在处理（404）
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id IN (?, ?) AND deleted_at IS NOT NULL').get(xa, xb).n, 2);
  assert.equal((await who.adminA.del(`/api/admin/users/${xa}`)).status, 404);
  assert.equal((await who.super.patch(`/api/admin/users/${xb}`, { display_name: 'x' })).status, 404);
  assert.ok(!(await who.adminA.get('/api/admin/users')).json.items.some((u) => u.id === xa), 'admin 列表不含已删');
  const su = (await who.super.get('/api/admin/users')).json.items.find((u) => u.id === xa);
  assert.equal(su.deleted, 1, 'super 账号页可见「已删除」');
  assert.equal((await who.super.post('/api/admin/users', { username: 'del-a', password: 'xxxx-pass-1' })).status, 409, '用户名仍被占用');
});

test('admin 停用 / 给自己租户发重置码：租户登录立即失效，用户自己设新密码', async () => {
  const tid = (await who.adminA.post('/api/admin/users', { username: 'dis-a', password: 'xxxx-pass-1' })).json.user.id;
  const t = await login('dis-a', 'xxxx-pass-1');
  assert.equal((await who.adminA.patch(`/api/admin/users/${tid}`, { disabled: 1 })).json.user.disabled, 1);
  assert.equal((await t.get('/api/me')).json.user, null);
  // 契约 §13.3：管理员不能直接改密码，改发重置码，由用户自己设新密码
  assert.equal((await who.adminA.patch(`/api/admin/users/${tid}`, { disabled: 0, password: 'newp-pass-1' })).status, 400);
  assert.equal((await who.adminA.patch(`/api/admin/users/${tid}`, { disabled: 0 })).status, 200);
  const rc = await who.adminA.post(`/api/admin/users/${tid}/reset-code`);
  assert.equal(rc.status, 200, rc.text);
  assert.equal((await new Client(base).post('/api/password/reset', { username: 'dis-a', code: rc.json.code, new_password: 'newp-pass-1' })).status, 200);
  await login('dis-a', 'newp-pass-1');
  await who.adminA.del(`/api/admin/users/${tid}`);
});

test('矩阵：用量——super 看全部；admin 只看自己建的租户（不含自己）', async () => {
  const r = await matrix('用量', 'GET', '/api/admin/usage?days=7', undefined, row(200, 200, 200, 403, 403));
  const users = (k) => [...new Set(r[k].json.items.map((x) => x.username))].sort();
  assert.deepEqual(users('super'), ['adma', 'admb', 'root', 'ta', 'tb'], '管理员与超管自己也计用量');
  assert.deepEqual(users('adminA'), ['ta']);
  assert.deepEqual(users('adminB'), ['tb']);
  assert.equal(r.adminA.json.items[0].messages, 1);
  assert.equal(r.adminA.json.items[0].role, 'tenant');
});

test('矩阵：模型 / 货架 / 设置只限 super，admin 与租户 403', async () => {
  const calls = [
    ['GET', '/api/admin/models'], ['POST', '/api/admin/models', { name: 'x' }], ['POST', '/api/admin/models/order', { ids: [] }],
    ['PATCH', '/api/admin/models/1', { name: 'x' }], ['DELETE', '/api/admin/models/1'], ['POST', '/api/admin/models/1/test'],
    ['GET', '/api/admin/shelves'], ['POST', '/api/admin/shelves', { title: 't' }], ['PATCH', '/api/admin/shelves/1', { title: 't' }],
    ['DELETE', '/api/admin/shelves/1'], ['POST', '/api/admin/shelves/1/items', { path: 'tester/safe-girl' }],
    ['DELETE', '/api/admin/shelves/1/items/tester/safe-girl'], ['POST', '/api/admin/shelves/1/order', { paths: [] }],
    ['GET', '/api/admin/settings'], ['PATCH', '/api/admin/settings', { site_name: '被改了' }],
  ];
  for (const [m, p, b] of calls) await matrix(`${m} ${p}`, m, p, b, row(undefined, 403, 403, 403, 403));
  // super 都能进（GET 200；写操作走到业务校验，不是 403）
  for (const p of ['/api/admin/models', '/api/admin/shelves', '/api/admin/settings']) assert.equal((await who.super.get(p)).status, 200, p);
  const sh = await who.super.post('/api/admin/shelves', { title: '超管货架' });
  assert.equal(sh.status, 200);
  assert.equal((await who.super.del(`/api/admin/shelves/${sh.json.shelf.id}`)).status, 200);
  assert.equal((await who.super.get('/api/admin/settings')).json.settings.site_name, 'AI 角色聊天', '越权写设置没有生效');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shelves').get().n, 0, '越权建货架没有生效');
});

test('超管看别人会话：普通 /api/chats/:id 始终 404', async () => {
  for (const k of ['adminA', 'tenantA', 'tenantB']) {
    const cid = chat[k];
    assert.equal((await who.super.get(`/api/chats/${cid}`)).status, 404, k);
    assert.equal((await who.super.patch(`/api/chats/${cid}`, { model_id: null })).status, 404);
    assert.equal((await who.super.post(`/api/chats/${cid}/messages`, { content: 'x' })).status, 404);
    assert.equal((await who.super.post(`/api/chats/${cid}/regenerate`)).status, 404);
    assert.equal((await who.super.del(`/api/chats/${cid}`)).status, 404);
  }
  // 管理员也看不到自己建的租户的会话
  assert.equal((await who.adminA.get(`/api/chats/${chat.tenantA}`)).status, 404);
  const msgId = db.prepare('SELECT id FROM messages WHERE chat_id = ? ORDER BY id LIMIT 1').get(chat.tenantA).id;
  assert.equal((await who.super.patch(`/api/messages/${msgId}`, { content: '篡改' })).status, 404);
  assert.equal((await who.super.del(`/api/messages/${msgId}`)).status, 404);
  // 超管自己的会话列表里没有别人的
  assert.deepEqual((await who.super.get('/api/chats')).json.items.map((c) => c.id), [chat.super]);
});

test('最后一个 super 保护：不能停用 / 删除 / 降级自己；不能动别的 super', async () => {
  assert.equal((await who.super.patch(`/api/admin/users/${id.super}`, { disabled: 1 })).status, 400);
  assert.equal((await who.super.patch(`/api/admin/users/${id.super}`, { role: 'admin' })).status, 400);
  assert.equal((await who.super.patch(`/api/admin/users/${id.super}`, { role: 'tenant' })).status, 400);
  assert.equal((await who.super.patch(`/api/admin/users/${id.super}`, { is_admin: 0 })).status, 400);
  assert.equal((await who.super.del(`/api/admin/users/${id.super}`)).status, 400);
  assert.equal(db.prepare('SELECT role, disabled FROM users WHERE id = ?').get(id.super).role, 'super');
  // role 原样再传一遍 super 不报错（相当于没改）
  assert.equal((await who.super.patch(`/api/admin/users/${id.super}`, { display_name: '超管', role: 'super' })).status, 200);

  // 第二个 super（只能脚本建，这里直接写库）：互相不能动
  const s2 = Number(db.prepare("INSERT INTO users(username, password_hash, display_name, is_admin, role, created_at) VALUES ('root2', ?, 'S2', 1, 'super', ?)")
    .run(hashPassword('root2-pass-1'), nowIso()).lastInsertRowid);
  for (const body of [{ disabled: 1 }, { role: 'admin' }, { display_name: 'x' }, { password: 'xxxx-pass-9' }]) {
    assert.equal((await who.super.patch(`/api/admin/users/${s2}`, body)).status, 403, JSON.stringify(body));
  }
  assert.equal((await who.super.del(`/api/admin/users/${s2}`)).status, 403);
  assert.equal((await who.adminA.patch(`/api/admin/users/${s2}`, { disabled: 1 })).status, 404);
  const s2row = db.prepare('SELECT role, disabled, display_name FROM users WHERE id = ?').get(s2);
  assert.deepEqual({ ...s2row }, { role: 'super', disabled: 0, display_name: 'S2' });
  db.prepare('DELETE FROM users WHERE id = ?').run(s2);
});

test('super 删除管理员（软删）：登录立即失效，他建的租户转给执行删除的超管', async () => {
  const aid = (await who.super.post('/api/admin/users', { username: 'tmp-adm', password: 'xxxx-pass-1', role: 'admin' })).json.user.id;
  const adm = await login('tmp-adm', 'xxxx-pass-1');
  const tid = (await adm.post('/api/admin/users', { username: 'tmp-ten', password: 'xxxx-pass-1' })).json.user.id;
  assert.equal((await who.super.del(`/api/admin/users/${aid}`)).status, 200);
  assert.equal((await adm.get('/api/me')).json.user, null);
  const t = db.prepare('SELECT created_by FROM users WHERE id = ?').get(tid);
  assert.equal(t.created_by, id.super);
  const listed = (await who.super.get('/api/admin/users')).json.items.find((u) => u.id === tid);
  assert.equal(listed.created_by_name, '超管');
  await who.super.del(`/api/admin/users/${tid}`);
});

test('scripts/create-admin.mjs --role super|admin（默认 super），不能降级最后一个 super', () => {
  const d = path.join(dir, 'script-data');
  mkdirSync(d, { recursive: true });
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'create-admin.mjs'), ...args], {
    env: { ...process.env, DATA_DIR: d, ADMIN_PASSWORD: 'script-pass-1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const roleOfName = (name) => {
    const x = openDb(path.join(d, 'aichat.sqlite'));
    try { return x.prepare('SELECT role, is_admin, created_by FROM users WHERE username = ?').get(name); } finally { x.close(); }
  };
  let r = run('boss');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /超级管理员/);
  assert.deepEqual({ ...roleOfName('boss') }, { role: 'super', is_admin: 1, created_by: null });
  r = run('mgr', '--role', 'admin', '--display', '经理');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual({ ...roleOfName('mgr') }, { role: 'admin', is_admin: 1, created_by: null });
  r = run('boss', '--role', 'admin');
  assert.notEqual(r.status, 0, '最后一个 super 不能降级');
  assert.match(r.stderr, /最后一个/);
  assert.equal(roleOfName('boss').role, 'super');
  r = run('mgr', '--role', 'super');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(roleOfName('mgr').role, 'super');
  r = run('boss', '--role', 'admin'); // 现在有两个 super，可以降
  assert.equal(r.status, 0, r.stderr);
  assert.equal(roleOfName('boss').role, 'admin');
  r = run('x1', '--role', 'tenant');
  assert.notEqual(r.status, 0);
  assert.equal(roleOfName('x1'), undefined);
  r = run('x2', '--bogus');
  assert.notEqual(r.status, 0);
  assert.ok(!/script-pass-1/.test(r.stdout + r.stderr), '不回显密码');
});

// ---- 慢速请求体（TOCTOU）：鉴权必须以读完请求体之后的状态为准 ----
/** 发一个请求，先只发前几个字节，返回 {finish()}：finish 把剩下的发完并拿到 {status, json}。 */
function slowRequest(client, method, p, body) {
  const raw = Buffer.from(JSON.stringify(body));
  const u = new URL(base + p);
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method,
    headers: { cookie: client.cookie, 'content-type': 'application/json', 'content-length': raw.length } });
  const done = new Promise((resolve, reject) => {
    req.on('response', (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* */ } resolve({ status: res.statusCode, json: j, text: t }); }); });
    req.on('error', reject);
  });
  req.write(raw.subarray(0, 5));
  return { finish: async () => { await new Promise((r) => setTimeout(r, 50)); req.end(raw.subarray(5)); return done; } };
}

test('慢速请求体：admin 挂起的改密请求，目标在此期间被超管升为 admin → 404，密码不变', async () => {
  const adm = await login('adma', 'adma-pass-1');
  const tid = (await adm.post('/api/admin/users', { username: 'slow-t', password: 'slow-pass-1' })).json.user.id;
  const pending = slowRequest(adm, 'PATCH', `/api/admin/users/${tid}`, { password: 'ownedByA99' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await who.super.patch(`/api/admin/users/${tid}`, { role: 'admin' })).status, 200);
  const r = await pending.finish();
  assert.equal(r.status, 404, r.text);
  const c = new Client(base);
  assert.equal((await c.post('/api/login', { username: 'slow-t', password: 'ownedByA99' })).status, 401);
  assert.equal((await c.post('/api/login', { username: 'slow-t', password: 'slow-pass-1' })).status, 200);
  await who.super.del(`/api/admin/users/${tid}`);
});

test('慢速请求体：admin 挂起的建租户请求，期间被停用 / 降为租户 → 不再按旧权限执行', async () => {
  for (const [name, change, want] of [['slow-a1', { disabled: 1 }, 401], ['slow-a2', { role: 'tenant' }, 403]]) {
    const aid = (await who.super.post('/api/admin/users', { username: name, password: 'xxxx-pass-1', role: 'admin' })).json.user.id;
    const adm = await login(name, 'xxxx-pass-1');
    const pending = slowRequest(adm, 'POST', '/api/admin/users', { username: `${name}-late`, password: 'xxxx-pass-1' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await who.super.patch(`/api/admin/users/${aid}`, change)).status, 200);
    const r = await pending.finish();
    assert.equal(r.status, want, r.text);
    assert.equal(db.prepare('SELECT 1 FROM users WHERE username = ?').get(`${name}-late`), undefined);
    await who.super.del(`/api/admin/users/${aid}`);
  }
});

test('慢速请求体：super 挂起的设置写请求，期间会话失效 → 401，不执行', async () => {
  const before = (await who.super.get('/api/admin/settings')).json.settings.site_name;
  const pending = slowRequest(who.super, 'PATCH', '/api/admin/settings', { site_name: '慢速改名' });
  await new Promise((r) => setTimeout(r, 50));
  // 把这个 super 的会话登出后再发完：读完请求体后重新查会话 → 401
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id.super);
  const r = await pending.finish();
  assert.equal(r.status, 401, r.text);
  who.super = await login('root', 'root-pass-1');
  assert.equal((await who.super.get('/api/admin/settings')).json.settings.site_name, before);
});
