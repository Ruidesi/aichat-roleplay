// 抓取图片的共享显示与请求边界；原图只在用户打开预览时加载。
import { zh } from '/i18n/zh.js';
import { get } from '/js/api.js';
import { esc, encodeHashPath } from '/js/util.js';
import { icon } from '/js/ui.js';

export const IMAGE_KINDS = ['all', 'avatar', 'fullimg', 'gallery'];

/** 仅允许应用自身受保护的图片路由，拒绝外链、脚本和不受保护文件。 */
export function safeImageUrl(value) {
  if (typeof value !== 'string' || !value || /[\s\\\u0000-\u001f]/u.test(value) || value.startsWith('//')) return '';
  try {
    const origin = globalThis.location?.origin || 'http://localhost';
    const url = new URL(value, origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    if (!/^\/api\/images\/[^/]+$/.test(url.pathname)) return '';
    return url.pathname + url.search;
  } catch { return ''; }
}

export function imageTitle(item) {
  const I = zh.images;
  const name = String(item?.character_name || item?.character_path || I.gallery_image);
  const kind = I.types[item?.kind] || I.gallery_image;
  return `${name} · ${kind}`;
}

export function galleryHref({ kind = 'all', q = '', character = '' } = {}) {
  const p = new URLSearchParams();
  if (IMAGE_KINDS.includes(kind) && kind !== 'all') p.set('kind', kind);
  if (q) p.set('q', q);
  if (character) p.set('character', character);
  const query = p.toString();
  return '#/gallery' + (query ? '?' + query : '');
}

export function galleryEntryHtml({ compact = false } = {}) {
  const I = zh.images;
  return `<a class="images-entry${compact ? ' compact' : ''}" href="#/gallery">${icon('image')}
    <span><b>${esc(I.entry)}</b>${compact ? '' : `<span>${esc(I.entry_lead)}</span>`}</span>${icon('chevron')}</a>`;
}

export function getImagePage({ kind = 'all', q = '', character = '', page = 1, cursor = '' } = {}, opts = {}) {
  const p = new URLSearchParams({ kind: IMAGE_KINDS.includes(kind) ? kind : 'all', q, character,
    page: String(Math.max(1, Math.floor(Number(page) || 1))), limit: '24' });
  if (cursor) p.set('cursor', cursor);
  return get('/api/images?' + p.toString(), opts);
}

export function getCharacterImagePage(path, page = 1, opts = {}) {
  const p = new URLSearchParams({ path, page: String(Math.max(1, Math.floor(Number(page) || 1))), limit: '24' });
  if (opts.cursor) p.set('cursor', opts.cursor);
  return get('/api/character-images?' + p.toString(), opts);
}

export function imageErrorMessage(error, { download = false } = {}) {
  const I = zh.images;
  if (error?.status === 401) return zh.session_expired;
  if (error?.status === 403) return I.permission_denied;
  if (error?.status === 404) return I.not_found;
  if (download) return globalThis.navigator?.onLine === false ? I.offline : I.download_failed;
  if (globalThis.navigator?.onLine === false || error?.status === 0) return I.offline;
  return I.load_failed;
}

export function imageCardHtml(item, index) {
  const I = zh.images;
  const thumb = safeImageUrl(item?.thumbnail_url);
  const original = safeImageUrl(item?.original_url);
  const title = imageTitle(item);
  const path = String(item?.character_path || '');
  return `<article class="image-card${thumb ? ' is-loading' : ' is-missing'}">
    <button class="image-open" type="button" data-image-index="${index}" aria-label="${esc(I.open(index + 1))}：${esc(title)}"${original ? '' : ' disabled'}>
      ${thumb ? `<img class="image-thumb" src="${esc(thumb)}" alt="" loading="lazy" decoding="async" data-image-thumb>` : ''}
      <span class="image-thumb-status" aria-hidden="true">${thumb ? esc(I.loading) : `${icon('image')}<span>${esc(I.source_unavailable)}</span>`}</span>
    </button>
    <div class="image-card-meta"><div class="image-card-title">${esc(item?.character_name || path || I.gallery_image)}</div>
      <span class="image-card-type">${esc(I.types[item?.kind] || I.gallery_image)}</span>
      ${path ? `<a class="image-card-link" href="#/c/${encodeHashPath(path)}">${esc(I.character_link)}${icon('chevron')}</a>` : ''}
    </div></article>`;
}

/** 对真实图片load/error事件提供可读状态；事件委托也适用于后续追加的页。 */
export function bindImageCards(container, { getItems, onOpen }) {
  const update = (img, failed) => {
    const card = img.closest('.image-card');
    if (!card) return;
    card.classList.remove('is-loading');
    card.classList.toggle('is-missing', failed);
    img.hidden = failed;
    const status = card.querySelector('.image-thumb-status');
    status.hidden = !failed;
    if (failed) status.textContent = globalThis.navigator?.onLine === false ? zh.images.offline : zh.images.load_image_failed;
  };
  const onLoad = (event) => { if (event.target.matches?.('[data-image-thumb]')) update(event.target, false); };
  const onError = (event) => { if (event.target.matches?.('[data-image-thumb]')) update(event.target, true); };
  const onClick = (event) => {
    const button = event.target.closest?.('[data-image-index]');
    if (!button || !container.contains(button) || button.disabled) return;
    const index = Number(button.dataset.imageIndex);
    const items = getItems();
    if (Number.isInteger(index) && items[index]) onOpen(items, index, button);
  };
  container.addEventListener('load', onLoad, true);
  container.addEventListener('error', onError, true);
  container.addEventListener('click', onClick);
  return {
    refresh() {
      container.querySelectorAll('[data-image-thumb]').forEach((img) => { if (img.complete) update(img, img.naturalWidth === 0); });
    },
    dispose() {
      container.removeEventListener('load', onLoad, true);
      container.removeEventListener('error', onError, true);
      container.removeEventListener('click', onClick);
    },
  };
}
