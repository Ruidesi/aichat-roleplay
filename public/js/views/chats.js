import { zh } from '/i18n/zh.js';
import { get, del } from '/js/api.js';
import { store } from '/js/store.js';
import { esc, timeAgo, previewText, fmtCost } from '/js/util.js';
import { icon, avatar, spinnerHtml, errorHtml, menu, confirmDialog, toast, toastError, fileEntryHtml, fileAvatar } from '/js/ui.js';
import { chatTarget } from '/js/cards.js';

export default async function chats(ctx) {
  const { root, setTitle } = ctx;
  const T = zh.chats;
  setTitle(T.title);
  root.innerHTML = `<div class="page page-narrow"><h1 class="page-title">${esc(T.title)}</h1>${fileEntryHtml()}<div id="list">${spinnerHtml()}</div></div>`;
  const list = root.querySelector('#list');

  const draw = (items) => {
    if (!items.length) {
      list.innerHTML = `<div class="empty">${icon('chats')}<div class="empty-title">${esc(T.empty)}</div><p>${esc(T.empty_hint)}</p><a class="btn btn-primary" href="#/">${esc(T.go_home)}</a></div>`;
      return;
    }
    list.innerHTML = `<div class="panel">${items.map((c) => {
      const ch = chatTarget(c);
      const cost = fmtCost(c.cost_usd, !!c.cost_partial);
      return `<div class="row chat-item" data-id="${esc(c.id)}">
        <a href="#/chat/${encodeURIComponent(c.id)}" style="display:contents;color:inherit">
          ${ch.file ? fileAvatar('avatar', 52) : avatar(ch.avatar, ch.name, 'avatar', 52)}
          <div class="row-main">
            <div class="row-title">${esc(ch.name || c.title)}${ch.file ? `<span class="badge file">${esc(zh.filechat.list_badge)}</span>` : ''}${ch.unavailable ? `<span class="badge gone">${esc(T.unavailable_badge)}</span>` : ''}</div>
            <div class="row-sub">${esc(previewText(c.last_message))}</div>
          </div>
          <div class="row-side"><span>${esc(timeAgo(c.updated_at))}</span>${cost ? `<span class="row-cost" title="${esc(zh.cost.list_label(cost))}">${esc(cost)}</span>` : ''}</div>
        </a>
        <button class="icon-btn" data-more aria-label="${esc(zh.more)}">${icon('more')}</button>
      </div>`;
    }).join('')}</div>`;
  };

  let items = [];
  const load = async () => {
    try {
      const r = await get('/api/chats');
      if (!ctx.isActive()) return;
      items = r.items || [];
      draw(items);
    } catch (e) {
      if (!ctx.isActive()) return;
      list.innerHTML = errorHtml(e.message);
      list.querySelector('[data-retry]').onclick = () => { list.innerHTML = spinnerHtml(); load(); };
    }
  };

  list.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-more]');
    if (!b) return;
    e.preventDefault();
    const id = b.closest('[data-id]').dataset.id;
    const c = items.find((x) => String(x.id) === id);
    const ch = chatTarget(c);
    const v = await menu([
      ...(ch.href ? [{ icon: 'user', label: zh.chat.menu_profile, value: 'profile' }] : []),
      { icon: 'trash', label: zh.chat.menu_delete, value: 'delete', danger: true },
    ], { title: ch.name });
    if (v === 'profile' && ch.href) ctx.navigate(ch.href);
    if (v === 'delete' && await confirmDialog(T.delete_confirm, { title: T.delete_title, danger: true, ok: zh.delete })) {
      try {
        await del('/api/chats/' + encodeURIComponent(id));
        items = items.filter((x) => String(x.id) !== id);
        store.homeCache = null;
        draw(items);
        toast(T.deleted);
      } catch (ex) { toastError(ex); }
    }
  });

  await load();
}
