// 固态预览缓存：只接收调用方已验证的图片；热读不进入NAS/转换队列。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, rename, readdir, lstat, open, unlink, chmod, statfs, mkdtemp, rm } from 'node:fs/promises';
import { HttpError } from './util.mjs';

const SMALL_MAX = 512 * 1024;
const JPEG_MAX = 1024 * 1024;
const INPUT_MAX = 64 * 1024 * 1024;
const MIN_FREE = 8 * 1024 ** 3;
const MAGIC = Buffer.from('AICHAT-PREVIEW-1\n');
const HEADER_MAX = 1024;
const CONTAINER_MAX = JPEG_MAX + HEADER_MAX + MAGIC.length + 2;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
const OWNED = /^[a-f0-9]{64}\.(preview|jpg)$/;
const TEMP = /^[a-f0-9]{64}-[a-f0-9]{16}\.(input|jpg|preview)$/;
const digest = buf => crypto.createHash('sha256').update(buf).digest('hex');
const validJpeg = buf => buf.length >= 4 && buf.length <= JPEG_MAX
  && buf.readUInt16BE(0) === 0xffd8 && buf.readUInt16BE(buf.length - 2) === 0xffd9;

async function freeBytes(dir) {
  const s = await statfs(dir).catch(() => statfs(path.dirname(dir)));
  return s.bavail * s.bsize;
}

function pack(image) {
  const header = Buffer.from(JSON.stringify({ type: image.type, length: image.buf.length, sha256: digest(image.buf) }));
  const length = Buffer.alloc(2); length.writeUInt16BE(header.length);
  return Buffer.concat([MAGIC, length, header, image.buf]);
}

function unpack(buf) {
  if (buf.length < MAGIC.length + 2 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('invalid preview');
  const length = buf.readUInt16BE(MAGIC.length), start = MAGIC.length + 2;
  if (!length || length > HEADER_MAX || start + length >= buf.length) throw new Error('invalid header');
  const header = JSON.parse(buf.toString('utf8', start, start + length));
  const body = buf.subarray(start + length);
  if (Object.keys(header).sort().join(',') !== 'length,sha256,type' || !TYPES.has(header.type)
      || !Number.isSafeInteger(header.length) || header.length !== body.length
      || body.length > (header.type === 'image/jpeg' ? JPEG_MAX : SMALL_MAX)
      || !/^[a-f0-9]{64}$/.test(header.sha256) || digest(body) !== header.sha256) throw new Error('corrupt preview');
  if (header.type === 'image/jpeg' && !validJpeg(body)) throw new Error('invalid jpeg');
  return { buf: body, type: header.type };
}

// maxConcurrent 管「读原图 + 生成」整条任务（读原图由上游 IO 队列再限一次）；maxConvert 只管 sips 转换（吃 CPU）。
export function createThumbnailCache({ dir, maxBytes = 128 * 1024 * 1024, maxConcurrent = 2, maxConvert = maxConcurrent,
  maxPending = 64, timeoutMs = 10000, getFreeBytes = freeBytes } = {}) {
  const inflight = new Map(), queue = [], children = new Set(), index = new Map();
  let active = 0, total = 0, closed = false, ready, lookupTail = Promise.resolve();
  let converting = 0; const convertQueue = [];
  async function convertSlot(run) {
    if (converting >= maxConvert) await new Promise(resolve => convertQueue.push(resolve));
    converting++;
    try { return await run(); } finally { converting--; convertQueue.shift()?.(); }
  }
  const unavailable = () => new HttpError(503, '缩略图暂时不可用，请稍后重试', 'thumbnail_unavailable');
  const keyOf = (source, preserveSmall) => digest(preserveSmall ? JSON.stringify(['raw-preview-v1', source]) : source);
  const fileOf = name => path.join(dir, name);

  async function safeDirectory(create = false) {
    if (!dir) return false;
    try {
      let s;
      try { s = await lstat(dir); } catch (e) {
        if (!create || e.code !== 'ENOENT') return false;
        await mkdir(dir, { recursive: true, mode: 0o700 }); s = await lstat(dir);
      }
      if (!s.isDirectory() || s.isSymbolicLink()) return false;
      if (create) await chmod(dir, 0o700);
      return true;
    } catch { return false; }
  }

  function touch(name, size) {
    total -= index.get(name) || 0;
    index.delete(name); index.set(name, size); total += size;
  }

  async function evict() {
    while (total > maxBytes && index.size) {
      const [name, size] = index.entries().next().value;
      // 只删除当前模块识别的缓存条目，unlink永不跟随链接。
      try { await unlink(fileOf(name)); } catch (e) { if (e.code !== 'ENOENT') break; }
      if (index.get(name) === size) { index.delete(name); total -= size; }
    }
  }

  async function initialize() {
    if (closed || !await safeDirectory(true)) throw unavailable();
    const files = [], names = await readdir(dir);
    // 元数据并发有界；初始化仅由cold miss触发，不阻挡已有热读。
    for (let start = 0; start < names.length; start += 4) {
      await Promise.all(names.slice(start, start + 4).map(async name => {
        if (TEMP.test(name)) { await unlink(fileOf(name)).catch(() => {}); return; }
        if (!OWNED.test(name)) return;
        try {
          const s = await lstat(fileOf(name));
          if (s.isFile()) files.push({ name, size: s.size, time: s.mtimeMs });
        } catch {}
      }));
    }
    files.sort((a, b) => a.time - b.time);
    const hot = [...index], hotNames = new Set(hot.map(([name]) => name));
    index.clear(); total = 0;
    for (const f of files) if (!hotNames.has(f.name)) touch(f.name, f.size);
    for (const [name, size] of hot) touch(name, size);
    await evict();
  }

  function drain() {
    while (!closed && active < maxConcurrent && queue.length) {
      const task = queue.shift(); active++;
      task.run().then(task.resolve, task.reject).finally(() => { active--; drain(); });
    }
  }

  function schedule(run) {
    if (closed || queue.length >= maxPending) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => { queue.push({ run, resolve, reject }); drain(); });
  }

  async function boundedRead(filename, limit) {
    let handle;
    try {
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const s = await handle.stat();
      if (!s.isFile() || s.size < 4 || s.size > limit) throw unavailable();
      const buf = Buffer.allocUnsafe(s.size);
      for (let pos = 0; pos < buf.length;) {
        const { bytesRead } = await handle.read(buf, pos, buf.length - pos, pos);
        if (!bytesRead) throw unavailable(); pos += bytesRead;
      }
      return { buf, size: s.size };
    } finally { await handle?.close().catch(() => {}); }
  }

  async function lookup(key, preserveSmall) {
    if (closed || !await safeDirectory()) return null;
    for (const extension of preserveSmall ? ['preview'] : ['preview', 'jpg']) {
      const name = `${key}.${extension}`;
      try {
        const cached = await boundedRead(fileOf(name), extension === 'preview' ? CONTAINER_MAX : JPEG_MAX);
        const image = extension === 'preview' ? unpack(cached.buf)
          : validJpeg(cached.buf) ? { buf: cached.buf, type: 'image/jpeg' } : null;
        if (!image || (!preserveSmall && image.type !== 'image/jpeg')
          || (preserveSmall && image.type !== 'image/jpeg' && image.buf.length > SMALL_MAX)) continue;
        touch(name, cached.size);
        // 近似LRU可跨重启恢复，更新时间失败不影响返回已验证字节。
        let handle;
        try { handle = await open(fileOf(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const now = new Date(); await handle.utimes(now, now); } catch {}
        finally { await handle?.close().catch(() => {}); }
        return image;
      } catch { /* 缺失/损坏/超大/链接是local miss，由caller决定回源。 */ }
    }
    return null;
  }

  async function peekPreview(keySource, { preserveSmall = false } = {}) {
    if (closed || !dir) return null;
    return lookup(keyOf(keySource, preserveSmall), preserveSmall);
  }

  function convertFile(input, output) {
    return new Promise((resolve, reject) => {
      const child = execFile('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '-Z', '480', input, '--out', output],
        { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 65536, windowsHide: true }, err => {
          children.delete(child); err ? reject(unavailable()) : resolve();
        });
      children.add(child);
    });
  }

  async function converted(buf) {
    // 转换scratch与持久cache独立：cache只读/初始化失败时仍可返回生成结果。
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'aichat-preview-'));
    const input = path.join(scratch, 'input'), output = path.join(scratch, 'output.jpg');
    try {
      for (const [file, data] of [[input, buf], [output, Buffer.alloc(0)]]) {
        const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(data); } finally { await handle.close(); }
      }
      await convertFile(input, output);
      const image = await boundedRead(output, JPEG_MAX);
      if (!validJpeg(image.buf)) throw unavailable();
      return { buf: image.buf, type: 'image/jpeg' };
    } finally { await rm(scratch, { recursive: true, force: true }).catch(() => {}); }
  }

  async function persist(key, image) {
    let temporary;
    try {
      if (closed || !dir || Number(await getFreeBytes(dir)) < MIN_FREE) return;
      try { await (ready ||= initialize()); } catch { ready = null; return; }
      if (closed || !await safeDirectory(true)) return;
      const available = Number(await getFreeBytes(dir));
      if (!Number.isFinite(available) || available < MIN_FREE) return;
      const bytes = pack(image), name = `${key}.preview`;
      temporary = fileOf(`${key}-${crypto.randomBytes(8).toString('hex')}.preview`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(bytes); await handle.chmod(0o600); } finally { await handle.close(); }
      if (closed) return;
      await rename(temporary, fileOf(name)); temporary = null;
      touch(name, bytes.length); await evict();
    } catch { /* ENOSPC/EROFS/初始化或空间检查失败：有效预览仍可返回，hot不受影响。 */ }
    finally { if (temporary) await unlink(temporary).catch(() => {}); }
  }

  function getPreview(keySource, load, { preserveSmall = false } = {}) {
    if (closed) return Promise.reject(unavailable());
    const key = keyOf(keySource, preserveSmall);
    if (inflight.has(key)) return inflight.get(key);
    const previousLookup = lookupTail;
    let finishLookup;
    const lookedUp = new Promise(resolve => { finishLookup = resolve; });
    lookupTail = previousLookup.then(() => lookedUp);
    const promise = (async () => {
      try {
        const hit = await lookup(key, preserveSmall);
        if (closed) throw unavailable();
        if (hit) return hit; // 热读不等待之前cold load/convert，满队列也能返回。
        // cold入队顺序保持调用顺序；只等先前本地lookup，不等NAS任务。
        await previousLookup;
        const task = schedule(async () => {
          if (closed) throw unavailable();
          const loaded = await load();
          if (closed) throw unavailable();
          if (!loaded || !Buffer.isBuffer(loaded.buf) || !loaded.buf.length || loaded.buf.length > INPUT_MAX || !TYPES.has(loaded.type)) throw unavailable();
          const image = preserveSmall && loaded.buf.length <= SMALL_MAX
            ? { buf: loaded.buf, type: loaded.type } : await convertSlot(() => converted(loaded.buf));
          if (closed) throw unavailable();
          await persist(key, image);
          return image;
        });
        finishLookup();
        try { return await task; } catch (e) { throw e instanceof HttpError ? e : unavailable(); }
      } finally { finishLookup(); }
    })().finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  // 旧BufferLoader契约不变；一律生成480px JPEG。
  const get = (key, load) => getPreview(key, async () => ({ buf: await load(), type: 'image/png' }));
  function close() {
    closed = true;
    for (const child of children) child.kill('SIGKILL');
    for (const task of queue.splice(0)) task.reject(unavailable());
  }
  return { get, peekPreview, getPreview, close };
}
