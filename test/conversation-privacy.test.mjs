// 发布版隐私边界：旧会话审查与录音取证接口不存在；所有角色只能访问自己的会话。
// 临时数据库、随机回环端口、假模型与假 ASR；无需个人配置或外网凭据。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { openDb, SCHEMA_VERSION } from '../server/db.mjs';
import { hashPassword } from '../server/auth.mjs';
import { createApp } from '../server/app.mjs';
import { createClipStore } from '../server/voice.mjs';
import { nowIso } from '../server/util.mjs';
import { Client, parseSse } from './helpers.mjs';

let dir, db, app, server, base, freshHasHistory;
const users = {};
const fixtures = {};
const clients = {};
const audio = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(256, 7)]);
const secrets = ['隐私正文标记', '编辑前隐私标记', '已删隐私标记', '私密全文标记', '私密设定标记', '未发送识别标记'];

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aichat-privacy-'));
  db = openDb(path.join(dir, 'test.sqlite'));
  freshHasHistory = !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_edits'").get();
  // 模拟旧部署遗留的历史表：升级不能删除已有数据，也不能继续写入旧正文。
  db.exec('CREATE TABLE IF NOT EXISTS message_edits (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES messages(id), old_content TEXT NOT NULL, edited_at TEXT NOT NULL)');
  const at = nowIso();
  const hash = hashPassword('offline-test-pass');
  const model = Number(db.prepare("INSERT INTO models(name, provider, base_url, model, enabled, created_at) VALUES ('离线模型', '测试', 'http://127.0.0.1:1', 'offline', 1, ?)").run(at).lastInsertRowid);
  db.prepare("UPDATE settings SET value = ? WHERE key = 'default_model_id'").run(String(model));
  for (const [name, role] of [['super', 'super'], ['admin', 'admin'], ['owner', 'tenant'], ['other', 'tenant']]) {
    users[name] = Number(db.prepare('INSERT INTO users(username, password_hash, role, is_admin, created_at) VALUES (?, ?, ?, ?, ?)').run(name, hash, role, role === 'tenant' ? 0 : 1, at).lastInsertRowid);
    const chat = Number(db.prepare("INSERT INTO chats(user_id, kind, title, model_id, card_override_json, created_at, updated_at) VALUES (?, 'file', ?, ?, ?, ?, ?)").run(users[name], `个人文件-${name}`, model, JSON.stringify({ instruction: secrets[4] }), at, at).lastInsertRowid);
    db.prepare('INSERT INTO chat_files(chat_id, files_json, instruction, text, total_chars, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(chat, JSON.stringify([{ name: '个人资料.txt', ok: true }]), '离线文件说明', secrets[3], secrets[3].length, at);
    const message = Number(db.prepare("INSERT INTO messages(chat_id, role, content, created_at) VALUES (?, 'user', ?, ?)").run(chat, secrets[0], at).lastInsertRowid);
    db.prepare('INSERT INTO message_edits(message_id, old_content, edited_at) VALUES (?, ?, ?)').run(message, secrets[1], at);
    db.prepare("INSERT INTO messages(chat_id, role, content, created_at, deleted_at, deleted_reason) VALUES (?, 'assistant', ?, ?, ?, 'user_delete')").run(chat, secrets[2], at, at);
    fixtures[name] = { chat, message };
  }
  const clips = createClipStore(path.join(dir, 'voice'));
  fixtures.owner.clips = [];
  for (const sent of [true, false]) {
    const file = await clips.save(users.owner, audio, 'webm');
    const id = Number(db.prepare("INSERT INTO voice_clips(user_id, chat_id, message_id, file, mime, bytes, raw_text, created_at) VALUES (?, ?, ?, ?, 'audio/webm', ?, ?, ?)").run(users.owner, fixtures.owner.chat, sent ? fixtures.owner.message : null, file, audio.length, secrets[5], at).lastInsertRowid);
    fixtures.owner.clips.push(id);
  }
  app = createApp({ db, chub: {}, avatars: {}, config: { dataDir: dir, publicDir: path.join(dir, 'public') },
    llm: {
      async streamChat(_messages, { onDelta }) { onDelta('离线回复'); return { text: '离线回复', tokens_in: 1, tokens_out: 1, usage: true, model: 'offline' }; },
      async complete() { return { text: '离线整理结果', tokens_in: 1, tokens_out: 1, usage: true, model: 'offline' }; },
    },
    asr: { available: () => true, async transcribe() { return { text: '本人录音内容', seconds: 1 }; } },
  });
  server = http.createServer(app.handle);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const name of Object.keys(users)) {
    clients[name] = new Client(base);
    assert.equal((await clients[name].post('/api/login', { username: name, password: 'offline-test-pass' })).status, 200);
  }
  clients.anonymous = new Client(base);
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  await app?.close();
  db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('新数据库不建立旧正文历史表，历史迁移槽位仍兼容', () => {
  assert.equal(freshHasHistory, false);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('旧数据库升级保持版本编号与已有历史数据，不触发删除', () => {
  const file = path.join(dir, 'legacy.sqlite');
  let legacy = openDb(file, { upTo: 7 });
  try {
    const at = nowIso();
    legacy.prepare("INSERT INTO users(id, username, password_hash, created_at) VALUES (1, 'legacy', 'offline-placeholder', ?)").run(at);
    legacy.prepare("INSERT INTO characters(id, chub_path, fetched_at) VALUES (1, 'offline/legacy', ?)").run(at);
    legacy.prepare('INSERT INTO chats(id, user_id, character_id, created_at, updated_at) VALUES (1, 1, 1, ?, ?)').run(at, at);
    legacy.prepare("INSERT INTO messages(id, chat_id, role, content, created_at) VALUES (1, 1, 'user', '现有正文', ?)").run(at);
    legacy.exec('CREATE TABLE message_edits (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES messages(id), old_content TEXT NOT NULL, edited_at TEXT NOT NULL)');
    legacy.prepare('INSERT INTO message_edits(message_id, old_content, edited_at) VALUES (1, ?, ?)').run('旧部署已存在的正文', at);
    legacy.exec('PRAGMA user_version = 8');
    legacy.close();
    legacy = openDb(file);
    assert.equal(legacy.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(legacy.prepare('SELECT old_content FROM message_edits').get().old_content, '旧部署已存在的正文');
    assert.equal(legacy.prepare('SELECT content FROM messages WHERE id = 1').get().content, '现有正文');
    assert.deepEqual(legacy.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { legacy.close(); }
});

for (const name of ['super', 'admin', 'owner', 'other', 'anonymous']) {
  test(`${name}：旧审查接口全部404，含编辑历史、设定、文件和未发送录音`, async () => {
    const { chat, clips } = fixtures.owner;
    const paths = ['/api/admin/review/chats', `/api/admin/review/chats/${chat}`, `/api/admin/review/chats/${chat}/file-text`, '/api/admin/voice', `/api/admin/voice?user_id=${users.owner}&unsent=1`, ...clips.map((id) => `/api/admin/voice/${id}/audio`)];
    for (const url of paths) {
      for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']) {
        const r = await clients[name].req(method, url, undefined, { range: 'bytes=0-3' });
        assert.equal(r.status, 404, `${name} ${method} ${url}: ${r.text}`);
        for (const secret of secrets) assert.ok(!r.text.includes(secret));
        assert.equal(r.headers.get('content-range'), null);
      }
    }
  });
}

test('所有登录角色：他人会话详情、文件、设定与消息操作均404，列表只含本人', async () => {
  for (const name of Object.keys(users)) {
    const c = clients[name];
    const target = fixtures[name === 'owner' ? 'other' : 'owner'];
    const readPaths = [`/api/chats/${target.chat}`, `/api/chats/${target.chat}/file-text`, `/api/chats/${target.chat}/settings`];
    for (const url of readPaths) {
      const r = await c.get(url);
      assert.equal(r.status, 404, `${name} ${url}`);
      for (const secret of secrets) assert.ok(!r.text.includes(secret));
    }
    for (const [method, url, body] of [
      ['PATCH', `/api/chats/${target.chat}`, { model_id: null }],
      ['DELETE', `/api/chats/${target.chat}`],
      ['PATCH', `/api/chats/${target.chat}/settings`, { override: { instruction: '越权' } }],
      ['DELETE', `/api/chats/${target.chat}/settings`],
      ['PATCH', `/api/messages/${target.message}`, { content: '越权' }],
      ['DELETE', `/api/messages/${target.message}`],
      ['POST', `/api/messages/${target.message}/rewind`, { content: '越权' }],
      ['POST', `/api/chats/${target.chat}/messages`, { content: '越权' }],
      ['POST', `/api/chats/${target.chat}/regenerate`, {}],
    ]) assert.equal((await c.req(method, url, body)).status, 404, `${name} ${method} ${url}`);
    const list = await c.get('/api/chats');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.items.map((x) => x.id), [fixtures[name].chat]);
    const upload = await fetch(`${base}/api/voice/transcribe?chat_id=${target.chat}`, { method: 'POST', headers: { cookie: c.cookie, 'content-type': 'audio/webm' }, body: audio });
    assert.equal(upload.status, 404, `${name} 不能往他人会话附录音`);
    await upload.text();
  }
});

test('管理员与普通用户均可继续本人的文件聊天、设定、编辑、语音和软删除', async () => {
  for (const name of Object.keys(users)) {
    const c = clients[name];
    const own = fixtures[name];
    assert.equal((await c.get(`/api/chats/${own.chat}`)).status, 200);
    assert.equal((await c.get(`/api/chats/${own.chat}/file-text`)).json.text, secrets[3]);
    assert.equal((await c.get(`/api/chats/${own.chat}/settings`)).status, 200);
    assert.equal((await c.patch(`/api/messages/${own.message}`, { content: '本人编辑后正文' })).status, 200);
    const view = (await c.get(`/api/chats/${own.chat}`)).json;
    assert.equal(view.messages[0].content, '本人编辑后正文');
    assert.ok(!JSON.stringify(view).includes(secrets[1]));
    assert.ok(!JSON.stringify(view).includes(secrets[2]));
    const rewind = await c.post(`/api/messages/${own.message}/rewind`, { content: '本人重新回复正文' });
    assert.equal(rewind.status, 200);
    assert.ok(parseSse(rewind.text).some((e) => e.event === 'done'), rewind.text);
    assert.equal((await c.get(`/api/chats/${own.chat}`)).json.messages[0].content, '本人重新回复正文');
    assert.equal((await c.del(`/api/chats/${own.chat}/settings`)).status, 200);
    const upload = await fetch(`${base}/api/voice/transcribe?chat_id=${own.chat}`, { method: 'POST', headers: { cookie: c.cookie, 'content-type': 'audio/webm' }, body: audio });
    assert.equal(upload.status, 200);
    const voice = await upload.json();
    assert.equal(voice.raw_text, '本人录音内容');
    const reply = await c.post(`/api/chats/${own.chat}/messages`, { content: voice.formatted_text, clip_id: voice.clip_id });
    assert.equal(reply.status, 200);
    assert.ok(parseSse(reply.text).some((e) => e.event === 'done'), reply.text);
    assert.equal((await c.del(`/api/chats/${own.chat}`)).status, 200);
    assert.equal((await c.get(`/api/chats/${own.chat}`)).status, 404);
    assert.equal((await c.get(`/api/chats/${own.chat}/file-text`)).status, 404);
    assert.ok(db.prepare('SELECT deleted_at FROM chats WHERE id = ?').get(own.chat).deleted_at);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_edits WHERE message_id = ?').get(own.message).n, 1, '编辑与重新回复不再收集旧正文');
    assert.equal(db.prepare('SELECT old_content FROM message_edits WHERE message_id = ?').get(own.message).old_content, secrets[1], '旧部署已有数据保持不变');
  }
});
