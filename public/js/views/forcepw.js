// 首次登录强制改密（契约 §13.3 / §13.4）：#/set-password，不能跳过，可以退出
import { zh } from '/i18n/zh.js';
import { post } from '/js/api.js';
import { store } from '/js/store.js';
import { esc } from '/js/util.js';
import { icon, toast } from '/js/ui.js';
import { loadMe, rebuildShell } from '/js/app.js';
import { applyReadingSettings } from '/js/reading.js';

export default async function forcepw(ctx) {
  const { root, setTitle, navigate } = ctx;
  const F = zh.force_password;
  setTitle(F.title);
  const u = store.me || {};
  root.innerHTML = `<div class="login">
    <form class="login-card" novalidate>
      <img class="login-logo" src="/icons/icon.svg" alt="">
      <h1>${esc(F.title)}</h1>
      <p class="sub">${esc(zh.me.account)}：${esc(u.username || '')}</p>
      <div class="warn-bar" role="note">${icon('lock')}<span>${esc(F.lead)}</span></div>
      <input type="text" name="username" autocomplete="username" value="${esc(u.username || '')}" hidden>
      <div class="field"><label for="fp-o">${esc(F.old_password)}</label>
        <input id="fp-o" class="input" name="old" type="password" autocomplete="current-password" required></div>
      <div class="field"><label for="fp-n">${esc(F.new_password)}</label>
        <input id="fp-n" class="input" name="nw" type="password" minlength="8" autocomplete="new-password" required></div>
      <div class="field"><label for="fp-n2">${esc(F.new_password2)}</label>
        <input id="fp-n2" class="input" name="nw2" type="password" minlength="8" autocomplete="new-password" required></div>
      <div class="form-error" role="alert"></div>
      <button class="btn btn-primary btn-block" type="submit">${esc(F.submit)}</button>
      <nav class="auth-links"><button type="button" class="btn btn-sm" data-logout>${icon('logout')}<span>${esc(F.logout)}</span></button></nav>
    </form>
  </div>`;
  const form = root.querySelector('form');
  const err = form.querySelector('.form-error');
  const btn = form.querySelector('button[type=submit]');
  form.old.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const old = form.old.value;
    const nw = form.nw.value;
    if (!old) { err.textContent = F.need_old; form.old.focus(); return; }
    if (nw.length < 8) { err.textContent = zh.me.password_short; form.nw.focus(); return; }
    if (nw !== form.nw2.value) { err.textContent = zh.me.password_mismatch; form.nw2.focus(); return; }
    if (nw === old) { err.textContent = F.same_as_old; form.nw.focus(); return; }
    btn.disabled = true;
    btn.textContent = F.submitting;
    try {
      await post('/api/me/password', { old_password: old, new_password: nw });
      // 以服务端为准刷新一次；拿不到就本地清掉标记
      try { await loadMe(); } catch { /* */ }
      if (store.me) store.me.must_change_password = false;
      rebuildShell();
      toast(F.done);
      navigate('#/', true);
    } catch (ex) {
      if (!ctx.isActive()) return;
      err.textContent = (ex && ex.status && ex.message) || zh.network_error;
      btn.disabled = false;
      btn.textContent = F.submit;
    }
  });

  root.querySelector('[data-logout]').onclick = async (e) => {
    e.currentTarget.disabled = true;
    try { await post('/api/logout', {}, { allow401: true }); } catch { /* 照样回登录页 */ }
    store.me = null;
    applyReadingSettings(null);
    store.homeCache = null;
    rebuildShell();
    navigate('#/login', true);
  };
}
