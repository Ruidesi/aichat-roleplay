// 本会话设定（契约 §20.1）：中途修改角色的全部信息 + 本会话专用的「我的称呼与人设」。
// GET /api/chats/:id/settings → {base, override, persona}；PATCH 同址 {override, persona[, save_to_card]}；DELETE 恢复原设定。
// override 只放与原卡不同的字段（同构于 V2 data）；persona 与「我的」页默认一致时传 null。
import { zh } from '/i18n/zh.js';
import { get, patch, del } from '/js/api.js';
import { store } from '/js/store.js';
import { esc } from '/js/util.js';
import { icon, openSheet, spinnerHtml, confirmDialog, toast, toastError } from '/js/ui.js';
import { loadCard } from '/js/cards.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : typeof v === 'string' ? v : String(v));
const truthy = (v) => v === true || v === 1 || v === '1';

// chub definition 字段名 → V2 data（base 万一按 chub 命名返回时也能用）
function toV2(o) {
  if (!isObj(o)) return {};
  if (isObj(o.data) && !('description' in o)) o = { ...o.data, name: o.name ?? o.data.name };
  if (!('first_message' in o || 'example_dialogs' in o || 'tavern_personality' in o || 'embedded_lorebook' in o)) return { ...o };
  return {
    ...o,
    description: o.personality ?? '',
    personality: o.tavern_personality ?? '',
    mes_example: o.example_dialogs ?? '',
    character_book: o.character_book ?? o.embedded_lorebook ?? null,
  };
}

function bookEntries(book) {
  if (!isObj(book)) return [];
  let list = book.entries;
  if (isObj(list)) list = Object.values(list);
  return Array.isArray(list) ? list.filter(isObj) : [];
}
const keysOf = (e) => (Array.isArray(e.keys) ? e.keys.map(str) : typeof e.keys === 'string' ? e.keys.split(/[,，、]/) : []).map((s) => s.trim()).filter(Boolean);
// 只比较用户能在面板里改的部分
const projBook = (book) => JSON.stringify(bookEntries(book).map((e) => ({ k: keysOf(e), c: str(e.content), on: !(e.enabled === false), cst: truthy(e.constant) })));

/** 打开面板。opts: {chatId, character, chatInfo, onSaved({name, reset})} */
export async function openChatSettings({ chatId, character = {}, chatInfo = null, onSaved }) {
  const T = zh.chatset;
  const url = '/api/chats/' + encodeURIComponent(chatId) + '/settings';
  const s = openSheet(`<div class="sheet-title">${esc(T.title)}</div><div data-ss-body>${spinnerHtml()}<p class="muted small" style="text-align:center">${esc(T.loading)}</p></div>`, { label: T.title });
  s.el.classList.add('ss-sheet');
  const body = s.el.querySelector('[data-ss-body]');

  let r;
  try {
    r = await get(url);
  } catch (e) {
    if (!s.el.isConnected) return;
    body.innerHTML = `<div class="empty" style="padding:24px 8px"><div class="empty-title">${esc(e.message || T.load_failed)}</div><button class="btn btn-sm" data-close>${esc(zh.close)}</button></div>`;
    body.querySelector('[data-close]').onclick = () => s.close();
    return;
  }
  if (!s.el.isConnected) return;

  const base = toV2(r.base);
  const ov = toV2(r.override);
  const kind = str(r.kind || (chatInfo && chatInfo.kind) || '');
  const isFile = kind === 'file' || ('instruction' in base && !('description' in base));
  const isScn = kind === 'scenario' || base.kind === 'scenario' || character.kind === 'scenario';
  if (!('name' in base)) base.name = str(character.name);

  const FIELDS = isFile
    ? [{ k: 'instruction', rows: 3 }, { k: 'system_prompt', rows: 4 }, { k: 'post_history_instructions', rows: 3 }].filter((f) => f.k === 'instruction' || f.k in base || f.k in ov)
    : [
      { k: 'name', rows: 0 },
      { k: 'description', rows: 6 },
      { k: 'personality', rows: 4 },
      { k: 'scenario', rows: 4 },
      { k: 'mes_example', rows: 5 },
      { k: 'system_prompt', rows: 4 },
      { k: 'post_history_instructions', rows: 3 },
    ];
  const label = (k) => (k === 'description' && isScn ? T.description_scenario : T[k] || k);
  const eff = (k) => str(k in ov ? ov[k] : base[k]);

  // 我的称呼与人设：本会话专用；默认取「我的」页
  const me = store.me || {};
  const pDef0 = isObj(r.persona_base) ? r.persona_base : isObj(r.persona_default) ? r.persona_default : null;
  const pDef = { name: str(pDef0 ? (pDef0.name ?? pDef0.persona_name) : me.persona_name), desc: str(pDef0 ? (pDef0.desc ?? pDef0.persona_desc ?? pDef0.description) : me.persona_desc) };
  const pv = isObj(r.persona) ? r.persona : null;
  const pCur = pv ? { name: str(pv.name ?? pv.persona_name), desc: str(pv.desc ?? pv.persona_desc ?? pv.description) } : { ...pDef };

  // 世界书（只有角色会话）
  const bookBase = isObj(base.character_book) ? base.character_book : null;
  const bookEff = 'character_book' in ov ? (isObj(ov.character_book) ? ov.character_book : null) : bookBase;
  let entries = bookEntries(bookEff).map((e) => ({ raw: e, keys: keysOf(e).join(', '), content: str(e.content), enabled: !(e.enabled === false), constant: truthy(e.constant) }));

  // 能否「同时保存到我的卡片」：后端给标记就用；否则自建卡会话查一下卡的作者
  let canSaveCard = truthy(r.can_save_to_card ?? r.is_card_owner ?? r.card_owner);
  const ucId = (chatInfo && chatInfo.user_card_id) ?? character.user_card_id ?? null;
  if (!('can_save_to_card' in r) && !('is_card_owner' in r) && !('card_owner' in r) && ucId != null && ucId !== '' && !isFile) {
    try { const c = await loadCard(ucId); canSaveCard = !!c.mine; } catch { canSaveCard = false; }
    if (!s.el.isConnected) return;
  }
  const hasOverride = Object.keys(ov).length > 0 || !!pv;

  body.innerHTML = `
    <p class="ss-lead">${esc(isFile ? T.lead_file : T.lead)}</p>
    <button class="btn btn-sm ss-restore" type="button" data-restore ${hasOverride ? '' : 'disabled'}>${icon('history')}<span>${esc(isFile ? T.restore_file : T.restore)}</span></button>
    <form class="ss-form" novalidate>
      ${isFile ? '' : `<h3 class="ss-sec">${esc(T.sec_character)}</h3>`}
      ${FIELDS.map((f) => `<div class="field ss-field" data-f="${f.k}">
        <div class="ss-label"><label for="ss-${f.k}">${esc(label(f.k))}</label><span class="ss-mod" hidden>${esc(T.modified)}</span></div>
        ${f.rows ? `<textarea id="ss-${f.k}" class="textarea" rows="${f.rows}" data-k="${f.k}"></textarea>` : `<input id="ss-${f.k}" class="input" data-k="${f.k}" autocomplete="off" maxlength="120">`}
      </div>`).join('')}
      ${isFile ? '' : `<div class="ss-book" data-book>
        <div class="ss-label"><span class="label">${esc(T.lorebook)}</span><span class="ss-mod" data-book-mod hidden>${esc(T.modified)}</span></div>
        <div data-entries></div>
        <button class="btn btn-sm" type="button" data-add-entry>${icon('plus')}<span>${esc(T.lore_add)}</span></button>
      </div>`}
      <h3 class="ss-sec">${esc(T.sec_me)}</h3>
      <p class="hint ss-hint">${esc(T.sec_me_hint)}</p>
      <div class="field ss-field" data-p="name"><div class="ss-label"><label for="ss-p-name">${esc(T.persona_name)}</label><span class="ss-mod" hidden>${esc(T.modified)}</span></div><input id="ss-p-name" class="input" data-pk="name" autocomplete="off" maxlength="40"></div>
      <div class="field ss-field" data-p="desc"><div class="ss-label"><label for="ss-p-desc">${esc(T.persona_desc)}</label><span class="ss-mod" hidden>${esc(T.modified)}</span></div><textarea id="ss-p-desc" class="textarea" rows="3" data-pk="desc" maxlength="2000"></textarea></div>
      ${canSaveCard ? `<label class="ss-check"><input type="checkbox" data-save-card><span><b>${esc(T.save_to_card)}</b><small>${esc(T.save_to_card_hint)}</small></span></label>` : ''}
      <p class="form-error" data-err role="alert"></p>
      <div class="sheet-actions ss-foot">
        <button class="btn" type="button" data-cancel>${esc(zh.cancel)}</button>
        <button class="btn btn-primary" type="submit" data-save>${esc(T.save)}</button>
      </div>
    </form>`;

  const form = body.querySelector('form');
  const errEl = body.querySelector('[data-err]');
  FIELDS.forEach((f) => { body.querySelector(`[data-k="${f.k}"]`).value = eff(f.k); });
  body.querySelector('[data-pk="name"]').value = pCur.name;
  body.querySelector('[data-pk="desc"]').value = pCur.desc;

  /* ---------- 世界书条目 ---------- */
  const entWrap = body.querySelector('[data-entries]');
  function drawEntries() {
    if (!entWrap) return;
    entWrap.innerHTML = entries.length ? entries.map((e, i) => `<div class="ss-entry" data-i="${i}">
      <div class="ss-entry-head"><b>${esc(T.lore_entry(i + 1))}</b><button class="icon-btn" type="button" data-rm aria-label="${esc(T.lore_remove)}" title="${esc(T.lore_remove)}">${icon('trash')}</button></div>
      <div class="field"><label for="ss-ek-${i}">${esc(T.lore_keys)}</label><input id="ss-ek-${i}" class="input" data-ek autocomplete="off"></div>
      <div class="field"><label for="ss-ec-${i}">${esc(T.lore_content)}</label><textarea id="ss-ec-${i}" class="textarea" rows="3" data-ec></textarea></div>
      <div class="ss-entry-flags">
        <label class="ss-flag"><input type="checkbox" data-een ${e.enabled ? 'checked' : ''}><span>${esc(T.lore_enabled)}</span></label>
        <label class="ss-flag"><input type="checkbox" data-ecst ${e.constant ? 'checked' : ''}><span>${esc(T.lore_constant)}</span></label>
      </div>
    </div>`).join('') : `<p class="muted small">${esc(T.lore_empty)}</p>`;
    entWrap.querySelectorAll('.ss-entry').forEach((row) => {
      const e = entries[+row.dataset.i];
      row.querySelector('[data-ek]').value = e.keys;
      row.querySelector('[data-ec]').value = e.content;
    });
  }
  if (entWrap) {
    drawEntries();
    entWrap.addEventListener('input', (ev) => {
      const row = ev.target.closest('.ss-entry');
      if (!row) return;
      const e = entries[+row.dataset.i];
      if (ev.target.matches('[data-ek]')) e.keys = ev.target.value;
      else if (ev.target.matches('[data-ec]')) e.content = ev.target.value;
      markDirty();
    });
    entWrap.addEventListener('change', (ev) => {
      const row = ev.target.closest('.ss-entry');
      if (!row) return;
      const e = entries[+row.dataset.i];
      if (ev.target.matches('[data-een]')) e.enabled = ev.target.checked;
      else if (ev.target.matches('[data-ecst]')) e.constant = ev.target.checked;
      markDirty();
    });
    entWrap.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-rm]');
      if (!b) return;
      entries.splice(+b.closest('.ss-entry').dataset.i, 1);
      drawEntries();
      markDirty();
    });
    body.querySelector('[data-add-entry]').onclick = () => {
      entries.push({ raw: {}, keys: '', content: '', enabled: true, constant: false });
      drawEntries();
      markDirty();
      const last = entWrap.querySelector('.ss-entry:last-child [data-ek]');
      if (last) last.focus();
    };
  }

  function currentBook() {
    const list = entries.map((e, i) => ({
      ...e.raw,
      keys: e.keys.split(/[,，、]/).map((x) => x.trim()).filter(Boolean),
      content: e.content,
      enabled: e.enabled,
      constant: e.constant,
      insertion_order: Number.isFinite(Number(e.raw.insertion_order)) ? Number(e.raw.insertion_order) : (i + 1) * 10,
    }));
    return { ...(bookBase || {}), entries: list };
  }

  /* ---------- 改动标记 + 计算 override ---------- */
  function collect() {
    const override = {};
    for (const f of FIELDS) {
      const v = body.querySelector(`[data-k="${f.k}"]`).value;
      if (v !== str(base[f.k])) override[f.k] = v;
    }
    if (entWrap) {
      const nb = currentBook();
      if (projBook(nb) !== projBook(bookBase)) override.character_book = nb;
    }
    const pn = body.querySelector('[data-pk="name"]').value;
    const pd = body.querySelector('[data-pk="desc"]').value;
    const persona = pn === pDef.name && pd === pDef.desc ? null : { name: pn, desc: pd };
    return { override, persona };
  }
  function markDirty() {
    const { override } = collect();
    FIELDS.forEach((f) => { body.querySelector(`[data-f="${f.k}"] .ss-mod`).hidden = !(f.k in override); });
    const bm = body.querySelector('[data-book-mod]');
    if (bm) bm.hidden = !('character_book' in override);
    body.querySelector('[data-p="name"] .ss-mod').hidden = body.querySelector('[data-pk="name"]').value === pDef.name;
    body.querySelector('[data-p="desc"] .ss-mod').hidden = body.querySelector('[data-pk="desc"]').value === pDef.desc;
    errEl.textContent = '';
  }
  form.addEventListener('input', (ev) => { if (!ev.target.closest('.ss-entry')) markDirty(); });
  markDirty();
  const startState = JSON.stringify(collect());

  body.querySelector('[data-cancel]').onclick = () => s.close();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const { override, persona } = collect();
    const saveCard = !!(body.querySelector('[data-save-card]') && body.querySelector('[data-save-card]').checked);
    if (!isFile && 'name' in override && !override.name.trim()) {
      errEl.textContent = T.name_required;
      body.querySelector('[data-k="name"]').focus();
      return;
    }
    if (JSON.stringify({ override, persona }) === startState && !saveCard) { toast(T.no_change); return; }
    const btn = body.querySelector('[data-save]');
    btn.disabled = true;
    btn.textContent = T.saving;
    try {
      const payload = { override, persona };
      if (saveCard) payload.save_to_card = true;
      await patch(url, payload);
      s.close();
      onSaved && onSaved({ name: isFile ? '' : str('name' in override ? override.name : base.name), reset: false, savedToCard: saveCard });
    } catch (e) {
      errEl.textContent = (e && e.message) || zh.network_error;
      btn.disabled = false;
      btn.textContent = T.save;
    }
  });

  body.querySelector('[data-restore]').onclick = async () => {
    if (!await confirmDialog(T.restore_confirm, { title: isFile ? T.restore_file : T.restore, ok: zh.confirm })) return;
    try {
      await del(url);
      s.close();
      onSaved && onSaved({ name: isFile ? '' : str(base.name), reset: true });
    } catch (e) { toastError(e); }
  };
}
