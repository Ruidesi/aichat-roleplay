// 用管理员发的一次性重置码设置新密码（契约 §13.3 / §13.4）：#/reset
import { zh } from '/i18n/zh.js';
import { post } from '/js/api.js';
import { store } from '/js/store.js';
import { esc } from '/js/util.js';
import { toast } from '/js/ui.js';

export default async function reset(ctx) {
  const { root, setTitle, navigate, query } = ctx;
  const R = zh.reset;
  setTitle(R.title);
  root.innerHTML = `<div class="login">
    <form class="login-card" novalidate>
      <img class="login-logo" src="/icons/icon.svg" alt="">
      <h1>${esc(R.title)}</h1>
      <p class="sub">${esc(R.subtitle)}</p>
      <div class="field"><label for="rs-u">${esc(R.username)}</label>
        <input id="rs-u" class="input" name="username" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" required></div>
      <div class="field"><label for="rs-c">${esc(R.code)}</label>
        <input id="rs-c" class="input code-input" name="code" maxlength="20" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" aria-describedby="rs-c-hint" required>
        <span class="hint" id="rs-c-hint">${esc(R.code_hint)}</span></div>
      <div class="field"><label for="rs-p">${esc(R.new_password)}</label>
        <input id="rs-p" class="input" name="password" type="password" minlength="8" autocomplete="new-password" required></div>
      <div class="field"><label for="rs-p2">${esc(R.new_password2)}</label>
        <input id="rs-p2" class="input" name="password2" type="password" minlength="8" autocomplete="new-password" required></div>
      <div class="form-error" role="alert"></div>
      <button class="btn btn-primary btn-block" type="submit">${esc(R.submit)}</button>
      <nav class="auth-links"><a href="#/login">${esc(R.back_login)}</a></nav>
    </form>
  </div>`;
  const form = root.querySelector('form');
  const err = form.querySelector('.form-error');
  const btn = form.querySelector('button[type=submit]');
  const presetUser = (query && query.get('u')) || '';
  const presetCode = (query && query.get('code')) || '';
  if (presetUser) form.username.value = presetUser;
  if (presetCode) form.code.value = presetCode.replace(/\s+/g, '');
  (presetUser ? (presetCode ? form.password : form.code) : form.username).focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const username = form.username.value.trim();
    // 重置码只去掉空白，不改大小写（以服务端签发的原样为准）
    const code = form.code.value.replace(/\s+/g, '');
    const pw = form.password.value;
    if (!username || !code || !pw) { err.textContent = R.need_all; return; }
    if (pw.length < 8) { err.textContent = zh.me.password_short; form.password.focus(); return; }
    if (pw !== form.password2.value) { err.textContent = zh.me.password_mismatch; form.password2.focus(); return; }
    btn.disabled = true;
    btn.textContent = R.submitting;
    try {
      await post('/api/password/reset', { username, code, new_password: pw }, { allow401: true });
      toast(R.done);
      // 重置会作废该账号全部登录：如果当前浏览器登的就是这个账号，本地状态也清掉
      if (store.me && store.me.username === username) {
        store.me = null;
        const { rebuildShell } = await import('/js/app.js');
        rebuildShell();
      }
      navigate('#/login?u=' + encodeURIComponent(username), true);
    } catch (ex) {
      if (!ctx.isActive()) return;
      err.textContent = (ex && ex.status && ex.message) || zh.network_error;
      btn.disabled = false;
      btn.textContent = R.submit;
    }
  });
}
