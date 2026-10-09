// v1.0 复核修复（第 4 轮）：
//   ① 长单元拆片重试后仍有小片保留原文 → 这一叶不算「已翻译」，整卡落 partial（前端出现「重试翻译」）；重试时不复用中英混合的旧叶子；
//      旧版本落成 ok 但还留着整段英文的卡，对外按 partial 报；重试轮在 system 里写明每条应有的宏次数。
//   ② 新建会话等翻译有总预算：翻译模型卡住时先用原文开场白建会话，翻译后台继续；开场白翻译失败计入模型熔断。
// 全部用假模型（不出网）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../server/db.mjs';
import { HttpError, nowIso } from '../server/util.mjs';
import {
  translateUnits, translateDefinition, macroHint, hasResidualSource, residualLeaves, createTranslationService, sourceHash, MODEL_TRIP_AFTER,
} from '../server/translate.mjs';
import { createCharacterService } from '../server/characters.mjs';
import { tmpDir, cleanupTmp } from './helpers.mjs';

const dir = tmpDir('round4-review');
after(() => cleanupTmp(dir));

const fakeZh = (v) => v.split(/(\{\{[^{}]*\}\})/).map((x, i) => (i % 2 ? x : x.replace(/[A-Za-z]+/g, '文'))).join('');
const timeoutErr = () => new HttpError(504, '回复超时', 'timeout');
const MODELS = [
  { id: 1, name: 'DeepSeek 快速', model: 'deepseek-flash', base_url: 'https://api.deepseek.com', enabled: 1 },
  { id: 2, name: 'DeepSeek 专业', model: 'deepseek-v4-pro', base_url: 'https://api.deepseek.com', enabled: 1 },
];
const fakeModels = () => ({ byId: (id) => MODELS.find((m) => m.id === Number(id)) || null, listEnabled: () => MODELS, systemDefault: () => MODELS[0] });

// ---------- ① 拆片保留原文 → partial ----------
test('macroHint：逐条写出每种宏的次数；没有宏的批返回空串', () => {
  const h = macroHint([{ id: '3.1', text: '{{user}} finds that {{user}} is drawn to {{char}}.' }, { id: '4', text: 'No macro here.' }]);
  assert.match(h, /3\.1：\{\{user\}\}×2、\{\{char\}\}×1/);
  assert.ok(!h.includes('4：'));
  assert.equal(macroHint([{ id: '1', text: 'plain' }]), '');
});

test('重试轮 system 写明宏次数：首轮把重复的 {{user}} 合并成「自己」被退回，重试按提示保留 → 整卡 ok', async () => {
  const text = 'In this world {{user}} finds that {{user}} is drawn into the war, and {{user}} must align with {{char}}.';
  const def = { scenario: text };
  const systems = [];
  const call = async (messages) => {
    systems.push(messages[0].content);
    const input = JSON.parse(messages[1].content);
    const hinted = /占位符数量硬性要求/.test(messages[0].content);
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      let z = fakeZh(v);
      if (!hinted) z = z.replace(/\{\{user\}\}(?=[^{]*\{\{user\}\})/, '自己'); // 没提示：模型把重复的 {{user}} 合并
      out[k] = z;
    }
    return { text: JSON.stringify(out) };
  };
  const res = await translateDefinition(def, {}, call);
  assert.equal(res.status, 'ok');
  assert.equal((res.zh.scenario.match(/\{\{user\}\}/g) || []).length, 3);
  assert.ok(systems.some((s) => /\{\{user\}\}×3、\{\{char\}\}×1/.test(s)), '重试轮附了宏次数');
  assert.ok(!/占位符数量硬性要求/.test(systems[0]), '首轮不附');
});

test('拆片后仍有一片保留原文：translateUnits 报出 kept；translateDefinition 落 partial，混合译文照样写入', async () => {
  const paras = [
    'Mira is a quiet librarian who loves old maps and older stories.',
    'In this world {{user}} finds that {{user}} is drawn into the war against the empire.',
    'She dreams of sailing to the northern isles one day with a crew of friends.',
  ];
  const def = { description: paras.join('\n\n') };
  // 模型「死不改」：含 {{user}} 的那片无论有没有提示都合并成「自己」
  const call = async (messages) => {
    const input = JSON.parse(messages[1].content);
    return { text: JSON.stringify(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, fakeZh(v).replace(/\{\{user\}\}(?=[^{]*\{\{user\}\})/, '自己')]))) };
  };
  const r = await translateUnits([{ id: '1', text: def.description, short: false }], call);
  assert.equal(r.kept.get('1'), 1);
  const res = await translateDefinition(def, {}, call);
  assert.equal(res.status, 'partial');
  assert.equal(res.mixed, 1);
  const out = res.zh.description.split('\n\n');
  assert.equal(out[1], paras[1], '校验不过的那片保留原文');
  assert.ok(!/[A-Za-z]/.test(out[0]) && !/[A-Za-z]/.test(out[2]), '其余段落已是中文');
  assert.ok(hasResidualSource(def.description, res.zh.description));
});

test('重试（reuse 同源旧译文）：中英混合的旧叶子不复用、重新送翻；干净的旧叶子照样复用', async () => {
  const eng = 'In this world {{user}} finds that {{user}} is drawn into the war against the empire.';
  const def = { description: `Mira loves maps and stories of the sea.\n\n${eng}`, scenario: 'A quiet harbor town where ships come and go every morning.' };
  const prev = { ...def, description: `米拉喜欢地图和大海的故事。\n\n${eng}`, scenario: '一个安静的港口小镇，每天早上船来船往。' };
  assert.equal(residualLeaves(def, prev), 1);
  const asked = [];
  const call = async (messages) => {
    const input = JSON.parse(messages[1].content);
    asked.push(...Object.values(input));
    return { text: JSON.stringify(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, fakeZh(v)]))) };
  };
  const res = await translateDefinition(def, { reuse: prev, glossary: {} }, call);
  assert.equal(res.status, 'ok');
  assert.ok(asked.some((x) => x.includes('drawn into the war')), '混合叶子重翻');
  assert.ok(!asked.some((x) => x.includes('harbor town')), '干净叶子复用');
  assert.equal(res.zh.scenario, prev.scenario);
  assert.ok(!hasResidualSource(def.description, res.zh.description));
});

test('hasResidualSource：网址 / 短名字 / 少于 4 个英文词的行照抄不算残留', () => {
  assert.ok(!hasResidualSource('See https://example.com/a-very-long-path-here', '见 https://example.com/a-very-long-path-here'));
  assert.ok(!hasResidualSource('Name: Mira Vale the Third', 'Name: Mira Vale the Third'.slice(0, 10)));
  assert.ok(hasResidualSource('Line one.\nShe walks along the shore every single morning.', '第一行。\nShe walks along the shore every single morning.'));
});

function insertChar(db, p, def, extra = {}) {
  const id = Number(db.prepare('INSERT INTO characters(chub_path, name, tagline, card_json, fetched_at) VALUES (?, ?, ?, ?, ?)')
    .run(p, def.name || 'X', '', JSON.stringify(def), nowIso()).lastInsertRowid);
  const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
  const sets = Object.keys(extra);
  if (sets.length) db.prepare(`UPDATE characters SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...sets.map((k) => (typeof extra[k] === 'function' ? extra[k](row) : extra[k])), id);
  return db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
}

test('旧库里落成 ok 但留着整段英文的卡：对外报 partial；普通用户「重试翻译」只重翻那一叶，之后 ok', async () => {
  const db = openDb(path.join(dir, 'residual.sqlite'));
  const eng = 'She walks along the shore every single morning before dawn.';
  const def = { name: '米拉', description: `Mira loves old maps and the stories behind them.\n\n${eng}`, scenario: 'A quiet harbor town where ships come and go every morning.' };
  const zh = { ...def, description: `米拉喜欢旧地图和背后的故事。\n\n${eng}`, scenario: '一个安静的港口小镇。' };
  const row = insertChar(db, 'tester/res1', def, { card_json_zh: JSON.stringify(zh), translate_status: 'ok', translate_hash: (r) => sourceHash(r), translated_at: nowIso(), glossary_json: '{}' });
  const asked = [];
  const llm = {
    async complete(messages, { model }) {
      const input = JSON.parse(messages[1].content);
      asked.push(...Object.values(input));
      return { text: JSON.stringify(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, fakeZh(v)]))), model_id: model.id };
    },
  };
  const tr = createTranslationService({ db, llm, models: fakeModels(), costs: null });
  const chars = createCharacterService({ db, chub: {}, llm, models: fakeModels(), translations: tr });
  assert.equal(tr.statusOf(row), 'partial');
  assert.equal(chars.detail(row, { id: 7, role: 'user' }).translate_status, 'partial');
  chars.retryTranslation(row, { id: 7, role: 'user' });
  await tr.pendingOf(row);
  const after1 = chars.getRowById(row.id);
  assert.equal(tr.statusOf(after1), 'ok');
  assert.equal(after1.translate_status, 'ok');
  assert.ok(asked.some((x) => x.includes('shore')), '残留段重翻');
  assert.ok(!asked.some((x) => x.includes('harbor')), '干净叶子复用');
  db.close();
});

// ---------- ② 新建会话等翻译的总预算 ----------
test('翻译模型卡住：新建会话不超过总预算，先用原文开场白；后台失败计入熔断，熔断后开场白改用 DeepSeek 专业', async () => {
  const db = openDb(path.join(dir, 'chat-budget.sqlite'));
  const greeting = 'Hello there, traveler. Welcome to my little shop by the sea.';
  const def = { name: 'Mira', first_message: greeting, description: 'A shopkeeper.' };
  // 整卡翻译已失败（同源）→ kick 不再开翻，只剩单独翻开场白这一步
  insertChar(db, 'tester/c9', def, { translate_status: 'failed', translate_hash: (r) => sourceHash(r), translated_at: nowIso() });
  const used = [];
  const llm = {
    async complete(messages, { model, timeoutMs }) {
      used.push({ id: model.id, timeoutMs });
      if (model.id === 1) { await new Promise((r) => setTimeout(r, timeoutMs)); throw timeoutErr(); } // 只发心跳不出字：到点超时
      return { text: '你好，旅人。欢迎来到我海边的小店。', model_id: model.id };
    },
  };
  const tr = createTranslationService({ db, llm, models: fakeModels(), costs: null });
  const timing = { waitCardMs: 300, budgetMs: 400, waitGreetingMs: 300, greetingTimeoutMs: 250 };
  const chars = createCharacterService({ db, chub: { character: async () => { throw new Error('不应拉 chub'); } }, llm, models: fakeModels(), translations: tr, timing });
  const user = { id: 3, role: 'user', nsfw_enabled: 0 };
  for (let i = 0; i < MODEL_TRIP_AFTER; i++) {
    const t0 = Date.now();
    const row = await chars.ensureForChat('tester/c9', user);
    const ms = Date.now() - t0;
    assert.ok(ms < timing.budgetMs + 300, `第 ${i + 1} 次建会话用了 ${ms}ms`);
    assert.equal(chars.greetingZhOf(row), greeting, '先用原文开场白');
    await new Promise((r) => setTimeout(r, 120)); // 等后台那次超时落地（计入熔断）
  }
  assert.ok(tr.isTripped(MODELS[0]), '开场白翻译连续超时 → 「DeepSeek 快速」熔断');
  assert.ok(used.slice(0, MODEL_TRIP_AFTER).every((u) => u.id === 1 && u.timeoutMs === timing.greetingTimeoutMs));
  const row = await chars.ensureForChat('tester/c9', user);
  assert.equal(used.at(-1).id, 2, '熔断后改用 DeepSeek 专业');
  assert.equal(chars.greetingZhOf(row), '你好，旅人。欢迎来到我海边的小店。');
  assert.equal(chars.getRow('tester/c9').greeting_zh, '你好，旅人。欢迎来到我海边的小店。', '回写 greeting_zh');
  db.close();
});

test('开场白翻译超出等待时间：先回原文，后台翻完后回写 greeting_zh', async () => {
  const db = openDb(path.join(dir, 'chat-bg.sqlite'));
  const greeting = 'Good evening. The tavern is warm and the fire is crackling.';
  insertChar(db, 'tester/c10', { name: 'Bram', first_message: greeting }, { translate_status: 'failed', translate_hash: (r) => sourceHash(r), translated_at: nowIso() });
  const llm = { async complete(_m, { model }) { await new Promise((r) => setTimeout(r, 350)); return { text: '晚上好。酒馆里很暖和，炉火噼啪作响。', model_id: model.id }; } };
  const tr = createTranslationService({ db, llm, models: fakeModels(), costs: null });
  const chars = createCharacterService({ db, chub: {}, llm, models: fakeModels(), translations: tr, timing: { budgetMs: 200, waitGreetingMs: 200 } });
  const row = await chars.ensureForChat('tester/c10', { id: 4, role: 'user' });
  assert.equal(chars.greetingZhOf(row), greeting);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(chars.getRow('tester/c10').greeting_zh, '晚上好。酒馆里很暖和，炉火噼啪作响。');
  assert.ok(!tr.isTripped(MODELS[0]));
  db.close();
});
