// v1.0（契约 §19 / §20）：角色卡完整翻译（叶子编号 → 分批 → 同构回填 → 逐叶校验）、并发只翻一次、源卡变化重翻、
// 失败重试、列表批量翻译 + 标签译名表、中文名搜索、聊天用中文设定、翻译模型设置；
// 本会话设定（override 生效与恢复、同时保存到原卡、本人查看差异）、改错字后从这里重新回复（rewind 权限与效果）。
// 进程内起 app，chub 与模型都是假的（不出网、不调真模型）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { openDb } from '../server/db.mjs';
import { hashPassword } from '../server/auth.mjs';
import { createApp } from '../server/app.mjs';
import { HttpError, nowIso } from '../server/util.mjs';
import { nodeToCard } from '../server/chub.mjs';
import {
  collectLeaves, translateDefinition, splitSegments, checkLeaf, parseIdJson, needsTranslation, packBatches, LIST_BATCH_MAX,
} from '../server/translate.mjs';
import { diffOverride, applyOverride, pickFields } from '../server/chat-settings.mjs';
import { tmpDir, cleanupTmp, listenFree, Client, parseSse } from './helpers.mjs';

const PORTS = [44983, 44984, 44985, 44986, 44987, 44988, 44989, 44982];
const MACRO = /\{\{[^{}]*\}\}|<\s*(?:bot|user|char)\s*>/gi;
const DICT = { Mira: '米拉', 'A brave knight': '一位勇敢的骑士', Fantasy: '奇幻', Knight: '骑士', tower: '塔楼', Brave: '勇敢', Rover: '漫游者', 'A wanderer': '一位流浪者' };

/** 假翻译：词典命中直接给；否则把英文单词换成「文」，占位符 / 星号 / 换行原样保留。带特殊记号的制造各种失败。 */
function fakeTranslate(v) {
  if (DICT[v]) return DICT[v];
  if (v.includes('BREAKMACRO')) return v.replace(MACRO, '').replace(/[A-Za-z]+/g, '文');
  if (v.includes('BREAKSTAR')) return v.replace(/\*/g, '').replace(/[A-Za-z]+/g, '文');
  if (v.includes('BREAKNL')) return v.replace(/\n/g, ' ').replace(/[A-Za-z]+/g, '文');
  const parts = v.split(/(\{\{[^{}]*\}\}|<\s*(?:bot|user|char)\s*>)/gi);
  return parts.map((p, i) => (i % 2 ? p : p.replace(/[A-Za-z]+/g, '文'))).join('');
}

const calls = []; // 每次 complete：{ input, model_id }
let failCards = true;
let failRefused = false; // true：FAILCARD 按「拒答」失败（可拆批隔离）；false：按上游不可用（不拆批，见第 2 轮复核）
let gate = null; // streamChat 卡住（模拟生成中）
let streamDelayMs = 0;
let lastPrompt = null;
const fakeLlm = {
  async streamChat(messages, { onDelta }) {
    lastPrompt = messages;
    if (gate) await gate;
    if (streamDelayMs) await new Promise((r) => setTimeout(r, streamDelayMs));
    onDelta('好的');
    return { text: '好的', tokens_in: 10, tokens_out: 5, usage: true, model: 'fake' };
  },
  async complete(messages, { model } = {}) {
    const raw = messages.at(-1).content;
    let input = null;
    try { input = JSON.parse(raw); } catch { /* 开场白单独翻译 */ }
    calls.push({ input, raw, model_id: model?.id ?? null, system: messages[0].content });
    await new Promise((r) => setTimeout(r, 30));
    if (!input) return { text: fakeTranslate(raw), tokens_in: 10, tokens_out: 10, usage: true, model: 'fake', model_id: model?.id };
    if (failCards && Object.values(input).some((v) => String(v).includes('FAILCARD'))) {
      throw failRefused ? new HttpError(502, '模型拒绝了这个请求', 'refused') : new HttpError(502, '对话服务暂时不可用，请稍后重试', 'upstream');
    }
    const out = {};
    for (const [k, v] of Object.entries(input)) if (!String(v).includes('MISSING')) out[k] = fakeTranslate(String(v));
    return { text: '```json\n' + JSON.stringify(out) + '\n```', tokens_in: 100, tokens_out: 50, usage: true, model: 'fake', model_id: model?.id };
  },
};

const DEF_MIRA = {
  name: 'Mira',
  personality: 'A brave knight. *smiles*\nShe guards {{user}}.',
  tavern_personality: 'Brave',
  scenario: 'At the old tower.',
  first_message: 'Hello {{user}}! *waves*',
  alternate_greetings: ['Hi there {{user}}', '你好呀'],
  example_dialogs: '<START>\n{{char}}: Hello',
  system_prompt: '',
  post_history_instructions: 'Stay in character',
  description: 'Creator notes here',
  embedded_lorebook: { name: 'W', entries: [{ id: 1, keys: ['tower'], content: 'The tower is old.', enabled: true, insertion_order: 1 }] },
  extensions: { depth_prompt: { prompt: 'keep me', depth: 4 } },
  id: 12345,
};
const NODES = {
  'tester/mira': { fullPath: 'tester/mira', name: 'Mira', tagline: 'A brave knight', avatar_url: '', topics: ['Fantasy', 'Knight'], nsfw_image: false, definition: DEF_MIRA },
  'tester/rover': { fullPath: 'tester/rover', name: 'Rover', tagline: 'A wanderer', avatar_url: '', topics: ['Fantasy'], nsfw_image: false,
    definition: { name: 'Rover', personality: 'Quiet BREAKMACRO {{user}} friend', first_message: 'Hey {{user}}', scenario: 'Road *dust*' } },
  'tester/failer': { fullPath: 'tester/failer', name: '失败者', tagline: '', avatar_url: '', topics: [], nsfw_image: false,
    definition: { name: '失败者', first_message: 'FAILCARD hello there', personality: 'FAILCARD calm' } },
  'tester/hot-nsfw': { fullPath: 'tester/hot-nsfw', name: 'Spicy', tagline: 'adult', avatar_url: '', topics: ['NSFW'], nsfw_image: true, definition: { name: 'Spicy', first_message: 'hey' } },
};
const extraList = Array.from({ length: 60 }, (_, i) => ({ fullPath: `bulk/c${i}`, name: `Bulk ${i}`, tagline: `Tag line ${i}`, avatar_url: '', topics: ['Knight'], nsfw_image: false }));
const fakeChub = {
  async search({ nsfw }) {
    const nodes = [...Object.values(NODES), ...extraList].filter((n) => nsfw || !n.nsfw_image);
    return { items: nodes.map(nodeToCard), page: 1, has_more: false };
  },
  async character(p) { if (!NODES[p]) throw new HttpError(404, '没有找到这个角色'); return structuredClone(NODES[p]); },
};

let dir, server, base, db, app;
const id = {};
const who = {};
const mids = {};

async function login(u, p) {
  const c = new Client(base);
  const r = await c.post('/api/login', { username: u, password: p });
  assert.equal(r.status, 200, `${u}：${r.text}`);
  return c;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function detailDone(c, p) {
  let r = await c.get(`/api/characters/${p}`);
  for (let i = 0; i < 200 && r.json?.character?.translate_status === 'pending'; i++) { await sleep(15); r = await c.get(`/api/characters/${p}`); }
  return r;
}
const cardCalls = (word) => calls.filter((x) => x.input && Object.values(x.input).some((v) => String(v).includes(word)));

before(async () => {
  dir = tmpDir('unit-v10');
  db = openDb(path.join(dir, 'aichat.sqlite'));
  const ins = db.prepare('INSERT INTO users(username, password_hash, display_name, is_admin, role, nsfw_enabled, persona_name, persona_desc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  id.super = Number(ins.run('root', hashPassword('root-pass-1'), '超管', 1, 'super', 1, '', '', nowIso()).lastInsertRowid);
  id.admin = Number(ins.run('ops', hashPassword('ops-pass-11'), '管理员', 1, 'admin', 0, '', '', nowIso()).lastInsertRowid);
  id.a = Number(ins.run('alice', hashPassword('alice-pass-1'), '爱丽丝', 0, 'tenant', 1, '小爱', '一名旅行者', nowIso()).lastInsertRowid);
  id.b = Number(ins.run('bob', hashPassword('bob-pass-12'), '鲍勃', 0, 'tenant', 0, '', '', nowIso()).lastInsertRowid);
  const mi = db.prepare("INSERT INTO models(name, provider, base_url, model, enabled, sort, currency, price_in, price_out, created_at) VALUES (?, ?, ?, ?, ?, ?, 'CNY', 2, 8, ?)");
  mids.chat = Number(mi.run('假对话', '测试', 'https://api.example.com/v1', 'fake', 1, 1, nowIso()).lastInsertRowid);
  mids.ds = Number(mi.run('DeepSeek 快速', 'DeepSeek', 'https://api.deepseek.com', 'deepseek-flash', 1, 2, nowIso()).lastInsertRowid);
  mids.ds2 = Number(mi.run('DeepSeek 专业', 'DeepSeek', 'https://api.deepseek.com', 'deepseek-v4-pro', 1, 3, nowIso()).lastInsertRowid);
  mids.off = Number(mi.run('停用的', '测试', 'https://api.example.com/v1', 'off', 0, 4, nowIso()).lastInsertRowid);
  db.prepare("UPDATE settings SET value = ? WHERE key = 'default_model_id'").run(String(mids.chat));
  db.prepare("INSERT INTO settings(key, value) VALUES ('card_writes_per_minute', '0')").run();
  app = createApp({ db, chub: fakeChub, llm: fakeLlm, avatars: { get: async () => ({ type: 'image/png', buf: Buffer.from('x') }) },
    config: { publicDir: path.join(dir, 'pub'), deepseekModel: 'fake', dataDir: dir } });
  server = http.createServer(app.handle);
  base = `http://127.0.0.1:${await listenFree(server, PORTS)}`;
  who.super = await login('root', 'root-pass-1');
  who.admin = await login('ops', 'ops-pass-11');
  who.a = await login('alice', 'alice-pass-1');
  who.b = await login('bob', 'bob-pass-12');
});

after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  cleanupTmp(dir);
});

// ---------- 纯函数 ----------
test('抽叶子：只抽白名单文本字段（含备选开场白、世界书内容），触发词不抽（走译名表），已是中文 / 空 / 非文本字段不抽', () => {
  const leaves = collectLeaves(DEF_MIRA);
  const paths = leaves.map((l) => l.path.join('.'));
  for (const p of ['name', 'personality', 'tavern_personality', 'scenario', 'first_message', 'alternate_greetings.0', 'example_dialogs', 'post_history_instructions', 'description',
    'embedded_lorebook.entries.0.content']) assert.ok(paths.includes(p), `缺 ${p}`);
  assert.ok(!paths.includes('alternate_greetings.1'), '已是中文的跳过');
  assert.ok(!paths.some((p) => p.startsWith('extensions') || p === 'id' || p === 'system_prompt'));
  assert.ok(!paths.some((p) => p.includes('.keys.')), '触发词不送翻（契约 §19.3）');
  assert.equal(needsTranslation('{{user}} *'), false);
  assert.equal(needsTranslation('你好，{{user}}'), false);
  assert.equal(needsTranslation('Hello'), true);
});

test('逐叶校验：宏 / 星号 / 换行 / markdown 数量不一致就不收；短文本只看宏与不新增换行', () => {
  assert.ok(checkLeaf('Hi {{user}} *waves*\nok', '你好 {{user}} *挥手*\n好'));
  assert.ok(!checkLeaf('Hi {{user}}', '你好'), '宏丢了');
  assert.ok(!checkLeaf('Hi {{user}}', '你好 {{char}}'), '宏换了');
  assert.ok(!checkLeaf('*waves*', '挥手'), '星号丢了');
  assert.ok(!checkLeaf('a\nb', 'a b'), '换行数不对');
  assert.ok(!checkLeaf('```\ncode\n```', '代码\n\n'), '代码块围栏');
  assert.ok(!checkLeaf('# Title\nx', '标题\nx'), '标题行');
  assert.ok(!checkLeaf('x', ''), '空');
  assert.ok(checkLeaf('Knight', '骑士', { short: true }));
  assert.ok(!checkLeaf('Knight', '骑\n士', { short: true }));
  assert.deepEqual(parseIdJson('好的：```json\n{"1":"甲"}\n```'), { 1: '甲' });
  assert.equal(parseIdJson('不是 JSON'), null);
});

test('长文本切段：换行串留在段外原样拼回；每段不超过上限；装批不超字数与个数', () => {
  const para = 'Word '.repeat(300).trim(); // 1499 字
  const text = [para, para, para, '', para].join('\n\n');
  const parts = splitSegments(text, 3000);
  assert.equal(parts.map((p) => p.text ?? p.sep).join(''), text);
  assert.ok(parts.filter((p) => p.text !== undefined).every((p) => p.text.length <= 3000));
  assert.ok(parts.filter((p) => p.text !== undefined).length >= 3);
  const single = splitSegments('Long sentence here. '.repeat(400), 3000);
  assert.ok(single.every((p) => (p.text ?? p.sep).length <= 3000));
  assert.equal(single.map((p) => p.text ?? p.sep).join(''), 'Long sentence here. '.repeat(400));
  const units = Array.from({ length: 100 }, (_, i) => ({ id: String(i), text: 'x'.repeat(200) }));
  const b = packBatches(units, { maxChars: 6000, maxUnits: 40 });
  assert.ok(b.every((x) => x.length <= 30 && x.reduce((a, u) => a + u.text.length, 0) <= 6000));
  assert.equal(b.flat().length, 100);
});

test('整卡翻译：同构回填（非文本字段原样）、触发词追加不替换、长叶子切段后换行一致、校验不过的叶子保留原文 → partial', async () => {
  const long = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} ${'word '.repeat(150)}*act*`).join('\n\n');
  const def = { ...structuredClone(DEF_MIRA), description: long, scenario: 'BREAKSTAR *dust* road', example_dialogs: 'line MISSING one' };
  const seen = [];
  const res = await translateDefinition(def, { name: 'Mira', tagline: 'A brave knight' }, async (messages) => {
    seen.push(messages);
    const input = JSON.parse(messages[1].content);
    return { text: JSON.stringify(Object.fromEntries(Object.entries(input).filter(([, v]) => !v.includes('MISSING')).map(([k, v]) => [k, fakeTranslate(v)]))) };
  });
  // 同构：键集合不变，非文本字段原样
  assert.deepEqual(Object.keys(res.zh).sort(), Object.keys(def).sort());
  assert.deepEqual(res.zh.extensions, def.extensions);
  assert.equal(res.zh.id, 12345);
  assert.equal(res.zh.name, '米拉');
  assert.equal(res.name_zh, '米拉');
  assert.equal(res.tagline_zh, '一位勇敢的骑士');
  assert.equal(res.zh.personality, '文 文 文. *文*\n文 文 {{user}}.');
  assert.equal(res.zh.first_message, '文 {{user}}! *文*');
  assert.deepEqual(res.zh.alternate_greetings, ['文 文 {{user}}', '你好呀']);
  // 触发词：保留原词并追加中文
  assert.deepEqual(res.zh.embedded_lorebook.entries[0].keys, ['tower', '塔楼']);
  assert.equal(res.zh.embedded_lorebook.entries[0].content, '文 文 文 文.');
  assert.equal(res.zh.embedded_lorebook.entries[0].id, 1);
  // 长叶子：切成多段，换行原样
  assert.equal((res.zh.description.match(/\n/g) || []).length, (long.match(/\n/g) || []).length);
  assert.ok(!/[A-Za-z]/.test(res.zh.description));
  // 校验不过（星号丢失）/ 模型漏回编号 → 重试一轮仍不行 → 保留原文
  assert.equal(res.zh.scenario, def.scenario);
  assert.equal(res.zh.example_dialogs, def.example_dialogs);
  assert.equal(res.status, 'partial');
  assert.ok(res.translated < res.units);
  // 每批按编号；长文本与短文本分开装批
  for (const m of seen) assert.ok(Object.keys(JSON.parse(m[1].content)).every((k) => /^\d+$/.test(k)));
  // 原对象不被改动
  assert.equal(def.name, 'Mira');
  assert.deepEqual(def.embedded_lorebook.entries[0].keys, ['tower']);
});

test('整卡翻译：全是中文 → ok 且不调用模型；复用上次同源译文只翻剩下的', async () => {
  let n = 0;
  const r1 = await translateDefinition({ name: '小明', first_message: '你好' }, { name: '小明', tagline: '' }, async () => { n += 1; return { text: '{}' }; });
  assert.equal(r1.status, 'ok');
  assert.equal(n, 0);
  const def = { first_message: 'Hello there', personality: 'Kind heart' };
  const reuse = { first_message: '你好啊', personality: 'Kind heart' };
  const asked = [];
  const r2 = await translateDefinition(def, { reuse }, async (m) => { const i = JSON.parse(m[1].content); asked.push(...Object.values(i)); return { text: JSON.stringify(Object.fromEntries(Object.entries(i).map(([k, v]) => [k, fakeTranslate(v)]))) }; });
  assert.deepEqual(asked, ['Kind heart']);
  assert.equal(r2.zh.first_message, '你好啊');
  assert.equal(r2.status, 'ok');
});

test('本会话设定纯函数：只存与原卡不同的字段；叠加；超长 400', () => {
  const base = { ...pickFields({ description: 'D', personality: 'P', scenario: '' }), name: '米拉' };
  assert.equal(diffOverride(base, { description: 'D', personality: 'P' }), null);
  assert.deepEqual(diffOverride(base, { personality: '暴躁', name: '米拉' }), { personality: '暴躁' });
  assert.deepEqual(applyOverride(base, { personality: '暴躁' }).personality, '暴躁');
  assert.throws(() => diffOverride(base, { personality: 'x'.repeat(9000) }), /性格太长/);
  assert.throws(() => diffOverride(base, { name: '' }), /名字不能为空/);
});

// ---------- 详情页：按需完整翻译 ----------
test('详情：秒开先回原文 + pending；后台整卡翻译完成后返回全部字段的原文与译文；花费记 system_costs(translate, 触发者)', async () => {
  const r0 = await who.a.get('/api/characters/tester/mira');
  assert.equal(r0.status, 200, r0.text);
  assert.equal(r0.json.character.translate_status, 'pending');
  assert.equal(r0.json.character.translating, true);
  assert.equal(r0.json.character.data_zh, null);
  assert.equal(r0.json.character.data.description, DEF_MIRA.personality.replace('{{user}}', '小爱'), '原文也给全（人物描述 = chub personality）');
  const r = await detailDone(who.a, 'tester/mira');
  const c = r.json.character;
  assert.equal(c.translate_status, 'ok');
  assert.equal(c.translating, false);
  assert.equal(c.name, 'Mira');
  assert.equal(c.name_zh, '米拉');
  assert.equal(c.tagline_zh, '一位勇敢的骑士');
  // 全部设定：原文 data 与译文 data_zh 同一 V2 结构
  for (const k of ['description', 'personality', 'scenario', 'first_mes', 'alternate_greetings', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes', 'character_book']) {
    assert.ok(k in c.data && k in c.data_zh, k);
  }
  assert.equal(c.data.personality, 'Brave');
  assert.equal(c.data_zh.personality, '勇敢');
  assert.equal(c.data_zh.creator_notes, '文 文 文');
  assert.equal(c.creator_notes_zh, '文 文 文');
  assert.deepEqual(c.data_zh.alternate_greetings, ['文 文 小爱', '你好呀']);
  assert.deepEqual(c.data_zh.character_book.entries[0].keys, ['tower', '塔楼']);
  assert.equal(c.greeting_zh, '文 小爱! *文*');
  assert.equal(c.greeting, 'Hello 小爱! *waves*');
  const costs = db.prepare("SELECT * FROM system_costs WHERE kind = 'translate'").all();
  assert.ok(costs.length >= 2);
  assert.ok(costs.every((x) => x.user_id === id.a && x.model_id === mids.ds), '默认用「DeepSeek 快速」，记触发者');
  // 标签走全站译名表
  let tags;
  for (let i = 0; i < 100; i++) { tags = (await who.a.get('/api/characters/tester/mira')).json.character.tags_zh; if (tags[0] === '奇幻') break; await sleep(15); }
  assert.deepEqual(tags, ['奇幻', '骑士']);
  assert.equal(db.prepare("SELECT zh FROM tag_translations WHERE tag = 'fantasy'").get().zh, '奇幻');
  const row = db.prepare("SELECT * FROM characters WHERE chub_path = 'tester/mira'").get();
  assert.equal(row.translate_status, 'ok');
  assert.equal(JSON.parse(row.card_json_zh).extensions.depth_prompt.prompt, 'keep me');
  assert.equal(row.tags_zh_json, JSON.stringify(['奇幻', '骑士']));
});

test('并发：同一角色同时打开 6 次、再新建会话，整卡翻译只跑一次', async () => {
  const before = cardCalls('Rover').length;
  const beforeLong = cardCalls('BREAKMACRO').length;
  const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => who.a.get('/api/characters/tester/rover')));
  assert.ok(rs.every((r) => r.status === 200));
  const chat = await who.a.post('/api/chats', { path: 'tester/rover' });
  assert.equal(chat.status, 200, chat.text);
  const r = await detailDone(who.a, 'tester/rover');
  // 长文本一批 + 短文本一批（并发打开也只各一次）；BREAKMACRO 那片叶子校验不过 → 只重试一轮
  assert.equal(cardCalls('Rover').length - before, 1);
  assert.equal(cardCalls('BREAKMACRO').length - beforeLong, 2);
  assert.equal(r.json.character.translate_status, 'partial', '宏丢了的叶子保留原文 → partial');
  assert.equal(r.json.character.data_zh.description, 'Quiet BREAKMACRO 小爱 friend');
  assert.equal(r.json.character.data_zh.scenario, '文 *文*');
  // 会话标题与开场白用中文名 / 中文开场白
  assert.equal(chat.json.chat.title, '漫游者');
  // 会话详情 / 会话列表里的角色名也用中文名，原名放 name_original（复核修复）
  const det = (await who.a.get(`/api/chats/${chat.json.chat.id}`)).json.character;
  assert.equal(det.name, '漫游者');
  assert.equal(det.name_original, 'Rover');
  assert.equal(det.tagline, '一位流浪者');
  const li = (await who.a.get('/api/chats')).json.items.find((x) => x.id === chat.json.chat.id).character;
  assert.equal(li.name, '漫游者');
  assert.equal(li.name_original, 'Rover');
  const msgs = (await who.a.get(`/api/chats/${chat.json.chat.id}`)).json.messages;
  assert.equal(msgs[0].content, '文 小爱');
});

test('源卡内容变化（chub 刷新后 card_json 变了）→ 重翻；没变不重翻', async () => {
  const n0 = calls.length;
  await who.a.get('/api/characters/tester/mira');
  await sleep(50);
  assert.equal(calls.length, n0, '没变不重翻');
  NODES['tester/mira'].definition = { ...DEF_MIRA, scenario: 'At the new castle.' };
  db.prepare("UPDATE characters SET fetched_at = '2020-01-01T00:00:00.000Z' WHERE chub_path = 'tester/mira'").run();
  const r0 = await who.b.get('/api/characters/tester/mira');
  assert.equal(r0.json.character.translate_status, 'pending');
  assert.equal(r0.json.character.data_zh, null, '源卡变了，旧译文不再当作有效');
  const r = await detailDone(who.b, 'tester/mira');
  assert.equal(r.json.character.translate_status, 'ok');
  assert.equal(r.json.character.data_zh.scenario, '文 文 文 文.');
  assert.ok(calls.length > n0);
  NODES['tester/mira'].definition = DEF_MIRA;
});

test('翻译失败：显示原文、不自动重试；「重试翻译」接口重来并成功', async () => {
  failCards = true;
  const r = await detailDone(who.a, 'tester/failer');
  assert.equal(r.json.character.translate_status, 'failed');
  assert.equal(r.json.character.data_zh, null);
  assert.equal(r.json.character.greeting_zh, 'FAILCARD hello there', '失败回原文');
  const n = calls.length;
  await who.a.get('/api/characters/tester/failer');
  await sleep(50);
  assert.equal(calls.length, n, '失败后打开不会自动重翻');
  failCards = false;
  const rr = await who.a.post('/api/characters/tester/failer/translate');
  assert.equal(rr.status, 200, rr.text);
  const done = await detailDone(who.a, 'tester/failer');
  assert.equal(done.json.character.translate_status, 'ok');
  assert.equal(done.json.character.data_zh.first_mes, '文 文 文');
  assert.equal((await who.a.post('/api/characters/nobody/none/translate')).status, 404);
  // 已经翻好（ok）的卡：普通用户点「重试翻译」不重翻（全站共享缓存，防刷费用）；super 可以强制
  const n2 = calls.length;
  assert.equal((await who.a.post('/api/characters/tester/failer/translate')).json.character.translate_status, 'ok');
  await sleep(80);
  assert.equal(calls.length, n2, 'ok 的卡普通用户重试不调模型');
  failCards = false;
  await who.super.post('/api/characters/tester/failer/translate');
  await detailDone(who.super, 'tester/failer');
  assert.ok(calls.length > n2, 'super 可强制重翻');
  failCards = true;
});

test('nsfw 关的用户打不开成人角色详情，也不会触发翻译', async () => {
  const n = calls.length;
  assert.equal((await who.b.get('/api/characters/tester/hot-nsfw')).status, 403);
  await sleep(50);
  assert.equal(calls.length, n);
});

// ---------- 列表与搜索 ----------
test('列表中文：首页热门 / 搜索先回已有译文，缺的标 translating 并后台批量翻（每批 ≤24 项），标签走共享译名表；稍后刷新就有中文', async () => {
  const before = calls.length;
  const h1 = (await who.b.get('/api/home')).json;
  const bulk1 = h1.hot.find((c) => c.path === 'bulk/c3');
  assert.equal(bulk1.translating, true);
  assert.equal(bulk1.name_zh, null);
  assert.ok(h1.hot.every((c) => Array.isArray(c.tags_zh)));
  const mira = h1.hot.find((c) => c.path === 'tester/mira');
  assert.equal(mira.name_zh, '米拉', '整卡翻译过的直接用');
  assert.equal(mira.tagline_zh, '一位勇敢的骑士');
  assert.deepEqual(mira.tags_zh, ['奇幻', '骑士']);
  assert.ok(!h1.hot.some((c) => c.nsfw));
  let h2;
  for (let i = 0; i < 100; i++) { await sleep(20); h2 = (await who.b.get('/api/home')).json; if (!h2.hot.some((c) => c.translating)) break; }
  const bulk2 = h2.hot.find((c) => c.path === 'bulk/c3');
  assert.equal(bulk2.name_zh, '文 3');
  assert.equal(bulk2.tagline_zh, '文 文 3');
  assert.deepEqual(bulk2.tags_zh, ['骑士']);
  assert.ok(!bulk2.translating);
  // 搜索结果同样带中文（还没翻的 39 项分两批：24 + 15）
  let s = (await who.b.get('/api/search?q=bulk')).json;
  assert.equal(s.items.find((c) => c.path === 'bulk/c7').name_zh, '文 7');
  assert.equal(s.items.find((c) => c.path === 'bulk/c50').translating, true);
  for (let i = 0; i < 100; i++) { await sleep(20); s = (await who.b.get('/api/search?q=bulk')).json; if (!s.items.some((c) => c.translating)) break; }
  assert.equal(s.items.find((c) => c.path === 'bulk/c50').name_zh, '文 50');
  // 每批 ≤24 项（一项 = 名字 + 简介两个短单元）
  const listCalls = calls.slice(before).filter((x) => x.input && Object.keys(x.input).some((k) => /^\d+[nt]$/.test(k)));
  assert.equal(listCalls.length, 3);
  for (const x of listCalls) assert.ok(new Set(Object.keys(x.input).map((k) => parseInt(k, 10))).size <= LIST_BATCH_MAX);
});

test('列表：一批里有一条翻不出来（被拒），重试时拆小批不连累别的；翻不出来的一段时间内不再反复排队', async () => {
  failCards = true;
  failRefused = true;
  const nodes = [{ fullPath: 'bad/x', name: 'FAILCARD Bad', tagline: '', avatar_url: '', topics: [], nsfw_image: false },
    ...Array.from({ length: 12 }, (_, i) => ({ fullPath: `ok/x${i}`, name: `Okay ${i}`, tagline: '', avatar_url: '', topics: [], nsfw_image: false }))];
  const cards = nodes.map(nodeToCard);
  const saved = fakeChub.search;
  fakeChub.search = async () => ({ items: cards, page: 1, has_more: false });
  try {
    let s = (await who.b.get('/api/search?q=x')).json;
    assert.ok(s.items.every((c) => c.translating));
    for (let i = 0; i < 100; i++) { await sleep(20); s = (await who.b.get('/api/search?q=x')).json; if (!s.items.some((c) => c.translating)) break; }
    assert.equal(s.items.find((c) => c.path === 'ok/x5').name_zh, '文 5', '同批的其他项照样翻好');
    const bad = s.items.find((c) => c.path === 'bad/x');
    assert.equal(bad.name_zh, null);
    assert.ok(!bad.translating, '翻不出来的不再标「翻译中」');
    const n = calls.length;
    await who.b.get('/api/search?q=x');
    await sleep(80);
    assert.equal(calls.length, n, '退避期内不再花钱重试');
  } finally { fakeChub.search = saved; failRefused = false; }
});

test('中文名搜索：本地缓存过的卡按 name_zh / tagline_zh 命中，排在 chub 结果前面；nsfw 关的用户搜不到成人卡', async () => {
  const r = await who.b.get('/api/search?q=' + encodeURIComponent('米拉'));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.items[0].path, 'tester/mira');
  assert.equal(r.json.items[0].local, true);
  assert.equal(r.json.items[0].name_zh, '米拉');
  assert.equal(r.json.items.filter((c) => c.path === 'tester/mira').length, 1, '与 chub 结果去重');
  const r2 = await who.b.get('/api/search?q=' + encodeURIComponent('流浪者'));
  assert.equal(r2.json.items[0].path, 'tester/rover', '按中文简介也能搜到');
  // 成人卡：nsfw 关的用户搜不到
  db.prepare("INSERT INTO chub_list_zh(path, name, tagline, name_zh, tagline_zh, card_snapshot, translated_at) VALUES ('x/adult', 'Adult', '', '成人卡甲', '', ?, ?)")
    .run(JSON.stringify({ path: 'x/adult', name: 'Adult', tagline: '', avatar: '', tags: [], nsfw: true }), nowIso());
  assert.ok(!(await who.b.get('/api/search?q=' + encodeURIComponent('成人卡甲'))).json.items.some((c) => c.path === 'x/adult'));
  assert.ok((await who.a.get('/api/search?q=' + encodeURIComponent('成人卡甲'))).json.items.some((c) => c.path === 'x/adult'));
});

test('聊天用中文设定：提示词里是中文角色名与 card_json_zh 的设定；世界书中文触发词也能命中', async () => {
  const chat = (await who.a.post('/api/chats', { path: 'tester/mira' })).json.chat;
  assert.equal(chat.title, '米拉');
  const ev = parseSse((await who.a.post(`/api/chats/${chat.id}/messages`, { content: '我们去塔楼吧' })).text);
  assert.ok(ev.find((e) => e.event === 'done'));
  const sys = lastPrompt[0].content;
  assert.ok(sys.includes('【角色】米拉'));
  assert.ok(sys.includes('文 文 文. *文*\n文 文 小爱.'), '中文人物描述');
  assert.ok(!sys.includes('A brave knight'));
  assert.ok(sys.includes('文 文 文 文.'), '中文触发词「塔楼」命中世界书');
  id.miraChat = chat.id;
});

test('翻译模型设置 translate_model_id：super 可改（只能选启用的），admin 403；之后翻译用它', async () => {
  assert.equal((await who.admin.patch('/api/admin/settings', { translate_model_id: mids.ds2 })).status, 403);
  assert.equal((await who.super.patch('/api/admin/settings', { translate_model_id: mids.off })).status, 400);
  let r = await who.super.patch('/api/admin/settings', { translate_model_id: mids.ds2 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.settings.translate_model_id, mids.ds2);
  const log = db.prepare("SELECT * FROM logs WHERE kind = 'settings.update' ORDER BY id DESC LIMIT 1").get();
  assert.match(log.summary, /翻译模型/);
  NODES['tester/new'] = { fullPath: 'tester/new', name: 'Newbie', tagline: '', avatar_url: '', topics: [], nsfw_image: false, definition: { name: 'Newbie', first_message: 'Yo' } };
  await sleep(100);
  const n = calls.length;
  await detailDone(who.a, 'tester/new');
  assert.ok(calls.slice(n).length > 0 && calls.slice(n).every((x) => x.model_id === mids.ds2));
  r = await who.super.patch('/api/admin/settings', { translate_model_id: null });
  assert.equal(r.json.settings.translate_model_id, null);
});

// ---------- §20 本会话设定 ----------
test('本会话设定：GET 返回原设定（中文优先）/ 覆盖 / 人设；PATCH 只存差异、下一条起生效；DELETE 恢复；别人的会话 404', async () => {
  const cid = id.miraChat;
  let r = await who.a.get(`/api/chats/${cid}/settings`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.base.name, '米拉');
  assert.equal(r.json.base.personality, '勇敢');
  assert.equal(r.json.override, null);
  assert.equal(r.json.persona, null);
  assert.deepEqual(r.json.persona_effective, { name: '小爱', desc: '一名旅行者' });
  assert.equal(r.json.modified, false);
  assert.equal((await who.b.get(`/api/chats/${cid}/settings`)).status, 404);
  assert.equal((await who.b.patch(`/api/chats/${cid}/settings`, { override: { personality: 'x' } })).status, 404);

  // 前端提交完整表单：只存与原设定不同的字段
  r = await who.a.patch(`/api/chats/${cid}/settings`, { override: { ...r.json.base, personality: '暴躁易怒', name: '米拉大人' }, persona: { name: '勇者', desc: '来自远方' } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.override, { name: '米拉大人', personality: '暴躁易怒' });
  assert.deepEqual(r.json.persona, { name: '勇者', desc: '来自远方' });
  assert.equal(r.json.effective.personality, '暴躁易怒');
  assert.equal(r.json.modified, true);
  const row = db.prepare('SELECT card_override_json, persona_override_json FROM chats WHERE id = ?').get(cid);
  assert.deepEqual(JSON.parse(row.card_override_json), { name: '米拉大人', personality: '暴躁易怒' });
  // 原卡（characters）不改
  assert.equal(JSON.parse(db.prepare("SELECT card_json_zh FROM characters WHERE chub_path = 'tester/mira'").get().card_json_zh).tavern_personality, '勇敢');
  // 事件进消息流（不进提示词历史）
  const d = (await who.a.get(`/api/chats/${cid}`)).json;
  assert.equal(d.chat.settings_modified, true);
  assert.equal(d.events.at(-1).kind, 'settings_update');
  assert.equal(d.events.at(-1).text, '已更新本会话设定，下一条回复起生效');
  assert.equal(d.events.at(-1).after_message_id, d.messages.at(-1).id);
  // 下一条回复起生效
  parseSse((await who.a.post(`/api/chats/${cid}/messages`, { content: '你好' })).text);
  let sys = lastPrompt[0].content;
  assert.ok(sys.includes('【角色】米拉大人'));
  assert.ok(sys.includes('【性格】\n暴躁易怒'));
  assert.ok(!sys.includes('【性格】\n勇敢'));
  assert.ok(sys.includes('「勇者」') && sys.includes('来自远方'), '本会话人设生效');
  assert.ok(!lastPrompt.some((m) => m.content.includes('已更新本会话设定')));
  // 替换语义：override 是本会话与原设定不同的全部字段（前端只发有改动的字段；没给的 = 跟原设定一致）
  r = await who.a.patch(`/api/chats/${cid}/settings`, { override: { name: '米拉大人', personality: '暴躁易怒', scenario: '雨夜的城门' }, persona: { name: '勇者', desc: '来自远方' } });
  assert.deepEqual(r.json.override, { name: '米拉大人', personality: '暴躁易怒', scenario: '雨夜的城门' });
  // 改回与原设定相同 → 该字段不再存
  r = await who.a.patch(`/api/chats/${cid}/settings`, { override: { name: '米拉大人', personality: '勇敢', scenario: '雨夜的城门' } });
  assert.deepEqual(r.json.override, { name: '米拉大人', scenario: '雨夜的城门' });
  // 不带 persona = 人设不变；不带 override = 角色设定不变
  assert.deepEqual(r.json.persona, { name: '勇者', desc: '来自远方' });
  r = await who.a.patch(`/api/chats/${cid}/settings`, { persona: { name: '勇者', desc: '来自远方' } });
  assert.deepEqual(r.json.override, { name: '米拉大人', scenario: '雨夜的城门' });
  assert.equal((await who.a.patch(`/api/chats/${cid}/settings`, { override: 'x' })).status, 400);
  assert.equal((await who.a.patch(`/api/chats/${cid}/settings`, { override: { personality: 'x'.repeat(9000) } })).status, 400);
  // 本人设置接口保留原设定、差异与生效值。
  const settings = (await who.a.get(`/api/chats/${cid}/settings`)).json;
  assert.equal(settings.modified, true);
  assert.equal(settings.base.name, '米拉');
  assert.equal(settings.effective.name, '米拉大人');
  assert.equal(settings.effective.scenario, '雨夜的城门');
  assert.deepEqual(settings.override, { name: '米拉大人', scenario: '雨夜的城门' });
  assert.deepEqual(settings.persona, { name: '勇者', desc: '来自远方' });
  assert.ok((await who.a.get(`/api/chats/${cid}`)).json.events.some((e) => e.kind === 'settings_update'));
  // 恢复
  r = await who.a.del(`/api/chats/${cid}/settings`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.override, null);
  assert.equal(r.json.persona, null);
  parseSse((await who.a.post(`/api/chats/${cid}/messages`, { content: '再见' })).text);
  sys = lastPrompt[0].content;
  assert.ok(sys.includes('【角色】米拉\n') || sys.includes('【角色】米拉\n\n'));
  assert.ok(sys.includes('【性格】\n勇敢'));
  assert.ok(sys.includes('「小爱」'));
  assert.equal((await who.a.get(`/api/chats/${cid}`)).json.events.at(-1).kind, 'settings_reset');
  assert.equal((await who.a.get(`/api/chats/${cid}/settings`)).json.modified, false);
});

test('本会话设定：自建卡作者「同时保存到我的卡片」→ 原卡更新、本会话不再有差异；公开卡的别人不能保存到原卡；世界书可改', async () => {
  const card = (await who.a.post('/api/cards', { kind: 'character', name: '阿青', description: '原描述', personality: '温柔', first_mes: '你好', visibility: 'public' })).json.card;
  const mine = (await who.a.post('/api/chats', { user_card_id: card.id })).json.chat;
  let r = await who.a.get(`/api/chats/${mine.id}/settings`);
  assert.equal(r.json.can_save_to_card, true);
  assert.equal(r.json.base.description, '原描述');
  r = await who.a.patch(`/api/chats/${mine.id}/settings`, { override: { personality: '冷淡', character_book: { entries: [{ keys: ['剑'], content: '一把古剑' }] } } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json.override).sort(), ['character_book', 'personality']);
  parseSse((await who.a.post(`/api/chats/${mine.id}/messages`, { content: '那把剑呢' })).text);
  assert.ok(lastPrompt[0].content.includes('一把古剑'), '本会话世界书生效');
  r = await who.a.patch(`/api/chats/${mine.id}/settings`, { save_to_card: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.override, null, '保存到原卡后本会话不再有差异');
  const k = (await who.a.get(`/api/cards/${card.id}`)).json.card;
  assert.equal(k.personality, '冷淡');
  assert.equal(k.character_book.entries[0].content, '一把古剑');
  assert.match(db.prepare("SELECT summary FROM logs WHERE kind = 'card.update' ORDER BY id DESC LIMIT 1").get().summary, /从会话设定保存/);
  // 别人用公开卡聊：能改本会话设定，但不能保存到原卡
  const other = (await who.super.post('/api/chats', { user_card_id: card.id })).json.chat;
  r = await who.super.get(`/api/chats/${other.id}/settings`);
  assert.equal(r.json.can_save_to_card, false);
  assert.equal((await who.super.patch(`/api/chats/${other.id}/settings`, { override: { personality: '活泼' }, save_to_card: true })).status, 403);
  r = await who.super.patch(`/api/chats/${other.id}/settings`, { override: { personality: '活泼' } });
  assert.equal(r.status, 200);
  assert.equal((await who.a.get(`/api/cards/${card.id}`)).json.card.personality, '冷淡', '原卡不受别人的会话设定影响');
});

// ---------- §20.2 改错字后从这里重新回复 ----------
test('rewind：改用户消息 → 之后的消息软删（edit_rewind）、按修改后的内容重新生成', async () => {
  const chat = (await who.a.post('/api/chats', { path: 'tester/mira' })).json.chat;
  const e1 = parseSse((await who.a.post(`/api/chats/${chat.id}/messages`, { content: '我门去塔楼' })).text);
  const u1 = e1.find((e) => e.event === 'user').data.message;
  parseSse((await who.a.post(`/api/chats/${chat.id}/messages`, { content: '第二句' })).text);
  const before = (await who.a.get(`/api/chats/${chat.id}`)).json.messages;
  assert.equal(before.length, 5);
  const r = await who.a.post(`/api/messages/${u1.id}/rewind`, { content: '我们去塔楼' });
  assert.equal(r.status, 200, r.text);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const ev = parseSse(r.text);
  assert.equal(ev[0].event, 'user');
  assert.equal(ev[0].data.message.id, u1.id);
  assert.equal(ev[0].data.message.content, '我们去塔楼');
  const done = ev.find((e) => e.event === 'done');
  assert.ok(done);
  // 提示词历史按修改后的内容，且不含被替换的后文
  const hist = lastPrompt.filter((m) => m.role !== 'system').map((m) => m.content);
  assert.equal(hist.at(-1), '我们去塔楼');
  assert.ok(!hist.includes('第二句') && !hist.includes('我门去塔楼'));
  const after = (await who.a.get(`/api/chats/${chat.id}`)).json.messages;
  assert.deepEqual(after.map((m) => m.id), [before[0].id, u1.id, done.data.message.id]);
  const dropped = db.prepare('SELECT deleted_reason FROM messages WHERE chat_id = ? AND id > ? AND id < ?').all(chat.id, u1.id, done.data.message.id);
  assert.equal(dropped.length, 3);
  assert.ok(dropped.every((x) => x.deleted_reason === 'edit_rewind'));
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(u1.id).content, '我们去塔楼');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND deleted_reason = 'edit_rewind'").get(chat.id).n, 3);
  // 用户侧费用只算未删。
  const cost = (await who.a.get(`/api/chats/${chat.id}`)).json.chat.cost_usd;
  const total = db.prepare('SELECT SUM(cost_usd) AS cost FROM messages WHERE chat_id = ?').get(chat.id).cost;
  assert.ok(cost < total);
  id.rewindChat = chat.id;
  id.rewindMsg = u1.id;
  id.rewindAssistant = done.data.message.id;
});

test('rewind 权限：只能用于自己会话里的用户消息；AI 消息 400、别人的 / 已删的 404、空内容 400、生成中 409', async () => {
  assert.equal((await who.a.post(`/api/messages/${id.rewindAssistant}/rewind`, { content: 'x' })).status, 400);
  assert.equal((await who.b.post(`/api/messages/${id.rewindMsg}/rewind`, { content: 'x' })).status, 404);
  assert.equal((await who.super.post(`/api/messages/${id.rewindMsg}/rewind`, { content: 'x' })).status, 404, '超管也不能借普通接口改别人的');
  assert.equal((await who.a.post(`/api/messages/${id.rewindMsg}/rewind`, { content: '  ' })).status, 400);
  const gone = db.prepare("SELECT id FROM messages WHERE chat_id = ? AND deleted_reason = 'edit_rewind' AND role = 'user'").get(id.rewindChat);
  assert.equal((await who.a.post(`/api/messages/${gone.id}/rewind`, { content: 'x' })).status, 404);
  // 生成中：409
  let open;
  gate = new Promise((r) => { open = r; });
  const pending = who.a.post(`/api/chats/${id.rewindChat}/messages`, { content: '慢慢说' });
  await sleep(80);
  const busy = await who.a.post(`/api/messages/${id.rewindMsg}/rewind`, { content: '改' });
  assert.equal(busy.status, 409);
  assert.equal((await who.a.patch(`/api/chats/${id.rewindChat}/settings`, { override: { personality: '急' } })).status, 409);
  open();
  gate = null;
  await pending;
  // 内容没变也可以从这里重新回复。
  const r = await who.a.post(`/api/messages/${id.rewindMsg}/rewind`, { content: '我们去塔楼' });
  assert.equal(r.status, 200);
  assert.ok(parseSse(r.text).find((e) => e.event === 'done'));
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(id.rewindMsg).content, '我们去塔楼');
});
