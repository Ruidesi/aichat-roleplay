// 整卡译文版本与个人选择。只保存译文，不复制旧源正文；对外摘要不包含模型接口或凭据。
import crypto from 'node:crypto';
import { HttpError, nowIso } from './util.mjs';

const RESERVED_EXTRA = new Set(['model', 'messages', 'stream', 'stream_options']);
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])])) : value;
export function translationModelFingerprint(model) {
  let extra = {};
  try { const parsed = JSON.parse(model?.extra_json || '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) extra = parsed; } catch { /* 无效附加参数与模型服务一样按空处理 */ }
  for (const key of RESERVED_EXTRA) delete extra[key];
  return crypto.createHash('sha256').update(JSON.stringify([
    String(model?.base_url || '').trim().replace(/\/+$/, ''), String(model?.model || ''), ordered(extra),
  ])).digest('hex');
}

export function createTranslationHistory({ db, sourceHash }) {
  const byId = id => db.prepare('SELECT * FROM character_translations WHERE id=?').get(id);
  const available = item => !!item && ['ok', 'partial'].includes(item.status) && !!(item.card_json_zh || item.has_zh);
  const metadataColumns = `id,source_hash,model_id,model_name,model_provider,model_slug,version,status,created_at,
    (card_json_zh IS NOT NULL AND card_json_zh != '') AS has_zh`;
  function append(row, { model = null, fingerprint = null, result = null, status = result?.status || 'failed', userId = null, error = null, createdAt = nowIso() } = {}) {
    const hash = row.source_hash || sourceHash(row);
    const fp = fingerprint || (model ? translationModelFingerprint(model) : 'legacy');
    // 任务排队期间账号可能被删除；版本仍保留，创建者外键留空。
    const creator = userId !== null && db.prepare('SELECT id FROM users WHERE id=?').get(userId) ? userId : null;
    const version = db.prepare('SELECT COALESCE(MAX(version),0)+1 n FROM character_translations WHERE character_id=? AND source_hash=? AND model_id IS ? AND model_fingerprint=?').get(row.id, hash, model?.id ?? null, fp).n;
    const id = Number(db.prepare(`INSERT INTO character_translations(character_id,source_hash,model_id,model_name,model_provider,model_slug,model_fingerprint,
      card_json_zh,name_zh,tagline_zh,glossary_json,status,created_at,created_by,version,error,review_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, hash, model?.id ?? null, model?.name || '既有译文（来源未知）', model?.provider || '', model?.model || '', fp,
        result?.zh ? JSON.stringify(result.zh) : null, result?.name_zh ?? null, result?.tagline_zh ?? null,
        result?.glossary ? JSON.stringify(result.glossary) : null, status, createdAt, creator, version, error,
        result?.review ? JSON.stringify(result.review) : null).lastInsertRowid);
    return byId(id);
  }
  function archiveLegacy(row) {
    if (!row?.id || !row.card_json_zh || !['ok', 'partial'].includes(row.translate_status)) return;
    const hash = row.translate_hash || sourceHash(row);
    // 自动任务已保存的已知模型版本也可对应当前共享缓存，避免再冒出重复未知版本。
    const existing = db.prepare(`SELECT id FROM character_translations WHERE character_id=? AND source_hash=?
      AND card_json_zh=? AND name_zh IS ? AND tagline_zh IS ? LIMIT 1`).get(row.id, hash, row.card_json_zh, row.name_zh ?? null, row.tagline_zh ?? null);
    if (existing) return;
    let zh, glossary;
    try { zh = JSON.parse(row.card_json_zh); } catch { return; }
    try { glossary = JSON.parse(row.glossary_json || '{}'); } catch { glossary = {}; }
    append({ ...row, source_hash: hash }, { result: { zh, name_zh: row.name_zh, tagline_zh: row.tagline_zh, glossary, status: row.translate_status }, createdAt: row.translated_at || nowIso() });
  }
  function selected(row, user) {
    if (!row?.id || !user?.id) return null;
    const item = db.prepare(`SELECT t.* FROM user_character_translation_selections s JOIN character_translations t ON t.id=s.translation_id
      WHERE s.user_id=? AND s.character_id=? AND t.character_id=?`).get(user.id, row.id, row.id);
    return available(item) && item.source_hash === sourceHash(row) ? item : null;
  }
  function select(row, user, id) {
    if (!row?.id || !user?.id) throw new HttpError(400, '无法选择这个译文');
    let item = null;
    if (id !== null && id !== undefined && id !== '') {
      const n = Number(id);
      if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, '译文版本不正确');
      item = byId(n);
      if (!item || item.character_id !== row.id) throw new HttpError(404, '没有找到这个译文版本');
      if (item.source_hash !== sourceHash(row)) throw new HttpError(400, '原文已更新，请选择当前原文的译文');
      if (!available(item)) throw new HttpError(400, '这个译文版本不可用');
    }
    db.prepare(`INSERT INTO user_character_translation_selections(user_id,character_id,translation_id,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id,character_id) DO UPDATE SET translation_id=excluded.translation_id,updated_at=excluded.updated_at`)
      .run(user.id, row.id, item?.id ?? null, nowIso());
    return item;
  }
  function summary(item, row, selectedId = null, hash = sourceHash(row)) {
    if (!item) return null;
    const stale = item.source_hash !== hash;
    return { id: item.id, model_id: item.model_id, model_name: item.model_name, model_provider: item.model_provider, model_slug: item.model_slug,
      version: item.version, status: item.status, created_at: item.created_at, current_source: !stale, selected: item.id === selectedId,
      stale, selectable: !stale && available(item) };
  }
  function list(row, user, { beforeId = null, limit = 50 } = {}) {
    archiveLegacy(row);
    const n = Math.max(1, Math.min(200, Number.isInteger(Number(limit)) ? Number(limit) : 50));
    let before = null;
    if (beforeId !== null && beforeId !== undefined && beforeId !== '') {
      before = Number(beforeId);
      if (!Number.isSafeInteger(before) || before <= 0) throw new HttpError(400, '译文分页位置不正确');
    }
    // 历史列表只取摘要列，避免分页一次加载几十份长卡正文。
    const items = before ? db.prepare(`SELECT ${metadataColumns} FROM character_translations WHERE character_id=? AND id<? ORDER BY id DESC LIMIT ?`).all(row.id,before,n+1)
      : db.prepare(`SELECT ${metadataColumns} FROM character_translations WHERE character_id=? ORDER BY id DESC LIMIT ?`).all(row.id,n+1);
    const hasMore = items.length > n, page = items.slice(0,n), choice = selected(row,user);
    const hash = sourceHash(row);
    return { items: page.map(item => summary(item,row,choice?.id,hash)), selected_translation_id: choice?.id ?? null,
      selected_translation: summary(choice,row,choice?.id,hash), has_more: hasMore, next_before_id: hasMore ? page.at(-1).id : null };
  }
  const latest = (row, fingerprint, modelId) => db.prepare(`SELECT * FROM character_translations WHERE character_id=? AND source_hash=? AND model_id IS ? AND model_fingerprint=?
    AND status IN ('ok','partial') AND card_json_zh IS NOT NULL ORDER BY id DESC LIMIT 1`).get(row.id, sourceHash(row), modelId, fingerprint);
  function selectedRow(row, user) {
    const item = selected(row,user);
    if (!item) return row;
    return { ...row, card_json_zh: item.card_json_zh, name_zh: item.name_zh, tagline_zh: item.tagline_zh,
      glossary_json: item.glossary_json, translate_hash: item.source_hash, translate_status: item.status,
      translated_at: item.created_at, _selected_translation_id: item.id };
  }
  return { append, archiveLegacy, selected, select, summary, list, latest, selectedRow };
}
