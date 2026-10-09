// 原图预览：原生模态对话框、键盘切图、受保护下载与焦点恢复。
import { zh } from '/i18n/zh.js';
import { ApiError } from '/js/api.js';
import { esc, encodeHashPath } from '/js/util.js';
import { icon } from '/js/ui.js';
import { safeImageUrl, imageTitle, imageErrorMessage } from '/js/images.js';

let activeViewer = null;

/** 单指横滑切图；保留纵向滚动与多指缩放，离页可彻底解绑。 */
export function bindImageSwipe(stage, { previous, next }) {
  const pointers = new Set();
  let start = null;
  const onDown = (event) => {
    if (event.pointerType !== 'touch') return;
    pointers.add(event.pointerId);
    start = pointers.size === 1 ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
  };
  const onUp = (event) => {
    if (event.pointerType !== 'touch') return;
    pointers.delete(event.pointerId);
    const first = start;
    start = null;
    if (!first || first.id !== event.pointerId || pointers.size) return;
    const dx = event.clientX - first.x;
    const dy = event.clientY - first.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
    if (dx < 0) next(); else previous();
  };
  const onCancel = (event) => { pointers.delete(event.pointerId); start = null; };
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onCancel);
  return () => {
    stage.removeEventListener('pointerdown', onDown);
    stage.removeEventListener('pointerup', onUp);
    stage.removeEventListener('pointercancel', onCancel);
    pointers.clear(); start = null;
  };
}

export function openImageViewer(items, { index = 0, onClose, returnFocus } = {}) {
  const images = (Array.isArray(items) ? items : []).filter((item) => item && safeImageUrl(item.original_url));
  if (!images.length) return { close() {} };
  const requested = items[index];
  index = Math.max(0, images.indexOf(requested));
  activeViewer?.close();
  const I = zh.images;
  const previousFocus = document.activeElement;
  const previousOverflow = document.body.style.overflow;
  const dialog = document.createElement('dialog');
  dialog.className = 'image-viewer';
  dialog.setAttribute('aria-label', I.preview);
  dialog.innerHTML = `<div class="image-viewer-head"><h2 data-image-title></h2>
    <button class="icon-btn" type="button" data-image-close aria-label="${esc(I.close)}">${icon('x')}</button></div>
    <div class="image-viewer-stage" aria-busy="true"><img hidden alt="" decoding="async" data-image-full>
      <div class="image-viewer-status" role="status" aria-live="polite" data-image-status></div>
      <button class="btn btn-sm" type="button" data-image-retry hidden>${esc(I.retry_image)}</button></div>
    <div class="image-viewer-controls"><button class="btn btn-secondary" type="button" data-image-prev>${icon('back')}<span>${esc(I.previous)}</span></button>
      <span data-image-position role="status" aria-live="polite"></span>
      <button class="btn btn-secondary" type="button" data-image-next><span>${esc(I.next)}</span>${icon('chevron')}</button></div>
    <div class="image-viewer-actions"><a class="btn btn-secondary" data-image-original target="_blank" rel="noopener noreferrer">${icon('image')}<span>${esc(I.view_original)}</span></a>
      <button class="btn btn-secondary" type="button" data-image-download>${icon('download')}<span>${esc(I.download)}</span></button>
      <a class="btn btn-secondary" data-image-character>${icon('user')}<span>${esc(I.character_link)}</span></a></div>
    <p class="image-viewer-caption" data-image-download-status role="status" aria-live="polite" hidden></p>`;
  const image = dialog.querySelector('[data-image-full]');
  const stage = dialog.querySelector('.image-viewer-stage');
  const status = dialog.querySelector('[data-image-status]');
  const retry = dialog.querySelector('[data-image-retry]');
  const previous = dialog.querySelector('[data-image-prev]');
  const next = dialog.querySelector('[data-image-next]');
  const download = dialog.querySelector('[data-image-download]');
  const downloadStatus = dialog.querySelector('[data-image-download-status]');
  let closed = false, loadSeq = 0, downloadController = null, stopSwipe = null;

  const close = () => {
    if (closed) return;
    closed = true;
    ++loadSeq;
    downloadController?.abort();
    stopSwipe?.();
    window.removeEventListener('hashchange', close);
    if (dialog.open && typeof dialog.close === 'function') dialog.close();
    dialog.remove();
    document.body.style.overflow = previousOverflow;
    if (activeViewer?.close === close) activeViewer = null;
    const focus = typeof returnFocus === 'function' ? returnFocus() : returnFocus || previousFocus;
    if (focus?.isConnected) try { focus.focus({ preventScroll: true }); } catch { /* 浏览器移除了原入口 */ }
    onClose?.();
  };

  function show(position) {
    index = Math.max(0, Math.min(images.length - 1, position));
    const item = images[index];
    const seq = ++loadSeq;
    downloadController?.abort();
    downloadController = null;
    download.disabled = !safeImageUrl(item.download_url);
    download.querySelector('span').textContent = I.download;
    downloadStatus.hidden = true;
    dialog.querySelector('[data-image-title]').textContent = imageTitle(item);
    dialog.querySelector('[data-image-position]').textContent = I.position(index + 1, images.length);
    previous.disabled = index === 0;
    next.disabled = index === images.length - 1;
    dialog.querySelector('[data-image-original]').href = safeImageUrl(item.original_url);
    const characterLink = dialog.querySelector('[data-image-character]');
    characterLink.hidden = !item.character_path;
    if (item.character_path) characterLink.href = '#/c/' + encodeHashPath(item.character_path);
    stage.setAttribute('aria-busy', 'true');
    stage.classList.remove('is-missing');
    status.hidden = false;
    status.textContent = I.loading;
    retry.hidden = true;
    image.hidden = true;
    image.alt = imageTitle(item);
    image.onload = () => {
      if (closed || seq !== loadSeq) return;
      stage.setAttribute('aria-busy', 'false');
      image.hidden = false;
      status.hidden = true;
      retry.hidden = true;
    };
    image.onerror = () => {
      if (closed || seq !== loadSeq) return;
      stage.setAttribute('aria-busy', 'false');
      stage.classList.add('is-missing');
      image.hidden = true;
      status.hidden = false;
      status.textContent = globalThis.navigator?.onLine === false ? I.offline : I.load_image_failed;
      retry.hidden = false;
    };
    image.src = safeImageUrl(item.original_url);
  }

  download.onclick = async () => {
    const item = images[index];
    const url = safeImageUrl(item.download_url);
    if (!url || downloadController) return;
    const controller = downloadController = new AbortController();
    const seq = loadSeq;
    download.disabled = true;
    download.querySelector('span').textContent = I.downloading;
    downloadStatus.hidden = true;
    try {
      const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new ApiError(I.download_failed, response.status);
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) throw new ApiError(I.source_unavailable, 404);
      const blob = await response.blob();
      if (!blob.size) throw new ApiError(I.source_unavailable, 404);
      if (closed || seq !== loadSeq || controller.signal.aborted) return;
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' })[contentType.split(';')[0]] || 'img';
      anchor.href = objectUrl;
      anchor.download = `${imageTitle(item).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120)}.${extension}`;
      anchor.hidden = true;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      downloadStatus.textContent = I.download_started;
      downloadStatus.hidden = false;
    } catch (error) {
      if (closed || seq !== loadSeq || error?.name === 'AbortError') return;
      downloadStatus.textContent = imageErrorMessage(error, { download: true });
      downloadStatus.hidden = false;
    } finally {
      if (!closed && seq === loadSeq && downloadController === controller) {
        downloadController = null;
        download.disabled = false;
        download.querySelector('span').textContent = I.download;
      }
    }
  };

  dialog.querySelector('[data-image-close]').onclick = close;
  previous.onclick = () => { if (index > 0) show(index - 1); };
  next.onclick = () => { if (index < images.length - 1) show(index + 1); };
  stopSwipe = bindImageSwipe(stage, { previous: previous.onclick, next: next.onclick });
  retry.onclick = () => { image.removeAttribute('src'); show(index); };
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('close', close);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
  dialog.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); previous.onclick(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); next.onclick(); }
    else if (event.key === 'Home') { event.preventDefault(); if (index !== 0) show(0); }
    else if (event.key === 'End') { event.preventDefault(); if (index !== images.length - 1) show(images.length - 1); }
  });
  document.body.appendChild(dialog);
  document.body.style.overflow = 'hidden';
  dialog.showModal();
  window.addEventListener('hashchange', close);
  activeViewer = { close };
  show(index);
  dialog.querySelector('[data-image-close]').focus({ preventScroll: true });
  return activeViewer;
}
