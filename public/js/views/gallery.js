import { zh } from '/i18n/zh.js';
import { esc } from '/js/util.js';
import { icon, spinnerHtml } from '/js/ui.js';
import { IMAGE_KINDS, getImagePage, galleryHref, imageCardHtml, bindImageCards, imageErrorMessage } from '/js/images.js';
import { openImageViewer } from '/js/image-viewer.js';

export default async function gallery(ctx) {
  const { root, query, setTitle } = ctx;
  const I = zh.images;
  setTitle(I.title);
  const state = {
    kind: IMAGE_KINDS.includes(query.get('kind')) ? query.get('kind') : 'all',
    q: (query.get('q') || '').slice(0, 120), character: (query.get('character') || '').slice(0, 300),
    items: [], page: 0, cursor: '', hasMore: false, loading: false, seq: 0,
  };
  let controller = null, viewer = null, disposed = false;
  root.innerHTML = `<div class="page gallery-page">
    <div class="gallery-head"><h1 class="page-title">${esc(I.title)}</h1><p>${esc(I.lead)}</p></div>
    <div class="gallery-filters">
      <form class="gallery-search" data-image-search role="search">
        <label class="sr-only" for="gallery-q">${esc(I.search_label)}</label>
        <input class="input" id="gallery-q" name="q" type="search" enterkeyhint="search" maxlength="120" autocomplete="off" placeholder="${esc(I.search_placeholder)}">
        <button class="icon-btn" type="button" data-image-clear aria-label="${esc(I.clear_search)}" hidden>${icon('x')}</button>
        <button class="btn btn-secondary" type="submit">${esc(I.search)}</button>
      </form>
      <div class="chips" role="group" aria-label="${esc(I.kind_label)}">
        ${IMAGE_KINDS.map((kind) => `<button class="chip" type="button" data-image-type="${kind}">${esc(I.types[kind])}</button>`).join('')}
      </div>
      <div class="gallery-character" data-image-character-filter hidden><span>${esc(I.character_filter)}：<b data-image-character-name></b></span>
        <button class="link-btn" type="button" data-image-reset-character>${esc(I.clear_character)}</button></div>
    </div>
    <p class="gallery-summary" data-image-summary role="status" aria-live="polite"></p>
    <div data-image-results role="region" aria-label="${esc(I.title)}" aria-busy="true"></div>
    <div data-image-message role="status" aria-live="polite" hidden></div>
    <div class="gallery-pagination" data-image-more-wrap hidden><button class="btn btn-secondary" type="button" data-image-more>${esc(I.more)}</button></div>
  </div>`;
  const input = root.querySelector('[name="q"]');
  const clear = root.querySelector('[data-image-clear]');
  const results = root.querySelector('[data-image-results]');
  const message = root.querySelector('[data-image-message]');
  const summary = root.querySelector('[data-image-summary]');
  const moreWrap = root.querySelector('[data-image-more-wrap]');
  const more = root.querySelector('[data-image-more]');
  input.value = state.q;
  const cards = bindImageCards(results, {
    getItems: () => state.items,
    onOpen: (items, index, button) => {
      viewer = openImageViewer(items, { index, returnFocus: () => button.isConnected ? button : input });
    },
  });
  ctx.onCleanup(() => { disposed = true; ++state.seq; controller?.abort(); cards.dispose(); viewer?.close(); });

  const syncFilters = () => {
    clear.hidden = !input.value;
    root.querySelectorAll('[data-image-type]').forEach((button) => {
      const active = button.dataset.imageType === state.kind;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    root.querySelector('[data-image-character-filter]').hidden = !state.character;
    root.querySelector('[data-image-character-name]').textContent = state.character;
    history.replaceState(null, '', galleryHref(state));
  };
  const showError = (text, reset) => {
    if (reset) results.innerHTML = '';
    message.hidden = false;
    message.innerHTML = `<div class="gallery-unavailable"><p>${esc(text)}</p><button class="btn btn-secondary" type="button" data-image-retry>${esc(I.retry)}</button></div>`;
    message.querySelector('[data-image-retry]').onclick = () => fetchPage(reset);
  };
  const fetchPage = async (reset) => {
    if (disposed || !ctx.isActive()) return;
    controller?.abort();
    controller = new AbortController();
    const seq = ++state.seq;
    const page = reset ? 1 : state.page + 1;
    state.loading = true;
    results.setAttribute('aria-busy', 'true');
    message.hidden = true;
    more.disabled = true;
    more.textContent = I.loading;
    if (reset) {
      state.items = [];
      state.page = 0;
      state.cursor = '';
      state.hasMore = false;
      results.innerHTML = spinnerHtml();
      summary.textContent = I.loading;
      moreWrap.hidden = true;
    }
    try {
      const response = await getImagePage({ ...state, page }, { signal: controller.signal });
      if (disposed || seq !== state.seq || !ctx.isActive()) return;
      if (response?.available === false) {
        showError(I.mirror_unavailable, reset);
        summary.textContent = state.items.length ? I.loaded(state.items.length) : '';
        return;
      }
      const incoming = Array.isArray(response?.items) ? response.items.filter((item) => item && typeof item === 'object') : [];
      const seen = new Set(state.items.map((item) => item.id));
      const fresh = incoming.filter((item) => { if (seen.has(item.id)) return false; seen.add(item.id); return true; });
      const startIndex = state.items.length;
      state.items.push(...fresh);
      state.page = page;
      state.cursor = typeof response?.next_cursor === 'string' ? response.next_cursor : '';
      state.hasMore = response?.has_more === true;
      if (reset) {
        results.innerHTML = state.items.length ? `<div class="gallery-grid">${state.items.map(imageCardHtml).join('')}</div>`
          : `<div class="empty"><div class="empty-title">${esc(I.empty)}</div></div>`;
      } else if (fresh.length) {
        const grid = results.querySelector('.gallery-grid');
        if (grid) grid.insertAdjacentHTML('beforeend', fresh.map((item, i) => imageCardHtml(item, startIndex + i)).join(''));
        else results.innerHTML = `<div class="gallery-grid">${state.items.map(imageCardHtml).join('')}</div>`;
      }
      cards.refresh();
      summary.textContent = state.items.length ? I.loaded(state.items.length) + (state.hasMore ? '' : ` · ${I.all_loaded}`) : '';
    } catch (error) {
      if (disposed || seq !== state.seq || !ctx.isActive() || error?.name === 'AbortError') return;
      showError(imageErrorMessage(error), reset);
      summary.textContent = state.items.length ? I.loaded(state.items.length) : '';
    } finally {
      if (seq === state.seq && !disposed && ctx.isActive()) {
        state.loading = false;
        results.setAttribute('aria-busy', 'false');
        more.disabled = false;
        more.textContent = I.more;
        moreWrap.hidden = !state.hasMore;
      }
    }
  };
  const refresh = () => { syncFilters(); fetchPage(true); };
  root.querySelector('[data-image-search]').addEventListener('submit', (event) => {
    event.preventDefault();
    state.q = input.value.trim().slice(0, 120);
    input.blur();
    refresh();
  });
  input.addEventListener('input', () => { clear.hidden = !input.value; });
  clear.onclick = () => { input.value = ''; state.q = ''; refresh(); input.focus(); };
  root.querySelectorAll('[data-image-type]').forEach((button) => {
    button.onclick = () => {
      if (state.kind === button.dataset.imageType) return;
      state.kind = button.dataset.imageType;
      state.q = input.value.trim().slice(0, 120);
      refresh();
    };
  });
  root.querySelector('[data-image-reset-character]').onclick = () => { state.character = ''; refresh(); };
  more.onclick = () => { if (!state.loading && state.hasMore) fetchPage(false); };
  syncFilters();
  await fetchPage(true);
}
