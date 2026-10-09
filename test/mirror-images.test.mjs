// 离线图片链路：真实临时 SQLite 和中性 PNG，不访问 NAS、模型或 CDN。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, symlinkSync, openSync, closeSync, ftruncateSync } from 'node:fs';
import { openDb } from '../server/db.mjs';
import { createSession } from '../server/auth.mjs';
import { createApp } from '../server/app.mjs';
import { solidPng } from '../server/png.mjs';
import { createMirrorImages } from '../server/mirror-images.mjs';
import { tmpDir, cleanupTmp, Client } from './helpers.mjs';

let dir, db, mirror, app, server, base;
let safe, adult, superUser;
const png = solidPng(32, 16, [120, 160, 200]);
const fallback = solidPng(16, 16, [20, 40, 60]);
const remote = 'https://avatars.charhub.io/avatars/fixture/avatar.webp';

before(async () => {
  dir = tmpDir('mirror-images');
  const imageDir = path.join(dir, 'nas');
  mkdirSync(imageDir, { recursive: true });
  writeFileSync(path.join(imageDir, 'safe.png'), png);
  writeFileSync(path.join(imageDir, 'not-image.png'), '{"card":"private fixture"}');
  writeFileSync(path.join(imageDir, 'fake.png'), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('{"card":"fake png"}') ]));
  writeFileSync(path.join(dir, 'outside.png'), png);
  symlinkSync(path.join(dir, 'outside.png'), path.join(imageDir, 'escape.png'));
  const large = openSync(path.join(imageDir, 'large.png'), 'w');
  ftruncateSync(large, 64 * 1024 * 1024 + 1);
  closeSync(large);
  mirror = new DatabaseSync(path.join(dir, 'mirror.sqlite'));
  mirror.exec(`CREATE TABLE chars (id INTEGER PRIMARY KEY, full_path TEXT UNIQUE NOT NULL, name TEXT, name_zh TEXT,
    tagline TEXT, tagline_zh TEXT, topics_json TEXT, nsfw INTEGER, nsfw_image INTEGER, avatar_url TEXT, max_res_url TEXT,
    avatar_file TEXT, avatar_status TEXT, avatar_bytes INTEGER, fullimg_file TEXT, fullimg_status TEXT, fullimg_bytes INTEGER);
    CREATE INDEX idx_chars_avatar ON chars(avatar_status); CREATE INDEX idx_chars_fullimg ON chars(fullimg_status);
    CREATE INDEX idx_chars_nsfw ON chars(nsfw);
    CREATE TABLE gallery (char_id INTEGER NOT NULL, image_id TEXT NOT NULL, url TEXT, nsfw INTEGER, raw_json TEXT,
      file TEXT, bytes INTEGER, content_type TEXT, status TEXT, PRIMARY KEY(char_id,image_id));
    CREATE INDEX idx_gallery_status ON gallery(status);
    CREATE VIRTUAL TABLE chars_fts USING fts5(name,name_zh,tagline,tagline_zh,topics,tokenize='trigram');`);
  const ins = mirror.prepare('INSERT INTO chars VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const rows = [
    [1, 'sample/safe', '中性测试角色', 0, 0, 'safe.png', 'ok', 'safe.png', 'ok'],
    [2, 'sample/adult', '成人测试角色', 1, 0, 'safe.png', 'ok', 'safe.png', 'ok'],
    [3, 'sample/image-adult', '成人头像测试', 0, 1, 'safe.png', 'ok', null, null],
    [4, 'sample/bad-avatar', '损坏头像', 0, 0, 'not-image.png', 'ok', null, null],
    [5, 'sample/spooled', '仅暂存测试', 0, 0, 'safe.png', 'spooled', 'safe.png', 'spooled'],
    [6, 'sample/app-adult', '应用权限测试', 0, 0, 'safe.png', 'ok', null, null],
    [7, 'sample/traversal', '路径测试', 0, 0, '../outside.png', 'ok', null, null],
    [8, 'sample/symlink', '链接测试', 0, 0, 'escape.png', 'ok', null, null],
    [9, 'sample/oversize', '超大图片测试', 0, 0, 'large.png', 'ok', null, null],
    [10, 'sample/missing', '文件缺失测试', 0, 0, 'missing.png', 'ok', null, null],
    [11, 'sample/fake-png', '伪造图片测试', 0, 0, 'fake.png', 'ok', null, null],
  ];
  for (const [id, p, name, nsfw, ni, af, as, ff, fs] of rows) {
    ins.run(id, p, name, name, '', '', '[]', nsfw, ni, remote, remote, af, as, png.length, ff, fs, png.length);
    mirror.prepare('INSERT INTO chars_fts(rowid,name,name_zh,tagline,tagline_zh,topics) VALUES(?,?,?,?,?,?)').run(id, name, name, '', '', '[]');
  }
  const gin = mirror.prepare('INSERT INTO gallery VALUES (?,?,?,?,?,?,?,?,?)');
  gin.run(1, 'neutral-1', remote, 0, '{"secret":"raw metadata"}', 'safe.png', png.length, 'text/html', 'ok');
  gin.run(1, 'adult-2', remote, 1, '{}', 'safe.png', png.length, 'image/png', 'ok');
  gin.run(1, 'pending-3', remote, 0, '{}', 'safe.png', png.length, 'image/png', 'spooled');
  gin.run(2, 'neutral-4', remote, 0, '{}', 'safe.png', png.length, 'image/png', 'ok');
  gin.run(1, '../../odd id/五', remote, 0, '{}', 'safe.png', png.length, 'image/png', 'ok');
  db = openDb(path.join(dir, 'aichat.sqlite'));
  for (const [id, role, enabled] of [[1, 'tenant', 0], [2, 'tenant', 1], [3, 'super', 0]]) {
    db.prepare('INSERT INTO users(id,username,password_hash,role,is_admin,nsfw_enabled,created_at,must_change_password) VALUES(?,?,?,?,?,?,?,0)')
      .run(id, `fixture-${id}`, 'unused', role, role === 'super' ? 1 : 0, enabled, new Date().toISOString());
  }
  db.prepare('INSERT INTO characters(chub_path,name,nsfw,fetched_at) VALUES(?,?,1,?)').run('sample/app-adult', '应用权限测试', new Date().toISOString());
  app = createApp({ db, config: { dataDir: dir, publicDir: path.join(dir, 'pub'), mirrorDbFile: path.join(dir, 'mirror.sqlite'), mirrorImageDir: imageDir },
    chub: { search: async () => ({ items: [{ path: 'sample/safe', name: '中性测试角色', avatar: `/api/avatar?u=${encodeURIComponent(remote)}`, tags: [], nsfw: false }], page: 1, has_more: false }) },
    llm: { streamChat: async () => { throw new Error('离线测试禁止模型调用'); } },
    avatars: { get: async (u) => { assert.equal(u, remote); return { type: 'image/png', buf: fallback }; } } });
  server = http.createServer(app.handle);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  [safe, adult, superUser] = [1, 2, 3].map(id => {
    const c = new Client(base); c.cookie = `ac_sid=${createSession(db, id)}`; return c;
  });
});

after(async () => {
  server?.closeAllConnections?.();
  if (server) await new Promise(r => server.close(r));
  app?.close?.(); mirror?.close(); db?.close();
  cleanupTmp(dir);
});

test('图片页只列NAS完成项并保持分页、类型过滤与安全URL', async () => {
  const r = await safe.get('/api/images?kind=gallery&limit=1');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.available, true);
  assert.equal(r.json.limit, 1);
  assert.equal(r.json.items.length, 1);
  assert.equal(r.json.has_more, true);
  const first = r.json.items[0];
  assert.equal(first.kind, 'gallery'); assert.equal(first.source, 'nas');
  assert.equal(first.character_path, 'sample/safe'); assert.equal(first.nsfw, false);
  assert.match(first.thumbnail_url, /^\/api\/images\/[^/?]+\?variant=thumb$/);
  assert.match(first.original_url, /^\/api\/images\/[^/?]+\?variant=original$/);
  assert.match(first.download_url, /download=1$/);
  assert.equal(JSON.stringify(r.json).includes(dir), false);
  assert.equal(JSON.stringify(r.json).includes('raw metadata'), false);
  const second = await safe.get('/api/images?kind=gallery&limit=1&page=2');
  assert.equal(second.json.items.length, 1); assert.equal(second.json.has_more, false);
  assert.notEqual(first.id, second.json.items[0].id);
});

test('角色图片页头像原图优先并过滤成人图和SSD暂存', async () => {
  const r = await safe.get('/api/character-images?path=sample%2Fsafe&limit=3');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.items.map(x => x.kind), ['avatar', 'fullimg', 'gallery']);
  assert.equal(r.json.has_more, true);
  const all = await adult.get('/api/character-images?path=sample%2Fsafe');
  assert.equal(all.json.items.filter(x => x.kind === 'gallery').length, 3);
  const s = await safe.get('/api/character-images?path=sample%2Fspooled');
  assert.equal(s.json.available, true); assert.deepEqual(s.json.items, []);
  const missing = await safe.get('/api/character-images?path=unknown%2Fcharacter');
  assert.equal(missing.status, 200); assert.deepEqual(missing.json.items, []);
});

test('成人权限对metadata、原图、HEAD、下载和super逐请求生效', async () => {
  for (const p of ['sample/adult', 'sample/image-adult', 'sample/app-adult']) {
    assert.equal((await safe.get(`/api/character-images?path=${encodeURIComponent(p)}`)).status, 403);
    assert.equal((await superUser.get(`/api/character-images?path=${encodeURIComponent(p)}`)).status, 403);
  }
  const all = await safe.get('/api/images?limit=60');
  assert.equal(all.json.items.some(x => ['sample/adult', 'sample/image-adult', 'sample/app-adult'].includes(x.character_path)), false);
  const r = await adult.get('/api/character-images?path=sample%2Fadult');
  const image = r.json.items.find(x => x.kind === 'fullimg');
  assert.equal((await safe.get(image.original_url)).status, 403);
  assert.equal((await safe.get(image.download_url)).status, 403);
  const head = await fetch(base + image.original_url, { method: 'HEAD', headers: { cookie: safe.cookie } });
  assert.equal(head.status, 403);
  db.prepare('UPDATE users SET nsfw_enabled=0 WHERE id=2').run();
  assert.equal((await adult.get(image.original_url)).status, 403);
  db.prepare('UPDATE users SET nsfw_enabled=1 WHERE id=2').run();
});

test('媒体魔数决定MIME、下载文件名安全且无共享缓存', async () => {
  const r = await safe.get('/api/character-images?path=sample%2Fsafe');
  const image = r.json.items.find(x => x.kind === 'gallery');
  const original = await fetch(base + image.original_url, { headers: { cookie: safe.cookie } });
  assert.equal(original.status, 200);
  assert.equal(original.headers.get('content-type'), 'image/png');
  assert.equal(original.headers.get('cache-control'), 'private, no-store');
  assert.equal(original.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), png);
  const download = await safe.get(image.download_url);
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /^attachment; filename=/);
  assert.equal(download.headers.get('content-disposition').includes('\r'), false);
  const head = await fetch(base + image.original_url, { method: 'HEAD', headers: { cookie: safe.cookie } });
  assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('缩略图为有限尺寸JPEG且高清原图缩略图复用本地头像', async () => {
  const r = await safe.get('/api/character-images?path=sample%2Fsafe');
  const full = r.json.items.find(x => x.kind === 'fullimg');
  const thumb = await fetch(base + full.thumbnail_url, { headers: { cookie: safe.cookie } });
  assert.equal(thumb.status, 200); assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), png);
  const gallery = r.json.items.find(x => x.kind === 'gallery');
  const small = await fetch(base + gallery.thumbnail_url, { headers: { cookie: safe.cookie } });
  assert.equal(small.status, 200); assert.equal(small.headers.get('content-type'), 'image/jpeg');
  const bytes = Buffer.from(await small.arrayBuffer());
  assert.equal(bytes.readUInt16BE(0), 0xffd8); assert.ok(bytes.length < 200000);
});

test('不读取逃逸、符号链接、伪造图片、超大图片或缺失文件', async () => {
  for (const p of ['sample/traversal', 'sample/symlink', 'sample/oversize', 'sample/missing', 'sample/fake-png', 'sample/bad-avatar']) {
    const r = await safe.get(`/api/character-images?path=${encodeURIComponent(p)}`);
    const response = await safe.get(r.json.items[0].original_url);
    assert.equal(response.status, 404, `${p}: ${response.text}`);
    assert.equal(response.text.includes('private fixture'), false);
    assert.equal(response.text.includes(dir), false);
  }
});

test('头像接点NAS优先且本地损坏安全回源，成人角色不能借CDN绕过', async () => {
  const home = await safe.get('/api/home');
  assert.match(home.json.hot[0].avatar, /[?&]p=sample%2Fsafe/);
  const nas = await fetch(base + home.json.hot[0].avatar, { headers: { cookie: safe.cookie } });
  assert.equal(nas.status, 200); assert.deepEqual(Buffer.from(await nas.arrayBuffer()), png);
  const bad = await fetch(base + `/api/avatar?p=sample%2Fbad-avatar&u=${encodeURIComponent(remote)}`, { headers: { cookie: safe.cookie } });
  assert.equal(bad.status, 200); assert.deepEqual(Buffer.from(await bad.arrayBuffer()), fallback);
  assert.equal((await safe.get(`/api/avatar?p=sample%2Fadult&u=${encodeURIComponent(remote)}`)).status, 403);
});

test('搜索、参数校验、奇异图集ID均通过安全接口', async () => {
  const r = await safe.get('/api/images?q=中性测试角色&kind=fullimg');
  assert.equal(r.status, 200); assert.equal(r.json.items.length, 1);
  assert.equal(r.json.items[0].character_path, 'sample/safe');
  assert.equal((await safe.get('/api/images?q=%22%20OR%20*')).status, 200);
  assert.equal((await safe.get('/api/images?q=%25')).json.items.length, 0);
  for (const route of ['/api/images?kind=bad', '/api/images?page=501', '/api/images?limit=61', '/api/images?character=bad', '/api/character-images?path=../outside', '/api/images/garbage', '/api/images/a.1?variant=bad']) {
    assert.equal((await safe.get(route)).status, 400, route);
  }
  const items = (await safe.get('/api/character-images?path=sample%2Fsafe')).json.items;
  assert.equal(items.filter(x => x.kind === 'gallery').length, 2);
  for (const image of items.filter(x => x.kind === 'gallery')) assert.equal((await safe.get(image.original_url)).status, 200);
  assert.equal((await new Client(base).get('/api/images')).status, 401);
  assert.equal((await new Client(base).get('/api/images/a.1')).status, 401);
});

test('应用成人标记不会造成分页漏项或提前结束', async () => {
  // 若先LIMIT再在JS过滤，第一页被应用成人角色占满时会误报没有更多图片。
  for (let id = 30; id <= 33; id++) {
    mirror.prepare('INSERT INTO chars(id,full_path,name,nsfw,nsfw_image,topics_json,avatar_file,avatar_status,avatar_bytes) VALUES(?,?,?,0,0,\'[]\',\'safe.png\',\'ok\',?)')
      .run(id, `fixture/hidden-${id}`, '权限分页样本', png.length);
    db.prepare('INSERT INTO characters(chub_path,name,nsfw,fetched_at) VALUES(?,?,1,?)').run(`fixture/hidden-${id}`, '权限分页样本', new Date().toISOString());
  }
  try {
    const r = await safe.get('/api/images?kind=avatar&limit=1');
    assert.equal(r.json.items.length, 1); assert.equal(r.json.has_more, true);
    assert.equal(r.json.items[0].character_path, 'sample/fake-png');
  } finally { mirror.prepare('DELETE FROM chars WHERE id BETWEEN 30 AND 33').run(); }
});

test('只有topics的成人标记也保护媒体和头像，p/u不能跨角色绑定', async () => {
  mirror.prepare('UPDATE chars SET topics_json=? WHERE id=11').run('["NSFW"]');
  try {
    assert.equal((await safe.get('/api/images/a.11?variant=original')).status, 403);
    assert.equal((await safe.get('/api/avatar?p=sample%2Ffake-png&u=' + encodeURIComponent(remote))).status, 403);
  } finally { mirror.prepare("UPDATE chars SET topics_json='[]' WHERE id=11").run(); }
  const r = await safe.get('/api/avatar?p=sample%2Fbad-avatar&u=' + encodeURIComponent('https://avatars.charhub.io/other-role/avatar.png'));
  assert.equal(r.status, 200); // CDN替身只接受当前角色DB中的remote，传入u被忽略。
});

test('中文短词能找到最近一万条以外的完成图片', async () => {
  mirror.exec(`WITH RECURSIVE n(i) AS (SELECT 100 UNION ALL SELECT i+1 FROM n WHERE i<10200)
    INSERT INTO chars(id,full_path,name,nsfw,nsfw_image,topics_json) SELECT i,'bulk/item-'||i,'后续样本',0,0,'[]' FROM n;`);
  try {
    const r = await safe.get('/api/images?kind=fullimg&q=' + encodeURIComponent('中性'));
    assert.equal(r.status, 200); assert.equal(r.json.items.length, 1);
    assert.equal(r.json.items[0].character_path, 'sample/safe');
  } finally { mirror.prepare('DELETE FROM chars WHERE id>=100').run(); }
});

test('受控游标能持续遍历500页以外的完整图库且不重复遗漏', async () => {
  const insert = mirror.prepare("INSERT INTO gallery(char_id,image_id,nsfw,file,bytes,status) VALUES(1,?,0,'safe.png',?,'ok')");
  for (let i = 0; i < 502; i++) insert.run(`cursor-${i}`, png.length);
  try {
    let r = await safe.get('/api/images?kind=gallery&limit=1');
    assert.equal(r.status, 200); assert.equal(typeof r.json.next_cursor, 'string');
    const initialCursor = r.json.next_cursor;
    const ids = new Set(); let page = 1;
    while (true) {
      assert.equal(r.json.items.length, 1);
      const item = r.json.items[0]; assert.equal(ids.has(item.id), false);
      ids.add(item.id);
      if (!r.json.has_more) break;
      r = await safe.get(`/api/images?kind=gallery&limit=1&page=${++page}&cursor=${encodeURIComponent(r.json.next_cursor)}`);
      assert.equal(r.status, 200, r.text);
    }
    assert.equal(ids.size, 504); assert.equal(page, 504);
    assert.equal((await safe.get('/api/images?kind=gallery&limit=1&page=501')).status, 400);
    assert.equal((await safe.get('/api/images?kind=fullimg&cursor=' + initialCursor)).status, 400);
    assert.equal((await safe.get('/api/images?kind=gallery&q=test&cursor=' + initialCursor)).status, 400);
    assert.equal((await safe.get('/api/images?cursor=' + Buffer.from('{"v":1,"rank":3,"sort_id":1,"filterHash":"x"}').toString('base64url'))).status, 400);
  } finally { mirror.prepare("DELETE FROM gallery WHERE image_id LIKE 'cursor-%'").run(); }
});

test('缩图缓存命中后关成人开关仍拒绝同一媒体', async () => {
  const r = await adult.get('/api/character-images?path=sample%2Fsafe');
  const image = r.json.items.find(x => x.kind === 'gallery' && x.nsfw);
  assert.equal((await adult.get(image.thumbnail_url)).status, 200);
  db.prepare('UPDATE users SET nsfw_enabled=0 WHERE id=2').run();
  try { assert.equal((await adult.get(image.thumbnail_url)).status, 403); }
  finally { db.prepare('UPDATE users SET nsfw_enabled=1 WHERE id=2').run(); }
});

test('无头像的高清原图即使压缩很小也必须生成480px缩图', async () => {
  const original = solidPng(2000, 2000, [130, 160, 180]);
  assert.ok(original.length < 512 * 1024);
  writeFileSync(path.join(dir, 'nas', 'large-dimensions.png'), original);
  mirror.prepare("INSERT INTO chars(id,full_path,name,nsfw,nsfw_image,topics_json,fullimg_file,fullimg_status,fullimg_bytes) VALUES(40,'fixture/large-dimensions','中性高清样本',0,0,'[]','large-dimensions.png','ok',?)").run(original.length);
  try {
    const r = await fetch(base + '/api/images/f.40?variant=thumb', { headers: { cookie: safe.cookie } });
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.notDeepEqual(Buffer.from(await r.arrayBuffer()), original);
  } finally { mirror.prepare('DELETE FROM chars WHERE id=40').run(); }
});

test('镜像不可用时成人搜索头像和删除p后的旧链接仍逐请求受保护', async () => {
  const adultRemote = 'https://avatars.charhub.io/avatars/fresh/adult/avatar.webp';
  const fallbackApp = createApp({ db, config: { dataDir: dir, mirrorDbFile: path.join(dir, 'missing-again.sqlite'), mirrorImageDir: path.join(dir, 'nas') },
    models: { listEnabled: () => [], systemDefault: () => null, byId: () => null },
    chub: { search: async ({ nsfw }) => ({ items: nsfw ? [{ path: 'fresh/adult', name: '成人中性样本', avatar: '/api/avatar?u=' + encodeURIComponent(adultRemote), nsfw: true, tags: [] }] : [] }) },
    llm: { streamChat: () => { throw new Error('禁止模型'); } }, avatars: { get: async u => { assert.equal(u, adultRemote); return { buf: fallback, type: 'image/png' }; } } });
  const s = http.createServer(fallbackApp.handle);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const c = new Client(`http://127.0.0.1:${s.address().port}`); c.cookie = adult.cookie;
  const other = new Client(c.base); other.cookie = safe.cookie;
  try {
    const home = await c.get('/api/home');
    const avatar = home.json.hot[0].avatar;
    assert.equal((await c.get(avatar)).status, 200);
    assert.equal((await other.get(avatar)).status, 403);
    const legacy = '/api/avatar?u=' + encodeURIComponent(adultRemote);
    assert.equal((await other.get(legacy)).status, 403);
    assert.equal((await c.get(legacy)).status, 200);
    db.prepare('UPDATE users SET nsfw_enabled=0 WHERE id=2').run();
    assert.equal((await c.get(avatar)).status, 403); assert.equal((await c.get(legacy)).status, 403);
    assert.equal((await other.get('/api/avatar?p=unknown%2Fsafe&u=' + encodeURIComponent(adultRemote))).status, 404);
  } finally {
    db.prepare('UPDATE users SET nsfw_enabled=1 WHERE id=2').run();
    s.closeAllConnections?.(); await new Promise(r => s.close(r)); fallbackApp.close();
  }
});

test('远端已知成人证据与镜像普通标记不一致时metadata也统一隐藏', async () => {
  const service = createMirrorImages({ dbFile: path.join(dir, 'mirror.sqlite'), imageDir: path.join(dir, 'nas') });
  try {
    service.avatarUrl('sample/safe', '/api/avatar?u=' + encodeURIComponent(remote), { nsfw: true });
    assert.throws(() => service.list({ character: 'sample/safe', user: { nsfw_enabled: 0 } }), e => e.status === 403);
    const hidden = service.list({ user: { nsfw_enabled: 0 }, limit: 60 });
    assert.equal(hidden.items.some(x => x.character_path === 'sample/safe'), false);
    const visible = service.list({ character: 'sample/safe', user: { nsfw_enabled: 1 } });
    assert.equal(visible.items.every(x => x.nsfw), true);
  } finally { service.close(); }
});

test('共享头像URL关联过多时拒绝旧裸URL，带角色链接仍可访问', () => {
  const service = createMirrorImages();
  try {
    for (let i = 0; i < 6000; i++) service.avatarUrl(`fixture/shared-${i}`, '/api/avatar?u=' + encodeURIComponent(remote), { nsfw: false });
    assert.throws(() => service.avatarLegacy(remote, { nsfw_enabled: 0 }), e => e.status === 403);
    assert.equal(service.avatarRemote('fixture/shared-5999', { nsfw_enabled: 0 }), remote);
  } finally { service.close(); }
  const localService = createMirrorImages({ charactersOfAvatarUrl: () => Array.from({ length: 6000 }, (_, i) => ({ full_path: `fixture/local-${i}`, nsfw: 0, topics_json: '[]' })) });
  try { assert.throws(() => localService.avatarLegacy(remote, { nsfw_enabled: 0 }), e => e.status === 403); }
  finally { localService.close(); }
});

test('镜像不可读不会影响应用并用受控状态响应', async () => {
  const unavailableApp = createApp({ db, config: { dataDir: dir, mirrorDbFile: path.join(dir, 'not-present.sqlite'), mirrorImageDir: path.join(dir, 'nas') }, chub: {}, llm: {}, avatars: {} });
  const s = http.createServer(unavailableApp.handle);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const c = new Client(`http://127.0.0.1:${s.address().port}`); c.cookie = safe.cookie;
  try {
    const r = await c.get('/api/images?limit=7&page=2');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { available: false, reason: 'mirror_unavailable', items: [], page: 2, limit: 7, has_more: false });
    assert.equal((await c.get('/api/images/a.1?variant=original')).status, 503);
    assert.equal((await c.get('/healthz')).status, 200);
  } finally {
    s.closeAllConnections?.(); await new Promise(r => s.close(r)); unavailableApp.close?.();
  }
});
