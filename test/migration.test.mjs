// 迁移：v0.1（user_version = 1）/ v0.2（user_version = 2）结构的库升级到最新（v3 三层权限），旧数据一条不丢、新列按规则回填、重复打开幂等。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDb, getSettings, SCHEMA_VERSION } from '../server/db.mjs';
import { createModelService, seedModels } from '../server/models.mjs';
import { tmpDir, cleanupTmp } from './helpers.mjs';

// v0.1 线上库的建表语句（原样照抄 v0.1 的 MIGRATIONS[0]）
const V01_SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '', is_admin INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, nsfw_enabled INTEGER NOT NULL DEFAULT 0,
    persona_name TEXT NOT NULL DEFAULT '', persona_desc TEXT NOT NULL DEFAULT '', daily_limit INTEGER NULL, created_at TEXT NOT NULL, last_login_at TEXT NULL);
  CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE INDEX idx_sessions_user ON sessions(user_id);
  CREATE TABLE characters (id INTEGER PRIMARY KEY AUTOINCREMENT, chub_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', tagline TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '', tags_json TEXT NOT NULL DEFAULT '[]', nsfw INTEGER NOT NULL DEFAULT 0, card_json TEXT NOT NULL DEFAULT '{}', greeting_zh TEXT NULL, fetched_at TEXT NOT NULL);
  CREATE TABLE shelves (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE shelf_items (shelf_id INTEGER NOT NULL REFERENCES shelves(id) ON DELETE CASCADE, character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    sort INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (shelf_id, character_id));
  CREATE TABLE chats (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, character_id INTEGER NOT NULL REFERENCES characters(id),
    title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX idx_chats_user ON chats(user_id, updated_at);
  CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')), content TEXT NOT NULL, created_at TEXT NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, model TEXT NULL);
  CREATE INDEX idx_messages_chat ON messages(chat_id, id);
  CREATE TABLE usage_daily (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, messages INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  PRAGMA user_version = 1;
`;

let dir;
before(() => { dir = tmpDir('unit-migrate'); });
after(() => cleanupTmp(dir));

function makeV01(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(V01_SCHEMA);
  const t = '2026-10-01T00:00:00.000Z';
  db.prepare("INSERT INTO users(username, password_hash, display_name, is_admin, nsfw_enabled, persona_name, daily_limit, created_at) VALUES ('admin','h1','管理员',1,1,'阿管',NULL,?)").run(t);
  db.prepare("INSERT INTO users(username, password_hash, display_name, created_at) VALUES ('amy','h2','艾米',?)").run(t);
  db.prepare("INSERT INTO sessions VALUES ('tok', 2, ?, 9999999999999)").run(t);
  db.prepare("INSERT INTO characters(chub_path, name, card_json, greeting_zh, fetched_at) VALUES ('a/b','角色','{\"first_message\":\"hi\"}','你好',?)").run(t);
  db.prepare("INSERT INTO shelves(title, sort, created_at) VALUES ('推荐', 1, ?)").run(t);
  db.prepare('INSERT INTO shelf_items VALUES (1, 1, 1)').run();
  db.prepare("INSERT INTO chats(user_id, character_id, title, created_at, updated_at) VALUES (2, 1, '角色', ?, ?)").run(t, t);
  db.prepare("INSERT INTO messages(chat_id, role, content, created_at) VALUES (1, 'assistant', '你好', ?)").run(t);
  db.prepare("INSERT INTO messages(chat_id, role, content, created_at, tokens_in, tokens_out, model) VALUES (1, 'user', '嗨', ?, 0, 0, NULL)").run(t);
  db.prepare("INSERT INTO messages(chat_id, role, content, created_at, tokens_in, tokens_out, model) VALUES (1, 'assistant', '回复', ?, 12, 34, 'deepseek-flash')").run(t);
  db.prepare("INSERT INTO usage_daily VALUES (2, '2026-10-01', 1, 12, 34)").run();
  for (const [k, v] of [['site_name', '我的站'], ['default_daily_limit', '50'], ['allow_user_chub_search', '0']]) db.prepare('INSERT INTO settings VALUES (?, ?)').run(k, v);
  db.close();
}

const snapshotRaw = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((r) => ({ ...r }));
// 升级后的库：v6 新列（软删除 / 自建卡）必须全为空，然后去掉再与旧快照比较。
const snapshot = (db, table) => {
  const rows = snapshotRaw(db, table);
  for (const r of rows) for (const c of V6_COLS_ALL[table] || []) if (c in r) assert.equal(r[c], null, `${table}.${c} 应为空`);
  // v7（契约 §13）：旧账号 note / invite_code_id 为空、must_change_password = 0（迁移不动旧账号）。
  for (const r of rows) for (const [c, v] of Object.entries(V7_COLS[table] || {})) if (c in r) assert.equal(r[c], v, `${table}.${c} 应为 ${v}`);
  return rows.map((r) => { const o = { ...r }; for (const c of [...(V6_COLS_ALL[table] || []), ...Object.keys(V7_COLS[table] || {})]) delete o[c]; return o; });
};
const V7_COLS = { users: { note: null, invite_code_id: null, must_change_password: 0, voice_auto_send: 0, reading_settings_json: '{}' }, chats: { kind: 'character' } }; // v10（§17 / §18）：users.voice_auto_send=0、旧会话 kind=character；v12：reading_settings_json='{}'
// v9（契约 §19 / §20）新增的列也一并要求为空并去掉：角色翻译缓存、本会话设定覆盖。
const V9_CHAR_COLS = ['card_json_zh', 'name_zh', 'tagline_zh', 'tags_zh_json', 'translated_at', 'translate_status', 'translate_hash', 'glossary_json']; // v11 加 glossary_json（契约 §19.3）
const V6_COLS_ALL = { users: ['deleted_at'], chats: ['user_card_id', 'deleted_at', 'card_override_json', 'persona_override_json'], messages: ['deleted_at', 'deleted_reason'], characters: V9_CHAR_COLS };
// v4（契约 §10）新增的列：比较「旧数据不丢」时去掉。
const V4_COLS = {
  models: ['proxy_url', 'currency', 'price_in', 'price_in_cached', 'price_out'],
  messages: ['tokens_in_cached', 'tokens_reasoning', 'cost_usd', 'cost_source'],
  usage_daily: ['cost_usd'],
};
// v6（契约 §12）新增的列：软删除与自建卡会话。比较「旧数据不丢」时也去掉（单独断言它们为空）。
const V6_COLS = { users: ['deleted_at'], chats: ['user_card_id', 'deleted_at'], messages: ['deleted_at', 'deleted_reason'] };
const strip6 = (table, rows) => rows.map((r) => { const o = { ...r }; for (const c of V6_COLS[table] || []) delete o[c]; return o; });
const strip4 = (table, rows) => strip6(table, rows).map((r) => { const o = { ...r }; for (const c of V4_COLS[table] || []) delete o[c]; return o; });
const snap3 = (db, table) => strip4(table, snapshot(db, table));

test('v0.1 库升级到最新：旧数据不丢，新列为空，models 表就位，角色按规则推出', () => {
  const d = path.join(dir, 'up'); mkdirSync(d, { recursive: true });
  const file = path.join(d, 'aichat.sqlite');
  makeV01(file);
  const raw = new DatabaseSync(file);
  const before = {};
  for (const t of ['users', 'sessions', 'characters', 'shelves', 'shelf_items', 'chats', 'messages', 'usage_daily', 'settings']) before[t] = snapshot(raw, t);
  raw.close();

  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  for (const t of ['sessions', 'characters', 'shelves', 'shelf_items', 'messages', 'usage_daily']) assert.deepEqual(snap3(db, t), before[t], t);
  const users = snapshot(db, 'users');
  assert.deepEqual(users.map(({ default_model_id, role, created_by, ...rest }) => rest), before.users);
  assert.ok(users.every((u) => u.default_model_id === null));
  assert.deepEqual(users.map((u) => [u.username, u.role, u.created_by]), [['admin', 'super', null], ['amy', 'tenant', 1]]);
  const chats = snapshot(db, 'chats');
  assert.deepEqual(chats.map(({ model_id, ...rest }) => rest), before.chats);
  assert.ok(chats.every((c) => c.model_id === null));
  const s = getSettings(db);
  assert.equal(s.site_name, '我的站');
  assert.equal(s.default_daily_limit, 50);
  assert.equal(s.allow_user_chub_search, 0);
  assert.equal(s.default_model_id, null);
  assert.deepEqual(db.prepare('PRAGMA table_info(models)').all().map((c) => c.name),
    ['id', 'name', 'provider', 'base_url', 'api_key_env', 'api_key_enc', 'model', 'enabled', 'sort', 'extra_json', 'created_at', ...V4_COLS.models]);

  // 预置后，旧会话（model_id 为空）解析到全站默认
  const kf = path.join(d, 'keys.env');
  writeFileSync(kf, 'DEEPSEEK_API_KEY=sk-test-only\n');
  const seeded = seedModels(db, { keysFile: kf });
  assert.equal(seeded.length, 2);
  const svc = createModelService({ db, keysFile: kf });
  const chat = db.prepare('SELECT * FROM chats WHERE id = 1').get();
  const user = db.prepare('SELECT * FROM users WHERE id = 2').get();
  assert.equal(svc.forChat(chat, user).model, 'deepseek-flash');
  db.close();

  // 再打开：幂等，不重复迁移、不重复预置
  const again = openDb(file);
  assert.equal(again.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM models').get().n, 2);
  assert.deepEqual(seedModels(again, { keysFile: kf }), []);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 3);
  again.close();
});

test('全新库直接到最新版本', () => {
  const d = path.join(dir, 'fresh'); mkdirSync(d, { recursive: true });
  const db = openDb(path.join(d, 'aichat.sqlite'));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.ok(db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'default_model_id'));
  assert.ok(db.prepare('PRAGMA table_info(chats)').all().some((c) => c.name === 'model_id'));
  const cols = db.prepare('PRAGMA table_info(users)').all();
  const role = cols.find((c) => c.name === 'role');
  assert.equal(role.notnull, 1);
  assert.equal(role.dflt_value, "'tenant'");
  assert.ok(cols.some((c) => c.name === 'created_by'));
  db.close();
});

// ---- v0.2（user_version = 2）带数据的库 → v3 三层权限 ----
const V02_EXTRA = `
  CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, provider TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL,
    api_key_env TEXT NULL, api_key_enc TEXT NULL, model TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, extra_json TEXT NULL, created_at TEXT NOT NULL);
  ALTER TABLE users ADD COLUMN default_model_id INTEGER NULL;
  ALTER TABLE chats ADD COLUMN model_id INTEGER NULL;
  PRAGMA user_version = 2;
`;

const ALL_TABLES = ['users', 'sessions', 'characters', 'shelves', 'shelf_items', 'chats', 'messages', 'usage_daily', 'settings', 'models'];

function makeV02(file, users) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(V01_SCHEMA.replace('PRAGMA user_version = 1;', ''));
  db.exec(V02_EXTRA);
  const t = '2026-10-01T00:00:00.000Z';
  const ins = db.prepare('INSERT INTO users(username, password_hash, display_name, is_admin, disabled, nsfw_enabled, daily_limit, default_model_id, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const u of users) ins.run(u.username, `h-${u.username}`, u.display || u.username, u.is_admin ? 1 : 0, u.disabled ? 1 : 0, u.nsfw ? 1 : 0, u.limit ?? null, u.model ?? null, t, u.login ?? null);
  db.prepare("INSERT INTO models(name, provider, base_url, api_key_env, model, enabled, sort, extra_json, created_at) VALUES ('DeepSeek 快速', 'DeepSeek', 'https://api.deepseek.com', 'DEEPSEEK_API_KEY', 'deepseek-flash', 1, 1, '{}', ?)").run(t);
  db.prepare("INSERT INTO characters(chub_path, name, card_json, greeting_zh, fetched_at) VALUES ('a/b','角色','{}','你好',?)").run(t);
  db.prepare("INSERT INTO shelves(title, sort, created_at) VALUES ('推荐', 1, ?)").run(t);
  db.prepare('INSERT INTO shelf_items VALUES (1, 1, 1)').run();
  const n = users.length;
  for (let uid = 1; uid <= n; uid++) {
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, 9999999999999)").run(`tok-${uid}`, uid, t);
    db.prepare("INSERT INTO chats(user_id, character_id, title, model_id, created_at, updated_at) VALUES (?, 1, '角色', 1, ?, ?)").run(uid, t, t);
    db.prepare("INSERT INTO messages(chat_id, role, content, created_at) VALUES (?, 'user', ?, ?)").run(uid, `来自 ${uid} 的消息`, t);
    db.prepare("INSERT INTO messages(chat_id, role, content, created_at, tokens_in, tokens_out, model) VALUES (?, 'assistant', '回复', ?, 3, 4, 'deepseek-flash')").run(uid, t);
    db.prepare("INSERT INTO usage_daily VALUES (?, '2026-10-01', 1, 3, 4)").run(uid);
  }
  for (const [k, v] of [['site_name', '我的站'], ['default_daily_limit', '20'], ['allow_user_chub_search', '1'], ['default_model_id', '1'], ['models_seeded', '1']]) db.prepare('INSERT INTO settings VALUES (?, ?)').run(k, v);
  db.close();
}

function migrateV02(name, users) {
  const d = path.join(dir, name); mkdirSync(d, { recursive: true });
  const file = path.join(d, 'aichat.sqlite');
  makeV02(file, users);
  const raw = new DatabaseSync(file);
  const before = {};
  for (const t of ALL_TABLES) before[t] = snapshot(raw, t);
  raw.close();
  const db = openDb(file);
  return { db, before, file };
}

test('v0.2 库升级到 v3：admin → super，其他管理员 → admin，其余 → tenant；created_by 回填；数据一条不丢', () => {
  const { db, before, file } = migrateV02('v2', [
    { username: 'ops', is_admin: 1, display: '运营' }, // id 1：旧管理员，但不叫 admin
    { username: 'admin', is_admin: 1, nsfw: 1 }, // id 2：叫 admin → super
    { username: 'amy', limit: 5, model: 1, login: '2026-10-01T01:00:00.000Z' }, // id 3
    { username: 'Ben', disabled: 1 }, // id 4
    { username: 'ops2', is_admin: 1, disabled: 1 }, // id 5
  ]);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  for (const t of ALL_TABLES.filter((x) => x !== 'users' && x !== 'settings')) assert.deepEqual(snap3(db, t), before[t], `${t} 不变`);
  assert.deepEqual(snapshot(db, 'settings').filter((r) => r.key !== 'cny_to_usd' && r.key !== 'log_retention_days'), before.settings, 'settings 旧值不变（只多 cny_to_usd / log_retention_days 默认值）');
  const users = snapshot(db, 'users');
  assert.equal(users.length, before.users.length);
  // 除新增两列外，每一列都与迁移前一致（is_admin 本来就与角色相符）
  assert.deepEqual(users.map(({ role, created_by, ...rest }) => rest), before.users);
  assert.deepEqual(users.map((u) => [u.username, u.role, u.created_by]), [
    ['ops', 'admin', 2], ['admin', 'super', null], ['amy', 'tenant', 2], ['Ben', 'tenant', 2], ['ops2', 'admin', 2],
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 10);
  db.close();

  // 再打开：幂等
  const again = openDb(file);
  assert.equal(again.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.deepEqual(snapshot(again, 'users'), users);
  again.close();
});

test('v0.2 库没有叫 admin 的账号：最早的启用管理员升为 super，保证至少一个 super', () => {
  const { db } = migrateV02('v2-noadmin', [
    { username: 'amy' }, // 1
    { username: 'old', is_admin: 1, disabled: 1 }, // 2：停用的管理员，不优先
    { username: 'boss', is_admin: 1 }, // 3：最早的启用管理员 → super
    { username: 'ops', is_admin: 1 }, // 4
  ]);
  const users = snapshot(db, 'users');
  assert.deepEqual(users.map((u) => [u.username, u.role, u.created_by]), [
    ['amy', 'tenant', 3], ['old', 'admin', 3], ['boss', 'super', null], ['ops', 'admin', 3],
  ]);
  assert.deepEqual(users.map((u) => u.is_admin), [0, 1, 1, 1]);
  db.close();
});

test('v0.2 库一个管理员都没有：全部 tenant，created_by 为空，不报错', () => {
  const { db } = migrateV02('v2-none', [{ username: 'amy' }, { username: 'bob' }]);
  assert.deepEqual(snapshot(db, 'users').map((u) => [u.role, u.created_by]), [['tenant', null], ['tenant', null]]);
  db.close();
});

test('迁移失败整体回滚：库停在 v2，数据不变', () => {
  const d = path.join(dir, 'v2-fail'); mkdirSync(d, { recursive: true });
  const file = path.join(d, 'aichat.sqlite');
  makeV02(file, [{ username: 'admin', is_admin: 1 }, { username: 'amy' }]);
  // 人为制造冲突：role 列已存在 → v3 的 ALTER 会失败
  const raw = new DatabaseSync(file);
  raw.exec("ALTER TABLE users ADD COLUMN role TEXT");
  const before = snapshot(raw, 'users');
  raw.close();
  assert.throws(() => openDb(file));
  const after = new DatabaseSync(file);
  assert.equal(after.prepare('PRAGMA user_version').get().user_version, 2);
  assert.deepEqual(snapshot(after, 'users'), before);
  assert.ok(!after.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'created_by'));
  after.close();
});

test('v0.2 里叫 admin 的账号已被停用：不升 super，改由最早的启用管理员当 super，保证有启用的 super', () => {
  const { db } = migrateV02('v2-admin-disabled', [
    { username: 'admin', is_admin: 1, disabled: 1 }, // 1
    { username: 'ops', is_admin: 1 }, // 2 → super
    { username: 't1' }, // 3
  ]);
  assert.deepEqual(snapshot(db, 'users').map((u) => [u.username, u.role, u.disabled, u.created_by]), [
    ['admin', 'admin', 1, 2], ['ops', 'super', 0, null], ['t1', 'tenant', 0, 2],
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'super' AND disabled = 0").get().n, 1);
  db.close();
});

test('v0.2 里叫 admin 的账号已被降成普通用户：仍是 tenant，真正的管理员升 super', () => {
  const { db } = migrateV02('v2-admin-demoted', [
    { username: 'root', is_admin: 1 }, // 1 → super
    { username: 'admin' }, // 2：is_admin=0 → tenant
    { username: 't1' }, // 3
  ]);
  const users = snapshot(db, 'users');
  assert.deepEqual(users.map((u) => [u.username, u.role, u.created_by]), [['root', 'super', null], ['admin', 'tenant', 1], ['t1', 'tenant', 1]]);
  assert.deepEqual(users.map((u) => u.is_admin), [1, 0, 0]);
  db.close();
});

test('v0.2 里管理员全部停用：不产生停用的 super，留给启动时的 ADMIN_BOOTSTRAP_PASSWORD 处理', () => {
  const { db } = migrateV02('v2-all-disabled', [{ username: 'admin', is_admin: 1, disabled: 1 }, { username: 't1' }]);
  assert.deepEqual(snapshot(db, 'users').map((u) => [u.username, u.role, u.created_by]), [['admin', 'admin', null], ['t1', 'tenant', null]]);
  db.close();
});

// ---- v3（user_version = 3，v0.3 线上结构）带数据的库 → v4（契约 §10 出站代理 + 计费）----
const V03_EXTRA = `
  ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'tenant';
  ALTER TABLE users ADD COLUMN created_by INTEGER NULL;
  CREATE INDEX IF NOT EXISTS idx_users_created_by ON users(created_by);
  CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at);
  PRAGMA user_version = 3;
`;

function makeV03(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(V01_SCHEMA.replace('PRAGMA user_version = 1;', ''));
  db.exec(V02_EXTRA.replace('PRAGMA user_version = 2;', ''));
  db.exec(V03_EXTRA);
  const t = '2026-09-30T20:00:00.000Z'; // 新加坡 2026-10-01 04:00
  db.prepare("INSERT INTO users(username, password_hash, display_name, is_admin, role, created_at) VALUES ('admin','h','超管',1,'super',?)").run(t);
  db.prepare("INSERT INTO users(username, password_hash, display_name, role, created_by, created_at) VALUES ('amy','h','艾米','tenant',1,?)").run(t);
  const addModel = db.prepare('INSERT INTO models(id, name, provider, base_url, api_key_env, api_key_enc, model, enabled, sort, extra_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  addModel.run(1, 'DeepSeek 快速', 'DeepSeek', 'https://api.deepseek.com', 'DEEPSEEK_API_KEY', null, 'deepseek-flash', 1, 1, '{"thinking":{"type":"disabled"}}', t);
  addModel.run(7, '自定义', '某家', 'https://api.other.example.com/v1', null, 'v1.enc', 'mystery-1', 1, 2, null, t);
  addModel.run(8, 'Grok 快速', 'xAI', 'https://api.x.ai/v1', null, 'v1.enc8', 'grok-4.20-0309-non-reasoning', 0, 3, null, t);
  addModel.run(9, 'Grok 4.7', 'xAI', 'https://API.X.AI/v1/', null, 'v1.enc9', 'grok-4.7', 0, 4, null, t);
  db.prepare("INSERT INTO characters(chub_path, name, card_json, greeting_zh, fetched_at) VALUES ('a/b','角色','{}','你好',?)").run(t);
  const chat = db.prepare("INSERT INTO chats(user_id, character_id, title, model_id, created_at, updated_at) VALUES (2, 1, '角色', ?, ?, ?)");
  chat.run(1, t, t); // chat 1：DeepSeek
  chat.run(9, t, t); // chat 2：Grok 4.7
  chat.run(7, t, t); // chat 3：没有单价的模型
  const msg = db.prepare('INSERT INTO messages(chat_id, role, content, created_at, tokens_in, tokens_out, model) VALUES (?, ?, ?, ?, ?, ?, ?)');
  msg.run(1, 'assistant', '开场白', t, 0, 0, null);
  msg.run(1, 'user', '你好', t, 0, 0, null);
  msg.run(1, 'assistant', '回复一', t, 1000, 200, 'deepseek-flash');
  msg.run(2, 'assistant', '回复二', t, 500, 100, 'grok-4.7');
  msg.run(2, 'assistant', '被停止且没 usage', t, 0, 0, 'grok-4.7');
  msg.run(3, 'assistant', '回复三', t, 300, 30, 'mystery-1');
  // 10-01 比现存消息多 1000 输入 / 100 输出（回复被删除 / 重新生成）；10-03（周六）消息全没了。
  db.prepare("INSERT INTO usage_daily VALUES (2, '2026-10-01', 5, 2800, 430)").run();
  db.prepare("INSERT INTO usage_daily VALUES (2, '2026-10-03', 1, 1000, 100)").run();
  for (const [k, v] of [['site_name', '我的站'], ['default_model_id', '1'], ['models_seeded', '1']]) db.prepare('INSERT INTO settings VALUES (?, ?)').run(k, v);
  db.close();
}

test('v3 带数据库升级到 v4：xAI 行自动设代理（不改启用）、预置单价、旧消息费用回填、用量花费回填；旧数据不丢；幂等', () => {
  const d = path.join(dir, 'v3'); mkdirSync(d, { recursive: true });
  const file = path.join(d, 'aichat.sqlite');
  makeV03(file);
  const raw = new DatabaseSync(file);
  const before = {};
  for (const t of ALL_TABLES) before[t] = snapshot(raw, t);
  raw.close();

  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  for (const t of ['users', 'sessions', 'characters', 'shelves', 'shelf_items', 'chats']) assert.deepEqual(snapshot(db, t), before[t], `${t} 不变`);
  for (const t of ['models', 'messages', 'usage_daily']) assert.deepEqual(snap3(db, t), before[t], `${t} 旧列不变`);

  const models = new Map(snapshot(db, 'models').map((m) => [m.id, m]));
  // 1. 代理：只给 api.x.ai 的行；enabled 不动
  assert.deepEqual([1, 7, 8, 9].map((id) => [models.get(id).proxy_url, models.get(id).enabled]),
    [[null, 1], [null, 1], ['http://127.0.0.1:42001', 0], ['http://127.0.0.1:42001', 0]]);
  // 2. 单价：预置表里有的填上（币种一起），没有的留空
  const price = (id) => { const m = models.get(id); return [m.currency, m.price_in, m.price_in_cached, m.price_out]; };
  assert.deepEqual(price(1), ['CNY', 2, 0.04, 8]);
  assert.deepEqual(price(7), ['USD', null, null, null]);
  assert.deepEqual(price(8), ['USD', 1.25, 0.2, 2.5]);
  assert.deepEqual(price(9), ['USD', 2, 0.5, 6]);
  // 3. 旧消息回填（按当前单价，缓存命中数未知按全未命中算），标 estimate；DeepSeek 按消息时刻分时（北京 10-01 周四 04:00 = 空闲半价）
  const msgs = snapshot(db, 'messages');
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≉ ${b}`);
  const ds = ((1000 * 2 + 200 * 8) / 1e6) * 0.14 * 0.5;
  const gk = (500 * 2 + 100 * 6) / 1e6;
  assert.deepEqual(msgs.map((m) => m.cost_source), [null, null, 'estimate', 'estimate', null, null]);
  near(msgs[2].cost_usd, ds);
  near(msgs[3].cost_usd, gk);
  assert.equal(msgs[4].cost_usd, null, '没有 token 数的不回填');
  assert.equal(msgs[5].cost_usd, null, '模型没单价的不回填');
  assert.ok(msgs.every((m) => m.tokens_in_cached === null && m.tokens_reasoning === null));
  // 4. 用量花费：按消息的新加坡日期累加；usage_daily 里多出来的 token（已删除的回复）按当天用得最多的有价模型补算，
  //    时刻取当天 10:00（10-01 周四但是国庆法定节假日 → DeepSeek 空闲价）；当天没有消息的（10-03 周六）用全站默认模型、空闲价。
  const ud = snapshot(db, 'usage_daily');
  near(ud[0].cost_usd, ds + gk + ((1000 * 2 + 100 * 8) / 1e6) * 0.14 * 0.5);
  near(ud[1].cost_usd, ((1000 * 2 + 100 * 8) / 1e6) * 0.14 * 0.5);
  // 5. 新表与默认汇率
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'system_costs'").get());
  assert.equal(getSettings(db).cny_to_usd, 0.14);
  const after1 = { models: snapshot(db, 'models'), messages: msgs, usage: snapshot(db, 'usage_daily') };
  db.close();

  // 再打开：幂等（不重复回填、不重复累加）
  const again = openDb(file);
  assert.equal(again.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.deepEqual(snapshot(again, 'models'), after1.models);
  assert.deepEqual(snapshot(again, 'messages'), after1.messages);
  assert.deepEqual(snapshot(again, 'usage_daily'), after1.usage);
  again.close();
});

test('v4 迁移失败整体回滚：库停在 v3，数据不变', () => {
  const d = path.join(dir, 'v3-fail'); mkdirSync(d, { recursive: true });
  const file = path.join(d, 'aichat.sqlite');
  makeV03(file);
  const raw = new DatabaseSync(file);
  raw.exec('ALTER TABLE messages ADD COLUMN cost_usd REAL'); // 人为冲突
  const before = snapshot(raw, 'models');
  raw.close();
  assert.throws(() => openDb(file));
  const after = new DatabaseSync(file);
  assert.equal(after.prepare('PRAGMA user_version').get().user_version, 3);
  assert.deepEqual(snapshot(after, 'models'), before);
  assert.ok(!after.prepare('PRAGMA table_info(models)').all().some((c) => c.name === 'proxy_url'));
  after.close();
});

test('全新库预置：xAI 预置走 42001 代理并带单价；DeepSeek 预置带人民币单价', () => {
  const d = path.join(dir, 'fresh-v4'); mkdirSync(d, { recursive: true });
  const db = openDb(path.join(d, 'aichat.sqlite'));
  const kf = path.join(d, 'keys.env');
  writeFileSync(kf, 'DEEPSEEK_API_KEY=sk-test-only\nexport XAI_API_KEY="xai-test-only"\n');
  const seeded = seedModels(db, { keysFile: kf });
  assert.deepEqual(seeded.map((m) => [m.name, m.enabled]), [['DeepSeek 快速', 1], ['DeepSeek 专业', 1], ['Grok 快速', 1]]);
  const rows = db.prepare('SELECT * FROM models ORDER BY sort').all();
  const g = rows.find((r) => r.name === 'Grok 快速');
  assert.deepEqual([g.base_url, g.model, g.api_key_env, g.proxy_url, g.currency, g.price_in, g.price_in_cached, g.price_out],
    ['https://api.x.ai/v1', 'grok-4.20-0309-non-reasoning', 'XAI_API_KEY', 'http://127.0.0.1:42001', 'USD', 1.25, 0.2, 2.5]);
  assert.deepEqual([rows[1].currency, rows[1].price_in, rows[1].price_in_cached, rows[1].price_out], ['CNY', 9, 0.3, 27]);
  assert.equal(rows[0].proxy_url, null);
  db.close();
});
