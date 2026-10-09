// v1.0 第 2 轮复核修复（翻译）：上游超时 / 5xx 不拆批、任务熔断与总时限、模型熔断后退到下一个 DeepSeek 模型、
// 译名表触发词与专有名词分开计上限。模型全是假的（不出网）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../server/db.mjs';
import { HttpError } from '../server/util.mjs';
import {
  translateUnits, translateDefinition, collectGlossary, collectGlossaryTerms, createTaskGuard, isUpstreamDown, createTranslationService,
  GLOSSARY_PROPER_MAX, GLOSSARY_KEYS_MAX, SHORT_TIMEOUT_MS, MODEL_TRIP_AFTER,
} from '../server/translate.mjs';
import { tmpDir, cleanupTmp } from './helpers.mjs';

const dir = tmpDir('round2-translate');
after(() => cleanupTmp(dir));

const timeoutErr = () => new HttpError(504, '超时', 'timeout');
const echo = (input) => ({ text: JSON.stringify(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v.replace(/[A-Za-z]+/g, '文')]))) });

test('isUpstreamDown：超时 / 5xx / 连不上算；拒答（502 refused）与 4xx 不算', () => {
  assert.ok(isUpstreamDown(timeoutErr()));
  assert.ok(isUpstreamDown(new HttpError(502, 'x', 'upstream')));
  assert.ok(isUpstreamDown(Object.assign(new Error('a'), { name: 'AbortError' })));
  assert.ok(!isUpstreamDown(new HttpError(502, '拒答', 'refused')));
  assert.ok(!isUpstreamDown(new HttpError(400, 'x')));
});

test('translateUnits：上游一直超时 → 不对半拆批，连续 3 次后本任务熔断，调用次数有上限', async () => {
  const units = Array.from({ length: 130 }, (_, i) => ({ id: String(i + 1), text: `Tag ${i}`, short: true })); // 3 批
  let n = 0;
  const timeouts = [];
  const r = await translateUnits(units, async (m, o) => { n += 1; timeouts.push(o.timeoutMs); throw timeoutErr(); }, { label: '测试' });
  assert.equal(r.map.size, 0);
  assert.equal(r.stopped, 'upstream');
  assert.ok(n <= 3, `只发了 ${n} 次`);
});

test('translateUnits：一次上游 502 → 整批原样重试一次（不拆小批）；拒答仍然拆批隔离', async () => {
  const units = Array.from({ length: 20 }, (_, i) => ({ id: String(i + 1), text: `Row ${i}`, short: true }));
  let n = 0;
  const sizes = [];
  const r = await translateUnits(units, async (m) => {
    n += 1;
    const input = JSON.parse(m[1].content);
    sizes.push(Object.keys(input).length);
    if (n === 1) throw new HttpError(502, 'x', 'upstream');
    return echo(input);
  });
  assert.equal(r.map.size, 20);
  assert.deepEqual(sizes, [20, 20], '重试按原批大小，只多一次');
  // 拒答（refused）：重试轮对半拆，把出问题的那条隔离出来
  const u2 = Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1), text: i === 3 ? 'BAD x' : `Row ${i}`, short: true }));
  const r2 = await translateUnits(u2, async (m) => {
    const input = JSON.parse(m[1].content);
    if (Object.values(input).some((x) => x.includes('BAD'))) throw new HttpError(502, '拒答', 'refused');
    return echo(input);
  });
  assert.equal(r2.map.size, 7);
  assert.equal(r2.stopped, null);
});

test('translateUnits：任务总时限到点 → 没发的批不再发，单次超时不超过剩余时间', async () => {
  let t = 0;
  const g = createTaskGuard({ deadlineMs: 1000, now: () => t });
  const units = Array.from({ length: 200 }, (_, i) => ({ id: String(i + 1), text: `Long text ${i}`, short: false }));
  let n = 0;
  const seen = [];
  const r = await translateUnits(units, async (m, o) => { n += 1; seen.push(o.timeoutMs); t += 600; return echo(JSON.parse(m[1].content)); }, { guard: g, concurrency: 1 });
  assert.equal(r.stopped, 'deadline');
  assert.ok(n <= 2, `发了 ${n} 次`);
  assert.ok(seen.every((x) => x <= 1000));
  assert.ok(r.map.size > 0 && r.map.size < 200, '已翻的保留（partial）');
});

test('translateDefinition：译名表一步就上游不可用 → 不再翻正文、直接抛错（调用方保留旧结果 / 记 failed）', async () => {
  const def = { name: 'Mira Vale', description: 'Mira lives in Vale. '.repeat(5), embedded_lorebook: { entries: [{ keys: ['castle', 'river'], content: 'The castle.' }] } };
  let n = 0;
  await assert.rejects(translateDefinition(def, { name: 'Mira Vale' }, async () => { n += 1; throw timeoutErr(); }), (e) => e.stopped === 'upstream');
  assert.ok(n <= 3, `只发了 ${n} 次（没进正文）`);
});

test('§19.2/§19.3 译名表：触发词与专有名词分开计上限；400 个触发词全部收进；超过上限的计入缺失 → partial', async () => {
  const keys = Array.from({ length: 404 }, (_, i) => `place${i}`);
  const body = 'They met Valera. Then Valera left. Later Valera came back. Then Kaelen saw Kaelen and Kaelen.';
  const def = { name: 'Rowan', description: body, embedded_lorebook: { entries: keys.map((k) => ({ keys: [k], content: 'x' })) } };
  const { terms, overflow } = collectGlossary(def, { name: 'Rowan' });
  assert.equal(overflow, 0);
  for (const w of ['Rowan', 'Valera', 'Kaelen', 'place0', 'place403']) assert.ok(terms.includes(w), w);
  assert.ok(terms.indexOf('Valera') < terms.indexOf('place0'), '专有名词排在触发词前面，不会被挤掉');
  assert.deepEqual(collectGlossaryTerms(def, { name: 'Rowan' }), terms);
  assert.ok(GLOSSARY_PROPER_MAX >= 40 && GLOSSARY_KEYS_MAX >= 400);
  // 超上限：计入缺失，状态 partial
  const many = { name: 'Rowan', embedded_lorebook: { entries: Array.from({ length: GLOSSARY_KEYS_MAX + 5 }, (_, i) => ({ keys: [`spot${i}`], content: '' })) } };
  assert.equal(collectGlossary(many, { name: 'Rowan' }).overflow, 5);
  const res = await translateDefinition(many, { name: 'Rowan' }, async (m) => {
    const input = JSON.parse(m[1].content);
    return { text: JSON.stringify(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, `中文${v.replace(/[A-Za-z]+/g, '')}`]))) };
  });
  assert.equal(res.status, 'partial');
  assert.equal(res.units - res.translated, 5);
});

test('重试大卡：上一次译名表只是缺词（这次补上）→ 不算译名表变了，已翻好的正文叶子照样复用', async () => {
  const def = { name: 'Mira', description: 'Mira walks along the shore every morning.', embedded_lorebook: { entries: [{ keys: ['harbor'], content: 'Old harbor.' }] } };
  const asked = [];
  const call = async (m) => { const input = JSON.parse(m[1].content); asked.push(...Object.values(input)); return { text: JSON.stringify(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v === 'Mira' ? '米拉' : v === 'harbor' ? '港口' : v.replace(/[A-Za-z]+/g, '文')]))) }; };
  const prevZh = structuredClone(def);
  prevZh.description = '米拉每天早上沿着海岸散步。';
  await translateDefinition(def, { name: 'Mira', reuse: prevZh, glossary: { Mira: '米拉' } }, call);
  assert.ok(asked.includes('harbor'), '缺的词补问');
  assert.ok(!asked.some((x) => x.includes('shore')), '正文叶子复用，没重翻');
});

function fakeModels() {
  const list = [
    { id: 1, name: 'DeepSeek 快速', model: 'deepseek-flash', base_url: 'https://api.deepseek.com', enabled: 1 },
    { id: 2, name: 'DeepSeek 专业', model: 'deepseek-v4-pro', base_url: 'https://api.deepseek.com', enabled: 1 },
  ];
  return { byId: (id) => list.find((m) => m.id === Number(id)) || null, listEnabled: () => list, systemDefault: () => list[0] };
}

test('模型熔断：「DeepSeek 快速」连续超时 → 熔断并退到「DeepSeek 专业」；列表不再挂着「翻译中」；短文本单次超时 45 秒', async () => {
  const db = openDb(path.join(dir, 'a.sqlite'));
  const calls = [];
  const llm = {
    async complete(messages, { model, timeoutMs }) {
      calls.push({ id: model.id, timeoutMs });
      if (model.id === 1) throw timeoutErr();
      return { ...echo(JSON.parse(messages[1].content)), model_id: model.id };
    },
  };
  const tr = createTranslationService({ db, llm, models: fakeModels(), costs: null });
  assert.equal(tr.model().id, 1);
  const cards = Array.from({ length: 30 }, (_, i) => ({ path: `u/c${i}`, name: `Card ${i}`, tagline: `Tagline ${i}`, tags: [] }));
  tr.localizeCards(cards);
  await tr.idle();
  const onFast = calls.filter((c) => c.id === 1).length;
  assert.ok(onFast >= MODEL_TRIP_AFTER && onFast <= 6, `快速版只试了 ${onFast} 次`);
  assert.ok(calls.every((c) => c.timeoutMs <= SHORT_TIMEOUT_MS));
  assert.ok(tr.isTripped(fakeModels().byId(1)));
  assert.equal(tr.model().id, 2, '熔断期间退到专业版');
  // 熔断期间：列表不再标 translating（退避到熔断结束），再打开时改用专业版翻
  const again = tr.localizeCards(cards);
  assert.ok(again.every((c) => !c.translating), '没翻出来的不再一直显示翻译中');
  const fresh = [{ path: 'u/new', name: 'New Card', tagline: 'Fresh', tags: [] }];
  tr.localizeCards(fresh);
  await tr.idle();
  assert.equal(tr.localizeCards(fresh)[0].name_zh, '文 文');
  assert.equal(calls.at(-1).id, 2);
  db.close();
});
