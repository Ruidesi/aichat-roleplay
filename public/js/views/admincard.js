// 管理 → 自建卡 · 只读详情（契约 §12.3，只限超级管理员）。没有任何修改 / 下架按钮。
import { zh } from '/i18n/zh.js';
import { get } from '/js/api.js';
import { esc, formatMessage, fmtDateTime, encodeHashPath } from '/js/util.js';
import { icon, avatar, spinnerHtml, errorHtml } from '/js/ui.js';
import { normCard, cardBadgesHtml } from '/js/cards.js';
import { cardsState } from '/js/views/admin.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

export default async function adminCard(ctx) {
  const { root, params, setTitle, navigate } = ctx;
  const K = zh.admin.cards;
  const E = zh.editor;
  const id = decodeURIComponent(params[0]);
  setTitle(zh.admin.tabs.cards);
  root.innerHTML = `<div class="page page-narrow acard">${spinnerHtml()}</div>`;
  const page = root.firstElementChild;
  let fromList = !!cardsState.fromList;
  cardsState.fromList = false;
  const back = () => { if (fromList) { fromList = false; history.back(); } else navigate('#/admin?tab=cards'); };

  let raw;
  try {
    let r;
    try {
      r = await get('/api/admin/cards/' + encodeURIComponent(id));
    } catch (e) {
      // 后端若没有单独的管理详情接口，退回到 GET /api/cards/:id（super 只读，契约 §12.2）
      if (e.status !== 404 && e.status !== 405) throw e;
      r = await get('/api/cards/' + encodeURIComponent(id));
    }
    raw = (r && (r.card || r.item)) || r;
  } catch (e) {
    if (!ctx.isActive()) return;
    page.innerHTML = errorHtml(e.status === 404 ? K.not_found : e.message);
    const b = page.querySelector('[data-retry]');
    if (e.status === 404) { b.textContent = K.back_list; b.onclick = back; } else b.onclick = () => adminCard(ctx);
    return;
  }
  if (!ctx.isActive()) return;
  const c = normCard(raw);
  const d = c.data || {};
  const isScn = c.kind === 'scenario';
  setTitle(`${zh.readonly} · ${c.name}`);

  const kv = (k, v) => `<div class="log-kv"><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
  const forkHtml = () => {
    if (!c.fork) return esc(K.no_fork);
    const f = c.fork;
    if (f.unavailable) return esc(zh.ucard.fork_unavailable);
    const name = esc(f.name || zh.ucard.fork_unknown);
    const href = f.ref ? (f.type === 'chub' ? '#/c/' + encodeHashPath(f.ref) : '#/admin/card/' + encodeURIComponent(f.ref)) : '';
    return `${href ? `<a href="${esc(href)}">${name}</a>` : name}${f.author ? ` · ${esc(zh.ucard.orig_author)} ${esc(f.author)}` : ''}${f.type === 'chub' ? ` <span class="muted">(${esc(zh.ucard.fork_from_chub)})</span>` : ''}`;
  };
  const block = (label, text) => `<div class="acard-field"><div class="acard-label">${esc(label)}</div>${String(text || '').trim()
    ? `<div class="prose">${formatMessage(String(text).trim())}</div>`
    : `<div class="muted small">${esc(K.field_empty)}</div>`}</div>`;
  const alts = Array.isArray(d.alternate_greetings) ? d.alternate_greetings.filter((x) => String(x || '').trim()) : [];
  const book = isObj(d.character_book) && Array.isArray(d.character_book.entries) ? d.character_book.entries : [];

  page.innerHTML = `
    <div class="ed-head">
      <button class="icon-btn" type="button" data-back aria-label="${esc(K.back_list)}" title="${esc(K.back_list)}">${icon('back')}</button>
      ${avatar(c.avatar, c.name, 'avatar', 44)}
      <div class="ed-head-main">
        <h1 class="ed-title"><span class="readonly-tag">${esc(zh.readonly)}</span>${esc(c.name)}</h1>
        <div class="ed-sub acard-badges">${cardBadgesHtml(c)}</div>
      </div>
    </div>
    <div class="readonly-bar acard-bar" role="note">${icon('admin')}<span>${esc(K.readonly_bar)}</span></div>
    <section class="panel panel-pad">
      <h2 class="ed-sec-title">${esc(E.sec_basic)}</h2>
      <dl class="log-dl">
        ${kv(K.owner, esc(c.owner.name || (c.owner.id != null ? '#' + c.owner.id : '')))}
        ${kv(E.tagline, c.tagline ? esc(c.tagline) : `<span class="muted">${esc(K.field_empty)}</span>`)}
        ${kv(E.tags, c.tags.length ? esc(c.tags.join('、')) : `<span class="muted">${esc(K.field_empty)}</span>`)}
        ${kv(E.visibility, esc(zh.visibility[c.visibility]))}
        ${kv(E.nsfw, esc(c.nsfw ? zh.admin.logs.yes : zh.admin.logs.no))}
        ${kv(K.fork, forkHtml())}
        ${c.chats ? kv(K.chats, esc(String(c.chats))) : ''}
        ${kv(K.created, esc(fmtDateTime(c.created_at)))}
        ${kv(K.updated, esc(fmtDateTime(c.updated_at)))}
        ${c.deleted_at ? kv(K.deleted_at, `<span class="danger-text">${esc(fmtDateTime(c.deleted_at))} · ${esc(zh.deleted_by_user)}</span>`) : ''}
      </dl>
      ${block(E.creator_notes, d.creator_notes)}
    </section>
    <section class="panel panel-pad">
      <h2 class="ed-sec-title">${esc(E.sec_setting)}</h2>
      ${block(isScn ? E.description_scenario : E.description, d.description)}
      ${block(E.personality, d.personality)}
      ${block(E.scenario, d.scenario)}
      ${block(E.first_mes, d.first_mes)}
      ${alts.length ? alts.map((a, i) => block(E.alt_item(i + 1), a)).join('') : block(E.alt_greetings, '')}
      ${block(E.mes_example, d.mes_example)}
    </section>
    <section class="panel panel-pad">
      <h2 class="ed-sec-title">${icon('book')}${esc(K.book(book.length))}</h2>
      ${book.length ? book.map((e, i) => {
        const keys = Array.isArray(e && e.keys) ? e.keys.join('、') : '';
        const flags = [e && e.enabled === false ? K.entry_flags.disabled : '', e && e.constant ? K.entry_flags.constant : '', e && e.case_sensitive ? K.entry_flags.case : '', e && e.insertion_order != null ? K.order(e.insertion_order) : ''].filter(Boolean).join(' · ');
        return `<div class="acard-entry${e && e.enabled === false ? ' off' : ''}">
          <div class="acard-label">${esc(E.entry_title(i + 1))} · ${esc(keys || E.entry_untitled)}</div>
          ${flags ? `<div class="muted small">${esc(flags)}</div>` : ''}
          <div class="prose">${formatMessage(String((e && e.content) || '').trim() || K.field_empty)}</div>
        </div>`;
      }).join('') : `<p class="muted small">${esc(E.book_empty)}</p>`}
    </section>
    <section class="panel panel-pad">
      <h2 class="ed-sec-title">${esc(E.sec_advanced)}</h2>
      ${block(E.system_prompt, d.system_prompt)}
      ${block(E.post_history, d.post_history_instructions)}
    </section>
    <div style="height:24px"></div>`;
  page.querySelector('[data-back]').onclick = back;
}
