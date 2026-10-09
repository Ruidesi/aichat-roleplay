// 只在临时缓存目录跑本机sips，中性PNG；验证有界缓存及退出清理。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, stat, readdir } from 'node:fs/promises';
import { createThumbnailCache } from '../server/mirror-thumbnails.mjs';
import { solidPng } from '../server/png.mjs';
import { tmpDir, cleanupTmp } from './helpers.mjs';

test('启动清理中断遗留的自有临时输入并保持缓存容量边界', async () => {
  const dir = tmpDir('mirror-thumbnail-recovery');
  const cacheDir = path.join(dir, 'cache');
  await mkdir(cacheDir);
  const orphan = path.join(cacheDir, `${'a'.repeat(64)}-1122334455667788.input`);
  const output = path.join(cacheDir, `${'b'.repeat(64)}-1122334455667788.jpg`);
  await writeFile(orphan, Buffer.alloc(1024 * 1024));
  await writeFile(output, Buffer.alloc(1024 * 1024));
  await writeFile(path.join(cacheDir, '用户说明.txt'), '保留这个非缓存文件');
  const cache = createThumbnailCache({ dir: cacheDir, maxBytes: 1024 });
  try {
    assert.equal((await cache.get('neutral', async () => solidPng(16, 16))).type, 'image/jpeg');
    await assert.rejects(stat(orphan), e => e.code === 'ENOENT');
    await assert.rejects(stat(output), e => e.code === 'ENOENT');
    assert.ok((await stat(path.join(cacheDir, '用户说明.txt'))).isFile());
    let total = 0;
    for (const f of await readdir(cacheDir)) if (/^[a-f0-9]{64}\.jpg$/.test(f)) total += (await stat(path.join(cacheDir, f))).size;
    assert.ok(total <= 1024);
  } finally { cache.close(); cleanupTmp(dir); }
});

test('缩图命中不重新读取原图且同键并发只生成一份', async () => {
  const dir = tmpDir('mirror-thumbnail-hit');
  const cache = createThumbnailCache({ dir: path.join(dir, 'cache') });
  let start, release;
  const started = new Promise(r => { start = r; });
  const gate = new Promise(r => { release = r; });
  const png = solidPng(1200, 800);
  try {
    const first = cache.get('same-file-stamp', async () => { start(); await gate; return png; });
    await started;
    const second = cache.get('same-file-stamp', async () => { throw new Error('并发重复读取原图'); });
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a.buf, b.buf); assert.equal(a.type, 'image/jpeg');
    const hit = await cache.get('same-file-stamp', async () => { throw new Error('缓存命中重读原图'); });
    assert.deepEqual(hit.buf, a.buf);
    const files = (await readdir(path.join(dir, 'cache'))).filter(f => f.endsWith('.jpg'));
    assert.equal(files.length, 1);
  } finally { release(); cache.close(); cleanupTmp(dir); }
});

test('缩图排队名额有限且关闭会拒绝排队与在途加载', async () => {
  const dir = tmpDir('mirror-thumbnail-bounds');
  const cache = createThumbnailCache({ dir: path.join(dir, 'cache'), maxConcurrent: 1, maxPending: 1 });
  let start, release;
  const started = new Promise(r => { start = r; });
  const gate = new Promise(r => { release = r; });
  try {
    const first = cache.get('one', async () => { start(); await gate; return solidPng(16, 16); });
    const firstRejected = assert.rejects(first, e => e.status === 503);
    await started;
    const queued = cache.get('two', async () => { throw new Error('已关闭队列不应读取原图'); });
    const queuedRejected = assert.rejects(queued, e => e.status === 503);
    await assert.rejects(cache.get('three', async () => solidPng(16, 16)), e => e.status === 503);
    cache.close(); release();
    await Promise.all([firstRejected, queuedRejected]);
    await assert.rejects(cache.get('four', async () => solidPng(16, 16)), e => e.status === 503);
  } finally { release(); cache.close(); cleanupTmp(dir); }
});
