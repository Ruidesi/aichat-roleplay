// v1.0 复核修复的回归测试：
//  - 上传解析：去标签 / XML 抽取线性（构造输入 1 秒内返回）、zip 解压总量上限、worker 隔离 + 批次超时、沙箱禁止写数据目录
//  - 上传接口：读请求体之前占名额（同一账号并发直接 429）、声明长度超限直接 413
//  - 翻译：值里含 ``` 的批能解析、解析失败在重试轮对半拆、§19.3 译名表（先建表再翻正文、触发词 = 原词 ∪ 译名）、平台元标签
//  - 语音：静音幻觉判定、整理提示词「拿不准不加括号」
// 模型都是假的（不出网、不调真模型）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { openDb } from '../server/db.mjs';
import { hashPassword } from '../server/auth.mjs';
import { createApp } from '../server/app.mjs';
import { nowIso } from '../server/util.mjs';
import {
  htmlToText, xmlElements, cleanText, parseFile, parseFilesIsolated, runTool, ZIP_TOO_BIG_MESSAGE, PARSE_TIMEOUT_MESSAGE,
} from '../server/fileparse.mjs';
import {
  parseIdJson, translateUnits, translateDefinition, collectGlossaryTerms, fixedTag, glossaryBlock,
} from '../server/translate.mjs';
import { looksSilent, FORMAT_SYSTEM } from '../server/voice.mjs';
import { tmpDir, cleanupTmp, listenFree, Client } from './helpers.mjs';

const PORTS = [44987, 44988, 44989, 44982, 44983, 44984, 44985, 44986];
let dir, server, base, db;
const who = {};

before(async () => {
  dir = tmpDir('unit-review');
  db = openDb(path.join(dir, 'aichat.sqlite'));
  const ins = db.prepare('INSERT INTO users(username, password_hash, display_name, is_admin, role, nsfw_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run('alice', hashPassword('alice-pass-1'), '爱丽丝', 0, 'tenant', 0, nowIso());
  ins.run('bob', hashPassword('bob-pass-12'), '鲍勃', 0, 'tenant', 0, nowIso());
  const app = createApp({ db, chub: { search: async () => ({ items: [], page: 1, has_more: false }), character: async () => { throw new Error('no'); } },
    llm: { complete: async () => ({ text: '{}' }), streamChat: async () => ({ text: '' }) }, avatars: { get: async () => ({ type: 'image/png', buf: Buffer.from('x') }) },
    asr: { available: () => true, transcribe: async () => ({ text: 'x', seconds: 1 }) },
    config: { publicDir: path.join(dir, 'pub'), deepseekModel: 'fake', dataDir: dir } });
  server = http.createServer(app.handle);
  base = `http://127.0.0.1:${await listenFree(server, PORTS)}`;
  for (const [u, p] of [['alice', 'alice-pass-1'], ['bob', 'bob-pass-12']]) {
    const c = new Client(base);
    assert.equal((await c.post('/api/login', { username: u, password: p })).status, 200);
    who[u] = c;
  }
});

after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  cleanupTmp(dir);
});

const timed = (fn) => { const t = Date.now(); const r = fn(); return { ms: Date.now() - t, r }; };

// ---------- 上传解析 ----------
test('去标签 / XML 抽取是线性的：只有开标签没有闭标签的构造输入 1 秒内返回', () => {
  for (const [label, s] of [['<head ', '<head '.repeat(200000)], ['<head>', '<head>'.repeat(200000)], ['<!--', '<!--'.repeat(200000)], ['<script>', '<script>x'.repeat(200000)]]) {
    const { ms } = timed(() => htmlToText(s));
    assert.ok(ms < 1000, `${label} 用了 ${ms}ms`);
  }
  for (const [name, s] of [['row', '<row>'.repeat(200000)], ['a:t', '<a:t>'.repeat(200000)], ['si', '<si>'.repeat(200000)], ['c', '<c r="A1">'.repeat(200000)]]) {
    const { ms } = timed(() => [...xmlElements(s, name)]);
    assert.ok(ms < 1000, `<${name}> 用了 ${ms}ms`);
  }
  const { ms } = timed(() => cleanText(' '.repeat(3_000_000) + 'x\n' + ' \t'.repeat(100000) + '\n'));
  assert.ok(ms < 1000, `长空白串 cleanText 用了 ${ms}ms`);
  // 功能不变
  assert.equal(htmlToText('<html><head><title>T</title></head><body><h1>第一章</h1><p>a &amp; b < c</p><SCRIPT>x</script><svg/>好<br>n<table><tr><td>1</td><td>2</td></tr></table><!-- c -->完</body></html>'),
    '第一章\n\na & b < c\n好\nn\n\n1\t2\n\n完');
  assert.equal(htmlToText('前<!-- 没有结尾的注释 后面都不要'), '前');
  assert.equal(htmlToText('前<style>没有闭标签'), '前');
  assert.equal(cleanText('甲  \n乙\t\n丙'), '甲\n乙\n丙');
});

test('zip 类：解压后合计超过 200MB 直接拒绝（不真解压）', async () => {
  const sd = path.join(dir, 'bomb');
  mkdirSync(sd, { recursive: true });
  // 210MB 的 0 从标准输入压进去（磁盘上只有压缩后的约 200KB）
  const r = spawnSync('/bin/sh', ['-c', 'dd if=/dev/zero bs=1048576 count=210 2>/dev/null | /usr/bin/zip -q bomb.epub -'], { cwd: sd });
  assert.equal(r.status, 0);
  const { readFileSync } = await import('node:fs');
  const data = readFileSync(path.join(sd, 'bomb.epub'));
  assert.ok(data.length < 2 * 1024 * 1024);
  const t = Date.now();
  const res = await parseFile({ name: 'bomb.epub', data }, { tmpDir: path.join(dir, 'tmp-parse'), binDir: path.join(dir, 'bin') });
  assert.equal(res.ok, false);
  assert.equal(res.error, ZIP_TOO_BIG_MESSAGE);
  assert.ok(Date.now() - t < 5000);
});

test('worker 隔离解析：结果与直接解析一致；整批超时就终止并报「解析超时」，临时目录删干净', async () => {
  const tmp = path.join(dir, 'tmp-iso');
  const ok = await parseFilesIsolated([{ name: 'a.html', data: Buffer.from('<p>你好</p><script>zzz</script>') }, { name: 'b.txt', data: Buffer.from('世界') }], { tmpDir: tmp, binDir: path.join(dir, 'bin') });
  assert.equal(ok.files.length, 2);
  assert.ok(ok.text.includes('你好') && ok.text.includes('世界') && !ok.text.includes('zzz'));
  await assert.rejects(
    parseFilesIsolated([{ name: 'a.txt', data: Buffer.from('x'.repeat(1000)) }], { tmpDir: tmp, binDir: path.join(dir, 'bin') }, { timeoutMs: 1 }),
    (e) => e.status === 422 && e.message === PARSE_TIMEOUT_MESSAGE,
  );
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(tmp), [], '批次临时目录已删');
});

test('子进程沙箱：只能写自己的临时目录，写不了数据目录', async () => {
  const own = path.join(dir, 'sbx-own');
  mkdirSync(own, { recursive: true });
  const outside = path.join(dir, 'should-not-exist.txt');
  await runTool('/usr/bin/touch', [outside], { writeDir: own });
  assert.equal(existsSync(outside), false, '沙箱里写不了临时目录以外');
  const inside = path.join(own, 'ok.txt');
  const r = await runTool('/usr/bin/touch', [inside], { writeDir: own });
  assert.equal(r.code, 0);
  assert.equal(existsSync(inside), true);
});

// ---------- 上传接口：读请求体之前占名额 ----------
/** 发一个只发了头和一点点请求体的上传（模拟慢速大上传），返回 socket。 */
function hangingUpload(cookie, p, contentLength) {
  return new Promise((resolve) => {
    const u = new URL(base);
    const s = net.connect(Number(u.port), u.hostname, () => {
      s.write(`POST ${p} HTTP/1.1\r\nHost: ${u.host}\r\nCookie: ${cookie}\r\nOrigin: ${base}\r\nContent-Type: application/octet-stream\r\nX-File-Name: a.txt\r\nContent-Length: ${contentLength}\r\n\r\nabc`);
      resolve(s);
    });
  });
}

test('上传：同一账号上一批还在传 → 第二个请求不读请求体直接 429；声明长度超限直接 413；名额用完能释放', async () => {
  const s = await hangingUpload(who.alice.cookie, '/api/file-chats/parse', 50 * 1024 * 1024);
  await new Promise((r) => setTimeout(r, 100));
  const t = Date.now();
  const r = await fetch(base + '/api/file-chats/parse', { method: 'POST', headers: { cookie: who.alice.cookie, 'content-type': 'text/plain', 'x-file-name': 'b.txt' }, body: '你好' });
  assert.equal(r.status, 429);
  assert.ok(Date.now() - t < 2000);
  // 别的账号不受影响
  const rb = await fetch(base + '/api/file-chats/parse', { method: 'POST', headers: { cookie: who.bob.cookie, 'content-type': 'text/plain', 'x-file-name': 'b.txt' }, body: '你好' });
  assert.equal(rb.status, 200, await rb.text());
  // 声明长度超过上限：不读直接 413
  const big = await fetch(base + '/api/voice/transcribe', { method: 'POST', headers: { cookie: who.bob.cookie, 'content-type': 'audio/webm', 'content-length': String(50 * 1024 * 1024) }, body: Buffer.alloc(10), duplex: 'half' }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
  // 断开挂着的上传 → 名额释放
  s.destroy();
  await new Promise((r) => setTimeout(r, 150));
  const r2 = await fetch(base + '/api/file-chats/parse', { method: 'POST', headers: { cookie: who.alice.cookie, 'content-type': 'text/plain', 'x-file-name': 'b.txt' }, body: '你好' });
  assert.equal(r2.status, 200, await r2.text());
});

test('上传暂存：每个账号最多保留 3 个没用的 upload_id，新建时删掉最旧的', async () => {
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const r = await fetch(base + '/api/file-chats/parse', { method: 'POST', headers: { cookie: who.bob.cookie, 'content-type': 'text/plain', 'x-file-name': `n${i}.txt` }, body: `第 ${i} 份` });
    ids.push((await r.json()).upload_id);
  }
  assert.equal(existsSync(path.join(dir, 'uploads', `${ids[0]}.json`)), false);
  for (const x of ids.slice(-3)) assert.equal(existsSync(path.join(dir, 'uploads', `${x}.json`)), true);
});

// ---------- 翻译 ----------
test('parseIdJson：值里含 ``` 也能解析；整段外层围栏 / 前后废话照样容忍', () => {
  const v = { 1: 'Hello\n```\nDay 1\n```', 2: 'Other text' };
  assert.deepEqual(parseIdJson(JSON.stringify(v)), v);
  assert.deepEqual(parseIdJson('```json\n' + JSON.stringify(v) + '\n```'), v);
  assert.deepEqual(parseIdJson('好的：\n' + JSON.stringify(v) + '\n以上'), v);
  assert.equal(parseIdJson('不是 JSON'), null);
});

test('translateUnits：重试轮里输出解析不了（截断）也对半拆开，单独隔离出问题的那条', async () => {
  const units = Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1), text: i === 5 ? 'BAD row' : `Row ${i}`, short: false }));
  let n = 0;
  const call = async (m) => {
    n += 1;
    const input = JSON.parse(m[1].content);
    if (Object.values(input).some((x) => x.includes('BAD'))) return { text: '{"1": "被截断' }; // 不是合法 JSON
    return { text: JSON.stringify(Object.fromEntries(Object.entries(input).map(([k, x]) => [k, x.replace(/[A-Za-z]+/g, '文')]))) };
  };
  const r = await translateUnits(units, call);
  assert.equal(r.map.size, 7, '只有坏的那条没翻出来');
  assert.ok(!r.map.has('6'));
  assert.ok(n >= 4 && n <= 10, `调用 ${n} 次`);
});

const CRICKET = {
  name: 'Cricket',
  description: 'Cricket runs the office. Ask Cricket anything.',
  personality: 'Cricket is cheerful. Everyone at Triple A Adventures trusts Cricket.',
  first_message: 'Cricket waves.\n```\nDay 1 (Dawn)\nGold: 10\n```',
  example_dialogs: '{{char}}: I am Cricket.',
  embedded_lorebook: { entries: [
    { keys: ['Triple A Adventures', 'door', 'office'], content: 'The agency of Cricket.', enabled: true },
    { keys: ['money'], secondary_keys: ['Cricket'], content: 'Costs and debts.', enabled: true },
  ] },
};
const GLOSS = { Cricket: '克里克特', 'Triple A Adventures': '三A冒险事务所', door: '门', office: '办公室', money: '金钱' };

test('collectGlossaryTerms：角色名 + 世界书全部触发词 + 正文里反复出现的专有名词；正则式 / 宏触发词跳过', () => {
  const t = collectGlossaryTerms(CRICKET, { name: 'Cricket' });
  for (const w of ['Cricket', 'Triple A Adventures', 'door', 'office', 'money']) assert.ok(t.includes(w), w);
  const t2 = collectGlossaryTerms({ name: 'Lara Lightland', personality: 'She met Zed. Then Zed left. Later Zed came back. The End.', embedded_lorebook: { entries: [{ keys: ['/re.*x/i', '{{char}}'] }] } }, { name: 'Lara Lightland' });
  for (const w of ['Lara Lightland', 'Zed']) assert.ok(t2.includes(w), w);
  // 契约 §19.3 补丁：角色名只作整体词条，不按空格拆
  assert.ok(!t2.includes('Lara') && !t2.includes('Lightland'), '角色名不拆成单词');
  assert.ok(!t2.includes('/re.*x/i') && !t2.includes('{{char}}') && !t2.includes('The') && !t2.includes('Later'));
});

test('§19.3 整卡翻译：先建译名表再翻正文；正文批 system 带译名表；中文名取自译名表；触发词 = 原词 ∪ 译名（单字不加）；值里有 ``` 也是 ok', async () => {
  const seen = [];
  const call = async (messages) => {
    const input = JSON.parse(messages[1].content);
    seen.push({ system: messages[0].content, input });
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      if (GLOSS[v]) { out[k] = GLOSS[v]; continue; }
      let z = v;
      for (const [o, c] of Object.entries(GLOSS)) z = z.split(o).join(c);
      out[k] = z.replace(/\{\{char\}\}/g, '\u0000').replace(/[A-Za-z]+/g, '文').replace(/\u0000/g, '{{char}}');
    }
    // 模型照样把整段包在围栏里返回
    return { text: '```json\n' + JSON.stringify(out) + '\n```' };
  };
  const res = await translateDefinition(CRICKET, { name: 'Cricket', tagline: '' }, call);
  assert.equal(res.status, 'ok');
  assert.equal(res.name_zh, '克里克特');
  assert.equal(res.zh.name, '克里克特');
  assert.deepEqual(res.glossary.Cricket, '克里克特');
  // 第一次调用是译名表；触发词没被当正文 / 短文本送翻（只在译名表请求里出现）
  assert.ok(Object.values(seen[0].input).includes('door'));
  for (const x of seen.slice(1)) assert.ok(!Object.values(x.input).some((v) => v === 'door' || v === 'office' || v === 'money'));
  // 正文批 system 附了译名表
  const body = seen.slice(1).find((x) => Object.values(x.input).some((v) => v.includes('cheerful')));
  assert.match(body.system, /译名表/);
  assert.match(body.system, /Cricket → 克里克特/);
  assert.ok(!body.system.includes('door → 门'), '只附本批用得到的条目');
  // 正文里人名统一
  assert.ok(res.zh.personality.includes('克里克特') && res.zh.description.includes('克里克特'));
  assert.ok(res.zh.first_message.includes('```'), '含 ``` 的叶子也翻出来了');
  // 触发词：原词保留 + 译名追加；「门」单字不加
  assert.deepEqual(res.zh.embedded_lorebook.entries[0].keys, ['Triple A Adventures', 'door', 'office', '三A冒险事务所', '办公室']);
  assert.deepEqual(res.zh.embedded_lorebook.entries[1].keys, ['money', '金钱']);
  assert.deepEqual(res.zh.embedded_lorebook.entries[1].secondary_keys, ['Cricket', '克里克特']);
  assert.deepEqual(CRICKET.embedded_lorebook.entries[0].keys, ['Triple A Adventures', 'door', 'office'], '原对象不改');
  // 重试：上次同源译名表能覆盖全部词 → 不再请求译名表、复用叶子
  seen.length = 0;
  const again = await translateDefinition(CRICKET, { name: 'Cricket', reuse: res.zh, glossary: res.glossary }, call);
  assert.equal(again.status, 'ok');
  assert.equal(seen.length, 0, '全部复用，不调模型');
});

test('glossaryBlock 与平台元标签：root / tavern 原样保留，vanilla 等圈内词给固定译名', () => {
  assert.equal(glossaryBlock({ Cricket: '克里克特' }, ['nothing here']), '');
  assert.match(glossaryBlock({ Cricket: '克里克特' }, ['ask Cricket']), /Cricket → 克里克特/);
  // 整词、区分大小写（契约 §19.3 补丁）
  assert.equal(glossaryBlock({ Cricket: '克里克特' }, ['ask cricket']), '');
  assert.equal(glossaryBlock({ Cricket: '克里克特' }, ['Crickets chirp']), '');
  assert.equal(fixedTag('ROOT'), 'ROOT');
  assert.equal(fixedTag('Tavern'), 'Tavern');
  assert.equal(fixedTag('vanilla'), '常规向');
  assert.equal(fixedTag('LitRPG'), '游戏化小说');
  assert.equal(fixedTag('Fantasy'), null);
});

// ---------- 语音 ----------
test('语音：静音录音的幻觉文字判为没听清；正常说话不误判；整理提示词写明拿不准不加括号', () => {
  assert.equal(looksSilent({ bytes: 1765, durationMs: 5700, ext: 'webm', text: 'Thank you.' }), true);
  assert.equal(looksSilent({ bytes: 20000, durationMs: 5000, ext: 'webm', text: '好' }), false, '码率正常');
  assert.equal(looksSilent({ bytes: 1765, durationMs: 5700, ext: 'webm', text: '我放下杯子然后对她说你真的确定要这么做吗' }), false, '识别出很多字');
  assert.equal(looksSilent({ bytes: 1765, durationMs: 5700, ext: 'mp4', text: 'Thank you.' }), false, '只看 opus 类');
  assert.match(FORMAT_SYSTEM, /拿不准时一律不加括号/);
  assert.match(FORMAT_SYSTEM, /Thank you\. → 输出：Thank you\./);
});
