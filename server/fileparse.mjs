// 上传文件 → 纯文本（契约 §16.1，由 §17 复用）。零 npm 依赖，只用 macOS 自带工具：
//   纯文本类：自动识别编码（UTF-8 / UTF-16 BOM / GB18030，用 TextDecoder）
//   doc / docx / rtf / odt / webarchive：/usr/bin/textutil -convert txt -stdout
//   html / htm：服务端自己去标签（不交给 textutil：它会按网页去加载外链资源，且无 charset 时会猜错编码）
//   pdf：tools/pdftext.swift（PDFKit），图片：tools/ocr.swift（Vision）；首次使用时 swiftc 编译到 DATA_DIR/bin
//   epub / pptx / xlsx：/usr/bin/unzip -p 取内部 xhtml / xml，去标签取正文（EPUB 按 spine 顺序）
// 所有子进程：参数数组调用（不经 shell）、带超时、输出有上限；能用 sandbox-exec 时禁止联网。
// 原始上传文件只在解析期间落在临时目录，解析完（无论成败）立刻删除。
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './util.mjs';
import { ROOT } from './config.mjs';

export const FILE_MAX_BYTES = 20 * 1024 * 1024;
export const FILES_MAX = 5;
export const TEXT_MAX_CHARS = 2_000_000;
export const TOOL_TIMEOUT_MS = 60_000;
const COMPILE_TIMEOUT_MS = 180_000;
const TOOL_OUTPUT_MAX = 32 * 1024 * 1024;

const TEXT_EXT = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'srt', 'vtt', 'log'];
const TEXTUTIL_EXT = ['doc', 'docx', 'rtf', 'odt', 'webarchive'];
const HTML_EXT = ['html', 'htm', 'xhtml'];
const ZIP_EXT = ['epub', 'pptx', 'xlsx'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'heic', 'heif'];
export const SUPPORTED_EXT = [...TEXT_EXT, ...TEXTUTIL_EXT, ...HTML_EXT, 'pdf', ...ZIP_EXT, ...IMAGE_EXT];
export const SUPPORTED_TEXT = 'txt、md、csv、json、srt、doc、docx、rtf、odt、html、pdf（文字版）、epub、pptx、xlsx、png、jpg、webp、heic';
export const UNSUPPORTED_MESSAGE = `不支持这种文件格式。支持：${SUPPORTED_TEXT}`;
export const SCANNED_PDF_MESSAGE = '这是图片扫描版，请上传文字版或截图';

const SANDBOX = '/usr/bin/sandbox-exec';
/**
 * 沙箱规则：禁止联网；禁止写文件，只放行 /dev（/dev/null 等）、系统给每个用户的临时 / 缓存目录（/private/var/folders，
 * PDFKit / Vision / textutil 会往里写缓存），以及这个子进程自己的临时目录。被恶意 PDF / 图片攻破的解析器写不了数据目录。
 */
export function sandboxProfile(writeDir = null) {
  let allow = '(allow file-write* (subpath "/dev") (subpath "/private/var/folders"))';
  if (writeDir) {
    let real = null;
    try { real = realpathSync(writeDir); } catch { real = null; }
    if (real && !/["\\\n]/.test(real)) allow = `(allow file-write* (subpath "/dev") (subpath "/private/var/folders") (subpath "${real}"))`;
  }
  return `(version 1)(allow default)(deny network*)(deny file-write*)${allow}`;
}

// 子进程登记（worker 里解析时把 pid 报给主线程：批次超时被终止时，主线程按 pid 收掉还在跑的子进程）
let spawnHook = null;
export function setSpawnHook(fn) { spawnHook = typeof fn === 'function' ? fn : null; }

// ---------- 文件名与类型 ----------

/** 文件名清理：去路径、控制字符，最长 120 字。 */
export function cleanName(name) {
  let n = String(name || '').replace(/\\/g, '/').split('/').pop() || '';
  n = n.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return n || '未命名文件';
}

const extOf = (name) => (/\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1] || '').toLowerCase();

/** 按扩展名定类型；没有扩展名时按文件头魔数猜（pdf / png / jpg / zip 类不猜具体格式）。 */
export function detectType(name, buf) {
  const ext = extOf(name);
  if (SUPPORTED_EXT.includes(ext)) return ext === 'jpeg' ? 'jpg' : ext === 'heif' ? 'heic' : ext === 'markdown' ? 'md' : ext;
  if (!ext && buf?.length) {
    if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
    if (!buf.subarray(0, 4096).includes(0)) return 'txt';
  }
  return null;
}

// ---------- 编码识别 ----------

/** 字节 → 文本：BOM（UTF-8 / UTF-16LE/BE）→ 严格 UTF-8 → GB18030（兼容 GBK / GB2312）。 */
export function decodeText(buf, hint = '') {
  if (!buf || !buf.length) return '';
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder('utf-8').decode(buf.subarray(3));
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const h = String(hint || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (h && !/^utf-?8$/.test(h)) {
    try { return new TextDecoder(/^(gb2312|gbk|gb18030|x-gbk|cp936)$/.test(h) ? 'gb18030' : h).decode(buf); } catch { /* 不认识的编码名，往下猜 */ }
  }
  // 没 BOM 的 UTF-16（中英文都常见 0 字节交替）
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  let zeroEven = 0, zeroOdd = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) { if (i % 2) zeroOdd += 1; else zeroEven += 1; }
  if (sample.length >= 4 && zeroOdd > sample.length * 0.2 && zeroEven < sample.length * 0.02) return new TextDecoder('utf-16le').decode(buf);
  if (sample.length >= 4 && zeroEven > sample.length * 0.2 && zeroOdd < sample.length * 0.02) return new TextDecoder('utf-16be').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* 不是 UTF-8 */ }
  try { return new TextDecoder('gb18030', { fatal: true }).decode(buf); } catch { /* 也不是 GB18030 */ }
  return new TextDecoder('utf-8').decode(buf); // 实在认不出：按 UTF-8 宽松解码
}

/** 正文清理：统一换行、去 NUL 与分页符、压缩过多空行、去行尾空白。 */
export function cleanText(s) {
  const t = String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000\u000b\u000c﻿]/g, '');
  return rstripLines(t)
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/** 去每行行尾的空格 / 制表符 / 不换行空格。线性扫描（正则 /[ \t]+\n/ 遇到很长的空白串会平方级变慢）。 */
function rstripLines(t) {
  if (!/[ \t\u00a0]\n/.test(t)) return t;
  const lines = t.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const l = lines[i];
    let e = l.length;
    while (e > 0) { const c = l.charCodeAt(e - 1); if (c === 32 || c === 9 || c === 0xa0) e -= 1; else break; }
    if (e !== l.length) lines[i] = l.slice(0, e);
  }
  return lines.join('\n');
}

// ---------- HTML / XML 去标签 ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', copy: '©', reg: '®', times: '×' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z]{1,32});/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head']);
const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'tr', 'table', 'section', 'article', 'blockquote', 'pre', 'header', 'footer', 'dd', 'dt', 'figure', 'figcaption', 'title']);
const TAG_NAME_RE = /<(\/?)([A-Za-z][A-Za-z0-9:-]{0,40})/y;
/** 只把 ASCII 大写转小写（长度不变，下标与原文一一对应；String#toLowerCase 遇到个别 Unicode 字符会变长）。 */
const asciiLower = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/**
 * (X)HTML → 文本：去注释与 script / style / head 等，块级标签换行，<br> 换行，解实体。
 * 线性扫描（indexOf），不用跨段懒惰匹配的正则：只有开标签没有闭标签时，旧写法是平方级（构造的文件能把主线程卡住几小时）。
 * 注释 / script 等找不到结尾时，丢掉从这里到文末的内容。
 */
export function htmlToText(html) {
  const s = String(html || '');
  let low = null; // 懒建：只有遇到要整段跳过的标签才需要
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { out.push(s.slice(i)); break; }
    if (lt > i) out.push(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4);
      if (e < 0) break;
      i = e + 3;
      continue;
    }
    const c1 = s.charCodeAt(lt + 1);
    if (c1 === 33 || c1 === 63) { // <!DOCTYPE …> / <![CDATA[ … / <?xml …?>
      const e = s.indexOf('>', lt + 2);
      if (e < 0) break;
      i = e + 1;
      continue;
    }
    TAG_NAME_RE.lastIndex = lt;
    const m = TAG_NAME_RE.exec(s);
    if (!m) { out.push('<'); i = lt + 1; continue; } // 不是标签（如「a < b」）：当普通文字
    const gt = s.indexOf('>', lt + m[0].length);
    if (gt < 0) break; // 标签没写完：后面都不要
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    i = gt + 1;
    if (!closing && SKIP_TAGS.has(name)) {
      if (s.charCodeAt(gt - 1) === 47) continue; // <svg …/>
      if (low === null) low = asciiLower(s);
      const e = low.indexOf(`</${name}`, i);
      if (e < 0) break;
      const e2 = s.indexOf('>', e);
      if (e2 < 0) break;
      i = e2 + 1;
      continue;
    }
    if (name === 'br') out.push('\n');
    else if (BLOCK_TAGS.has(name)) out.push('\n');
    else if (closing && (name === 'td' || name === 'th')) out.push('\t');
  }
  return cleanText(decodeEntities(out.join('')).replace(/[ \t]+/g, (x) => (x.includes('\t') ? '\t' : ' ')));
}

// ---------- XML 线性扫描（epub 的 opf、pptx、xlsx 用；不用跨段懒惰匹配的正则） ----------

const isTagEnd = (c) => c === 62 || c === 47 || c === 32 || c === 9 || c === 10 || c === 13; // > / 空白

/** 依次给出 <name …> 开标签文本（不找闭标签）。找不到 '>' 就结束。 */
export function* xmlTags(s, name) {
  const open = `<${name}`;
  let i = 0;
  for (;;) {
    const a = s.indexOf(open, i);
    if (a < 0) return;
    if (!isTagEnd(s.charCodeAt(a + open.length))) { i = a + open.length; continue; }
    const gt = s.indexOf('>', a + open.length);
    if (gt < 0) return;
    yield s.slice(a, gt + 1);
    i = gt + 1;
  }
}

/** 依次给出 <name …>内容</name> 的 {tag, inner}；自闭合的 inner 为 ''。找不到闭标签就结束。 */
export function* xmlElements(s, name) {
  const open = `<${name}`;
  const close = `</${name}>`;
  let i = 0;
  for (;;) {
    const a = s.indexOf(open, i);
    if (a < 0) return;
    if (!isTagEnd(s.charCodeAt(a + open.length))) { i = a + open.length; continue; }
    const gt = s.indexOf('>', a + open.length);
    if (gt < 0) return;
    const tag = s.slice(a, gt + 1);
    if (s.charCodeAt(gt - 1) === 47) { yield { tag, inner: '' }; i = gt + 1; continue; }
    const e = s.indexOf(close, gt + 1);
    if (e < 0) return;
    yield { tag, inner: s.slice(gt + 1, e) };
    i = e + close.length;
  }
}

/** 元素里全部 <name>文字</name> 的文字拼起来（解实体）。 */
const xmlTexts = (s, name) => { const out = []; for (const x of xmlElements(s, name)) out.push(decodeEntities(x.inner)); return out.join(''); };

/** HTML 字节 → 文本：先按 <meta charset> 解码。 */
export function htmlBytesToText(buf) {
  const head = buf.subarray(0, 4096).toString('latin1');
  const cs = /<meta[^>]+charset\s*=\s*["']?([A-Za-z0-9_-]+)/i.exec(head)?.[1] || '';
  return htmlToText(decodeText(buf, cs));
}

// ---------- 子进程 ----------

/**
 * 跑一个子进程（参数数组，不经 shell），带超时与输出上限。返回 {code, stdout(Buffer), stderr}。
 * sandbox：用 sandbox-exec 禁止联网（系统有就用）。
 */
export function runTool(cmd, args, { timeoutMs = TOOL_TIMEOUT_MS, maxOutput = TOOL_OUTPUT_MAX, sandbox = true, cwd, writeDir = null } = {}) {
  const useSandbox = sandbox && existsSync(SANDBOX);
  const file = useSandbox ? SANDBOX : cmd;
  const argv = useSandbox ? ['-p', sandboxProfile(writeDir), cmd, ...args] : args;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, argv, { stdio: ['ignore', 'pipe', 'pipe'], cwd, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME || '/tmp', LANG: 'en_US.UTF-8' } });
    } catch (e) {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(e?.message || e), error: 'spawn' });
      return;
    }
    const out = [];
    let size = 0;
    let err = '';
    let killedFor = null;
    const pid = child.pid;
    if (pid && spawnHook) { try { spawnHook('spawn', pid); } catch { /* ignore */ } }
    const timer = setTimeout(() => { killedFor = 'timeout'; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (c) => {
      size += c.length;
      if (size > maxOutput) { if (!killedFor) { killedFor = 'too_big'; child.kill('SIGKILL'); } return; }
      out.push(c);
    });
    child.stderr.on('data', (c) => { if (err.length < 4000) err += c.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(e?.message || e), error: 'spawn' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (pid && spawnHook) { try { spawnHook('exit', pid); } catch { /* ignore */ } }
      resolve({ code: killedFor ? -1 : code, stdout: Buffer.concat(out), stderr: err, error: killedFor });
    });
  });
}

// ---------- Swift 小工具：首次使用时编译 ----------

const compiling = new Map(); // name → Promise<path>

/** 确保 DATA_DIR/bin/<name> 已按当前源码编译好（源码哈希变了就重编）。返回可执行文件路径。 */
export function ensureSwiftTool(name, binDir, { toolsDir = path.join(ROOT, 'tools') } = {}) {
  const key = `${binDir}|${name}`;
  if (compiling.has(key)) return compiling.get(key);
  const p = (async () => {
    const src = path.join(toolsDir, `${name}.swift`);
    const code = readFileSync(src);
    const hash = createHash('sha256').update(code).digest('hex').slice(0, 16);
    const bin = path.join(binDir, name);
    const stamp = `${bin}.hash`;
    try {
      if (existsSync(bin) && (await readFile(stamp, 'utf8')).trim() === hash) return bin;
    } catch { /* 没有 stamp，重编 */ }
    await mkdir(binDir, { recursive: true });
    const tmp = `${bin}.build-${process.pid}-${randomBytes(4).toString('hex')}`;
    const r = await runTool('/usr/bin/swiftc', ['-O', '-o', tmp, src], { timeoutMs: COMPILE_TIMEOUT_MS, sandbox: false, maxOutput: 1024 * 1024 });
    if (r.code !== 0 || !existsSync(tmp)) {
      await rm(tmp, { force: true });
      console.error(`[fileparse] 编译 ${name} 失败（${r.error || r.code}）`);
      throw new Error(`compile ${name} failed`);
    }
    await rename(tmp, bin);
    await writeFile(stamp, hash + '\n');
    console.log(`[fileparse] 已编译 ${name}`);
    return bin;
  })();
  compiling.set(key, p);
  p.catch(() => compiling.delete(key)); // 失败了下次再试
  return p;
}

// ---------- ZIP 类（epub / pptx / xlsx） ----------

/** unzip 的参数是通配模式：把 [ * ? 写成方括号字面量（[[] [*] [?]）。 */
const unzipLiteral = (name) => name.replace(/[[*?]/g, (c) => `[${c}]`);

export const ZIP_TOTAL_MAX_BYTES = 200 * 1024 * 1024; // 压缩包里全部条目解压后合计上限（声明值）
export const ZIP_READ_MAX_BYTES = 200 * 1024 * 1024;  // 一个文件实际读出的解压字节累计上限（防声明值作假）
export const ZIP_ENTRY_MAX_BYTES = 16 * 1024 * 1024;  // 单个条目上限
export const ZIP_ENTRIES_MAX = 1000;                  // epub 章节 / pptx 幻灯片 / xlsx 工作表 最多读几个
export const FILE_TIMEOUT_MS = 90_000;                // 单个文件解析总耗时上限
export const BATCH_TIMEOUT_MS = 180_000;              // 一批文件解析总耗时上限（worker 里跑，超时直接终止）
export const ZIP_TOO_BIG_MESSAGE = '文件解压后太大，无法读取';
export const PARSE_TIMEOUT_MESSAGE = '解析超时，请换小一点的文件或分开上传';

/** 剩余时间（毫秒）；超时抛「解析超时」。 */
function remaining(o) {
  if (!o?.deadline) return TOOL_TIMEOUT_MS;
  const left = o.deadline - Date.now();
  if (left <= 0) throw new HttpError(400, PARSE_TIMEOUT_MESSAGE);
  return Math.min(TOOL_TIMEOUT_MS, left);
}

/** 条目列表 + 解压后合计大小（unzip -Zl 的最后一行：「N files, X bytes uncompressed, …」）。合计超限直接拒绝。 */
async function zipList(file, o) {
  const r = await runTool('/usr/bin/unzip', ['-Z1', file], { maxOutput: 4 * 1024 * 1024, timeoutMs: remaining(o) });
  if (r.code !== 0) throw new HttpError(400, '文件已损坏，无法读取');
  const t = await runTool('/usr/bin/unzip', ['-Zt', file], { maxOutput: 64 * 1024, timeoutMs: remaining(o) });
  const m = /(\d+)\s+files?,\s+(\d+)\s+bytes? uncompressed/i.exec(t.stdout.toString('utf8'));
  if (t.code !== 0 || !m) throw new HttpError(400, '文件已损坏，无法读取');
  if (Number(m[2]) > ZIP_TOTAL_MAX_BYTES) throw new HttpError(400, ZIP_TOO_BIG_MESSAGE);
  return r.stdout.toString('utf8').split('\n').map((x) => x.replace(/\r$/, '')).filter(Boolean);
}

/** 读一个条目。o.readBytes 累计实际读出的字节，超过 ZIP_READ_MAX_BYTES 就停（抛「解压后太大」）。 */
async function zipRead(file, entry, maxOutput = ZIP_ENTRY_MAX_BYTES, o = null) {
  const r = await runTool('/usr/bin/unzip', ['-p', file, unzipLiteral(entry)], { maxOutput, timeoutMs: remaining(o) });
  if (r.error === 'too_big') throw new HttpError(400, ZIP_TOO_BIG_MESSAGE);
  if (r.error === 'timeout') throw new HttpError(400, PARSE_TIMEOUT_MESSAGE);
  if (o) {
    o.readBytes = (o.readBytes || 0) + r.stdout.length;
    if (o.readBytes > ZIP_READ_MAX_BYTES) throw new HttpError(400, ZIP_TOO_BIG_MESSAGE);
  }
  if (r.code !== 0 && !r.stdout.length) return null;
  return r.stdout;
}

/** 取标签属性。标签只看前 8KB（防超长标签上的回溯）。 */
const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"|\\b${name}\\s*=\\s*'([^']*)'`, 'i').exec(String(tag).slice(0, 8192))?.slice(1).find((x) => x !== undefined) ?? null;

/** posix 路径拼接（zip 内部路径，处理 ../）。 */
function zipJoin(base, rel) {
  const r = decodeURIComponent(String(rel).split('#')[0]);
  if (r.startsWith('/')) return r.slice(1);
  const parts = (base ? base.split('/') : []).concat(r.split('/'));
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}

async function epubText(file, o) {
  const entries = await zipList(file, o);
  const set = new Set(entries);
  let opfPath = null;
  const container = await zipRead(file, 'META-INF/container.xml', 1024 * 1024, o);
  if (container) {
    const first = xmlTags(container.toString('utf8'), 'rootfile').next();
    if (!first.done) opfPath = attr(first.value, 'full-path');
  }
  if (!opfPath || !set.has(opfPath)) opfPath = entries.find((e) => e.toLowerCase().endsWith('.opf')) || null;
  let order = [];
  if (opfPath) {
    const opf = (await zipRead(file, opfPath, 4 * 1024 * 1024, o))?.toString('utf8') || '';
    const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
    const manifest = new Map();
    for (const tag of xmlTags(opf, 'item')) {
      const id = attr(tag, 'id');
      const href = attr(tag, 'href');
      if (id && href) { try { manifest.set(id, zipJoin(base, href)); } catch { /* href 编码不对：跳过 */ } }
    }
    for (const tag of xmlTags(opf, 'itemref')) {
      const href = manifest.get(attr(tag, 'idref'));
      if (href && set.has(href)) order.push(href);
    }
  }
  if (!order.length) order = entries.filter((e) => /\.(x?html?)$/i.test(e)).sort();
  const parts = [];
  let total = 0;
  for (const e of order.slice(0, ZIP_ENTRIES_MAX)) {
    const buf = await zipRead(file, e, ZIP_ENTRY_MAX_BYTES, o);
    if (!buf) continue;
    const t = htmlBytesToText(buf);
    if (t) { parts.push(t); total += t.length; }
    if (total > TEXT_MAX_CHARS * 1.2) break;
  }
  return parts.join('\n\n');
}

const numOf = (s) => Number(/(\d+)\.xml$/i.exec(s)?.[1] || 0);

async function pptxText(file, o) {
  const entries = await zipList(file, o);
  const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e)).sort((a, b) => numOf(a) - numOf(b)).slice(0, ZIP_ENTRIES_MAX);
  const out = [];
  for (const s of slides) {
    const xml = (await zipRead(file, s, ZIP_ENTRY_MAX_BYTES, o))?.toString('utf8') || '';
    const paras = [];
    for (const p of xml.split('</a:p>')) {
      const t = xmlTexts(p, 'a:t');
      if (t.trim()) paras.push(t);
    }
    if (paras.length) out.push(`【第 ${numOf(s)} 页】\n${paras.join('\n')}`);
  }
  return out.join('\n\n');
}

async function xlsxText(file, o) {
  const entries = await zipList(file, o);
  const shared = [];
  if (entries.includes('xl/sharedStrings.xml')) {
    const xml = (await zipRead(file, 'xl/sharedStrings.xml', ZIP_ENTRY_MAX_BYTES, o))?.toString('utf8') || '';
    for (const si of xmlElements(xml, 'si')) shared.push(xmlTexts(si.inner, 't'));
  }
  // 工作表名（workbook.xml 的 sheet 顺序 ≈ sheetN 编号）
  const names = [];
  if (entries.includes('xl/workbook.xml')) {
    const wb = (await zipRead(file, 'xl/workbook.xml', ZIP_ENTRY_MAX_BYTES, o))?.toString('utf8') || '';
    for (const tag of xmlTags(wb, 'sheet')) names.push(decodeEntities(attr(tag, 'name') || ''));
  }
  const sheets = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(e)).sort((a, b) => numOf(a) - numOf(b)).slice(0, ZIP_ENTRIES_MAX);
  const out = [];
  for (const s of sheets) {
    const xml = (await zipRead(file, s, ZIP_ENTRY_MAX_BYTES, o))?.toString('utf8') || '';
    const rows = [];
    for (const r of xmlElements(xml, 'row')) {
      const cells = [];
      for (const c of xmlElements(r.inner, 'c')) {
        const t = attr(c.tag, 't');
        const inner = c.inner;
        let v = '';
        const vText = () => { const x = xmlElements(inner, 'v').next(); return x.done ? '' : x.value.inner; };
        if (t === 's') v = shared[Number(vText())] ?? '';
        else if (t === 'inlineStr') v = xmlTexts(inner, 't');
        else v = decodeEntities(vText());
        cells.push(v.replace(/[\t\n]+/g, ' '));
      }
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (cells.length) rows.push(cells.join('\t'));
    }
    if (rows.length) out.push(`【工作表：${names[numOf(s) - 1] || numOf(s)}】\n${rows.join('\n')}`);
  }
  return out.join('\n\n');
}

// ---------- 单个文件 ----------

/**
 * 解析一个文件 → {name, type, chars, ok, error?, text}。原始字节先写到 tmpDir 的随机子目录，解析完立刻删除。
 * @param {{name:string, data:Buffer}} f
 * @param {{tmpDir:string, binDir:string}} o
 */
export async function parseFile(f, { tmpDir, binDir, timeoutMs = FILE_TIMEOUT_MS }) {
  const o = { deadline: Date.now() + timeoutMs, readBytes: 0 };
  const name = cleanName(f.name);
  const fail = (error, type = null) => ({ name, type, chars: 0, ok: false, error, text: '' });
  if (!f.data || !f.data.length) return fail('文件是空的');
  if (f.data.length > FILE_MAX_BYTES) return fail('文件超过 20MB');
  const type = detectType(name, f.data);
  if (!type) return fail(UNSUPPORTED_MESSAGE);
  let text = '';
  if (TEXT_EXT.includes(type) || type === 'md') {
    text = cleanText(decodeText(f.data));
    if (type === 'json') { try { text = cleanText(JSON.stringify(JSON.parse(text), null, 1)); } catch { /* 不合法就按原文 */ } }
    if (type === 'srt' || type === 'vtt') text = cleanText(text.replace(/^\d+\s*\n(?=\d\d:)/gm, '').replace(/^[\d:.,]+\s+-->\s+[\d:.,]+.*$/gm, '').replace(/^WEBVTT.*$/m, ''));
  } else if (HTML_EXT.includes(type)) {
    text = htmlBytesToText(f.data);
  } else {
    const dir = path.join(tmpDir, randomBytes(12).toString('hex'));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `input.${type}`);
    try {
      await writeFile(file, f.data, { mode: 0o600 });
      if (TEXTUTIL_EXT.includes(type)) {
        const r = await runTool('/usr/bin/textutil', ['-convert', 'txt', '-stdout', '-encoding', 'UTF-8', file], { timeoutMs: remaining(o), writeDir: dir });
        if (r.code !== 0) return fail(r.error === 'timeout' ? '解析超时' : '文件已损坏或格式不对，无法读取', type);
        text = cleanText(r.stdout.toString('utf8'));
      } else if (type === 'pdf') {
        let bin;
        try { bin = await ensureSwiftTool('pdftext', binDir); } catch { return fail('PDF 解析暂不可用', type); }
        const r = await runTool(bin, [file], { timeoutMs: remaining(o), writeDir: dir });
        if (r.code === 4) return fail('PDF 有密码保护，请先去掉密码', type);
        if (r.code !== 0) return fail(r.error === 'timeout' ? '解析超时' : 'PDF 已损坏，无法读取', type);
        text = cleanText(r.stdout.toString('utf8'));
        if (text.replace(/\s/g, '').length < 10) return fail(SCANNED_PDF_MESSAGE, type);
      } else if (IMAGE_EXT.includes(type)) {
        let bin;
        try { bin = await ensureSwiftTool('ocr', binDir); } catch { return fail('图片文字识别暂不可用', type); }
        const r = await runTool(bin, [file], { timeoutMs: remaining(o), writeDir: dir });
        if (r.code === 3) return fail('图片已损坏或格式不对，无法读取', type);
        if (r.code === 6) return fail('图片像素太大（超过 5000 万像素），请缩小后再上传', type);
        if (r.code !== 0) return fail(r.error === 'timeout' ? '识别超时' : '图片文字识别失败', type);
        text = cleanText(r.stdout.toString('utf8'));
      } else if (type === 'epub') text = cleanText(await epubText(file, o));
      else if (type === 'pptx') text = cleanText(await pptxText(file, o));
      else if (type === 'xlsx') text = cleanText(await xlsxText(file, o));
    } catch (e) {
      if (e instanceof HttpError) return fail(e.message, type);
      console.error('[fileparse] 解析失败', type, e?.message || e);
      return fail('文件解析失败', type);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!text.trim()) return fail(IMAGE_EXT.includes(type) ? '图片里没有识别到文字' : '没有读到文字内容', type);
  return { name, type, chars: text.length, ok: true, text };
}

// ---------- 多文件上传体 ----------

/** multipart/form-data → 全部带文件名的部分 [{name, contentType, data}]（最多 maxParts 个）。 */
export function parseMultipartFiles(buf, contentType, { maxParts = 20 } = {}) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
  if (!m) return [];
  const boundary = Buffer.from(`--${m[1] || m[2]}`, 'latin1');
  const files = [];
  let pos = buf.indexOf(boundary);
  let guard = 0;
  while (pos >= 0 && guard++ < maxParts + 10) {
    let start = pos + boundary.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    const next = buf.indexOf(boundary, start);
    if (next < 0) break;
    let end = next;
    if (buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;
    const part = buf.subarray(start, end);
    const sep = part.indexOf('\r\n\r\n');
    if (sep >= 0) {
      const head = part.toString('utf8', 0, sep);
      const disp = /content-disposition:([^\r\n]*)/i.exec(head)?.[1] || '';
      const star = /\bfilename\*\s*=\s*(?:UTF-8|utf-8)''([^;\r\n]+)/.exec(disp)?.[1];
      let filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1];
      if (star) { try { filename = decodeURIComponent(star); } catch { /* 用普通 filename */ } }
      const ct = (/content-type:\s*([^\r\n;]*)/i.exec(head)?.[1] || '').trim().toLowerCase();
      if (filename !== undefined) files.push({ name: filename, contentType: ct, data: part.subarray(sep + 4) });
      if (files.length > maxParts) break;
    }
    pos = next;
  }
  return files;
}

/**
 * 上传请求 → 文件列表。支持：multipart（多个文件）；原始请求体（单个文件，文件名放 X-File-Name 头，URL 编码）；
 * JSON {files:[{name, data: base64 或 dataURL}]}。
 */
export function filesFromRequest(buf, headers) {
  const ct = String(headers['content-type'] || '').toLowerCase();
  if (ct.startsWith('multipart/form-data')) return parseMultipartFiles(buf, headers['content-type'], { maxParts: FILES_MAX });
  if (ct.startsWith('application/json')) {
    let b;
    try { b = JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, '请求格式不正确'); }
    const list = Array.isArray(b?.files) ? b.files : [];
    return list.slice(0, FILES_MAX + 1).map((x) => {
      const v = typeof x?.data === 'string' ? x.data : '';
      const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(v);
      return { name: String(x?.name || ''), contentType: m ? m[1] : '', data: Buffer.from(m ? m[3] : v, 'base64') };
    });
  }
  let name = String(headers['x-file-name'] || '');
  try { name = decodeURIComponent(name); } catch { /* 原样 */ }
  return buf.length ? [{ name, contentType: ct.split(';')[0].trim(), data: buf }] : [];
}

/**
 * 解析一批文件（顺序执行，避免同时起多个子进程）。合并后正文上限 200 万字，超出截断。
 * 返回 {files:[{name,type,chars,ok,error?}], text, total_chars, truncated}。
 */
export async function parseFiles(list, o) {
  if (!list.length) throw new HttpError(400, '没有收到文件');
  if (list.length > FILES_MAX) throw new HttpError(400, `一次最多上传 ${FILES_MAX} 个文件`);
  const files = [];
  const texts = [];
  let total = 0;
  let truncated = false;
  for (const f of list) {
    const r = await parseFile(f, o);
    if (r.ok) {
      let t = r.text;
      const header = list.length > 1 ? `《${r.name}》\n` : '';
      const room = TEXT_MAX_CHARS - total - header.length;
      if (room <= 0) { truncated = true; files.push({ name: r.name, type: r.type, chars: 0, ok: false, error: '总字数已超过 200 万字，这个文件没有读入' }); continue; }
      if (t.length > room) { t = t.slice(0, room); truncated = true; }
      texts.push(header + t);
      total += header.length + t.length + 2;
      files.push({ name: r.name, type: r.type, chars: t.length, ok: true, ...(t.length < r.chars ? { truncated: true } : {}) });
    } else {
      files.push({ name: r.name, type: r.type, chars: 0, ok: false, error: r.error });
    }
  }
  const text = texts.join('\n\n');
  return { files, text, total_chars: text.length, truncated };
}

// ---------- 隔离解析：worker_threads + 总超时 ----------

/**
 * 在 worker 线程里解析一批文件（主线程不跑任何正文正则 / XML 抽取，构造的文件卡不住整个服务）。
 * 批次总耗时上限 timeoutMs（默认 180 秒）：超时就终止 worker、按 pid 收掉它起的子进程、删掉这批的临时目录，抛「解析超时」。
 * 需要 Swift 小工具（pdf / 图片）时先在主线程编译好（编译本身是子进程，不占主线程），worker 里只用现成的。
 */
export async function parseFilesIsolated(list, { tmpDir, binDir }, { timeoutMs = BATCH_TIMEOUT_MS, maxHeapMb = 1024 } = {}) {
  if (!list.length) throw new HttpError(400, '没有收到文件');
  if (list.length > FILES_MAX) throw new HttpError(400, `一次最多上传 ${FILES_MAX} 个文件`);
  const types = new Set(list.map((f) => (f?.data?.length ? detectType(cleanName(f.name), f.data) : null)));
  for (const [t, tool] of [['pdf', 'pdftext'], ...IMAGE_EXT.map((x) => [x === 'jpeg' ? 'jpg' : x === 'heif' ? 'heic' : x, 'ocr'])]) {
    if (types.has(t)) { try { await ensureSwiftTool(tool, binDir); } catch { /* worker 里会给出「暂不可用」 */ } }
  }
  const { Worker } = await import('node:worker_threads');
  const batchDir = path.join(tmpDir, `batch-${randomBytes(8).toString('hex')}`);
  await mkdir(batchDir, { recursive: true, mode: 0o700 });
  const pids = new Set();
  const files = list.map((f) => ({ name: String(f.name || ''), data: f.data }));
  let worker;
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
      worker = new Worker(new URL('./parse-worker.mjs', import.meta.url), {
        workerData: { files, tmpDir: batchDir, binDir },
        resourceLimits: { maxOldGenerationSizeMb: maxHeapMb, maxYoungGenerationSizeMb: 64 },
        stdout: false, stderr: false,
      });
      const timer = setTimeout(() => {
        console.error(`[fileparse] 一批文件解析超过 ${Math.round(timeoutMs / 1000)} 秒，已终止`);
        finish(reject, new HttpError(422, PARSE_TIMEOUT_MESSAGE, 'parse_timeout'));
      }, timeoutMs);
      worker.on('message', (m) => {
        if (m?.type === 'spawn') pids.add(m.pid);
        else if (m?.type === 'exit') pids.delete(m.pid);
        else if (m?.type === 'done') finish(resolve, m.result);
        else if (m?.type === 'error') finish(reject, m.status ? new HttpError(m.status, m.message) : new HttpError(500, '文件解析失败'));
      });
      worker.on('error', (e) => {
        console.error('[fileparse] 解析线程出错', e?.code || e?.message || e);
        finish(reject, new HttpError(422, e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? '文件太复杂，解析时内存不够，请换小一点的文件' : '文件解析失败'));
      });
      worker.on('exit', (code) => finish(reject, new HttpError(500, `文件解析失败（${code}）`)));
    });
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
    await rm(batchDir, { recursive: true, force: true }).catch(() => {});
  }
}
