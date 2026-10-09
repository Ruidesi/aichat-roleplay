// 发现页：角色资料默认本地，外网 Chub 由用户主动选择；社区仅展示站内公开卡。
import { zh } from '/i18n/zh.js';
import { get } from '/js/api.js';
import { esc, tagLabel, debounce } from '/js/util.js';
import { icon, cardHtml, spinnerHtml, errorHtml } from '/js/ui.js';
import { ucardGridHtml } from '/js/cards.js';
import { refreshOnce } from '/js/cardrefresh.js';
import { galleryEntryHtml } from '/js/images.js';

const SORTS = ['trending_downloads', 'download_count', 'star_count', 'last_activity_at', 'created_at'];
const CSORTS = ['new', 'popular'];
const KINDS = ['', 'character', 'scenario'];
let lastTab = 'chub';

export default async function search(ctx) {
  const { root, query, setTitle } = ctx;
  const S = zh.search;
  setTitle(S.title);
  const qTab = query.get('tab');
  const state = {
    tab: qTab === 'community' || qTab === 'chub' ? qTab : query.has('source') ? 'chub' : lastTab,
    q: query.get('q') || '',
    source: query.get('source') === 'remote' ? 'remote' : 'local',
    // chub
    tag: '',
    sort: 'trending_downloads',
    // 社区
    ctag: '',
    kind: '',
    csort: 'new',
    page: 1, cursor: '', hasMore: false, loading: false, seq: 0,
  };
  if (state.tab === 'community') {
    state.ctag = query.get('tag') || '';
    state.kind = KINDS.includes(query.get('kind')) ? query.get('kind') : '';
    state.csort = CSORTS.includes(query.get('sort')) ? query.get('sort') : 'new';
  } else {
    state.tag = query.get('tag') || '';
    state.sort = SORTS.includes(query.get('sort')) ? query.get('sort') : 'trending_downloads';
  }
  lastTab = state.tab;
  const tags = [...zh.quick_tags];
  if (state.tag && !tags.some((t) => t.toLowerCase() === state.tag.toLowerCase())) tags.unshift(state.tag);

  root.innerHTML = `<div class="page">
    ${galleryEntryHtml({ compact: true })}
    <div class="search-bar">
      <div class="tabs disc-tabs" role="tablist" aria-label="${esc(S.tabs_label)}">
        <button role="tab" type="button" data-tabk="chub" aria-controls="results">${esc(S.tab_chub)}</button>
        <button role="tab" type="button" data-tabk="community" aria-controls="results">${esc(S.tab_community)}</button>
      </div>
      <div class="sort-row" data-sources role="group" aria-label="${esc(S.sources_label)}">
        <button class="chip" type="button" data-source="local" style="min-height:44px">${esc(S.source_local)}</button>
        <button class="chip" type="button" data-source="remote" style="min-height:44px">${esc(S.source_remote)}</button>
      </div>
      <p class="muted small disc-lead" data-source-lead role="status"></p>
      <form class="search-box" role="search">
        ${icon('search')}
        <input type="search" enterkeyhint="search" autocomplete="off">
        <button type="button" class="icon-btn" data-clear aria-label="${esc(zh.close)}" hidden>${icon('x')}</button>
      </form>
      <div class="search-tools" data-tools="chub">
        <div class="sort-row" data-tags>
          <button class="chip" data-tag="">${esc(S.all_tags)}</button>
          ${tags.map((t) => `<button class="chip" data-tag="${esc(t)}">${esc(tagLabel(t))}</button>`).join('')}
        </div>
        <div class="sort-row" data-sorts role="group" aria-label="${esc(S.sort_label)}">
          ${SORTS.map((s) => `<button class="chip" data-sort="${s}">${esc(S.sort[s])}</button>`).join('')}
        </div>
      </div>
      <div class="search-tools" data-tools="community">
        <div class="sort-row" data-kinds role="group" aria-label="${esc(S.kind_label)}">
          ${KINDS.map((k) => `<button class="chip" data-kind="${k}">${esc(k ? zh.kinds[k] : S.kind_all)}</button>`).join('')}
          <span class="sort-sep" aria-hidden="true"></span>
          ${CSORTS.map((s) => `<button class="chip" data-csort="${s}">${esc(S.community_sort[s])}</button>`).join('')}
        </div>
        <div class="sort-row" data-ctag-row hidden><button class="chip active" data-ctag-clear aria-label="${esc(S.clear_tag)}"><span data-ctag-text></span>${icon('x', 'chip-x')}</button></div>
      </div>
    </div>
    <p class="muted small disc-lead" data-clead>${esc(S.community_lead)}</p>
    <div id="results" class="section" style="margin-top:12px" role="tabpanel"></div>
    <div class="load-more" hidden><button class="btn btn-sm">${esc(zh.load_more)}</button></div>
    <div id="sentinel" style="height:1px"></div>
  </div>`;

  const input = root.querySelector('input');
  const clearBtn = root.querySelector('[data-clear]');
  const results = root.querySelector('#results');
  const moreWrap = root.querySelector('.load-more');
  const moreBtn = moreWrap.querySelector('button');
  input.value = state.q;
  clearBtn.hidden = !state.q;

  const isCom = () => state.tab === 'community';
  const refreshCancels = new Set();
  const syncChips = () => {
    root.querySelectorAll('[data-tabk]').forEach((b) => {
      const on = b.dataset.tabk === state.tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    root.querySelector('[data-tools="chub"]').hidden = isCom();
    root.querySelector('[data-tools="community"]').hidden = !isCom();
    root.querySelector('[data-clead]').hidden = !isCom();
    root.querySelector('[data-sources]').hidden = isCom();
    root.querySelector('[data-source-lead]').hidden = isCom();
    root.querySelector('[data-source-lead]').textContent = state.source === 'remote' ? S.remote_lead : S.local_lead;
    root.querySelectorAll('[data-sources] [data-source]').forEach((b) => {
      const on = b.dataset.source === state.source;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const ph = isCom() ? S.community_placeholder : S.placeholder;
    input.placeholder = ph;
    input.setAttribute('aria-label', ph);
    root.querySelectorAll('[data-tag]').forEach((b) => b.classList.toggle('active', b.dataset.tag.toLowerCase() === state.tag.toLowerCase()));
    root.querySelectorAll('[data-sort]').forEach((b) => b.classList.toggle('active', b.dataset.sort === state.sort));
    root.querySelectorAll('[data-kind]').forEach((b) => { const on = b.dataset.kind === state.kind; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on); });
    root.querySelectorAll('[data-csort]').forEach((b) => { const on = b.dataset.csort === state.csort; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on); });
    root.querySelector('[data-ctag-row]').hidden = !state.ctag;
    root.querySelector('[data-ctag-text]').textContent = state.ctag ? S.tag_filter(state.ctag) : '';
  };
  const syncUrl = () => {
    const p = new URLSearchParams();
    p.set('tab', state.tab);
    if (state.q) p.set('q', state.q);
    if (isCom()) {
      if (state.ctag) p.set('tag', state.ctag);
      if (state.kind) p.set('kind', state.kind);
      if (state.csort !== 'new') p.set('sort', state.csort);
    } else {
      p.set('source', state.source);
      if (state.tag) p.set('tag', state.tag);
      if (state.sort !== 'trending_downloads') p.set('sort', state.sort);
    }
    const qs = p.toString();
    history.replaceState(null, '', '#/search' + (qs ? '?' + qs : ''));
  };

  const fetchPage = async (reset) => {
    const seq = ++state.seq;
    const com = isCom();
    const source = state.source;
    if (reset) {
      state.page = 1;
      state.cursor = '';
      for (const cancel of refreshCancels) cancel();
      refreshCancels.clear();
      results.innerHTML = spinnerHtml();
      moreWrap.hidden = true;
    }
    state.loading = true;
    moreBtn.disabled = true;
    const p = com
      ? new URLSearchParams({ q: state.q, tag: state.ctag, kind: state.kind, sort: state.csort, page: String(state.page) })
      : new URLSearchParams({ q: state.q, tag: state.tag, sort: state.sort, page: String(state.page), source });
    if (!com && source === 'local' && state.cursor) p.set('cursor', state.cursor);
    const render = com ? ucardGridHtml : cardHtml;
    try {
      const r = await get((com ? '/api/community?' : '/api/search?') + p.toString());
      if (seq !== state.seq || !ctx.isActive()) return;
      const items = ((r && r.items) || []).map((item) => com ? item : { ...item, source });
      state.hasMore = !!(r && r.has_more);
      state.cursor = !com && source === 'local' && typeof r?.next_cursor === 'string' ? r.next_cursor : '';
      if (reset) {
        const empty = com ? S.community_empty : source === 'local' ? (r?.available === false ? S.local_unavailable : S.local_empty) : S.empty;
        results.innerHTML = items.length ? `<div class="grid">${items.map(render).join('')}</div>` : `<div class="empty"><div class="empty-title">${esc(empty)}</div></div>`;
      } else {
        const grid = results.querySelector('.grid');
        if (grid) grid.insertAdjacentHTML('beforeend', items.map(render).join(''));
      }
      moreWrap.hidden = !state.hasMore;
      // 契约 §19.2：chub 结果里还在翻译的卡，稍后用同一页的数据自动刷新一次
      if (!com) {
        const url = '/api/search?' + p.toString();
        const cancel = refreshOnce(ctx, results, items, async () => {
          const fresh = await get(url);
          return ((fresh && fresh.items) || []).map((item) => ({ ...item, source }));
        });
        refreshCancels.add(cancel);
      }
    } catch (e) {
      if (seq !== state.seq || !ctx.isActive()) return;
      if (reset) {
        results.innerHTML = errorHtml(e.status === 403 && !com ? S.disabled : e.message);
        const b = results.querySelector('[data-retry]');
        if (b) b.onclick = () => fetchPage(true);
      } else {
        state.page--;
        moreWrap.hidden = false;
      }
    } finally {
      if (seq === state.seq) { state.loading = false; moreBtn.disabled = false; }
    }
  };

  const loadMore = () => {
    if (state.loading || !state.hasMore) return;
    state.page++;
    fetchPage(false);
  };
  const refresh = () => { syncChips(); syncUrl(); fetchPage(true); };
  const onType = debounce(() => {
    const v = input.value.trim();
    if (v === state.q) return;
    state.q = v;
    refresh();
  }, 450);

  const setTab = (t) => {
    if (t === state.tab) return;
    state.tab = lastTab = t;
    refresh();
  };
  const tabBar = root.querySelector('.disc-tabs');
  tabBar.addEventListener('click', (e) => { const b = e.target.closest('[data-tabk]'); if (b) setTab(b.dataset.tabk); });
  tabBar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setTab(isCom() ? 'chub' : 'community');
    const b = root.querySelector(`[data-tabk="${state.tab}"]`);
    if (b) b.focus();
  });
  root.querySelector('[data-sources]').addEventListener('click', (e) => {
    const button = e.target.closest('[data-source]');
    if (!button || !['local', 'remote'].includes(button.dataset.source) || button.dataset.source === state.source) return;
    state.source = button.dataset.source;
    refresh();
  });

  input.addEventListener('input', () => { clearBtn.hidden = !input.value; onType(); });
  root.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    input.blur();
    state.q = input.value.trim();
    refresh();
  });
  clearBtn.onclick = () => { input.value = ''; clearBtn.hidden = true; state.q = ''; refresh(); input.focus(); };
  root.querySelector('[data-tags]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag]');
    if (!b) return;
    state.tag = b.dataset.tag;
    refresh();
  });
  root.querySelector('[data-sorts]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    state.sort = b.dataset.sort;
    refresh();
  });
  root.querySelector('[data-kinds]').addEventListener('click', (e) => {
    const k = e.target.closest('[data-kind]');
    const s = e.target.closest('[data-csort]');
    if (k) state.kind = k.dataset.kind;
    else if (s) state.csort = s.dataset.csort;
    else return;
    refresh();
  });
  root.querySelector('[data-ctag-clear]').onclick = () => { state.ctag = ''; refresh(); };
  moreBtn.onclick = loadMore;

  const io = new IntersectionObserver((ents) => { if (ents.some((x) => x.isIntersecting)) loadMore(); }, { rootMargin: '400px' });
  io.observe(root.querySelector('#sentinel'));
  ctx.onCleanup(() => io.disconnect());

  syncChips();
  syncUrl();
  const activeTag = root.querySelector('[data-tag].active');
  if (!isCom() && activeTag && activeTag.scrollIntoView) activeTag.scrollIntoView({ inline: 'center', block: 'nearest' });
  if (!state.q && !state.tag && !query.get('sort') && !matchMedia('(pointer: coarse)').matches) input.focus();
  await fetchPage(true);
}
