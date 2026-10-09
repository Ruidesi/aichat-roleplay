import { zh } from '/i18n/zh.js';
import { get, post, patch, del, encPath } from '/js/api.js';
import { store } from '/js/store.js';
import { esc, fmtDateTime, debounce, roleOf, timeAgo, fmtUsd, fmtCost, fmtPrice, numOrNull } from '/js/util.js';
import { icon, avatar, spinnerHtml, errorHtml, openSheet, confirmDialog, toast, toastError, copyText } from '/js/ui.js';
import { normCard, cardBadgesHtml } from '/js/cards.js';
import { crawlerTab } from '/js/crawler.js';
import { clearTranslationModelsCache } from '/js/translation-models.js';

const A = zh.admin;
const pick = (r, ...keys) => {
  if (Array.isArray(r)) return r;
  for (const k of keys) if (r && Array.isArray(r[k])) return r[k];
  return [];
};
const truthy = (v) => v === true || v === 1 || v === '1';

// 各身份能看到的标签（契约 §9.4）
const TABS = {
  super: ['users', 'invites', 'usage', 'cards', 'shelves', 'models', 'crawler', 'logs', 'settings'],
  // 抓取监控：admin 只看，super 可操作（契约 §15）
  admin: ['tenants', 'invites', 'usage', 'crawler'],
};

let lastTab = '';

export default async function admin(ctx) {
  const { root, setTitle } = ctx;
  setTitle(A.title);
  const role = roleOf(store.me);
  const tabs = TABS[role] || TABS.admin;
  root.innerHTML = `<div class="page page-narrow" style="max-width:860px">
    <h1 class="page-title">${esc(A.title)}</h1>
    <div class="tabs" role="tablist">${tabs.map((k) => `<button role="tab" data-tab="${k}">${esc(A.tabs[k])}</button>`).join('')}</div>
    <div id="admin-body"></div>
  </div>`;
  const body = root.querySelector('#admin-body');
  // 窄屏下标签条横向滚动：选中项不在可见范围时只横向滚动标签条（不带动整页上下滚）
  const revealTab = (k) => {
    const bar = root.querySelector('.tabs');
    const b = bar && bar.querySelector(`[data-tab="${k}"]`);
    if (!b) return;
    const br = bar.getBoundingClientRect();
    const r = b.getBoundingClientRect();
    const pad = 12;
    if (r.right > br.right - pad) bar.scrollLeft += r.right - br.right + pad;
    else if (r.left < br.left + pad) bar.scrollLeft -= br.left - r.left + pad;
  };
  const views = {
    users: (b) => users(b, 'super'),
    tenants: (b) => users(b, 'admin'),
    invites: (b) => invitesList(b, role === 'super'),
    models, usage, shelves, logs: logsList, cards: cardsList,
    settings: (b) => {
      const my = tabSeq;
      return settings(b, ctx, {
        isCurrent: () => my === tabSeq && ctx.isActive(),
        setStop: (fn) => { if (my === tabSeq) tabStop = fn; else fn(); },
      });
    },
    crawler: (b) => {
      const my = tabSeq;
      return crawlerTab(b, ctx, {
        isCurrent: () => my === tabSeq && ctx.isActive(),
        setStop: (fn) => { if (my === tabSeq) tabStop = fn; else fn(); },
      });
    },
  };
  // 带定时器的标签（抓取）：切换标签或离开管理页时停掉
  let tabStop = null;
  let tabSeq = 0;
  const stopTab = () => { if (tabStop) { const f = tabStop; tabStop = null; try { f(); } catch { /* */ } } };
  ctx.onCleanup(stopTab);

  const show = async (k) => {
    stopTab();
    tabSeq++;
    lastTab = k;
    // 地址栏记下当前标签：刷新或从只读查看返回时停在原处（replaceState 不触发路由）
    const h = '#/admin?tab=' + k;
    if (location.hash !== h) history.replaceState(null, '', h);
    root.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === k);
      b.setAttribute('aria-selected', b.dataset.tab === k ? 'true' : 'false');
    });
    revealTab(k);
    body.innerHTML = spinnerHtml();
    body.onclick = null;
    body.onchange = null;
    body.oninput = null;
    try {
      await views[k](body, ctx);
    } catch (e) {
      if (!ctx.isActive()) return;
      body.innerHTML = errorHtml(e.message);
      body.querySelector('[data-retry]').onclick = () => show(k);
    }
  };
  root.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) show(b.dataset.tab);
  });
  const want = ctx.query && ctx.query.get('tab');
  const first = tabs.includes(want) ? want : tabs.includes(lastTab) ? lastTab : tabs[0];
  await show(first);
}

/* ================= 账号（super）/ 租户（admin） ================= */
const roleBadge = (r) => (r && zh.roles[r] ? `<span class="badge role-${esc(r)}">${esc(zh.roles[r])}</span>` : '');
let usersFilter = ''; // super 的身份筛选：'' | super | admin | tenant

async function users(body, mode) {
  const U = A.users;
  const asSuper = mode === 'super';
  const r = await get('/api/admin/users');
  const all = pick(r, 'items', 'users');
  const byId = new Map(all.map((u) => [String(u.id), u]));
  const limitText = (u) => (u.daily_limit == null || u.daily_limit === '' ? U.follow_site : Number(u.daily_limit) === 0 ? U.unlimited : String(u.daily_limit));
  const creatorName = (u) => {
    if (u.created_by_name) return u.created_by_name;
    if (u.created_by == null) return U.created_by_none;
    const c = byId.get(String(u.created_by));
    return c ? (c.display_name || c.username) : `#${u.created_by}`;
  };
  const reload = () => users(body, mode).catch((e) => toastError(e));

  const draw = () => {
    const list = asSuper && usersFilter ? all.filter((u) => roleOf(u) === usersFilter) : all;
    const count = (k) => (k ? all.filter((u) => roleOf(u) === k).length : all.length);
    body.innerHTML = `
      ${asSuper ? '' : `<p class="muted small" style="margin:0 0 10px">${esc(U.tenants_lead)}</p>`}
      <div class="admin-toolbar">
        ${asSuper ? `<div class="chips" role="group" aria-label="${esc(U.role)}">${['', 'super', 'admin', 'tenant'].map((k) => `<button class="chip${usersFilter === k ? ' active' : ''}" data-filter="${k}" aria-pressed="${usersFilter === k}">${esc(k ? zh.roles[k] : U.all_roles)}<span class="chip-count">${count(k)}</span></button>`).join('')}</div>` : '<span></span>'}
        <button class="btn btn-primary btn-sm" data-add>${icon('plus')}<span>${esc(asSuper ? U.add : U.add_tenant)}</span></button>
      </div>
      ${list.length ? `<div class="panel">${list.map((u) => {
        const rl = roleOf(u);
        const isMe = store.me && String(store.me.id) === String(u.id);
        const gone = !!u.deleted_at;
        return `
        <button class="row${gone ? ' row-deleted' : ''}" data-id="${esc(u.id)}">
          <div class="avatar-fallback" style="width:40px;height:40px;font-size:16px">${esc([...(u.display_name || u.username || '?')][0])}</div>
          <div class="row-main">
            <div class="row-title">${esc(u.display_name || u.username)}${asSuper ? roleBadge(rl) : ''}${gone ? `<span class="badge deleted">${esc(U.deleted)}</span>` : ''}${!gone && truthy(u.must_change_password) ? `<span class="badge must-change">${esc(U.must_change)}</span>` : ''}${u.invite_code_id != null && u.invite_code_id !== '' ? `<span class="badge via-invite">${esc(U.via_invite)}</span>` : ''}${isMe ? `<span class="muted small"> ${esc(U.self)}</span>` : ''}</div>
            ${u.note ? `<div class="user-note">${esc(U.note)}：${esc(u.note)}</div>` : ''}
            <div class="row-sub"><span class="status-dot${truthy(u.disabled) || gone ? ' off' : ''}"></span>${esc(u.username)} · ${esc(gone ? U.deleted : truthy(u.disabled) ? U.disabled : U.enabled)} · ${esc(U.daily_limit)} ${esc(limitText(u))}</div>
            <div class="row-sub">${asSuper ? `${esc(U.created_by)}：${esc(creatorName(u))} · ` : ''}${esc(U.last_login)}：${esc(u.last_login_at ? fmtDateTime(u.last_login_at) : U.never)}</div>
          </div>
        </button>`;
      }).join('')}</div>` : `<div class="empty">${esc(asSuper ? (all.length ? U.filter_empty : U.empty) : U.tenants_empty)}</div>`}`;

    body.querySelector('[data-add]').onclick = () => userForm(null, reload, mode);
    body.querySelectorAll('[data-filter]').forEach((b) => { b.onclick = () => { usersFilter = b.dataset.filter; draw(); }; });
    body.querySelectorAll('[data-id]').forEach((b) => {
      b.onclick = () => {
        const u = byId.get(b.dataset.id);
        if (u) userForm(u, reload, mode);
      };
    });
  };
  draw();
}

function userForm(u, done, mode) {
  const U = A.users;
  const asSuper = mode === 'super';
  const isNew = !u;
  const isSelf = !!(u && store.me && String(store.me.id) === String(u.id));
  const targetRole = u ? roleOf(u) : 'tenant';
  // 已删除（软删，契约 §12.4）的账号只给说明，不能再编辑
  if (u && u.deleted_at) {
    const s = openSheet(`
      <div class="sheet-title">${esc(u.display_name || u.username)}<span class="badge deleted">${esc(U.deleted)}</span></div>
      <p class="sheet-text">${esc(U.deleted_note)}${u.deleted_at ? '\n' + esc(fmtDateTime(u.deleted_at)) : ''}</p>
      <div class="sheet-actions"><button class="btn" type="button" data-cancel>${esc(zh.close)}</button></div>`);
    s.el.querySelector('[data-cancel]').onclick = () => s.close();
    return;
  }
  // 超管不能动别的超管（契约 §9.3），只给只读说明
  if (u && targetRole === 'super' && !isSelf) {
    const s = openSheet(`
      <div class="sheet-title">${esc(u.display_name || u.username)}${roleBadge('super')}</div>
      <p class="sheet-text">${esc(U.super_locked)}</p>
      <div class="sheet-actions"><button class="btn" type="button" data-cancel>${esc(zh.close)}</button></div>`);
    s.el.querySelector('[data-cancel]').onclick = () => s.close();
    return;
  }
  // 只有超管能选 / 改身份；自己与超管账号的身份不可改
  const canRole = asSuper && !isSelf && targetRole !== 'super';
  const roleField = canRole ? `
      <div class="field"><span class="label" id="uf-r-l">${esc(U.role)}</span>
        <div class="seg" role="radiogroup" aria-labelledby="uf-r-l">
          ${['tenant', 'admin'].map((k) => `<label class="seg-opt"><input type="radio" name="role" value="${k}"><span>${esc(zh.roles[k])}</span></label>`).join('')}
        </div>
        <span class="hint" data-role-hint></span></div>` : (asSuper && u ? `<div class="field"><span class="label">${esc(U.role)}</span><div class="role-fixed">${roleBadge(targetRole)}</div></div>` : '');
  const title = isNew ? (asSuper ? U.add : U.add_tenant) : (u.display_name || u.username);
  const s = openSheet(`
    <div class="sheet-title">${esc(title)}</div>
    <form novalidate>
      ${isNew ? `<div class="field"><label for="uf-u">${esc(U.username)}</label><input id="uf-u" class="input" name="username" autocomplete="off" autocapitalize="off" required></div>` : ''}
      ${roleField}
      <div class="field"><label for="uf-d">${esc(U.display_name)}</label><input id="uf-d" class="input" name="display_name" maxlength="40"></div>
      ${isNew ? `<div class="field"><label for="uf-p">${esc(U.initial_password)}</label><input id="uf-p" class="input" name="password" type="text" autocomplete="new-password" autocapitalize="off" spellcheck="false" minlength="8" aria-describedby="uf-p-h"><span class="hint" id="uf-p-h">${esc(U.initial_password_hint)}</span></div>` : ''}
      <div class="field"><label for="uf-n">${esc(U.note)}</label><textarea id="uf-n" class="textarea" name="note" rows="2" maxlength="100" aria-describedby="uf-n-h"></textarea><span class="hint" id="uf-n-h">${esc(U.note_hint)}</span></div>
      ${isNew ? '' : `<div class="field"><span class="label">${esc(U.password_section)}</span><div class="pw-note">${esc(isSelf ? U.self_password : U.password_admin_note)}${isSelf ? '' : `<br><button class="btn btn-sm" type="button" data-reset-code>${icon('key')}<span>${esc(U.reset_code)}</span></button>`}</div></div>`}
      <div class="field"><label for="uf-l">${esc(U.daily_limit)}</label><input id="uf-l" class="input" name="daily_limit" inputmode="numeric" pattern="[0-9]*"><span class="hint">${esc(U.daily_limit_hint)}</span></div>
      ${isNew || isSelf ? '' : `<label class="row" style="padding:10px 0"><div class="row-main">${esc(U.disabled)}</div><span class="switch"><input type="checkbox" name="disabled" role="switch"><span></span></span></label>`}
      <div class="form-error" role="alert"></div>
      <div class="sheet-actions">
        ${isNew || isSelf ? `<button class="btn" type="button" data-cancel>${esc(zh.cancel)}</button>` : `<button class="btn btn-danger" type="button" data-del>${esc(zh.delete)}</button>`}
        <button class="btn btn-primary" type="submit">${esc(zh.save)}</button>
      </div>
    </form>`, { label: title });
  const f = s.el.querySelector('form');
  const err = f.querySelector('.form-error');
  const roleHint = f.querySelector('[data-role-hint]');
  const syncRoleHint = () => {
    if (!roleHint) return;
    const v = (f.querySelector('input[name="role"]:checked') || {}).value;
    roleHint.textContent = v === 'admin' ? U.role_admin_hint : U.role_tenant_hint;
  };
  if (canRole) {
    const cur = targetRole === 'admin' ? 'admin' : 'tenant';
    f.querySelector(`input[name="role"][value="${cur}"]`).checked = true;
    f.querySelectorAll('input[name="role"]').forEach((x) => x.addEventListener('change', syncRoleHint));
    syncRoleHint();
  }
  if (u) {
    f.display_name.value = u.display_name || '';
    f.note.value = u.note || '';
    f.daily_limit.value = u.daily_limit == null ? '' : String(u.daily_limit);
    if (f.disabled) f.disabled.checked = truthy(u.disabled);
  }
  const c = f.querySelector('[data-cancel]');
  if (c) c.onclick = () => s.close();
  const rc = f.querySelector('[data-reset-code]');
  if (rc) rc.onclick = () => { s.close(); issueResetCode(u); };
  const d = f.querySelector('[data-del]');
  if (d) d.onclick = async () => {
    s.close();
    const nm = u.display_name || u.username;
    if (!await confirmDialog(zh.delete_forever, { title: asSuper && targetRole === 'admin' ? U.admin_delete_title(nm) : U.delete_title(nm), danger: true, ok: zh.delete })) return;
    try { await del('/api/admin/users/' + encodeURIComponent(u.id)); done(); } catch (e) { toastError(e); }
  };
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const pw = isNew ? f.password.value : '';
    const lim = f.daily_limit.value.trim();
    const note = f.note.value.trim();
    if (lim !== '' && !/^\d+$/.test(lim)) { err.textContent = U.daily_limit_hint; return; }
    if (isNew && pw.length < 8) { err.textContent = zh.me.password_short; return; }
    if ([...note].length > 100) { err.textContent = U.note_hint; return; }
    const data = {
      display_name: f.display_name.value.trim(),
      daily_limit: lim === '' ? null : Number(lim),
    };
    // 备注：新建时有才带；编辑时有变化才带（清空 = null）
    if (isNew) { if (note) data.note = note; } else if (note !== (u.note || '')) data.note = note || null;
    if (canRole) {
      const rv = (f.querySelector('input[name="role"]:checked') || {}).value || 'tenant';
      if (isNew || rv !== targetRole) data.role = rv;
    } else if (isNew) {
      data.role = 'tenant';
    }
    if (f.disabled && !isSelf) data.disabled = f.disabled.checked;
    if (isNew) data.password = pw; // 编辑时绝不带 password（契约 §13.3）
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      if (isNew) {
        data.username = f.username.value.trim();
        if (!data.username) { err.textContent = zh.login.need_both; btn.disabled = false; return; }
        await post('/api/admin/users', data);
        toast(asSuper ? U.created : U.tenant_created);
      } else {
        await patch('/api/admin/users/' + encodeURIComponent(u.id), data);
        toast(zh.saved);
      }
      s.close();
      done();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  });
  setTimeout(() => (f.username || f.display_name).focus(), 50);
}

// 生成一次性重置码（契约 §13.3）：先确认，再弹窗显示明文（仅此一次）
async function issueResetCode(u) {
  const U = A.users;
  const nm = u.display_name || u.username;
  if (!await confirmDialog(U.reset_code_confirm, { title: U.reset_code_confirm_title(nm), ok: U.reset_code_ok })) return;
  let r;
  try {
    r = await post('/api/admin/users/' + encodeURIComponent(u.id) + '/reset-code', {});
  } catch (e) { toastError(e); return; }
  // 返回形态宽松读取：{code, expires_at} / {reset:{code, expires_at}}
  const box = (r && r.reset && typeof r.reset === 'object' ? r.reset : r) || {};
  const code = String(box.code || box.reset_code || '');
  if (!code) { toast(zh.server_error, 'error'); return; }
  const exp = box.expires_at || (r && r.expires_at) || new Date(Date.now() + 24 * 3600e3).toISOString();
  const s = openSheet(`
    <div class="sheet-title">${esc(U.reset_code_title)} · ${esc(nm)}</div>
    <div class="sheet-stack">
      <div class="code-big" data-code>${esc(code)}</div>
      <p class="muted small" style="margin:0;text-align:center">${esc(U.username)}：${esc(u.username)} · ${esc(U.reset_code_expires(fmtDateTime(exp)))}</p>
      <p class="once-warn" role="alert">${esc(U.reset_code_once)}</p>
      <p class="muted small" style="margin:0">${esc(U.reset_code_howto)}</p>
    </div>
    <div class="sheet-actions">
      <button class="btn" type="button" data-close>${esc(zh.close)}</button>
      <button class="btn btn-primary" type="button" data-copy>${icon('copy')}<span>${esc(U.copy_code)}</span></button>
    </div>`, { label: U.reset_code_title });
  s.el.querySelector('[data-close]').onclick = () => s.close();
  s.el.querySelector('[data-copy]').onclick = () => copyText(code);
}

/* ================= 邀请码（admin 与 super，契约 §13.2 / §13.4） ================= */
const INVITE_STATUSES = ['active', 'used_up', 'expired', 'disabled', 'creator_inactive'];
let invitesFilter = ''; // '' | active | used_up | expired | disabled | creator_inactive

// 状态以服务端为准；没给或不认识时按字段推算
function inviteStatus(it) {
  const st = String(it.status || '').toLowerCase();
  if (INVITE_STATUSES.includes(st)) return st;
  if (st === 'exhausted') return 'used_up';
  if (it.disabled_at) return 'disabled';
  const exp = it.expires_at ? Date.parse(it.expires_at) : NaN;
  if (Number.isFinite(exp) && exp <= Date.now()) return 'expired';
  const max = Number(it.max_uses) || 0;
  if (max > 0 && (Number(it.used_count) || 0) >= max) return 'used_up';
  return 'active';
}
const inviteLink = (it) => it.link || `${location.origin}/#/register?code=${encodeURIComponent(it.code || '')}`;
const inviteUsers = (it) => (Array.isArray(it.users) ? it.users : Array.isArray(it.registered_users) ? it.registered_users : []);

// 新加坡日期（YYYY-MM-DD），用于自选日期的最小值
function sgToday() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch { return new Date().toISOString().slice(0, 10); }
}

async function invitesList(body, asSuper) {
  const I = A.invites;
  const r = await get('/api/admin/invites');
  const all = pick(r, 'items', 'invites');
  const open = new Set(); // 展开了「已注册」的邀请码 id
  const reload = () => invitesList(body, asSuper).catch((e) => toastError(e));

  const itemHtml = (it) => {
    const st = inviteStatus(it);
    const users = inviteUsers(it);
    const used = Number(it.used_count) || 0;
    const id = String(it.id);
    const isOpen = open.has(id);
    const creator = it.creator_name || it.created_by_name || (it.creator && (it.creator.name || it.creator.display_name || it.creator.username)) || (it.creator_id != null ? '#' + it.creator_id : '—');
    return `<div class="inv-item inv-${st}" data-inv="${esc(id)}">
      <div class="inv-head"><span class="inv-code">${esc(it.code)}</span><span class="badge inv-${st}">${esc(I.status[st])}</span></div>
      <div class="inv-note">${esc(it.note || '')}</div>
      <div class="inv-meta">
        <span>${esc(I.used(used, Number(it.max_uses) || 0))}</span>
        <span>${esc(I.expires(it.expires_at ? fmtDateTime(it.expires_at) : '—'))}</span>
        ${asSuper ? `<span>${esc(I.creator)}：${esc(creator)}</span>` : ''}
        <span>${esc(I.created_at)} ${esc(fmtDateTime(it.created_at))}</span>
      </div>
      <div class="inv-actions">
        ${st === 'active' ? `<button class="btn btn-sm" data-a="link">${icon('link')}<span>${esc(I.copy_link)}</span></button>
        <button class="btn btn-sm" data-a="code">${icon('copy')}<span>${esc(I.copy_code)}</span></button>` : ''}
        <button class="btn btn-sm" data-a="users" aria-expanded="${isOpen}">${icon(isOpen ? 'up' : 'down')}<span>${esc(isOpen ? I.users_hide : I.users(Math.max(users.length, used)))}</span></button>
        ${st === 'active' ? `<button class="btn btn-sm btn-danger" data-a="disable">${esc(I.disable)}</button>` : ''}
      </div>
      ${isOpen ? `<div class="inv-users">${users.length ? users.map((u) => `<div><b>${esc(u.display_name || u.username)}<span class="muted"> · ${esc(u.username)}</span></b><span class="muted">${esc(fmtDateTime(u.registered_at || u.created_at))}</span></div>`).join('') : `<div class="muted">${esc(I.users_none)}</div>`}</div>` : ''}
    </div>`;
  };

  const draw = () => {
    const list = invitesFilter ? all.filter((it) => inviteStatus(it) === invitesFilter) : all;
    const count = (k) => (k ? all.filter((it) => inviteStatus(it) === k).length : all.length);
    body.innerHTML = `
      <p class="muted small" style="margin:0 0 10px">${esc(I.lead)}</p>
      <div class="admin-toolbar">
        <div class="chips" role="group" aria-label="${esc(I.filter_label)}">${['', ...INVITE_STATUSES].map((k) => `<button class="chip${invitesFilter === k ? ' active' : ''}" data-filter="${k}" aria-pressed="${invitesFilter === k}">${esc(k ? I.status[k] : I.all)}<span class="chip-count">${count(k)}</span></button>`).join('')}</div>
        <button class="btn btn-primary btn-sm" data-add>${icon('plus')}<span>${esc(I.add)}</span></button>
      </div>
      ${list.length ? `<div class="panel">${list.map(itemHtml).join('')}</div>` : `<div class="empty">${icon('ticket')}<div class="empty-title">${esc(all.length ? I.filter_empty : I.empty)}</div></div>`}`;
  };
  draw();

  body.onclick = async (e) => {
    if (e.target.closest('[data-add]')) { inviteForm(reload); return; }
    const fb = e.target.closest('[data-filter]');
    if (fb) { invitesFilter = fb.dataset.filter; draw(); return; }
    const b = e.target.closest('[data-a]');
    const row = b && b.closest('[data-inv]');
    if (!row) return;
    const it = all.find((x) => String(x.id) === row.dataset.inv);
    if (!it) return;
    const a = b.dataset.a;
    if (a === 'link') copyText(inviteLink(it));
    else if (a === 'code') copyText(it.code);
    else if (a === 'users') {
      const id = String(it.id);
      if (open.has(id)) open.delete(id); else open.add(id);
      draw();
      const nb = body.querySelector(`[data-inv="${CSS.escape(id)}"] [data-a="users"]`);
      if (nb) nb.focus();
    } else if (a === 'disable') {
      if (!await confirmDialog(I.disable_confirm, { title: I.disable_title(it.code), ok: I.disable, danger: true })) return;
      try {
        await post('/api/admin/invites/' + encodeURIComponent(it.id) + '/disable', {});
        toast(I.disabled_done);
        reload();
      } catch (ex) { toastError(ex); }
    }
  };
}

function inviteForm(done) {
  const I = A.invites;
  const today = sgToday();
  const s = openSheet(`
    <div class="sheet-title">${esc(I.add)}</div>
    <form novalidate>
      <div class="field"><label for="if-n">${esc(I.note)}</label>
        <textarea id="if-n" class="textarea" name="note" rows="2" maxlength="100" required aria-describedby="if-n-h"></textarea>
        <span class="hint" id="if-n-h">${esc(I.note_hint)} <span data-count>0/100</span></span></div>
      <div class="field"><label for="if-m">${esc(I.max_uses)}</label>
        <input id="if-m" class="input" name="max_uses" inputmode="numeric" pattern="[0-9]*" value="1" aria-describedby="if-m-h"><span class="hint" id="if-m-h">${esc(I.max_uses_hint)}</span></div>
      <div class="field"><span class="label" id="if-v-l">${esc(I.validity)}</span>
        <div class="seg" role="radiogroup" aria-labelledby="if-v-l">
          ${['1', '7', '30', 'custom'].map((k) => `<label class="seg-opt"><input type="radio" name="validity" value="${k}"${k === '7' ? ' checked' : ''}><span>${esc(k === 'custom' ? I.custom : I.days(k))}</span></label>`).join('')}
        </div></div>
      <div class="field" data-custom hidden><label for="if-d">${esc(I.custom_date)}</label>
        <input id="if-d" class="input" type="date" name="date" min="${today}"></div>
      <p class="muted small" style="margin:0 0 6px">${esc(I.no_change_hint)}</p>
      <div class="form-error" role="alert"></div>
      <div class="sheet-actions">
        <button class="btn" type="button" data-cancel>${esc(zh.cancel)}</button>
        <button class="btn btn-primary" type="submit">${esc(I.create)}</button>
      </div>
    </form>`, { label: I.add });
  const f = s.el.querySelector('form');
  const err = f.querySelector('.form-error');
  const cnt = f.querySelector('[data-count]');
  const custom = f.querySelector('[data-custom]');
  f.note.addEventListener('input', () => { cnt.textContent = `${[...f.note.value.trim()].length}/100`; });
  f.querySelectorAll('input[name="validity"]').forEach((x) => x.addEventListener('change', () => {
    const isCustom = f.validity.value === 'custom';
    custom.hidden = !isCustom;
    if (isCustom && !f.date.value) f.date.focus();
  }));
  f.querySelector('[data-cancel]').onclick = () => s.close();
  setTimeout(() => f.note.focus(), 50);

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const note = f.note.value.trim();
    if (!note) { err.textContent = I.note_required; f.note.focus(); return; }
    if ([...note].length > 100) { err.textContent = I.note_long; f.note.focus(); return; }
    const mu = f.max_uses.value.trim();
    if (!/^\d+$/.test(mu) || Number(mu) < 1 || Number(mu) > 10000) { err.textContent = I.max_uses_bad; f.max_uses.focus(); return; }
    const data = { note, max_uses: Number(mu) };
    const v = f.validity.value;
    if (v === 'custom') {
      const d = f.date.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < today) { err.textContent = I.date_bad; f.date.focus(); return; }
      // 选中日期当天 23:59:59（新加坡时间）到期
      data.expires_at = new Date(`${d}T23:59:59+08:00`).toISOString();
    } else {
      data.expires_in_days = Number(v);
    }
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const r = await post('/api/admin/invites', data);
      s.close();
      done();
      const inv = (r && (r.invite || r.item)) || r;
      if (inv && inv.code) showInvite(inv);
      else toast(I.created);
    } catch (ex) {
      err.textContent = (ex && ex.status && ex.message) || zh.network_error;
      btn.disabled = false;
    }
  });
}

// 新建成功：显示码与链接，方便立刻复制
function showInvite(inv) {
  const I = A.invites;
  const link = inviteLink(inv);
  const s = openSheet(`
    <div class="sheet-title">${esc(I.created_title)}</div>
    <div class="sheet-stack">
      <div class="code-big">${esc(inv.code)}</div>
      <div class="inv-meta" style="justify-content:center"><span>${esc(I.used(Number(inv.used_count) || 0, Number(inv.max_uses) || 0))}</span><span>${esc(I.expires(inv.expires_at ? fmtDateTime(inv.expires_at) : '—'))}</span></div>
      <div class="field" style="margin:0"><span class="label">${esc(I.link)}</span><div class="link-box">${esc(link)}</div></div>
      <p class="muted small" style="margin:0">${esc(I.created_hint)}</p>
    </div>
    <div class="sheet-actions">
      <button class="btn" type="button" data-code>${icon('copy')}<span>${esc(I.copy_code)}</span></button>
      <button class="btn btn-primary" type="button" data-link>${icon('link')}<span>${esc(I.copy_link)}</span></button>
    </div>`, { label: I.created_title });
  s.el.querySelector('[data-code]').onclick = () => copyText(inv.code);
  s.el.querySelector('[data-link]').onclick = () => copyText(link);
}

/* ================= 模型 ================= */
const sid = (v) => (v == null ? '' : String(v));
const XAI_DEFAULT_PROXY = 'http://127.0.0.1:42001'; // 契约 §10.1：新建 xAI 模型时默认填本机代理
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const isXai = (u) => { const h = hostOf(u); return h === 'api.x.ai' || h.endsWith('.x.ai'); };
const PROXY_RE = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})\/?$/i;
const curOf = (m) => (String((m && m.currency) || 'USD').toUpperCase() === 'CNY' ? 'CNY' : 'USD');
function priceLine(m) {
  const D = A.models;
  const cur = curOf(m);
  const pi = fmtPrice(m.price_in, cur);
  const po = fmtPrice(m.price_out, cur);
  if (!pi && !po) return D.price_none;
  const pc = fmtPrice(m.price_in_cached, cur) || pi;
  return D.price_line(pi || '—', pc || '—', po || '—');
}
// 单价输入框 → 数字 / null（空）/ NaN（非法）
const priceVal = (t) => {
  t = String(t || '').trim();
  if (!t) return null;
  if (!/^\d*\.?\d+$/.test(t)) return NaN;
  return Number(t);
};
const priceText = (v) => { const n = numOrNull(v); return n == null ? '' : String(+n.toFixed(8)); };

async function models(body) {
  const D = A.models;
  const [r, st] = await Promise.all([
    get('/api/admin/models'),
    get('/api/admin/settings').catch(() => null),
  ]);
  const list = pick(r, 'items', 'models');
  const stObj = (st && st.settings) || st || {};
  let defId = r && r.default_model_id !== undefined ? r.default_model_id : stObj.default_model_id;
  // 全站默认未设或已停用时，实际生效的是第一个启用的模型（§8.2）
  const effDefault = () => {
    const d = list.find((m) => sid(m.id) === sid(defId) && truthy(m.enabled));
    return d || list.find((m) => truthy(m.enabled)) || null;
  };
  const tests = new Map(); // id → {state:'run'|'ok'|'fail', text, sample}
  const reload = () => models(body).catch((e) => toastError(e));
  const invalidateUserCache = () => { store.modelsCache = null; };

  const testHtml = (m) => {
    const t = tests.get(sid(m.id));
    if (!t) return '';
    if (t.state === 'run') return `<div class="model-test muted" role="status">${esc(D.testing)}</div>`;
    return `<div class="model-test ${t.state}" role="status">${esc(t.text)}${t.sample ? `<span class="sample">${esc(t.sample)}</span>` : ''}</div>`;
  };

  const draw = () => {
    const eff = effDefault();
    body.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px"><button class="btn btn-primary btn-sm" data-add>${icon('plus')}<span>${esc(D.add)}</span></button></div>
      ${list.length ? `<div class="panel">${list.map((m, i) => {
        const on = truthy(m.enabled);
        const isDef = eff && sid(eff.id) === sid(m.id);
        return `<div class="model-item" data-mid="${esc(sid(m.id))}">
          <div class="model-row${on ? '' : ' off'}">
            <div class="model-sort">
              <button class="icon-btn" data-act="up" aria-label="${esc(D.up)}" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
              <button class="icon-btn" data-act="down" aria-label="${esc(D.down)}" ${i === list.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
            </div>
            <div class="row-main" data-act="edit">
              <div class="row-title"><span>${esc(m.name)}</span>${isDef ? `<span class="badge">${esc(D.site_default)}</span>` : ''}</div>
              <div class="row-sub">${esc([m.provider, m.model].filter(Boolean).join(' · '))}</div>
              <div class="row-sub"><span class="status-dot${on ? '' : ' off'}"></span>${esc(on ? D.enabled : D.disabled)}${truthy(m.key_set) ? '' : ` · ${esc(D.key_none)}`}${m.proxy_url ? ` · ${esc(D.via_proxy)}` : ''}</div>
              <div class="row-sub">${esc(priceLine(m))}</div>
            </div>
            <span class="switch"><input type="checkbox" role="switch" data-act="toggle" aria-label="${esc(D.enabled)} · ${esc(m.name)}" ${on ? 'checked' : ''}><span></span></span>
          </div>
          ${testHtml(m)}
          <div class="model-actions">
            <button class="btn btn-sm" data-act="test" ${tests.get(sid(m.id))?.state === 'run' ? 'disabled' : ''}>${icon('play')}<span>${esc(D.test)}</span></button>
            ${isDef || !on ? '' : `<button class="btn btn-sm" data-act="default">${esc(D.set_default)}</button>`}
            <button class="btn btn-sm" data-act="edit">${icon('edit')}<span>${esc(zh.edit)}</span></button>
          </div>
        </div>`;
      }).join('')}</div>` : `<div class="empty">${esc(D.empty)}</div>`}`;
    body.querySelector('[data-add]').onclick = () => modelForm(null, reload);
  };
  draw();

  const onClick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'toggle') return; // 开关走 change 事件
    const item = b.closest('[data-mid]');
    const m = item && list.find((x) => sid(x.id) === item.dataset.mid);
    if (!m) return;
    const mid = encodeURIComponent(m.id);
    try {
      if (act === 'edit') {
        modelForm(m, reload);
      } else if (act === 'up' || act === 'down') {
        const i = list.indexOf(m);
        const j = act === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= list.length) return;
        const ids = list.map((x) => x.id);
        [ids[i], ids[j]] = [ids[j], ids[i]];
        await post('/api/admin/models/order', { ids });
        invalidateUserCache();
        reload();
      } else if (act === 'default') {
        if (!truthy(m.enabled)) { toast(D.default_needs_enabled, 'error'); return; }
        await patch('/api/admin/settings', { default_model_id: m.id });
        defId = m.id;
        invalidateUserCache();
        toast(D.default_set);
        draw();
      } else if (act === 'test') {
        tests.set(sid(m.id), { state: 'run' });
        draw();
        let t;
        try {
          const res = await post('/api/admin/models/' + mid + '/test', {});
          t = res && res.ok
            ? { state: 'ok', text: D.test_ok(Math.round(+res.latency_ms || 0)), sample: res.sample || '' }
            : { state: 'fail', text: `${D.test_fail}：${(res && res.error) || zh.server_error}` };
        } catch (ex) {
          t = { state: 'fail', text: `${D.test_fail}：${(ex && typeof ex.status === 'number' && ex.message) || zh.network_error}` };
        }
        if (!body.isConnected || lastTab !== 'models' || body.onclick !== onClick) return;
        tests.set(sid(m.id), t);
        draw();
      }
    } catch (ex) { toastError(ex); }
  };
  body.onclick = onClick;

  body.onchange = async (e) => {
    const sw = e.target.closest('[data-act="toggle"]');
    if (!sw) return;
    const item = sw.closest('[data-mid]');
    const m = item && list.find((x) => sid(x.id) === item.dataset.mid);
    if (!m) return;
    const want = sw.checked;
    sw.disabled = true;
    try {
      const res = await patch('/api/admin/models/' + encodeURIComponent(m.id), { enabled: want });
      m.enabled = res && res.model && 'enabled' in res.model ? res.model.enabled : want;
      invalidateUserCache();
      toast(zh.saved);
      draw();
    } catch (ex) {
      sw.checked = !want;
      sw.disabled = false;
      toastError(ex);
    }
  };
}

function modelForm(m, done) {
  const D = A.models;
  const isNew = !m;
  const extraText = (v) => {
    if (v == null || v === '') return '';
    if (typeof v === 'string') {
      try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
    }
    try { return JSON.stringify(v, null, 2); } catch { return ''; }
  };
  let keyState = D.key_none;
  let keyHint = '';
  if (m) {
    const envName = m.api_key_env || (m.key_source === 'env' ? m.key_env || '' : '');
    if (m.api_key_env || m.key_source === 'env') {
      // 服务器配置来源：变量里取不到密钥也要说清楚；填了新密钥后端会改为加密保存在后台
      keyState = truthy(m.key_set)
        ? D.key_from_env(envName) + (m.key_hint ? `（末 4 位 ${m.key_hint}）` : '')
        : D.key_from_env_missing(envName);
      keyHint = D.key_from_env_hint;
    } else if (truthy(m.key_set)) keyState = D.key_set(m.key_hint || '');
  }
  const s = openSheet(`
    <div class="sheet-title">${esc(isNew ? D.add : D.edit)}</div>
    <form novalidate>
      <div class="field"><label for="mf-n">${esc(D.name)}</label><input id="mf-n" class="input" name="name" maxlength="40" autocomplete="off" required></div>
      <div class="field"><label for="mf-p">${esc(D.provider)}</label><input id="mf-p" class="input" name="provider" maxlength="40" autocomplete="off"></div>
      <div class="field"><label for="mf-u">${esc(D.base_url)}</label><input id="mf-u" class="input" name="base_url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" required><span class="hint">${esc(D.base_url_hint)}</span></div>
      <div class="field"><label for="mf-m">${esc(D.model)}</label><input id="mf-m" class="input" name="model" autocomplete="off" autocapitalize="off" spellcheck="false" required></div>
      <div class="field"><label for="mf-k">${esc(D.key)}</label><input id="mf-k" class="input" name="api_key" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false"><span class="key-state">${esc(keyState)}${isNew || keyHint ? '' : ` · ${esc(D.key_keep)}`}</span>${keyHint ? `<span class="hint">${esc(keyHint)}</span>` : ''}</div>
      <div class="field"><label for="mf-px">${esc(D.proxy_url)}</label><input id="mf-px" class="input" name="proxy_url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false"><span class="hint">${esc(D.proxy_url_hint)}</span></div>
      <fieldset class="field price-set">
        <legend class="label">${esc(D.pricing)}<span class="muted">（${esc(D.price_unit)}）</span></legend>
        <div class="seg" role="radiogroup" aria-label="${esc(D.currency)}">
          ${['USD', 'CNY'].map((k) => `<label class="seg-opt"><input type="radio" name="currency" value="${k}"><span>${esc(k === 'USD' ? D.currency_usd : D.currency_cny)}</span></label>`).join('')}
        </div>
        <div class="price-grid">
          <div class="pf"><label for="mf-pi">${esc(D.price_in)}</label><input id="mf-pi" class="input" name="price_in" inputmode="decimal" autocomplete="off"></div>
          <div class="pf"><label for="mf-pc">${esc(D.price_in_cached)}</label><input id="mf-pc" class="input" name="price_in_cached" inputmode="decimal" autocomplete="off" aria-describedby="mf-pc-h"><span class="hint" id="mf-pc-h">${esc(D.price_cached_hint)}</span></div>
          <div class="pf"><label for="mf-po">${esc(D.price_out)}</label><input id="mf-po" class="input" name="price_out" inputmode="decimal" autocomplete="off"></div>
        </div>
        <span class="hint">${esc(D.pricing_hint)}</span>
        <div class="price-sync" data-sync-wrap hidden><button class="btn btn-sm" type="button" data-sync>${icon('refresh')}<span>${esc(D.sync_xai)}</span></button><span class="hint" data-sync-msg role="status"></span></div>
      </fieldset>
      <div class="field"><label for="mf-x">${esc(D.extra)}</label><textarea id="mf-x" class="textarea mono" name="extra_json" rows="3" spellcheck="false" autocapitalize="off"></textarea><span class="hint">${esc(D.extra_hint)}</span></div>
      <label class="row" style="padding:10px 0"><div class="row-main">${esc(D.enabled)}</div><span class="switch"><input type="checkbox" name="enabled" role="switch"><span></span></span></label>
      <div class="form-error" role="alert"></div>
      <div class="sheet-actions">
        ${isNew ? `<button class="btn" type="button" data-cancel>${esc(zh.cancel)}</button>` : `<button class="btn btn-danger" type="button" data-del>${esc(zh.delete)}</button>`}
        <button class="btn btn-primary" type="submit">${esc(zh.save)}</button>
      </div>
    </form>`, { label: isNew ? D.add : D.edit });
  const f = s.el.querySelector('form');
  const err = f.querySelector('.form-error');
  f.name.value = m ? m.name || '' : '';
  f.provider.value = m ? m.provider || '' : '';
  f.base_url.value = m ? m.base_url || '' : 'https://';
  f.model.value = m ? m.model || '' : '';
  f.extra_json.value = m ? extraText(m.extra_json) : '';
  f.enabled.checked = m ? truthy(m.enabled) : true;
  f.proxy_url.value = m ? m.proxy_url || '' : '';
  f.querySelector(`input[name="currency"][value="${curOf(m)}"]`).checked = true;
  f.price_in.value = m ? priceText(m.price_in) : '';
  f.price_in_cached.value = m ? priceText(m.price_in_cached) : '';
  f.price_out.value = m ? priceText(m.price_out) : '';

  // xAI：新建时自动填本机代理；显示「从 xAI 同步价格」
  const syncWrap = f.querySelector('[data-sync-wrap]');
  const syncMsg = f.querySelector('[data-sync-msg]');
  let proxyTouched = !!(m && m.proxy_url);
  f.proxy_url.addEventListener('input', () => { proxyTouched = true; });
  const onUrl = () => {
    const x = isXai(f.base_url.value.trim());
    syncWrap.hidden = !x;
    if (x && isNew && !proxyTouched && !f.proxy_url.value.trim()) f.proxy_url.value = XAI_DEFAULT_PROXY;
  };
  f.base_url.addEventListener('input', onUrl);
  onUrl();
  const syncBtn = f.querySelector('[data-sync]');
  syncBtn.onclick = async () => {
    if (isNew) { syncMsg.textContent = D.sync_save_first; return; }
    syncBtn.disabled = true;
    syncMsg.textContent = D.syncing;
    try {
      const r = await post('/api/admin/models/' + encodeURIComponent(m.id) + '/sync-price', {});
      const p = (r && (r.model || r.prices || r.price)) || r || {};
      f.querySelector('input[name="currency"][value="' + curOf(p) + '"]').checked = true;
      if ('price_in' in p) f.price_in.value = priceText(p.price_in);
      if ('price_in_cached' in p) f.price_in_cached.value = priceText(p.price_in_cached);
      if ('price_out' in p) f.price_out.value = priceText(p.price_out);
      // 后端已把新单价写进库并立即生效：同步本地 m（免得保存时把同样的价格当改动再提交）并刷新背后的模型列表
      for (const k of ['currency', 'price_in', 'price_in_cached', 'price_out']) if (k in p) m[k] = p[k];
      store.modelsCache = null;
      syncMsg.textContent = D.synced;
      try { done(); } catch { /* 刷新失败不影响弹层 */ }
    } catch (ex) {
      syncMsg.textContent = (ex && typeof ex.status === 'number' && ex.message) || zh.network_error;
    } finally { syncBtn.disabled = false; }
  };

  const c = f.querySelector('[data-cancel]');
  if (c) c.onclick = () => s.close();
  const d = f.querySelector('[data-del]');
  if (d) d.onclick = async () => {
    s.close();
    if (!await confirmDialog(D.delete_confirm, { danger: true, ok: zh.delete })) return;
    try {
      const r = await del('/api/admin/models/' + encodeURIComponent(m.id));
      store.modelsCache = null;
      toast(r && (r.disabled || r.deleted === false) ? D.deleted_as_disabled : D.deleted);
      done();
    } catch (e) { toastError(e); }
  };
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const data = {
      name: f.name.value.trim(),
      provider: f.provider.value.trim(),
      base_url: f.base_url.value.trim(),
      model: f.model.value.trim(),
      enabled: f.enabled.checked,
    };
    if (!data.name || !data.model || !data.base_url || data.base_url === 'https://') { err.textContent = D.need_fields; return; }
    if (!/^https:\/\/[^\s/]+/i.test(data.base_url)) { err.textContent = D.bad_url; return; }
    const xt = f.extra_json.value.trim();
    if (xt) {
      let o;
      try { o = JSON.parse(xt); } catch { o = null; }
      if (!o || typeof o !== 'object' || Array.isArray(o)) { err.textContent = D.extra_invalid; f.extra_json.focus(); return; }
      data.extra_json = JSON.stringify(o);
    } else {
      data.extra_json = null;
    }
    const px = f.proxy_url.value.trim();
    if (px) {
      const pm = px.match(PROXY_RE);
      if (!pm || +pm[2] < 1 || +pm[2] > 65535) { err.textContent = D.proxy_invalid; f.proxy_url.focus(); return; }
    }
    data.proxy_url = px ? px.replace(/\/$/, '') : null;
    data.currency = (f.querySelector('input[name="currency"]:checked') || {}).value || 'USD';
    for (const k of ['price_in', 'price_in_cached', 'price_out']) {
      const v = priceVal(f[k].value);
      if (Number.isNaN(v)) { err.textContent = D.price_invalid; f[k].focus(); return; }
      data[k] = v;
    }
    const key = f.api_key.value.trim();
    if (key) data.api_key = key;
    if (!isNew) {
      // 编辑只提交改动过的字段：接口地址没变就不发，免得每次保存都重新做域名校验
      const orig = {
        name: m.name || '',
        provider: m.provider || '',
        base_url: m.base_url || '',
        model: m.model || '',
        enabled: truthy(m.enabled),
        proxy_url: m.proxy_url || null,
        currency: curOf(m),
        price_in: numOrNull(m.price_in),
        price_in_cached: numOrNull(m.price_in_cached),
        price_out: numOrNull(m.price_out),
        extra_json: (() => { const t = extraText(m.extra_json).trim(); if (!t) return null; try { return JSON.stringify(JSON.parse(t)); } catch { return t; } })(),
      };
      for (const k of Object.keys(orig)) if (data[k] === orig[k]) delete data[k];
      if (!Object.keys(data).length) { s.close(); return; }
    }
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      if (isNew) {
        await post('/api/admin/models', data);
        toast(D.created);
      } else {
        await patch('/api/admin/models/' + encodeURIComponent(m.id), data);
        toast(zh.saved);
      }
      store.modelsCache = null;
      s.close();
      done();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  });
  setTimeout(() => f.name.focus(), 50);
}

/* ================= 用量 ================= */
// super 的「翻译与测试」花费（契约 §10.3 只说「另得 system_costs 合计」）：兼容数字 / {cost_usd} / 按类别的数组或对象
function systemCostOf(r) {
  if (!r) return null;
  const v = r.system_costs !== undefined ? r.system_costs : r.system_cost_usd !== undefined ? r.system_cost_usd : r.system_cost;
  if (v == null) return null;
  if (typeof v === 'number' || typeof v === 'string') return numOrNull(v);
  if (Array.isArray(v)) return v.reduce((a, x) => a + (numOrNull(x && typeof x === 'object' ? x.cost_usd : x) || 0), 0);
  if (typeof v === 'object') {
    if ('cost_usd' in v) return numOrNull(v.cost_usd);
    if ('total' in v) return numOrNull(v.total);
    return Object.values(v).reduce((a, x) => a + (numOrNull(x && typeof x === 'object' ? x.cost_usd : x) || 0), 0);
  }
  return null;
}

async function usage(body) {
  const G = A.usage;
  let days = 7;
  const draw = async () => {
    body.innerHTML = spinnerHtml();
    const r = await get('/api/admin/usage?days=' + days);
    const rows = pick(r, 'items', 'rows', 'usage');
    const tot = rows.reduce((a, x) => ({ m: a.m + (+x.messages || 0), i: a.i + (+x.tokens_in || 0), o: a.o + (+x.tokens_out || 0), c: a.c + (numOrNull(x.cost_usd) || 0) }), { m: 0, i: 0, o: 0, c: 0 });
    // 合计金额以接口的 total_cost_usd 为准（各行已四舍五入，前端累加会差 $0.000001）；没给才回退按行累加
    const apiTotal = r ? numOrNull(r.total_cost_usd) : null;
    if (apiTotal != null) tot.c = apiTotal;
    const usd = (v) => fmtUsd(v) || '—';
    const asSuper = roleOf(store.me) === 'super';
    const sys = asSuper ? systemCostOf(r) : null;
    // 有算不出费用的系统调用时，「翻译与测试」与「全站合计」前面加「约」（与会话花费口径一致）
    const sysPartial = !!(r && r.system_costs && typeof r.system_costs === 'object' && r.system_costs.cost_partial);
    const sysUsd = (v) => fmtCost(v, sysPartial) || '—';
    const grand = sys == null ? null : Math.round((tot.c + sys) * 1e6) / 1e6;
    const sysHtml = sys == null ? '' : `<div class="panel usage-sys">
        <div class="usage-sys-row"><div><div class="row-title">${esc(G.system_costs)}</div><div class="row-sub wrap">${esc(G.system_costs_hint)}</div></div><b class="num">${esc(sysUsd(sys))}</b></div>
        <div class="usage-sys-row total"><div class="row-title">${esc(G.grand_total)}</div><b class="num">${esc(sysUsd(grand))}</b></div>
      </div>`;
    body.innerHTML = `
      ${roleOf(store.me) === 'admin' ? `<p class="muted small" style="margin:0 0 10px">${esc(G.scope_admin)}</p>` : ''}
      <div class="chips" style="margin-bottom:12px">${[1, 7, 30].map((d) => `<button class="chip${d === days ? ' active' : ''}" data-days="${d}">${esc(d === 1 ? G.today : G.last_days(d))}</button>`).join('')}</div>
      ${rows.length ? `<div class="panel table-wrap"><table class="data usage-table">
        <thead><tr><th>${esc(G.day)}</th><th>${esc(G.user)}</th><th class="num">${esc(G.cost)}</th><th class="num">${esc(G.messages)}</th><th class="num">${esc(G.input)}</th><th class="num">${esc(G.output)}</th></tr></thead>
        <tbody>${rows.map((x) => `<tr><td>${esc(x.day)}</td><td class="usage-user">${esc(x.display_name || x.username || x.user_id)}</td><td class="num">${esc(usd(x.cost_usd))}</td><td class="num">${(+x.messages || 0).toLocaleString()}</td><td class="num">${(+x.tokens_in || 0).toLocaleString()}</td><td class="num">${(+x.tokens_out || 0).toLocaleString()}</td></tr>`).join('')}</tbody>
        <tfoot><tr><th>${esc(G.total)}</th><th></th><th class="num">${esc(usd(tot.c))}</th><th class="num">${tot.m.toLocaleString()}</th><th class="num">${tot.i.toLocaleString()}</th><th class="num">${tot.o.toLocaleString()}</th></tr></tfoot>
      </table></div>` : `<div class="empty">${esc(G.empty)}</div>`}
      ${sysHtml}`;
    body.querySelectorAll('[data-days]').forEach((b) => { b.onclick = () => { days = +b.dataset.days; draw().catch((e) => { body.innerHTML = errorHtml(e.message); }); }; });
  };
  await draw();
}

/* ================= 货架 ================= */
async function shelves(body) {
  const S = A.shelves;
  const r = await get('/api/admin/shelves');
  const list = pick(r, 'items', 'shelves');
  const reload = () => shelves(body).catch((e) => toastError(e));
  body.innerHTML = `
    <form class="inline-form" data-new style="margin-bottom:16px">
      <input class="input" name="title" aria-label="${esc(S.title)}" placeholder="${esc(S.title)}" maxlength="40">
      <button class="btn btn-primary" type="submit">${esc(S.add)}</button>
    </form>
    ${list.length ? list.map((s) => `
      <div class="panel" data-shelf="${esc(s.id)}">
        <div class="row" style="border-bottom:1px solid var(--border)">
          <div class="row-main"><div class="row-title">${esc(s.title)}</div><div class="row-sub">${esc(S.count((s.items || []).length))}</div></div>
          <button class="btn btn-sm" data-act="add">${esc(S.add_char)}</button>
          <button class="icon-btn" data-act="rename" aria-label="${esc(S.rename)}">${icon('edit')}</button>
          <button class="icon-btn" data-act="delete" aria-label="${esc(zh.delete)}">${icon('trash')}</button>
        </div>
        ${(s.items || []).length ? (s.items || []).map((c, i, arr) => `
          <div class="shelf-item" data-path="${esc(c.path)}">
            ${avatar(c.avatar, c.name)}
            <div class="row-main"><div class="row-title">${esc(c.name)}</div><div class="row-sub">${esc(c.path)}</div></div>
            <button class="icon-btn" data-act="up" aria-label="${esc(S.up)}" ${i === 0 ? 'disabled style="opacity:.3"' : ''}>${icon('up')}</button>
            <button class="icon-btn" data-act="down" aria-label="${esc(S.down)}" ${i === arr.length - 1 ? 'disabled style="opacity:.3"' : ''}>${icon('down')}</button>
            <button class="icon-btn" data-act="remove" aria-label="${esc(zh.remove)}">${icon('x')}</button>
          </div>`).join('') : `<div class="panel-pad muted small">${esc(S.empty_items)}</div>`}
      </div>`).join('') : `<div class="empty">${esc(S.empty)}</div>`}`;

  body.querySelector('[data-new]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = e.target.title.value.trim();
    if (!title) return;
    try { await post('/api/admin/shelves', { title }); reload(); } catch (ex) { toastError(ex); }
  });

  body.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const shelfEl = b.closest('[data-shelf]');
    if (!shelfEl) return;
    const shelf = list.find((x) => String(x.id) === shelfEl.dataset.shelf);
    const sid = encodeURIComponent(shelf.id);
    const itemEl = b.closest('[data-path]');
    const act = b.dataset.act;
    try {
      if (act === 'delete') {
        if (!await confirmDialog(S.delete_confirm, { danger: true, ok: zh.delete })) return;
        await del('/api/admin/shelves/' + sid);
      } else if (act === 'rename') {
        const t = await promptTitle(shelf.title);
        if (!t || t === shelf.title) return;
        await patch('/api/admin/shelves/' + sid, { title: t });
      } else if (act === 'add') {
        await pickCharacter(shelf);
      } else if (act === 'remove') {
        await del('/api/admin/shelves/' + sid + '/items/' + encPath(itemEl.dataset.path));
      } else if (act === 'up' || act === 'down') {
        const paths = (shelf.items || []).map((c) => c.path);
        const i = paths.indexOf(itemEl.dataset.path);
        const j = act === 'up' ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= paths.length) return;
        [paths[i], paths[j]] = [paths[j], paths[i]];
        await post('/api/admin/shelves/' + sid + '/order', { paths });
      }
      store.homeCache = null;
      reload();
    } catch (ex) { toastError(ex); }
  };
}

function promptTitle(value) {
  return new Promise((resolve) => {
    const s = openSheet(`<div class="sheet-title">${esc(A.shelves.rename)}</div>
      <form><div class="field"><input class="input" name="t" maxlength="40" aria-label="${esc(A.shelves.title)}"></div>
      <div class="sheet-actions"><button class="btn" type="button" data-c>${esc(zh.cancel)}</button><button class="btn btn-primary" type="submit">${esc(zh.save)}</button></div></form>`,
    { onClose: (v) => resolve(typeof v === 'string' ? v : null) });
    const f = s.el.querySelector('form');
    f.t.value = value || '';
    f.querySelector('[data-c]').onclick = () => s.close(null);
    f.addEventListener('submit', (e) => { e.preventDefault(); s.close(f.t.value.trim()); });
    setTimeout(() => f.t.focus(), 50);
  });
}

function pickCharacter(shelf) {
  const S = A.shelves;
  return new Promise((resolve) => {
    let added = false;
    const s = openSheet(`<div class="sheet-title">${esc(S.add_char)} · ${esc(shelf.title)}</div>
      <div class="search-box" style="box-shadow:none;margin-bottom:10px">${icon('search')}<input type="search" aria-label="${esc(S.search_char)}" placeholder="${esc(S.search_char)}" autocomplete="off"></div>
      <div data-res style="min-height:120px"></div>`, { onClose: () => resolve(added) });
    const input = s.el.querySelector('input');
    const res = s.el.querySelector('[data-res]');
    const have = new Set((shelf.items || []).map((c) => c.path));
    let seq = 0;
    const run = async () => {
      const my = ++seq;
      res.innerHTML = spinnerHtml();
      try {
        const r = await get('/api/search?' + new URLSearchParams({ q: input.value.trim(), sort: 'trending_downloads', page: '1' }));
        if (my !== seq) return;
        const items = r.items || [];
        res.innerHTML = items.length ? items.map((c) => `
          <div class="shelf-item" data-path="${esc(c.path)}">${avatar(c.avatar, c.name)}
            <div class="row-main"><div class="row-title">${esc(c.name)}</div><div class="row-sub">${esc(c.tagline || c.path)}</div></div>
            <button class="btn btn-sm" data-pick ${have.has(c.path) ? 'disabled' : ''}>${esc(have.has(c.path) ? S.added : zh.add)}</button>
          </div>`).join('') : `<div class="empty">${esc(zh.search.empty)}</div>`;
      } catch (e) { if (my === seq) res.innerHTML = errorHtml(e.message); }
    };
    res.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b || b.disabled) return;
      const path = b.closest('[data-path]').dataset.path;
      b.disabled = true;
      try {
        await post('/api/admin/shelves/' + encodeURIComponent(shelf.id) + '/items', { path });
        have.add(path);
        added = true;
        b.textContent = S.added;
      } catch (ex) { b.disabled = false; toastError(ex); }
    });
    input.addEventListener('input', debounce(run, 400));
    run();
    setTimeout(() => input.focus(), 50);
  });
}

/* ================= 站点设置 ================= */
async function settings(body, ctx, lifecycle) {
  const T = A.settings;
  const controller = new AbortController();
  let disposed = false, statusBusy = false, submitHandler = null, refreshButton = null;
  const active = () => !disposed && lifecycle.isCurrent();
  const stop = () => {
    disposed = true;
    controller.abort();
    if (refreshButton) refreshButton.onclick = null;
    if (submitHandler) body.querySelector('form').removeEventListener('submit', submitHandler);
  };
  lifecycle.setStop(stop);
  let r, apiModels;
  try {
    [r, apiModels] = await Promise.all([
      get('/api/admin/settings', { signal: controller.signal }),
      get('/api/models', { signal: controller.signal }).catch(() => ({ items: [] })),
    ]);
  } catch (error) { if (!active() || error?.name === 'AbortError') return; throw error; }
  if (!active()) return;
  const st = (r && r.settings) || r || {};
  const modelItems = Array.isArray(apiModels?.items) ? apiModels.items.filter((m) => m && Number.isSafeInteger(Number(m.id)) && Number(m.id) > 0) : [];
  let apiOptions = `<option value="">${esc(T.translate_api_follow)}</option>` + modelItems.map((m) =>
    `<option value="${esc(m.id)}">${esc(m.name)}${m.provider ? ' · ' + esc(m.provider) : ''}</option>`).join('');
  if (st.translate_model_id != null && !modelItems.some((m) => String(m.id) === String(st.translate_model_id))) {
    apiOptions += `<option value="${esc(st.translate_model_id)}" disabled>${esc(T.translate_api_unavailable(st.translate_model_id))}</option>`;
  }
  body.innerHTML = `<form class="panel panel-pad" novalidate>
    <div class="field"><label for="st-n">${esc(T.site_name)}</label><input id="st-n" class="input" name="site_name" maxlength="40"></div>
    <div class="field"><label for="st-l">${esc(T.default_daily_limit)}</label><input id="st-l" class="input" name="default_daily_limit" inputmode="numeric" pattern="[0-9]*"><span class="hint">${esc(T.default_daily_limit_hint)}</span></div>
    <label class="row" style="padding:10px 0"><div class="row-main">${esc(T.allow_user_chub_search)}</div><span class="switch"><input type="checkbox" name="allow_user_chub_search"><span></span></span></label>
    <div class="field"><label for="st-fx">${esc(T.cny_to_usd)}</label><input id="st-fx" class="input" name="cny_to_usd" inputmode="decimal" autocomplete="off"><span class="hint">${esc(T.cny_to_usd_hint)}</span></div>
    <div class="field"><label for="st-lr">${esc(T.log_retention_days)}</label><input id="st-lr" class="input" name="log_retention_days" inputmode="numeric" pattern="[0-9]*" autocomplete="off"><span class="hint">${esc(T.log_retention_days_hint)}</span></div>
    <section class="admin-translation-settings" aria-labelledby="st-tr-title">
      <h2 class="section-title" id="st-tr-title">${esc(T.translate_title)}</h2>
      <div class="admin-translation-fields">
        <div class="field"><label for="st-tr-backend">${esc(T.translate_backend)}</label><select id="st-tr-backend" class="select" name="translate_backend">
          <option value="cli">${esc(T.translate_backend_cli)}</option><option value="api">${esc(T.translate_backend_api)}</option></select></div>
        <div class="field"><label for="st-tr-cli-model">${esc(T.translate_cli_model)}</label><select id="st-tr-cli-model" class="select" name="translate_cli_model">
          <option value="grok-4.5">Grok 4.5</option><option value="grok-4.7">Grok 4.7</option></select></div>
        <div class="field"><label for="st-tr-api-model">${esc(T.translate_api_model)}</label><select id="st-tr-api-model" class="select" name="translate_model_id">${apiOptions}</select></div>
      </div>
      <p class="admin-translation-hint">${esc(T.translate_backend_hint)}</p>
      <div class="admin-cli-status"><p data-cli-status role="status" aria-live="polite">${esc(T.translate_cli_loading)}</p>
        <button class="btn btn-secondary" type="button" data-cli-refresh>${esc(T.translate_cli_refresh)}</button></div>
      <p class="admin-translation-hint" data-cli-quota-hint hidden></p>
    </section>
    <div class="form-error" role="alert"></div>
    <button class="btn btn-primary btn-block" type="submit">${esc(zh.save)}</button>
  </form>`;
  const f = body.querySelector('form');
  f.site_name.value = st.site_name || '';
  f.default_daily_limit.value = st.default_daily_limit == null ? '0' : String(st.default_daily_limit);
  f.allow_user_chub_search.checked = st.allow_user_chub_search == null ? true : truthy(st.allow_user_chub_search) || st.allow_user_chub_search === 'true';
  const fx0 = st.cny_to_usd == null || st.cny_to_usd === '' ? '' : String(st.cny_to_usd);
  f.cny_to_usd.value = fx0 || '0.14';
  const lr0 = st.log_retention_days == null || st.log_retention_days === '' ? '' : String(st.log_retention_days);
  f.log_retention_days.value = lr0 || '90';
  f.translate_backend.value = st.translate_backend === 'cli' ? 'cli' : 'api';
  f.translate_cli_model.value = st.translate_cli_model === 'grok-4.7' ? 'grok-4.7' : 'grok-4.5';
  f.translate_model_id.value = st.translate_model_id == null ? '' : String(st.translate_model_id);
  const statusEl = body.querySelector('[data-cli-status]');
  refreshButton = body.querySelector('[data-cli-refresh]');
  async function refreshCLIStatus() {
    if (!active() || statusBusy) return;
    statusBusy = true;
    refreshButton.disabled = true;
    statusEl.textContent = T.translate_cli_loading;
    statusEl.setAttribute('aria-busy', 'true');
    try {
      const response = await get('/api/admin/translation/cli-status', { signal: controller.signal });
      if (!active()) return;
      const quota = response?.quota;
      const collected = typeof quota?.collectedAt === 'number' ? quota.collectedAt : Date.parse(quota?.collectedAt || '');
      const age = Date.now() - collected;
      const verified = quota?.ok === true && quota.status === 'ok' && Number.isFinite(collected) && age >= -1000 && age <= 30000;
      const remaining = verified && typeof quota.remainingPercent === 'number' && Number.isFinite(quota.remainingPercent)
        && quota.remainingPercent >= 0 && quota.remainingPercent <= 100 ? quota.remainingPercent : null;
      const min = Number.isFinite(response?.min_remaining_percent) ? response.min_remaining_percent : 55;
      const hintEl = body.querySelector('[data-cli-quota-hint]');
      if (hintEl) { hintEl.textContent = T.translate_cli_quota_hint(min); hintEl.hidden = false; }
      if (remaining == null) statusEl.textContent = min > 0 ? T.translate_cli_unknown : (response?.available === true ? T.translate_cli_unknown_free : T.translate_cli_paused);
      else {
        const amount = String(Math.round(remaining * 10) / 10);
        const available = response.available === true && remaining >= min;
        const time = fmtDateTime(quota.collectedAt);
        statusEl.textContent = `${available ? T.translate_cli_available : T.translate_cli_paused} · ${T.translate_cli_remaining(amount)}${time ? ' · ' + T.translate_cli_collected(time) : ''}`;
      }
    } catch (error) {
      if (active() && error?.name !== 'AbortError') statusEl.textContent = T.translate_cli_unknown;
    } finally {
      statusBusy = false;
      if (active()) { refreshButton.disabled = false; statusEl.setAttribute('aria-busy', 'false'); }
    }
  }
  refreshButton.onclick = refreshCLIStatus;
  refreshCLIStatus();
  submitHandler = async (e) => {
    e.preventDefault();
    if (!active()) return;
    const err = f.querySelector('.form-error');
    err.textContent = '';
    const lim = f.default_daily_limit.value.trim() || '0';
    if (!/^\d+$/.test(lim)) { err.textContent = T.default_daily_limit_hint; return; }
    const fxText = f.cny_to_usd.value.trim();
    const fx = Number(fxText);
    if (!fxText || !/^\d*\.?\d+$/.test(fxText) || !(fx > 0)) { err.textContent = T.cny_to_usd_invalid; f.cny_to_usd.focus(); return; }
    const lrText = f.log_retention_days.value.trim();
    const lr = Number(lrText);
    if (!/^\d+$/.test(lrText) || lr < 1 || lr > 3650) { err.textContent = T.log_retention_days_invalid; f.log_retention_days.focus(); return; }
    const backend = f.translate_backend.value, cliModel = f.translate_cli_model.value;
    const apiModelText = f.translate_model_id.value;
    if (!['cli', 'api'].includes(backend) || !['grok-4.5', 'grok-4.7'].includes(cliModel)
      || (apiModelText !== '' && (!/^\d+$/.test(apiModelText) || Number(apiModelText) <= 0))) {
      err.textContent = T.translate_invalid; return;
    }
    const data = {
      site_name: f.site_name.value.trim() || zh.site_name,
      default_daily_limit: Number(lim),
      allow_user_chub_search: f.allow_user_chub_search.checked ? 1 : 0,
      translate_backend: backend, translate_cli_model: cliModel, translate_model_id: apiModelText === '' ? null : Number(apiModelText),
    };
    if (fxText !== fx0) data.cny_to_usd = fx;
    if (lrText !== lr0) data.log_retention_days = lr;
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = zh.saving || '正在保存…';
    try {
      await patch('/api/admin/settings', data, { signal: controller.signal });
      if (!active()) return;
      clearTranslationModelsCache();
      store.siteName = data.site_name;
      document.querySelectorAll('.brand-name').forEach((x) => { x.textContent = data.site_name; });
      toast(zh.saved);
    } catch (ex) { if (active() && ex?.name !== 'AbortError') err.textContent = ex.message; }
    finally { if (active()) { btn.disabled = false; btn.textContent = zh.save; } }
  };
  f.addEventListener('submit', submitHandler);
}

/* ================= 自建卡（super，只读，契约 §12.3） ================= */
// 列表接口按契约 §12.3 的筛选项：GET /api/admin/cards?q=&owner_id=&visibility=&kind=&include_deleted=&page=
export const cardsState = { q: '', owner_id: '', owner_name: '', visibility: '', kind: '', include_deleted: true, fromList: false };

async function cardsList(body, ctx) {
  const K = A.cards;
  const st = cardsState;
  const ur = await get('/api/admin/users').catch(() => null);
  const userList = pick(ur, 'items', 'users');
  body.innerHTML = `
    <p class="muted small" style="margin:0 0 10px">${esc(K.lead)}</p>
    <form class="admin-filters card-filters panel panel-pad" novalidate data-filters>
      <div class="search-box rf-q">${icon('search')}<input type="search" name="q" aria-label="${esc(K.keyword)}" placeholder="${esc(K.keyword)}" autocomplete="off" enterkeyhint="search"></div>
      <label class="rf-field rf-owner"><span>${esc(K.owner)}</span><select class="input select" name="owner_id"></select></label>
      <label class="rf-field"><span>${esc(K.visibility)}</span><select class="input select" name="visibility">
        <option value="">${esc(K.all_vis)}</option><option value="private">${esc(zh.visibility.private)}</option><option value="public">${esc(zh.visibility.public)}</option></select></label>
      <label class="rf-field"><span>${esc(K.kind)}</span><select class="input select" name="kind">
        <option value="">${esc(K.all_kinds)}</option><option value="character">${esc(zh.kinds.character)}</option><option value="scenario">${esc(zh.kinds.scenario)}</option></select></label>
      <label class="rf-check"><input type="checkbox" name="include_deleted"><span>${esc(K.include_deleted)}</span></label>
      <div class="rf-foot"><span class="form-error" role="alert"></span><button class="btn btn-sm" type="button" data-clear>${icon('x')}<span>${esc(K.clear)}</span></button></div>
    </form>
    <div data-results></div>`;
  const f = body.querySelector('[data-filters]');
  const results = body.querySelector('[data-results]');
  results.addEventListener('click', (e) => { if (e.target.closest('.acard-item')) cardsState.fromList = true; });
  const userLabel = (u) => {
    const n = u.display_name || u.username || `#${u.id}`;
    return u.username && u.display_name && u.display_name !== u.username ? `${n}（${u.username}）` : n;
  };
  const fillUsers = () => {
    const opts = userList.map((u) => [String(u.id), userLabel(u)]);
    if (st.owner_id && !opts.some(([v]) => v === st.owner_id)) opts.unshift([st.owner_id, st.owner_name || `#${st.owner_id}`]);
    f.owner_id.innerHTML = `<option value="">${esc(K.all_owners)}</option>` + opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
    f.owner_id.value = st.owner_id;
  };
  fillUsers();
  f.q.value = st.q;
  f.visibility.value = st.visibility;
  f.kind.value = st.kind;
  f.include_deleted.checked = st.include_deleted !== false;

  let seq = 0;
  let page = 1;
  let items = [];
  const qs = (p) => {
    const o = { page: String(p) };
    for (const k of ['q', 'owner_id', 'visibility', 'kind']) if (st[k]) o[k] = st[k];
    if (st.include_deleted === false) o.include_deleted = '0';
    return new URLSearchParams(o).toString();
  };
  const rowHtml = (raw) => {
    const c = normCard(raw);
    const meta = [c.owner.name ? `${K.owner} ${c.owner.name}` : '', c.chats ? `${K.chats} ${c.chats}` : '', timeAgo(c.updated_at || c.created_at)].filter(Boolean);
    return `<a class="row admin-list-item acard-item${c.deleted_at ? ' row-deleted' : ''}" href="#/admin/card/${encodeURIComponent(c.id)}">
      ${avatar(c.avatar, c.name, 'avatar', 44)}
      <div class="row-main">
        <div class="row-title">${esc(c.name)}</div>
        <div class="row-badges">${cardBadgesHtml(c)}</div>
        ${c.tagline ? `<div class="row-sub">${esc(c.tagline)}</div>` : ''}
        <div class="row-sub">${esc(meta.join(' · '))}${c.fork ? ` · ${esc(zh.ucard.forked_from)} ${esc(c.fork.unavailable ? zh.ucard.fork_unavailable : (c.fork.name || zh.ucard.fork_unknown))}` : ''}</div>
      </div>
    </a>`;
  };
  const draw = (hasMore) => {
    const any = st.q || st.owner_id || st.visibility || st.kind || st.include_deleted === false;
    f.querySelector('[data-clear]').hidden = !any;
    results.innerHTML = items.length
      ? `<div class="panel">${items.map(rowHtml).join('')}</div>${hasMore ? `<div class="load-more"><button class="btn btn-sm" data-more>${esc(zh.load_more)}</button></div>` : ''}`
      : `<div class="empty">${esc(K.empty)}</div>`;
    const mb = results.querySelector('[data-more]');
    if (mb) mb.onclick = () => run(page + 1);
  };
  const run = async (p = 1) => {
    const my = ++seq;
    if (p === 1) results.innerHTML = spinnerHtml();
    else { const mb = results.querySelector('[data-more]'); if (mb) { mb.disabled = true; mb.textContent = zh.loading; } }
    try {
      const r = await get('/api/admin/cards?' + qs(p));
      if (my !== seq || !ctx.isActive()) return;
      const got = pick(r, 'items', 'cards');
      items = p === 1 ? got : items.concat(got);
      page = p;
      draw(!!(r && r.has_more));
    } catch (e) {
      if (my !== seq) return;
      if (p === 1) {
        results.innerHTML = errorHtml(e.message);
        results.querySelector('[data-retry]').onclick = () => run(1);
      } else { toastError(e); draw(true); }
    }
  };
  const apply = () => {
    st.q = f.q.value.trim();
    st.owner_id = f.owner_id.value;
    st.owner_name = st.owner_id ? (f.owner_id.selectedOptions[0] || {}).textContent : '';
    st.visibility = f.visibility.value;
    st.kind = f.kind.value;
    st.include_deleted = f.include_deleted.checked;
    run(1);
  };
  const applyLater = debounce(() => { if (ctx.isActive() && body.isConnected) apply(); }, 400);
  f.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
  f.q.addEventListener('input', applyLater);
  ['owner_id', 'visibility', 'kind', 'include_deleted'].forEach((k) => f[k].addEventListener('change', apply));
  f.querySelector('[data-clear]').onclick = () => {
    Object.assign(st, { q: '', owner_id: '', owner_name: '', visibility: '', kind: '', include_deleted: true });
    f.q.value = ''; f.visibility.value = ''; f.kind.value = ''; f.include_deleted.checked = true;
    fillUsers();
    run(1);
  };
  await run(1);
}

/* ================= 系统日志（super，只读，契约 §11.3 / §11.4） ================= */
// 筛选条件留在模块里：切走标签再回来时保持原样
const logsState = { kind: '', level: '', actor_id: '', actor_name: '', q: '', from: '', to: '' };
const LOG_LEVELS = ['info', 'warn', 'error'];
const LOG_GROUP_ORDER = ['auth', 'user', 'invite', 'card', 'chat', 'message', 'model', 'shelf', 'settings', 'llm', 'system'];
const logGroupOf = (k) => String(k || '').split('.')[0];
const isPlainObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// 类型中文名：i18n 优先，其次服务端给的中文名，最后原样
function logKindName(kind, serverNames) {
  const L = A.logs;
  if (!kind) return '';
  if (L.kinds[kind]) return L.kinds[kind];
  if (kind.endsWith('.') && L.groups[kind.slice(0, -1)]) return L.group_all(L.groups[kind.slice(0, -1)]);
  return (serverNames && serverNames.get(kind)) || kind;
}

// GET /api/admin/logs/kinds 的返回形态尽量宽松地读：[{kind,name}] / ['auth.login'] / {kinds:{kind:name}}
function normalizeKinds(r) {
  const out = new Map();
  const add = (k, n) => { if (typeof k === 'string' && k) out.set(k, typeof n === 'string' && n ? n : (out.get(k) || '')); };
  const walk = (v) => {
    if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === 'string') add(x, '');
        else if (isPlainObj(x)) add(x.kind || x.key || x.value || x.id, x.name || x.label || x.title || x.zh);
      }
    } else if (isPlainObj(v)) {
      for (const [k, n] of Object.entries(v)) add(k, typeof n === 'string' ? n : (isPlainObj(n) ? n.name || n.label : ''));
    }
  };
  if (Array.isArray(r)) walk(r);
  else if (isPlainObj(r)) walk(r.items || r.kinds || r.data || {});
  return out;
}

// 日志时间精确到秒，按新加坡时区（与筛选的日期口径一致）
const LOG_TZ = 'Asia/Singapore';
let logTimeFmt = null;
function fmtLogTime(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (!v || Number.isNaN(d.getTime())) return v ? String(v) : '';
  try {
    if (!logTimeFmt) logTimeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: LOG_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const o = {};
    for (const x of logTimeFmt.formatToParts(d)) o[x.type] = x.value;
    return `${o.year}-${o.month}-${o.day} ${o.hour}:${o.minute}:${o.second}`;
  } catch {
    const p2 = (x) => String(x).padStart(2, '0');
    return `${fmtDateTime(d)}:${p2(d.getSeconds())}`;
  }
}

// 取值转成中文文本。users：id → 账号名（用于「租户转交给」这类只存了 id 的字段）
function logValueText(v, key, users) {
  const L = A.logs;
  if (v === null || v === undefined || v === '') return L.empty_value;
  if (v === true) return L.yes;
  if (v === false) return L.no;
  if (key === 'role' && typeof v === 'string' && zh.roles[v]) return zh.roles[v];
  if (L.value_keys.includes(key) && typeof v === 'string' && L.values[v]) return L.values[v];
  if (L.time_fields.includes(key) && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return fmtLogTime(v);
  if (key === 'tenants_transferred_to' && users) {
    const u = users.find((x) => String(x.id) === String(v));
    if (u) return u.display_name || u.username || `#${u.id}`;
    return `#${v}`;
  }
  if (Array.isArray(v)) {
    if (!v.length) return L.empty_value;
    // 每项都有名称就只列名称；纯文本/数字直接用顿号连起来
    if (v.every((x) => isPlainObj(x) && (x.name || x.title))) return v.map((x) => x.name || x.title).join(L.list_sep);
    if (v.every((x) => x == null || typeof x !== 'object')) return v.map((x) => logValueText(x, key, users)).join(L.list_sep);
  }
  if (isPlainObj(v) && (v.name || v.title) && Object.keys(v).every((k) => ['id', 'name', 'title'].includes(k))) return v.name || v.title;
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}
const logFieldName = (k) => A.logs.fields[k] || k;

// 密码、密钥这类变更：旧值本来就不记，只显示新值，不显示「（空） →」
const LOG_SECRET_FIELDS = ['password', 'api_key', 'key'];
const LOG_SECRET_VALUES = ['已重置', '已更换'];

// 把 detail 拆成「字段变更（旧 → 新）」与「其他信息」两组。
// 只有 changes / diff 里的条目，或顶层带 old/new、before/after、from+to 键的对象，才算变更；
// 顶层数组一律当作「其他信息」按列表显示（例如货架新顺序 paths），不按长度推断旧/新。
function splitLogDetail(detail) {
  const changes = [];
  const extras = [];
  let d = detail;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { if (d.trim()) extras.push({ key: '', value: d }); return { changes, extras }; } }
  if (d == null) return { changes, extras };
  if (!isPlainObj(d)) { extras.push({ key: '', value: d }); return { changes, extras }; }
  const pickKey = (o, ks) => ks.find((k) => hasOwn(o, k));
  const objChange = (field, v, label) => {
    if (!isPlainObj(v)) return null;
    const both = hasOwn(v, 'from') && hasOwn(v, 'to');
    const ok = pickKey(v, ['old', 'before']) || (both ? 'from' : null);
    const nk = pickKey(v, ['new', 'after']) || (both ? 'to' : null);
    if (!ok && !nk) return null;
    const ch = { field, label: label || (typeof v.label === 'string' ? v.label : ''), old: ok ? v[ok] : undefined, new: nk ? v[nk] : undefined, hasOld: !!ok, hasNew: !!nk };
    if (ch.hasOld && ch.old == null && (LOG_SECRET_FIELDS.includes(field) || LOG_SECRET_VALUES.includes(ch.new))) ch.hasOld = false;
    return ch;
  };
  const pushChanges = (src) => {
    if (Array.isArray(src)) {
      for (const c of src) {
        if (!isPlainObj(c)) continue;
        const field = c.field || c.key || c.name || '';
        const ch = objChange(field, c);
        if (ch) changes.push(ch);
      }
    } else if (isPlainObj(src)) {
      for (const [k, v] of Object.entries(src)) {
        let ch = objChange(k, v);
        if (!ch && Array.isArray(v) && v.length === 2) ch = { field: k, label: '', old: v[0], new: v[1], hasOld: true, hasNew: true };
        changes.push(ch || { field: k, label: '', old: undefined, new: v, hasOld: false, hasNew: true });
      }
    }
  };
  const hidden = A.logs.hidden_fields;
  for (const [k, v] of Object.entries(d)) {
    if (k === 'changes' || k === 'diff' || k === 'fields_changed') { pushChanges(v); continue; }
    if (hidden.includes(k)) continue;
    // role 已译成账号类型，role_name 重复，只留一个
    if (k === 'role_name' && hasOwn(d, 'role')) continue;
    const ch = objChange(k, v);
    if (ch) changes.push(ch); else extras.push({ key: k, value: v });
  }
  // 模型排序：变更里存的是 id 串，借 detail.order 的 {id,name} 换成名称
  if (Array.isArray(d.order) && d.order.every((x) => isPlainObj(x) && x.id != null)) {
    const names = new Map(d.order.map((x) => [String(x.id), x.name || `#${x.id}`]));
    const toNames = (v) => (typeof v === 'string' && v ? v.split(',').map((id) => names.get(id.trim()) || `#${id.trim()}`).join(A.logs.list_sep) : v);
    for (const c of changes) if (c.field === 'order') { c.old = toNames(c.old); c.new = toNames(c.new); }
    // 新顺序已经体现在变更里，不再重复列出
    if (changes.some((c) => c.field === 'order')) {
      const i = extras.findIndex((x) => x.key === 'order');
      if (i !== -1) extras.splice(i, 1);
    }
  }
  return { changes, extras };
}

function logTargetText(it) {
  const L = A.logs;
  const t = it.target_type;
  const id = it.target_id;
  if (!t && (id == null || id === '')) return '';
  const tn = (t && L.targets[t]) || t || '';
  const name = it.target_name || '';
  return [tn, name || (id != null && id !== '' ? `#${id}` : '')].filter(Boolean).join(' ');
}
const logActorText = (it) => {
  const a = it.actor || {};
  return a.name || it.actor_name || (a.id != null ? `#${a.id}` : A.logs.system_actor);
};

async function logsList(body, ctx) {
  const L = A.logs;
  const st = logsState;
  const [kr, ur] = await Promise.all([
    get('/api/admin/logs/kinds').catch(() => null),
    get('/api/admin/users').catch(() => null),
  ]);
  const serverKinds = normalizeKinds(kr);
  const userList = pick(ur, 'items', 'users');

  body.innerHTML = `
    <p class="muted small" style="margin:0 0 10px">${esc(L.lead)}</p>
    <form class="admin-filters log-filters panel panel-pad" novalidate data-filters>
      <div class="search-box rf-q">${icon('search')}<input type="search" name="q" aria-label="${esc(L.keyword)}" placeholder="${esc(L.keyword)}" autocomplete="off" enterkeyhint="search"></div>
      <label class="rf-field"><span>${esc(L.kind)}</span><select class="input select" name="kind"></select></label>
      <label class="rf-field"><span>${esc(L.level)}</span><select class="input select" name="level"></select></label>
      <label class="rf-field rf-actor"><span>${esc(L.actor)}</span><select class="input select" name="actor_id"></select></label>
      <label class="rf-field"><span>${esc(L.from)}</span><input class="input" type="date" name="from"></label>
      <label class="rf-field"><span>${esc(L.to)}</span><input class="input" type="date" name="to"></label>
      <div class="rf-foot"><span class="form-error" role="alert"></span><button class="btn btn-sm" type="button" data-clear>${icon('x')}<span>${esc(L.clear)}</span></button></div>
    </form>
    <div data-results></div>`;
  const f = body.querySelector('[data-filters]');
  const results = body.querySelector('[data-results]');
  const ferr = f.querySelector('.form-error');

  // 类型下拉：按前缀分组，每组第一项是「全部X类」（前缀匹配）
  const fillKinds = () => {
    const all = new Set([...Object.keys(L.kinds), ...serverKinds.keys()]);
    if (st.kind && !st.kind.endsWith('.')) all.add(st.kind);
    const groups = new Map();
    for (const k of all) {
      const g = logGroupOf(k);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(k);
    }
    const order = [...LOG_GROUP_ORDER.filter((g) => groups.has(g)), ...[...groups.keys()].filter((g) => !LOG_GROUP_ORDER.includes(g)).sort()];
    const known = Object.keys(L.kinds);
    const rank = (k) => { const i = known.indexOf(k); return i === -1 ? 999 : i; };
    f.kind.innerHTML = `<option value="">${esc(L.all_kinds)}</option>` + order.map((g) => {
      const gname = L.groups[g] || g;
      const ks = groups.get(g).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      return `<optgroup label="${esc(gname)}"><option value="${esc(g + '.')}">${esc(L.group_all(gname))}</option>${ks.map((k) => `<option value="${esc(k)}">${esc(logKindName(k, serverKinds))}</option>`).join('')}</optgroup>`;
    }).join('');
    f.kind.value = st.kind;
  };
  f.level.innerHTML = `<option value="">${esc(L.all_levels)}</option>` + LOG_LEVELS.map((k) => `<option value="${k}">${esc(L.levels[k])}</option>`).join('');
  const userLabel = (u) => {
    const n = u.display_name || u.username || `#${u.id}`;
    return u.username && u.display_name && u.display_name !== u.username ? `${n}（${u.username}）` : n;
  };
  const fillActors = () => {
    const opts = userList.map((u) => [String(u.id), `${userLabel(u)} · ${zh.roles[roleOf(u)] || ''}`]);
    if (st.actor_id && !opts.some(([v]) => v === st.actor_id)) opts.unshift([st.actor_id, st.actor_name || `#${st.actor_id}`]);
    f.actor_id.innerHTML = `<option value="">${esc(L.all_actors)}</option>` + opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
    f.actor_id.value = st.actor_id;
  };
  fillKinds();
  fillActors();
  f.level.value = st.level;
  f.q.value = st.q;
  f.from.value = st.from;
  f.to.value = st.to;

  let seq = 0;
  let page = 1;
  let items = [];
  const qs = (p) => {
    const o = { page: String(p) };
    for (const k of ['kind', 'level', 'actor_id', 'q', 'from', 'to']) if (st[k]) o[k] = st[k];
    return new URLSearchParams(o).toString();
  };
  const lvOf = (it) => (LOG_LEVELS.includes(it.level) ? it.level : 'info');
  const rowHtml = (it, i) => {
    const lv = lvOf(it);
    const meta = [fmtLogTime(it.at), logActorText(it), logTargetText(it), it.ip || ''].filter(Boolean);
    return `<button class="row log-item" type="button" data-i="${i}">
      <span class="log-lv lv-${lv}" aria-hidden="true"></span>
      <div class="row-main">
        <div class="row-title log-title"><span>${esc(logKindName(it.kind, serverKinds))}</span>${lv !== 'info' ? `<span class="badge lv-${lv}">${esc(L.levels[lv])}</span>` : `<span class="sr-only">${esc(L.levels.info)}</span>`}</div>
        ${it.summary ? `<div class="row-sub log-summary">${esc(it.summary)}</div>` : ''}
        <div class="row-sub log-meta">${esc(meta.join(' · '))}</div>
      </div>
    </button>`;
  };
  const draw = (hasMore, loadingMore) => {
    const any = st.kind || st.level || st.actor_id || st.q || st.from || st.to;
    f.querySelector('[data-clear]').hidden = !any;
    results.innerHTML = items.length
      ? `<div class="panel">${items.map(rowHtml).join('')}</div>${hasMore ? `<div class="load-more"><button class="btn btn-sm" data-more ${loadingMore ? 'disabled' : ''}>${esc(loadingMore ? zh.loading : zh.load_more)}</button></div>` : ''}`
      : `<div class="empty">${esc(L.empty)}</div>`;
    const mb = results.querySelector('[data-more]');
    if (mb) mb.onclick = () => run(page + 1);
  };
  const run = async (p = 1) => {
    ferr.textContent = '';
    if (st.from && st.to && st.from > st.to) { seq++; ferr.textContent = L.date_invalid; results.innerHTML = ''; f.querySelector('[data-clear]').hidden = false; return; }
    const my = ++seq;
    if (p === 1) results.innerHTML = spinnerHtml();
    else { const mb = results.querySelector('[data-more]'); if (mb) { mb.disabled = true; mb.textContent = zh.loading; } }
    try {
      const r = await get('/api/admin/logs?' + qs(p));
      if (my !== seq || !ctx.isActive()) return;
      const got = pick(r, 'items');
      items = p === 1 ? got : items.concat(got);
      page = p;
      draw(!!(r && r.has_more), false);
    } catch (e) {
      if (my !== seq) return;
      if (p === 1) {
        results.innerHTML = errorHtml(e.message);
        results.querySelector('[data-retry]').onclick = () => run(1);
      } else { toastError(e); draw(true, false); }
    }
  };
  const apply = () => {
    st.kind = f.kind.value;
    st.level = f.level.value;
    st.actor_id = f.actor_id.value;
    st.actor_name = st.actor_id ? (f.actor_id.selectedOptions[0] || {}).textContent : '';
    st.q = f.q.value.trim();
    st.from = f.from.value;
    st.to = f.to.value;
    run(1);
  };
  const applyLater = debounce(() => { if (ctx.isActive() && body.isConnected) apply(); }, 400);
  f.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
  f.q.addEventListener('input', applyLater);
  ['kind', 'level', 'actor_id', 'from', 'to'].forEach((k) => f[k].addEventListener('change', apply));
  f.querySelector('[data-clear]').onclick = () => {
    Object.assign(st, { kind: '', level: '', actor_id: '', actor_name: '', q: '', from: '', to: '' });
    f.q.value = ''; f.from.value = ''; f.to.value = ''; f.level.value = '';
    fillKinds(); fillActors();
    run(1);
  };

  // 点开详情：字段变更按「旧 → 新」列出，其余信息逐项列出
  const openDetail = (it) => {
    const lv = lvOf(it);
    const { changes, extras } = splitLogDetail(it.detail !== undefined ? it.detail : it.detail_json);
    const a = it.actor || {};
    const actorId = a.id != null ? a.id : it.actor_id;
    const kv = (k, v) => (v ? `<div class="log-kv"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>` : '');
    const chHtml = changes.length ? `<div class="log-sec"><div class="log-sec-title">${esc(L.changes)}</div><ul class="log-changes">${changes.map((c) => {
      const oldT = c.hasOld === false ? '' : logValueText(c.old, c.field, userList);
      const newT = c.hasNew === false ? L.empty_value : logValueText(c.new, c.field, userList);
      return `<li><span class="log-field">${esc(L.change_labels[c.field] || c.label || logFieldName(c.field))}</span><span class="log-diff">${oldT ? `<span class="log-old">${esc(oldT)}</span><span class="log-arrow" aria-label="${esc(L.arrow)}">${esc(L.arrow)}</span>` : ''}<span class="log-new">${esc(newT)}</span></span></li>`;
    }).join('')}</ul></div>` : '';
    const exHtml = extras.length ? `<div class="log-sec"><div class="log-sec-title">${esc(L.extra)}</div><dl class="log-dl">${extras.map((x) => `<div class="log-kv"><dt>${esc(x.key ? logFieldName(x.key) : L.extra)}</dt><dd>${esc(logValueText(x.value, x.key, userList))}</dd></div>`).join('')}</dl></div>` : '';
    const btns = [];
    if (actorId != null && String(actorId) !== String(st.actor_id)) btns.push(`<button class="btn btn-sm" type="button" data-only="actor">${icon('user')}<span>${esc(L.only_actor)}</span></button>`);
    if (it.kind && it.kind !== st.kind) btns.push(`<button class="btn btn-sm" type="button" data-only="kind">${icon('search')}<span>${esc(L.only_kind)}</span></button>`);
    const title = logKindName(it.kind, serverKinds) || L.detail_title;
    const s = openSheet(`
      <div class="sheet-title log-sheet-title"><span class="log-lv lv-${lv}" aria-hidden="true"></span><span>${esc(title)}</span><span class="badge lv-${lv}">${esc(L.levels[lv])}</span></div>
      ${it.summary ? `<p class="sheet-text log-sheet-summary">${esc(it.summary)}</p>` : ''}
      <dl class="log-dl">
        ${kv(L.time, fmtLogTime(it.at))}
        ${kv(L.actor, logActorText(it))}
        ${kv(L.target, logTargetText(it))}
        ${kv(L.ip, it.ip || '')}
      </dl>
      ${chHtml}${exHtml}
      ${!changes.length && !extras.length ? `<p class="muted small log-none">${esc(L.no_detail)}</p>` : ''}
      <div class="sheet-actions log-actions">${btns.join('')}<button class="btn" type="button" data-close>${esc(zh.close)}</button></div>`, { label: title });
    s.el.querySelector('[data-close]').onclick = () => s.close();
    s.el.querySelectorAll('[data-only]').forEach((b) => {
      b.onclick = () => {
        s.close();
        if (b.dataset.only === 'actor') {
          st.actor_id = String(actorId);
          st.actor_name = logActorText(it);
          fillActors();
        } else {
          st.kind = it.kind;
          fillKinds();
        }
        run(1);
      };
    });
  };
  results.addEventListener('click', (e) => {
    const b = e.target.closest('.log-item');
    if (!b) return;
    const it = items[+b.dataset.i];
    if (it) openDetail(it);
  });
  await run(1);
}
