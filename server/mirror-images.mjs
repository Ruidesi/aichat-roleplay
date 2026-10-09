// 只读抓取镜像。NAS路径来自数据库引用，媒体ID不含本机路径或远端URL。
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { realpath, open, lstat } from 'node:fs/promises';
import { HttpError } from './util.mjs';
import { isValidChubPath, checkAvatarUrl } from './chub.mjs';
import { NSFW_FORBIDDEN } from './characters.mjs';
import { readChunks } from './png.mjs';
import { createThumbnailCache } from './mirror-thumbnails.mjs';

export const MIRROR_IMAGE_MAX_BYTES = 64 * 1024 * 1024;
const TYPES = ['all', 'avatar', 'fullimg', 'gallery'];
const COLUMNS = 'c.id,c.full_path,c.name,c.name_zh,c.nsfw,c.nsfw_image,c.topics_json,c.avatar_url,c.max_res_url,c.avatar_file,c.avatar_status,c.avatar_bytes,c.fullimg_file,c.fullimg_status,c.fullimg_bytes';
const LIST_COLUMNS = 'c.id,c.full_path,c.name,c.name_zh,c.nsfw,c.nsfw_image,c.topics_json';
const RANK = { avatar: 0, fullimg: 1, gallery: 2 };
const notFound = () => new HttpError(404, '没有找到这张图片', 'image_not_found');
const unavailable = () => new HttpError(503, '图片库暂时不可用，请稍后重试', 'mirror_unavailable');
const inside = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);

export function parseImageQuery(query, { characterRequired = false } = {}) {
  const integer = (name, max, fallback) => {
    const raw = query.get(name);
    if (raw === null || raw === '') return fallback;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > max) throw new HttpError(400, '分页参数不正确');
    return Number(raw);
  };
  const kind = query.get('kind') || 'all';
  if (!TYPES.includes(kind)) throw new HttpError(400, '图片类型不正确');
  const q = (query.get('q') || '').trim();
  if (q.length > 120 || /[\x00-\x1f]/.test(q)) throw new HttpError(400, '搜索内容太长或格式不正确');
  const character = (query.get(characterRequired ? 'path' : 'character') || '').trim();
  if ((characterRequired && !character) || (character && (!isValidChubPath(character) || character.includes('\\')))) throw new HttpError(400, '角色地址不正确');
  const cursor = query.get('cursor') || '';
  if (cursor.length > 1024 || (cursor && !/^[A-Za-z0-9_-]+$/.test(cursor))) throw new HttpError(400, '分页游标不正确');
  return { kind, q, character, cursor, page: integer('page', cursor ? Number.MAX_SAFE_INTEGER : 500, 1), limit: integer('limit', 60, 24) };
}

function filterHash({ kind, q, character }) {
  return crypto.createHash('sha256').update(JSON.stringify([kind, q, character])).digest('hex');
}
function readCursor(raw, filters) {
  if (!raw) return null;
  try {
    if (raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    if (Buffer.from(json).toString('base64url') !== raw) throw new Error();
    const c = JSON.parse(json);
    if (!c || Array.isArray(c) || c.v !== 1 || !Number.isSafeInteger(c.sort_id) || c.sort_id < 1 || ![0, 1, 2].includes(c.rank)
      || c.filterHash !== filterHash(filters) || Object.keys(c).sort().join(',') !== 'filterHash,rank,sort_id,v') throw new Error();
    return c;
  } catch { throw new HttpError(400, '分页游标已失效，请重新加载', 'invalid_cursor'); }
}
function nextCursor(row, filters) {
  return Buffer.from(JSON.stringify({ v: 1, sort_id: row.sort_id, rank: RANK[row.kind], filterHash: filterHash(filters) })).toString('base64url');
}

function adult(row) {
  if (row.nsfw || row.nsfw_image || row.image_nsfw) return true;
  try { return JSON.parse(row.topics_json || '[]').some(t => String(t).toUpperCase() === 'NSFW'); } catch { return false; }
}
function mediaId(row) {
  return row.kind === 'gallery' ? `g.${row.id}.${Buffer.from(String(row.image_id)).toString('base64url')}` : `${row.kind === 'avatar' ? 'a' : 'f'}.${row.id}`;
}
function parseMediaId(id) {
  const m = /^(a|f|g)\.([1-9]\d{0,15})(?:\.([A-Za-z0-9_-]{1,1400}))?$/.exec(id || '');
  if (!m || !Number.isSafeInteger(Number(m[2])) || (m[1] === 'g') !== !!m[3]) throw new HttpError(400, '图片地址不正确');
  const imageId = m[3] ? Buffer.from(m[3], 'base64url').toString('utf8') : null;
  if (m[3] && (!imageId || Buffer.from(imageId).toString('base64url') !== m[3] || imageId.includes('\0'))) throw new HttpError(400, '图片地址不正确');
  return { kind: m[1] === 'a' ? 'avatar' : m[1] === 'f' ? 'fullimg' : 'gallery', charId: Number(m[2]), imageId };
}
function mimeOf(buf) {
  if (buf.length < 12) throw notFound();
  if (buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    try { const chunks = readChunks(buf); if (!chunks.some(c => c.type === 'IDAT')) throw new Error('no data'); return 'image/png'; } catch { throw notFound(); }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' && buf.readUInt32LE(4) + 8 <= buf.length && ['VP8 ', 'VP8L', 'VP8X'].includes(buf.toString('ascii', 12, 16))) return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(buf.toString('ascii', 0, 6)) && buf[buf.length - 1] === 0x3b) return 'image/gif';
  if (buf.toString('ascii', 4, 8) === 'ftyp' && buf.readUInt32BE(0) >= 16 && buf.readUInt32BE(0) <= buf.length && /avif|avis/.test(buf.toString('ascii', 8, Math.min(buf.readUInt32BE(0), 64)))) return 'image/avif';
  throw notFound();
}
const extension = type => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' })[type];

export function createMirrorImages({ dbFile, imageDir, cacheDir, previewMaxBytes = 1024 * 1024 * 1024, isAdultPath = () => false, characterOfPath = () => null, charactersOfAvatarUrl = () => [], thumbnailCache = null, nasReader = null, apiReader = null, apiBreakerMs = 30000, apiBreakerFailures = 3, retryMs = 10000, ioTimeoutMs = 15000,
  apiIoConcurrency = 16, smbIoConcurrency = 4, thumbConcurrency = apiReader ? 16 : 2, thumbConvert = apiReader ? Math.max(2, Math.min(8, os.availableParallelism() - 1)) : 2 } = {}) {
  let db = null, nextTry = 0, closed = false, fts = false;
  let charColumns = COLUMNS, galleryRevision = 'NULL';
  const bindings = new Map();
  const urlBindings = new Map();
  // 44970 API 没什么并发限制（同一来源 24 路），NAS 读取与缩略图生成都放宽；SMB 兜底时仍按 4 路，免得压垮挂载。
  const thumbs = thumbnailCache || createThumbnailCache({ dir: cacheDir, maxBytes: previewMaxBytes, maxConcurrent: thumbConcurrency, maxConvert: thumbConvert,
    maxPending: apiReader ? 512 : 64 });
  const previewFailures = new Map();
  // 44970 API 优先；连续失败（或 401/403）后熔断 apiBreakerMs，期间全走 SMB，到期先用 HEAD 在后台再探。
  const api = { failures: 0, openUntil: 0, probing: null };
  const API_TRIP_NOW = new Set(['unauthorized', 'forbidden']);
  function apiRoute(rel) {
    if (!apiReader || closed) return false;
    if (!api.openUntil) return true;
    if (Date.now() >= api.openUntil && !api.probing && apiReader.size) {
      const controller = new AbortController();
      api.probing = controller;
      // 探测结果：成功/404 = 接口正常；与接口健康无关的失败（没配密钥、路径不合法）不改熔断。
      apiReader.size(rel, { signal: controller.signal }).then(() => 'ok', e => e?.status === 404 ? 'ok' : e?.breaker === false ? 'skip' : 'fail')
        .then(r => { if (api.probing !== controller || closed) return; if (r === 'ok') apiHealthy(); else if (r === 'fail') api.openUntil = Date.now() + apiBreakerMs; })
        .finally(() => { if (api.probing === controller) api.probing = null; });
    }
    return false;
  }
  function apiHealthy() { api.failures = 0; api.openUntil = 0; }
  // 列表一返回就在后台把这一页的缩略图全部开始准备：浏览器对同一站点同时只发 6 个请求，不预取的话冷图只能 6 张 6 张排队等 NAS。
  // 只在 API 正常时做（SMB 兜底时不加压）；同一张图正在准备时浏览器的请求会直接等这一份，不会重复读。
  function prefetchThumbs(ids, user) {
    if (!apiReader || api.openUntil || closed || !ids.length) return;
    setImmediate(() => { for (const id of ids) read(id, { variant: 'thumb', user }).catch(() => {}); });
  }
  function apiFailed(e) {
    if (e?.breaker === false) return;
    if (++api.failures >= apiBreakerFailures || API_TRIP_NOW.has(e?.reason)) api.openUntil = Date.now() + apiBreakerMs;
  }
  let activeReads = 0;
  const ioQueue = [];
  const activeIOTasks = new Set();
  function io(run) {
    if (closed || ioQueue.length >= (apiReader ? 256 : 32)) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      const task = { run, resolve, reject, expired: false, timer: null, controller: new AbortController() };
      task.timer = setTimeout(() => {
        task.expired = true; task.controller.abort(); reject(unavailable());
        const i = ioQueue.indexOf(task); if (i >= 0) ioQueue.splice(i, 1);
        // 已启动的IO直到真正完成才释放并发槽；超时不会反复启动新的挂起读取。
      }, ioTimeoutMs);
      task.timer.unref?.(); ioQueue.push(task); drain();
    });
  }
  function drain() {
    while (!closed && activeReads < (apiReader && !api.openUntil ? apiIoConcurrency : smbIoConcurrency) && ioQueue.length) {
      const task = ioQueue.shift(); activeReads++;
      activeIOTasks.add(task);
      task.run(() => task.expired || closed, task.controller.signal).then(task.resolve, task.reject).finally(() => {
        clearTimeout(task.timer); activeIOTasks.delete(task); activeReads--; drain();
      });
    }
  }
  function connection() {
    if (closed || !dbFile || !imageDir || Date.now() < nextTry) return null;
    if (db) return db;
    try {
      db = new DatabaseSync(dbFile, { readOnly: true });
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250;');
      const chars = new Set(db.prepare('PRAGMA table_info(chars)').all().map(c => c.name));
      const gallery = new Set(db.prepare('PRAGMA table_info(gallery)').all().map(c => c.name));
      charColumns = COLUMNS + ['avatar_fetched_at', 'fullimg_fetched_at'].map(c => `,${chars.has(c) ? `c.${c}` : 'NULL'} AS ${c}`).join('');
      galleryRevision = gallery.has('fetched_at') ? 'g.fetched_at' : 'NULL';
      db.prepare(`SELECT ${COLUMNS} FROM chars c LIMIT 0`).all();
      db.prepare('SELECT char_id,image_id,file,bytes,status,nsfw FROM gallery LIMIT 0').all();
      fts = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='chars_fts'").get();
      return db;
    } catch { failed(); return null; }
  }
  function failed() {
    try { db?.close(); } catch { /* ignore */ }
    db = null; nextTry = Date.now() + retryMs;
  }
  function lookup(p) {
    const d = connection();
    if (!d) return null;
    try { return d.prepare(`SELECT ${charColumns} FROM chars c WHERE c.full_path=?`).get(p) || null; } catch { failed(); return null; }
  }
  const knownAdultPath = p => !!isAdultPath(p) || !!bindings.get(p)?.nsfw;
  function allow(row, user) {
    if ((adult(row) || knownAdultPath(row.full_path)) && !user?.nsfw_enabled) throw new HttpError(403, NSFW_FORBIDDEN);
  }
  function publicItem(row) {
    const id = mediaId(row), url = `/api/images/${id}`;
    return { id, kind: row.kind, character_path: row.full_path, character_name: row.name_zh || row.name || row.full_path,
      nsfw: adult(row) || knownAdultPath(row.full_path), thumbnail_url: `${url}?variant=thumb`, original_url: `${url}?variant=original`,
      download_url: `${url}?variant=original&download=1`, source: 'nas', bytes: Math.max(0, Number(row.bytes) || 0) };
  }
  function list({ kind = 'all', q = '', character = '', page = 1, limit = 24, cursor = '', user } = {}) {
    const filters = { kind, q, character };
    const after = readCursor(cursor, filters);
    const empty = { available: false, reason: 'mirror_unavailable', items: [], page, limit, has_more: false };
    const d = connection();
    if (!d) return empty;
    const characterRow = character ? lookup(character) : null;
    if (characterRow) allow(characterRow, user);
    if (character && knownAdultPath(character) && !user?.nsfw_enabled) throw new HttpError(403, NSFW_FORBIDDEN);
    const where = [], params = [];
    if (character) { where.push('c.full_path=?'); params.push(character); }
    if (!user?.nsfw_enabled) where.push(`COALESCE(c.nsfw,0)=0 AND COALESCE(c.nsfw_image,0)=0 AND NOT EXISTS
      (SELECT 1 FROM json_each(CASE WHEN json_valid(c.topics_json) THEN c.topics_json ELSE '[]' END) WHERE upper(value)='NSFW')`);
    if (q) {
      if (fts && Array.from(q).length >= 3) {
        where.push('c.id IN (SELECT rowid FROM chars_fts WHERE chars_fts MATCH ?)'); params.push(`"${q.replaceAll('"', '""')}"`);
      } else {
        // FTS轻量名称索引支持完整短词匹配；旧库无FTS时也不能静默遗漏角色。
        where.push(fts
          ? "c.id IN (SELECT rowid FROM chars_fts WHERE name LIKE ? ESCAPE '\\' OR name_zh LIKE ? ESCAPE '\\')"
          : "(c.name LIKE ? ESCAPE '\\' OR c.name_zh LIKE ? ESCAPE '\\')");
        const literal = `%${q.replace(/[\\%_]/g, '\\$&')}%`; params.push(literal, literal);
      }
    }
    const common = where.length ? ` AND ${where.join(' AND ')}` : '';
    const need = after ? limit + 1 : page * limit + 1;
    const rows = [];
    try {
      for (const type of kind === 'all' ? TYPES.slice(1) : [kind]) {
        const rank = RANK[type];
        if (after && character && rank < after.rank) continue;
        const gallery = type === 'gallery';
        const extra = gallery && !user?.nsfw_enabled ? ' AND COALESCE(g.nsfw,0)=0' : '';
        let before = null, visible = 0;
        do {
          const column = gallery ? 'g.rowid' : 'c.id';
          const window = after && (!character || rank === after.rank) ? ` AND ${column}${!character && rank > after.rank ? '<=' : '<'}?` : '';
          const cursor = before === null ? '' : ` AND ${column}<?`;
          const charFilter = gallery && characterRow ? ' AND g.char_id=?' : '';
          const sql = gallery
            ? `SELECT ${LIST_COLUMNS},g.image_id,g.nsfw AS image_nsfw,g.file,g.bytes,g.rowid AS sort_id FROM gallery g JOIN chars c ON c.id=g.char_id WHERE g.status='ok' AND g.file IS NOT NULL AND g.file<>''${common}${extra}${charFilter}${window}${cursor} ORDER BY g.rowid DESC LIMIT ?`
            : `SELECT ${LIST_COLUMNS},c.${type}_file AS file,c.${type}_bytes AS bytes,c.id AS sort_id FROM chars c WHERE c.${type}_status='ok' AND c.${type}_file IS NOT NULL AND c.${type}_file<>''${common}${window}${cursor} ORDER BY c.id DESC LIMIT ?`;
          const p = [...params];
          if (gallery && characterRow) p.push(characterRow.id);
          if (window) p.push(after.sort_id);
          if (before !== null) p.push(before);
          const batch = need - visible; p.push(batch);
          const found = d.prepare(sql).all(...p);
          rows.push(...found.filter(r => user?.nsfw_enabled || !knownAdultPath(r.full_path)).map(r => { visible++; return { ...r, kind: type }; }));
          if (found.length < batch || !found.length) break;
          before = found[found.length - 1].sort_id;
        } while (visible < need);
      }
      rows.sort((a, b) => character ? RANK[a.kind] - RANK[b.kind] || b.sort_id - a.sort_id : b.sort_id - a.sort_id || RANK[a.kind] - RANK[b.kind]);
      const start = after ? 0 : (page - 1) * limit;
      const selected = rows.slice(start, start + limit), has_more = rows.length > start + limit;
      prefetchThumbs(selected.map(mediaId), user);
      return { available: true, items: selected.map(publicItem), page, limit, has_more,
        next_cursor: has_more && selected.length ? nextCursor(selected[selected.length - 1], filters) : null };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      failed(); return empty;
    }
  }
  function find(id, user) {
    const parsed = parseMediaId(id), d = connection();
    if (!d) throw unavailable();
    let row;
    try {
      row = parsed.kind === 'gallery'
        ? d.prepare(`SELECT ${charColumns},g.image_id,g.nsfw AS image_nsfw,g.file,g.bytes,g.status,${galleryRevision} AS revision FROM gallery g JOIN chars c ON c.id=g.char_id WHERE g.char_id=? AND g.image_id=?`).get(parsed.charId, parsed.imageId)
        : d.prepare(`SELECT ${charColumns},c.${parsed.kind}_file AS file,c.${parsed.kind}_bytes AS bytes,c.${parsed.kind}_status AS status FROM chars c WHERE c.id=?`).get(parsed.charId);
    } catch { failed(); throw unavailable(); }
    if (!row) throw notFound();
    allow(row, user);
    if (row.status !== 'ok' || !row.file) throw notFound();
    return { ...row, kind: parsed.kind };
  }
  function lexicalFile(file) {
    if (typeof file !== 'string' || !file || file.length > 4096 || /[\x00-\x1f\\]/.test(file) || file.split('/').includes('..')) throw notFound();
    const root = path.resolve(imageDir), candidate = path.resolve(root, file);
    if (!inside(root, candidate) || candidate === root) throw notFound();
    return { root, candidate };
  }
  async function readFileSafe(file, { metadataOnly = false } = {}) {
    return io(async (expired, signal) => {
      const live = () => { if (expired()) throw unavailable(); };
      let fh;
      try {
        live();
        const { root, candidate } = lexicalFile(file);
        const rel = path.relative(root, candidate).split(path.sep).join('/');
        if (apiRoute(rel)) {
          try {
            if (metadataOnly && apiReader.size) {
              const size = await apiReader.size(rel, { signal });
              live(); apiHealthy();
              if (!Number.isSafeInteger(size) || size < 12 || size > MIRROR_IMAGE_MAX_BYTES) throw notFound();
              return { size };
            }
            const buf = await apiReader.read(rel, { signal });
            live(); apiHealthy();
            if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.length > MIRROR_IMAGE_MAX_BYTES) throw notFound();
            const type = mimeOf(buf);
            return metadataOnly ? { size: buf.length } : { buf, type };
          } catch (e) {
            live();
            if (e?.status === 404) { apiHealthy(); throw e; } // 404 = 图片不存在，不兜底
            if (!e?.fallback && e instanceof HttpError) throw e;
            if (!e?.fallback) e = { breaker: true };
            apiFailed(e); // 这一次读取退回下面的 SMB/fast 路径
          }
        }
        if (nasReader) {
          // reader的abort/timeout严格等源worker实际close后才settle；外层响应可先超时。
          const buf = await nasReader.read(path.relative(root, candidate), { signal });
          live();
          if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.length > MIRROR_IMAGE_MAX_BYTES) throw notFound();
          const type = mimeOf(buf);
          return metadataOnly ? { size: buf.length } : { buf, type };
        }
        let resolvedRoot, resolved;
        try {
          try { resolvedRoot = await realpath(root); } catch { throw unavailable(); }
          resolved = await realpath(candidate);
          live();
          if (!inside(resolvedRoot, resolved)) throw notFound();
          const relative = path.relative(root, candidate);
          let cur = root;
          for (const part of relative.split(path.sep)) { live(); cur = path.join(cur, part); if ((await lstat(cur)).isSymbolicLink()) throw notFound(); }
          fh = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          live();
          const s = await fh.stat();
          const current = await lstat(candidate);
          if (!s.isFile() || s.size < 12 || s.size > MIRROR_IMAGE_MAX_BYTES || s.ino !== current.ino || s.dev !== current.dev || !inside(resolvedRoot, await realpath(candidate))) throw notFound();
          live();
          const stamp = `${resolved}:${s.ino}:${s.size}:${s.mtimeMs}`;
          if (metadataOnly) return { stamp, size: s.size };
          const chunks = []; let length = 0;
          while (length <= MIRROR_IMAGE_MAX_BYTES) {
            live();
            const chunk = Buffer.allocUnsafe(Math.min(256 * 1024, MIRROR_IMAGE_MAX_BYTES + 1 - length));
            const { bytesRead } = await fh.read(chunk, 0, chunk.length, null);
            if (!bytesRead) break;
            length += bytesRead; if (length > MIRROR_IMAGE_MAX_BYTES) throw notFound();
            chunks.push(chunk.subarray(0, bytesRead));
          }
          if (length !== s.size) throw notFound();
          live();
          const buf = Buffer.concat(chunks, length), type = mimeOf(buf);
          return { buf, type, stamp };
        } catch (e) {
          if (e instanceof HttpError) throw e;
          if (['EACCES', 'EPERM', 'EIO', 'ETIMEDOUT', 'ENOTCONN'].includes(e?.code)) throw unavailable();
          throw notFound();
        } finally { await fh?.close().catch(() => {}); }
      } catch (e) { throw e; }
    });
  }
  async function read(id, { variant = 'original', user } = {}) {
    if (!['thumb', 'original'].includes(variant)) throw new HttpError(400, '图片版本不正确');
    const row = find(id, user);
    let image;
    if (variant === 'thumb') {
      // 先检查当前权限及数据库路径，再只访问SSD；warm预览不依赖NAS是否在线。
      lexicalFile(row.file);
      const candidates = [];
      if (row.kind === 'fullimg' && row.avatar_status === 'ok' && row.avatar_file) {
        try { lexicalFile(row.avatar_file); candidates.push({ ...row, kind: 'avatar', file: row.avatar_file, bytes: row.avatar_bytes }); }
        catch (e) { if (e?.status !== 404) throw e; }
      }
      candidates.push(row);
      const previews = candidates.map(c => ({ file: c.file, preserveSmall: c.kind === 'avatar',
        key: JSON.stringify([path.resolve(imageDir), mediaId(c), c.file, c.bytes ?? null,
          c.kind === 'gallery' ? c.revision ?? null : c[`${c.kind}_fetched_at`] ?? null]) }));
      // fullimg可能已有预览；不得先因冷头像等待NAS而挡住后面的热候选。
      for (const p of previews) {
        image = await thumbs.peekPreview(p.key, { preserveSmall: p.preserveSmall });
        if (image) break;
      }
      if (!image) {
        for (let i = 0; i < previews.length; i++) {
          const p = previews[i], failed = previewFailures.get(p.key);
          try {
            if (failed && failed.until > Date.now()) throw failed.error;
            previewFailures.delete(p.key);
            image = await thumbs.getPreview(p.key, async () => {
              const { buf, type } = await readFileSafe(p.file);
              return { buf, type };
            }, { preserveSmall: p.preserveSmall });
            previewFailures.delete(p.key); break;
          } catch (e) {
            if (![404, 503].includes(e?.status)) throw e;
            if (!failed || failed.until <= Date.now()) {
              previewFailures.delete(p.key); previewFailures.set(p.key, { until: Date.now() + 10000, error: e });
              while (previewFailures.size > 1000) previewFailures.delete(previewFailures.keys().next().value);
            }
            if (i === previews.length - 1) throw e;
          }
        }
      }
    }
    image ||= await readFileSafe(row.file);
    return { ...image, filename: `${row.kind}-${row.id}.${extension(image.type)}` };
  }
  function fallbackUrl(proxy) {
    try {
      const u = new URL(proxy, 'http://local');
      return u.origin === 'http://local' && u.pathname === '/api/avatar' ? checkAvatarUrl(u.searchParams.get('u')) : null;
    } catch { return null; }
  }
  function rememberUrl(p, remote, nsfw) {
    if (!remote) return;
    const known = urlBindings.get(remote) || { paths: new Set(), nsfw: false, overflow: false };
    known.paths.add(p); known.nsfw ||= nsfw;
    while (known.paths.size > 64) { known.overflow = true; known.paths.delete(known.paths.values().next().value); }
    urlBindings.delete(remote); urlBindings.set(remote, known);
    while (urlBindings.size > 5000) urlBindings.delete(urlBindings.keys().next().value);
  }
  function avatarUrl(p, fallbackProxy = '', evidence = {}) {
    if (!isValidChubPath(p) || p.includes('\\')) return fallbackProxy;
    const remote = fallbackUrl(fallbackProxy);
    const row = lookup(p);
    const nsfw = !!bindings.get(p)?.nsfw || !!evidence.nsfw || (Array.isArray(evidence.tags) && evidence.tags.some(t => String(t).toUpperCase() === 'NSFW'))
      || (row ? adult(row) : false) || !!isAdultPath(p);
    if (remote) {
      bindings.delete(p); bindings.set(p, { remote, at: Date.now(), nsfw });
      while (bindings.size > 5000) bindings.delete(bindings.keys().next().value);
      rememberUrl(p, remote, nsfw);
    }
    if (!row && !remote && !characterOfPath(p)?.avatar_url) return fallbackProxy;
    const associated = checkAvatarUrl(row?.avatar_url || row?.max_res_url || '') || checkAvatarUrl(characterOfPath(p)?.avatar_url || '') || remote;
    rememberUrl(p, associated, nsfw);
    return `/api/avatar?${associated ? `u=${encodeURIComponent(associated)}&` : ''}p=${encodeURIComponent(p)}`;
  }
  function avatarRemote(p, user) {
    if (!isValidChubPath(p) || p.includes('\\')) throw new HttpError(400, '角色地址不正确');
    const row = lookup(p), local = characterOfPath(p);
    if (row) allow(row, user);
    if (knownAdultPath(p) && !user?.nsfw_enabled) throw new HttpError(403, NSFW_FORBIDDEN);
    const bound = bindings.get(p);
    if (row) return checkAvatarUrl(row.avatar_url || row.max_res_url || '') || checkAvatarUrl(local?.avatar_url || '') || (bound && Date.now() - bound.at < 600000 ? bound.remote : null);
    return checkAvatarUrl(local?.avatar_url || '') || (bound && Date.now() - bound.at < 600000 ? bound.remote : null);
  }
  function avatarLegacy(raw, user) {
    const remote = checkAvatarUrl(raw);
    if (!remote) throw new HttpError(403, '不允许的图片地址');
    const known = urlBindings.get(remote);
    if (known?.overflow) throw new HttpError(403, '请使用带角色信息的头像地址');
    const paths = new Set(known?.paths || []);
    const local = charactersOfAvatarUrl(raw, remote) || [];
    if (!Array.isArray(local) || local.length > 64) throw new HttpError(403, '请使用带角色信息的头像地址');
    for (const row of local) paths.add(row.full_path || row.chub_path);
    // 旧CDN地址常含角色路径；只按唯一角色键查询，再确认URL确实属于该行。
    try {
      const u = new URL(remote), parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'avatars' && parts.length >= 4) {
        const p = `${decodeURIComponent(parts[1])}/${decodeURIComponent(parts[2])}`;
        if (isValidChubPath(p)) {
          const row = lookup(p);
          if (row && checkAvatarUrl(row.avatar_url || row.max_res_url || '') === remote) paths.add(p);
        }
      }
    } catch { /* 不接受无法关联的URL */ }
    if (paths.size > 64) throw new HttpError(403, '请使用带角色信息的头像地址');
    if (!paths.size) throw new HttpError(403, '图片地址未关联可访问的角色');
    if (!user?.nsfw_enabled && (known?.nsfw || local.some(adult))) throw new HttpError(403, NSFW_FORBIDDEN);
    for (const p of paths) {
      const row = lookup(p);
      if (row) allow(row, user);
      if (knownAdultPath(p) && !user?.nsfw_enabled) throw new HttpError(403, NSFW_FORBIDDEN);
    }
    return remote;
  }
  async function readAvatar(p, user) {
    avatarRemote(p, user); // 鉴权失败不能进入CDN回源。
    const row = lookup(p);
    if (!row || row.avatar_status !== 'ok' || !row.avatar_file) return null;
    try { return await read(`a.${row.id}`, { variant: 'thumb', user }); } catch (e) { if ([404, 503].includes(e?.status)) return null; throw e; }
  }
  function close() {
    closed = true; thumbs.close();
    for (const task of activeIOTasks) task.controller.abort();
    for (const task of ioQueue.splice(0)) { clearTimeout(task.timer); task.controller.abort(); task.reject(unavailable()); }
    try { db?.close(); } catch { /* ignore */ } db = null; bindings.clear(); urlBindings.clear(); previewFailures.clear();
    api.probing?.abort(); api.probing = null;
    const closing = nasReader?.close();
    closing?.catch?.(() => {}); // 保留返回Promise供await；旧同步关闭调用也不会产生未处理拒绝。
    if (!apiReader) return closing;
    const apiClosing = Promise.resolve(apiReader.close()).catch(() => {});
    return closing ? Promise.all([closing, apiClosing]) : apiClosing;
  }
  return { list, read, readAvatar, avatarUrl, avatarRemote, avatarLegacy, assertAllowed: find, close };
}
