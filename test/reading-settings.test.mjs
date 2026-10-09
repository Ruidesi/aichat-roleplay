// 阅读设定：真实本地 HTTP + SQLite，全部数据留在本测试的临时目录，禁止调用上游。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { openDb } from '../server/db.mjs';
import { hashPassword, createSession, publicUser } from '../server/auth.mjs';
import { createApp } from '../server/app.mjs';
import { tmpDir, cleanupTmp, Client } from './helpers.mjs';

const DEFAULTS = {
  font_scale: 1, font_size: 16, font_family: 'system', font_weight: 400,
  line_height: 1.6, letter_spacing: 0,
};
const CUSTOM = {
  font_scale: 1.15, font_size: 22, font_family: 'serif', font_weight: 500,
  line_height: 1.9, letter_spacing: 0.5,
};
const PASSWORD = 'reading-test-pass-12';
const PASSWORD_HASH = hashPassword(PASSWORD);
const CREATED_AT = '2026-10-02T00:00:00.000Z';
let rootDir;
let fixtureId = 0;

before(() => { rootDir = tmpDir('unit-reading-settings'); });
after(() => cleanupTmp(rootDir));

async function localApp(t, db, dir) {
  const upstreamForbidden = async () => { throw new Error('阅读设定测试不允许调用上游'); };
  const app = createApp({
    db,
    chub: { search: upstreamForbidden, character: upstreamForbidden },
    llm: { complete: upstreamForbidden, streamChat: upstreamForbidden },
    avatars: { get: upstreamForbidden },
    config: { publicDir: path.join(dir, 'public'), dataDir: dir, aiKeysFile: '/dev/null' },
  });
  const server = http.createServer(app.handle);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await new Promise((resolve) => server.close(resolve));
    db.close();
  };
  t.after(stop);
  return { db, base, dir, stop };
}

async function fixture(t) {
  const dir = path.join(rootDir, `case-${++fixtureId}`);
  const file = path.join(dir, 'aichat.sqlite');
  const db = openDb(file);
  const ins = db.prepare('INSERT INTO users(username, password_hash, display_name, role, persona_name, persona_desc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run('alice', PASSWORD_HASH, '爱丽丝', 'tenant', '阿狸', '测试人设', CREATED_AT);
  ins.run('bob', PASSWORD_HASH, '鲍勃', 'tenant', '', '', CREATED_AT);
  return { ...await localApp(t, db, dir), file };
}

async function login(base, username = 'alice') {
  const client = new Client(base);
  const response = await client.post('/api/login', { username, password: PASSWORD });
  assert.equal(response.status, 200, response.text);
  return { client, response };
}

function stored(db, id = 1) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  assert.ok(Object.hasOwn(row, 'reading_settings_json'), '数据库应新增阅读设定列');
  return row.reading_settings_json;
}

function replaceStored(db, value, id = 1) {
  stored(db, id);
  db.prepare('UPDATE users SET reading_settings_json = ? WHERE id = ?').run(value, id);
}

// 能捕捉 publicUser 漏掉旧账号默认值，或误把返回对象共享给其他账号的错误。
test('publicUser 对旧账号补齐阅读默认值，每次返回独立对象', () => {
  const oldUser = { id: 9, username: 'old-user', password_hash: PASSWORD_HASH, role: 'tenant' };
  const first = publicUser(oldUser);
  assert.deepEqual(first.reading_settings, DEFAULTS);
  first.reading_settings.font_size = 28;
  assert.deepEqual(publicUser(oldUser).reading_settings, DEFAULTS);
  assert.equal(Object.hasOwn(first, 'password_hash'), false);
  assert.equal(Object.hasOwn(first, 'reading_settings_json'), false);
});

// 能捕捉读库 JSON 未验证即透传、未知字段泄露和任意 CSS 字体进入客户端的错误。
test('publicUser 过滤坏 JSON、非法值及未知字段，保留合法阅读值', () => {
  for (const value of [undefined, '', 'not-json', 'null', '[]', '42', '"serif"']) {
    assert.deepEqual(publicUser({ id: 1, username: 'alice', reading_settings_json: value }).reading_settings, DEFAULTS);
  }
  const value = '{"font_scale":1.1,"font_size":"24","font_family":"url(https://example.invalid/font)","font_weight":700,"line_height":null,"letter_spacing":4,"color":"red","__proto__":{"polluted":true}}';
  const settings = publicUser({ id: 1, username: 'alice', reading_settings_json: value }).reading_settings;
  assert.deepEqual(settings, { font_scale: 1.1, font_size: 16, font_family: 'system', font_weight: 400, line_height: 1.6, letter_spacing: 0 });
  assert.equal(Object.getPrototypeOf(settings), Object.prototype);
  assert.equal(Object.hasOwn(settings, '__proto__'), false);
});

// 能捕捉登录、查询和 PATCH 三个出口给出不同阅读数据，或附带字段丢失的错误。
test('登录、GET 与空 PATCH 一致返回完整默认值及原用户字段', async (t) => {
  const f = await fixture(t);
  const { client, response } = await login(f.base);
  assert.deepEqual(response.json.user.reading_settings, DEFAULTS);
  const me = await client.get('/api/me');
  assert.equal(me.status, 200, me.text);
  assert.deepEqual(me.json.user, response.json.user);
  const patched = await client.patch('/api/me', {});
  assert.equal(patched.status, 200, patched.text);
  assert.deepEqual(patched.json.user, response.json.user);
  assert.equal(patched.json.site_name, me.json.site_name);
  assert.equal(patched.json.user.persona_name, '阿狸');
  assert.equal(patched.json.user.persona_desc, '测试人设');
  assert.equal(patched.json.user.default_model_id, null);
});

// 能捕捉只改进程内状态、只在当前设备可见，或重启后丢失设定的错误。
test('完整阅读设定持久化，另一设备及服务重开后重新登录仍一致', async (t) => {
  const f = await fixture(t);
  const { client } = await login(f.base);
  const patched = await client.patch('/api/me', { reading_settings: CUSTOM });
  assert.equal(patched.status, 200, patched.text);
  assert.deepEqual(patched.json.user.reading_settings, CUSTOM);
  assert.deepEqual((await client.get('/api/me')).json.user.reading_settings, CUSTOM);
  assert.deepEqual(JSON.parse(stored(f.db)), CUSTOM);
  const secondDevice = await login(f.base);
  assert.deepEqual(secondDevice.response.json.user.reading_settings, CUSTOM);
  assert.deepEqual((await secondDevice.client.get('/api/me')).json.user.reading_settings, CUSTOM);
  await f.stop();
  const reopened = await localApp(t, openDb(f.file), f.dir);
  const reLogin = await login(reopened.base);
  assert.deepEqual(reLogin.response.json.user.reading_settings, CUSTOM);
  assert.deepEqual((await reLogin.client.get('/api/me')).json.user.reading_settings, CUSTOM);
});

// 能捕捉部分 PATCH 覆盖整个对象、清空未提交设定的错误。
test('部分 PATCH 合并当前阅读值，空对象不清空，普通资料修改保留阅读值', async (t) => {
  const f = await fixture(t);
  const { client } = await login(f.base);
  assert.equal((await client.patch('/api/me', { reading_settings: CUSTOM })).status, 200);
  const patched = await client.patch('/api/me', { reading_settings: { font_size: 26, font_family: 'mono' } });
  const expected = { font_scale: 1.15, font_size: 26, font_family: 'mono', font_weight: 500, line_height: 1.9, letter_spacing: 0.5 };
  assert.equal(patched.status, 200, patched.text);
  assert.deepEqual(patched.json.user.reading_settings, expected);
  assert.deepEqual((await client.patch('/api/me', { reading_settings: {} })).json.user.reading_settings, expected);
  const other = await client.patch('/api/me', { display_name: '新昵称', persona_name: '新称呼', persona_desc: '新人设', nsfw_enabled: 1, voice_auto_send: true });
  assert.equal(other.status, 200, other.text);
  assert.deepEqual(other.json.user.reading_settings, expected);
  assert.equal(other.json.user.display_name, '新昵称');
  assert.equal(other.json.user.persona_name, '新称呼');
  assert.equal(other.json.user.persona_desc, '新人设');
  assert.equal(other.json.user.nsfw_enabled, 1);
  assert.equal(other.json.user.voice_auto_send, true);
});

// 能捕捉 null 被当成缺失字段、仅清空单项或回传不完整默认值的错误。
test('reading_settings:null 重置全部参数，重新登录得到完整默认值', async (t) => {
  const f = await fixture(t);
  const { client } = await login(f.base);
  await client.patch('/api/me', { reading_settings: CUSTOM });
  const reset = await client.patch('/api/me', { reading_settings: null });
  assert.equal(reset.status, 200, reset.text);
  assert.deepEqual(reset.json.user.reading_settings, DEFAULTS);
  assert.deepEqual((await client.get('/api/me')).json.user.reading_settings, DEFAULTS);
  assert.deepEqual((await login(f.base)).response.json.user.reading_settings, DEFAULTS);
  assert.deepEqual(JSON.parse(stored(f.db)), DEFAULTS);
});

// 能捕捉更新按请求 user_id 操作，或全站共享阅读设定的越权错误。
test('两个账号阅读设定隔离，请求 user_id 无法修改另一个账号', async (t) => {
  const f = await fixture(t);
  const alice = (await login(f.base)).client;
  const bob = (await login(f.base, 'bob')).client;
  const alicePatch = await alice.patch('/api/me', { user_id: 2, reading_settings: { font_size: 24 } });
  assert.equal(alicePatch.status, 200, alicePatch.text);
  assert.deepEqual(alicePatch.json.user.reading_settings, { font_scale: 1, font_size: 24, font_family: 'system', font_weight: 400, line_height: 1.6, letter_spacing: 0 });
  assert.deepEqual((await bob.get('/api/me')).json.user.reading_settings, DEFAULTS);
  const bobPatch = await bob.patch('/api/me', { user_id: 1, reading_settings: { font_family: 'sans', font_weight: 600 } });
  assert.equal(bobPatch.status, 200, bobPatch.text);
  assert.deepEqual((await alice.get('/api/me')).json.user.reading_settings, { font_scale: 1, font_size: 24, font_family: 'system', font_weight: 400, line_height: 1.6, letter_spacing: 0 });
  assert.deepEqual((await bob.get('/api/me')).json.user.reading_settings, { font_scale: 1, font_size: 16, font_family: 'sans', font_weight: 600, line_height: 1.6, letter_spacing: 0 });
});

// 能捕捉旧值损坏导致查询 500、污染前端，或妨碍合法 PATCH 恢复的错误。
test('坏 JSON 查询与登录安全回落，合法部分 PATCH 能恢复存储', async (t) => {
  const f = await fixture(t);
  const { client } = await login(f.base);
  replaceStored(f.db, '{bad-json');
  const me = await client.get('/api/me');
  assert.equal(me.status, 200, me.text);
  assert.deepEqual(me.json.user.reading_settings, DEFAULTS);
  assert.deepEqual((await login(f.base)).response.json.user.reading_settings, DEFAULTS);
  const repaired = await client.patch('/api/me', { reading_settings: { font_size: 20 } });
  assert.equal(repaired.status, 200, repaired.text);
  const expected = { font_scale: 1, font_size: 20, font_family: 'system', font_weight: 400, line_height: 1.6, letter_spacing: 0 };
  assert.deepEqual(repaired.json.user.reading_settings, expected);
  assert.deepEqual(JSON.parse(stored(f.db)), expected);
});

// 能捕捉边界误判和白名单漏掉合法字体 / 字重的错误。
test('合法上下界和字体字重白名单均可保存', async (t) => {
  const f = await fixture(t);
  const { client } = await login(f.base);
  for (const value of [
    { font_scale: 0.85, font_size: 14, font_family: 'system', font_weight: 400, line_height: 1.2, letter_spacing: -0.5 },
    { font_scale: 1.3, font_size: 28, font_family: 'sans', font_weight: 500, line_height: 2.4, letter_spacing: 2 },
    { font_scale: 1, font_size: 16, font_family: 'serif', font_weight: 600, line_height: 1.6, letter_spacing: 0 },
    { font_scale: 1, font_size: 16, font_family: 'mono', font_weight: 400, line_height: 1.6, letter_spacing: 0 },
  ]) {
    const response = await client.patch('/api/me', { reading_settings: value });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.json.user.reading_settings, value);
  }
});

// 能捕捉参数强制转型、未知字段放行、字段逐项写入导致请求部分生效的错误。
test('非法阅读参数返回中文 400，阅读设定及其他用户资料均无部分写入', async (t) => {
  const f = await fixture(t);
  const { client } = await login(f.base);
  await client.patch('/api/me', { reading_settings: CUSTOM });
  const before = f.db.prepare('SELECT * FROM users WHERE id = 1').get().reading_settings_json;
  const badValues = [
    [], 'serif', 1, true,
    { font_scale: 0.84 }, { font_scale: 1.31 }, { font_scale: '1.1' }, { font_scale: null },
    { font_size: 13 }, { font_size: 29 }, { font_size: 16.5 }, { font_size: '18' },
    { font_family: 'Arial' }, { font_family: 'sans-serif' }, { font_family: 'serif; color: red' }, { font_family: ['serif'] },
    { font_weight: 300 }, { font_weight: 700 }, { font_weight: '500' }, { font_weight: 500.1 },
    { line_height: 1.19 }, { line_height: 2.41 }, { line_height: '1.8' }, { line_height: null },
    { letter_spacing: -0.51 }, { letter_spacing: 2.01 }, { letter_spacing: '1' }, { letter_spacing: true },
    { font_size: 24, unknown: 'no' }, JSON.parse('{"font_size":24,"__proto__":{"polluted":true}}'),
    { font_size: 24, font_weight: 700 },
  ];
  for (const value of badValues) {
    const response = await client.patch('/api/me', { display_name: '不能生效', persona_desc: '不能生效', reading_settings: value });
    assert.equal(response.status, 400, JSON.stringify(value) + ': ' + response.text);
    assert.match(response.json.error, /\p{Script=Han}/u);
    assert.equal(stored(f.db), before);
    const row = f.db.prepare('SELECT display_name, persona_desc FROM users WHERE id = 1').get();
    assert.equal(row.display_name, '爱丽丝');
    assert.equal(row.persona_desc, '测试人设');
  }
  assert.deepEqual((await client.get('/api/me')).json.user.reading_settings, CUSTOM);
});

// 能捕捉 JSON 指数溢出后 Infinity 被范围校验放行的错误。
test('JSON 数字溢出被拒绝，不保存非有限阅读参数', async (t) => {
  const f = await fixture(t);
  const { client } = await login(f.base);
  await client.patch('/api/me', { reading_settings: CUSTOM });
  const before = f.db.prepare('SELECT * FROM users WHERE id = 1').get().reading_settings_json;
  for (const key of ['font_scale', 'line_height', 'letter_spacing']) {
    const response = await fetch(f.base + '/api/me', {
      method: 'PATCH', headers: { cookie: client.cookie, 'content-type': 'application/json' },
      body: `{"reading_settings":{"font_size":24,"${key}":1e400}}`,
    });
    assert.equal(response.status, 400, await response.text());
    assert.equal(stored(f.db), before);
  }
});

// 能捕捉匿名 PATCH 被误开放，或匿名 GET 原契约被破坏的错误。
test('未登录 PATCH 拒绝，未登录 GET 保留 user:null 契约', async (t) => {
  const f = await fixture(t);
  const anonymous = new Client(f.base);
  const patch = await anonymous.patch('/api/me', { user_id: 1, reading_settings: { font_size: 24 } });
  assert.equal(patch.status, 401, patch.text);
  assert.match(patch.json.error, /\p{Script=Han}/u);
  const me = await anonymous.get('/api/me');
  assert.equal(me.status, 200, me.text);
  assert.equal(me.json.user, null);
});

// 能捕捉迁移漏列、回填覆盖旧资料 / 密码 / 会话，以及再次打开重复迁移的错误。
test('v11 升级只添加阅读列，旧账号密码角色会话消息保留且再次打开幂等', () => {
  const file = path.join(rootDir, 'migration-v11', 'aichat.sqlite');
  let db = openDb(file, { upTo: 11 });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
  db.prepare('INSERT INTO users(username, password_hash, display_name, is_admin, role, persona_name, voice_auto_send, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('legacy', PASSWORD_HASH, '旧账号', 1, 'super', '旧称呼', 1, CREATED_AT);
  createSession(db, 1);
  db.prepare('INSERT INTO characters(chub_path, name, fetched_at) VALUES (?, ?, ?)').run('legacy/card', '旧角色', CREATED_AT);
  db.prepare('INSERT INTO chats(user_id, character_id, title, created_at, updated_at) VALUES (1, 1, ?, ?, ?)').run('旧会话', CREATED_AT, CREATED_AT);
  db.prepare("INSERT INTO messages(chat_id, role, content, created_at) VALUES (1, 'assistant', ?, ?)").run('旧消息', CREATED_AT);
  const snapshot = (table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row }));
  const before = Object.fromEntries(['users', 'sessions', 'characters', 'chats', 'messages'].map((table) => [table, snapshot(table)]));
  db.close();
  db = openDb(file);
  try {
    const column = db.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'reading_settings_json');
    assert.ok(column, 'v12 必须给旧库加阅读设定列');
    assert.equal(column.type, 'TEXT');
    assert.equal(column.notnull, 1);
    assert.equal(column.dflt_value, "'{}'");
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
    for (const table of ['users', 'sessions', 'characters', 'chats', 'messages']) {
      const rows = snapshot(table);
      if (table === 'users') for (const row of rows) { assert.equal(row.reading_settings_json, '{}'); delete row.reading_settings_json; }
      assert.deepEqual(rows, before[table], table);
    }
    assert.deepEqual(publicUser(db.prepare('SELECT * FROM users WHERE id = 1').get()).reading_settings, DEFAULTS);
    db.prepare('UPDATE users SET reading_settings_json = ? WHERE id = 1').run(JSON.stringify(CUSTOM));
    const migrated = Object.fromEntries(['users', 'sessions', 'characters', 'chats', 'messages'].map((table) => [table, snapshot(table)]));
    db.close();
    db = openDb(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
    for (const table of ['users', 'sessions', 'characters', 'chats', 'messages']) assert.deepEqual(snapshot(table), migrated[table], table);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
