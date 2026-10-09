// v0.7（契约 §12）：自建卡 / 剧情卡、拷贝二创、导入导出（V2 JSON 与 PNG chara 块）、世界书、全面软删除、super 只读、v5→v6 迁移。
// 进程内起 app，chub 与模型用假的（不出网、不调真模型）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { openDb, SCHEMA_VERSION } from '../server/db.mjs';
import { hashPassword } from '../server/auth.mjs';
import { createApp } from '../server/app.mjs';
import { HttpError, nowIso } from '../server/util.mjs';
import { nodeToCard } from '../server/chub.mjs';
import { crc32, crc32Table, readTextChunks, readChunks, solidPng, withTextChunk, isPng, writeChunks, stripPngMetadata } from '../server/png.mjs';
import { selectLore, normalizeLorebook, parseCardJson, normalizeCardData, sniffImage, sanitizeAvatar, stripJpegMetadata, stripWebpMetadata } from '../server/cards.mjs';
import { buildMessages, NARRATOR_RULE } from '../server/prompt.mjs';
import { tmpDir, cleanupTmp, listenFree, Client, parseSse } from './helpers.mjs';

const PORTS = [44988, 44987, 44986, 44985, 44984, 44989, 44982];
const TINY_PNG = solidPng(4, 4, [10, 20, 30]);

// ---------- 测试图片：结构合法的最小 JPEG / WebP（可带元数据）----------
const seg = (marker, payload) => { const h = Buffer.from([0xff, marker, 0, 0]); h.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([h, payload]); };
const APP0 = seg(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
const DQT = seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]));
const SOS = seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0]));
const SCAN = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]);
/** orientation：写进 EXIF 的方向；带 EXIF 时附上一段「GPS-SECRET」，再加 COM 段与 EOI 后的尾巴。 */
function makeJpeg({ orientation = 0, meta = false } = {}) {
  const parts = [Buffer.from([0xff, 0xd8]), APP0];
  if (meta) {
    const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
    parts.push(seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, Buffer.from('GPS-SECRET-1.3521,103.8198')])));
    parts.push(seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0XMP-SECRET')));
    parts.push(seg(0xfe, Buffer.from('COMMENT-SECRET')));
  }
  parts.push(DQT, SOS, SCAN, Buffer.from([0xff, 0xd9]));
  if (meta) parts.push(Buffer.from('TRAILER-SECRET'));
  return Buffer.concat(parts);
}
const riffChunk = (type, data) => { const h = Buffer.alloc(8); h.write(type, 0, 'latin1'); h.writeUInt32LE(data.length, 4); return Buffer.concat([h, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
function makeWebp({ meta = false } = {}) {
  const chunks = [];
  if (meta) { const x = Buffer.alloc(10); x[0] = 0x08 | 0x04 | 0x10; chunks.push(riffChunk('VP8X', x)); }
  chunks.push(riffChunk('VP8 ', Buffer.alloc(40, 2)));
  if (meta) chunks.push(riffChunk('EXIF', Buffer.from('EXIF-SECRET')), riffChunk('XMP ', Buffer.from('XMP-SECRET')));
  const body = Buffer.concat(chunks);
  const h = Buffer.alloc(12); h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(body.length + 4, 4); h.write('WEBP', 8, 'latin1');
  return Buffer.concat([h, body]);
}
/** zTXt 块：keyword\0 + 方法 0 + 压缩数据。 */
const ztxt = (keyword, compressed) => ({ type: 'zTXt', data: Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0, 0]), compressed]) });
const has = (buf, text) => buf.includes(Buffer.from(text, 'latin1'));
const LORE_BOOK = {
  entries: [
    { keys: ['dragon'], content: 'LORE-DRAGON', enabled: true, insertion_order: 20 },
    { keys: ['CaseKey'], content: 'LORE-CASE', enabled: true, case_sensitive: true, insertion_order: 30 },
    { keys: ['castle'], secondary_keys: ['night'], selective: true, content: 'LORE-SELECTIVE', enabled: true, insertion_order: 40 },
    { keys: [], content: 'LORE-CONSTANT', constant: true, enabled: true, insertion_order: 50 },
    { keys: ['dragon'], content: 'LORE-DISABLED', enabled: false, insertion_order: 10 },
  ],
};

const NODES = {
  'tester/lore-girl': {
    fullPath: 'tester/lore-girl', name: 'Lore Girl', tagline: 'tl', avatar_url: 'https://avatars.charhub.io/a/lg.webp', topics: ['Fantasy'], nsfw_image: false,
    definition: {
      name: 'Lore Girl', first_message: 'Hello {{user}}', personality: 'A mage', tavern_personality: 'calm', description: 'Creator notes',
      embedded_lorebook: { name: 'World', entries: [{ id: 1, keys: ['tower'], content: 'CHUB-LORE-TOWER', enabled: true, insertion_order: 1, selective: true, secondary_keys: [] }] },
    },
  },
  'tester/spicy': { fullPath: 'tester/spicy', name: 'Spicy', tagline: 'x', avatar_url: '', topics: ['NSFW'], nsfw_image: true, definition: { name: 'Spicy', first_message: '嗨' } },
};
const fakeChub = {
  async search() { return { items: Object.values(NODES).map(nodeToCard), page: 1, has_more: false }; },
  async character(p) { if (!NODES[p]) throw new HttpError(404, '没有找到这个角色'); return structuredClone(NODES[p]); },
};

let lastPrompt = null;
const fakeLlm = {
  async streamChat(messages, { onDelta }) {
    lastPrompt = messages;
    onDelta('好的');
    return { text: '好的', tokens_in: 10, tokens_out: 5, usage: true, model: 'fake' };
  },
  async complete() { return { text: '你好（译）', tokens_in: 1, tokens_out: 1 }; },
};

let dir, server, base, db;
const id = {};
const who = {};

async function login(u, p) {
  // 管理员直接开的号首次登录要先改密（契约 §13.3，见 invites.test.mjs）；这里的用例与之无关，直接清掉标记。
  db.prepare('UPDATE users SET must_change_password = 0 WHERE username = ?').run(u);
  const c = new Client(base);
  const r = await c.post('/api/login', { username: u, password: p });
  assert.equal(r.status, 200, `${u}：${r.text}`);
  return c;
}

/** 原始上传（非 JSON 请求体）。 */
async function upload(c, p, buf, type) {
  const r = await fetch(base + p, { method: 'POST', headers: { cookie: c.cookie, 'content-type': type }, body: buf });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, json, text };
}
async function getRaw(c, p) {
  const r = await fetch(base + p, { headers: { cookie: c.cookie } });
  return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
}

before(async () => {
  dir = tmpDir('unit-cards');
  db = openDb(path.join(dir, 'aichat.sqlite'));
  const ins = db.prepare('INSERT INTO users(username, password_hash, display_name, is_admin, role, nsfw_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  id.super = Number(ins.run('root', hashPassword('root-pass-1'), '超管', 1, 'super', 0, nowIso()).lastInsertRowid);
  id.a = Number(ins.run('alice', hashPassword('alice-pass-1'), '爱丽丝', 0, 'tenant', 1, nowIso()).lastInsertRowid);
  id.b = Number(ins.run('bob', hashPassword('bob-pass-12'), '鲍勃', 0, 'tenant', 0, nowIso()).lastInsertRowid);
  // 有单价的假模型（不出网：llm 是假的），让回复有费用，好验证「用户侧费用只算未删」
  db.prepare("INSERT INTO models(name, provider, base_url, model, enabled, sort, currency, price_in, price_out, created_at) VALUES ('假模型', '测试', 'https://api.example.com/v1', 'fake', 1, 1, 'USD', 1, 2, ?)").run(nowIso());
  // 建卡频率限制（每分钟 N 次）对既有用例关掉；「防滥用」用例里单独打开再验证。
  db.prepare("INSERT INTO settings(key, value) VALUES ('card_writes_per_minute', '0')").run();
  const app = createApp({ db, chub: fakeChub, llm: fakeLlm,
    avatars: { get: async () => ({ type: 'image/png', buf: TINY_PNG }) },
    config: { publicDir: path.join(dir, 'pub'), deepseekModel: 'fake', dataDir: dir } });
  server = http.createServer(app.handle);
  base = `http://127.0.0.1:${await listenFree(server, PORTS)}`;
  who.super = await login('root', 'root-pass-1');
  who.a = await login('alice', 'alice-pass-1');
  who.b = await login('bob', 'bob-pass-12');
});

after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  cleanupTmp(dir);
});

// ---------- 纯函数 ----------
test('CRC：zlib.crc32 与查表实现一致；PNG tEXt 写入后能读回，chunk 结构与 CRC 都对', () => {
  for (const s of ['', 'IEND', 'hello world', '中文'.repeat(100)]) assert.equal(crc32(Buffer.from(s)), crc32Table(Buffer.from(s)));
  assert.equal(crc32Table(Buffer.from('123456789')), 0xcbf43926); // 标准校验值
  const png = withTextChunk(TINY_PNG, 'chara', 'QUJD');
  assert.ok(isPng(png));
  assert.equal(readTextChunks(png).get('chara'), 'QUJD');
  const types = readChunks(png).map((c) => c.type);
  assert.deepEqual([types[0], types.at(-2), types.at(-1)], ['IHDR', 'tEXt', 'IEND']);
  // 再写一次同名块：旧块被替换，不会出现两个
  const again = withTextChunk(png, 'chara', 'WFla');
  assert.equal(readChunks(again).filter((c) => c.type === 'tEXt').length, 1);
  assert.equal(readTextChunks(again).get('chara'), 'WFla');
  // 坏 CRC 被拒
  const bad = Buffer.from(png); bad[bad.length - 5] ^= 0xff;
  assert.throws(() => readChunks(bad));
  // 占位图能被 zlib 正常解压
  const idat = readChunks(TINY_PNG).find((c) => c.type === 'IDAT').data;
  assert.equal(zlib.inflateSync(idat).length, 4 * (1 + 4 * 3));
});

test('世界书命中：最近 4 条、不区分大小写（case_sensitive 除外）、selective 次要词、constant 常驻、停用不注入、按 insertion_order、预算上限', () => {
  const book = normalizeLorebook(LORE_BOOK);
  const h = (...xs) => xs.map((content) => ({ role: 'user', content }));
  assert.deepEqual(selectLore(book, h('A DRAGON appears')), ['LORE-DRAGON', 'LORE-CONSTANT']);
  assert.deepEqual(selectLore(book, h('casekey')), ['LORE-CONSTANT'], '区分大小写的条目不命中');
  assert.deepEqual(selectLore(book, h('CaseKey')), ['LORE-CASE', 'LORE-CONSTANT']);
  assert.deepEqual(selectLore(book, h('castle')), ['LORE-CONSTANT'], 'selective 缺次要词不命中');
  assert.deepEqual(selectLore(book, h('castle at night')), ['LORE-SELECTIVE', 'LORE-CONSTANT']);
  // 只扫最近 4 条
  assert.deepEqual(selectLore(book, h('dragon', '1', '2', '3', '4')), ['LORE-CONSTANT']);
  assert.deepEqual(selectLore(book, h('dragon', '2', '3', '4')), ['LORE-DRAGON', 'LORE-CONSTANT']);
  // 预算：常驻优先占预算，放不下的条目跳过
  const big = normalizeLorebook({ entries: [{ keys: ['x'], content: 'a'.repeat(3000), insertion_order: 1 }, { keys: ['x'], content: 'b'.repeat(3000), insertion_order: 2 }, { constant: true, content: 'c'.repeat(500), insertion_order: 3 }] });
  const got = selectLore(big, h('x'));
  assert.deepEqual(got.map((t) => t[0]), ['a', 'c']);
  // SillyTavern world info 形状（entries 为对象、key / disable / order）
  const st = normalizeLorebook({ entries: { 0: { key: ['moon'], content: 'ST-MOON', order: 5 }, 1: { key: ['sun'], content: 'ST-SUN', disable: true } } });
  assert.deepEqual(selectLore(st, h('moon and sun')), ['ST-MOON']);
});

test('剧情卡提示词：叙述者口吻；人物卡不带；相关设定段在 system 里', () => {
  const sys = (kind, lore) => buildMessages({ definition: { personality: '设定' }, charName: '故事', user: { display_name: '我' }, history: [{ role: 'user', content: 'hi' }], kind, lore })[0].content;
  assert.ok(sys('scenario', []).includes(NARRATOR_RULE));
  assert.ok(sys('scenario', []).includes('【世界与剧情设定】'));
  assert.ok(!sys('character', []).includes(NARRATOR_RULE));
  assert.ok(sys('character', ['L1', 'L2']).includes('【相关设定】\nL1\n\nL2'));
  assert.ok(!sys('character', []).includes('【相关设定】'));
});

test('导入解析：V1 / V2 / V3 JSON；无法识别的回 400；字段规范化', () => {
  const v2 = parseCardJson({ spec: 'chara_card_v2', data: { name: 'N', description: 'D', first_mes: 'F', tags: ['NSFW', 'x'], character_book: LORE_BOOK } });
  assert.equal(v2.name, 'N');
  assert.equal(v2.nsfw, true);
  assert.equal(v2.data.character_book.entries.length, 5);
  const v1 = parseCardJson({ name: 'Old', description: 'D1', first_mes: 'hi', mes_example: 'ex' });
  assert.deepEqual([v1.name, v1.data.description, v1.data.mes_example], ['Old', 'D1', 'ex']);
  const v3 = parseCardJson({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'V3', description: 'd3', extensions: { aichat: { kind: 'scenario', tagline: 'tg' } } } });
  assert.deepEqual([v3.kind, v3.tagline, 'aichat' in v3.data.extensions], ['scenario', 'tg', false]);
  assert.throws(() => parseCardJson({ foo: 1 }), (e) => e.status === 400);
  assert.throws(() => normalizeCardData({ description: 'x'.repeat(40000) }, { strict: true }), (e) => e.status === 400);
  assert.equal(normalizeCardData({ description: 'x'.repeat(40000) }).description.length, 30000);
  assert.equal(sniffImage(Buffer.from('GIF89a......')), null);
});

// ---------- 自建卡 CRUD 与权限 ----------
let cardA; // alice 的私有人物卡
test('新建 / 读取 / 修改：字段齐全；data 与平铺两种写法都认；超长 400；别人改 404', async () => {
  let r = await who.a.post('/api/cards', {
    kind: 'character', name: '艾琳', tagline: '剑士', tags: ['奇幻', '剑'], nsfw: false,
    data: { description: '她是{{char}}', first_mes: '你好 {{user}}，我是 {{char}}', alternate_greetings: ['备选'], character_book: LORE_BOOK },
  });
  assert.equal(r.status, 200, r.text);
  cardA = r.json.card;
  assert.equal(cardA.visibility, 'private', '默认私有');
  assert.equal(cardA.is_owner, true);
  assert.deepEqual(cardA.tags, ['奇幻', '剑']);
  assert.equal(cardA.data.first_mes, '你好 {{user}}，我是 {{char}}');
  assert.equal(cardA.first_mes, cardA.data.first_mes, '平铺一份');
  assert.equal(cardA.data.character_book.entries.length, 5);
  assert.equal(cardA.author.name, '爱丽丝');
  r = await who.a.patch(`/api/cards/${cardA.id}`, { scenario: '城堡', tagline: '女剑士' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.card.data.scenario, r.json.card.tagline, r.json.card.data.description], ['城堡', '女剑士', '她是{{char}}']);
  assert.equal((await who.a.patch(`/api/cards/${cardA.id}`, { description: 'x'.repeat(30001) })).status, 400);
  assert.equal((await who.a.post('/api/cards', { name: '' })).status, 400);
  assert.equal((await who.a.post('/api/cards', { name: 'x', kind: 'bad' })).status, 400);
  assert.equal((await who.a.post('/api/cards', { name: 'x', visibility: 'world' })).status, 400);
  assert.equal((await who.b.patch(`/api/cards/${cardA.id}`, { name: '偷改' })).status, 404);
  assert.equal((await who.super.patch(`/api/cards/${cardA.id}`, { name: '超管改' })).status, 404, 'super 只读');
  assert.equal((await who.super.del(`/api/cards/${cardA.id}`)).status, 404, 'super 不能删');
  const my = (await who.a.get('/api/my/cards')).json.items;
  assert.deepEqual(my.map((x) => x.id), [cardA.id]);
  assert.ok(!('data' in my[0]), '列表不带全部设定');
  assert.deepEqual((await who.b.get('/api/my/cards')).json.items, []);
});

test('私有卡：他人看不到、不能 fork / 开聊 / 导出 / 看头像，回应与不存在一致；super 只读可看', async () => {
  const up = await upload(who.a, `/api/cards/${cardA.id}/avatar`, TINY_PNG, 'image/png');
  assert.equal(up.status, 200, up.text);
  const avatar = up.json.card.avatar;
  assert.match(avatar, /^\/api\/card-avatar\/\d+-[0-9a-f]{16}\.png$/);
  const missing = 987654;
  for (const [m, p, body] of [
    ['GET', `/api/cards/${cardA.id}`], ['POST', '/api/cards/fork', { from: 'user', id: cardA.id }], ['POST', '/api/chats', { user_card_id: cardA.id }],
    ['GET', `/api/cards/${cardA.id}/export?format=json`], ['GET', `/api/cards/${cardA.id}/export?format=png`],
  ]) {
    const r = await who.b.req(m, p, body);
    const r404 = await who.b.req(m, p.replace(String(cardA.id), String(missing)), body && { ...body, ...(body.id ? { id: missing } : {}), ...(body.user_card_id ? { user_card_id: missing } : {}) });
    assert.equal(r.status, 404, `${m} ${p}`);
    assert.equal(r.text, r404.text, `${m} ${p} 与不存在一致`);
  }
  assert.equal((await getRaw(who.b, avatar)).status, 404);
  assert.equal((await getRaw(who.a, avatar)).status, 200);
  const sv = await getRaw(who.super, avatar);
  assert.equal(sv.status, 200);
  assert.equal(sv.headers.get('content-type'), 'image/png');
  assert.equal((await who.super.get(`/api/cards/${cardA.id}`)).status, 200);
  // 社区里没有私有卡
  assert.deepEqual((await who.b.get('/api/community')).json.items, []);
  // 路径安全：乱写的文件名、穿越、非当前头像一律 404
  for (const p of ['/api/card-avatar/..%2F..%2Fetc%2Fpasswd', '/api/card-avatar/1-0000000000000000.png', `/api/card-avatar/${cardA.id}-0123456789abcdef.png`, '/api/card-avatar/x.png']) {
    assert.equal((await getRaw(who.a, p)).status, 404, p);
  }
});

test('头像上传：魔数校验、5MB 上限、multipart 与 dataURL 都行，换头像后旧文件失效', async () => {
  const before = (await who.a.get(`/api/cards/${cardA.id}`)).json.card.avatar;
  assert.equal((await upload(who.a, `/api/cards/${cardA.id}/avatar`, Buffer.from('GIF89a-not-allowed-xxxxxxxx'), 'image/png')).status, 400);
  assert.equal((await upload(who.a, `/api/cards/${cardA.id}/avatar`, Buffer.from('<svg></svg>'.padEnd(64)), 'image/webp')).status, 400);
  assert.equal((await upload(who.a, `/api/cards/${cardA.id}/avatar`, Buffer.from('x'), 'text/html')).status, 415);
  const huge = Buffer.concat([TINY_PNG.subarray(0, 16), Buffer.alloc(5 * 1024 * 1024 + 10)]);
  assert.equal((await upload(who.a, `/api/cards/${cardA.id}/avatar`, huge, 'image/png')).status, 413);
  // multipart（JPEG）
  const jpg = makeJpeg();
  const bd = 'XyZbOuNdArY';
  const mp = Buffer.concat([Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), jpg, Buffer.from(`\r\n--${bd}--\r\n`)]);
  let r = await upload(who.a, `/api/cards/${cardA.id}/avatar`, mp, `multipart/form-data; boundary=${bd}`);
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.card.avatar, /\.jpg$/);
  assert.equal((await getRaw(who.a, before)).status, 404, '旧头像失效');
  // dataURL（WebP）
  const webp = makeWebp();
  r = await who.a.post(`/api/cards/${cardA.id}/avatar`, { image: `data:image/webp;base64,${webp.toString('base64')}` });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.card.avatar, /\.webp$/);
  const got = await getRaw(who.a, r.json.card.avatar);
  assert.equal(got.headers.get('content-type'), 'image/webp');
  assert.ok(got.buf.equals(webp));
  // 别人不能给我的卡传头像
  assert.equal((await upload(who.b, `/api/cards/${cardA.id}/avatar`, TINY_PNG, 'image/png')).status, 404);
  // 换回 PNG，后面导出 PNG 用
  r = await upload(who.a, `/api/cards/${cardA.id}/avatar`, TINY_PNG, 'image/png');
  assert.equal(r.status, 200);
});

let pubCard;
test('公开卡：社区可见、他人可开聊 / fork（新卡私有、标改编自）/ 导出；成人卡对没开成人内容的人 403 且社区不显示', async () => {
  let r = await who.a.patch(`/api/cards/${cardA.id}`, { visibility: 'public' });
  assert.equal(r.status, 200);
  pubCard = r.json.card;
  const com = (await who.b.get('/api/community')).json;
  assert.deepEqual(com.items.map((x) => x.id), [cardA.id]);
  assert.equal(com.items[0].author.name, '爱丽丝');
  assert.equal((await who.b.get('/api/community?q=艾')).json.items.length, 1);
  assert.equal((await who.b.get('/api/community?q=%25')).json.items.length, 0, 'LIKE 转义');
  assert.equal((await who.b.get('/api/community?tag=奇幻')).json.items.length, 1);
  assert.equal((await who.b.get('/api/community?kind=scenario')).json.items.length, 0);
  assert.equal((await who.b.get('/api/community?sort=bad')).status, 400);
  r = await who.b.get(`/api/cards/${cardA.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.card.is_owner, false);
  assert.equal((await getRaw(who.b, pubCard.avatar)).status, 200);
  // fork
  r = await who.b.post('/api/cards/fork', { from: 'user', id: cardA.id });
  assert.equal(r.status, 200, r.text);
  const f = r.json.card;
  assert.equal(f.name, '艾琳（改编）');
  assert.equal(f.visibility, 'private');
  assert.deepEqual(f.forked_from, { type: 'user', path: null, id: cardA.id, name: '艾琳', author: '爱丽丝' });
  assert.equal(f.data.character_book.entries.length, 5);
  assert.notEqual(f.avatar, pubCard.avatar, '头像复制成新文件');
  assert.equal((await getRaw(who.b, f.avatar)).status, 200);
  assert.equal((await getRaw(who.a, f.avatar)).status, 404, 'fork 出来的私有卡头像原作者也看不到');
  // 成人卡
  r = await who.a.post('/api/cards', { name: '成人卡', nsfw: true, visibility: 'public', first_mes: 'x' });
  const adult = r.json.card;
  assert.equal((await who.b.get(`/api/cards/${adult.id}`)).status, 403);
  assert.equal((await who.b.post('/api/chats', { user_card_id: adult.id })).status, 403);
  assert.equal((await who.b.post('/api/cards/fork', { from: 'user', id: adult.id })).status, 403);
  assert.ok(!(await who.b.get('/api/community')).json.items.some((x) => x.id === adult.id));
  assert.ok((await who.a.get('/api/community')).json.items.some((x) => x.id === adult.id), '开了成人内容的人能看到');
  await who.a.del(`/api/cards/${adult.id}`);
});

test('chub 卡 fork：复制 definition 与 embedded lorebook、下载头像存本地、标原作者；成人 chub 卡 403', async () => {
  const r = await who.b.post('/api/cards/fork', { from: 'chub', path: 'tester/lore-girl' });
  assert.equal(r.status, 200, r.text);
  const c = r.json.card;
  assert.equal(c.name, 'Lore Girl（改编）');
  assert.deepEqual(c.forked_from, { type: 'chub', path: 'tester/lore-girl', id: null, name: 'Lore Girl', author: 'tester' });
  assert.equal(c.data.description, 'A mage');
  assert.equal(c.data.personality, 'calm');
  assert.equal(c.data.creator_notes, 'Creator notes');
  assert.deepEqual(c.data.character_book.entries.map((e) => e.content), ['CHUB-LORE-TOWER']);
  assert.match(c.avatar, /\.png$/);
  assert.equal((await getRaw(who.b, c.avatar)).status, 200);
  assert.equal((await who.b.post('/api/cards/fork', { from: 'chub', path: 'tester/spicy' })).status, 403);
  assert.equal((await who.b.post('/api/cards/fork', { from: 'chub', path: '../x' })).status, 400);
  assert.equal((await who.b.post('/api/cards/fork', { from: 'other' })).status, 400);
});

// ---------- 导入导出往返 ----------
test('导出 JSON / PNG → 再导入：字段、世界书、类型、简介原样还原；PNG 的 chara 块是 base64 V2', async () => {
  const full = (await who.a.get(`/api/cards/${cardA.id}`)).json.card;
  // JSON
  const j = await getRaw(who.a, `/api/cards/${cardA.id}/export?format=json`);
  assert.equal(j.status, 200);
  assert.match(j.headers.get('content-disposition'), /attachment; filename=".*\.json"; filename\*=UTF-8''/);
  const exported = JSON.parse(j.buf.toString('utf8'));
  assert.equal(exported.spec, 'chara_card_v2');
  assert.equal(exported.data.name, '艾琳');
  assert.equal(exported.data.creator, '爱丽丝');
  assert.equal(exported.data.character_book.entries.length, 5);
  let r = await upload(who.b, '/api/cards/import', j.buf, 'application/json');
  assert.equal(r.status, 200, r.text);
  const fromJson = r.json.card;
  // PNG
  const p = await getRaw(who.b, `/api/cards/${cardA.id}/export?format=png`); // 公开卡任何人可导出
  assert.equal(p.status, 200);
  assert.equal(p.headers.get('content-type'), 'image/png');
  const chara = readTextChunks(p.buf).get('chara');
  assert.deepEqual(JSON.parse(Buffer.from(chara, 'base64').toString('utf8')), exported);
  r = await upload(who.b, '/api/cards/import', p.buf, 'image/png');
  assert.equal(r.status, 200, r.text);
  const fromPng = r.json.card;
  assert.match(fromPng.avatar, /\.png$/, 'PNG 本身作为头像');
  for (const c of [fromJson, fromPng]) {
    assert.equal(c.name, full.name);
    assert.equal(c.tagline, full.tagline);
    assert.equal(c.kind, full.kind);
    assert.deepEqual(c.tags, full.tags);
    assert.equal(c.visibility, 'private');
    assert.deepEqual(c.data, full.data);
    assert.equal(c.forked_from, null);
  }
  // 头像不是 PNG 也能导出 PNG（用占位图）；剧情卡类型能还原
  r = await who.a.post('/api/cards', { kind: 'scenario', name: '雾城', description: '世界', visibility: 'private' });
  const sc = r.json.card;
  const p2 = await getRaw(who.a, `/api/cards/${sc.id}/export?format=png`);
  assert.equal(p2.status, 200);
  r = await upload(who.a, '/api/cards/import', p2.buf, 'image/png');
  assert.equal(r.json.card.kind, 'scenario');
  // multipart 导入、JSON 包 base64 导入
  const bd = 'B0und';
  const mp = Buffer.concat([Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="file"; filename="c.png"\r\nContent-Type: image/png\r\n\r\n`), p.buf, Buffer.from(`\r\n--${bd}--\r\n`)]);
  assert.equal((await upload(who.b, '/api/cards/import', mp, `multipart/form-data; boundary=${bd}`)).status, 200);
  assert.equal((await who.b.post('/api/cards/import', { file: `data:image/png;base64,${p.buf.toString('base64')}` })).status, 200);
  // 没有卡数据的 PNG / 乱码 / 其他图片
  assert.equal((await upload(who.b, '/api/cards/import', TINY_PNG, 'image/png')).status, 400);
  assert.equal((await upload(who.b, '/api/cards/import', Buffer.from('{oops'), 'application/json')).status, 400);
  assert.equal((await upload(who.b, '/api/cards/import', Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(20)]), 'image/jpeg')).status, 400);
  assert.equal((await who.a.get(`/api/cards/${cardA.id}/export?format=gif`)).status, 400);
});

// ---------- 自建卡开聊与世界书 ----------
let cardChat;
test('自建卡开聊：开场白宏替换；提示词带角色设定与命中的世界书；剧情卡叙述者口吻；chub 卡 embedded lorebook 也生效', async () => {
  let r = await who.b.post('/api/chats', { user_card_id: cardA.id });
  assert.equal(r.status, 200, r.text);
  cardChat = r.json.chat;
  assert.deepEqual([cardChat.character.path, cardChat.character.user_card_id, cardChat.character.name], [null, cardA.id, '艾琳']);
  const d = (await who.b.get(`/api/chats/${cardChat.id}`)).json;
  assert.equal(d.messages[0].content, '你好 鲍勃，我是 艾琳');
  assert.equal(d.character.user_card_id, cardA.id);
  r = await who.b.post(`/api/chats/${cardChat.id}/messages`, { content: 'I saw a Dragon' });
  assert.ok(parseSse(r.text).some((e) => e.event === 'done'), r.text);
  const sys = lastPrompt[0].content;
  assert.ok(sys.includes('她是艾琳'), '角色描述宏替换');
  assert.ok(sys.includes('【场景】\n城堡'));
  assert.ok(sys.includes('【相关设定】\nLORE-DRAGON\n\nLORE-CONSTANT'), sys);
  assert.ok(!sys.includes('LORE-DISABLED') && !sys.includes('LORE-CASE'));
  assert.ok(!sys.includes(NARRATOR_RULE));
  // 会话列表里能看到自建卡会话
  const items = (await who.b.get('/api/chats')).json.items;
  assert.equal(items.find((x) => x.id === cardChat.id).character.user_card_id, cardA.id);
  // 剧情卡
  const sc = (await who.b.post('/api/cards', { kind: 'scenario', name: '雾城', description: '{{user}} 来到雾城', first_mes: '雾气弥漫' })).json.card;
  const sch = (await who.b.post('/api/chats', { user_card_id: sc.id })).json.chat;
  await who.b.post(`/api/chats/${sch.id}/messages`, { content: '往前走' });
  assert.ok(lastPrompt[0].content.includes(NARRATOR_RULE));
  assert.ok(lastPrompt[0].content.includes('【世界与剧情设定】\n鲍勃 来到雾城'));
  // chub 卡的 embedded lorebook
  const cc = (await who.b.post('/api/chats', { path: 'tester/lore-girl' })).json.chat;
  await who.b.post(`/api/chats/${cc.id}/messages`, { content: 'look at the TOWER' });
  assert.ok(lastPrompt[0].content.includes('【相关设定】\nCHUB-LORE-TOWER'));
  await who.b.post(`/api/chats/${cc.id}/messages`, { content: 'nothing' });
  // 最近 4 条里仍有 tower（用户 tower / 回复 / nothing）
  assert.ok(lastPrompt[0].content.includes('CHUB-LORE-TOWER'));
});

test('卡被改成私有后：他人旧会话还在、能看，但标不可用（名字 / 标题 / 头像都脱敏，头像文件 404）、不能继续聊、不能新开；作者自己照常', async () => {
  const av = (await who.b.get(`/api/chats/${cardChat.id}`)).json.character.avatar;
  assert.ok(av, '公开时有头像');
  const mineChat = (await who.a.post('/api/chats', { user_card_id: cardA.id })).json.chat;
  await who.a.patch(`/api/cards/${cardA.id}`, { visibility: 'private' });
  const d = await who.b.get(`/api/chats/${cardChat.id}`);
  assert.equal(d.status, 200);
  // v0.9 F3：改私有也标不可用；F4：标题脱敏；F7：头像不给
  assert.deepEqual(d.json.character, { path: null, user_card_id: cardA.id, kind: 'character', name: '已不可用的角色', avatar: '', unavailable: true, tagline: '', tags: [], nsfw: false });
  assert.equal(d.json.chat.title, '已不可用的角色');
  assert.ok(!JSON.stringify(d.json.chat).includes('艾琳'));
  const li = (await who.b.get('/api/chats')).json.items.find((x) => x.id === cardChat.id);
  assert.deepEqual([li.title, li.character.name, li.character.avatar, li.character.unavailable], ['已不可用的角色', '已不可用的角色', '', true]);
  assert.equal((await getRaw(who.b, av)).status, 404, 'v0.9 F7：私有卡头像只给作者与 super');
  assert.equal((await getRaw(who.a, av)).status, 200);
  assert.equal((await getRaw(who.super, av)).status, 200);
  const r = await who.b.post(`/api/chats/${cardChat.id}/messages`, { content: '还在吗' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, '这个角色已不可用');
  assert.equal((await who.b.post('/api/chats', { user_card_id: cardA.id })).status, 404);
  // 作者本人的私有卡会话不受影响
  const mine = (await who.a.get(`/api/chats/${mineChat.id}`)).json;
  assert.deepEqual([mine.chat.title, mine.character.name, mine.character.unavailable], ['艾琳', '艾琳', undefined]);
  assert.equal(mine.character.avatar, av);
  // 脱敏仅影响用户响应，持久化的原始标题不变。
  assert.equal(db.prepare('SELECT title FROM chats WHERE id = ?').get(cardChat.id).title, '艾琳');
  // 改回公开：恢复
  await who.a.patch(`/api/cards/${cardA.id}`, { visibility: 'public' });
  const back = (await who.b.get(`/api/chats/${cardChat.id}`)).json;
  assert.deepEqual([back.chat.title, back.character.name, back.character.unavailable], ['艾琳', '艾琳', undefined]);
  assert.equal((await getRaw(who.b, av)).status, 200);
  await who.a.del(`/api/chats/${mineChat.id}`);
});

test('v0.9 F5：改编自——源卡改私有 / 删除 / 源作者账号删除后，非 super 只看到 {type, unavailable}；源作者本人（改私有时）与 super 照旧（源作者账号删除走同一判定 cardUsableBy）', async () => {
  const src = (await who.a.post('/api/cards', { name: 'F5源卡', visibility: 'public', first_mes: 'x' })).json.card;
  const fk = (await who.b.post('/api/cards/fork', { from: 'user', id: src.id })).json.card;
  await who.b.patch(`/api/cards/${fk.id}`, { visibility: 'public', name: 'F5改编' });
  const full = { type: 'user', path: null, id: src.id, name: 'F5源卡', author: '爱丽丝' };
  assert.deepEqual((await who.b.get(`/api/cards/${fk.id}`)).json.card.forked_from, full);
  await who.a.patch(`/api/cards/${src.id}`, { visibility: 'private' });
  const gone = { type: 'user', unavailable: true };
  assert.deepEqual((await who.b.get(`/api/cards/${fk.id}`)).json.card.forked_from, gone);
  assert.deepEqual((await who.b.get('/api/my/cards')).json.items.find((x) => x.id === fk.id).forked_from, gone);
  assert.deepEqual((await who.b.get('/api/community')).json.items.find((x) => x.id === fk.id).forked_from, gone);
  assert.deepEqual((await who.a.get(`/api/cards/${fk.id}`)).json.card.forked_from, full, '源卡作者本人仍能看到自己的源卡');
  assert.deepEqual((await who.super.get(`/api/cards/${fk.id}`)).json.card.forked_from, full, 'super 照旧');
  assert.deepEqual((await who.super.get(`/api/admin/cards/${fk.id}`)).json.card.forked_from, full);
  const ex = await getRaw(who.b, `/api/cards/${fk.id}/export?format=json`);
  assert.ok(!ex.buf.toString('utf8').includes('F5源卡'), '导出不带源卡信息');
  await who.a.del(`/api/cards/${src.id}`);
  assert.deepEqual((await who.a.get(`/api/cards/${fk.id}`)).json.card.forked_from, gone, '源卡删了，连源作者也只看到不可用');
  assert.deepEqual((await who.super.get(`/api/cards/${fk.id}`)).json.card.forked_from, full);
  await who.b.del(`/api/cards/${fk.id}`);
});

test('v0.9 F6：卡的会话数与社区 popular 排序不算已软删账号的会话', async () => {
  const pop = (await who.a.post('/api/cards', { name: 'F6热门', visibility: 'public', first_mes: 'x' })).json.card;
  const other = (await who.a.post('/api/cards', { name: 'F6次之', visibility: 'public', first_mes: 'x' })).json.card;
  const r = await who.super.post('/api/admin/users', { username: 'f6user', password: 'f6-pass-123' });
  const temp = await login('f6user', 'f6-pass-123');
  for (let i = 0; i < 3; i++) await temp.post('/api/chats', { user_card_id: pop.id });
  await who.b.post('/api/chats', { user_card_id: other.id });
  const rank = async () => (await who.b.get('/api/community?sort=popular')).json.items.filter((x) => x.id === pop.id || x.id === other.id).map((x) => [x.id, x.chats]);
  assert.deepEqual(await rank(), [[pop.id, 3], [other.id, 1]]);
  assert.equal((await who.a.get(`/api/cards/${pop.id}`)).json.card.chats, 3);
  assert.equal((await who.super.del(`/api/admin/users/${r.json.user.id}`)).status, 200);
  assert.deepEqual(await rank(), [[other.id, 1], [pop.id, 0]]);
  assert.equal((await who.a.get(`/api/cards/${pop.id}`)).json.card.chats, 0);
  assert.equal((await who.a.get('/api/my/cards')).json.items.find((x) => x.id === pop.id).chats, 0);
  assert.equal((await who.super.get(`/api/admin/cards/${pop.id}`)).json.card.chats, 3, 'super 自建卡管理仍按真实总数');
  await who.a.del(`/api/cards/${pop.id}`);
  await who.a.del(`/api/cards/${other.id}`);
});

// ---------- 软删除泄露矩阵 ----------
test('软删除：删消息 / 重新生成 / 删会话之后，用户侧任何接口都拿不到，404 与不存在一致；费用只算未删；数据库保留软删原因', async () => {
  const c = who.a;
  const chat = (await c.post('/api/chats', { path: 'tester/lore-girl' })).json.chat;
  const say = async (t) => parseSse((await c.post(`/api/chats/${chat.id}/messages`, { content: t })).text);
  await say('第一句');
  await say('第二句');
  let msgs = (await c.get(`/api/chats/${chat.id}`)).json.messages;
  assert.equal(msgs.length, 5); // 开场白 + 2×(用户+回复)
  const cost5 = (await c.get(`/api/chats/${chat.id}`)).json.chat.cost_usd;
  // 重新生成：旧回复软删
  const oldReply = msgs[4];
  const rg = parseSse((await c.post(`/api/chats/${chat.id}/regenerate`)).text);
  assert.ok(rg.some((e) => e.event === 'done'));
  msgs = (await c.get(`/api/chats/${chat.id}`)).json.messages;
  assert.equal(msgs.length, 5);
  assert.ok(!msgs.some((m) => m.id === oldReply.id), '被替换的回复不再出现');
  // 删第二轮（用户消息及其后）
  const second = msgs[3];
  assert.equal((await c.del(`/api/messages/${second.id}`)).status, 200);
  msgs = (await c.get(`/api/chats/${chat.id}`)).json.messages;
  assert.equal(msgs.length, 3);
  const nf = await c.patch('/api/messages/99999999', { content: 'x' });
  for (const mid of [second.id, oldReply.id]) {
    const p = await c.patch(`/api/messages/${mid}`, { content: '改' });
    assert.equal(p.status, 404);
    assert.equal(p.text, nf.text, '已删消息与不存在一致');
    assert.equal((await c.del(`/api/messages/${mid}`)).text, (await c.del('/api/messages/99999999')).text);
  }
  // 历史里没有已删内容
  await say('第三句');
  assert.ok(!lastPrompt.some((m) => m.content.includes('第二句')), '提示词历史不含已删消息');
  // 会话费用：用户侧只算未删
  const live = db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS s FROM messages WHERE chat_id = ? AND deleted_at IS NULL').get(chat.id).s;
  const all = db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS s FROM messages WHERE chat_id = ?').get(chat.id).s;
  assert.ok(all > live);
  const userCost = (await c.get(`/api/chats/${chat.id}`)).json.chat.cost_usd;
  assert.equal(userCost, Math.round(live * 1e6) / 1e6);
  assert.equal((await c.get('/api/chats')).json.items.find((x) => x.id === chat.id).cost_usd, userCost);
  assert.ok(cost5 >= 0);
  // 测试数据库验证软删除保留原因。
  const reasons = db.prepare('SELECT deleted_reason FROM messages WHERE chat_id = ? AND deleted_at IS NOT NULL').all(chat.id).map((m) => m.deleted_reason).sort();
  assert.deepEqual(reasons, ['regenerate', 'user_delete', 'user_delete']);
  // 删会话
  const usageBefore = db.prepare('SELECT SUM(messages) AS n FROM usage_daily WHERE user_id = ?').get(id.a).n;
  assert.equal((await c.del(`/api/chats/${chat.id}`)).status, 200);
  const missing = 99999999;
  for (const [m, p, body] of [
    ['GET', `/api/chats/${chat.id}`], ['DELETE', `/api/chats/${chat.id}`], ['PATCH', `/api/chats/${chat.id}`, { model_id: null }],
    ['POST', `/api/chats/${chat.id}/messages`, { content: 'x' }], ['POST', `/api/chats/${chat.id}/regenerate`],
  ]) {
    const r = await c.req(m, p, body);
    const r404 = await c.req(m, p.replace(String(chat.id), String(missing)), body);
    assert.equal(r.status, 404, `${m} ${p}`);
    assert.equal(r.text, r404.text, `${m} ${p} 与不存在一致`);
  }
  const anyMsg = db.prepare('SELECT id FROM messages WHERE chat_id = ? ORDER BY id LIMIT 1').get(chat.id).id;
  assert.equal((await c.patch(`/api/messages/${anyMsg}`, { content: 'x' })).text, nf.text);
  const list = (await c.get('/api/chats')).text;
  assert.ok(!JSON.parse(list).items.some((x) => x.id === chat.id));
  for (const t of ['第一句', '第三句']) assert.ok(!list.includes(t));
  // 用量照算全部
  assert.equal(db.prepare('SELECT SUM(messages) AS n FROM usage_daily WHERE user_id = ?').get(id.a).n, usageBefore);
  assert.ok(db.prepare('SELECT deleted_at FROM chats WHERE id = ?').get(chat.id).deleted_at);
  const stored = db.prepare('SELECT deleted_at, deleted_reason FROM messages WHERE chat_id = ?').all(chat.id);
  assert.ok(stored.every((m) => m.deleted_at));
  assert.ok(stored.some((m) => m.deleted_reason === 'chat_delete'));
  // 行都还在（软删）
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(chat.id).n >= 7);
});

test('编辑消息：本人只见改后内容、id 不变；删除后不可见；他人无法读取', async () => {
  const c = who.a;
  const chat = (await c.post('/api/chats', { path: 'tester/lore-girl' })).json.chat;
  parseSse((await c.post(`/api/chats/${chat.id}/messages`, { content: 'EDIT-ORIG-hello' })).text);
  let msgs = (await c.get(`/api/chats/${chat.id}`)).json.messages;
  const um = msgs.find((m) => m.content === 'EDIT-ORIG-hello');
  let p = await c.patch(`/api/messages/${um.id}`, { content: 'EDIT-V2' });
  assert.equal(p.status, 200);
  assert.equal(p.json.message.id, um.id);
  assert.equal(p.json.message.content, 'EDIT-V2');
  assert.ok(!('edits' in p.json.message) && !('edited_at' in p.json.message), '用户侧不暴露编辑历史');
  // 重复保存同内容仍成功
  assert.equal((await c.patch(`/api/messages/${um.id}`, { content: 'EDIT-V2' })).status, 200);
  p = await c.patch(`/api/messages/${um.id}`, { content: '.' });
  assert.equal(p.status, 200);
  const userText = (await c.get(`/api/chats/${chat.id}`)).text;
  assert.ok(!userText.includes('EDIT-ORIG-hello') && !userText.includes('EDIT-V2'), '用户侧拿不到原文');
  msgs = JSON.parse(userText).messages;
  assert.equal(msgs.find((m) => m.id === um.id).content, '.');
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(um.id).content, '.');
  assert.equal((await c.del(`/api/messages/${um.id}`)).status, 200);
  assert.equal(db.prepare('SELECT deleted_reason FROM messages WHERE id = ?').get(um.id).deleted_reason, 'user_delete');
  const afterDelete = (await c.get(`/api/chats/${chat.id}`)).json.messages;
  assert.ok(!afterDelete.some((m) => m.id === um.id));
  assert.equal((await who.b.get(`/api/chats/${chat.id}`)).status, 404);
});

test('软删除：删自建卡 → 我的卡 / 详情 / 社区 / 导出 / fork / 开聊都没了；作者用它的会话一并隐藏；他人会话保留但不能继续；super 看得到并标已删', async () => {
  const k = (await who.a.post('/api/cards', { name: '将删卡', tagline: 'secret-tagline', tags: ['t1'], visibility: 'public', first_mes: '在' })).json.card;
  const kav = (await upload(who.a, `/api/cards/${k.id}/avatar`, TINY_PNG, 'image/png')).json.card.avatar;
  const mine = (await who.a.post('/api/chats', { user_card_id: k.id })).json.chat;
  const theirs = (await who.b.post('/api/chats', { user_card_id: k.id })).json.chat;
  assert.equal((await who.b.get(`/api/chats/${theirs.id}`)).json.character.name, '将删卡');
  assert.equal((await getRaw(who.b, kav)).status, 200);
  assert.equal((await who.a.del(`/api/cards/${k.id}`)).status, 200);
  // 他人会话里：卡的名字、简介、标签、头像都不再给出（只剩占位），头像文件也拿不到
  const gone = { path: null, user_card_id: k.id, kind: 'character', name: '已不可用的角色', avatar: '', unavailable: true };
  assert.deepEqual((await who.b.get(`/api/chats/${theirs.id}`)).json.character, { ...gone, tagline: '', tags: [], nsfw: false });
  assert.deepEqual((await who.b.get('/api/chats')).json.items.find((x) => x.id === theirs.id).character, gone);
  // v0.9 F4：标题也脱敏
  assert.equal((await who.b.get(`/api/chats/${theirs.id}`)).json.chat.title, '已不可用的角色');
  assert.equal((await who.b.get('/api/chats')).json.items.find((x) => x.id === theirs.id).title, '已不可用的角色');
  assert.equal(db.prepare('SELECT title FROM chats WHERE id = ?').get(theirs.id).title, '将删卡', '持久化原标题不变');
  assert.equal((await getRaw(who.b, kav)).status, 404);
  assert.equal((await getRaw(who.super, kav)).status, 200, 'super 卡片管理仍能看头像');
  const storedCard = (await who.super.get(`/api/admin/cards/${k.id}`)).json.card;
  assert.deepEqual([storedCard.name, storedCard.tagline, storedCard.avatar], ['将删卡', 'secret-tagline', kav], '卡片管理仍保留原始信息');
  assert.ok(!(await who.a.get('/api/my/cards')).json.items.some((x) => x.id === k.id));
  assert.ok(!(await who.b.get('/api/community')).json.items.some((x) => x.id === k.id));
  const missing = 987655;
  for (const [cl, m, p, body] of [
    [who.a, 'GET', `/api/cards/${k.id}`], [who.b, 'GET', `/api/cards/${k.id}`], [who.a, 'PATCH', `/api/cards/${k.id}`, { name: 'x' }], [who.a, 'DELETE', `/api/cards/${k.id}`],
    [who.a, 'GET', `/api/cards/${k.id}/export?format=json`], [who.b, 'POST', '/api/cards/fork', { from: 'user', id: k.id }], [who.a, 'POST', '/api/chats', { user_card_id: k.id }],
  ]) {
    const r = await cl.req(m, p, body);
    const alt = body && JSON.parse(JSON.stringify(body).replace(String(k.id), String(missing)));
    const r404 = await cl.req(m, p.replace(String(k.id), String(missing)), alt);
    assert.equal(r.status, 404, `${m} ${p}`);
    assert.equal(r.text, r404.text, `${m} ${p} 与不存在一致`);
  }
  assert.equal((await who.a.get(`/api/chats/${mine.id}`)).status, 404, '作者的会话一并软删');
  assert.ok(!(await who.a.get('/api/chats')).json.items.some((x) => x.id === mine.id));
  assert.equal((await who.b.get(`/api/chats/${theirs.id}`)).status, 200, '他人会话保留');
  assert.equal((await who.b.post(`/api/chats/${theirs.id}/messages`, { content: 'x' })).status, 403);
  // super：只读列表含已删
  const al = (await who.super.get('/api/admin/cards')).json.items.find((x) => x.id === k.id);
  assert.equal(al.deleted, 1);
  assert.equal(al.owner.username, 'alice');
  assert.ok(!(await who.super.get('/api/admin/cards?include_deleted=0')).json.items.some((x) => x.id === k.id));
  const ad = (await who.super.get(`/api/admin/cards/${k.id}`)).json.card;
  assert.ok(ad.deleted_at);
  assert.equal(ad.data.first_mes, '在');
  assert.equal((await who.super.get(`/api/cards/${k.id}`)).status, 200, 'super 经普通详情接口也能只读看');
  const storedChat = db.prepare('SELECT deleted_at, user_card_id FROM chats WHERE id = ?').get(mine.id);
  assert.ok(storedChat.deleted_at);
  assert.equal(storedChat.user_card_id, k.id);
  assert.deepEqual(db.prepare('SELECT deleted_reason FROM messages WHERE chat_id = ? ORDER BY id').all(mine.id).map((m) => m.deleted_reason), ['card_delete']);
  // super 只读：管理接口没有写方法
  for (const m of ['POST', 'PATCH', 'DELETE']) assert.equal((await who.super.req(m, `/api/admin/cards/${k.id}`, m === 'DELETE' ? undefined : {})).status, 405);
  // 普通用户 / admin 不能调 super 只读接口
  assert.equal((await who.a.get('/api/admin/cards')).status, 403);
});

test('软删除：删账号 → 不能登录（与不存在一致）、旧登录立即失效、用户名仍占用；他的公开卡从社区隐藏；账号管理仍显示删除状态', async () => {
  const r = await who.super.post('/api/admin/users', { username: 'gone', password: 'gone-pass-1' });
  const gid = r.json.user.id;
  const g = await login('gone', 'gone-pass-1');
  const k = (await g.post('/api/cards', { name: '遗作', visibility: 'public' })).json.card;
  const gc = (await g.post('/api/chats', { path: 'tester/lore-girl' })).json.chat;
  const bc = (await who.b.post('/api/chats', { user_card_id: k.id })).json.chat;
  assert.equal(bc.title, '遗作');
  assert.ok((await who.b.get('/api/community')).json.items.some((x) => x.id === k.id));
  assert.equal((await who.super.del(`/api/admin/users/${gid}`)).status, 200);
  assert.equal((await g.get('/api/me')).json.user, null);
  const bad = await new Client(base).post('/api/login', { username: 'gone', password: 'gone-pass-1' });
  const none = await new Client(base).post('/api/login', { username: 'nobody-here', password: 'gone-pass-1' });
  assert.equal(bad.status, 401);
  assert.equal(bad.text, none.text);
  assert.equal((await who.super.post('/api/admin/users', { username: 'gone', password: 'gone-pass-1' })).status, 409);
  assert.ok(!(await who.b.get('/api/community')).json.items.some((x) => x.id === k.id));
  assert.equal((await who.b.get(`/api/cards/${k.id}`)).status, 404);
  // v0.9 F4：作者账号删了，别人用它的会话标题与角色都脱敏
  const bv = (await who.b.get(`/api/chats/${bc.id}`)).json;
  assert.deepEqual([bv.chat.title, bv.character.name, bv.character.unavailable], ['已不可用的角色', '已不可用的角色', true]);
  assert.equal((await who.b.get('/api/chats')).json.items.find((x) => x.id === bc.id).title, '已不可用的角色');
  assert.equal(db.prepare('SELECT user_id FROM chats WHERE id = ?').get(gc.id).user_id, gid, '软删账号保留会话所属关系');
  assert.equal((await who.super.get('/api/admin/users')).json.items.find((u) => u.id === gid).deleted, 1);
});

// ---------- 安全加固（v0.8 修复）----------
test('PNG 文本块：只解压 chara / ccv3，其他 zTXt 不碰；解压总量有上限，炸弹块被拒；同名只试一次', () => {
  const bomb = zlib.deflateSync(Buffer.alloc(16 * 1024 * 1024, 0x41)); // 约 16KB → 解压 16MB
  const b64 = Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data: { name: 'Z', first_mes: 'hi' } })).toString('base64');
  const chunks = readChunks(TINY_PNG);
  const many = [];
  for (let i = 0; i < 60; i++) many.push(ztxt(`junk${i}`, bomb));
  const png = writeChunks([chunks[0], ...many, { type: 'tEXt', data: Buffer.from(`chara\0${b64}`, 'latin1') }, ...chunks.slice(1)]);
  const rss0 = process.memoryUsage().rss;
  const t0 = Date.now();
  const got = readTextChunks(png, { keywords: ['ccv3', 'chara'] });
  assert.deepEqual([...got.keys()], ['chara']);
  assert.ok(Date.now() - t0 < 1000, '不解压无关块');
  assert.ok(process.memoryUsage().rss - rss0 < 64 * 1024 * 1024, '内存不涨');
  // chara 本身是炸弹：超过总预算 → 抛错
  const charaBomb = writeChunks([chunks[0], ztxt('chara', bomb), ...chunks.slice(1)]);
  assert.throws(() => readTextChunks(charaBomb, { keywords: ['chara'] }), /过大/);
  // 同名坏块很多：只试第一块，其余跳过（不会被反复解压）
  const bad = Buffer.from([0x78, 0x9c, 1, 2, 3]);
  const many2 = writeChunks([chunks[0], ...Array.from({ length: 50 }, () => ztxt('chara', bad)), ...chunks.slice(1)]);
  assert.equal(readTextChunks(many2, { keywords: ['chara'] }).size, 0);
  // 正常的 zTXt chara 仍能读
  const okZ = writeChunks([chunks[0], ztxt('chara', zlib.deflateSync(Buffer.from(b64, 'latin1'))), ...chunks.slice(1)]);
  assert.equal(readTextChunks(okZ, { keywords: ['chara'] }).get('chara'), b64);
});

test('导入 zTXt 炸弹 PNG：400 或成功但内存有界（服务不被拖垮）', async () => {
  const bomb = zlib.deflateSync(Buffer.alloc(16 * 1024 * 1024, 0x41));
  const b64 = Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data: { name: '炸弹测试', first_mes: 'hi' } })).toString('base64');
  const chunks = readChunks(TINY_PNG);
  const many = Array.from({ length: 30 }, (_, i) => ztxt(`k${i}`, bomb));
  const png = writeChunks([chunks[0], ...many, { type: 'tEXt', data: Buffer.from(`chara\0${b64}`, 'latin1') }, ...chunks.slice(1)]);
  const rss0 = process.memoryUsage().rss;
  let r = await upload(who.b, '/api/cards/import', png, 'image/png');
  assert.equal(r.status, 200, r.text);
  assert.ok(process.memoryUsage().rss - rss0 < 128 * 1024 * 1024, '内存增长有界');
  // 存下来的头像不带任何文本块（原始 chara 与垃圾 zTXt 都去掉）
  const av = await getRaw(who.b, r.json.card.avatar);
  assert.ok(!readChunks(av.buf).some((c) => /^(tEXt|zTXt|iTXt)$/.test(c.type)));
  await who.b.del(`/api/cards/${r.json.card.id}`);
  // chara 本身是炸弹 → 400
  const charaBomb = writeChunks([chunks[0], ztxt('chara', bomb), ...chunks.slice(1)]);
  r = await upload(who.b, '/api/cards/import', charaBomb, 'image/png');
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'PNG 文件已损坏或过大');
});

test('头像去元数据：导入 PNG 的原始卡数据、JPEG 的 EXIF/GPS/XMP/注释/尾巴、WebP 的 EXIF/XMP 都不落盘；JPEG 方向保留', async () => {
  // 纯函数
  const png = withTextChunk(withTextChunk(TINY_PNG, 'chara', 'T1JJR0lOQUwtU0VDUkVU'), 'Comment', 'PNG-SECRET');
  const sp = stripPngMetadata(png);
  assert.ok(!has(sp, 'PNG-SECRET') && !has(sp, 'chara'));
  assert.deepEqual(readChunks(sp).map((c) => c.type), readChunks(TINY_PNG).map((c) => c.type));
  const jpg = makeJpeg({ orientation: 6, meta: true });
  const sj = stripJpegMetadata(jpg);
  for (const t of ['GPS-SECRET', 'XMP-SECRET', 'COMMENT-SECRET', 'TRAILER-SECRET']) assert.ok(!has(sj, t), t);
  assert.ok(sj.includes(Buffer.from([0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6])), '方向 6 保留');
  assert.ok(sj.includes(SCAN) && sj.subarray(-2).equals(Buffer.from([0xff, 0xd9])));
  assert.ok(stripJpegMetadata(makeJpeg()).equals(makeJpeg()), '没有元数据的 JPEG 原样');
  assert.throws(() => stripJpegMetadata(Buffer.concat([Buffer.from([0xff, 0xd8]), APP0, DQT])), /截断/);
  const sw = stripWebpMetadata(makeWebp({ meta: true }));
  assert.ok(!has(sw, 'EXIF-SECRET') && !has(sw, 'XMP-SECRET'));
  assert.equal(sw.readUInt32LE(4), sw.length - 8, 'RIFF 长度正确');
  assert.equal(sw[20], 0x10, 'VP8X 只剩 alpha 标志');
  assert.ok(stripWebpMetadata(makeWebp()).equals(makeWebp()));
  assert.throws(() => sanitizeAvatar(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(40, 2)])), (e) => e.status === 400);
  // HTTP：导入 PNG → 改掉敏感设定并公开 → 别人拿到的头像里没有原始卡
  const secretCard = Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data: { name: '原卡', description: 'ORIGINAL-SECRET-TEXT', first_mes: 'hi' } })).toString('base64');
  let r = await upload(who.a, '/api/cards/import', withTextChunk(TINY_PNG, 'chara', secretCard), 'image/png');
  assert.equal(r.status, 200, r.text);
  const imp = r.json.card;
  await who.a.patch(`/api/cards/${imp.id}`, { description: 'cleaned', visibility: 'public' });
  let got = await getRaw(who.b, imp.avatar);
  assert.equal(got.status, 200);
  assert.ok(!has(got.buf, secretCard.slice(0, 40)) && !has(got.buf, 'chara'), '头像里没有原始 chara');
  // 导出 PNG 只含当前（已清理）的卡
  got = await getRaw(who.b, `/api/cards/${imp.id}/export?format=png`);
  assert.ok(!Buffer.from(readTextChunks(got.buf).get('chara'), 'base64').toString('utf8').includes('ORIGINAL-SECRET-TEXT'));
  // 上传 JPEG / WebP：服务端存的是去过元数据的
  r = await upload(who.a, `/api/cards/${imp.id}/avatar`, makeJpeg({ orientation: 6, meta: true }), 'image/jpeg');
  assert.equal(r.status, 200, r.text);
  got = await getRaw(who.b, r.json.card.avatar);
  assert.ok(got.buf.equals(sj));
  r = await upload(who.a, `/api/cards/${imp.id}/avatar`, makeWebp({ meta: true }), 'image/webp');
  got = await getRaw(who.b, r.json.card.avatar);
  assert.ok(got.buf.equals(sw));
  // 结构坏的图片：400
  assert.equal((await upload(who.a, `/api/cards/${imp.id}/avatar`, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]), 'image/jpeg')).status, 400);
  // fork：复制的头像同样是清理过的
  r = await who.b.post('/api/cards/fork', { from: 'user', id: imp.id });
  got = await getRaw(who.b, r.json.card.avatar);
  assert.ok(got.buf.equals(sw));
  await who.b.del(`/api/cards/${r.json.card.id}`);
  await who.a.del(`/api/cards/${imp.id}`);
});

test('防滥用：每分钟建卡 / 传头像次数、保留卡数、累计建卡数（含已删）都有上限，参数可调，super 不受限', async () => {
  const c = await (async () => {
    await who.super.post('/api/admin/users', { username: 'quota', password: 'quota-pass-1' });
    return login('quota', 'quota-pass-1');
  })();
  const set = (b) => who.super.patch('/api/admin/settings', b);
  let r = await set({ card_writes_per_minute: 3, card_max_per_user: 0, card_max_total_per_user: 0 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.settings.card_writes_per_minute, 3);
  assert.equal((await set({ card_writes_per_minute: -1 })).status, 400);
  assert.equal((await set({ card_max_per_user: 'abc' })).status, 400);
  assert.equal((await who.a.patch('/api/admin/settings', { card_max_per_user: 1 })).status, 403);
  const ids = [];
  for (let i = 0; i < 3; i++) { r = await c.post('/api/cards', { name: `q${i}` }); assert.equal(r.status, 200, r.text); ids.push(r.json.card.id); }
  r = await c.post('/api/cards', { name: 'q3' });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, '操作太频繁，请稍后再试');
  assert.equal((await upload(c, '/api/cards/import', Buffer.from('{}'), 'application/json')).status, 429);
  assert.equal((await c.post('/api/cards/fork', { from: 'user', id: ids[0] })).status, 429);
  assert.equal((await upload(c, `/api/cards/${ids[0]}/avatar`, TINY_PNG, 'image/png')).status, 429);
  assert.equal((await c.patch(`/api/cards/${ids[0]}`, { tagline: '改字不限' })).status, 200, '修改不计次');
  for (let i = 0; i < 5; i++) assert.equal((await who.super.post('/api/cards', { name: `s${i}` })).status, 200, 'super 不受限');
  // 保留卡数（不含已删）
  await set({ card_writes_per_minute: 0, card_max_per_user: 3 });
  r = await c.post('/api/cards', { name: 'q4' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, '每个账号最多保存 3 张卡，请先删除不用的卡');
  assert.equal((await c.post('/api/cards/fork', { from: 'user', id: ids[0] })).status, 400);
  assert.equal((await c.del(`/api/cards/${ids[2]}`)).status, 200);
  assert.equal((await c.post('/api/cards', { name: 'q5' })).status, 200, '删了就能再建');
  // 累计（含已删）：提示里不提「已删除」
  await set({ card_max_per_user: 0, card_max_total_per_user: 4 });
  r = await c.post('/api/cards', { name: 'q6' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, '已达到建卡数量上限，请联系管理员');
  assert.equal((await upload(c, '/api/cards/import', Buffer.from(JSON.stringify({ name: 'imp', first_mes: 'x' })), 'application/json')).status, 400);
  // 0 = 不限；默认值
  r = await set({ card_max_total_per_user: 0, card_writes_per_minute: 0 });
  assert.deepEqual([r.json.settings.card_max_per_user, r.json.settings.card_max_total_per_user], [0, 0]);
  assert.equal((await c.post('/api/cards', { name: 'q7' })).status, 200);
  db.prepare("DELETE FROM settings WHERE key IN ('card_max_per_user', 'card_max_total_per_user')").run();
  assert.deepEqual([(await who.super.get('/api/admin/settings')).json.settings.card_max_per_user, (await who.super.get('/api/admin/settings')).json.settings.card_max_total_per_user], [200, 1000]);
  const logs = db.prepare("SELECT detail_json FROM logs WHERE kind = 'settings.update'").all().map((x) => x.detail_json).join('\n');
  assert.ok(logs.includes('每分钟建卡') && logs.includes('累计建卡上限'), '改参数写系统日志');
});

// ---------- 迁移 ----------
test('迁移 v5 → v6：带数据升级，旧数据一条不丢；chats 可存自建卡会话；外键仍生效；会话 id 不复用；幂等', () => {
  const d = path.join(dir, 'mig6'); mkdirSync(d, { recursive: true });
  const file = path.join(d, 'aichat.sqlite');
  let x = openDb(file, { upTo: 5 });
  assert.equal(x.prepare('PRAGMA user_version').get().user_version, 5);
  const t = '2026-10-01T00:00:00.000Z';
  x.prepare("INSERT INTO users(username, password_hash, display_name, is_admin, role, created_at) VALUES ('admin', 'h', '超管', 1, 'super', ?)").run(t);
  x.prepare("INSERT INTO users(username, password_hash, display_name, role, created_by, created_at) VALUES ('amy', 'h2', '艾米', 'tenant', 1, ?)").run(t);
  x.prepare("INSERT INTO characters(chub_path, name, fetched_at) VALUES ('a/b', '角色', ?)").run(t);
  for (let i = 0; i < 3; i++) x.prepare("INSERT INTO chats(user_id, character_id, title, model_id, created_at, updated_at) VALUES (2, 1, ?, NULL, ?, ?)").run(`会话${i}`, t, t);
  x.prepare("INSERT INTO messages(chat_id, role, content, created_at, tokens_in, tokens_out, cost_usd, cost_source) VALUES (1, 'assistant', '你好', ?, 3, 4, 0.001, 'estimate')").run(t);
  x.prepare("INSERT INTO messages(chat_id, role, content, created_at) VALUES (2, 'user', '嗨', ?)").run(t);
  x.prepare('DELETE FROM chats WHERE id = 3').run(); // v0.6 的硬删：id 3 已用过
  x.prepare("INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES ('tk', 2, ?, 9999999999999)").run(t);
  const tables = ['users', 'characters', 'chats', 'messages', 'usage_daily', 'models', 'sessions', 'logs'];
  const snap = (db2, tb) => db2.prepare(`SELECT * FROM ${tb} ORDER BY rowid`).all().map((r) => ({ ...r }));
  const before = Object.fromEntries(tables.map((tb) => [tb, snap(x, tb)]));
  x.close();

  x = openDb(file, { upTo: 6 });
  assert.equal(x.prepare('PRAGMA user_version').get().user_version, 6);
  assert.equal(SCHEMA_VERSION, 12);
  const NEW = { users: ['deleted_at'], chats: ['user_card_id', 'deleted_at'], messages: ['deleted_at', 'deleted_reason'] };
  for (const tb of tables) {
    const rows = snap(x, tb).map((r) => { const o = { ...r }; for (const c of NEW[tb] || []) { assert.equal(o[c], null, `${tb}.${c}`); delete o[c]; } return o; });
    if (tb === 'logs') assert.deepEqual(rows.slice(0, before.logs.length), before.logs);
    else assert.deepEqual(rows, before[tb], `${tb} 不变`);
  }
  const mig = x.prepare("SELECT detail_json FROM logs WHERE kind = 'system.migrate' ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual(JSON.parse(mig.detail_json), { from: 5, to: 6 });
  assert.equal(x.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(x.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(x.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chats' ORDER BY name").all().map((r) => r.name),
    ['idx_chats_card', 'idx_chats_updated', 'idx_chats_user']);
  // 自建卡会话：character_id 为空、user_card_id 有值
  const card = Number(x.prepare("INSERT INTO user_cards(owner_id, name, created_at, updated_at) VALUES (2, '卡', ?, ?)").run(t, t).lastInsertRowid);
  const newChat = Number(x.prepare('INSERT INTO chats(user_id, character_id, user_card_id, title, created_at, updated_at) VALUES (2, NULL, ?, ?, ?, ?)').run(card, '卡', t, t).lastInsertRowid);
  assert.ok(newChat > 3, `会话 id 不复用被硬删的 3（得到 ${newChat}）`);
  // 二选一约束、外键
  assert.throws(() => x.prepare("INSERT INTO chats(user_id, character_id, user_card_id, title, created_at, updated_at) VALUES (2, NULL, NULL, 'x', ?, ?)").run(t, t));
  assert.throws(() => x.prepare("INSERT INTO chats(user_id, character_id, user_card_id, title, created_at, updated_at) VALUES (2, 1, ?, 'x', ?, ?)").run(card, t, t));
  assert.throws(() => x.prepare("INSERT INTO messages(chat_id, role, content, created_at) VALUES (424242, 'user', 'x', ?)").run(t), /FOREIGN KEY/);
  // messages 对 chats 的级联仍指向新表
  const fk = x.prepare('PRAGMA foreign_key_list(messages)').all();
  assert.equal(fk[0].table, 'chats');
  x.close();
  // 幂等
  x = openDb(file, { upTo: 6 });
  assert.equal(x.prepare("SELECT COUNT(*) AS n FROM logs WHERE kind = 'system.migrate'").get().n, 1 + before.logs.filter((l) => l.kind === 'system.migrate').length);
  assert.equal(x.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
  x.close();
});

test('迁移 v6 失败整体回滚：库停在 v5，chats 原样、外键重新打开', () => {
  const d = path.join(dir, 'mig6-fail'); mkdirSync(d, { recursive: true });
  const file = path.join(d, 'aichat.sqlite');
  let x = openDb(file, { upTo: 5 });
  x.prepare("INSERT INTO users(username, password_hash, created_at) VALUES ('u', 'h', '2026-10-01T00:00:00.000Z')").run();
  x.exec("CREATE TABLE user_cards_conflict (x); ALTER TABLE users ADD COLUMN deleted_at TEXT NULL;"); // 让 v6 的 ALTER 撞列失败
  x.close();
  assert.throws(() => openDb(file), /duplicate column/);
  x = openDb(file, { upTo: 5 });
  assert.equal(x.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal(x.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('user_cards', 'chats_v6')").get().n, 0);
  assert.ok(/character_id INTEGER NOT NULL/.test(x.prepare("SELECT sql FROM sqlite_master WHERE name = 'chats'").get().sql));
  assert.equal(x.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  x.close();
});
