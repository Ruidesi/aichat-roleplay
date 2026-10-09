// v1.0 第 3 轮修复：流式超时不被 SSE 心跳续期（首个有效 delta / 有效 delta 间隔 / 总时长）；
// 翻译长叶子校验不过时按段落拆片重试、只留校验不过的小片；标题行宽松比较；译名表不收普通词、整词匹配；整卡翻译全站并发上限。
// 上游全是本机假服务 / 假模型（不出网）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { openDb } from '../server/db.mjs';
import { nowIso } from '../server/util.mjs';
import { createLlm } from '../server/llm.mjs';
import {
  translateUnits, translateDefinition, leafProblem, splitParagraphs, scanProperNouns, collectGlossaryTerms, glossaryBlock,
  createTranslationService, CARD_CONCURRENCY,
} from '../server/translate.mjs';
import { tmpDir, cleanupTmp, listenFree } from './helpers.mjs';

const dir = tmpDir('round3-fixes');
const PORTS = [44982, 44983, 44984, 44985, 44986, 44987, 44988, 44989];

// ---------- 假上游：按模型名决定行为 ----------
let up;
let upBase;
const sockets = new Set();
before(async () => {
  up = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      const m = body.model;
      const timers = [];
      const stop = () => timers.forEach((t) => clearInterval(t));
      res.on('close', stop);
      const data = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (m === 'json-heartbeat') {
        // 非流式：200 头先回，然后一直发空行（DeepSeek 非流式等待时的保活），永远不给正文
        res.writeHead(200, { 'content-type': 'application/json' });
        timers.push(setInterval(() => res.write('\n'), 30));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (m === 'heartbeat-only') {
        // 只发 SSE 心跳注释，不出字（10-02 DeepSeek 快速故障现象）
        res.write(': keep-alive\n\n');
        timers.push(setInterval(() => res.write(': keep-alive\n\n'), 30));
        return;
      }
      if (m === 'stall-after-text') {
        data({ model: m, choices: [{ delta: { content: '前半段' } }] });
        timers.push(setInterval(() => res.write(': keep-alive\n\n'), 30));
        return;
      }
      if (m === 'endless') {
        // 一直在出字，但永远不结束 → 只有总时长上限能停下
        timers.push(setInterval(() => data({ model: m, choices: [{ delta: { content: '字' } }] }), 40));
        return;
      }
      if (m === 'ok-with-heartbeats') {
        let n = 0;
        res.write(': keep-alive\n\n');
        timers.push(setInterval(() => {
          n += 1;
          if (n % 2) { res.write(': keep-alive\n\n'); return; }
          if (n < 8) { data({ model: m, choices: [{ delta: { content: `段${n}` } }] }); return; }
          stop();
          data({ model: m, choices: [{ delta: {}, finish_reason: 'stop' }] });
          res.end('data: [DONE]\n\n');
        }, 40));
        return;
      }
      res.end('data: [DONE]\n\n');
    });
  });
  up.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const port = await listenFree(up, PORTS);
  upBase = `http://127.0.0.1:${port}/v1`;
});

after(async () => {
  for (const s of sockets) s.destroy();
  await new Promise((r) => up.close(r));
  cleanupTmp(dir);
});

const fakeModelSvc = () => ({ apiKeyOf: () => 'test-key', extraOf: () => ({}), systemDefault: () => null });
const mdl = (model) => ({ id: 9, name: model, model, base_url: upBase });

test('llm：上游只发 SSE 心跳（: keep-alive）不出字 → 首个有效内容时限一到就报 timeout，心跳不续期', async () => {
  const llm = createLlm({ models: fakeModelSvc(), checkUpstream: null, firstByteTimeoutMs: 300, idleTimeoutMs: 300, totalTimeoutMs: 5000 });
  const t0 = Date.now();
  await assert.rejects(llm.streamChat([{ role: 'user', content: 'x' }], { model: mdl('heartbeat-only') }), (e) => e.code === 'timeout' && e.partial === '');
  const took = Date.now() - t0;
  assert.ok(took >= 250 && took < 2000, `用了 ${took} ms`);
});

test('llm：出了一段字后只剩心跳 → 有效内容间隔时限报 timeout，已生成部分随错误带回', async () => {
  const llm = createLlm({ models: fakeModelSvc(), checkUpstream: null, firstByteTimeoutMs: 300, idleTimeoutMs: 300, totalTimeoutMs: 5000 });
  const t0 = Date.now();
  await assert.rejects(llm.streamChat([{ role: 'user', content: 'x' }], { model: mdl('stall-after-text') }), (e) => e.code === 'timeout' && e.partial === '前半段');
  assert.ok(Date.now() - t0 < 2000);
});

test('llm：一直出字永不结束 → 总时长上限报 timeout，已生成部分保留', async () => {
  const llm = createLlm({ models: fakeModelSvc(), checkUpstream: null, firstByteTimeoutMs: 300, idleTimeoutMs: 300, totalTimeoutMs: 600 });
  const t0 = Date.now();
  await assert.rejects(llm.streamChat([{ role: 'user', content: 'x' }], { model: mdl('endless') }), (e) => e.code === 'timeout' && e.partial.length > 3 && /^字+$/.test(e.partial));
  const took = Date.now() - t0;
  assert.ok(took >= 550 && took < 2000, `用了 ${took} ms`);
});

test('llm：正常回复中间夹着心跳 → 照常拼接完成', async () => {
  const llm = createLlm({ models: fakeModelSvc(), checkUpstream: null, firstByteTimeoutMs: 300, idleTimeoutMs: 300, totalTimeoutMs: 5000 });
  const r = await llm.streamChat([{ role: 'user', content: 'x' }], { model: mdl('ok-with-heartbeats') });
  assert.equal(r.text, '段2段4段6');
  assert.equal(r.finish_reason, 'stop');
});

test('llm：非流式上游一直发空行保活 → 按总时限报 timeout（不被续期）', async () => {
  const llm = createLlm({ models: fakeModelSvc(), checkUpstream: null, totalTimeoutMs: 5000 });
  const t0 = Date.now();
  await assert.rejects(llm.complete([{ role: 'user', content: 'x' }], { model: mdl('json-heartbeat'), timeoutMs: 300 }), (e) => e.code === 'timeout');
  assert.ok(Date.now() - t0 < 2000);
  // timeoutMs 超过总上限时按总上限算
  const llm2 = createLlm({ models: fakeModelSvc(), checkUpstream: null, totalTimeoutMs: 300 });
  const t1 = Date.now();
  await assert.rejects(llm2.complete([{ role: 'user', content: 'x' }], { model: mdl('json-heartbeat'), timeoutMs: 60000 }), (e) => e.code === 'timeout');
  assert.ok(Date.now() - t1 < 2000);
});

// ---------- 翻译：按段落拆片重试 ----------
const fakeZh = (v) => v.split(/(\{\{[^{}]*\}\})/).map((x, i) => (i % 2 ? x : x.replace(/[A-Za-z]+/g, '文'))).join('');

test('splitParagraphs：空行处断开、相邻短行合并、拼回等于原文；短多行文本可逐行拆', () => {
  const t = 'Hello *waves* there.\nLine two {{user}}.\n\n# Head\n  Third para.\n---\nLast';
  const p = splitParagraphs(t);
  assert.equal(p.map((x) => x.sep ?? x.text).join(''), t);
  assert.equal(p.filter((x) => x.text !== undefined).length, 3);
  const q = splitParagraphs('a line\nb line\nc line', 0);
  assert.equal(q.filter((x) => x.text !== undefined).length, 3);
});

test('长叶子里一段星号对不上：重试轮按段落拆片，只有那一片保留原文，其余回填（人设不再整段漏翻）', async () => {
  const paras = [
    'Mira is a *quiet* librarian who loves old maps.',
    'She speaks softly and *rarely* raises her voice.',
    'When nervous she *hums an old tune.',  // 原文星号是单个
    'She dreams of sailing to the northern isles one day.',
  ];
  const def = { description: paras.join('\n\n') };
  let calls = 0;
  const call = async (messages) => {
    calls += 1;
    const input = JSON.parse(messages[1].content);
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      let z = fakeZh(v);
      if (v.includes('hums')) z = z.replace('*', ''); // 模型把这一段的星号弄丢了
      out[k] = z;
    }
    return { text: JSON.stringify(out) };
  };
  const res = await translateDefinition(def, {}, call);
  // 复核修复：有小片保留原文的叶子不算翻完 → partial（前端出现「重试翻译」），但中英混合的译文照样写进去
  assert.equal(res.status, 'partial');
  assert.equal(res.mixed, 1);
  const outParas = res.zh.description.split('\n\n');
  assert.equal(outParas.length, 4);
  assert.equal(outParas[2], paras[2], '校验不过的那一片保留原文');
  for (const i of [0, 1, 3]) assert.ok(!/[A-Za-z]/.test(outParas[i].replace(/\*/g, '')), `第 ${i + 1} 段已回填中文：${outParas[i]}`);
  assert.ok(calls <= 4, `调用 ${calls} 次`);
});

test('translateUnits：拆片后各片都通过 → 整段回填；上游不可用的单元不拆片', async () => {
  const u = { id: '1', text: 'Para one *a*.\n\nPara two *b*.', short: false };
  let n = 0;
  const r = await translateUnits([u], async (messages) => {
    n += 1;
    const input = JSON.parse(messages[1].content);
    // 第一次整段回来少了一个换行（校验不过），拆片后逐片都对
    if (n === 1) return { text: JSON.stringify({ 1: '段一 *甲*。\n段二 *乙*。' }) };
    return { text: JSON.stringify(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, fakeZh(v)]))) };
  });
  assert.equal(r.map.get('1'), '文 文 *文*.\n\n文 文 *文*.');
  assert.equal(r.keptPieces, 0);
});

// ---------- 标题行宽松比较 ----------
test('标题校验：原文「##标题」（无空格）被模型补了空格 → 不判失败；标题行数真的少了才判失败', () => {
  assert.equal(leafProblem('##Background\nShe grew up by the sea.', '## 背景\n她在海边长大。'), null);
  assert.equal(leafProblem('## Background\ntext', '##背景\n文本'), null);
  assert.equal(leafProblem('# A\n## B\ntext', '# 甲\n乙\n文本'), 'heading');
});

// ---------- 译名表不收普通词 ----------
test('正文专有名词扫描：只收句中大写 ≥3 次、从不小写出现、且不是常见词的词；句首出现不计', () => {
  const def = {
    description: [
      'The castle belongs to Valdris. Guards obey Valdris and fear Valdris.',
      'Everyone calls her Your Majesty. The Queen rules with Your Majesty grace and the Queen smiles at the Queen.',
      'She walks with Silver eyes, Silver hair and Silver rings, but silver coins mean nothing.',
      'Sometimes she is calm. Sometimes not. Sometimes neither. Sometimes, she rests.',
      'Ember flickers. Ember fades. Ember rises. They meet at Kestrel Bay near Kestrel Bay docks by Kestrel Bay.',
    ].join('\n'),
  };
  const w = scanProperNouns(def);
  assert.ok(w.includes('Valdris'), w.join(','));
  assert.ok(w.includes('Kestrel'), w.join(','));
  for (const bad of ['Your', 'Majesty', 'Queen', 'Silver', 'Sometimes', 'Ember', 'Bay', 'The']) assert.ok(!w.includes(bad), `不该收 ${bad}：${w.join(',')}`);
});

test('角色名只作整体词条：标题式长名字不拆成单词', () => {
  const t = collectGlossaryTerms({ name: 'Yes My Liege', description: 'A tale about duty.' }, { name: 'Yes My Liege' });
  assert.deepEqual(t, ['Yes My Liege']);
});

test('glossaryBlock：整词、区分大小写，只附本批真正出现的词条；措辞是「这些专有名词按此表翻译」', () => {
  const g = { Ash: '艾什', Valdris: '瓦尔德里斯', door: '门' };
  const b = glossaryBlock(g, ['She brushed the ashes away. Valdris smiled. Ashley waved. A trapdoor creaked.']);
  assert.match(b, /Valdris → 瓦尔德里斯/);
  assert.ok(!b.includes('Ash →'), 'ashes / Ashley 不算 Ash');
  assert.ok(!b.includes('door →'), 'trapdoor 不算 door');
  assert.match(b, /这些专有名词按此表翻译/);
  assert.ok(!b.includes('一律'));
  assert.equal(glossaryBlock(g, ['The ash tree.']), '', '大小写不同不算');
});

// ---------- 整卡翻译全站并发上限 ----------
test('整卡翻译全站同时最多 3 张在翻，其余排队；排队情况可查；全部最终翻完', async () => {
  const db = openDb(path.join(dir, 'conc.sqlite'));
  const ins = db.prepare('INSERT INTO characters(chub_path, name, card_json, fetched_at) VALUES (?, ?, ?, ?)');
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(Number(ins.run(`u/c${i}`, `Card ${i}`, JSON.stringify({ name: `Card ${i}`, description: `Card ${i} likes tea and long walks.` }), nowIso()).lastInsertRowid));
  let active = 0;
  let peak = 0;
  const gates = [];
  const llm = {
    async complete(messages) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => gates.push(r));
      active -= 1;
      const input = JSON.parse(messages[1].content);
      return { text: JSON.stringify(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, fakeZh(v)]))), model_id: 1 };
    },
  };
  const models = { byId: () => ({ id: 1, name: 'DeepSeek 快速', model: 'deepseek-flash', base_url: 'https://api.deepseek.com', enabled: 1 }), listEnabled: () => [{ id: 1, name: 'DeepSeek 快速', model: 'deepseek-flash', base_url: 'https://api.deepseek.com', enabled: 1 }], systemDefault: () => null };
  const tr = createTranslationService({ db, llm, models, costs: null });
  const rowOf = (id) => db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
  const ps = ids.map((id) => tr.start(rowOf(id), { userId: 1 }));
  assert.ok(ps.every(Boolean));
  await new Promise((r) => setTimeout(r, 30));
  const st = tr.cardQueueStats();
  assert.equal(st.running, CARD_CONCURRENCY);
  assert.equal(st.queued, 6 - CARD_CONCURRENCY);
  assert.equal(st.queued_total, 3);
  // 排队中的卡对外显示「翻译中」
  for (const id of ids) assert.equal(tr.statusOf(rowOf(id)), 'pending');
  // 放行：每次把卡住的调用都放掉，直到全部完成
  let done = false;
  Promise.all(ps).then(() => { done = true; });
  for (let i = 0; i < 200 && !done; i++) {
    while (gates.length) gates.shift()();
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(done, '全部翻完');
  assert.ok(peak <= CARD_CONCURRENCY, `同时在翻 ${peak} 张`);
  for (const id of ids) assert.equal(rowOf(id).translate_status, 'ok');
  const end = tr.cardQueueStats();
  assert.deepEqual([end.running, end.queued], [0, 0]);
  assert.ok(end.queue_peak >= 3);
  db.close();
});
