// 角色镜像只读入口：列表不解析大卡JSON；完整卡只按唯一角色路径读取。
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from './util.mjs';
import { isValidChubPath, SORTS } from './chub.mjs';
import { NSFW_FORBIDDEN } from './characters.mjs';

const LIST_FIELDS = ['id','full_path','name','name_zh','tagline','tagline_zh','topics_json','nsfw','nsfw_image',
  'stars','chats','avatar_status','avatar_file'];
const parse = (raw, fallback = null) => { try { return JSON.parse(raw); } catch { return fallback; } };
const tagsOf = row => { const tags = parse(row?.topics_json, []); return Array.isArray(tags) ? tags.map(String) : []; };
const adult = row => !!Number(row?.nsfw) || !!Number(row?.nsfw_image) || tagsOf(row).some(t => t.toUpperCase() === 'NSFW');
const unavailable = () => new HttpError(503, '本地角色镜像暂时不可用，请稍后再试', 'mirror_unavailable');
const sortUnavailable = () => new HttpError(503, '此本地排序尚未建立索引，请选择热门或最新', 'mirror_sort_unavailable');
const invalidCursor = () => new HttpError(400, '分页游标已失效，请重新加载', 'invalid_cursor');
const quote = q => `"${q.replaceAll('"','""')}"`;
const like = q => `%${q.replace(/[\\%_]/g,'\\$&')}%`;

export function characterSource(raw) {
  if (raw == null || raw === '' || raw === 'local') return 'local';
  if (raw === 'remote') return raw;
  throw new HttpError(400, '角色来源不正确');
}

export function createMirrorCharacters({ dbFile, blockedPaths = () => [], retryMs = 10000 } = {}) {
  let db = null, columns = new Set(), indexed = new Set(), sortIndexes = new Map(), fts = false, nextTry = 0, closed = false;
  function closeConnection() { try { db?.close(); } catch {} db = null; }
  function connection() {
    if (closed || !dbFile || Date.now() < nextTry) return null;
    if (db) return db;
    try {
      db = new DatabaseSync(dbFile, { readOnly:true });
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250;');
      columns = new Set(db.prepare('PRAGMA table_info(chars)').all().map(c=>c.name));
      if (!columns.has('id') || !columns.has('full_path')) throw new Error('invalid mirror schema');
      indexed = new Set(['id','full_path']);
      sortIndexes = new Map();
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='chars'").all()) {
        const first = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno LIMIT 1').get(row.name);
        if (first) { indexed.add(first.name); if (!sortIndexes.has(first.name)) sortIndexes.set(first.name,row.name); }
      }
      fts = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='chars_fts'").get();
      return db;
    } catch { closeConnection(); nextTry = Date.now()+retryMs; return null; }
  }
  const select = names => names.map(k=>columns.has(k)?`c.${k}`:`NULL AS ${k}`).join(',');
  function metadata(p) {
    if (!isValidChubPath(p)) return null;
    const d = connection(); if (!d) return null;
    return d.prepare(`SELECT ${select(LIST_FIELDS)} FROM chars c WHERE c.full_path=?`).get(p) || null;
  }
  function assertAllowed(p, user) {
    const row = metadata(p);
    if (!user?.nsfw_enabled && (adult(row) || blockedPaths().includes(p))) throw new HttpError(403,NSFW_FORBIDDEN);
    return row;
  }
  function avatar(p) {
    const row = metadata(p);
    return row?.avatar_status === 'ok' && row.avatar_file ? `/api/images/a.${row.id}?variant=thumb` : '';
  }
  function item(row) {
    return { path:row.full_path,name:row.name || row.full_path,name_zh:row.name_zh || null,
      tagline:row.tagline || '',tagline_zh:row.tagline_zh || null,tags:tagsOf(row),nsfw:adult(row),
      stars:row.stars == null ? null : Number(row.stars),chats:row.chats == null ? null : Number(row.chats),
      avatar:row.avatar_status === 'ok' && row.avatar_file ? `/api/images/a.${row.id}?variant=thumb` : '',
      source:'local',local:true };
  }
  function list({ q='',tag='',sort='download_count',page=1,limit=24,cursor='',nsfw=false,includePaths=[] }={}) {
    if (!SORTS.includes(sort)) throw new HttpError(400,'排序方式不正确');
    const d = connection();
    if (!d) return { available:false,source:'local',items:[],page,has_more:false,next_cursor:null };
    const column = sort === 'created_at' ? 'created_at' : sort === 'last_activity_at' ? 'last_activity_at' : columns.has('stars') ? 'stars' : 'id';
    if (!columns.has(column) || !indexed.has(column)) throw sortUnavailable();
    const blocked = nsfw ? [] : [...new Set(blockedPaths())].sort();
    const included = [...new Set(includePaths)].sort();
    // 详情正常入缓存会增加译名候选；游标只绑定用户筛选和权限状态。
    const filterHash = crypto.createHash('sha256').update(JSON.stringify([q,tag,sort,nsfw,blocked])).digest('hex');
    let after = null;
    if (cursor) {
      try {
        if (cursor.length>1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalidCursor();
        const raw = Buffer.from(cursor,'base64url').toString('utf8');
        if (Buffer.from(raw).toString('base64url')!==cursor) throw invalidCursor();
        after = JSON.parse(raw);
        if (Object.keys(after).sort().join(',')!=='filterHash,id,v,value' || after.v!==1 || after.filterHash!==filterHash
          || !Number.isSafeInteger(after.id) || after.id<1 || (after.value!==null && (['stars','id'].includes(column)
            ? typeof after.value!=='number' || !Number.isFinite(after.value)
            : typeof after.value!=='string' || after.value.length>256))) throw invalidCursor();
      } catch { throw invalidCursor(); }
    }
    const where=[],params=[];
    if (!nsfw) {
      if (columns.has('nsfw')) where.push('COALESCE(c.nsfw,0)=0');
      if (columns.has('nsfw_image')) where.push('COALESCE(c.nsfw_image,0)=0');
      if (columns.has('topics_json')) where.push("NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(c.topics_json) THEN c.topics_json ELSE '[]' END) WHERE upper(value)='NSFW')");
      if (blocked.length) { where.push(`c.full_path NOT IN (${blocked.map(()=>'?').join(',')})`); params.push(...blocked); }
    }
    if (q) {
      let match;
      const qs=[];
      if (isValidChubPath(q)) { match='c.full_path=?';qs.push(q); }
      else if (fts && Array.from(q).length>=3) { match='c.id IN (SELECT rowid FROM chars_fts WHERE chars_fts MATCH ?)';qs.push(quote(q)); }
      else {
        const fields=['name','name_zh','tagline','tagline_zh'].filter(k=>columns.has(k));
        match=!fields.length ? '0' : fts ? `c.id IN (SELECT rowid FROM chars_fts WHERE ${fields.map(k=>`${k} LIKE ? ESCAPE '\\'`).join(' OR ')})`
          : `(${fields.map(k=>`c.${k} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
        qs.push(...fields.map(()=>like(q)));
      }
      if (included.length) { match=`(${match} OR c.full_path IN (SELECT value FROM json_each(?)))`;qs.push(JSON.stringify(included)); }
      where.push(match);params.push(...qs);
    }
    if (tag) {
      if (!columns.has('topics_json')) where.push('0');
      else {
        if (fts && Array.from(tag).length>=3) { where.push('c.id IN (SELECT rowid FROM chars_fts WHERE chars_fts MATCH ?)');params.push(`topics:${quote(tag)}`); }
        where.push("EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(c.topics_json) THEN c.topics_json ELSE '[]' END) WHERE lower(value)=lower(?))");params.push(tag);
      }
    }
    if (after) {
      if (after.value===null) { where.push(`c.${column} IS NULL AND c.id<?`);params.push(after.id); }
      else { where.push(`((c.${column},c.id)<(?,?) OR c.${column} IS NULL)`);params.push(after.value,after.id); }
    }
    // 广标签若先取全部FTS候选的元数据再排序，会产生大量随机SSD读取。
    // 只做有界候选计数；常见标签沿现有排序索引取够一页即停，稀有标签仍走FTS候选。
    let orderedIndex = '';
    if (tag && !q && fts && Array.from(tag).length>=3 && sortIndexes.has(column)) {
      const candidates=d.prepare('SELECT rowid FROM chars_fts WHERE chars_fts MATCH ? LIMIT 2049').all(`topics:${quote(tag)}`);
      if (candidates.length>2048) orderedIndex=` INDEXED BY "${sortIndexes.get(column).replaceAll('"','""')}"`;
    }
    const rows = d.prepare(`SELECT ${select(LIST_FIELDS)},c.${column} AS sort_value FROM chars c${orderedIndex}
      ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY c.${column} DESC,c.id DESC LIMIT ? OFFSET ?`)
      .all(...params,limit+1,after?0:(page-1)*limit);
    const shown=rows.slice(0,limit),last=shown.at(-1),hasMore=rows.length>limit;
    return { available:true,source:'local',items:shown.map(item),page,has_more:hasMore,
      next_cursor:hasMore&&last ? Buffer.from(JSON.stringify({v:1,id:last.id,value:last.sort_value,filterHash})).toString('base64url') : null };
  }
  function character(p,user) {
    assertAllowed(p,user);
    const d=connection();if(!d) throw unavailable();
    const fields=[...LIST_FIELDS,'card_json','card_json_zh','translated_at','translate_status'];
    const row=d.prepare(`SELECT ${select(fields)} FROM chars c WHERE c.full_path=?`).get(p);
    if (!row) throw new HttpError(404,'本地没有找到这个角色，可在发现页选择 Chub 外网搜索');
    const raw=parse(row.card_json),node=raw?.node || (raw?.definition ? raw : null);
    if (!node?.definition || typeof node.definition!=='object' || Array.isArray(node.definition))
      throw new HttpError(404,'本地尚未保存这张角色的完整设定，可在发现页选择 Chub 外网搜索');
    const translated=parse(row.card_json_zh),zh=translated?.node?.definition || translated?.definition || translated;
    return { node:{...node,fullPath:p,topics:tagsOf(row),nsfw_image:adult(row)},
      translation:['ok','partial'].includes(row.translate_status) && zh && typeof zh==='object' && !Array.isArray(zh) ? zh : null,
      name_zh:row.name_zh,tagline_zh:row.tagline_zh,translate_status:row.translate_status,translated_at:row.translated_at };
  }
  return { list,character,avatar,metadata,assertAllowed,available:()=>!!connection(),close:()=>{closed=true;closeConnection();} };
}
