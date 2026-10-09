// v1.0（契约 §17 / §18）：上传文件快速开聊 + 语音输入。
// 文件解析用 macOS 自带工具真跑（textutil / swiftc 编译的 PDFKit 与 Vision 小工具 / unzip），样本都是测试里现造的小文件；
// 模型与语音识别都是假的（不出网、不调真模型）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { openDb, getSettings } from '../server/db.mjs';
import { hashPassword } from '../server/auth.mjs';
import { createApp } from '../server/app.mjs';
import { HttpError, nowIso } from '../server/util.mjs';
import { buildMessages, BRACKET_RULE } from '../server/prompt.mjs';
import { decodeText, detectType, parseFile, parseFiles, htmlToText, parseMultipartFiles, SCANNED_PDF_MESSAGE, UNSUPPORTED_MESSAGE } from '../server/fileparse.mjs';
import {
  chunkText, tokenize, buildIndex, searchIndex, retrieve, buildFileMessages, modeFor, estimateForModel, createIndexCache, FULL_MAX_CHARS, CHUNK_CHARS, CHUNK_OVERLAP,
} from '../server/filechat.mjs';
import { sniffAudio, cleanFormatted, FORMAT_SYSTEM } from '../server/voice.mjs';
import { tmpDir, cleanupTmp, listenFree, Client, parseSse } from './helpers.mjs';

const PORTS = [44985, 44986, 44987, 44988, 44989, 44982, 44983, 44984];
const RAW_SPEECH = '嗯 旁白 我放下杯子 那个 我说 你确定吗';
const FORMATTED = '（放下杯子）说道：你确定吗？';

let dir, sdir, server, base, db;
const id = {};
const who = {};
const mids = {};
const prompts = []; // streamChat 收到的 messages
const completes = []; // complete 收到的 {system, user, model_id}
let asrMode = 'ok';
const asrCalls = [];
const fakeLlm = {
  async streamChat(messages, { onDelta }) {
    prompts.push(messages);
    onDelta('我已读完');
    onDelta('资料。');
    return { text: '我已读完资料。', tokens_in: 100, tokens_out: 10, usage: true, model: 'fake' };
  },
  async complete(messages, { model } = {}) {
    completes.push({ system: messages[0].content, user: messages.at(-1).content, model_id: model?.id ?? null });
    if (messages[0].content === FORMAT_SYSTEM) return { text: `“${FORMATTED.replace('（', '(').replace('）', ')')}”`, tokens_in: 200, tokens_out: 20, usage: true, model: 'fake', model_id: model?.id };
    return { text: '译文', tokens_in: 10, tokens_out: 10, usage: true, model: 'fake', model_id: model?.id };
  },
};
const fakeAsr = {
  available: () => true,
  async transcribe(buf, { mime, ext }) {
    asrCalls.push({ bytes: buf.length, mime, ext });
    if (asrMode === 'down') throw new HttpError(503, '语音识别暂不可用', 'asr_unavailable');
    if (asrMode === 'silent') return { text: '', seconds: 1 };
    if (asrMode === 'long') return { text: RAW_SPEECH, seconds: 120 };
    return { text: RAW_SPEECH, seconds: 3 };
  },
};

async function login(u, p) {
  const c = new Client(base);
  const r = await c.post('/api/login', { username: u, password: p });
  assert.equal(r.status, 200, `${u}：${r.text}`);
  return c;
}

/** 原始请求（上传用）。 */
async function raw(c, method, p, body, headers = {}) {
  const r = await fetch(base + p, { method, headers: { cookie: c.cookie, ...headers }, body });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  c.bodies.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch { /* 二进制 */ }
  return { status: r.status, json, text, buf, headers: r.headers };
}

function multipart(files) {
  const boundary = '----aichatTest' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`, 'utf8'));
    parts.push(f.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

const upload = (c, files) => { const m = multipart(files); return raw(c, 'POST', '/api/file-chats/parse', m.body, { 'content-type': m.type }); };

// ---------- 样本（现造） ----------
const S = {};
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { ...opts, encoding: 'buffer' });
  if (r.status !== 0) throw new Error(`${cmd} 失败：${r.stderr?.toString()}`);
  return r.stdout;
}
function makeSamples() {
  sdir = path.join(dir, 'samples');
  mkdirSync(sdir, { recursive: true });
  // GBK 编码的 txt（「你好世界，林黛玉」）
  S.gbk = Buffer.concat([Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7, 0xa3, 0xac]), Buffer.from([0xc1, 0xd6, 0xf7, 0xec, 0xd3, 0xf1])]);
  const html = '<html><head><meta charset="utf-8"><title>T</title><style>.x{}</style></head><body><h1>第一章 雪夜</h1><p>贾宝玉走进大观园。</p><script>alert(1)</script></body></html>';
  writeFileSync(path.join(sdir, 'a.html'), html);
  for (const f of ['docx', 'rtf', 'odt']) run('/usr/bin/textutil', ['-inputencoding', 'UTF-8', '-convert', f, path.join(sdir, 'a.html'), '-output', path.join(sdir, `a.${f}`)]);
  S.docx = readFileSync(path.join(sdir, 'a.docx'));
  S.rtf = readFileSync(path.join(sdir, 'a.rtf'));
  S.odt = readFileSync(path.join(sdir, 'a.odt'));
  S.html = Buffer.from(html);
  // GBK 网页（meta charset=gbk）
  S.htmlGbk = Buffer.concat([Buffer.from('<html><head><meta charset="gbk"></head><body><p>'), S.gbk, Buffer.from('</p></body></html>')]);
  // PDF（文字版）与 PNG（文字图）：cupsfilter 文本 → PDF，sips 渲染成 PNG
  writeFileSync(path.join(sdir, 't.txt'), '这是一段测试文字。\nHello PDF 12345\n');
  S.pdf = run('/usr/sbin/cupsfilter', ['-i', 'text/plain', '-m', 'application/pdf', path.join(sdir, 't.txt')], { stdio: ['ignore', 'pipe', 'ignore'] });
  writeFileSync(path.join(sdir, 't.pdf'), S.pdf);
  run('/usr/bin/sips', ['-s', 'format', 'png', path.join(sdir, 't.pdf'), '--out', path.join(sdir, 't.png')], { stdio: 'ignore' });
  S.png = readFileSync(path.join(sdir, 't.png'));
  // 扫描版（没有文字层的空白页）
  S.blankPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  // EPUB：spine 顺序与文件名字母序相反（验证按 spine 排）
  const ep = path.join(sdir, 'ep');
  mkdirSync(path.join(ep, 'META-INF'), { recursive: true });
  mkdirSync(path.join(ep, 'OEBPS'), { recursive: true });
  writeFileSync(path.join(ep, 'mimetype'), 'application/epub+zip');
  writeFileSync(path.join(ep, 'META-INF/container.xml'), '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  writeFileSync(path.join(ep, 'OEBPS/content.opf'), '<package><manifest><item id="c2" href="b.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="z.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
  writeFileSync(path.join(ep, 'OEBPS/z.xhtml'), '<html><body><p>第一章：孙悟空出世</p></body></html>');
  writeFileSync(path.join(ep, 'OEBPS/b.xhtml'), '<html><body><p>第二章：大闹天宫 &amp; 花果山</p></body></html>');
  run('/usr/bin/zip', ['-q', '-X', '-r', '../book.epub', 'mimetype', 'META-INF', 'OEBPS'], { cwd: ep });
  S.epub = readFileSync(path.join(sdir, 'book.epub'));
  // PPTX
  const pp = path.join(sdir, 'pp');
  mkdirSync(path.join(pp, 'ppt/slides'), { recursive: true });
  writeFileSync(path.join(pp, '[Content_Types].xml'), '<Types/>');
  writeFileSync(path.join(pp, 'ppt/slides/slide2.xml'), '<p:sld><a:p><a:r><a:t>第二页：结论</a:t></a:r></a:p></p:sld>');
  writeFileSync(path.join(pp, 'ppt/slides/slide10.xml'), '<p:sld><a:p><a:r><a:t>第十页：附录</a:t></a:r></a:p></p:sld>');
  writeFileSync(path.join(pp, 'ppt/slides/slide1.xml'), '<p:sld><a:p><a:r><a:t>项目</a:t></a:r><a:r><a:t>汇报</a:t></a:r></a:p><a:p><a:r><a:t>第二段</a:t></a:r></a:p></p:sld>');
  run('/usr/bin/zip', ['-q', '-X', '-r', '../deck.pptx', '.'], { cwd: pp });
  S.pptx = readFileSync(path.join(sdir, 'deck.pptx'));
  // XLSX
  const xx = path.join(sdir, 'xx');
  mkdirSync(path.join(xx, 'xl/worksheets'), { recursive: true });
  writeFileSync(path.join(xx, 'xl/workbook.xml'), '<workbook><sheets><sheet name="人物表" sheetId="1"/></sheets></workbook>');
  writeFileSync(path.join(xx, 'xl/sharedStrings.xml'), '<sst><si><t>姓名</t></si><si><t>年龄</t></si><si><t>林冲</t></si></sst>');
  writeFileSync(path.join(xx, 'xl/worksheets/sheet1.xml'), '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>35</v></c></row></sheetData></worksheet>');
  run('/usr/bin/zip', ['-q', '-X', '-r', '../t.xlsx', '.'], { cwd: xx });
  S.xlsx = readFileSync(path.join(sdir, 't.xlsx'));
}

const webm = (n = 2000) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(n, 7)]);
const pdirs = () => ({ tmpDir: path.join(dir, 'tmp-parse'), binDir: path.join(dir, 'bin') });

before(async () => {
  dir = tmpDir('unit-v10fv');
  makeSamples();
  db = openDb(path.join(dir, 'aichat.sqlite'));
  const ins = db.prepare('INSERT INTO users(username, password_hash, display_name, is_admin, role, nsfw_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  id.super = Number(ins.run('root', hashPassword('root-pass-1'), '超管', 1, 'super', 1, nowIso()).lastInsertRowid);
  id.admin = Number(ins.run('ops', hashPassword('ops-pass-11'), '管理员', 1, 'admin', 0, nowIso()).lastInsertRowid);
  id.a = Number(ins.run('alice', hashPassword('alice-pass-1'), '爱丽丝', 0, 'tenant', 0, nowIso()).lastInsertRowid);
  id.b = Number(ins.run('bob', hashPassword('bob-pass-12'), '鲍勃', 0, 'tenant', 0, nowIso()).lastInsertRowid);
  id.c = Number(ins.run('carol', hashPassword('carol-pass-1'), '卡萝', 0, 'tenant', 0, nowIso()).lastInsertRowid);
  const mi = db.prepare("INSERT INTO models(name, provider, base_url, model, enabled, sort, currency, price_in, price_in_cached, price_out, created_at) VALUES (?, ?, ?, ?, 1, ?, 'CNY', 2, 0.04, 8, ?)");
  mids.chat = Number(mi.run('假对话', '测试', 'https://api.example.com/v1', 'fake', 1, nowIso()).lastInsertRowid);
  mids.ds = Number(mi.run('DeepSeek 快速', 'DeepSeek', 'https://api.deepseek.com', 'deepseek-flash', 2, nowIso()).lastInsertRowid);
  mids.ds2 = Number(mi.run('DeepSeek 专业', 'DeepSeek', 'https://api.deepseek.com', 'deepseek-v4-pro', 3, nowIso()).lastInsertRowid);
  db.prepare("UPDATE settings SET value = ? WHERE key = 'default_model_id'").run(String(mids.chat));
  const app = createApp({ db, chub: { search: async () => ({ items: [], page: 1, has_more: false }), character: async () => { throw new HttpError(404, 'x'); } }, llm: fakeLlm,
    avatars: { get: async () => ({ type: 'image/png', buf: Buffer.from('x') }) }, asr: fakeAsr,
    config: { publicDir: path.join(dir, 'pub'), deepseekModel: 'fake', dataDir: dir } });
  server = http.createServer(app.handle);
  base = `http://127.0.0.1:${await listenFree(server, PORTS)}`;
  who.super = await login('root', 'root-pass-1');
  who.admin = await login('ops', 'ops-pass-11');
  who.a = await login('alice', 'alice-pass-1');
  who.b = await login('bob', 'bob-pass-12');
  who.c = await login('carol', 'carol-pass-1');
});

after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  cleanupTmp(dir);
});

// ---------- 解析：各格式（真跑系统工具） ----------
test('编码识别：GBK / UTF-16 BOM / UTF-8；类型按扩展名与魔数', () => {
  assert.equal(decodeText(S.gbk), '你好世界，林黛玉');
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文ab', 'utf16le')])), '中文ab');
  assert.equal(decodeText(Buffer.from('普通 UTF-8')), '普通 UTF-8');
  assert.equal(detectType('x.TXT'), 'txt');
  assert.equal(detectType('x.jpeg'), 'jpg');
  assert.equal(detectType('noext', Buffer.from('%PDF-1.4')), 'pdf');
  assert.equal(detectType('x.exe', Buffer.from('MZ')), null);
  assert.equal(htmlToText('<p>a&amp;b</p><script>x()</script><br>c'), 'a&b\n\nc'.replace('\n\n', '\n\n'));
});

test('解析各格式：txt(GBK)、docx、rtf、odt、html(GBK)、pdf、epub(spine 顺序)、pptx、xlsx、png 文字图', async () => {
  const o = pdirs();
  const p = async (name, data) => parseFile({ name, data }, o);
  let r = await p('小说.txt', S.gbk);
  assert.ok(r.ok && r.text.includes('林黛玉'), JSON.stringify(r));
  for (const [n, d] of [['a.docx', S.docx], ['a.rtf', S.rtf], ['a.odt', S.odt], ['a.html', S.html]]) {
    r = await p(n, d);
    assert.ok(r.ok, `${n}：${r.error}`);
    assert.ok(r.text.includes('贾宝玉走进大观园'), `${n}：${r.text}`);
    assert.ok(!r.text.includes('alert'), `${n} 不该带脚本`);
  }
  r = await p('gbk.htm', S.htmlGbk);
  assert.ok(r.text.includes('你好世界'), r.text);
  r = await p('t.pdf', S.pdf);
  assert.ok(r.ok && r.text.includes('这是一段测试文字') && r.text.includes('Hello PDF 12345'), JSON.stringify(r));
  r = await p('scan.pdf', S.blankPdf);
  assert.equal(r.ok, false);
  assert.equal(r.error, SCANNED_PDF_MESSAGE);
  r = await p('book.epub', S.epub);
  assert.ok(r.ok, r.error);
  assert.ok(r.text.indexOf('孙悟空出世') >= 0 && r.text.indexOf('孙悟空出世') < r.text.indexOf('大闹天宫'), r.text);
  assert.ok(r.text.includes('大闹天宫 & 花果山'));
  r = await p('deck.pptx', S.pptx);
  assert.ok(r.ok, r.error);
  assert.ok(r.text.indexOf('项目汇报') < r.text.indexOf('第二页') && r.text.indexOf('第二页') < r.text.indexOf('第十页'), r.text);
  r = await p('t.xlsx', S.xlsx);
  assert.ok(r.ok && r.text.includes('人物表') && r.text.includes('林冲\t35'), r.text);
  r = await p('shot.png', S.png);
  assert.ok(r.ok && r.text.includes('测试文字'), JSON.stringify(r));
  r = await p('virus.exe', Buffer.from('MZxxxx'));
  assert.equal(r.ok, false);
  assert.equal(r.error, UNSUPPORTED_MESSAGE);
  r = await p('big.txt', Buffer.alloc(20 * 1024 * 1024 + 1, 0x61));
  assert.equal(r.error, '文件超过 20MB');
  // 原始上传文件解析完立即删除：临时目录里不留东西
  assert.deepEqual(readdirSync(o.tmpDir), []);
  // Swift 小工具编译到了 DATA_DIR/bin
  assert.ok(existsSync(path.join(o.binDir, 'pdftext')) && existsSync(path.join(o.binDir, 'ocr')));
});

test('多文件：合并正文、最多 5 个；multipart 多文件解析', async () => {
  const m = multipart([{ name: 'a.txt', data: Buffer.from('甲') }, { name: '乙 文件.md', data: Buffer.from('乙') }]);
  const parts = parseMultipartFiles(m.body, m.type);
  assert.deepEqual(parts.map((x) => [x.name, x.data.toString()]), [['a.txt', '甲'], ['乙 文件.md', '乙']]);
  const r = await parseFiles([{ name: 'a.txt', data: Buffer.from('甲甲') }, { name: 'b.txt', data: Buffer.from('乙乙') }], pdirs());
  assert.ok(r.text.includes('《a.txt》\n甲甲') && r.text.includes('《b.txt》\n乙乙'));
  await assert.rejects(parseFiles(Array.from({ length: 6 }, (_, i) => ({ name: `${i}.txt`, data: Buffer.from('x') })), pdirs()), /最多上传 5 个/);
});

// ---------- 检索模式（纯函数） ----------
test('切块（约 1500 字、重叠 150 字）+ 中文二字切分 BM25 能找到相关段落', () => {
  const paras = Array.from({ length: 300 }, (_, i) => `第${i}段。这里是普通的叙述文字，讲述天气和街道的日常景象，没有什么特别的事情发生。`.repeat(3));
  paras[217] = '机密段落：青铜罗盘藏在钟楼地下室的第三块砖后面。Golden compass hidden under the bell tower.';
  const text = paras.join('\n');
  const chunks = chunkText(text);
  assert.ok(chunks.length > 10);
  assert.ok(chunks.every((c) => c.length <= CHUNK_CHARS + CHUNK_OVERLAP + 200));
  assert.ok(chunks[1].startsWith(chunks[0].slice(-CHUNK_OVERLAP)), '相邻块要重叠');
  assert.deepEqual(tokenize('青铜罗盘 Bell Tower'), ['青铜', '铜罗', '罗盘', 'bell', 'tower']);
  const idx = { chunks, index: buildIndex(chunks) };
  const hits = searchIndex(idx.index, '罗盘藏在哪里？');
  assert.ok(chunks[hits[0].idx].includes('青铜罗盘'));
  assert.ok(chunks[searchIndex(idx.index, 'where is the golden compass')[0].idx].includes('Golden compass'));
  const got = retrieve(idx, '罗盘在钟楼哪里', { top: 20, budget: 30000 });
  assert.ok(got.some((g) => g.text.includes('青铜罗盘')));
  assert.ok(got.reduce((a, g) => a + g.text.length, 0) <= 30000 + CHUNK_CHARS);
  assert.deepEqual(got.map((g) => g.idx), [...got.map((g) => g.idx)].sort((a, b) => a - b), '按原文顺序');
  assert.equal(modeFor(FULL_MAX_CHARS), 'full');
  assert.equal(modeFor(FULL_MAX_CHARS + 1), 'retrieval');
  const cache = createIndexCache({ size: 2 });
  let loads = 0;
  for (const k of [1, 2, 1, 3, 1, 2]) cache.get(k, () => { loads += 1; return ['a']; });
  assert.equal(cache.size, 2);
  assert.equal(loads, 4, 'LRU：1 常用不被挤掉');
});

test('文件会话提示词：资料在前（整份逐字），说明在资料之后、对话规则之前；检索模式只放开头与片段', () => {
  const user = { display_name: '小明' };
  const full = buildFileMessages({ file: { text: 'ABC资料正文', mode: 'full', files: [{ name: 'a.txt', ok: true }], total_chars: 7 }, settings: { instruction: '你扮演书中的老师' }, user, history: [{ role: 'user', content: '你好' }], extraUser: '' });
  const sys = full[0].content;
  assert.ok(sys.indexOf('<资料>\nABC资料正文\n</资料>') > 0);
  assert.ok(sys.indexOf('</资料>') < sys.indexOf('【说明】') && sys.indexOf('【说明】') < sys.indexOf('【对话规则】'));
  assert.ok(sys.includes('推测') && sys.includes(BRACKET_RULE) && sys.includes('未成年人'));
  assert.equal(full.at(-1).content, '你好');
  const longText = 'X'.repeat(5000);
  const rt = buildFileMessages({ file: { text: longText, mode: 'retrieval', files: [], total_chars: 999999 }, snippets: [{ idx: 4, text: '片段内容' }], settings: {}, user, history: [], extraUser: '引导' });
  assert.ok(rt[0].content.includes('【片段 5】\n片段内容'));
  assert.ok(!rt[0].content.includes('X'.repeat(3001)), '检索模式只放开头 3000 字');
  assert.equal(rt.at(-1).content, '引导');
  const e = estimateForModel({ base_url: 'https://api.example.com', currency: 'USD', price_in: 1, price_in_cached: 0.1, price_out: 2 }, { text: '中'.repeat(100000), total_chars: 100000, mode: 'full' });
  assert.ok(e.first_message_usd > e.per_message_usd && e.per_message_usd > 0, JSON.stringify(e));
  // §18.1：普通角色提示词也带括号规则
  assert.ok(buildMessages({ definition: {}, charName: 'A', user, history: [] })[0].content.includes(BRACKET_RULE));
});

// ---------- 文件会话（HTTP） ----------
let fileChatId;
test('上传解析 → upload_id（只本人能用）→ 同步建文件会话：首条 AI 消息、文件名标签、日志不记正文', async () => {
  let r = await upload(who.a, [{ name: '红楼.txt', data: S.gbk }, { name: 'a.docx', data: S.docx }, { name: 'bad.exe', data: Buffer.from('MZ') }]);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.files.length, 3);
  assert.deepEqual(r.json.files.map((f) => f.ok), [true, true, false]);
  assert.equal(r.json.files[2].error, UNSUPPORTED_MESSAGE);
  assert.equal(r.json.mode, 'full');
  assert.ok(r.json.total_chars > 10);
  assert.ok(r.json.estimate_per_message_usd > 0);
  assert.ok(Array.isArray(r.json.estimates) && r.json.estimates.some((x) => x.model_id === mids.ds));
  assert.match(r.json.upload_id, /^[0-9a-f]{32}$/);
  const up = r.json.upload_id;
  // 别人拿不到
  assert.equal((await who.b.post('/api/file-chats', { upload_id: up })).status, 404);
  prompts.length = 0;
  r = await who.a.post('/api/file-chats', { upload_id: up, instruction: '你扮演林黛玉陪我聊天', model_id: mids.ds });
  assert.equal(r.status, 200, r.text);
  fileChatId = r.json.chat.id;
  assert.equal(r.json.chat.kind, 'file');
  assert.equal(r.json.chat.character.kind, 'file');
  assert.equal(r.json.chat.character.name, '红楼.txt');
  assert.equal(r.json.chat.title, '红楼.txt 等 2 个文件');
  assert.equal(r.json.message.role, 'assistant');
  assert.equal(r.json.message.content, '我已读完资料。');
  const sys = prompts[0][0].content;
  assert.ok(sys.includes('林黛玉') && sys.includes('贾宝玉走进大观园'));
  assert.ok(sys.indexOf('</资料>') < sys.indexOf('你扮演林黛玉陪我聊天'));
  assert.match(prompts[0].at(-1).content, /按说明直接开场/);
  // upload_id 用过即作废
  assert.equal((await who.a.post('/api/file-chats', { upload_id: up })).status, 404);
  const log = db.prepare("SELECT * FROM logs WHERE kind = 'chat.file_create' ORDER BY id DESC LIMIT 1").get();
  assert.ok(log && log.target_id === fileChatId);
  assert.ok(!log.detail_json.includes('贾宝玉') && !log.detail_json.includes('林黛玉陪我'), '日志不记正文与说明');
  assert.ok(log.detail_json.includes('红楼.txt'));
});

test('文件会话：详情带 file（不带全文）、全文只本人、列表显示文件名；继续聊 system 逐字不变（前缀缓存）', async () => {
  let r = await who.a.get(`/api/chats/${fileChatId}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.file.files.map((f) => f.name), ['红楼.txt', 'a.docx', 'bad.exe']);
  assert.equal(r.json.file.instruction, '你扮演林黛玉陪我聊天');
  assert.equal(r.json.file.mode, 'full');
  assert.ok(!r.text.includes('贾宝玉走进大观园'), '详情不返回全文');
  r = await who.a.get(`/api/chats/${fileChatId}/file-text`);
  assert.ok(r.json.text.includes('贾宝玉走进大观园'));
  assert.equal((await who.b.get(`/api/chats/${fileChatId}/file-text`)).status, 404);
  r = await who.a.get('/api/chats');
  const it = r.json.items.find((x) => x.id === fileChatId);
  assert.equal(it.kind, 'file');
  assert.equal(it.character.name, '红楼.txt');
  prompts.length = 0;
  await who.a.post(`/api/chats/${fileChatId}/messages`, { content: '你是谁？' });
  await who.a.post(`/api/chats/${fileChatId}/messages`, { content: '（叹气）说道：今天好累。' });
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0][0].content, prompts[1][0].content, 'system 不随轮次变化');
  assert.equal(prompts[1].at(-1).content, '（叹气）说道：今天好累。');
});

test('文件会话：本会话设定改「一句话说明」下一条起生效；SSE 建会话；重新生成首条', async () => {
  let r = await who.a.patch(`/api/chats/${fileChatId}/settings`, { override: { instruction: '改为问答模式' } });
  assert.equal(r.status, 200, r.text);
  prompts.length = 0;
  await who.a.post(`/api/chats/${fileChatId}/messages`, { content: '继续' });
  assert.ok(prompts[0][0].content.includes('改为问答模式') && !prompts[0][0].content.includes('你扮演林黛玉陪我聊天'));
  // 聊天页开头说明 / 文件资料弹层用生效值（复核修复）
  const fi = (await who.a.get(`/api/chats/${fileChatId}`)).json.file;
  assert.equal(fi.instruction, '改为问答模式');
  assert.equal(fi.instruction_original, '你扮演林黛玉陪我聊天');
  // SSE 模式
  r = await upload(who.a, [{ name: 'n.md', data: Buffer.from('# 笔记\n内容甲乙丙') }]);
  const res = await fetch(`${base}/api/file-chats`, { method: 'POST', headers: { cookie: who.a.cookie, 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ upload_id: r.json.upload_id }) });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const ev = parseSse(await res.text());
  assert.deepEqual(ev.map((e) => e.event), ['chat', 'delta', 'delta', 'done']);
  const cid = ev[0].data.chat.id;
  assert.equal(ev[0].data.chat.kind, 'file');
  // 说明为空：首条引导是「概括 + 问想聊什么」
  // 还没有用户消息时可以重新生成首条
  prompts.length = 0;
  const rg = await fetch(`${base}/api/chats/${cid}/regenerate`, { method: 'POST', headers: { cookie: who.a.cookie } });
  assert.ok(parseSse(await rg.text()).some((e) => e.event === 'done'));
  assert.match(prompts[0].at(-1).content, /概括资料的内容/);
  const msgs = (await who.a.get(`/api/chats/${cid}`)).json.messages;
  assert.equal(msgs.length, 1, '旧首条被替换（软删）');
});

test('文件较大（> 15 万字）→ 检索模式：存块、按问题查阅相关段落，system 不放全文', async () => {
  const filler = '这是一段普通的填充文字，用来把文件撑大，描述城市街道与日常天气。\n';
  const parts = [];
  for (let i = 0; i < 5200; i++) parts.push(i === 4100 ? '关键线索：紫色钥匙放在灯塔顶层的抽屉里。\n' : filler);
  const big = Buffer.from(parts.join(''));
  let r = await upload(who.a, [{ name: '长篇.txt', data: big }]);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.mode, 'retrieval');
  assert.equal(r.json.notice, '文件较大，AI 会按你的问题查阅相关段落');
  r = await who.a.post('/api/file-chats', { upload_id: r.json.upload_id });
  const cid = r.json.chat.id;
  const n = db.prepare('SELECT COUNT(*) AS n FROM chat_file_chunks WHERE chat_id = ?').get(cid).n;
  assert.ok(n > 100);
  assert.equal((await who.a.get(`/api/chats/${cid}`)).json.file.mode, 'retrieval');
  prompts.length = 0;
  await who.a.post(`/api/chats/${cid}/messages`, { content: '紫色钥匙在哪里？' });
  const sys = prompts[0][0].content;
  assert.ok(sys.includes('关键线索：紫色钥匙放在灯塔顶层的抽屉里'));
  assert.ok(sys.length < 40000, `system 太长：${sys.length}`);
  assert.ok(sys.includes('<资料开头>'));
});

test('文件会话：本人可看文件名、说明与全文；删会话后接口不可见但软删数据保留', async () => {
  const r = await who.a.get(`/api/chats/${fileChatId}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.chat.kind, 'file');
  assert.equal(r.json.file.files[0].name, '红楼.txt');
  assert.equal(r.json.file.instruction, '改为问答模式');
  assert.equal(r.json.file.instruction_original, '你扮演林黛玉陪我聊天');
  assert.equal(r.json.chat.settings_modified, true);
  assert.ok((await who.a.get(`/api/chats/${fileChatId}/file-text`)).json.text.includes('贾宝玉走进大观园'));
  for (const user of [who.b, who.admin, who.super]) {
    assert.equal((await user.get(`/api/chats/${fileChatId}/file-text`)).status, 404);
  }
  assert.equal((await who.a.del(`/api/chats/${fileChatId}`)).status, 200);
  assert.equal((await who.a.get(`/api/chats/${fileChatId}/file-text`)).status, 404);
  const stored = db.prepare('SELECT text FROM chat_files WHERE chat_id = ?').get(fileChatId);
  assert.ok(stored.text.includes('贾宝玉走进大观园'));
});

test('上传接口：没文件 400、没登录 401、过期 / 不存在的 upload_id 404', async () => {
  assert.equal((await raw(who.a, 'POST', '/api/file-chats/parse', Buffer.alloc(0), { 'content-type': 'application/octet-stream' })).status, 400);
  assert.equal((await fetch(`${base}/api/file-chats/parse`, { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } })).status, 401);
  // 原始请求体 + X-File-Name
  const r = await raw(who.a, 'POST', '/api/file-chats/parse', Buffer.from('单个文件正文'), { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('单个.txt') });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.files[0].name, '单个.txt');
  assert.equal((await who.a.post('/api/file-chats', { upload_id: 'f'.repeat(32) })).status, 404);
  assert.equal((await who.a.post('/api/file-chats', { upload_id: '../x' })).status, 404);
});

// ---------- 语音（§18） ----------
test('语音纯函数：魔数认格式、整理结果清理', () => {
  assert.equal(sniffAudio(webm()).ext, 'webm');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(8)])).ext, 'mp4');
  assert.equal(sniffAudio(Buffer.from('OggS' + 'x'.repeat(20))).ext, 'ogg');
  assert.equal(sniffAudio(Buffer.from('hello world, not audio')), null);
  assert.equal(cleanFormatted('"(放下杯子)说道:真的吗？"', '原文'), '（放下杯子）说道：真的吗？');
  assert.equal(cleanFormatted('', '原文'), '原文');
  assert.equal(cleanFormatted('很长'.repeat(200), '短'), '短', '模型续写时退回原文');
  assert.ok(FORMAT_SYSTEM.includes('（戏谑地看着她）说道：哦？'));
});

let clipId;
let voiceChat;
test('语音识别：原件按原格式落盘、识别 + 整理、花费记 system_costs(voice)；格式 / 大小 / 类型校验', async () => {
  voiceChat = (await who.a.post('/api/file-chats', { upload_id: (await upload(who.a, [{ name: 'v.txt', data: Buffer.from('语音测试资料') }])).json.upload_id })).json.chat.id;
  completes.length = 0;
  let r = await raw(who.a, 'POST', `/api/voice/transcribe?chat_id=${voiceChat}&duration_ms=3200`, webm(), { 'content-type': 'audio/webm;codecs=opus' });
  assert.equal(r.status, 200, r.text);
  clipId = r.json.clip_id;
  assert.equal(r.json.raw_text, RAW_SPEECH);
  assert.equal(r.json.formatted_text, FORMATTED);
  assert.ok(r.json.cost_usd > 0);
  assert.equal(asrCalls.at(-1).mime, 'audio/webm;codecs=opus');
  assert.ok(completes.some((c) => c.system === FORMAT_SYSTEM && c.user.includes(RAW_SPEECH) && c.model_id === mids.ds), '默认用 DeepSeek 快速整理');
  const v = db.prepare('SELECT * FROM voice_clips WHERE id = ?').get(clipId);
  assert.match(v.file, new RegExp(`^${id.a % 1000}/[0-9a-f-]{36}\\.webm$`));
  assert.ok(readFileSync(path.join(dir, 'voice', v.file)).equals(webm()), '原件原样保存');
  assert.equal(v.chat_id, voiceChat);
  assert.equal(v.duration_ms, 3200);
  assert.equal(v.message_id, null);
  const sc = db.prepare("SELECT COUNT(*) AS n, SUM(cost_usd) AS s FROM system_costs WHERE kind = 'voice' AND user_id = ?").get(id.a);
  assert.equal(sc.n, 2, '识别一笔 + 整理一笔');
  // 校验
  assert.equal((await raw(who.a, 'POST', '/api/voice/transcribe', Buffer.from('hi'), { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await raw(who.a, 'POST', '/api/voice/transcribe', Buffer.alloc(100, 1), { 'content-type': 'audio/webm' })).status, 415);
  // 超过 10MB：服务端回 413 并断开连接（客户端可能只看到连接被重置）
  const tooBig = await raw(who.a, 'POST', '/api/voice/transcribe', Buffer.concat([webm(10), Buffer.alloc(10 * 1024 * 1024)]), { 'content-type': 'audio/webm' }).catch(() => ({ status: 413 }));
  assert.equal(tooBig.status, 413);
  assert.equal((await raw(who.b, 'POST', `/api/voice/transcribe?chat_id=${voiceChat}`, webm(), { 'content-type': 'audio/webm' })).status, 404, '别人的会话');
  // 超管设置语音整理模型
  assert.equal((await who.super.patch('/api/admin/settings', { voice_format_model_id: mids.ds2 })).json.settings.voice_format_model_id, mids.ds2);
  completes.length = 0;
  r = await raw(who.a, 'POST', '/api/voice/transcribe', webm(), { 'content-type': 'audio/webm' });
  assert.equal(completes.find((c) => c.system === FORMAT_SYSTEM).model_id, mids.ds2);
  await who.super.patch('/api/admin/settings', { voice_format_model_id: null });
  // 用量页：super 看到语音花费
  r = await who.super.get('/api/admin/usage?days=1');
  assert.ok(r.json.system_costs.voice_usd > 0);
});

test('发送带 voice_clip_id：绑定到用户消息；用户侧与普通文字消息完全一样；clip 只能用一次、只能用自己的', async () => {
  const edited = '（放下杯子）说道：你真的确定吗？';
  let r = await who.a.post(`/api/chats/${voiceChat}/messages`, { content: edited, voice_clip_id: clipId });
  const ev = parseSse(r.text);
  const um = ev.find((e) => e.event === 'user').data.message;
  assert.equal(um.content, edited, '内容以输入框最终文字为准');
  assert.deepEqual(Object.keys(um).sort(), ['content', 'created_at', 'id', 'role']);
  const v = db.prepare('SELECT * FROM voice_clips WHERE id = ?').get(clipId);
  assert.equal(v.message_id, um.id);
  r = await who.a.post(`/api/chats/${voiceChat}/messages`, { content: 'x', voice_clip_id: clipId });
  assert.equal(r.status, 400, '已用过');
  // 别人的 clip
  const other = (await raw(who.b, 'POST', '/api/voice/transcribe', webm(), { 'content-type': 'audio/webm' })).json.clip_id;
  r = await who.a.post(`/api/chats/${voiceChat}/messages`, { content: 'x', voice_clip_id: other });
  assert.equal(r.status, 400);
  // 用户侧接口拿不到录音与识别原文
  r = await who.a.get(`/api/chats/${voiceChat}`);
  assert.ok(!r.text.includes('voice') && !r.text.includes(RAW_SPEECH));
  // 整段用户侧响应里都没有识别原文（只在 transcribe 的返回里给本人看了一次 raw_text）
  const userBodies = who.a.bodies.filter((t) => !t.includes('"clip_id"'));
  assert.ok(!userBodies.some((t) => t.includes(RAW_SPEECH)));
});

test('软删：用户删消息 / 会话后 clip 只标 deleted_at，文件保留', async () => {
  const msg = db.prepare('SELECT message_id FROM voice_clips WHERE id = ?').get(clipId).message_id;
  // 再录一段放在这个会话但不发送
  const unsent = (await raw(who.a, 'POST', `/api/voice/transcribe?chat_id=${voiceChat}`, webm(), { 'content-type': 'audio/webm' })).json.clip_id;
  assert.equal((await who.a.del(`/api/messages/${msg}`)).status, 200);
  assert.ok(db.prepare('SELECT deleted_at FROM voice_clips WHERE id = ?').get(clipId).deleted_at);
  assert.equal(db.prepare('SELECT deleted_at FROM voice_clips WHERE id = ?').get(unsent).deleted_at, null);
  assert.equal((await who.a.del(`/api/chats/${voiceChat}`)).status, 200);
  assert.ok(db.prepare('SELECT deleted_at FROM voice_clips WHERE id = ?').get(unsent).deleted_at);
  const clips = db.prepare('SELECT file, deleted_at FROM voice_clips WHERE chat_id = ?').all(voiceChat);
  assert.ok(clips.length >= 2 && clips.every((x) => x.deleted_at));
  for (const clip of clips) assert.ok(readFileSync(path.join(dir, 'voice', clip.file)).equals(webm()));
});

test('识别失败：503 asr_unavailable（前端退回浏览器识别），录音照样保存、日志不记识别文字；没说话时不调整理', async () => {
  asrMode = 'down';
  let r = await raw(who.c, 'POST', '/api/voice/transcribe', webm(), { 'content-type': 'audio/webm' });
  assert.equal(r.status, 503);
  assert.equal(r.json.code, 'asr_unavailable');
  const v = db.prepare('SELECT * FROM voice_clips WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(id.c);
  assert.ok(v && v.error && existsSync(path.join(dir, 'voice', v.file)));
  const log = db.prepare("SELECT * FROM logs WHERE kind = 'voice.error' ORDER BY id DESC LIMIT 1").get();
  assert.ok(log && !String(log.detail_json).includes(RAW_SPEECH));
  asrMode = 'silent';
  completes.length = 0;
  r = await raw(who.c, 'POST', '/api/voice/transcribe', webm(), { 'content-type': 'audio/webm' });
  assert.equal(r.status, 200);
  assert.equal(r.json.formatted_text, '');
  assert.equal(r.json.empty, true);
  assert.equal(completes.length, 0);
  asrMode = 'ok';
});

test('限流：每人每分钟 10 次；「识别后直接发送」开关存在用户设置里', async () => {
  const c2 = await login('bob', 'bob-pass-12');
  let last;
  for (let i = 0; i < 10; i++) last = await raw(c2, 'POST', '/api/voice/transcribe', webm(), { 'content-type': 'audio/webm' });
  // bob 前面已用过 1 次：第 10 次请求累计 11 次 → 429
  assert.equal(last.status, 429);
  let r = await who.a.get('/api/me');
  assert.equal(r.json.user.voice_auto_send, false);
  r = await who.a.patch('/api/me', { voice_auto_send: true });
  assert.equal(r.json.user.voice_auto_send, true);
  assert.equal((await who.a.get('/api/me')).json.user.voice_auto_send, true);
});

test('第 2 轮复核：读不出时长的大文件、非浏览器录音格式、超长录音一律不落盘；上游秒数超长的删原件；录音每日上限默认非 0', async () => {
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM voice_clips WHERE user_id = ?').get(id.c).n;
  const n0 = count();
  // ADTS 头 + 3MB 垃圾：afinfo 读不出时长 → 415，不落盘
  const adts = Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc]), Buffer.alloc(3 * 1024 * 1024, 0x41)]);
  let r = await raw(who.c, 'POST', '/api/voice/transcribe', adts, { 'content-type': 'audio/aac' });
  assert.equal(r.status, 415, r.text);
  // 只有 RIFF/WAVE 头：浏览器录音不会产出 wav，不收
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(1024 * 1024, 0x42)]);
  r = await raw(who.c, 'POST', '/api/voice/transcribe', wav, { 'content-type': 'audio/wav' });
  assert.equal(r.status, 415);
  // webm 2.5MB（读不出时长且超过 2MB）→ 413
  r = await raw(who.c, 'POST', '/api/voice/transcribe', webm(2.5 * 1024 * 1024), { 'content-type': 'audio/webm' });
  assert.equal(r.status, 413);
  // 前端计时就超过 60 秒 → 413
  r = await raw(who.c, 'POST', '/api/voice/transcribe?duration_ms=90000', webm(), { 'content-type': 'audio/webm' });
  assert.equal(r.status, 413);
  assert.equal(count(), n0, '以上都没落盘');
  // 上游返回实际 120 秒：花费照记，删原件、记 error
  asrMode = 'long';
  r = await raw(who.c, 'POST', '/api/voice/transcribe', webm(), { 'content-type': 'audio/webm' });
  asrMode = 'ok';
  assert.equal(r.status, 413);
  const v = db.prepare('SELECT * FROM voice_clips WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(id.c);
  assert.ok(v.error && v.error.includes('60 秒'));
  assert.equal(v.duration_ms, 120000);
  assert.ok(!existsSync(path.join(dir, 'voice', v.file)), '原件已删');
  const st = getSettings(db);
  assert.ok(st.voice_daily_max_clips > 0 && st.voice_daily_max_mb > 0, '录音每日上限默认非 0');
});
