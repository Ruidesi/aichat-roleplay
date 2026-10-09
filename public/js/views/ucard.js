// 自建卡详情（契约 §12.5）：社区卡 / 我的卡。开聊、拷贝并二次创作、编辑、导出、删除
import { zh } from '/i18n/zh.js';
import { get } from '/js/api.js';
import { esc, timeAgo, previewText, fmtDateTime, fmtNum } from '/js/util.js';
import { store } from '/js/store.js';
import { normDef, renderSheet } from '/js/charsheet.js';
import { icon, avatar, spinnerHtml, menu, toastError } from '/js/ui.js';
import { loadCard, forkLineHtml, editHref, startCardChat, forkCard, exportCard, deleteCard, chatTarget } from '/js/cards.js';

export default async function ucard(ctx) {
  const { root, params, setTitle, navigate } = ctx;
  const U = zh.ucard;
  const id = decodeURIComponent(params[0]);
  root.innerHTML = `<div class="page page-narrow">${spinnerHtml()}</div>`;
  const page = root.firstElementChild;
  const back = () => (history.length > 1 ? history.back() : navigate('#/search?tab=community'));

  const chatsP = get('/api/chats').catch(() => null);
  let c;
  try {
    c = await loadCard(id);
  } catch (e) {
    if (!ctx.isActive()) return;
    const msg = e.status === 404 || e.status === 403 ? U.not_found : e.message;
    page.innerHTML = `<div class="char-top" style="position:static;margin:0 -8px"><button class="icon-btn" data-back aria-label="${esc(zh.back)}">${icon('back')}</button></div>
      <div class="empty"><div class="empty-title">${esc(msg)}</div>${e.status === 403 && /成人/.test(e.message || '') ? `<a class="btn btn-sm" href="#/me">${esc(zh.nav.me)}</a>` : ''}</div>`;
    page.querySelector('[data-back]').onclick = back;
    return;
  }
  if (!ctx.isActive()) return;
  setTitle(c.name);
  const d = c.data || {};
  const canUse = c.mine || c.visibility === 'public'; // 私有卡只有作者能开聊 / 拷贝
  const chatsR = await chatsP;
  if (!ctx.isActive()) return;
  const mine = ((chatsR && chatsR.items) || []).filter((x) => { const t = chatTarget(x); return t.userCardId != null && String(t.userCardId) === String(c.id); });
  const latest = mine[0] || null;
  const isScn = c.kind === 'scenario';

  page.innerHTML = `
    <div class="char-hero">
      <div class="char-hero-bg"></div>
      <div class="char-top">
        <button class="icon-btn" data-back aria-label="${esc(zh.back)}">${icon('back')}</button>
        <button class="icon-btn" data-more aria-label="${esc(zh.more)}">${icon('more')}</button>
      </div>
      ${avatar(c.avatar, c.name, 'char-avatar')}
      <h1 class="char-name">${esc(c.name)}</h1>
      ${c.tagline ? `<p class="char-tagline">${esc(c.tagline)}</p>` : ''}
      <div class="char-stats">
        <span class="badge kind-${c.kind}">${esc(zh.kinds[c.kind])}</span>
        ${c.mine ? `<span class="badge vis-${c.visibility}">${esc(zh.visibility[c.visibility])}</span>` : ''}
        ${c.owner.name ? `<span>${esc(U.by(c.owner.name))}</span>` : ''}
        ${c.chats ? `<span>${fmtNum(c.chats)} ${esc(zh.card.chats)}</span>` : ''}
      </div>
      ${c.fork ? forkLineHtml(c.fork) : ''}
      ${c.tags.length || c.nsfw ? `<div class="chips">${c.tags.slice(0, 12).map((t) => `<a class="chip sm" href="#/search?tab=community&tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}${c.nsfw ? '<span class="chip sm">18+</span>' : ''}</div>` : ''}
      ${canUse ? `<div class="char-actions">
        ${c.mine ? `<a class="btn btn-sm btn-secondary" href="${editHref(c.id)}">${icon('edit')}<span>${esc(U.edit)}</span></a>` : ''}
        <button class="btn btn-sm btn-secondary" type="button" data-fork>${icon('fork')}<span>${esc(U.fork)}</span></button>
      </div>` : ''}
      ${c.mine && c.visibility === 'private' ? `<p class="muted small" style="margin-top:10px">${icon('lock', 'inline-ico')} ${esc(U.private_note)}</p>` : ''}
    </div>
    ${canUse ? `<div class="char-cta">${latest
      ? `<div class="cta-row"><a class="btn btn-primary" href="#/chat/${encodeURIComponent(latest.id)}">${icon('chat_bubble')}<span>${esc(U.continue)}</span></a>
         <button class="btn btn-secondary" data-start>${icon('plus')}<span>${esc(U.new_chat)}</span></button></div>`
      : `<button class="btn btn-primary btn-block" data-start>${icon('chat_bubble')}<span>${esc(U.start)}</span></button>`}</div>` : ''}
    <section class="section" data-history hidden>
      <div class="section-head"><h2 class="section-title">${esc(U.history)}</h2></div>
      <div class="panel" data-history-list></div>
    </section>
    <div class="cs-sheet" data-sheet></div>
    <p class="muted small" style="text-align:center;margin-top:20px">${esc(U.updated(timeAgo(c.updated_at || c.created_at)))}</p>
    <div style="height:24px"></div>`;

  page.querySelector('[data-back]').onclick = back;
  if (c.avatar) page.querySelector('.char-hero-bg').style.backgroundImage = `url(${JSON.stringify(c.avatar)})`;
  // 全部设定（契约 §19.1）：自建卡不翻译，但同样分区展示全部字段
  const me = store.me || {};
  renderSheet(page.querySelector('[data-sheet]'), { orig: normDef(d) || normDef({}), scenario: isScn, names: { char: c.name, user: me.persona_name || me.display_name || me.username || '' } });

  const startBtn = page.querySelector('[data-start]');
  if (startBtn) {
    const label = latest ? U.new_chat : U.start;
    startBtn.onclick = async () => {
      startBtn.disabled = true;
      startBtn.lastElementChild.textContent = U.starting;
      try { await startCardChat(c.id, navigate); } catch (e) {
        toastError(e);
        startBtn.disabled = false;
        startBtn.lastElementChild.textContent = label;
      }
    };
  }
  const forkBtn = page.querySelector('[data-fork]');
  if (forkBtn) forkBtn.onclick = () => forkCard({ from: 'user', id: c.id }, navigate, forkBtn);

  const moreBtn = page.querySelector('[data-more]');
  const items = [];
  if (c.mine) items.push({ icon: 'edit', label: U.edit, value: 'edit' });
  if (canUse) items.push({ icon: 'fork', label: U.fork, value: 'fork' });
  if (canUse) items.push({ icon: 'download', label: U.export_json, value: 'json' }, { icon: 'image', label: U.export_png, value: 'png' });
  if (c.mine) items.push({ icon: 'trash', label: U.delete, value: 'delete', danger: true });
  if (!items.length) moreBtn.hidden = true;
  moreBtn.onclick = async () => {
    const v = await menu(items, { title: c.name });
    if (!ctx.isActive()) return;
    if (v === 'edit') navigate(editHref(c.id));
    else if (v === 'fork') forkCard({ from: 'user', id: c.id }, navigate, forkBtn);
    else if (v === 'json' || v === 'png') exportCard(c, v);
    else if (v === 'delete' && await deleteCard(c)) navigate('#/create', true);
  };

  if (mine.length) {
    const sec = page.querySelector('[data-history]');
    sec.hidden = false;
    sec.querySelector('[data-history-list]').innerHTML = mine.slice(0, 20).map((x) => `
      <a class="row" href="#/chat/${encodeURIComponent(x.id)}">
        <div class="row-main"><div class="row-title">${esc(previewText(x.last_message) || zh.character.no_preview)}</div><div class="row-sub">${esc(zh.character.last_chat)} · ${esc(fmtDateTime(x.updated_at))}</div></div>
        <div class="row-side">${esc(timeAgo(x.updated_at))}</div>
      </a>`).join('');
  }
}
