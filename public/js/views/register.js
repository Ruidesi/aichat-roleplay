// 邀请码注册（契约 §13.2 / §13.4）：#/register?code=XXXX
import { zh } from '/i18n/zh.js';
import { get, post } from '/js/api.js';
import { store } from '/js/store.js';
import { esc, debounce } from '/js/util.js';
import { icon, toast } from '/js/ui.js';
import { loadMe, rebuildShell } from '/js/app.js';
import { clearReadingAccount } from '/js/reading.js';

// 与后端 server/auth.mjs USERNAME_RE 保持一致
const USERNAME_RE = /^[A-Za-z0-9_.-]{2,32}$/;

// 10 位，去掉易混字符 0 O 1 I L，大写（契约 §13.1）
const CODE_RE = /^[A-HJKMNP-Z2-9]{10}$/;
export const normCode = (s) => String(s || '').toUpperCase().replace(/[\s-]+/g, '');

// 服务端给的原因：已知代码翻成中文；本身就是中文说明的照用；其余统一「邀请码无效」
function reasonText(reason) {
  const R = zh.register;
  if (!reason) return R.code_invalid;
  const k = String(reason).trim();
  if (R.reasons[k]) return R.reasons[k];
  if (/[一-鿿]/.test(k)) return k;
  return R.code_invalid;
}

export default async function register(ctx) {
  const { root, setTitle, navigate, query } = ctx;
  const R = zh.register;
  setTitle(R.title);
  const initialCode = normCode(query && query.get('code'));

  // 已登录：先说明，需要退出当前账号才能注册新账号
  if (store.me) {
    const nm = store.me.display_name || store.me.username || '';
    root.innerHTML = `<div class="login"><div class="login-card">
      <img class="login-logo" src="/icons/icon.svg" alt="">
      <h1>${esc(R.title)}</h1>
      <p class="sub">${esc(store.siteName)}</p>
      <div class="auth-notice" role="status">${esc(R.logged_in(nm))}
        <button class="btn btn-primary btn-block" type="button" data-logout>${esc(R.logout_continue)}</button>
      </div>
      <nav class="auth-links"><a href="#/">${esc(R.go_home)}</a></nav>
    </div></div>`;
    root.querySelector('[data-logout]').onclick = async (e) => {
      e.currentTarget.disabled = true;
      try { await post('/api/logout', {}, { allow401: true }); } catch { /* 照样继续 */ }
      clearReadingAccount(store);
      rebuildShell();
      if (ctx.isActive()) register(ctx);
    };
    return;
  }

  root.innerHTML = `<div class="login">
    <form class="login-card" novalidate>
      <img class="login-logo" src="/icons/icon.svg" alt="">
      <h1>${esc(R.title)}</h1>
      <p class="sub">${esc(R.subtitle)}</p>
      <div class="field"><label for="rg-c">${esc(R.code)}</label>
        <input id="rg-c" class="input code-input" name="code" maxlength="14" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" aria-describedby="rg-c-state rg-c-hint" required>
        <div class="code-state" id="rg-c-state" role="status" aria-live="polite"></div>
        <span class="hint" id="rg-c-hint">${esc(R.code_hint)}</span></div>
      <div class="field"><label for="rg-u">${esc(R.username)}</label>
        <input id="rg-u" class="input" name="username" maxlength="32" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" aria-describedby="rg-u-hint" required>
        <span class="hint" id="rg-u-hint">${esc(R.username_hint)}</span></div>
      <div class="field"><label for="rg-d">${esc(R.display_name)}</label>
        <input id="rg-d" class="input" name="display_name" maxlength="40" autocomplete="nickname" aria-describedby="rg-d-hint">
        <span class="hint" id="rg-d-hint">${esc(R.display_name_hint)}</span></div>
      <div class="field"><label for="rg-p">${esc(R.password)}</label>
        <input id="rg-p" class="input" name="password" type="password" minlength="8" autocomplete="new-password" required></div>
      <div class="field"><label for="rg-p2">${esc(R.password2)}</label>
        <input id="rg-p2" class="input" name="password2" type="password" minlength="8" autocomplete="new-password" required></div>
      <div class="form-error" role="alert"></div>
      <button class="btn btn-primary btn-block" type="submit">${esc(R.submit)}</button>
      <nav class="auth-links"><a href="#/login">${esc(R.have_account)}</a></nav>
    </form>
  </div>`;

  const form = root.querySelector('form');
  const err = form.querySelector('.form-error');
  const btn = form.querySelector('button[type=submit]');
  const codeIn = form.code;
  const stateEl = form.querySelector('#rg-c-state');

  // 邀请码状态：'' 未填 | 'format' 格式不对 | 'checking' | 'ok' | 'bad'
  let codeState = '';
  let codeMsg = '';
  let checkedCode = '';
  let checkSeq = 0;
  const paint = () => {
    stateEl.className = 'code-state' + (codeState === 'ok' ? ' ok' : codeState === 'bad' || codeState === 'format' ? ' bad' : '');
    if (codeState === 'ok') stateEl.innerHTML = `${icon('check')}<span>${esc(R.code_ok)}</span>`;
    else if (codeState === 'checking') stateEl.textContent = R.checking;
    else if (codeState === 'bad' || codeState === 'format') stateEl.textContent = codeMsg;
    else stateEl.textContent = '';
    if (codeState === 'bad' || codeState === 'format') codeIn.setAttribute('aria-invalid', 'true');
    else codeIn.removeAttribute('aria-invalid');
  };

  const check = async (showFormat) => {
    const code = normCode(codeIn.value);
    if (!code) { codeState = ''; checkedCode = ''; paint(); return; }
    if (!CODE_RE.test(code)) {
      // 输入过程中只在长度够了才提示格式问题，避免边打字边报错
      if (showFormat || code.length >= 10) { codeState = 'format'; codeMsg = R.code_bad_format; } else codeState = '';
      checkedCode = '';
      paint();
      return;
    }
    if (code === checkedCode && (codeState === 'ok' || codeState === 'bad')) return;
    const seq = ++checkSeq;
    codeState = 'checking';
    paint();
    let st = 'bad';
    let msg = '';
    try {
      const r = await get('/api/register/check?code=' + encodeURIComponent(code), { allow401: true });
      if (r && r.ok) st = 'ok';
      else msg = reasonText(r && r.reason);
    } catch (e) {
      msg = e && typeof e.status === 'number' && e.status && e.message ? e.message : zh.network_error;
      // 网络问题不算「邀请码无效」：不记 checkedCode，下次还会再查
      if (!e || !e.status) { if (seq === checkSeq && ctx.isActive()) { codeState = 'bad'; codeMsg = msg; checkedCode = ''; paint(); } return; }
    }
    if (seq !== checkSeq || !ctx.isActive()) return;
    codeState = st;
    codeMsg = msg;
    checkedCode = code;
    paint();
  };
  const checkSoon = debounce(() => check(false), 450);

  codeIn.addEventListener('input', () => {
    // 输入时就规范成大写、去掉空格（保留光标位置的简单处理：只有变化时才回写）
    const v = normCode(codeIn.value);
    if (v !== codeIn.value) codeIn.value = v;
    if (v !== checkedCode) { codeState = ''; paint(); }
    checkSoon();
  });
  codeIn.addEventListener('blur', () => check(true));

  if (initialCode) {
    codeIn.value = initialCode;
    check(true);
    form.username.focus();
  } else {
    codeIn.focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const code = normCode(codeIn.value);
    const username = form.username.value.trim();
    const display_name = form.display_name.value.trim();
    const password = form.password.value;
    if (!CODE_RE.test(code)) { err.textContent = R.need_code; codeIn.focus(); return; }
    if (codeState === 'bad' && checkedCode === code) { err.textContent = codeMsg || R.code_invalid; codeIn.focus(); return; }
    if (!username) { err.textContent = R.need_username; form.username.focus(); return; }
    if (!USERNAME_RE.test(username)) { err.textContent = R.username_bad; form.username.focus(); return; }
    if (password.length < 8) { err.textContent = R.password_short; form.password.focus(); return; }
    if (password !== form.password2.value) { err.textContent = R.password_mismatch; form.password2.focus(); return; }
    btn.disabled = true;
    btn.textContent = R.submitting;
    try {
      await post('/api/register', { code, username, display_name: display_name || username, password }, { allow401: true });
      await loadMe();
      rebuildShell();
      store.homeCache = null;
      toast(R.done);
      navigate('#/', true);
    } catch (ex) {
      if (!ctx.isActive()) return;
      err.textContent = (ex && ex.status && ex.message) || zh.network_error;
      btn.disabled = false;
      btn.textContent = R.submit;
      // 邀请码问题（过期 / 用完）时重新核对一遍，让状态行同步
      checkedCode = '';
      check(true);
    }
  });
}
