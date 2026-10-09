// v0.6 系统日志（契约 §11）：每个 kind 都断言写入内容；隐私（日志表与接口响应里没有密码、key、会话内容、上游正文）；
// 权限（admin / tenant 403）；查询（分页 / kind 前缀 / 级别 / 账号 / LIKE 转义 / 新加坡日期）；日志接口访问不记录；
// 保留期清理；写日志失败不影响业务；v4 带数据升级到 v5；真启动 server.mjs 记 system.start / system.migrate。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDb, getSettings, SCHEMA_VERSION } from '../server/db.mjs';
import { hashPassword } from '../server/auth.mjs';
import { createApp } from '../server/app.mjs';
import { HttpError, nowIso } from '../server/util.mjs';
import { nodeToCard } from '../server/chub.mjs';
import { createLlm } from '../server/llm.mjs';
import { createModelService, loadOrCreateSecret, encryptSecret } from '../server/models.mjs';
import { writeLog, purgeOldLogs, sanitizeDetail, LOG_KINDS } from '../server/logs.mjs';
import { ROOT } from '../server/config.mjs';
import { tmpDir, cleanupTmp, listenFree, portFree, Client, parseSse } from './helpers.mjs';

const PORTS = [44989, 44988, 44987, 44986, 44985, 44984, 44983, 44982];

// 隐私标记：这些字符串只要出现在日志表或日志接口响应里就算泄漏。
const PW = { root: 'PwRoot-0001-xx', adm: 'PwAdm-0002-xx', ten: 'PwTen-0003-xx', newTen: 'PwNewTen-0004-xx', reset: 'PwReset-0005-xx', wrong: 'PwWrong-0006-xx', self: 'PwSelf-0007-xx' };
const MODEL_KEY = 'sk-LOGTEST-' + 'q'.repeat(20) + 'K3y9';
const MODEL_KEY2 = 'sk-LOGTEST2-' + 'w'.repeat(20) + 'Z8x7';
const CHAT_TEXT = 'CHAT-SECRET-CONTENT-甲乙丙';
const UPSTREAM_BODY = 'UPSTREAM-SECRET-BODY';
const V8_SECRETS = []; // v0.8 用例里产生的明文重置码 / 新密码（日志里绝不能出现）
const SECRETS = [...Object.values(PW), MODEL_KEY, MODEL_KEY2, MODEL_KEY.slice(-8), MODEL_KEY2.slice(-8), CHAT_TEXT, UPSTREAM_BODY, 'scrypt$'];

const NODES = {
  'tester/girl': { fullPath: 'tester/girl', name: 'Girl', tagline: 'hi', avatar_url: 'https://avatars.charhub.io/a/g.webp', topics: [], nsfw_image: false,
    definition: { name: 'Girl', first_message: '你好，{{user}}！' } },
  'tester/boy': { fullPath: 'tester/boy', name: 'Boy', tagline: 'yo', avatar_url: 'https://avatars.charhub.io/a/b.webp', topics: [], nsfw_image: false,
    definition: { name: 'Boy', first_message: '嗨' } },
};
const fakeChub = {
  async search() { return { items: Object.values(NODES).map(nodeToCard), page: 1, has_more: false }; },
  async character(p) { if (!NODES[p]) throw new HttpError(404, '没有找到这个角色'); return structuredClone(NODES[p]); },
};

// 假上游：risk → 400 审核（正文带标记）；err500 → 500（正文带标记）；slow → 不回；其他正常流式。
function startUpstream() {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      const m = body.model;
      if (m === 'risk') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `Content Exists Risk ${UPSTREAM_BODY}` } })); return; }
      if (m === 'err500') { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: UPSTREAM_BODY } })); return; }
      if (m === 'slow') return;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ model: m, choices: [{ delta: { content: '好的' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ model: m, choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
}

let dir, up, appServer, base, db, svc;
const id = {};
const who = {};
const mid = {};

async function login(u, p) {
  // 管理员直接开的号首次登录要先改密（契约 §13.3，见 invites.test.mjs）；这里的用例与之无关，直接清掉标记。
  db.prepare('UPDATE users SET must_change_password = 0 WHERE username = ?').run(u);
  const c = new Client(base);
  const r = await c.post('/api/login', { username: u, password: p });
  assert.equal(r.status, 200, `${u} 登录：${r.text}`);
  return c;
}

const allLogs = () => db.prepare('SELECT * FROM logs ORDER BY id').all();
const lastLog = (kind) => db.prepare('SELECT * FROM logs WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind);
const detailOf = (row) => (row?.detail_json ? JSON.parse(row.detail_json) : null);
const maxId = () => db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM logs').get().m;
const logsSince = (fromId) => db.prepare('SELECT * FROM logs WHERE id > ? ORDER BY id').all(fromId);
const changeOf = (row, field) => detailOf(row)?.changes?.find((c) => c.field === field);

function addMockModel(name, model, upBase, enabled = 1) {
  const key = loadOrCreateSecret(path.join(dir, 'secret.key'));
  const max = db.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM models').get().m;
  return Number(db.prepare('INSERT INTO models(name, provider, base_url, api_key_enc, model, enabled, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(name, '测试', upBase, encryptSecret(MODEL_KEY, key), model, enabled, max + 1, nowIso()).lastInsertRowid);
}

before(async () => {
  dir = tmpDir('unit-logs');
  up = startUpstream();
  const upBase = `http://127.0.0.1:${await listenFree(up, PORTS)}/v1`;
  db = openDb(path.join(dir, 'aichat.sqlite'));
  id.super = Number(db.prepare("INSERT INTO users(username, password_hash, display_name, is_admin, role, created_at) VALUES ('root', ?, '超管', 1, 'super', ?)")
    .run(hashPassword(PW.root), nowIso()).lastInsertRowid);
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  svc = createModelService({ db, secretFile: path.join(dir, 'secret.key'), lookup });
  mid.ok = addMockModel('正常', 'ok-a', upBase);
  mid.risk = addMockModel('拒答模型', 'risk', upBase);
  mid.err = addMockModel('坏模型', 'err500', upBase);
  mid.slow = addMockModel('慢模型', 'slow', upBase);
  mid.xai = Number(db.prepare("INSERT INTO models(name, provider, base_url, api_key_enc, model, enabled, sort, proxy_url, created_at) VALUES ('Grok', 'xAI', 'https://api.x.ai/v1', ?, 'grok-x', 0, 99, 'http://127.0.0.1:42001', ?)")
    .run(encryptSecret(MODEL_KEY, loadOrCreateSecret(path.join(dir, 'secret.key'))), nowIso()).lastInsertRowid);
  const real = createLlm({ models: svc, checkUpstream: null, firstByteTimeoutMs: 400, idleTimeoutMs: 400 });
  const llm = {
    streamChat: real.streamChat,
    complete: real.complete,
    // 同步价格：不出网，直接给一张假价格表
    async getJson() { return { models: [{ id: 'grok-x', prompt_text_token_price: 20000, cached_prompt_text_token_price: 5000, completion_text_token_price: 60000 }] }; },
  };
  // 抓取控制接口用假的（契约 §15）：记下收到的请求，不出网、不碰真实 17990。
  const crawler = { calls: [], async request(method, p, body) { this.calls.push({ method, p, body }); return { ok: true, status: 200, json: { ok: true } }; } };
  const app = createApp({ db, chub: fakeChub, llm, models: svc, avatars: { get: async () => ({ type: 'image/png', buf: Buffer.from('x') }) },
    config: { publicDir: path.join(dir, 'pub'), deepseekModel: 'fake' }, crawler });
  appServer = http.createServer(app.handle);
  base = `http://127.0.0.1:${await listenFree(appServer, PORTS)}`;
  who.super = await login('root', PW.root);
  let r = await who.super.post('/api/admin/users', { username: 'adm', password: PW.adm, display_name: '管理甲', role: 'admin' });
  assert.equal(r.status, 200, r.text);
  id.admin = r.json.user.id;
  who.admin = await login('adm', PW.adm);
  r = await who.admin.post('/api/admin/users', { username: 'ten', password: PW.ten, display_name: '租户甲' });
  assert.equal(r.status, 200, r.text);
  id.tenant = r.json.user.id;
  who.tenant = await login('ten', PW.ten);
});

after(async () => {
  await new Promise((r) => appServer.close(r));
  up.closeAllConnections?.();
  await new Promise((r) => up.close(r));
  db.close();
  cleanupTmp(dir);
});

// ---------- auth.* ----------
test('auth.login 成功：info，操作人 = 本人，ip = socket 地址，不写密码', async () => {
  await login('ten', PW.ten);
  const row = lastLog('auth.login');
  assert.equal(row.level, 'info');
  assert.equal(row.actor_id, id.tenant);
  assert.equal(row.actor_name, '租户甲');
  assert.equal(row.target_type, 'user');
  assert.equal(row.target_id, id.tenant);
  assert.equal(row.ip, '127.0.0.1');
  assert.match(row.summary, /ten.*登录成功/);
  assert.deepEqual(detailOf(row), { result: 'ok', username: 'ten', user_agent: 'node' }); // 契约 §14：带 UA
});

test('auth.login 失败：warn，写尝试的用户名与原因（密码错误 / 账号不存在 / 停用），不写密码；X-Forwarded-For 不被采信', async () => {
  const c = new Client(base);
  let r = await c.post('/api/login', { username: 'ten', password: PW.wrong }, { 'x-forwarded-for': '8.8.8.8' });
  assert.equal(r.status, 401);
  let row = lastLog('auth.login');
  assert.equal(row.level, 'warn');
  assert.equal(row.ip, '127.0.0.1');
  // 操作人是未登录的请求方：actor 留空，被尝试的账号只在 target 与 detail.username
  assert.equal(row.actor_id, null);
  assert.equal(row.actor_name, null);
  assert.equal(row.target_type, 'user');
  assert.equal(row.target_id, id.tenant);
  assert.deepEqual(detailOf(row), { result: 'fail', username: 'ten', reason: '密码错误', user_agent: 'node' });
  assert.match(row.summary, /登录失败：ten（密码错误）/);

  r = await c.post('/api/login', { username: 'ghost-user', password: PW.wrong });
  assert.equal(r.status, 401);
  row = lastLog('auth.login');
  assert.equal(row.actor_id, null);
  assert.equal(row.actor_name, null);
  assert.equal(row.target_id, null);
  assert.equal(detailOf(row).username, 'ghost-user');
  assert.equal(detailOf(row).reason, '账号不存在');

  // 停用（超管直接改库造一个停用账号，免得多出 user.disable 日志）
  db.prepare("INSERT INTO users(username, password_hash, display_name, disabled, role, created_at) VALUES ('frozen', ?, '冻结', 1, 'tenant', ?)").run(hashPassword(PW.wrong), nowIso());
  r = await c.post('/api/login', { username: 'frozen', password: PW.wrong });
  assert.equal(r.status, 403);
  row = lastLog('auth.login');
  assert.equal(row.level, 'warn');
  assert.equal(detailOf(row).reason, '停用');
});

test('auth.lockout：连续 5 次失败记一条锁定；锁定期间再试记「锁定」原因且每分钟最多一条', async () => {
  db.prepare("INSERT INTO users(username, password_hash, display_name, role, created_at) VALUES ('victim', ?, '受害者', 'tenant', ?)").run(hashPassword(PW.self), nowIso());
  const c = new Client(base);
  const start = maxId();
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/login', { username: 'victim', password: PW.wrong })).status, 401);
  const lock = logsSince(start).filter((x) => x.kind === 'auth.lockout');
  assert.equal(lock.length, 1);
  assert.equal(lock[0].level, 'warn');
  assert.equal(lock[0].ip, '127.0.0.1');
  assert.equal(lock[0].actor_id, null);
  assert.equal(lock[0].actor_name, null);
  assert.equal(lock[0].target_type, 'user');
  assert.ok(lock[0].target_id > 0);
  assert.ok(logsSince(start).filter((x) => x.kind === 'auth.login').every((x) => x.actor_id === null && x.actor_name === null));
  assert.deepEqual(detailOf(lock[0]), { username: 'victim', scope: 'user', minutes: 10, user_agent: 'node' });
  assert.match(lock[0].summary, /victim.*锁定 10 分钟/);
  const mid1 = maxId();
  for (let i = 0; i < 3; i++) assert.equal((await c.post('/api/login', { username: 'victim', password: PW.self })).status, 429);
  const locked = logsSince(mid1);
  assert.equal(locked.length, 1, '锁定期间的反复尝试只记一条');
  assert.equal(locked[0].kind, 'auth.login');
  assert.equal(detailOf(locked[0]).reason, '锁定');
  assert.equal(locked[0].actor_id, null);
});

test('auth.login：IP 整体被锁后换用户名反复尝试，每个 IP 每分钟只多记一条（防刷日志表）', async () => {
  // 单独起一个 app（自带独立的登录限流器），免得把主测试实例的 127.0.0.1 锁住
  const app2 = createApp({ db, chub: fakeChub, llm: { streamChat() {}, complete() {}, async getJson() { return {}; } }, models: svc,
    avatars: { get: async () => ({ type: 'image/png', buf: Buffer.from('x') }) }, config: { publicDir: path.join(dir, 'pub'), deepseekModel: 'fake' } });
  const srv2 = http.createServer(app2.handle);
  const base2 = `http://127.0.0.1:${await listenFree(srv2, PORTS)}`;
  try {
    const c = new Client(base2);
    for (let i = 0; i < 30; i++) assert.equal((await c.post('/api/login', { username: `spray${i}`, password: PW.wrong })).status, 401);
    const mid1 = maxId();
    for (let i = 0; i < 40; i++) assert.equal((await c.post('/api/login', { username: `flood${i}`, password: PW.wrong })).status, 429);
    const after = logsSince(mid1);
    assert.equal(after.length, 1, `IP 锁定期间换 40 个用户名只能多 1 条，实际 ${after.length}`);
    assert.equal(after[0].kind, 'auth.login');
    assert.equal(detailOf(after[0]).reason, '锁定');
    assert.equal(after[0].actor_id, null);
  } finally {
    await new Promise((r) => srv2.close(r));
  }
});

test('auth.password_change：本人改密码记一条，不写新旧密码', async () => {
  const c = await login('ten', PW.ten);
  const r = await c.post('/api/me/password', { old_password: PW.ten, new_password: PW.newTen });
  assert.equal(r.status, 200, r.text);
  const row = lastLog('auth.password_change');
  assert.equal(row.actor_id, id.tenant);
  assert.equal(row.target_id, id.tenant);
  assert.match(row.summary, /修改了自己的密码/);
  assert.equal(row.detail_json, null);
  who.tenant = c;
});

test('auth.logout：已登录退出记一条；没登录的退出不记', async () => {
  const c = await login('ten', PW.newTen);
  const before = maxId();
  assert.equal((await c.post('/api/logout')).status, 200);
  const row = lastLog('auth.logout');
  assert.ok(row.id > before);
  assert.equal(row.actor_id, id.tenant);
  assert.equal(row.ip, '127.0.0.1');
  const n = maxId();
  assert.equal((await new Client(base).post('/api/logout')).status, 200);
  assert.equal(maxId(), n);
});

// ---------- user.* ----------
test('user.create：写创建者、角色、显示名；不写密码', async () => {
  const row = db.prepare("SELECT * FROM logs WHERE kind = 'user.create' AND target_id = ?").get(id.tenant);
  assert.equal(row.actor_id, id.admin);
  assert.equal(row.actor_name, '管理甲');
  assert.equal(row.level, 'info');
  assert.match(row.summary, /创建租户账号 ten（租户甲）/);
  assert.deepEqual(detailOf(row), { username: 'ten', display_name: '租户甲', role: 'tenant', role_name: '租户', daily_limit: '跟随全站', note: null, must_change_password: true });
  const adm = db.prepare("SELECT * FROM logs WHERE kind = 'user.create' AND target_id = ?").get(id.admin);
  assert.equal(adm.actor_id, id.super);
  assert.equal(detailOf(adm).role, 'admin');
});

test('user.update：列出字段旧值→新值（含备注）；管理接口拒绝 password 字段；没变化不记', async () => {
  // 契约 §13.3：管理员不能改密码，带 password 一律 400，且什么都不改、不记日志
  const n0 = maxId();
  const bad = await who.super.patch(`/api/admin/users/${id.tenant}`, { display_name: '不该生效', password: PW.reset });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, '管理员不能修改用户密码，请发重置码');
  assert.equal(maxId(), n0);
  assert.equal(db.prepare('SELECT display_name FROM users WHERE id = ?').get(id.tenant).display_name, '租户甲');
  const r = await who.super.patch(`/api/admin/users/${id.tenant}`, { display_name: '租户乙', note: '朋友介绍', daily_limit: 30 });
  assert.equal(r.status, 200, r.text);
  const row = lastLog('user.update');
  assert.equal(row.actor_id, id.super);
  assert.equal(row.target_id, id.tenant);
  const d = detailOf(row);
  assert.equal(d.username, 'ten');
  assert.deepEqual(changeOf(row, 'display_name'), { field: 'display_name', label: '显示名', from: '租户甲', to: '租户乙' });
  assert.deepEqual(changeOf(row, 'note'), { field: 'note', label: '备注', from: null, to: '朋友介绍' });
  assert.equal(changeOf(row, 'password'), undefined);
  assert.deepEqual(changeOf(row, 'daily_limit'), { field: 'daily_limit', label: '每日上限', from: '跟随全站', to: '30' });
  assert.match(row.summary, /修改账号 ten.*显示名、备注、每日上限/);
  // 角色变更
  await who.super.patch(`/api/admin/users/${id.tenant}`, { role: 'admin' });
  assert.deepEqual(changeOf(lastLog('user.update'), 'role'), { field: 'role', label: '角色', from: '租户', to: '管理员' });
  await who.super.patch(`/api/admin/users/${id.tenant}`, { role: 'tenant' });
  assert.deepEqual(changeOf(lastLog('user.update'), 'role'), { field: 'role', label: '角色', from: '管理员', to: '租户' });
  // 原样提交不产生日志
  const n = maxId();
  assert.equal((await who.super.patch(`/api/admin/users/${id.tenant}`, { display_name: '租户乙', daily_limit: 30 })).status, 200);
  assert.equal(maxId(), n);
  // 失败的修改不记
  assert.equal((await who.super.patch(`/api/admin/users/${id.tenant}`, { password: 'short' })).status, 400);
  assert.equal(maxId(), n);
});

test('user.disable / user.enable：单独成条；重复停用不再记', async () => {
  assert.equal((await who.admin.patch(`/api/admin/users/${id.tenant}`, { disabled: true })).status, 200);
  let row = lastLog('user.disable');
  assert.equal(row.actor_id, id.admin);
  assert.equal(row.target_id, id.tenant);
  assert.match(row.summary, /停用账号 ten/);
  const n = maxId();
  assert.equal((await who.admin.patch(`/api/admin/users/${id.tenant}`, { disabled: true })).status, 200);
  assert.equal(maxId(), n);
  assert.equal((await who.admin.patch(`/api/admin/users/${id.tenant}`, { disabled: false })).status, 200);
  row = lastLog('user.enable');
  assert.equal(row.target_id, id.tenant);
  assert.match(row.summary, /启用账号 ten/);
});

test('user.delete：写被删账号的用户名与角色', async () => {
  const r = await who.admin.post('/api/admin/users', { username: 'temp1', password: PW.self, display_name: '临时' });
  const tid = r.json.user.id;
  assert.equal((await who.admin.del(`/api/admin/users/${tid}`)).status, 200);
  const row = lastLog('user.delete');
  assert.equal(row.actor_id, id.admin);
  assert.equal(row.target_id, tid);
  assert.deepEqual(detailOf(row), { username: 'temp1', display_name: '临时', role: 'tenant' });
  assert.match(row.summary, /删除租户账号 temp1/);
});

// ---------- model.* ----------
test('model.create / update（key 只写「已更换」）/ disable / enable / delete / sync_price', async () => {
  let r = await who.super.post('/api/admin/models', { name: '新模型', provider: '某家', base_url: 'https://api.example.com/v1', model: 'm-1', api_key: MODEL_KEY2 });
  assert.equal(r.status, 200, r.text);
  const m = r.json.model.id;
  let row = lastLog('model.create');
  assert.equal(row.target_id, m);
  assert.equal(row.actor_id, id.super);
  const cd = detailOf(row);
  assert.equal(cd.name, '新模型');
  assert.equal(cd.key_source, '后台填写');
  assert.equal(cd.base_url, 'https://api.example.com/v1');

  r = await who.super.patch(`/api/admin/models/${m}`, { name: '新模型2', api_key: MODEL_KEY, price_in: 1.5 });
  assert.equal(r.status, 200, r.text);
  row = lastLog('model.update');
  assert.deepEqual(changeOf(row, 'name'), { field: 'name', label: '显示名', from: '新模型', to: '新模型2' });
  assert.deepEqual(changeOf(row, 'api_key'), { field: 'api_key', label: '密钥', from: null, to: '已更换' });
  assert.deepEqual(changeOf(row, 'price_in'), { field: 'price_in', label: '输入单价', from: null, to: 1.5 });
  assert.ok(!detailOf(row).changes.some((c) => c.field === 'api_key_enc'));

  r = await who.super.patch(`/api/admin/models/${m}`, { enabled: false });
  row = lastLog('model.disable');
  assert.equal(row.target_id, m);
  assert.match(row.summary, /停用模型「新模型2」/);
  r = await who.super.patch(`/api/admin/models/${m}`, { enabled: true });
  assert.equal(lastLog('model.enable').target_id, m);

  // 排序记成 model.update
  const ids = (await who.super.get('/api/admin/models')).json.items.map((x) => x.id);
  assert.equal((await who.super.post('/api/admin/models/order', { ids: ids.slice().reverse() })).status, 200);
  assert.match(lastLog('model.update').summary, /调整模型排序/);

  assert.equal((await who.super.del(`/api/admin/models/${m}`)).status, 200);
  row = lastLog('model.delete');
  assert.equal(row.target_id, m);
  assert.equal(detailOf(row).name, '新模型2');

  // 有会话在用的模型：删除改停用 → model.disable
  db.prepare("INSERT INTO characters(chub_path, name, fetched_at) VALUES ('x/inuse', 'X', ?)").run(nowIso());
  const cid = db.prepare("SELECT id FROM characters WHERE chub_path = 'x/inuse'").get().id;
  db.prepare('INSERT INTO chats(user_id, character_id, title, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id.super, cid, 'x', mid.slow, nowIso(), nowIso());
  assert.equal((await who.super.del(`/api/admin/models/${mid.slow}`)).json.disabled, true);
  row = lastLog('model.disable');
  assert.equal(row.target_id, mid.slow);
  assert.equal(detailOf(row).reason, '有会话在用');
  db.prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(mid.slow);

  r = await who.super.post(`/api/admin/models/${mid.xai}/sync-price`);
  assert.equal(r.status, 200, r.text);
  row = lastLog('model.sync_price');
  assert.equal(row.target_id, mid.xai);
  assert.deepEqual(changeOf(row, 'price_out'), { field: 'price_out', label: '输出单价', from: null, to: 6 });
});

// ---------- shelf.* ----------
test('shelf.create / update / add_item / reorder / remove_item / delete', async () => {
  let r = await who.super.post('/api/admin/shelves', { title: '推荐' });
  const sid = r.json.shelf.id;
  let row = lastLog('shelf.create');
  assert.equal(row.target_id, sid);
  assert.equal(detailOf(row).title, '推荐');
  await who.super.patch(`/api/admin/shelves/${sid}`, { title: '热门推荐' });
  row = lastLog('shelf.update');
  assert.deepEqual(changeOf(row, 'title'), { field: 'title', label: '标题', from: '推荐', to: '热门推荐' });
  assert.equal((await who.super.post(`/api/admin/shelves/${sid}/items`, { path: 'tester/girl' })).status, 200);
  assert.equal((await who.super.post(`/api/admin/shelves/${sid}/items`, { path: 'tester/boy' })).status, 200);
  row = lastLog('shelf.add_item');
  assert.deepEqual(detailOf(row), { shelf: '热门推荐', path: 'tester/boy', name: 'Boy' });
  // 重复添加不记
  const n = maxId();
  await who.super.post(`/api/admin/shelves/${sid}/items`, { path: 'tester/boy' });
  assert.equal(maxId(), n);
  await who.super.post(`/api/admin/shelves/${sid}/order`, { paths: ['tester/boy', 'tester/girl'] });
  assert.deepEqual(detailOf(lastLog('shelf.reorder')).paths, ['tester/boy', 'tester/girl']);
  await who.super.del(`/api/admin/shelves/${sid}/items/tester/boy`);
  assert.equal(detailOf(lastLog('shelf.remove_item')).path, 'tester/boy');
  await who.super.del(`/api/admin/shelves/${sid}`);
  row = lastLog('shelf.delete');
  assert.deepEqual(detailOf(row), { title: '热门推荐', items: 1 });
});

// ---------- settings.update ----------
test('settings.update：旧值→新值；log_retention_days 校验 1–3650', async () => {
  let r = await who.super.patch('/api/admin/settings', { site_name: '新站名', log_retention_days: 30, allow_user_chub_search: false });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.settings.log_retention_days, 30);
  const row = lastLog('settings.update');
  assert.deepEqual(changeOf(row, 'site_name'), { field: 'site_name', label: '站点名称', from: 'AI 角色聊天', to: '新站名' });
  assert.deepEqual(changeOf(row, 'log_retention_days'), { field: 'log_retention_days', label: '日志保留天数', from: 90, to: 30 });
  assert.deepEqual(changeOf(row, 'allow_user_chub_search'), { field: 'allow_user_chub_search', label: '允许租户搜索角色库', from: '允许', to: '不允许' });
  const n = maxId();
  for (const bad of [0, 3651, 1.5, 'abc', -1]) {
    r = await who.super.patch('/api/admin/settings', { site_name: '不该写进去', log_retention_days: bad });
    assert.equal(r.status, 400, `log_retention_days=${bad}`);
  }
  assert.equal(getSettings(db).site_name, '新站名', '校验失败时其他字段也不写');
  assert.equal(maxId(), n);
  assert.equal((await who.super.patch('/api/admin/settings', { log_retention_days: '3650' })).json.settings.log_retention_days, 3650);
  assert.equal((await who.super.patch('/api/admin/settings', { log_retention_days: 90, site_name: 'AI 角色聊天', allow_user_chub_search: true })).status, 200);
  // admin 不能改设置（也就不能改保留天数）
  assert.equal((await who.admin.patch('/api/admin/settings', { log_retention_days: 1 })).status, 403);
});

// ---------- llm.error ----------
test('llm.error：拒答 warn / 上游错误 error / 超时 warn；写模型、会话、用户、code、HTTP 状态，不写对话内容与上游正文', async () => {
  const c = await who.super.post('/api/chats', { path: 'tester/girl', model_id: mid.risk });
  assert.equal(c.status, 200, c.text);
  const chatId = c.json.chat.id;
  const send = async () => parseSse((await who.super.post(`/api/chats/${chatId}/messages`, { content: CHAT_TEXT })).text);

  let ev = await send();
  assert.equal(ev.find((e) => e.event === 'error')?.data.code, 'refused');
  let row = lastLog('llm.error');
  assert.equal(row.level, 'warn');
  assert.equal(row.actor_id, id.super);
  assert.equal(row.target_type, 'chat');
  assert.equal(row.target_id, chatId);
  let d = detailOf(row);
  assert.equal(d.code, 'refused');
  assert.equal(d.http_status, 400);
  assert.equal(d.chat_id, chatId);
  assert.ok(!('model_id' in d), '本地模型 id 不重复写进 detail');
  assert.equal(d.model_name, '拒答模型');
  assert.equal(d.model, 'risk');
  assert.equal(d.source, 'chat');
  assert.match(row.summary, /拒答模型拒答，HTTP 400，会话/);

  await who.super.patch(`/api/chats/${chatId}`, { model_id: mid.err });
  ev = await send();
  assert.equal(ev.find((e) => e.event === 'error')?.data.code, 'upstream');
  row = lastLog('llm.error');
  assert.equal(row.level, 'error');
  d = detailOf(row);
  assert.equal(d.code, 'upstream');
  assert.equal(d.http_status, 500);

  await who.super.patch(`/api/chats/${chatId}`, { model_id: mid.slow });
  ev = await send();
  assert.equal(ev.find((e) => e.event === 'error')?.data.code, 'timeout');
  row = lastLog('llm.error');
  assert.equal(row.level, 'warn');
  assert.equal(detailOf(row).code, 'timeout');
  assert.ok(!('http_status' in detailOf(row)), '没有 HTTP 状态就不写这个键');

  // 正常回复不记 llm.error
  await who.super.patch(`/api/chats/${chatId}`, { model_id: mid.ok });
  const n = db.prepare("SELECT COUNT(*) AS n FROM logs WHERE kind = 'llm.error'").get().n;
  ev = await send();
  assert.ok(ev.some((e) => e.event === 'done'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM logs WHERE kind = 'llm.error'").get().n, n);

  // 后台「测试」失败也记，source=test
  const t = await who.super.post(`/api/admin/models/${mid.err}/test`);
  assert.equal(t.json.ok, false);
  row = lastLog('llm.error');
  assert.equal(detailOf(row).source, 'test');
  assert.equal(row.target_type, 'model');
  assert.equal(row.target_id, mid.err);
});

// ---------- 接口 ----------
test('权限：/api/admin/logs 与 /kinds 只限 super；admin / tenant 403，未登录 401', async () => {
  const t = await login('ten', PW.newTen);
  for (const p of ['/api/admin/logs', '/api/admin/logs/kinds', '/api/admin/logs?kind=user.']) {
    assert.equal((await who.admin.get(p)).status, 403, `admin ${p}`);
    assert.equal((await t.get(p)).status, 403, `tenant ${p}`);
    assert.equal((await new Client(base).get(p)).status, 401, `anon ${p}`);
    assert.equal((await who.super.get(p)).status, 200, `super ${p}`);
  }
  // 只读：没有删除 / 写接口
  assert.equal((await who.super.del('/api/admin/logs')).status, 405);
  assert.equal((await who.super.post('/api/admin/logs', {})).status, 405);
});

test('GET /api/admin/logs：结构、倒序、kind 精确与前缀、级别、账号、关键词', async () => {
  let r = await who.super.get('/api/admin/logs');
  assert.equal(r.status, 200);
  assert.equal(r.json.page, 1);
  const it = r.json.items[0];
  assert.deepEqual(Object.keys(it).sort(), ['actor', 'at', 'detail', 'id', 'ip', 'kind', 'kind_name', 'level', 'summary', 'target_id', 'target_type'].sort());
  const ids = r.json.items.map((x) => x.id);
  assert.deepEqual(ids, ids.slice().sort((a, b) => b - a), '按时间倒序');

  r = await who.super.get('/api/admin/logs?kind=user.');
  assert.ok(r.json.items.length > 0 && r.json.items.every((x) => x.kind.startsWith('user.')));
  const kindsSeen = new Set(r.json.items.map((x) => x.kind));
  for (const k of ['user.create', 'user.update', 'user.disable', 'user.enable', 'user.delete']) assert.ok(kindsSeen.has(k), k);
  r = await who.super.get('/api/admin/logs?kind=user');
  assert.ok(r.json.items.every((x) => x.kind.startsWith('user.')));
  r = await who.super.get('/api/admin/logs?kind=user.delete');
  assert.ok(r.json.items.length >= 1 && r.json.items.every((x) => x.kind === 'user.delete'));
  assert.equal(r.json.items[0].kind_name, '删除账号');
  assert.deepEqual(r.json.items[0].actor, { id: id.admin, name: '管理甲' });

  r = await who.super.get('/api/admin/logs?level=error');
  assert.ok(r.json.items.length >= 1 && r.json.items.every((x) => x.level === 'error'));
  r = await who.super.get(`/api/admin/logs?actor_id=${id.admin}`);
  assert.ok(r.json.items.length >= 1 && r.json.items.every((x) => x.actor?.id === id.admin));
  r = await who.super.get(`/api/admin/logs?q=${encodeURIComponent('ghost-user')}`);
  assert.ok(r.json.items.length >= 1 && r.json.items.every((x) => x.summary.includes('ghost-user') || x.actor?.name?.includes('ghost-user')));
  r = await who.super.get(`/api/admin/logs?q=${encodeURIComponent('管理甲')}`); // actor_name 也搜
  assert.ok(r.json.items.some((x) => x.actor?.name === '管理甲' && !x.summary.includes('管理甲')));

  for (const bad of ['level=fatal', 'actor_id=abc', 'kind=a%25', 'from=2026-13-01', 'to=2026/10/01']) {
    assert.equal((await who.super.get(`/api/admin/logs?${bad}`)).status, 400, bad);
  }
});

test('GET /api/admin/logs：LIKE 转义、新加坡日期、分页每页 50', async () => {
  // 造数据：同一天（新加坡）边界两侧 + 带 % _ 的摘要
  writeLog(db, { kind: 'system.start', summary: '边界前 SGT 2020-05-01 23:59', at: '2020-05-01T15:59:59.000Z' });
  writeLog(db, { kind: 'system.start', summary: '边界后 SGT 2020-05-02 00:00', at: '2020-05-01T16:00:00.000Z' });
  writeLog(db, { kind: 'system.start', summary: '边界后 SGT 2020-05-02 23:59', at: '2020-05-02T15:59:59.000Z' });
  writeLog(db, { kind: 'settings.update', summary: '百分比 100%_ok', at: '2020-05-02T01:00:00.000Z' });
  writeLog(db, { kind: 'settings.update', summary: '百分比 1000xok', at: '2020-05-02T01:00:00.000Z' });
  let r = await who.super.get('/api/admin/logs?from=2020-05-02&to=2020-05-02');
  assert.deepEqual(r.json.items.map((x) => x.summary).sort(), ['百分比 1000xok', '百分比 100%_ok', '边界后 SGT 2020-05-02 00:00', '边界后 SGT 2020-05-02 23:59'].sort());
  r = await who.super.get(`/api/admin/logs?q=${encodeURIComponent('0%_')}`);
  assert.deepEqual(r.json.items.map((x) => x.summary), ['百分比 100%_ok']);
  r = await who.super.get(`/api/admin/logs?q=${encodeURIComponent('_')}`);
  assert.ok(r.json.items.every((x) => x.summary.includes('_') || x.actor?.name?.includes('_')));

  // 分页
  const day = '2019-03-03';
  for (let i = 0; i < 120; i++) writeLog(db, { kind: 'system.retention', summary: `批量 ${i}`, at: new Date(Date.parse(`${day}T04:00:00.000Z`) + i * 1000).toISOString() });
  const q = (p) => who.super.get(`/api/admin/logs?from=${day}&to=${day}&page=${p}`).then((x) => x.json);
  const p1 = await q(1), p2 = await q(2), p3 = await q(3);
  assert.equal(p1.items.length, 50); assert.equal(p1.has_more, true);
  assert.equal(p2.items.length, 50); assert.equal(p2.has_more, true);
  assert.equal(p3.items.length, 20); assert.equal(p3.has_more, false);
  assert.equal(p1.items[0].summary, '批量 119');
  assert.equal(p3.items[19].summary, '批量 0');
  db.prepare("DELETE FROM logs WHERE at < '2021-01-01'").run();
});

test('GET /api/admin/logs/kinds：全部类型与中文名、分组', async () => {
  writeLog(db, { kind: 'custom.thing', summary: '未登记的类型' });
  const r = await who.super.get('/api/admin/logs/kinds');
  assert.equal(r.status, 200);
  const map = Object.fromEntries(r.json.items.map((x) => [x.kind, x.name]));
  for (const [k, v] of Object.entries(LOG_KINDS)) assert.equal(map[k], v);
  assert.equal(map['custom.thing'], 'custom.thing');
  assert.ok(r.json.groups.some((g) => g.prefix === 'user.' && g.name === '账号'));
  db.prepare("DELETE FROM logs WHERE kind = 'custom.thing'").run();
});

test('日志接口本身的访问不记录', async () => {
  const n = maxId();
  await who.super.get('/api/admin/logs');
  await who.super.get('/api/admin/logs/kinds');
  await who.super.get('/api/admin/users');
  assert.equal(maxId(), n);
});

// ---------- card.* / chat.delete / message.delete（契约 §12）----------
test('card.create / update / fork / import / delete、chat.delete、message.delete：记卡名与改了哪些字段，不记卡片正文与聊天内容', async () => {
  let r = await who.super.post('/api/admin/users', { username: 'card-u', password: PW.self, display_name: '作者' });
  assert.equal(r.status, 200, r.text);
  const u = await login('card-u', PW.self);
  r = await u.post('/api/cards', { kind: 'character', name: '日志卡', description: CHAT_TEXT, first_mes: '开场' });
  assert.equal(r.status, 200, r.text);
  const cid = r.json.card.id;
  let row = lastLog('card.create');
  assert.equal(row.target_id, cid);
  assert.equal(row.target_type, 'card');
  assert.match(row.summary, /新建人物卡「日志卡」（私有）/);
  r = await u.patch(`/api/cards/${cid}`, { visibility: 'public', description: CHAT_TEXT + '2' });
  assert.equal(r.status, 200, r.text);
  row = lastLog('card.update');
  assert.deepEqual(detailOf(row).changes.map((c) => [c.field, c.from, c.to]), [['visibility', '私有', '站内公开'], ['description', null, '已修改']]);
  r = await u.post('/api/cards/fork', { from: 'user', id: cid });
  assert.equal(r.status, 200, r.text);
  row = lastLog('card.fork');
  assert.equal(row.target_id, r.json.card.id);
  assert.deepEqual([detailOf(row).from, detailOf(row).ref, detailOf(row).source_name], ['user', String(cid), '日志卡']);
  r = await u.post('/api/cards/import', { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '导入卡', description: CHAT_TEXT } });
  assert.equal(r.status, 200, r.text);
  assert.match(lastLog('card.import').summary, /导入人物卡「导入卡」/);
  const chat = (await u.post('/api/chats', { user_card_id: cid })).json.chat;
  const msgs = (await u.get(`/api/chats/${chat.id}`)).json.messages;
  assert.equal((await u.del(`/api/messages/${msgs[0].id}`)).status, 200);
  row = lastLog('message.delete');
  assert.deepEqual([row.target_type, row.target_id, detailOf(row).messages], ['chat', chat.id, 1]);
  assert.equal((await u.del(`/api/chats/${chat.id}`)).status, 200);
  row = lastLog('chat.delete');
  assert.deepEqual([row.target_type, row.target_id], ['chat', chat.id]);
  assert.equal((await u.del(`/api/cards/${cid}`)).status, 200);
  row = lastLog('card.delete');
  assert.equal(row.target_id, cid);
  assert.match(row.summary, /删除人物卡「日志卡」/);
  // 日志类型接口带中文名与分组
  const kinds = (await who.super.get('/api/admin/logs/kinds')).json;
  for (const k of ['card.create', 'card.update', 'card.delete', 'card.fork', 'card.import', 'chat.delete', 'message.delete']) {
    const it = kinds.items.find((x) => x.kind === k);
    assert.ok(it && it.name !== k, `缺少中文名：${k}`);
  }
  assert.ok(kinds.groups.some((g) => g.prefix === 'card.'));
});

test('v0.8 invite.create / invite.disable / user.register / user.reset_code_issued / user.password_reset：记备注与 id，不记密码、不记重置码', async () => {
  let r = await who.admin.post('/api/admin/invites', { note: '日志测试邀请', max_uses: 2, expires_in_days: 7 });
  assert.equal(r.status, 200, r.text);
  const inv = r.json.invite;
  let row = lastLog('invite.create');
  assert.deepEqual([row.actor_id, row.target_type, row.target_id], [id.admin, 'invite', inv.id]);
  assert.match(row.summary, /日志测试邀请/);
  assert.equal(detailOf(row).note, '日志测试邀请');
  const regPw = 'PwReg-0008-xx';
  V8_SECRETS.push(regPw);
  const c = new Client(base);
  r = await c.post('/api/register', { code: inv.code, username: 'reg-log', display_name: '注册者', password: regPw });
  assert.equal(r.status, 200, r.text);
  row = lastLog('user.register');
  assert.deepEqual([row.actor_id, row.target_type, row.target_id, row.ip], [r.json.user.id, 'user', r.json.user.id, '127.0.0.1']);
  assert.deepEqual([detailOf(row).invite_id, detailOf(row).invite_note, detailOf(row).user_agent], [inv.id, '日志测试邀请', 'node']);
  r = await who.admin.post(`/api/admin/invites/${inv.id}/disable`);
  assert.equal(r.status, 200, r.text);
  row = lastLog('invite.disable');
  assert.deepEqual([row.actor_id, row.target_id], [id.admin, inv.id]);
  const n = maxId();
  assert.equal((await who.admin.post(`/api/admin/invites/${inv.id}/disable`)).status, 200);
  assert.equal(maxId(), n, '重复停用不再记');
  const uid = db.prepare("SELECT id FROM users WHERE username = 'reg-log'").get().id;
  r = await who.admin.post(`/api/admin/users/${uid}/reset-code`);
  assert.equal(r.status, 200, r.text);
  V8_SECRETS.push(r.json.code);
  row = lastLog('user.reset_code_issued');
  assert.deepEqual([row.actor_id, row.target_id], [id.admin, uid]);
  const newPw = 'PwRegNew-0009-xx';
  V8_SECRETS.push(newPw);
  r = await new Client(base).post('/api/password/reset', { username: 'reg-log', code: r.json.code, new_password: newPw });
  assert.equal(r.status, 200, r.text);
  row = lastLog('user.password_reset');
  assert.deepEqual([row.actor_id, row.target_id, detailOf(row).issued_by], [uid, uid, id.admin]);
  const kinds = (await who.super.get('/api/admin/logs/kinds')).json;
  for (const k of ['invite.create', 'invite.disable', 'user.register', 'user.reset_code_issued', 'user.password_reset']) {
    const it = kinds.items.find((x) => x.kind === k);
    assert.ok(it && it.name !== k, `缺少中文名：${k}`);
  }
  assert.ok(kinds.groups.some((g) => g.prefix === 'invite.'));
});

test('v0.9 crawler.*：super 的抓取操作各记一条（阶段 / 全部 / 配置 / 出口），admin 调写接口 403 且不记', async () => {
  const before = allLogs().length;
  assert.equal((await who.admin.post('/api/admin/crawler/pause-all')).status, 403);
  assert.equal(allLogs().length, before);
  for (const [m, p, b] of [
    ['POST', '/api/admin/crawler/phase/card/start'], ['POST', '/api/admin/crawler/phase/avatar/pause'],
    ['POST', '/api/admin/crawler/pause-all'], ['POST', '/api/admin/crawler/resume-all'],
    ['PUT', '/api/admin/crawler/config', { per_exit_rps: 2 }],
    ['POST', '/api/admin/crawler/exits/7001/disable'], ['POST', '/api/admin/crawler/exits/direct/enable'],
  ]) assert.equal((await who.super.req(m, p, b ?? {})).status, 200, `${m} ${p}`);
  const row = lastLog('crawler.config');
  assert.equal(row.actor_id, id.super);
  assert.deepEqual(detailOf(row).patch, { per_exit_rps: 2 });
  assert.match(lastLog('crawler.phase_start').summary, /角色卡详情/);
  assert.equal(detailOf(lastLog('crawler.exit_enable')).exit, 'direct');
});

// ---------- v1.0 chat.override_update / chat.rewind（契约 §20）----------
test('v1.0 chat.override_update / chat.rewind：只记改了哪些字段与条数，不记设定正文与聊天内容', async () => {
  // 翻译模型（契约 §19.2，super 可改）指到能快速回应的假模型，免得新建会话等在途翻译
  let r = await who.super.patch('/api/admin/settings', { translate_model_id: mid.ok });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.settings.translate_model_id, mid.ok);
  assert.deepEqual(changeOf(lastLog('settings.update'), 'translate_model_id').label, '翻译模型');
  const chat = (await who.super.post('/api/chats', { path: 'tester/girl', model_id: mid.ok })).json.chat;
  r = await who.super.patch(`/api/chats/${chat.id}/settings`, { override: { personality: CHAT_TEXT }, persona: { name: '旅人', desc: CHAT_TEXT } });
  assert.equal(r.status, 200, r.text);
  let row = lastLog('chat.override_update');
  assert.deepEqual([row.actor_id, row.target_type, row.target_id], [id.super, 'chat', chat.id]);
  assert.deepEqual(detailOf(row).fields, ['personality', 'persona_name', 'persona_desc']);
  assert.match(row.summary, /性格、我的称呼、我的人设/);
  assert.equal((await who.super.del(`/api/chats/${chat.id}/settings`)).status, 200);
  assert.equal(detailOf(lastLog('chat.override_update')).reset, true);
  const ev = parseSse((await who.super.post(`/api/chats/${chat.id}/messages`, { content: CHAT_TEXT })).text);
  const um = ev.find((e) => e.event === 'user').data.message;
  r = await who.super.post(`/api/messages/${um.id}/rewind`, { content: CHAT_TEXT + '改' });
  assert.equal(r.status, 200);
  row = lastLog('chat.rewind');
  assert.deepEqual([row.target_type, row.target_id, detailOf(row).message_id, detailOf(row).replaced_messages, detailOf(row).edited], ['chat', chat.id, um.id, 1, true]);
  const kinds = (await who.super.get('/api/admin/logs/kinds')).json;
  for (const k of ['chat.override_update', 'chat.rewind']) assert.ok(kinds.items.find((x) => x.kind === k && x.name !== k), `缺少中文名：${k}`);
});

test('隐私：日志表与日志接口响应里没有密码、密码哈希、key、会话内容、上游正文、cookie', async () => {
  const dump = JSON.stringify(allLogs());
  const pages = [];
  for (let p = 1; p < 50; p++) {
    const r = await who.super.get(`/api/admin/logs?page=${p}`);
    pages.push(r.text);
    if (!r.json.has_more) break;
  }
  pages.push((await who.super.get('/api/admin/logs/kinds')).text);
  const cookie = who.super.cookie.replace('ac_sid=', '');
  for (const s of [...SECRETS, ...V8_SECRETS, cookie]) {
    assert.ok(!dump.includes(s), `日志表泄漏：${s.slice(0, 6)}…`);
    for (const t of pages) assert.ok(!t.includes(s), `日志接口泄漏：${s.slice(0, 6)}…`);
  }
  // 每个 kind 至少有一条（system.* 在后面的用例里单独验）
  const have = new Set(allLogs().map((x) => x.kind));
  // v1.0 的 chat.file_create / voice.error 在 v10-file-voice.test.mjs 里单独验（含不记正文、不记识别文字）
  for (const k of Object.keys(LOG_KINDS).filter((x) => !x.startsWith('system.') && x !== 'chat.file_create' && !x.startsWith('voice.'))) assert.ok(have.has(k), `缺少 ${k}`);
});

test('sanitizeDetail 兜底：密码 / key / cookie 之类的键一律丢掉，超长字符串截断', () => {
  const s = sanitizeDetail({ password: 'x', api_key: 'y', nested: { cookie: 'c', token: 't', ok: 1 }, long: 'a'.repeat(900), changes: [{ field: 'password', to: '已重置' }] });
  assert.deepEqual(Object.keys(s).sort(), ['changes', 'long', 'nested']);
  assert.deepEqual(s.nested, { ok: 1 });
  assert.equal(s.long.length, 501);
  assert.deepEqual(s.changes, [{ field: 'password', to: '已重置' }]);
});

test('写日志失败不影响业务：logs 表没了照样能登录、改设置', async () => {
  db.exec('ALTER TABLE logs RENAME TO logs_hidden');
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const c = await login('root', PW.root);
    assert.equal((await c.post('/api/login', { username: 'root', password: PW.wrong })).status, 401);
    assert.equal((await c.patch('/api/admin/settings', { site_name: '还能改' })).status, 200);
    assert.equal(writeLog(db, { kind: 'system.start', summary: 'x' }), null);
    assert.equal(purgeOldLogs(db), 0);
  } finally {
    console.error = orig;
    db.exec('ALTER TABLE logs_hidden RENAME TO logs');
  }
  assert.ok(errs.some((e) => e.includes('[log]')));
  await who.super.patch('/api/admin/settings', { site_name: 'AI 角色聊天' });
});

// ---------- 保留期清理 ----------
test('system.retention：按 log_retention_days 删超期日志并记清理条数；没删就不记', async () => {
  db.prepare("UPDATE settings SET value = '10' WHERE key = 'log_retention_days'").run();
  const now = Date.parse('2026-10-01T00:00:00.000Z');
  writeLog(db, { kind: 'system.start', summary: '旧1', at: '2026-09-01T00:00:00.000Z' });
  writeLog(db, { kind: 'system.start', summary: '旧2', at: '2026-09-20T23:59:59.000Z' });
  writeLog(db, { kind: 'system.start', summary: '新1', at: '2026-09-21T00:00:01.000Z' });
  const total = db.prepare("SELECT COUNT(*) AS n FROM logs WHERE at < '2026-09-21T00:00:00.000Z'").get().n;
  assert.equal(purgeOldLogs(db, { now }), total);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM logs WHERE summary IN ('旧1','旧2')").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM logs WHERE summary = '新1'").get().n, 1);
  const row = lastLog('system.retention');
  assert.equal(row.level, 'info');
  assert.deepEqual(detailOf(row), { deleted: total, retention_days: 10, before: '2026-09-21T00:00:00.000Z' });
  assert.match(row.summary, new RegExp(`清理了 ${total} 条超过 10 天`));
  const n = maxId();
  assert.equal(purgeOldLogs(db, { now }), 0);
  assert.equal(maxId(), n);
  // 设置坏了回落 90 天
  db.prepare("UPDATE settings SET value = 'oops' WHERE key = 'log_retention_days'").run();
  assert.equal(getSettings(db).log_retention_days, 90);
  db.prepare("UPDATE settings SET value = '90' WHERE key = 'log_retention_days'").run();
});

// ---------- 迁移 ----------
test('迁移：v4 带数据的库升级到 v5，旧数据一条不丢，logs 表与索引就位，记 system.migrate；再开幂等', () => {
  const d = path.join(dir, 'mig'); mkdirSync(d, { recursive: true });
  const file = path.join(d, 'aichat.sqlite');
  // 只迁到 v4（v0.4 线上库结构），再删掉保留天数设置
  let x = openDb(file, { upTo: 4 });
  x.exec("DELETE FROM settings WHERE key = 'log_retention_days';");
  const t = '2026-10-01T00:00:00.000Z';
  x.prepare("INSERT INTO users(username, password_hash, display_name, is_admin, role, created_at) VALUES ('admin', 'h', '超管', 1, 'super', ?)").run(t);
  x.prepare("INSERT INTO users(username, password_hash, display_name, role, created_by, created_at) VALUES ('amy', 'h2', '艾米', 'tenant', 1, ?)").run(t);
  x.prepare("INSERT INTO characters(chub_path, name, fetched_at) VALUES ('a/b', '角色', ?)").run(t);
  x.prepare("INSERT INTO chats(user_id, character_id, title, created_at, updated_at) VALUES (2, 1, '角色', ?, ?)").run(t, t);
  x.prepare("INSERT INTO messages(chat_id, role, content, created_at, tokens_in, tokens_out, cost_usd, cost_source) VALUES (1, 'assistant', '你好', ?, 3, 4, 0.001, 'estimate')").run(t);
  x.prepare("INSERT INTO usage_daily(user_id, day, messages, tokens_in, tokens_out, cost_usd) VALUES (2, '2026-10-01', 1, 3, 4, 0.001)").run();
  x.prepare("INSERT INTO settings(key, value) VALUES ('site_name', '我的站') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const tables = ['users', 'characters', 'chats', 'messages', 'usage_daily', 'models', 'system_costs'];
  const snap = (db2, tb) => db2.prepare(`SELECT * FROM ${tb} ORDER BY rowid`).all().map((r) => ({ ...r }));
  const before = Object.fromEntries(tables.map((tb) => [tb, snap(x, tb)]));
  const beforeSettings = snap(x, 'settings');
  x.close();
  const raw = new DatabaseSync(file);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'logs'").get().n, 0);
  raw.close();

  x = openDb(file, { upTo: 5 });
  assert.equal(x.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal(SCHEMA_VERSION, 12);
  for (const tb of tables) assert.deepEqual(snap(x, tb), before[tb], `${tb} 不变`);
  assert.deepEqual(snap(x, 'settings').filter((r) => r.key !== 'log_retention_days'), beforeSettings);
  assert.equal(getSettings(x).log_retention_days, 90);
  assert.deepEqual(x.prepare('PRAGMA table_info(logs)').all().map((c) => c.name),
    ['id', 'at', 'level', 'kind', 'actor_id', 'actor_name', 'target_type', 'target_id', 'ip', 'summary', 'detail_json']);
  const idx = x.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'logs'").all().map((r) => r.name).sort();
  assert.deepEqual(idx, ['idx_logs_actor_at', 'idx_logs_at', 'idx_logs_kind_at']);
  const mig = x.prepare("SELECT * FROM logs WHERE kind = 'system.migrate'").all();
  assert.equal(mig.length, 1);
  assert.deepEqual(JSON.parse(mig[0].detail_json), { from: 4, to: 5 });
  assert.equal(mig[0].summary, '数据库从版本 4 升级到 5');
  assert.equal(mig[0].actor_id, null);
  x.close();
  x = openDb(file, { upTo: 5 });
  assert.equal(x.prepare("SELECT COUNT(*) AS n FROM logs WHERE kind = 'system.migrate'").get().n, 1, '不重复迁移、不重复记');
  x.close();
});

// ---------- 真启动 ----------
test('真启动 server.mjs：记 system.migrate（0→最新）、启动建超管的 user.create、system.start（版本、端口）；按 PID 停', async () => {
  const d = path.join(dir, 'boot'); mkdirSync(d, { recursive: true });
  const keys = path.join(d, 'keys.env');
  writeFileSync(keys, '');
  let port = null;
  for (const p of [44983, 44984, 44985, 44986, 44987, 44988, 44989]) if (await portFree(p)) { port = p; break; }
  assert.ok(port, '没有空闲端口');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), DATA_DIR: d, AI_KEYS_FILE: keys, SSL_DIR: path.join(d, 'no-ssl'),
      ADMIN_BOOTSTRAP_PASSWORD: PW.root, MODEL_SEED_PROBE: '0', NO_PROXY: '*' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  try {
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++) {
      try { ok = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.ok(ok, `服务没起来：${out}`);
  } finally {
    child.kill('SIGTERM'); // 按 PID 停自己起的子进程
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
  }
  const b = new DatabaseSync(path.join(d, 'aichat.sqlite'));
  const rows = b.prepare('SELECT * FROM logs ORDER BY id').all();
  b.close();
  const kinds = rows.map((r) => r.kind);
  assert.deepEqual(kinds, ['system.migrate', 'user.create', 'system.start'], out);
  assert.deepEqual(JSON.parse(rows[0].detail_json), { from: 0, to: SCHEMA_VERSION });
  assert.equal(rows[1].actor_name, '系统');
  const st = JSON.parse(rows[2].detail_json);
  assert.equal(st.version, '1.1.0');
  assert.equal(st.port, port);
  assert.match(rows[2].summary, new RegExp(`版本 1\\.1\\.0，端口 ${port}`));
  assert.ok(!JSON.stringify(rows).includes(PW.root));
});
