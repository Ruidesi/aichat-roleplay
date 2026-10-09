// 创作页（契约 §12.5）：我的卡（人物卡 / 剧情卡两栏）+ 新建 + 导入
import { zh } from '/i18n/zh.js';
import { get } from '/js/api.js';
import { esc, timeAgo } from '/js/util.js';
import { icon, avatar, spinnerHtml, errorHtml, menu, toastError, fileEntryHtml } from '/js/ui.js';
import { normCard, cardBadgesHtml, cardHref, editHref, startCardChat, exportCard, deleteCard, pickAndImport } from '/js/cards.js';

let lastKind = 'character';

export default async function create(ctx) {
  const { root, setTitle, navigate, query } = ctx;
  const C = zh.create;
  setTitle(C.title);
  const want = query.get('kind');
  let kind = want === 'scenario' || want === 'character' ? want : lastKind;

  root.innerHTML = `<div class="page page-narrow">
    <h1 class="page-title">${esc(C.title)}</h1>
    <p class="muted small create-lead">${esc(C.lead)}</p>
    <div class="create-actions">
      <a class="create-act" href="#/cards/new?kind=character">${icon('user')}<span>${esc(C.new_character)}</span></a>
      <a class="create-act" href="#/cards/new?kind=scenario">${icon('book')}<span>${esc(C.new_scenario)}</span></a>
      <button class="create-act" type="button" data-import>${icon('upload')}<span>${esc(C.import)}</span></button>
    </div>
    <p class="muted small create-hint">${esc(C.import_hint)}</p>
    ${fileEntryHtml()}
    <div class="tabs create-tabs" role="tablist" aria-label="${esc(C.list_label)}">
      ${['character', 'scenario'].map((k) => `<button role="tab" type="button" data-kind="${k}" aria-controls="create-list">${esc(zh.kinds[k])}<span class="chip-count" data-count="${k}"></span></button>`).join('')}
    </div>
    <div id="create-list" role="tabpanel">${spinnerHtml()}</div>
    <div style="height:24px"></div>
  </div>`;
  const list = root.querySelector('#create-list');
  let items = [];

  const syncTabs = () => {
    root.querySelectorAll('[data-kind]').forEach((b) => {
      const on = b.dataset.kind === kind;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    for (const k of ['character', 'scenario']) {
      const n = items.filter((c) => c.kind === k).length;
      const el = root.querySelector(`[data-count="${k}"]`);
      if (el) el.textContent = items.length || n ? ` ${n}` : '';
    }
  };

  const draw = () => {
    syncTabs();
    const mine = items.filter((c) => c.kind === kind);
    if (!mine.length) {
      list.innerHTML = `<div class="empty">${icon(kind === 'scenario' ? 'book' : 'user')}<div class="empty-title">${esc(kind === 'scenario' ? C.empty_scenario : C.empty_character)}</div><p>${esc(C.empty_hint)}</p>
        <a class="btn btn-primary" href="#/cards/new?kind=${kind}">${icon('plus')}<span>${esc(kind === 'scenario' ? C.new_scenario : C.new_character)}</span></a></div>`;
      return;
    }
    list.innerHTML = `<div class="panel">${mine.map((c) => `
      <div class="row ucard-row" data-id="${esc(c.id)}">
        <a href="${cardHref(c.id)}" class="ucard-link">
          ${avatar(c.avatar, c.name, 'avatar ucard-avatar', 52)}
          <div class="row-main">
            <div class="row-title ucard-title"><span>${esc(c.name)}</span>${cardBadgesHtml(c, { kind: false })}</div>
            <div class="row-sub">${esc(c.tagline || '')}</div>
            <div class="row-sub">${esc(zh.ucard.updated(timeAgo(c.updated_at || c.created_at)))}</div>
          </div>
        </a>
        <button class="icon-btn" type="button" data-more aria-label="${esc(zh.more)}：${esc(c.name)}">${icon('more')}</button>
      </div>`).join('')}</div>`;
  };

  const load = async () => {
    try {
      const r = await get('/api/my/cards');
      if (!ctx.isActive()) return;
      items = (Array.isArray(r) ? r : (r && (r.items || r.cards)) || []).map(normCard).filter((c) => !c.deleted_at);
      draw();
    } catch (e) {
      if (!ctx.isActive()) return;
      list.innerHTML = errorHtml(e.message);
      list.querySelector('[data-retry]').onclick = () => { list.innerHTML = spinnerHtml(); load(); };
    }
  };

  root.querySelector('.create-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    kind = lastKind = b.dataset.kind;
    history.replaceState(null, '', '#/create?kind=' + kind);
    draw();
  });
  root.querySelector('.create-tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    kind = lastKind = kind === 'character' ? 'scenario' : 'character';
    history.replaceState(null, '', '#/create?kind=' + kind);
    draw();
    const b = root.querySelector(`[data-kind="${kind}"]`);
    if (b) b.focus();
  });

  root.querySelector('[data-import]').onclick = async () => {
    const c = await pickAndImport();
    if (c && ctx.isActive()) navigate(editHref(c.id));
  };

  list.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-more]');
    if (!b) return;
    e.preventDefault();
    const id = b.closest('[data-id]').dataset.id;
    const c = items.find((x) => String(x.id) === id);
    if (!c) return;
    const U = zh.ucard;
    const v = await menu([
      { icon: 'edit', label: C.menu_edit, value: 'edit' },
      { icon: 'chat_bubble', label: C.menu_chat, value: 'chat' },
      { icon: 'download', label: U.export_json, value: 'json' },
      { icon: 'image', label: U.export_png, value: 'png' },
      { icon: 'trash', label: U.delete, value: 'delete', danger: true },
    ], { title: c.name });
    if (!ctx.isActive()) return;
    if (v === 'edit') navigate(editHref(c.id));
    else if (v === 'chat') { try { await startCardChat(c.id, navigate); } catch (ex) { toastError(ex); } }
    else if (v === 'json' || v === 'png') exportCard(c, v);
    else if (v === 'delete' && await deleteCard(c)) {
      items = items.filter((x) => x !== c);
      if (ctx.isActive()) draw();
    }
  });

  syncTabs();
  await load();
}
