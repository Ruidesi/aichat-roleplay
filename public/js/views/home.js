import { zh } from '/i18n/zh.js';
import { get } from '/js/api.js';
import { store } from '/js/store.js';
import { esc, tagLabel } from '/js/util.js';
import { icon, avatar, cardHtml, spinnerHtml, errorHtml, fileEntryHtml, fileAvatar } from '/js/ui.js';
import { chatTarget } from '/js/cards.js';
import { refreshOnce } from '/js/cardrefresh.js';
import { galleryEntryHtml } from '/js/images.js';

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return zh.home.greeting_morning;
  if (h < 18) return zh.home.greeting_afternoon;
  return zh.home.greeting_evening;
}

export default async function home(ctx) {
  const { root, setTitle } = ctx;
  setTitle('');
  const H = zh.home;
  const name = (store.me && (store.me.display_name || store.me.username)) || '';
  root.innerHTML = `<div class="page">
    <div class="hello">
      <h1>${esc(greeting())}${name ? '，' + esc(name) : ''}</h1>
      <p>${esc(H.lead)}</p>
      <a class="search-pill" href="#/search">${icon('search')}<span>${esc(zh.search.placeholder)}</span></a>
      ${galleryEntryHtml()}
      ${fileEntryHtml()}
    </div>
    <div id="home-body">${spinnerHtml()}</div>
  </div>`;
  const body = root.querySelector('#home-body');

  const draw = (data, chats) => {
    const parts = [];
    if (chats && chats.length) {
      parts.push(`<section class="section">
        <div class="section-head"><h2 class="section-title">${esc(H.continue)}</h2><a class="link-btn" href="#/chats">${esc(H.see_all)}</a></div>
        <div class="recent-row">${chats.slice(0, 12).map((c) => { const t = chatTarget(c); return `<a class="recent" href="#/chat/${encodeURIComponent(c.id)}">${t.file ? fileAvatar('avatar', 64) : avatar(t.avatar, t.name, 'avatar', 64)}<span>${esc(t.name)}</span></a>`; }).join('')}</div>
      </section>`);
    }
    for (const s of (data.shelves || [])) {
      if (!s.items || !s.items.length) continue;
      parts.push(`<section class="section">
        <div class="section-head"><h2 class="section-title">${esc(s.title)}</h2></div>
        <div class="shelf">${s.items.map(cardHtml).join('')}</div>
      </section>`);
    }
    parts.push(`<section class="section">
      <div class="section-head"><h2 class="section-title">${esc(H.tags)}</h2></div>
      <div class="chips scroll">${zh.quick_tags.map((t) => `<a class="chip" href="#/search?tab=chub&tag=${encodeURIComponent(t)}">${esc(tagLabel(t))}</a>`).join('')}</div>
    </section>`);
    const hot = data.hot || [];
    parts.push(`<section class="section">
      <div class="section-head"><h2 class="section-title">${esc(H.hot)}</h2><a class="link-btn" href="#/search?tab=chub&sort=trending_downloads">${esc(H.see_all)}</a></div>
      ${hot.length ? `<div class="grid">${hot.map(cardHtml).join('')}</div>` : `<div class="empty">${esc(H.empty)}</div>`}
    </section>`);
    body.innerHTML = parts.join('');
  };

  if (store.homeCache) draw(store.homeCache.data, store.homeCache.chats);

  const load = async () => {
    try {
      const [data, chats] = await Promise.all([
        get('/api/home?source=local'),
        get('/api/chats').then((r) => r.items || []).catch(() => []),
      ]);
      if (!ctx.isActive()) return;
      store.homeCache = { data, chats };
      draw(data, chats);
      // 契约 §19.2：还在翻译的卡（translating:true）稍后自动刷新一次，换成中文名 / 简介
      const allCards = (d) => [...((d && d.shelves) || []).flatMap((x) => x.items || []), ...((d && d.hot) || [])];
      refreshOnce(ctx, body, allCards(data), async () => {
        const fresh = await get('/api/home?source=local');
        if (store.homeCache && store.homeCache.data === data) store.homeCache = { data: fresh, chats };
        return allCards(fresh);
      });
    } catch (e) {
      if (!ctx.isActive() || store.homeCache) return;
      body.innerHTML = errorHtml(e.message);
      body.querySelector('[data-retry]').onclick = () => { body.innerHTML = spinnerHtml(); load(); };
    }
  };
  await load();
}
