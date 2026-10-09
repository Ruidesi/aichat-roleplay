// 入口：登录态、外壳（底部 Tab / 桌面侧栏）、hash 路由
import { zh } from '/i18n/zh.js';
import { get, setUnauthorizedHandler, setMustChangeHandler, ApiError } from '/js/api.js';
import { store } from '/js/store.js';
import { esc, isManager, isSuper } from '/js/util.js';
import { icon, errorHtml } from '/js/ui.js';
import { applyReadingSettings } from '/js/reading.js';

const app = document.getElementById('app');
let cleanup = null;
let renderSeq = 0;

const routes = [
  { re: /^\/login$/, view: 'login', public: true },
  // v0.8 邀请码注册 / 重置码改密 / 首次登录强制改密（契约 §13.4）
  { re: /^\/register$/, view: 'register', public: true },
  { re: /^\/reset$/, view: 'reset', public: true },
  { re: /^\/set-password$/, view: 'forcepw', bare: true },
  { re: /^\/?$/, view: 'home', tab: 'home' },
  { re: /^\/search$/, view: 'search', tab: 'search' },
  { re: /^\/gallery$/, view: 'gallery', tab: 'search' },
  { re: /^\/c\/(.+)$/, view: 'character', tab: 'home' },
  // v0.7 自建卡（契约 §12.5）
  { re: /^\/create$/, view: 'create', tab: 'create' },
  { re: /^\/cards\/new$/, view: 'editor', tab: 'create' },
  { re: /^\/cards\/([^/]+)\/edit$/, view: 'editor', tab: 'create' },
  { re: /^\/u\/([^/]+)$/, view: 'ucard' }, // 从「发现」或「创作」都会进来：不改当前高亮的 Tab
  { re: /^\/chat\/([^/]+)$/, view: 'chat', tab: 'chats', chat: true },
  { re: /^\/chats$/, view: 'chats', tab: 'chats' },
  // v1.0 上传文件快速开聊（契约 §17）
  { re: /^\/upload$/, view: 'upload', tab: 'chats' },
  { re: /^\/me$/, view: 'me', tab: 'me' },
  { re: /^\/me\/logins$/, view: 'logins', tab: 'me' }, // 契约 §14
  { re: /^\/admin$/, view: 'admin', tab: 'admin', admin: true },
  { re: /^\/admin\/card\/([^/]+)$/, view: 'admincard', tab: 'admin', admin: true, super: true },
];

function parseHash() {
  let h = location.hash.replace(/^#/, '') || '/';
  if (!h.startsWith('/')) h = '/' + h;
  const qi = h.indexOf('?');
  const path = qi === -1 ? h : h.slice(0, qi);
  const query = new URLSearchParams(qi === -1 ? '' : h.slice(qi + 1));
  return { path, query };
}

export function navigate(hash, replace = false) {
  if (replace) {
    history.replaceState(null, '', hash);
    route();
  } else if (location.hash === hash) {
    route();
  } else {
    location.hash = hash;
  }
}

function setTitle(t) {
  document.title = t ? `${t} · ${store.siteName}` : store.siteName;
}

function shellHtml() {
  const tabs = [
    ['home', '#/', zh.nav.home],
    ['search', '#/search', zh.nav.search],
    ['create', '#/create', zh.nav.create],
    ['chats', '#/chats', zh.nav.chats],
    ['me', '#/me', zh.nav.me],
  ];
  if (isManager(store.me)) tabs.push(['admin', '#/admin', zh.nav.admin]);
  return `<div class="shell">
    <nav class="nav" aria-label="${esc(zh.nav.home)}">
      <div class="nav-brand"><img src="/icons/icon.svg" alt=""><span class="brand-name">${esc(store.siteName)}</span></div>
      ${tabs.map(([k, href, label]) => `<a href="${href}" data-tab="${k}">${icon(k)}<span>${esc(label)}</span></a>`).join('')}
    </nav>
    <main class="main" id="main"></main>
  </div>`;
}

let shellBuilt = false;
export function rebuildShell() { shellBuilt = false; }

// 离开保护（编辑器有未保存修改时）：返回 false 则留在原页
let leaveGuard = null;
let currentHash = location.hash;
export function setLeaveGuard(fn) { leaveGuard = fn || null; }
// 视图用 replaceState 改了地址（不触发路由）后调用，让离开保护按新地址回退
export function noteHashReplaced() { currentHash = location.hash; }

async function route() {
  if (leaveGuard && location.hash !== currentHash) {
    const target = location.hash;
    const guard = leaveGuard;
    const seq0 = ++renderSeq;
    history.replaceState(null, '', currentHash || '#/');
    let ok = false;
    try { ok = await guard(); } catch { ok = false; }
    if (seq0 !== renderSeq) return;
    if (!ok) return;
    leaveGuard = null;
    history.replaceState(null, '', target);
  }
  currentHash = location.hash;
  const seq = ++renderSeq;
  const { path, query } = parseHash();
  let r = routes.find((x) => x.re.test(path));
  if (!r) { navigate('#/', true); return; }
  const m = path.match(r.re);

  if (!r.public && !store.me) { navigate('#/login', true); return; }
  // 首次登录未改初始密码：除「设置新密码」页外哪儿也去不了（可退出）
  if (store.me && mustChangePassword(store.me) && r.view !== 'forcepw') { navigate('#/set-password', true); return; }
  if (r.view === 'forcepw' && !mustChangePassword(store.me)) { navigate('#/', true); return; }
  if (r.view === 'login' && store.me) { navigate('#/', true); return; }
  if (r.admin && !isManager(store.me)) { navigate('#/', true); return; }
  if (r.super && !isSuper(store.me)) { navigate('#/admin', true); return; }

  leaveGuard = null;
  if (cleanup) { try { cleanup(); } catch { /* */ } cleanup = null; }
  applyReadingSettings(store.me?.reading_settings);

  let root;
  if (r.public || r.bare) {
    shellBuilt = false;
    app.innerHTML = '<div id="main"></div>';
    root = app.firstChild;
  } else {
    if (!shellBuilt) { app.innerHTML = shellHtml(); shellBuilt = true; }
    const shell = app.querySelector('.shell');
    shell.classList.toggle('chat-mode', !!r.chat);
    if (r.tab) app.querySelectorAll('.nav a').forEach((a) => {
      const on = a.dataset.tab === r.tab;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    root = app.querySelector('#main');
  }
  root.innerHTML = '';
  window.scrollTo(0, 0);

  try {
    const mod = await import(`/js/views/${r.view}.js`);
    if (seq !== renderSeq) return;
    const ctx = {
      root, query, params: m.slice(1), setTitle, navigate,
      isActive: () => seq === renderSeq,
      onCleanup: (fn) => { const prev = cleanup; cleanup = () => { prev && prev(); fn(); }; },
    };
    await mod.default(ctx);
  } catch (e) {
    if (seq !== renderSeq) return;
    console.error(e);
    root.innerHTML = errorHtml(e instanceof ApiError ? e.message : zh.network_error);
    const b = root.querySelector('[data-retry]');
    if (b) b.onclick = () => route();
  }
}

export async function loadMe() {
  try {
    const r = await get('/api/me', { allow401: true });
    store.me = r.user || null; // v0.9 F9：未登录时服务端回 200 {user:null}（旧版回 401，下面仍兼容）
    applyReadingSettings(store.me?.reading_settings);
    // must_change_password 可能在 user 里，也可能在顶层（契约 §13.3 未限定位置）
    if (store.me && r.must_change_password != null && store.me.must_change_password == null) store.me.must_change_password = r.must_change_password;
    if (r.site_name) store.siteName = r.site_name;
    return true;
  } catch (e) {
    if (e.status === 401) { store.me = null; applyReadingSettings(null); return true; }
    throw e;
  }
}

setUnauthorizedHandler(() => {
  applyReadingSettings(null);
  if (!store.me) return;
  store.me = null;
  shellBuilt = false;
  import('/js/ui.js').then(({ toast }) => toast(zh.session_expired));
  navigate('#/login', true);
});

setMustChangeHandler(() => {
  applyReadingSettings(store.me?.reading_settings);
  if (!store.me) return;
  store.me.must_change_password = true;
  if (parseHash().path !== '/set-password') navigate('#/set-password', true);
});

export function mustChangePassword(u) {
  const v = u && u.must_change_password;
  return v === true || v === 1 || v === '1';
}

async function boot() {
  try {
    await loadMe();
  } catch (e) {
    app.innerHTML = `<div class="boot">${errorHtml(e.message)}</div>`;
    app.querySelector('[data-retry]').onclick = boot;
    return;
  }
  setTitle('');
  window.addEventListener('hashchange', route);
  route();
}

boot();
