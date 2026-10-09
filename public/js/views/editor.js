// 卡片编辑器（契约 §12.5）：基本信息 / 设定 / 世界书 / 高级，实时字数，保存、试聊
// 路由：#/cards/new?kind=character|scenario（新建）、#/cards/<id>/edit（编辑自己的卡）
import { zh } from '/i18n/zh.js';
import { post, patch, ApiError } from '/js/api.js';
import { store } from '/js/store.js';
import { esc, initial } from '/js/util.js';
import { icon, spinnerHtml, errorHtml, menu, toast, toastError, confirmDialog } from '/js/ui.js';
import { setLeaveGuard, noteHashReplaced } from '/js/app.js';
import {
  normCard, loadCard, cardHref, editHref, forkLineHtml, startCardChat, exportCard, deleteCard,
  uploadAvatar, AVATAR_TYPES, AVATAR_MAX,
} from '/js/cards.js';

// 字段上限以后端 server/cards.mjs 的 TEXT_FIELDS / LIMITS 为准，逐字段对应（契约 v0.9 F1）
const LIM = {
  name: 60, tagline: 200, tag: 30, tags: 20,
  description: 30000, personality: 8000, scenario: 8000, first_mes: 10000, mes_example: 12000,
  system_prompt: 8000, post_history_instructions: 8000, creator_notes: 8000,
  greeting: 10000, greetings: 20, entryContent: 20000, key: 100, keys: 50,
};
// 触发词输入框是一整行（逗号分隔），上限 = 最多 50 个 × 每个 100 字 + 分隔符
const KEYS_INPUT_MAX = LIM.keys * (LIM.key + 2);
const len = (s) => [...String(s || '')].length;
const splitKeys = (s) => String(s || '').split(/[,，、\n]/).map((x) => x.trim()).filter(Boolean);
const clampKeys = (arr) => arr.map((k) => k.slice(0, LIM.key)).slice(0, LIM.keys);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** 字段：label + 输入 + 帮助 + 实时字数 */
function fieldHtml({ id, key, label, hint, rows = 0, max, value = '', required = false }) {
  const input = rows
    ? `<textarea id="${id}" class="textarea" data-f="${key}" rows="${rows}" maxlength="${max}"${hint ? ` aria-describedby="${id}-h"` : ''}>${esc(value)}</textarea>`
    : `<input id="${id}" class="input" data-f="${key}" maxlength="${max}" value="${esc(value)}" autocomplete="off"${required ? ' required aria-required="true"' : ''}${hint ? ` aria-describedby="${id}-h"` : ''}>`;
  return `<div class="field ed-field">
    <div class="ed-label"><label for="${id}">${esc(label)}</label><span class="ed-count" data-count="${key}" aria-hidden="true">${esc(zh.chars_count(len(value)))}</span></div>
    ${input}
    ${hint ? `<span class="hint" id="${id}-h">${esc(hint)}</span>` : ''}
    <div class="form-error" data-err="${key}" role="alert"></div>
  </div>`;
}

export default async function editor(ctx) {
  const { root, params, query, setTitle, navigate } = ctx;
  const E = zh.editor;
  let id = params[0] != null ? decodeURIComponent(params[0]) : null;

  root.innerHTML = `<div class="page page-narrow">${spinnerHtml()}</div>`;
  const page = root.firstElementChild;

  let card;
  if (id != null) {
    try {
      card = await loadCard(id);
    } catch (e) {
      if (!ctx.isActive()) return;
      page.innerHTML = errorHtml(e.status === 404 || e.status === 403 ? zh.ucard.not_found : e.message);
      const b = page.querySelector('[data-retry]');
      if (e.status === 404 || e.status === 403) { b.textContent = zh.back; b.onclick = () => navigate('#/create'); } else b.onclick = () => editor(ctx);
      return;
    }
    if (!ctx.isActive()) return;
    if (!card.mine) {
      page.innerHTML = `<div class="empty"><div class="empty-title">${esc(E.not_owner)}</div><a class="btn btn-sm" href="${cardHref(card.id)}">${esc(zh.create.menu_view)}</a></div>`;
      return;
    }
  } else {
    card = normCard({ kind: query.get('kind') === 'scenario' ? 'scenario' : 'character', visibility: 'private' });
  }

  const kind = card.kind;
  const isScn = kind === 'scenario';
  const D = isObj(card.data) ? { ...card.data } : {};
  const origBook = isObj(D.character_book) ? D.character_book : {};
  let alts = Array.isArray(D.alternate_greetings) ? D.alternate_greetings.map((x) => String(x ?? '')) : [];
  let entries = (Array.isArray(origBook.entries) ? origBook.entries : []).map((e, i) => ({
    ...(isObj(e) ? e : {}),
    _keys: (Array.isArray(e && e.keys) ? e.keys : []).join(', '),
    content: String((e && e.content) || ''),
    enabled: !(e && e.enabled === false),
    constant: !!(e && e.constant),
    case_sensitive: !!(e && e.case_sensitive),
    insertion_order: Number.isFinite(Number(e && e.insertion_order)) ? Number(e.insertion_order) : (i + 1) * 10,
    _open: false,
  }));
  let tags = card.tags.slice(0, LIM.tags);
  let pendingAvatar = null; // 新卡还没保存时选的头像
  let avatarUrl = card.avatar;
  let objUrl = '';

  const titleText = () => (id == null ? E.title_new[kind] : E.title_edit);
  setTitle(titleText());

  page.innerHTML = `
    <div class="ed-head">
      <button class="icon-btn" type="button" data-back aria-label="${esc(zh.back)}">${icon('back')}</button>
      <div class="ed-head-main">
        <h1 class="ed-title" data-title>${esc(titleText())}</h1>
        <div class="ed-sub"><span class="badge kind-${kind}">${esc(zh.kinds[kind])}</span><span class="ed-dirty" data-dirty hidden>${esc(E.unsaved)}</span></div>
      </div>
      <button class="icon-btn" type="button" data-more aria-label="${esc(E.more)}" ${id == null ? 'hidden' : ''}>${icon('more')}</button>
    </div>
    ${card.fork ? forkLineHtml(card.fork) : ''}
    <nav class="ed-nav" aria-label="${esc(E.sections_label)}">
      <a class="chip" href="#ed-basic" data-jump="ed-basic">${esc(E.sec_basic)}</a>
      <a class="chip" href="#ed-setting" data-jump="ed-setting">${esc(E.sec_setting)}</a>
      <a class="chip" href="#ed-book" data-jump="ed-book">${esc(E.sec_book)}<span class="chip-count" data-book-count></span></a>
      <a class="chip" href="#ed-adv" data-jump="ed-adv">${esc(E.sec_advanced)}</a>
    </nav>
    <form class="ed-form" novalidate>
      <section class="panel panel-pad ed-sec" id="ed-basic" aria-labelledby="ed-basic-t">
        <h2 class="ed-sec-title" id="ed-basic-t">${esc(E.sec_basic)}</h2>
        <div class="ed-avatar-row">
          <div class="ed-avatar" data-avatar></div>
          <div class="ed-avatar-side">
            <span class="label">${esc(E.avatar)}</span>
            <label class="btn btn-sm ed-upload">${icon('upload')}<span data-avatar-label>${esc(avatarUrl ? E.avatar_change : E.avatar_upload)}</span><input type="file" accept="image/png,image/jpeg,image/webp" data-avatar-input class="sr-only"></label>
            <span class="hint" data-avatar-hint>${esc(E.avatar_hint)}</span>
          </div>
        </div>
        ${fieldHtml({ id: 'ed-name', key: 'name', label: E.name, hint: isScn ? E.name_scenario_hint : E.name_hint, max: LIM.name, value: card.name, required: true })}
        ${fieldHtml({ id: 'ed-tagline', key: 'tagline', label: E.tagline, hint: E.tagline_hint, max: LIM.tagline, value: card.tagline })}
        <div class="field ed-field">
          <div class="ed-label"><label for="ed-tag-in">${esc(E.tags)}</label><span class="ed-count" data-tag-count aria-hidden="true"></span></div>
          <div class="tag-editor" data-tags>
            <span class="tag-list" data-tag-list></span>
            <input id="ed-tag-in" class="tag-input" maxlength="${LIM.tag}" autocomplete="off" enterkeyhint="done" aria-describedby="ed-tag-h">
          </div>
          <span class="hint" id="ed-tag-h">${esc(E.tags_hint)}</span>
        </div>
        ${fieldHtml({ id: 'ed-notes', key: 'creator_notes', label: E.creator_notes, hint: E.creator_notes_hint, rows: 3, max: LIM.creator_notes, value: D.creator_notes || '' })}
        <label class="row ed-switch-row" for="ed-nsfw">
          <div class="row-main"><div class="row-title">${esc(E.nsfw)}</div><div class="row-sub wrap">${esc(E.nsfw_hint)}</div></div>
          <span class="switch"><input id="ed-nsfw" type="checkbox" role="switch" data-f="nsfw"${card.nsfw ? ' checked' : ''}><span></span></span>
        </label>
        <div class="field ed-vis">
          <span class="label" id="ed-vis-l">${esc(E.visibility)}</span>
          <div class="seg" role="radiogroup" aria-labelledby="ed-vis-l">
            ${['private', 'public'].map((v) => `<label class="seg-opt"><input type="radio" name="visibility" value="${v}"${card.visibility === v ? ' checked' : ''}><span>${icon(v === 'private' ? 'lock' : 'globe')}${esc(zh.visibility[v])}</span></label>`).join('')}
          </div>
          <span class="hint" data-vis-hint></span>
        </div>
      </section>

      <section class="panel panel-pad ed-sec" id="ed-setting" aria-labelledby="ed-setting-t">
        <h2 class="ed-sec-title" id="ed-setting-t">${esc(E.sec_setting)}</h2>
        ${fieldHtml({ id: 'ed-desc', key: 'description', label: isScn ? E.description_scenario : E.description, hint: isScn ? E.description_scenario_hint : E.description_hint, rows: 8, max: LIM.description, value: D.description || '' })}
        ${fieldHtml({ id: 'ed-pers', key: 'personality', label: E.personality, hint: E.personality_hint, rows: 3, max: LIM.personality, value: D.personality || '' })}
        ${fieldHtml({ id: 'ed-scn', key: 'scenario', label: E.scenario, hint: E.scenario_hint, rows: 3, max: LIM.scenario, value: D.scenario || '' })}
        ${fieldHtml({ id: 'ed-first', key: 'first_mes', label: E.first_mes, hint: E.first_mes_hint, rows: 5, max: LIM.first_mes, value: D.first_mes || '' })}
        <div class="field ed-field">
          <span class="label">${esc(E.alt_greetings)}</span>
          <span class="hint">${esc(E.alt_greetings_hint)}</span>
          <div class="ed-alts" data-alts></div>
          <button class="btn btn-sm ed-add" type="button" data-alt-add>${icon('plus')}<span>${esc(E.alt_add)}</span></button>
        </div>
        ${fieldHtml({ id: 'ed-ex', key: 'mes_example', label: E.mes_example, hint: E.mes_example_hint, rows: 5, max: LIM.mes_example, value: D.mes_example || '' })}
      </section>

      <section class="panel panel-pad ed-sec" id="ed-book" aria-labelledby="ed-book-t">
        <h2 class="ed-sec-title" id="ed-book-t">${icon('book')}${esc(E.sec_book)}</h2>
        <p class="hint ed-sec-hint">${esc(E.book_hint)}</p>
        <div class="book-list" data-book></div>
        <button class="btn btn-sm ed-add" type="button" data-book-add>${icon('plus')}<span>${esc(E.book_add)}</span></button>
      </section>

      <section class="panel panel-pad ed-sec" id="ed-adv" aria-labelledby="ed-adv-t">
        <h2 class="ed-sec-title" id="ed-adv-t">${esc(E.sec_advanced)}</h2>
        <p class="hint ed-sec-hint">${esc(E.advanced_hint)}</p>
        ${fieldHtml({ id: 'ed-sys', key: 'system_prompt', label: E.system_prompt, hint: E.system_prompt_hint, rows: 4, max: LIM.system_prompt, value: D.system_prompt || '' })}
        ${fieldHtml({ id: 'ed-phi', key: 'post_history_instructions', label: E.post_history, hint: E.post_history_hint, rows: 3, max: LIM.post_history_instructions, value: D.post_history_instructions || '' })}
      </section>
    </form>
    <div class="ed-bar">
      <span class="ed-total" data-total aria-live="off"></span>
      <button class="btn btn-secondary" type="button" data-try title="${esc(E.try_chat_hint)}">${icon('chat_bubble')}<span>${esc(E.try_chat)}</span></button>
      <button class="btn btn-primary" type="button" data-save>${icon('check')}<span>${esc(E.save)}</span></button>
    </div>`;

  const form = page.querySelector('.ed-form');
  const $f = (k) => form.querySelector(`[data-f="${k}"]`);
  const saveBtn = page.querySelector('[data-save]');
  const tryBtn = page.querySelector('[data-try]');
  const moreBtn = page.querySelector('[data-more]');

  /* ---------- 头像 ---------- */
  const avBox = page.querySelector('[data-avatar]');
  const avHint = page.querySelector('[data-avatar-hint]');
  const avLabel = page.querySelector('[data-avatar-label]');
  const drawAvatar = () => {
    const src = objUrl || avatarUrl;
    const nm = ($f('name') && $f('name').value) || card.name;
    avBox.innerHTML = src ? `<img src="${esc(src)}" alt="" data-fallback="${esc(initial(nm))}">` : `<div class="avatar-fallback">${esc(initial(nm))}</div>`;
    avLabel.textContent = src ? E.avatar_change : E.avatar_upload;
  };
  drawAvatar();
  const avInput = page.querySelector('[data-avatar-input]');
  avInput.addEventListener('change', async () => {
    const f = avInput.files && avInput.files[0];
    avInput.value = '';
    if (!f) return;
    if (!AVATAR_TYPES.includes(f.type)) { toast(E.avatar_bad_type, 'error'); return; }
    if (f.size > AVATAR_MAX) { toast(E.avatar_too_big, 'error'); return; }
    if (objUrl) URL.revokeObjectURL(objUrl);
    objUrl = URL.createObjectURL(f);
    drawAvatar();
    if (id == null) {
      pendingAvatar = f;
      avHint.textContent = E.avatar_pending;
      return;
    }
    await doUpload(f);
  });
  async function doUpload(f) {
    avHint.textContent = E.avatar_uploading;
    try {
      const r = await uploadAvatar(id, f);
      if (r.avatar) avatarUrl = r.avatar;
      pendingAvatar = null;
      avHint.textContent = E.avatar_hint;
      toast(E.avatar_done);
      store.homeCache = null;
    } catch (e) {
      avHint.textContent = E.avatar_hint;
      if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = ''; }
      drawAvatar();
      toastError(e);
    }
  }
  ctx.onCleanup(() => { if (objUrl) URL.revokeObjectURL(objUrl); });

  /* ---------- 标签 ---------- */
  const tagList = page.querySelector('[data-tag-list]');
  const tagIn = page.querySelector('#ed-tag-in');
  const drawTags = () => {
    tagList.innerHTML = tags.map((t, i) => `<span class="tag-pill">${esc(t)}<button type="button" data-tag-rm="${i}" aria-label="${esc(E.tag_remove(t))}">${icon('x')}</button></span>`).join('');
    page.querySelector('[data-tag-count]').textContent = `${tags.length}/${LIM.tags}`;
    tagIn.hidden = tags.length >= LIM.tags;
    tagIn.setAttribute('aria-label', E.tag_input);
  };
  const addTags = (raw) => {
    for (const t of splitKeys(raw)) {
      const v = [...t].slice(0, LIM.tag).join('');
      if (tags.length >= LIM.tags) break;
      if (!tags.some((x) => x.toLowerCase() === v.toLowerCase())) tags.push(v);
    }
    drawTags();
    changed();
  };
  tagIn.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      if (tagIn.value.trim()) { addTags(tagIn.value); tagIn.value = ''; }
    } else if (e.key === 'Backspace' && !tagIn.value && tags.length) {
      tags.pop(); drawTags(); changed();
    }
  });
  tagIn.addEventListener('input', () => {
    if (/[,，、]/.test(tagIn.value)) { addTags(tagIn.value); tagIn.value = ''; }
  });
  tagIn.addEventListener('blur', () => { if (tagIn.value.trim()) { addTags(tagIn.value); tagIn.value = ''; } });
  tagList.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag-rm]');
    if (!b) return;
    tags.splice(+b.dataset.tagRm, 1);
    drawTags();
    changed();
    tagIn.focus();
  });
  page.querySelector('[data-tags]').addEventListener('click', (e) => { if (e.target === e.currentTarget || e.target === tagList) tagIn.focus(); });
  drawTags();

  /* ---------- 可见性 ---------- */
  const visHint = page.querySelector('[data-vis-hint]');
  const visVal = () => (form.querySelector('input[name="visibility"]:checked') || {}).value || 'private';
  const syncVis = () => { visHint.textContent = visVal() === 'public' ? E.vis_public_hint : E.vis_private_hint; };
  syncVis();

  /* ---------- 备选开场白 ---------- */
  const altBox = page.querySelector('[data-alts]');
  const drawAlts = () => {
    altBox.innerHTML = alts.map((a, i) => `<div class="ed-alt">
      <div class="ed-label"><label for="ed-alt-${i}">${esc(E.alt_item(i + 1))}</label><span class="ed-count" data-alt-count="${i}" aria-hidden="true">${esc(zh.chars_count(len(a)))}</span>
        <button class="icon-btn ed-rm" type="button" data-alt-rm="${i}" aria-label="${esc(E.alt_remove)}" title="${esc(E.alt_remove)}">${icon('trash')}</button></div>
      <textarea id="ed-alt-${i}" class="textarea" rows="3" maxlength="${LIM.greeting}" data-alt="${i}">${esc(a)}</textarea>
    </div>`).join('');
    // 备选开场白最多 20 条（后端 LIMITS.greetings）
    const addBtn = page.querySelector('[data-alt-add]');
    if (addBtn) addBtn.hidden = alts.length >= LIM.greetings;
  };
  drawAlts();
  altBox.addEventListener('input', (e) => {
    const t = e.target.closest('[data-alt]');
    if (!t) return;
    const i = +t.dataset.alt;
    alts[i] = t.value;
    const c = altBox.querySelector(`[data-alt-count="${i}"]`);
    if (c) c.textContent = zh.chars_count(len(t.value));
    changed();
  });
  altBox.addEventListener('click', (e) => {
    const b = e.target.closest('[data-alt-rm]');
    if (!b) return;
    alts.splice(+b.dataset.altRm, 1);
    drawAlts();
    changed();
  });
  page.querySelector('[data-alt-add]').onclick = () => {
    if (alts.length >= LIM.greetings) return;
    alts.push('');
    drawAlts();
    const t = altBox.querySelector(`[data-alt="${alts.length - 1}"]`);
    if (t) t.focus();
  };

  /* ---------- 世界书 ---------- */
  const bookBox = page.querySelector('[data-book]');
  const bookCount = page.querySelector('[data-book-count]');
  const entryHead = (e, i) => {
    const ks = splitKeys(e._keys);
    return `${esc(E.entry_title(i + 1))} · ${esc(e.constant ? E.entry_constant : (ks.length ? ks.slice(0, 4).join('、') : E.entry_untitled))}`;
  };
  const drawBook = () => {
    bookCount.textContent = entries.length ? ` ${entries.length}` : '';
    if (!entries.length) { bookBox.innerHTML = `<p class="muted small book-empty">${esc(E.book_empty)}</p>`; return; }
    bookBox.innerHTML = entries.map((e, i) => `<details class="book-entry${e.enabled ? '' : ' off'}" data-i="${i}"${e._open ? ' open' : ''}>
      <summary class="book-head"><span class="book-head-t" data-head="${i}">${entryHead(e, i)}</span><span class="ed-count" data-ec="${i}">${esc(zh.chars_count(len(e.content)))}</span></summary>
      <div class="book-body">
        <div class="field">
          <label for="be-k-${i}">${esc(E.entry_keys)}</label>
          <input id="be-k-${i}" class="input" data-e="_keys" maxlength="${KEYS_INPUT_MAX}" value="${esc(e._keys)}" autocomplete="off" aria-describedby="be-k-h-${i}">
          <span class="hint" id="be-k-h-${i}">${esc(E.entry_keys_hint)}</span>
        </div>
        <div class="field">
          <label for="be-c-${i}">${esc(E.entry_content)}</label>
          <textarea id="be-c-${i}" class="textarea" rows="4" data-e="content" maxlength="${LIM.entryContent}">${esc(e.content)}</textarea>
        </div>
        <div class="book-flags">
          <label class="book-flag"><span>${esc(E.entry_enabled)}</span><span class="switch"><input type="checkbox" role="switch" data-e="enabled"${e.enabled ? ' checked' : ''}><span></span></span></label>
          <label class="book-flag" title="${esc(E.entry_constant_hint)}"><span>${esc(E.entry_constant)}</span><span class="switch"><input type="checkbox" role="switch" data-e="constant"${e.constant ? ' checked' : ''} aria-describedby="be-cst-${i}"><span></span></span></label>
          <label class="book-flag"><span>${esc(E.entry_case)}</span><span class="switch"><input type="checkbox" role="switch" data-e="case_sensitive"${e.case_sensitive ? ' checked' : ''}><span></span></span></label>
          <label class="book-flag book-order"><span>${esc(E.entry_order)}</span><input class="input" type="number" inputmode="numeric" step="1" data-e="insertion_order" value="${esc(e.insertion_order)}" title="${esc(E.entry_order_hint)}"></label>
        </div>
        <span class="hint" id="be-cst-${i}">${esc(E.entry_constant_hint)} ${esc(E.entry_order_hint)}</span>
        <div class="book-foot"><button class="btn btn-sm btn-danger" type="button" data-e-rm>${icon('trash')}<span>${esc(E.entry_remove)}</span></button></div>
      </div>
    </details>`).join('');
  };
  drawBook();
  const entryOf = (el) => { const d = el.closest('[data-i]'); return d ? [entries[+d.dataset.i], +d.dataset.i, d] : [null, -1, null]; };
  bookBox.addEventListener('toggle', (e) => {
    const d = e.target.closest && e.target.closest('[data-i]');
    if (d && entries[+d.dataset.i]) entries[+d.dataset.i]._open = d.open;
  }, true);
  const onEntryInput = (e) => {
    const t = e.target.closest('[data-e]');
    if (!t) return;
    const [en, i, d] = entryOf(t);
    if (!en) return;
    const k = t.dataset.e;
    if (t.type === 'checkbox') en[k] = t.checked;
    else if (k === 'insertion_order') en[k] = t.value === '' ? 0 : Math.trunc(Number(t.value)) || 0;
    else en[k] = t.value;
    if (k === 'content') { const c = bookBox.querySelector(`[data-ec="${i}"]`); if (c) c.textContent = zh.chars_count(len(t.value)); }
    if (k === '_keys' || k === 'constant') { const h = bookBox.querySelector(`[data-head="${i}"]`); if (h) h.innerHTML = entryHead(en, i); }
    if (k === 'enabled') d.classList.toggle('off', !en.enabled);
    changed();
  };
  bookBox.addEventListener('input', onEntryInput);
  bookBox.addEventListener('change', onEntryInput);
  bookBox.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-e-rm]');
    if (!b) return;
    const [en, i] = entryOf(b);
    if (!en) return;
    if (!await confirmDialog(E.entry_remove_confirm, { danger: true, ok: zh.delete })) return;
    entries.splice(i, 1);
    drawBook();
    changed();
  });
  page.querySelector('[data-book-add]').onclick = () => {
    const maxOrder = entries.reduce((m, x) => Math.max(m, Number(x.insertion_order) || 0), 0);
    entries.push({ _keys: '', content: '', enabled: true, constant: false, case_sensitive: false, selective: false, position: 'before_char', insertion_order: maxOrder + 10, _open: true });
    drawBook();
    const inp = bookBox.querySelector(`[data-i="${entries.length - 1}"] [data-e="_keys"]`);
    if (inp) inp.focus();
  };

  /* ---------- 收集 / 脏检查 ---------- */
  const TEXT_KEYS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes'];
  function collect() {
    const data = { ...D };
    for (const k of TEXT_KEYS) data[k] = $f(k).value;
    data.alternate_greetings = alts.map((a) => a).filter((a) => a.trim());
    data.character_book = {
      ...origBook,
      entries: entries.map((e) => {
        const { _keys, _open, ...rest } = e;
        return {
          ...rest,
          keys: clampKeys(splitKeys(_keys)),
          secondary_keys: Array.isArray(rest.secondary_keys) ? rest.secondary_keys : [],
          content: e.content,
          enabled: !!e.enabled,
          constant: !!e.constant,
          case_sensitive: !!e.case_sensitive,
          selective: !!rest.selective,
          insertion_order: Number(e.insertion_order) || 0,
          position: rest.position || 'before_char',
        };
      }),
    };
    if (!isObj(data.extensions)) data.extensions = {};
    return {
      kind,
      name: $f('name').value.trim(),
      tagline: $f('tagline').value.trim(),
      tags: tags.slice(),
      nsfw: $f('nsfw').checked,
      visibility: visVal(),
      data,
    };
  }
  let savedSnap = JSON.stringify(collect());
  let dirty = false;
  const totalEl = page.querySelector('[data-total]');
  const onBeforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);
  ctx.onCleanup(() => window.removeEventListener('beforeunload', onBeforeUnload));
  const guard = () => confirmDialog(E.leave_confirm, { danger: true, ok: E.leave_ok });

  function drawTotal() {
    let n = 0;
    for (const k of ['description', 'personality', 'scenario', 'first_mes', 'mes_example']) n += len($f(k).value);
    for (const a of alts) n += len(a);
    for (const e of entries) n += len(e.content);
    totalEl.textContent = E.total_chars(n.toLocaleString('en-US'));
  }
  function changed() {
    const now = JSON.stringify(collect()) !== savedSnap || (id == null && !!pendingAvatar);
    if (now !== dirty) {
      dirty = now;
      page.querySelector('[data-dirty]').hidden = !dirty;
      setLeaveGuard(dirty ? guard : null);
    }
    drawTotal();
  }
  drawTotal();

  form.addEventListener('input', (e) => {
    const t = e.target.closest('[data-f]');
    if (t && t.dataset.f) {
      const c = form.querySelector(`[data-count="${t.dataset.f}"]`);
      if (c) c.textContent = zh.chars_count(len(t.value));
      if (t.dataset.f === 'name') {
        const er = form.querySelector('[data-err="name"]');
        if (er) er.textContent = '';
        t.removeAttribute('aria-invalid');
        if (!avatarUrl && !objUrl) drawAvatar();
      }
    }
    if (e.target.closest('[data-f], [name="visibility"]')) changed();
  });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'visibility') syncVis();
    if (e.target.closest('[data-f], [name="visibility"]')) changed();
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });

  /* ---------- 保存 ---------- */
  let saving = false;
  async function save({ quiet = false } = {}) {
    if (saving) return false;
    const body = collect();
    if (!body.name) {
      const inp = $f('name');
      form.querySelector('[data-err="name"]').textContent = E.name_required;
      inp.setAttribute('aria-invalid', 'true');
      inp.focus();
      inp.scrollIntoView({ block: 'center' });
      return false;
    }
    saving = true;
    saveBtn.disabled = true;
    tryBtn.disabled = true;
    const lbl = saveBtn.querySelector('span');
    lbl.textContent = E.saving;
    try {
      const isNew = id == null;
      const r = isNew ? await post('/api/cards', body) : await patch('/api/cards/' + encodeURIComponent(id), body);
      const c = (r && (r.card || r.item)) || r;
      if (isNew) {
        if (!c || c.id == null) throw new ApiError(zh.server_error, 500);
        id = c.id;
        history.replaceState(null, '', editHref(id));
        noteHashReplaced();
        moreBtn.hidden = false;
        page.querySelector('[data-title]').textContent = E.title_edit;
        setTitle(E.title_edit);
      }
      if (c && c.avatar) avatarUrl = c.avatar;
      savedSnap = JSON.stringify(body);
      if (pendingAvatar) await doUpload(pendingAvatar);
      changed();
      store.homeCache = null;
      if (!quiet) toast(isNew ? E.saved_new : zh.saved);
      return true;
    } catch (e) {
      toastError(e);
      return false;
    } finally {
      saving = false;
      if (saveBtn.isConnected) { saveBtn.disabled = false; tryBtn.disabled = false; lbl.textContent = E.save; }
    }
  }
  saveBtn.onclick = () => save();

  tryBtn.onclick = async () => {
    if (id == null || dirty) {
      if (!await save({ quiet: true })) return;
    }
    tryBtn.disabled = true;
    try { await startCardChat(id, navigate); } catch (e) { toastError(e); if (tryBtn.isConnected) tryBtn.disabled = false; }
  };

  // Ctrl/⌘+S 保存
  const onKey = (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); }
  };
  document.addEventListener('keydown', onKey);
  ctx.onCleanup(() => document.removeEventListener('keydown', onKey));

  /* ---------- 头部 ---------- */
  page.querySelector('[data-back]').onclick = () => {
    if (history.length > 1) history.back(); else navigate(id != null ? cardHref(id) : '#/create');
  };
  page.querySelector('.ed-nav').addEventListener('click', (e) => {
    const a = e.target.closest('[data-jump]');
    if (!a) return;
    e.preventDefault(); // 不改地址栏 hash（hash 用于路由）
    const sec = page.querySelector('#' + a.dataset.jump);
    if (sec) sec.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  });
  moreBtn.onclick = async () => {
    if (id == null) return;
    const U = zh.ucard;
    const v = await menu([
      { icon: 'user', label: zh.create.menu_view, value: 'view' },
      { icon: 'download', label: U.export_json, value: 'json' },
      { icon: 'image', label: U.export_png, value: 'png' },
      { icon: 'trash', label: U.delete, value: 'delete', danger: true },
    ], { title: $f('name').value.trim() || card.name });
    if (!ctx.isActive()) return;
    const cur = { id, name: $f('name').value.trim() || card.name };
    if (v === 'view') navigate(cardHref(id));
    else if (v === 'json' || v === 'png') {
      if (dirty && !await save({ quiet: true })) return;
      exportCard(cur, v);
    } else if (v === 'delete' && await deleteCard(cur)) {
      dirty = false;
      setLeaveGuard(null);
      navigate('#/create', true);
    }
  };

  if (id == null) setTimeout(() => { if (ctx.isActive()) $f('name').focus(); }, 50);
}
