// chub.ai 代理：搜索、角色详情、头像（SSRF 白名单 + 磁盘缓存）。
import crypto from 'node:crypto';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { readFile, writeFile, rename, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './util.mjs';

export const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const CHUB_API = 'https://api.chub.ai';
const CHUB_TIMEOUT_MS = 15000;
export const PAGE_SIZE = 24;
export const SORTS = ['download_count', 'trending_downloads', 'star_count', 'last_activity_at', 'created_at'];

// ---------- SSRF 白名单 ----------
const ALLOWED_EXACT = new Set(['avatars.charhub.io', 'charhub.io', 'chub.ai']);
const ALLOWED_SUFFIX = ['.charhub.io', '.chub.ai'];

/** 只放行 https、默认端口、无账号密码、主机在白名单里的地址。返回规范化 URL 字符串或 null。 */
export function checkAvatarUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '443') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.includes('..')) return null;
  const ok = ALLOWED_EXACT.has(host) || ALLOWED_SUFFIX.some((s) => host.endsWith(s) && host.length > s.length);
  if (!ok) return null;
  // 头像地址不需要查询串；清掉它，避免同一张图拼不同查询串反复回源、各存一份把磁盘写满。
  u.hash = '';
  u.search = '';
  return u.toString();
}

export const avatarProxyUrl = (url) => (url && checkAvatarUrl(url) ? `/api/avatar?u=${encodeURIComponent(url)}` : '');

export function isNsfwNode(node) {
  if (!node) return false;
  if (node.nsfw_image === true) return true;
  const topics = Array.isArray(node.topics) ? node.topics : [];
  return topics.some((t) => String(t).toUpperCase() === 'NSFW');
}

export function nodeToCard(n) {
  return {
    path: n.fullPath || n.full_path || '',
    name: n.name || '',
    tagline: n.tagline || '',
    avatar: avatarProxyUrl(n.avatar_url || n.max_res_url || ''),
    tags: Array.isArray(n.topics) ? n.topics.map(String) : [],
    nsfw: isNsfwNode(n),
    stars: Number(n.starCount) || 0,
    chats: Number(n.nChats) || 0,
  };
}

export function createChub({ apiKey = '', fetchImpl = fetch } = {}) {
  async function chubFetch(url) {
    const headers = { 'User-Agent': BROWSER_UA, Accept: 'application/json' };
    if (apiKey) headers['CH-API-KEY'] = apiKey;
    let r;
    try {
      r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(CHUB_TIMEOUT_MS) });
    } catch (e) {
      throw new HttpError(502, '角色库暂时连不上，请稍后再试');
    }
    if (r.status === 404) throw new HttpError(404, '没有找到这个角色');
    if (!r.ok) throw new HttpError(502, '角色库暂时连不上，请稍后再试');
    try { return await r.json(); } catch { throw new HttpError(502, '角色库返回的数据无法识别'); }
  }

  /** 搜索。nsfw 由调用方按用户设置决定。 */
  async function search({ q = '', tag = '', sort = 'download_count', page = 1, nsfw = false }) {
    const p = new URLSearchParams({
      search: String(q || ''),
      first: String(PAGE_SIZE),
      page: String(page),
      sort: SORTS.includes(sort) ? sort : 'download_count',
      nsfw: nsfw ? 'true' : 'false',
      venus: 'true',
      include_forks: 'true',
      asc: 'false',
    });
    if (tag) p.set('tags', String(tag));
    if (!nsfw) p.set('exclude_tags', 'NSFW');
    const j = await chubFetch(`${CHUB_API}/search?${p}`);
    const nodes = Array.isArray(j?.data?.nodes) ? j.data.nodes : [];
    const count = Number(j?.data?.count);
    let items = nodes.map((n) => ({ n, card: nodeToCard(n) })).filter((x) => x.card.path);
    if (!nsfw) items = items.filter((x) => x.n.nsfw_image !== true && !x.card.nsfw);
    const has_more = Number.isFinite(count) && count > 0 ? page * PAGE_SIZE < count : nodes.length >= PAGE_SIZE;
    return { items: items.map((x) => x.card), page, has_more };
  }

  /** 角色详情：返回 chub 的 node（含 definition）。 */
  async function character(fullPath) {
    if (!isValidChubPath(fullPath)) throw new HttpError(400, '角色地址不正确');
    const enc = fullPath.split('/').map(encodeURIComponent).join('/');
    const j = await chubFetch(`${CHUB_API}/api/characters/${enc}?full=true`);
    if (!j?.node) throw new HttpError(404, '没有找到这个角色');
    return j.node;
  }

  return { search, character };
}

export function isValidChubPath(p) {
  return typeof p === 'string' && p.length <= 300 && /^[^/\s?#]+\/[^/\s?#]+$/.test(p) && !p.includes('..');
}

// ---------- 头像代理 + 磁盘缓存 ----------
const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
export const AVATAR_CACHE_MAX_BYTES = 500 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(png|jpeg|jpg|webp|gif|avif)$/i;

/** 边读边计数，超过上限立刻中止，不先把整个响应体读进内存。 */
async function readCapped(r, max) {
  if (!r.body || typeof r.body.getReader !== 'function') {
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > max) throw new HttpError(502, '头像太大');
    return buf;
  }
  const reader = r.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new HttpError(502, '头像太大');
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total);
}

/**
 * 头像磁盘缓存。总量超过 maxBytes 时按最近使用（LRU）淘汰。
 * 索引在内存里：启动时扫一遍缓存目录（只有两层，按 mtime 排序），命中时刷新顺序并 touch mtime。
 */
export function createAvatarCache({ dir, fetchImpl = fetch, maxBytes = AVATAR_CACHE_MAX_BYTES, maxItemBytes = AVATAR_MAX_BYTES }) {
  mkdirSync(dir, { recursive: true });
  const inflight = new Map();
  const index = new Map(); // id -> size（含 .type），Map 的插入顺序即 LRU 顺序（旧在前）
  let total = 0;

  // 启动时重建索引；顺手清掉上次中断留下的 .tmp。
  try {
    const found = [];
    for (const sub of readdirSync(dir)) {
      if (!/^[0-9a-f]{2}$/.test(sub)) continue;
      const subDir = path.join(dir, sub);
      for (const f of readdirSync(subDir)) {
        const fp = path.join(subDir, f);
        if (f.endsWith('.tmp')) { unlink(fp).catch(() => {}); continue; }
        if (!/^[0-9a-f]{64}$/.test(f)) continue;
        try {
          const st = statSync(fp);
          let size = st.size;
          try { size += statSync(fp + '.type').size; } catch { /* ignore */ }
          found.push({ id: f, size, mtime: st.mtimeMs });
        } catch { /* ignore */ }
      }
    }
    found.sort((a, b) => a.mtime - b.mtime);
    for (const x of found) { index.set(x.id, x.size); total += x.size; }
  } catch { /* 目录不可读就当空缓存 */ }

  const fileOf = (id) => path.join(dir, id.slice(0, 2), id);

  async function evict() {
    while (total > maxBytes && index.size) {
      const [id, size] = index.entries().next().value;
      index.delete(id);
      total -= size;
      const f = fileOf(id);
      await Promise.all([unlink(f).catch(() => {}), unlink(f + '.type').catch(() => {})]);
    }
  }

  function touch(id) {
    const size = index.get(id);
    if (size === undefined) return;
    index.delete(id);
    index.set(id, size);
    const now = new Date();
    utimes(fileOf(id), now, now).catch(() => {});
  }

  async function fetchRemote(url) {
    let cur = url;
    for (let hop = 0; hop < 4; hop++) {
      const r = await fetchImpl(cur, {
        headers: { 'User-Agent': BROWSER_UA, Accept: 'image/avif,image/webp,image/png,image/*;q=0.8' },
        redirect: 'manual',
        signal: AbortSignal.timeout(CHUB_TIMEOUT_MS),
      });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        const next = loc ? checkAvatarUrl(new URL(loc, cur).toString()) : null;
        try { await r.body?.cancel(); } catch { /* ignore */ }
        if (!next) throw new HttpError(403, '不允许的图片地址');
        cur = next;
        continue;
      }
      const drop = async () => { try { await r.body?.cancel(); } catch { /* ignore */ } };
      if (!r.ok) { await drop(); throw new HttpError(r.status === 404 ? 404 : 502, '头像加载失败'); }
      const type = (r.headers.get('content-type') || '').split(';')[0].trim();
      if (!IMAGE_TYPES.test(type)) { await drop(); throw new HttpError(502, '头像格式不支持'); }
      const len = Number(r.headers.get('content-length') || 0);
      if (len > maxItemBytes) { await drop(); throw new HttpError(502, '头像太大'); }
      const buf = await readCapped(r, maxItemBytes);
      return { type, buf };
    }
    throw new HttpError(502, '头像跳转次数太多');
  }

  async function get(url) {
    const safe = checkAvatarUrl(url);
    if (!safe) throw new HttpError(403, '不允许的图片地址');
    const id = crypto.createHash('sha256').update(safe).digest('hex');
    const file = fileOf(id);
    try {
      const [buf, meta] = await Promise.all([readFile(file), readFile(file + '.type', 'utf8')]);
      touch(id);
      return { type: meta.trim(), buf };
    } catch { /* 未缓存 */ }
    if (inflight.has(id)) return inflight.get(id);
    const p = (async () => {
      const { type, buf } = await fetchRemote(safe);
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, buf);
      await writeFile(file + '.type', type);
      await rename(tmp, file);
      const size = buf.length + Buffer.byteLength(type);
      if (index.has(id)) total -= index.get(id);
      index.delete(id);
      index.set(id, size);
      total += size;
      await evict();
      return { type, buf };
    })().finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  }

  return { get, stats: () => ({ files: index.size, bytes: total }) };
}
