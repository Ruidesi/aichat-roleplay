import { zh } from '/i18n/zh.js';
import { patch, post } from '/js/api.js';
import { store } from '/js/store.js';
import { esc, initial, roleOf } from '/js/util.js';
import { icon, confirmDialog, toast, toastError, spinnerHtml, errorHtml } from '/js/ui.js';
import { loadModels, findModel, modelOptionsHtml, wireRadioGroup } from '/js/models.js';
import { readingFormHtml, mountReadingSettings } from '/js/reading-ui.js';
import { applyReadingSettings, createProfileSession } from '/js/reading.js';

export default async function me(ctx) {
  const { root, setTitle, navigate } = ctx;
  const M = zh.me;
  setTitle(M.title);
  const u = store.me || {};
  const shown = u.display_name || u.username || '';

  root.innerHTML = `<div class="page page-narrow">
    <h1 class="page-title">${esc(M.title)}</h1>
    <div class="me-head">
      <div class="avatar-fallback">${esc(initial(shown))}</div>
      <div style="min-width:0"><b data-shown>${esc(shown)}${roleOf(u) && roleOf(u) !== 'tenant' ? `<span class="badge">${esc(zh.roles[roleOf(u)])}</span>` : ''}</b>
      <span class="muted small">${esc(M.account)}：${esc(u.username)}</span></div>
    </div>

    <form class="panel panel-pad" data-profile novalidate>
      <div class="field"><label for="me-dn">${esc(M.display_name)}</label>
        <input id="me-dn" class="input" name="display_name" maxlength="40" autocomplete="nickname" aria-describedby="me-dn-err" required>
        <div class="form-error" id="me-dn-err" role="alert"></div></div>
      <div class="field" style="margin-top:20px"><span class="label">${esc(M.persona)}</span><span class="hint">${esc(M.persona_hint)}</span></div>
      <div class="field"><label for="me-pn">${esc(M.persona_name)}</label>
        <input id="me-pn" class="input" name="persona_name" maxlength="40"></div>
      <div class="field"><label for="me-pd">${esc(M.persona_desc)}</label>
        <textarea id="me-pd" class="textarea" name="persona_desc" rows="4" maxlength="2000"></textarea></div>
      <button class="btn btn-primary btn-block" type="submit">${esc(zh.save)}</button>
    </form>

    ${readingFormHtml()}

    <div class="panel" data-model-panel>
      <div class="panel-title" id="me-model-t">${esc(M.default_model)}</div>
      <p class="panel-hint">${esc(M.default_model_hint)}</p>
      <div data-model-body>${spinnerHtml()}</div>
    </div>

    <div class="panel">
      <div class="panel-title">${esc(M.content)}</div>
      <label class="row" for="me-nsfw">
        <div class="row-main"><div class="row-title">${esc(M.nsfw)}</div><div class="row-sub" style="white-space:normal">${esc(M.nsfw_hint)}</div></div>
        <span class="switch"><input id="me-nsfw" type="checkbox" role="switch"><span></span></span>
      </label>
    </div>

    <div class="panel">
      <div class="panel-title">${esc(zh.voice.setting_title)}</div>
      <label class="row" for="me-vas">
        <div class="row-main"><div class="row-title">${esc(zh.voice.auto_send)}</div><div class="row-sub" style="white-space:normal">${esc(zh.voice.auto_send_hint)}</div></div>
        <span class="switch"><input id="me-vas" type="checkbox" role="switch"><span></span></span>
      </label>
    </div>

    <div class="panel">
      <div class="panel-title">${esc(M.security)}</div>
      <a class="row" href="#/me/logins" data-logins>${icon('history')}<div class="row-main"><div class="row-title">${esc(M.logins)}</div><div class="row-sub">${esc(M.logins_sub)}</div></div>${icon('chevron')}</a>
    </div>

    <form class="panel panel-pad" data-pw id="me-password" novalidate>
      <div class="field"><span class="label" style="font-size:15px;color:var(--text)">${esc(M.password)}</span></div>
      <div class="field"><label for="me-op">${esc(M.old_password)}</label><input id="me-op" class="input" type="password" name="old" autocomplete="current-password"></div>
      <div class="field"><label for="me-np">${esc(M.new_password)}</label><input id="me-np" class="input" type="password" name="nw" autocomplete="new-password" minlength="8"></div>
      <div class="field"><label for="me-np2">${esc(M.new_password2)}</label><input id="me-np2" class="input" type="password" name="nw2" autocomplete="new-password" minlength="8"></div>
      <div class="form-error" role="alert"></div>
      <button class="btn btn-block" type="submit">${esc(M.password)}</button>
    </form>

    <div class="panel"><button class="row danger" data-logout>${icon('logout')}<span>${esc(M.logout)}</span></button></div>
    <div style="height:24px"></div>
  </div>`;

  mountReadingSettings(root.querySelector('[data-reading]'), ctx);

  const pf = root.querySelector('[data-profile]');
  pf.display_name.value = u.display_name || '';
  pf.persona_name.value = u.persona_name || '';
  pf.persona_desc.value = u.persona_desc || '';
  const profileKeys = ['display_name', 'persona_name', 'persona_desc'];
  function updateProfileHeader() {
    const name = store.me.display_name || store.me.username;
    root.querySelector('[data-shown]').firstChild.textContent = name;
    root.querySelector('.me-head .avatar-fallback').textContent = initial(name);
  }
  const profileSession = createProfileSession({
    getUser: () => store.me, persist: (body) => patch('/api/me', body),
    onDraftChange: (draft, { fields }) => {
      if (ctx.isActive() && store.me === u) {
        for (const key of fields) pf[key].value = draft[key];
        updateProfileHeader();
      }
    },
  });
  const editProfile = (e) => {
    const key = e.target?.name;
    if (profileKeys.includes(key)) profileSession.edit({ [key]: pf[key].value.trim() });
  };
  pf.addEventListener('input', editProfile);
  pf.addEventListener('change', editProfile);
  ctx.onCleanup(() => profileSession.dispose());
  pf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const dnErr = pf.querySelector('#me-dn-err');
    dnErr.textContent = '';
    pf.display_name.removeAttribute('aria-invalid');
    if (!pf.display_name.value.trim()) {
      dnErr.textContent = M.display_name_required;
      pf.display_name.setAttribute('aria-invalid', 'true');
      pf.display_name.focus();
      return;
    }
    const btn = pf.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const saved = await profileSession.save();
      if (!saved || !ctx.isActive() || store.me !== u) return;
      updateProfileHeader();
      toast(zh.saved);
    } catch (ex) { if (ctx.isActive() && store.me === u) toastError(ex); }
    finally { if (ctx.isActive() && store.me === u) btn.disabled = false; }
  });

  /* ---------- 默认模型 ---------- */
  const modelBody = root.querySelector('[data-model-body]');
  const drawModels = async () => {
    modelBody.innerHTML = spinnerHtml();
    let data;
    try {
      data = await loadModels(true);
    } catch (ex) {
      if (!ctx.isActive()) return;
      modelBody.innerHTML = errorHtml(ex.message);
      modelBody.querySelector('[data-retry]').onclick = drawModels;
      return;
    }
    if (!ctx.isActive()) return;
    const items = data.items;
    if (!items.length) { modelBody.innerHTML = `<div class="panel-pad muted small">${esc(zh.models.empty)}</div>`; return; }
    const siteDef = findModel(items, data.default_model_id) || items[0];
    // 自己选的模型已被停用（不在启用列表里）→ 按跟随系统显示，与服务端回落一致
    const savedId = store.me ? store.me.default_model_id : null;
    let cur = findModel(items, savedId) ? savedId : null;
    // 服务端仍存着已停用的选择：提示用户，并允许点「跟随系统默认」显式清空（否则模型重新启用后会悄悄恢复）
    let stale = savedId != null && cur == null;
    modelBody.innerHTML = `${stale ? `<p class="panel-hint warn" data-stale role="status">${esc(M.default_model_stale)}</p>` : ''}<div class="model-list in-panel" role="radiogroup" aria-labelledby="me-model-t">${modelOptionsHtml({ items, value: cur, withFollow: true, siteDefaultName: siteDef ? siteDef.name : '' })}</div>`;
    const group = modelBody.querySelector('[role="radiogroup"]');
    let busy = false;
    const rg = wireRadioGroup(group, async (mid) => {
      const m = mid == null ? null : findModel(items, mid);
      const want = m ? m.id : null;
      if (busy || (String(want) === String(cur) && !(stale && want == null))) return;
      busy = true;
      const prev = cur;
      rg.set(want);
      try {
        const r = await patch('/api/me', { default_model_id: want });
        cur = r && r.user && 'default_model_id' in r.user ? r.user.default_model_id : want;
        store.me.default_model_id = cur;
        if (stale) { stale = false; const n = modelBody.querySelector('[data-stale]'); if (n) n.remove(); }
        toast(zh.saved);
      } catch (ex) {
        rg.set(prev);
        toastError(ex);
      } finally { busy = false; }
    });
  };
  drawModels();

  const nsfw = root.querySelector('#me-nsfw');
  nsfw.checked = !!u.nsfw_enabled;
  nsfw.addEventListener('change', async () => {
    const want = nsfw.checked;
    if (want) {
      const ok = await confirmDialog(M.nsfw_confirm, { title: M.nsfw_confirm_title, ok: M.nsfw_yes });
      if (!ok) { nsfw.checked = false; return; }
    }
    try {
      const r = await patch('/api/me', { nsfw_enabled: want });
      store.me.nsfw_enabled = r && r.user ? r.user.nsfw_enabled : want;
      store.homeCache = null;
      toast(zh.saved);
    } catch (ex) { nsfw.checked = !want; toastError(ex); }
  });

  // 语音识别后直接发送（契约 §18.3 / §18.5，默认关）
  const vas = root.querySelector('#me-vas');
  vas.checked = u.voice_auto_send === true || u.voice_auto_send === 1;
  vas.addEventListener('change', async () => {
    const want = vas.checked;
    vas.disabled = true;
    try {
      const r = await patch('/api/me', { voice_auto_send: want });
      store.me.voice_auto_send = r && r.user && 'voice_auto_send' in r.user ? r.user.voice_auto_send : want;
      toast(zh.saved);
    } catch (ex) { vas.checked = !want; toastError(ex); } finally { vas.disabled = false; }
  });

  const pw = root.querySelector('[data-pw]');
  // 从登录记录页「去修改密码」进来（#/me?focus=password）：滚到改密码表单
  if (ctx.query && ctx.query.get('focus') === 'password') {
    setTimeout(() => { pw.scrollIntoView({ block: 'center' }); pw.old.focus({ preventScroll: true }); }, 60);
  }
  const pwErr = pw.querySelector('.form-error');
  pw.addEventListener('submit', async (e) => {
    e.preventDefault();
    pwErr.textContent = '';
    if (pw.nw.value.length < 8) { pwErr.textContent = M.password_short; return; }
    if (pw.nw.value !== pw.nw2.value) { pwErr.textContent = M.password_mismatch; return; }
    if (pw.nw.value === pw.old.value) { pwErr.textContent = M.password_same; return; }
    const btn = pw.querySelector('button');
    btn.disabled = true;
    try {
      await post('/api/me/password', { old_password: pw.old.value, new_password: pw.nw.value });
      pw.reset();
      toast(M.password_done);
    } catch (ex) { pwErr.textContent = ex.message; } finally { btn.disabled = false; }
  });

  root.querySelector('[data-logout]').onclick = async () => {
    if (!await confirmDialog(M.logout_confirm, { ok: M.logout, danger: true })) return;
    try { await post('/api/logout', {}, { allow401: true }); } catch { /* 忽略，照样回登录页 */ }
    store.me = null;
    applyReadingSettings(null);
    store.homeCache = null;
    const { rebuildShell } = await import('/js/app.js');
    rebuildShell();
    navigate('#/login', true);
  };
}
