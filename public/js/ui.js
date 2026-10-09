// 通用界面组件：图标、头像、角色卡、提示、弹层。
import { zh } from '/i18n/zh.js';
import { esc, initial, fmtNum, encodeHashPath } from '/js/util.js';

const P = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  chats: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/>',
  me: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  admin: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  send: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chat_bubble: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  model: '<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  create: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  fork: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7"/><path d="M12 12v5"/>',
  upload: '<path d="M12 16V4"/><path d="m6 10 6-6 6 6"/><path d="M4 20h16"/>',
  download: '<path d="M12 4v12"/><path d="m6 10 6 6 6-6"/><path d="M4 20h16"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5"/><path d="M19 19v2H6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9"/><path d="m17 6 3 3"/><path d="m15 8 2 2"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z"/><path d="M14 6v12" stroke-dasharray="2 2"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
};

export function icon(name, cls = '') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}

/** 头像：有图用图（失败自动换成首字），无图用渐变首字。 */
export function avatar(src, name, cls = 'avatar', size) {
  const style = size ? ` style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px"` : '';
  const fb = `<div class="${cls} avatar-fallback"${style} aria-hidden="true">${esc(initial(name))}</div>`;
  if (!src) return fb;
  return `<img class="${cls}"${style} src="${esc(src)}" alt="" loading="lazy" decoding="async" data-fallback="${esc(initial(name))}">`;
}

/** 「上传文件开聊」醒目入口（首页 / 会话 / 创作页顶部，契约 §17.1） */
export function fileEntryHtml() {
  const F = zh.filechat;
  return `<a class="fc-entry" href="#/upload">
    <span class="fc-entry-ic">${icon('upload')}</span>
    <span class="fc-entry-main"><b>${esc(F.entry)}</b><span>${esc(F.entry_sub)}</span></span>
    ${icon('chevron', 'fc-entry-chev')}
  </a>`;
}

/** 文件会话的头像（契约 §17：没有角色，用文件图标） */
export function fileAvatar(cls = 'avatar', size) {
  const style = size ? ` style="width:${size}px;height:${size}px"` : '';
  return `<div class="${cls} avatar-fallback file-avatar"${style} aria-hidden="true">${icon('file')}</div>`;
}

// 图片加载失败 → 换成首字头像（全局捕获，不用内联事件）
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
  const div = document.createElement('div');
  div.className = img.className + ' avatar-fallback';
  div.setAttribute('style', img.getAttribute('style') || '');
  div.textContent = img.dataset.fallback;
  img.replaceWith(div);
}, true);

/** chub 卡名字（契约 §19.2）：有中文名时显示中文名 + 小字原名 */
export function cardNameParts(c) {
  const name = String((c && c.name) || '').trim();
  const nz = String((c && c.name_zh) || '').trim();
  if (nz && nz !== name) return { main: nz, orig: name };
  const o = String((c && (c.name_orig || c.original_name || c.name_original || c.name_en)) || '').trim();
  if (o && o !== name) return { main: name, orig: o };
  return { main: name, orig: '' };
}

export function characterHref(path, { source = 'local' } = {}) {
  return '#/c/' + encodeHashPath(path) + (source === 'remote' ? '?source=remote' : '');
}

export function cardHtml(c) {
  if (!c) return '';
  const tag = c.tagline_zh || c.tagline || '';
  const nm = cardNameParts(c);
  const source = c.source === 'remote' ? 'remote' : 'local';
  // 本地浏览不通过 CDN 或头像代理补图；缺图使用首字头像。
  const portrait = source === 'remote' ? c.avatar
    : typeof c.avatar === 'string' && /^\/api\/images\/[\w.-]+(?:\?|$)/.test(c.avatar) ? c.avatar : '';
  return `<a class="card" href="${esc(characterHref(c.path, { source }))}" data-path="${esc(c.path)}" data-source="${source}">
    <div class="card-img">${avatar(portrait, nm.main, 'card-avatar')}${c.nsfw ? '<span class="card-badge">18+</span>' : ''}</div>
    <div class="card-body">
      <div class="card-name">${esc(nm.main)}</div>
      ${nm.orig ? `<div class="card-orig">${esc(nm.orig)}</div>` : ''}
      <div class="card-tag">${esc(tag)}</div>
      <div class="card-meta">
        ${c.chats ? `<span>${icon('chat_bubble')}${fmtNum(c.chats)}</span>` : ''}
        ${c.stars ? `<span>${icon('star')}${fmtNum(c.stars)}</span>` : ''}
      </div>
    </div>
  </a>`;
}

/* ---------- 提示 ---------- */
let toastWrap;
export function toast(msg, type = '') {
  if (!toastWrap) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'toast-wrap';
    toastWrap.setAttribute('role', 'status');
    toastWrap.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastWrap);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  toastWrap.appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 3800 : 2400);
}
// 只显示服务端给的中文说明（ApiError 带 status）；浏览器原生英文异常换成通用提示
export const toastError = (e) => { if (e && e.name !== 'AbortError') toast((e && typeof e.status === 'number' && e.message) || zh.network_error, 'error'); };

/* ---------- 弹层 ---------- */
/** 打开底部弹层，返回 {el, close}。onClose 在关闭时调用。 */
export function openSheet(innerHtml, { onClose, label } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"${label ? ` aria-label="${esc(label)}"` : ''}><div class="sheet-grip"></div>${innerHtml}</div>`;
  const prevFocus = document.activeElement;
  let closed = false;
  const close = (val) => {
    if (closed) return;
    closed = true;
    ov.remove();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', onHash);
    if (prevFocus && prevFocus.focus) try { prevFocus.focus({ preventScroll: true }); } catch { /* */ }
    onClose && onClose(val);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const onHash = () => close();
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', onHash);
  document.body.appendChild(ov);
  const sheet = ov.querySelector('.sheet');
  return { el: sheet, close };
}

export function confirmDialog(text, { title = '', ok = zh.confirm, danger = false } = {}) {
  return new Promise((resolve) => {
    const s = openSheet(`
      ${title ? `<div class="sheet-title">${esc(title)}</div>` : ''}
      <p class="sheet-text">${esc(text)}</p>
      <div class="sheet-actions">
        <button class="btn" data-a="no">${esc(zh.cancel)}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-a="yes">${esc(ok)}</button>
      </div>`, { onClose: (v) => resolve(v === true) });
    s.el.querySelector('[data-a="no"]').onclick = () => s.close(false);
    const y = s.el.querySelector('[data-a="yes"]');
    y.onclick = () => s.close(true);
    y.focus();
  });
}

/** 菜单：items=[{icon,label,danger,value}]，返回所选 value 或 undefined；note = 列表上方一行小字 */
export function menu(items, { title, note } = {}) {
  return new Promise((resolve) => {
    const s = openSheet(`
      ${title ? `<div class="sheet-title">${esc(title)}</div>` : ''}
      ${note ? `<p class="menu-note">${esc(note)}</p>` : ''}
      <div class="menu-list">${items.map((it, i) => `<button class="menu-item${it.danger ? ' danger' : ''}" data-i="${i}">${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span></button>`).join('')}</div>`,
    { onClose: (v) => resolve(v) });
    s.el.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => s.close(items[+b.dataset.i].value); });
  });
}

/** 单个多行文本编辑 */
export function editTextDialog({ title, value = '', label = '' }) {
  return new Promise((resolve) => {
    const s = openSheet(`
      <div class="sheet-title">${esc(title)}</div>
      <div class="field">${label ? `<label for="dlg-t">${esc(label)}</label>` : ''}<textarea id="dlg-t" class="textarea" rows="6" aria-label="${esc(title)}"></textarea></div>
      <div class="sheet-actions">
        <button class="btn" data-a="no">${esc(zh.cancel)}</button>
        <button class="btn btn-primary" data-a="yes">${esc(zh.save)}</button>
      </div>`, { onClose: (v) => resolve(typeof v === 'string' ? v : null) });
    const ta = s.el.querySelector('textarea');
    ta.value = value;
    s.el.querySelector('[data-a="no"]').onclick = () => s.close(null);
    s.el.querySelector('[data-a="yes"]').onclick = () => s.close(ta.value);
    setTimeout(() => ta.focus(), 50);
  });
}

export function spinnerHtml() { return '<div class="center-pad"><div class="spinner"></div></div>'; }

export function errorHtml(msg) {
  return `<div class="empty"><div class="empty-title">${esc(msg || zh.network_error)}</div><button class="btn btn-sm" data-retry>${esc(zh.retry)}</button></div>`;
}

/** 复制文本到剪贴板（不支持时退回 execCommand），成功后提示 */
export async function copyText(text, okMsg = zh.copied) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0'; t.style.top = '0';
    document.body.appendChild(t); t.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    t.remove();
  }
  toast(ok ? okMsg : zh.copy_failed, ok ? '' : 'error');
  return ok;
}
