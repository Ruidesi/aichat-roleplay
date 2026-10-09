import { zh } from '/i18n/zh.js';
import { post } from '/js/api.js';
import { store } from '/js/store.js';
import { esc } from '/js/util.js';
import { loadMe, rebuildShell } from '/js/app.js';

export default async function login({ root, setTitle, navigate, query }) {
  setTitle(zh.login.submit);
  const L = zh.login;
  root.innerHTML = `<div class="login">
    <form class="login-card" novalidate>
      <img class="login-logo" src="/icons/icon.svg" alt="">
      <h1>${esc(store.siteName)}</h1>
      <p class="sub">${esc(L.subtitle)}</p>
      <div class="field"><label for="lg-u">${esc(L.username)}</label>
        <input id="lg-u" class="input" name="username" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" required></div>
      <div class="field"><label for="lg-p">${esc(L.password)}</label>
        <input id="lg-p" class="input" name="password" type="password" autocomplete="current-password" required></div>
      <div class="form-error" role="alert"></div>
      <button class="btn btn-primary btn-block" type="submit">${esc(L.submit)}</button>
      <nav class="auth-links" aria-label="${esc(L.links_label)}">
        <a href="#/register">${esc(L.register_link)}</a>
        <span aria-hidden="true">·</span>
        <a href="#/reset">${esc(L.forgot_link)}</a>
      </nav>
    </form>
  </div>`;
  const form = root.querySelector('form');
  const err = form.querySelector('.form-error');
  const btn = form.querySelector('button[type=submit]');
  // 从重置密码页回来时带上账号（#/login?u=xxx）
  const preset = query && query.get('u');
  if (preset) { form.username.value = preset; form.password.focus(); } else form.querySelector('#lg-u').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = form.username.value.trim();
    const password = form.password.value;
    if (!username || !password) { err.textContent = L.need_both; return; }
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = L.submitting;
    try {
      await post('/api/login', { username, password }, { allow401: true });
      await loadMe();
      rebuildShell();
      store.homeCache = null;
      navigate('#/', true);
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = L.submit;
      form.password.select();
    }
  });
}
