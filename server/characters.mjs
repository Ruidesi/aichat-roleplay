// 角色缓存：第一次打开某个 chub 角色时拉详情存库；开场白中文翻译缓存在 greeting_zh。
import { HttpError, nowIso } from './util.mjs';
import { isNsfwNode, avatarProxyUrl, isValidChubPath } from './chub.mjs';
import { translateGreeting } from './llm.mjs';
import { applyMacros, userCallName } from './prompt.mjs';
import { createTranslationService, needsTranslation, sourceHash } from './translate.mjs';
import { chubDefinitionToData, TEXT_FIELDS } from './cards.mjs';

const REFRESH_MS = 7 * 24 * 3600 * 1000;

export const NSFW_FORBIDDEN = '该角色含成人内容，请先在「我的」里开启成人内容';

export function parseJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

export function rowToCard(row) {
  return {
    path: row.chub_path,
    name: row.name,
    tagline: row.tagline,
    avatar: avatarProxyUrl(row.avatar_url),
    tags: parseJson(row.tags_json, []),
    nsfw: !!row.nsfw,
    stars: null,
    chats: null,
  };
}

/** 新建会话时最多等在途的整卡翻译多久（拿中文开场白与中文名）；超时就单独翻开场白，不让用户久等。 */
export const CHAT_WAIT_TRANSLATION_MS = 15 * 1000;
/** 新建会话等翻译的总预算（等整卡 + 单独翻开场白共用）：到点先用原文开场白建会话，翻译在后台继续、回写 greeting_zh。 */
export const CHAT_TRANSLATE_BUDGET_MS = 20 * 1000;
/** 新建会话时单独翻开场白最多等多久（同时受总预算约束）。 */
export const CHAT_GREETING_WAIT_MS = 12 * 1000;
/** 开场白翻译单次调用的超时（后台继续跑时也以此为限；超时计入翻译模型熔断）。 */
export const GREETING_TIMEOUT_MS = 45 * 1000;

export function createCharacterService({ db, chub, llm, costs = null, models = null, translations = null, grokCli = null, mirror = null, timing = {} }) {
  const translating = new Map();
  // 时限（测试可缩短）
  const T = {
    waitCard: timing.waitCardMs ?? CHAT_WAIT_TRANSLATION_MS,
    budget: timing.budgetMs ?? CHAT_TRANSLATE_BUDGET_MS,
    waitGreeting: timing.waitGreetingMs ?? CHAT_GREETING_WAIT_MS,
    greetingTimeout: timing.greetingTimeoutMs ?? GREETING_TIMEOUT_MS,
  };
  // 契约 §19：整卡翻译 / 列表翻译 / 标签译名表（models 缺省时只能用 llm 默认模型）。
  const tr = translations || createTranslationService({
    db, llm, costs, grokCli,
    models: models || { byId: () => null, listEnabled: () => [], systemDefault: () => null },
  });

  const getRow = (path) => db.prepare('SELECT * FROM characters WHERE chub_path = ?').get(path);
  const getRowById = (id) => db.prepare('SELECT * FROM characters WHERE id = ?').get(id);

  function storeNode(path, node, old, local = null) {
    if (old) tr.archiveTranslation?.(old);
    const def = node.definition || {};
    const card = {
      name: def.name || node.name || '',
      description: def.description ?? node.description ?? '',
      personality: def.personality || '',
      tavern_personality: def.tavern_personality || '',
      scenario: def.scenario || '',
      first_message: def.first_message || '',
      example_dialogs: def.example_dialogs || '',
      system_prompt: def.system_prompt || '',
      post_history_instructions: def.post_history_instructions || '',
      alternate_greetings: Array.isArray(def.alternate_greetings) ? def.alternate_greetings : [],
      ...def,
    };
    // card_json 存 definition 原样（补齐常用键便于读取）。
    const oldDef = old ? parseJson(old.card_json, {}) : {};
    const keepZh = old && old.greeting_zh != null && (oldDef.first_message || '') === (card.first_message || '');
    const fullPath = node.fullPath || path;
    const tags = Array.isArray(node.topics) ? node.topics.map(String) : [];
    db.prepare(`
      INSERT INTO characters(chub_path, name, tagline, avatar_url, tags_json, nsfw, card_json, greeting_zh, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chub_path) DO UPDATE SET name=excluded.name, tagline=excluded.tagline, avatar_url=excluded.avatar_url,
        tags_json=excluded.tags_json, nsfw=excluded.nsfw, card_json=excluded.card_json, greeting_zh=excluded.greeting_zh, fetched_at=excluded.fetched_at
    `).run(path, node.name || card.name || fullPath, node.tagline || '', node.avatar_url || node.max_res_url || '', JSON.stringify(tags),
      isNsfwNode(node) ? 1 : 0, JSON.stringify(card), keepZh ? old.greeting_zh : null, nowIso());
    let row = getRow(path);
    if (local?.translation) {
      // 镜像已有译文可直接复用；只写开发/应用缓存，不调用翻译模型。
      db.prepare(`UPDATE characters SET name_zh=?,tagline_zh=?,card_json_zh=?,translate_status=?,
        translate_hash=?,translated_at=? WHERE id=?`).run(local.name_zh || null,local.tagline_zh || null,
        JSON.stringify(local.translation),local.translate_status,sourceHash(row),local.translated_at || null,row.id);
      row = getRow(path);
    }
    return row;
  }

  async function fetchAndStore(path, old) {
    return storeNode(path, await chub.character(path), old);
  }

  /**
   * 开场白中文（缓存在 greeting_zh）。waitMs：最多等多久（不传就等到结束）；到点先回原文（_greeting_fallback），翻译在后台继续并回写。
   * 失败计入翻译模型熔断（tr.noteFail），连续失败后 tr.model() 会改用其他启用的 DeepSeek 模型。
   */
  async function ensureGreetingZh(row, user = null, { waitMs = null } = {}) {
    if (row.greeting_zh != null) return row;
    const def = parseJson(row.card_json, {});
    const src = def.first_message || '';
    if (!src.trim()) {
      db.prepare('UPDATE characters SET greeting_zh = ? WHERE id = ?').run('', row.id);
      return { ...row, greeting_zh: '' };
    }
    if (!translating.has(row.id)) {
      // 契约 §10.2：翻译开场白的花费记 system_costs（kind=translate），不算进会话。
      const tm = tr.model(); // 契约 §19.2：翻译模型（设置 translate_model_id，默认「DeepSeek 快速」）
      const onResult = (r) => costs?.recordSystem('translate', (r?.model_id && models?.byId?.(r.model_id)) || tm || null, user?.id ?? null, r);
      const translator = tr.complete ? { complete: tr.complete } : llm;
      const p = translateGreeting(translator, src, { onResult, model: tm || undefined, timeoutMs: T.greetingTimeout })
        .then((zh) => { tr.noteOk?.(tm); db.prepare('UPDATE characters SET greeting_zh = ? WHERE id = ?').run(zh, row.id); return zh; })
        .catch((e) => { tr.noteFail?.(tm, e); console.error('[translate] 开场白翻译失败:', e?.message || e); return null; })
        .finally(() => translating.delete(row.id));
      translating.set(row.id, p);
    }
    const pending = translating.get(row.id);
    let zh;
    if (waitMs == null) zh = await pending;
    else {
      let timer;
      const TIMEOUT = Symbol('timeout');
      zh = waitMs <= 0 ? TIMEOUT : await Promise.race([pending, new Promise((r) => { timer = setTimeout(() => r(TIMEOUT), waitMs); timer.unref?.(); })]);
      clearTimeout(timer);
      if (zh === TIMEOUT) {
        console.warn(`[translate] 开场白翻译 ${Math.round(Math.max(0, waitMs) / 1000)} 秒内没完成，先用原文建会话，翻译在后台继续：${row.chub_path}`);
        return { ...row, greeting_zh: null, _greeting_fallback: src };
      }
    }
    // 翻译失败：回原文，不缓存，下次再试。
    return { ...row, greeting_zh: zh ?? null, _greeting_fallback: zh == null ? src : undefined };
  }

  /**
   * 取角色（必要时从 chub 拉取），并做 NSFW 检查与开场白翻译。
   * @param {string} path chub fullPath
   * @param {{user?:object, translate?:boolean}} opts
   */
  async function ensure(path, { user = null, translate = true, source = mirror ? 'local' : 'remote' } = {}) {
    if (!isValidChubPath(path)) throw new HttpError(400, '角色地址不正确');
    if (!['local','remote'].includes(source)) throw new HttpError(400,'角色来源不正确');
    let row = getRow(path);
    // 已缓存完整卡即使超过刷新期限也属于本地资料；默认浏览不回源。
    // 镜像的最新成人标记同样约束旧缓存，避免绕过列表过滤。
    if (mirror && user) mirror.assertAllowed(path,user);
    if (source === 'local') {
      const def = row && parseJson(row.card_json, null);
      if (!def || typeof def !== 'object' || Array.isArray(def) || !Object.keys(def).length) {
        if (!mirror) throw new HttpError(404,'本地没有找到这个角色');
        const local = mirror.character(path,user);
        row = storeNode(path,local.node,row,local);
      }
    } else if (!row || Date.now() - Date.parse(row.fetched_at) > REFRESH_MS) {
      try {
        row = await fetchAndStore(path, row);
      } catch (e) {
        if (!row) throw e; // 刷新失败但有旧缓存：用旧的
      }
    }
    const tags=parseJson(row.tags_json,[]);
    if (user && !user.nsfw_enabled && (row.nsfw || (Array.isArray(tags) && tags.some(t=>String(t).toUpperCase()==='NSFW'))))
      throw new HttpError(403, NSFW_FORBIDDEN);
    if (translate) row = await ensureGreetingZh(row, user);
    return row;
  }

  function greetingZhOf(row, user = null) {
    row = selectedRow(row,user);
    const def = parseJson(row.card_json, {});
    const zh = tr.zhOf(row);
    if (zh && typeof zh.first_message === 'string' && zh.first_message.trim()) return zh.first_message;
    if (row.greeting_zh != null && row.greeting_zh !== '') return row.greeting_zh;
    if (row._greeting_fallback) return row._greeting_fallback;
    return def.first_message || '';
  }

  /** 展示 / 聊天用的角色名：有中文名用中文名（契约 §19.2「角色名用中文名」）。 */
  function displayName(row, user = null) {
    row = selectedRow(row,user);
    const zh = tr.hasZh(row) ? row.name_zh : null;
    return (zh && zh.trim()) || row.name;
  }

  /**
   * 会话 / 列表里显示的名字与简介（契约 §19.2「角色名用中文名」「列表也要中文」）：
   * 翻译可用（ok / partial、源卡没变）时 name 给中文名，原名放 name_original；没有译文时 name_zh / tagline_zh 为 null。
   */
  function names(row, user = null) {
    row = selectedRow(row,user);
    const ok = tr.hasZh(row);
    const nz = ok && row.name_zh && row.name_zh.trim() ? row.name_zh.trim() : null;
    const tz = ok && row.tagline_zh && row.tagline_zh.trim() ? row.tagline_zh.trim() : null;
    return {
      name: nz || row.name,
      name_zh: nz,
      name_original: row.name,
      tagline: tz || row.tagline || '',
      tagline_zh: tz,
      tagline_original: row.tagline || '',
    };
  }

  /**
   * 提示词用的设定（契约 §19.2「聊天也用中文设定」）：card_json_zh（状态 ok / partial 且源卡没变）优先，否则原文。
   * @returns {{definition:object, charName:string, zh:boolean}}
   */
  function promptSource(row, user = null) {
    row = selectedRow(row,user);
    const zh = tr.zhOf(row);
    if (zh) return { definition: zh, charName: displayName(row), zh: true };
    return { definition: parseJson(row.card_json, {}) || {}, charName: row.name, zh: false };
  }

  /** V2 data 的文本字段做宏替换（展示用；世界书触发词不动）。 */
  function macroData(data, ctx) {
    if (!data) return null;
    const out = { ...data };
    for (const k of Object.keys(TEXT_FIELDS)) out[k] = applyMacros(out[k] || '', ctx);
    out.alternate_greetings = (out.alternate_greetings || []).map((g) => applyMacros(g, ctx));
    if (out.character_book?.entries) {
      out.character_book = { ...out.character_book, entries: out.character_book.entries.map((e) => ({ ...e, content: applyMacros(e.content, ctx) })) };
    }
    return out;
  }

  /**
   * 角色详情（契约 §19.1 / §19.2）：全部设定的原文（data）与译文（data_zh，没有则 null）+ 翻译状态。
   * data 用 V2 结构（与自建卡一致）：description=人物描述、personality=性格、scenario、first_mes、alternate_greetings、
   * mes_example、system_prompt、post_history_instructions、creator_notes、character_book{entries[{keys,content,enabled,constant,...}]}。
   */
  function detail(row, user) {
    const translationSourceHash = sourceHash(row);
    const history = translationHistory(row,user);
    const job = tr.translationJob?.(row,user) || { status: 'none', model_id: null, model_name: null };
    row = selectedRow(row,user);
    const def = parseJson(row.card_json, {});
    const zhDef = tr.zhOf(row);
    const ctx = { char: row.name, user: userCallName(user) };
    const zhName = zhDef ? (row.name_zh || row.name) : null;
    const ctxZh = { char: zhName || row.name, user: userCallName(user) };
    const tags = parseJson(row.tags_json, []);
    const tm = tr.tagMap(tags);
    const tagsZh = tags.map((t) => tm.get(String(t)) ?? String(t));
    if (tags.length && tags.every((t) => tm.has(String(t))) && row.tags_zh_json !== JSON.stringify(tagsZh)) {
      try { db.prepare('UPDATE characters SET tags_zh_json = ? WHERE id = ?').run(JSON.stringify(tagsZh), row.id); } catch { /* ignore */ }
    }
    const status = tr.statusOf(row);
    const data = macroData(chubDefinitionToData(def), ctx);
    const dataZh = zhDef ? macroData(chubDefinitionToData(zhDef), ctxZh) : null;
    const taglineZh = zhDef ? (row.tagline_zh ?? null) : null;
    return {
      path: row.chub_path,
      name: row.name,
      name_original: row.name,
      name_zh: zhName,
      tagline: row.tagline,
      tagline_zh: taglineZh,
      avatar: avatarProxyUrl(row.avatar_url),
      tags,
      tags_zh: tagsZh,
      nsfw: !!row.nsfw,
      greeting: applyMacros(def.first_message || '', ctx),
      greeting_zh: applyMacros(greetingZhOf(row), ctxZh),
      creator_notes: def.description || '',
      creator_notes_zh: dataZh ? dataZh.creator_notes : null,
      data,
      data_zh: dataZh,
      translate_status: job.status === 'pending' ? 'pending' : status, // none | pending | ok | partial | failed
      translating: job.status === 'pending' || status === 'pending',
      translated_at: row.translated_at || null,
      translation_history: history.items,
      translation_history_has_more: history.has_more,
      translation_history_next_before_id: history.next_before_id,
      selected_translation_id: history.selected_translation_id,
      selected_translation: history.selected_translation,
      default_translate_model_id: history.default_translate_model_id,
      translation_job: job,
      translation_source_hash: translationSourceHash,
    };
  }

  // 路由在ensure里做访问检查；同步服务方法也执行相同门禁，历史ID不构成访问授权。
  function assertTranslationAccess(row,user) {
    if (!row) throw new HttpError(404, '没有找到这个角色');
    if (mirror && user && row.chub_path) mirror.assertAllowed(row.chub_path,user);
    const tags = parseJson(row.tags_json,[]);
    if (user && !user.nsfw_enabled && (row.nsfw || (Array.isArray(tags) && tags.some(t => String(t).toUpperCase() === 'NSFW'))))
      throw new HttpError(403,NSFW_FORBIDDEN);
  }
  function selectedRow(row,user) {
    assertTranslationAccess(row,user);
    return tr.selectedRow?.(row,user) || row;
  }
  function translationHistory(row,user,options = {}) {
    assertTranslationAccess(row,user);
    return tr.translationHistory?.(row,user,options) || { items: [], selected_translation_id: null, selected_translation: null,
      default_translate_model_id: null, has_more: false, next_before_id: null };
  }
  function selectTranslation(row,user,id) {
    assertTranslationAccess(row,user);
    return tr.selectTranslation(row,user,id);
  }
  function manualTranslation(row,user,options) {
    assertTranslationAccess(row,user);
    return tr.manualTranslation(row,user,options);
  }

  /** 打开详情：后台开始整卡翻译（不等）。 */
  function kickTranslation(row, user) { tr.kick(row, { userId: user?.id ?? null }); return getRowById(row.id); }

  /**
   * 「重试翻译」（契约 §19.2：翻译失败显示原文并提供重试）：只对 failed / partial 强制重来（复用已翻好的叶子与译名表）；
   * 已经翻好（ok）的不重翻——全站共享的缓存，不能让任何人反复花钱、还可能把好译文换差；super 例外可强制。
   * 从没翻过 / 源卡变了 / 上次翻到一半进程重启（状态 none）按正常首翻处理。
   */
  function retryTranslation(row, user) {
    const st = tr.statusOf(row);
    const isSuper = user?.role === 'super';
    if (st === 'pending') return getRowById(row.id);
    if (st === 'none') { tr.start(row, { userId: user?.id ?? null })?.catch(() => {}); return getRowById(row.id); }
    if (st === 'ok' && !isSuper) return getRowById(row.id);
    tr.start(row, { userId: user?.id ?? null, force: true, unlimited: isSuper })?.catch(() => {});
    return getRowById(row.id);
  }

  /**
   * 新建会话用：拉角色（NSFW 检查）→ 有在途整卡翻译就等它（最多 15 秒）→ 还没有中文开场白就单独翻开场白。
   */
  async function ensureForChat(path, user, { source = mirror ? 'local' : 'remote' } = {}) {
    let row = await ensure(path, { user, translate: false, source });
    // 本地开聊使用已有译文或原文，主动翻译仍由详情的手动入口处理。
    if (source === 'local') return selectedRow(row,user);
    row = selectedRow(row,user);
    // 总预算从这里起算（拉 chub 详情另有自己的超时）：等整卡 + 单独翻开场白合计不超过 CHAT_TRANSLATE_BUDGET_MS
    const t0 = Date.now();
    tr.kick(row, { userId: user?.id ?? null });
    const p = tr.pendingOf(row);
    if (p) {
      let timer;
      await Promise.race([p.catch(() => null), new Promise((r) => { timer = setTimeout(r, Math.min(T.waitCard, T.budget)); timer.unref?.(); })]);
      clearTimeout(timer);
      row = getRowById(row.id) || row;
    }
    const def = parseJson(row.card_json, {});
    if (!tr.zhOf(row) && row.greeting_zh == null && needsTranslation(def.first_message || '')
        && tr.translationJob?.(row,user)?.status !== 'pending') {
      const left = Math.min(T.waitGreeting, T.budget - (Date.now() - t0));
      row = await ensureGreetingZh(row, user, { waitMs: left });
    }
    return selectedRow(row,user);
  }

  return { ensure, ensureForChat, detail, getRow, getRowById, greetingZhOf, displayName, names, promptSource, kickTranslation, retryTranslation, translations: tr,
    translationHistory, selectTranslation, manualTranslation, selectedRow };
}
