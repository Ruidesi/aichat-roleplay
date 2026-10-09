import { zh } from '/i18n/zh.js';
import { get, post, encPath } from '/js/api.js';
import { store } from '/js/store.js';
import { esc, tagLabel, fmtNum, timeAgo, decodeHashPath, previewText, fmtDateTime } from '/js/util.js';
import { icon, avatar, spinnerHtml, toastError, characterHref } from '/js/ui.js';
import { forkCard, chatTarget } from '/js/cards.js';
import { chubSheet, renderSheet, cardNames, tagZh } from '/js/charsheet.js';
import { mountTranslationTools } from '/js/translation-tools.js';
import { safeImageUrl, getCharacterImagePage, galleryHref, imageCardHtml, bindImageCards, imageErrorMessage } from '/js/images.js';
import { openImageViewer } from '/js/image-viewer.js';

export default async function character(ctx) {
  const { root, params, query, setTitle, navigate } = ctx;
  const C = zh.character;
  const I = zh.images;
  const path = decodeHashPath(params[0]);
  const source = query?.get('source') === 'remote' ? 'remote' : 'local';
  const sourceQuery = '?source=' + source;
  root.innerHTML = `<div class="page page-narrow">${spinnerHtml()}<p class="muted small" data-preparing hidden style="text-align:center;margin-top:-8px" role="status">${esc(source === 'local' ? C.local_preparing : C.preparing)}</p></div>`;
  const page = root.firstElementChild;
  // 第一次打开 chub 角色时后端要翻译开场白，可能要等十几秒：超过 1.5 秒给一句说明
  const prepTimer = setTimeout(() => {
    const p = page.querySelector('[data-preparing]');
    if (p) p.hidden = false;
  }, 1500);
  ctx.onCleanup(() => clearTimeout(prepTimer));

  // 与角色详情并行拉会话列表，用来决定主按钮是「继续」还是「开始」
  const chatsP = get('/api/chats').catch(() => null);

  let data;
  try {
    data = await get('/api/characters/' + encPath(path) + sourceQuery);
    clearTimeout(prepTimer);
  } catch (e) {
    clearTimeout(prepTimer);
    if (!ctx.isActive()) return;
    const msg = e.status === 403 ? C.blocked : e.status === 404 ? (source === 'local' ? C.local_not_found : C.not_found) : e.message;
    page.innerHTML = `<div class="char-top" style="position:static;margin:0 -8px">
      <button class="icon-btn" data-back aria-label="${esc(zh.back)}">${icon('back')}</button></div>
      <div class="empty"><div class="empty-title">${esc(msg)}</div>
      ${e.status === 404 && source === 'local' ? `<a class="btn btn-sm" href="${esc(characterHref(path, { source: 'remote' }))}">${esc(C.open_remote)}</a>` : ''}
      ${e.status === 403 ? `<a class="btn btn-sm" href="#/me">${esc(zh.nav.me)}</a>` : ''}</div>`;
    page.querySelector('[data-back]').onclick = () => (history.length > 1 ? history.back() : navigate('#/'));
    return;
  }
  if (!ctx.isActive()) return;
  let ch = data.character || {};
  const S = zh.sheet;
  const chPath = ch.path || path;
  const chatsR = await chatsP;
  if (!ctx.isActive()) return;
  const mine = ((chatsR && chatsR.items) || []).filter((c) => { const t = chatTarget(c); return t.userCardId == null && t.path === chPath; });
  const latest = mine[0] || null; // 列表已按 updated_at 倒序
  const me = store.me || {};
  const userName = me.persona_name || me.display_name || me.username || '';

  page.innerHTML = `
    <div class="char-hero">
      <div class="char-hero-bg"></div>
      <div class="char-top"><button class="icon-btn" data-back aria-label="${esc(zh.back)}">${icon('back')}</button></div>
      <div data-hero></div>
      <div class="char-actions"><button class="btn btn-sm btn-secondary" type="button" data-fork>${icon('fork')}<span>${esc(C.fork)}</span></button></div>
    </div>
    <div class="char-cta">${latest
      ? `<div class="cta-row"><a class="btn btn-primary" href="#/chat/${encodeURIComponent(latest.id)}">${icon('chat_bubble')}<span>${esc(C.continue)}</span></a>
         <button class="btn btn-secondary" data-start>${icon('plus')}<span>${esc(C.new_chat)}</span></button></div>`
      : `<button class="btn btn-primary btn-block" data-start>${icon('chat_bubble')}<span>${esc(C.start)}</span></button>`}</div>
    <section class="section character-images" data-character-images>
      <div class="section-head"><h2 class="section-title">${esc(I.character_images)}</h2>
        <a class="link-btn" href="${esc(galleryHref({ character: chPath }))}">${esc(I.view_all)}</a></div>
      <p class="gallery-summary" data-character-image-summary role="status" aria-live="polite">${esc(I.loading)}</p>
      <div data-character-image-grid aria-busy="true">${spinnerHtml()}</div>
      <div data-character-image-message role="status" aria-live="polite" hidden></div>
      <div class="gallery-pagination" data-character-image-more-wrap hidden>
        <button class="btn btn-secondary" type="button" data-character-image-more>${esc(I.more)}</button></div>
    </section>
    <section class="panel panel-pad tr-tools" data-tr-tools aria-label="翻译与历史译文"></section>
    <div class="cs-status" data-tr-status role="status" aria-live="polite" hidden></div>
    <div class="cs-sheet" data-sheet></div>
    <section class="section" data-history hidden>
      <div class="section-head"><h2 class="section-title">${esc(C.history)}</h2><button class="link-btn" type="button" data-history-all hidden></button></div>
      <div class="panel" data-history-list></div>
    </section>
    <div style="height:24px"></div>`;

  page.querySelector('[data-back]').onclick = () => (history.length > 1 ? history.back() : navigate('#/'));
  const initialAvatar = source === 'local' ? safeImageUrl(ch.avatar) : ch.avatar;
  if (initialAvatar) page.querySelector('.char-hero-bg').style.backgroundImage = `url(${JSON.stringify(initialAvatar)})`;

  // ---------- 头部：中文名 + 小字原名、中文简介、中文标签（可切回原文） ----------
  const heroEl = page.querySelector('[data-hero]');
  const imageState = { items: [], page: 0, visible: 6, hasMore: false, loading: false, seq: 0, avatarFailed: false };
  let imageController = null, imageViewer = null;
  let heroOrig = false;
  function drawHero() {
    const nm = cardNames(ch);
    const tagO = String(ch.tagline || '');
    const tagZ = String(ch.tagline_zh || '').trim();
    const tags = (ch.tags || []).slice(0, 10);
    // 服务端对没有译名的标签会回填原词：与原词相同就当作没有译文，改用本地中文标签
    const tagsZ = tags.map((t, i) => { const z = tagZh(ch, t, i); return z && z !== String(t).trim() ? z : ''; });
    const tagShown = tags.map((t, i) => tagsZ[i] || tagLabel(t));
    // 只有显示的内容和原文真的不同，才给「查看原文」
    const hasTr = !!(nm.orig || (tagZ && tagZ !== tagO.trim()) || tagShown.some((x, i) => x !== tags[i]));
    const useO = heroOrig && hasTr;
    const name = useO && nm.orig ? nm.orig : nm.main;
    const tagline = useO ? tagO : (tagZ || tagO);
    setTitle(nm.main);
    const avatarImage = imageState.items.find((item) => item.kind === 'avatar' && safeImageUrl(item.thumbnail_url));
    const originalImage = imageState.items.find((item) => item.kind === 'fullimg' && safeImageUrl(item.original_url))
      || imageState.items.find((item) => item.kind === 'avatar' && safeImageUrl(item.original_url));
    const fallbackAvatar = source === 'local' ? safeImageUrl(ch.avatar) : ch.avatar;
    const portraitUrl = (!imageState.avatarFailed && safeImageUrl(avatarImage?.thumbnail_url)) || fallbackAvatar;
    const portrait = avatar(portraitUrl, nm.main, 'char-avatar');
    if (portraitUrl) page.querySelector('.char-hero-bg').style.backgroundImage = `url(${JSON.stringify(portraitUrl)})`;
    heroEl.innerHTML = `${originalImage ? `<button class="char-image-trigger" type="button" data-open-avatar aria-label="${esc(I.view_original)}：${esc(nm.main)}">${portrait}<span class="char-image-label">${esc(I.view_original)}</span></button>` : portrait}
      <h1 class="char-name">${esc(name)}</h1>
      <p class="muted small">${esc(source === 'local' ? C.source_local : C.source_remote)}</p>
      ${nm.orig && !useO ? `<p class="cs-orig-name">${esc(S.orig_name(nm.orig))}</p>` : ''}
      ${tagline ? `<p class="char-tagline">${esc(tagline)}</p>` : ''}
      ${(ch.chats || ch.stars) ? `<div class="char-stats">${ch.chats ? `<span>${fmtNum(ch.chats)} ${esc(zh.card.chats)}</span>` : ''}${ch.stars ? `<span>${fmtNum(ch.stars)} ${esc(zh.card.stars)}</span>` : ''}</div>` : ''}
      ${tags.length || ch.nsfw ? `<div class="chips">${tags.map((t, i) => `<a class="chip sm" href="#/search?tab=chub&source=${source}&tag=${encodeURIComponent(t)}">${esc(useO ? t : tagShown[i])}</a>`).join('')}${ch.nsfw ? '<span class="chip sm">18+</span>' : ''}</div>` : ''}
      ${hasTr ? `<button class="link-btn cs-hero-toggle" type="button" data-hero-toggle aria-pressed="${useO}">${icon('globe')}<span>${esc(useO ? S.view_translation : S.view_original)}</span></button>` : ''}`;
    const tg = heroEl.querySelector('[data-hero-toggle]');
    if (tg) tg.onclick = () => { heroOrig = !heroOrig; drawHero(); const b = heroEl.querySelector('[data-hero-toggle]'); if (b) b.focus(); };
    const openAvatar = heroEl.querySelector('[data-open-avatar]');
    if (openAvatar && originalImage) openAvatar.onclick = () => {
      imageViewer = openImageViewer(imageState.items, { index: imageState.items.indexOf(originalImage),
        returnFocus: () => heroEl.querySelector('[data-open-avatar]') });
    };
    const portraitImage = heroEl.querySelector('img.char-avatar');
    if (portraitImage && avatarImage && !imageState.avatarFailed && fallbackAvatar && portraitUrl !== fallbackAvatar) {
      portraitImage.onerror = () => { imageState.avatarFailed = true; if (ctx.isActive()) drawHero(); };
    }
  }

  // 图片索引独立加载；NAS或图片权限错误不阻塞角色设定和开聊按钮。
  const imageGrid = page.querySelector('[data-character-image-grid]');
  const imageMessage = page.querySelector('[data-character-image-message]');
  const imageSummary = page.querySelector('[data-character-image-summary]');
  const imageMoreWrap = page.querySelector('[data-character-image-more-wrap]');
  const imageMore = page.querySelector('[data-character-image-more]');
  const imageCards = bindImageCards(imageGrid, {
    getItems: () => imageState.items,
    onOpen: (items, index, button) => {
      imageViewer = openImageViewer(items, { index, returnFocus: () => button.isConnected ? button
        : imageGrid.querySelector(`[data-image-index="${index}"]`) || imageMore });
    },
  });
  ctx.onCleanup(() => { ++imageState.seq; imageController?.abort(); imageCards.dispose(); imageViewer?.close(); });
  const drawImages = () => {
    imageGrid.innerHTML = imageState.items.length
      ? `<div class="gallery-grid">${imageState.items.slice(0, imageState.visible).map(imageCardHtml).join('')}</div>`
      : `<div class="empty"><div class="empty-title">${esc(I.character_empty)}</div></div>`;
    imageSummary.textContent = imageState.items.length ? I.loaded(imageState.items.length) : '';
    imageMoreWrap.hidden = imageState.visible >= imageState.items.length && !imageState.hasMore;
    imageCards.refresh();
  };
  const loadImages = async (reset) => {
    if (!ctx.isActive()) return;
    imageController?.abort();
    imageController = new AbortController();
    const seq = ++imageState.seq;
    const imagePage = reset ? 1 : imageState.page + 1;
    imageState.loading = true;
    imageMore.disabled = true;
    imageMore.textContent = I.loading;
    imageGrid.setAttribute('aria-busy', 'true');
    imageMessage.hidden = true;
    if (reset) {
      imageSummary.textContent = I.loading;
      imageGrid.innerHTML = spinnerHtml();
    }
    const showImageError = (message) => {
      if (reset) imageGrid.innerHTML = '';
      imageSummary.textContent = imageState.items.length ? I.loaded(imageState.items.length) : '';
      imageMessage.hidden = false;
      imageMessage.innerHTML = `<div class="gallery-unavailable"><p>${esc(message)}</p><button class="btn btn-secondary" type="button" data-image-retry>${esc(I.retry)}</button></div>`;
      imageMessage.querySelector('[data-image-retry]').onclick = () => loadImages(reset);
    };
    try {
      const response = await getCharacterImagePage(chPath, imagePage, {
        signal: imageController.signal, cursor: reset ? '' : imageState.cursor || '',
      });
      if (seq !== imageState.seq || !ctx.isActive()) return;
      if (response?.available === false) { showImageError(I.mirror_unavailable); return; }
      const incoming = Array.isArray(response?.items) ? response.items.filter((item) => item && typeof item === 'object') : [];
      if (reset) { imageState.items = []; imageState.visible = 6; imageState.avatarFailed = false; }
      const seen = new Set(imageState.items.map((item) => item.id));
      imageState.items.push(...incoming.filter((item) => { if (seen.has(item.id)) return false; seen.add(item.id); return true; }));
      imageState.page = imagePage;
      imageState.cursor = typeof response?.next_cursor === 'string' ? response.next_cursor : '';
      imageState.hasMore = response?.has_more === true;
      if (!reset) imageState.visible = imageState.items.length;
      drawImages();
      drawHero();
    } catch (error) {
      if (seq !== imageState.seq || !ctx.isActive() || error?.name === 'AbortError') return;
      showImageError(imageErrorMessage(error));
    } finally {
      if (seq === imageState.seq && ctx.isActive()) {
        imageState.loading = false;
        imageGrid.setAttribute('aria-busy', 'false');
        imageMore.disabled = false;
        imageMore.textContent = I.more;
      }
    }
  };
  imageMore.onclick = () => {
    if (imageState.loading) return;
    if (imageState.visible < imageState.items.length) { imageState.visible = imageState.items.length; drawImages(); }
    else if (imageState.hasMore) loadImages(false);
  };

  // ---------- 全部设定（契约 §19.1） ----------
  const sheetEl = page.querySelector('[data-sheet]');
  const sheetState = { mode: new Map(), closed: new Set(), expanded: new Set() };
  function drawSheet() {
    const sh = chubSheet(ch);
    const nm = cardNames(ch);
    renderSheet(sheetEl, { orig: sh.orig, zh: sh.zh, chub: true, names: { char: nm.main, char_orig: nm.orig || nm.main, user: userName } }, sheetState);
  }

  drawHero();
  drawSheet();
  // 工具控件保持 DOM 与焦点；只有正文变化才重画设定，保留各区阅读状态。
  mountTranslationTools({ container: page.querySelector('[data-tr-tools]'), statusEl: page.querySelector('[data-tr-status]'),
    character: ch, path: chPath, source, ctx, onCharacter(next) {
      const contents = (c) => JSON.stringify([c.name, c.tagline, c.tags, c.data, c.greeting,
        c.name_zh, c.tagline_zh, c.tags_zh, c.data_zh, c.greeting_zh]);
      const changed = contents(ch) !== contents(next);
      ch = next;
      if (changed) { drawHero(); drawSheet(); }
    } });
  loadImages(true);

  // 拷贝并二次创作（契约 §12.2 / §12.5）：fork 成功后直接进编辑器
  const forkBtn = page.querySelector('[data-fork]');
  forkBtn.onclick = () => forkCard({ from: 'chub', path: chPath, source }, navigate, forkBtn);

  const startBtn = page.querySelector('[data-start]');
  const startLabel = latest ? C.new_chat : C.start;
  startBtn.onclick = async () => {
    startBtn.disabled = true;
    startBtn.lastElementChild.textContent = C.starting;
    try {
      const r = await post('/api/chats', { path: chPath, source });
      store.homeCache = null;
      navigate('#/chat/' + encodeURIComponent(r.chat.id));
    } catch (e) {
      toastError(e);
      startBtn.disabled = false;
      startBtn.lastElementChild.textContent = startLabel;
    }
  };

  // 我和 TA 的历史会话：标题用「时间 + 最后一句」，不重复角色名
  // 放在全部设定之后；默认只列最近 3 条，「查看全部」展开（最多 20 条）
  if (mine.length) {
    const sec = page.querySelector('[data-history]');
    const listEl = sec.querySelector('[data-history-list]');
    const allBtn = sec.querySelector('[data-history-all]');
    const HISTORY_FEW = 3;
    const all = mine.slice(0, 20);
    const drawHistory = (expanded) => {
      listEl.innerHTML = (expanded ? all : all.slice(0, HISTORY_FEW)).map((c) => `
      <a class="row" href="#/chat/${encodeURIComponent(c.id)}">
        <div class="row-main"><div class="row-title">${esc(previewText(c.last_message) || C.no_preview)}</div><div class="row-sub">${esc(C.last_chat)} · ${esc(fmtDateTime(c.updated_at))}</div></div>
        <div class="row-side">${esc(timeAgo(c.updated_at))}</div>
      </a>`).join('');
      allBtn.hidden = expanded || all.length <= HISTORY_FEW;
    };
    sec.hidden = false;
    allBtn.textContent = C.history_all(all.length);
    allBtn.onclick = () => { drawHistory(true); const a = listEl.querySelector('a.row:nth-child(' + (HISTORY_FEW + 1) + ')'); if (a) a.focus(); };
    drawHistory(false);
  }
}
