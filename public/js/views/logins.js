// 我的登录记录（契约 §14）：#/me/logins，所有身份都能看，只看自己账号
import { zh } from '/i18n/zh.js';
import { get } from '/js/api.js';
import { esc, fmtDateTime, timeAgo } from '/js/util.js';
import { icon, spinnerHtml, errorHtml } from '/js/ui.js';

const RESULTS = ['success', 'fail', 'locked'];

function resultOf(it) {
  const r = String((it && it.result) || '').toLowerCase();
  return RESULTS.includes(r) ? r : 'fail';
}

// 原因：服务端按契约给中文（密码错误 / 账号停用 / 尝试过多被锁）；若给的是代码就翻译
function reasonText(reason) {
  if (!reason) return '';
  const k = String(reason).trim();
  return zh.logins.reasons[k] || k;
}

export default async function logins(ctx) {
  const { root, setTitle, navigate } = ctx;
  const L = zh.logins;
  setTitle(L.title);
  root.innerHTML = `<div class="page page-narrow">
    <div class="page-head">
      <button class="icon-btn" data-back aria-label="${esc(zh.back)}" title="${esc(zh.back)}">${icon('back')}</button>
      <h1>${esc(L.title)}</h1>
    </div>
    <div class="warn-bar" role="note">${icon('alert')}<span>${esc(L.warn)} <a href="#/me?focus=password">${esc(L.change_password)}</a></span></div>
    <div data-list>${spinnerHtml()}</div>
    <div data-more></div>
    <p class="muted small" data-retention style="text-align:center;margin:12px 0 0"></p>
    <div style="height:24px"></div>
  </div>`;
  root.querySelector('[data-back]').onclick = () => navigate('#/me');

  const listEl = root.querySelector('[data-list]');
  const moreEl = root.querySelector('[data-more]');
  const retEl = root.querySelector('[data-retention]');
  const items = [];
  let page = 0;
  let hasMore = false;
  let loading = false;

  const rowHtml = (it) => {
    // 注册 / 用重置码改密码不是登录，单独标题 + 中性色标，不显示成「登录成功」
    const ev = String((it && it.event) || 'login').toLowerCase();
    if (ev !== 'login' && ev !== 'lockout') {
      const ip = it.ip || L.unknown_ip;
      const device = it.device || L.unknown_device;
      const title = L.events[ev] || it.event_name || ev;
      return `<div class="row event" role="listitem">
      <span class="login-dot event" aria-hidden="true"></span>
      <div class="row-main">
        <div class="row-title">${esc(title)}</div>
        <div class="row-sub">${esc(fmtDateTime(it.at))}</div>
        <div class="row-sub">${esc(L.ip)} <span class="mono">${esc(ip)}</span> · ${esc(device)}</div>
      </div>
      <span class="row-side">${esc(timeAgo(it.at))}</span>
    </div>`;
    }
    const res = resultOf(it);
    const reason = res === 'fail' ? reasonText(it.reason) : ''; // 锁定本身已说明原因，不重复
    const title = L.results[res] + (reason ? ` · ${reason}` : '');
    const ip = it.ip || L.unknown_ip;
    const device = it.device || L.unknown_device;
    return `<div class="row ${res}" role="listitem">
      <span class="login-dot ${res}" aria-hidden="true"></span>
      <div class="row-main">
        <div class="row-title">${esc(title)}</div>
        <div class="row-sub">${esc(fmtDateTime(it.at))}</div>
        <div class="row-sub">${esc(L.ip)} <span class="mono">${esc(ip)}</span> · ${esc(device)}</div>
      </div>
      <span class="row-side">${esc(timeAgo(it.at))}</span>
    </div>`;
  };

  const draw = () => {
    listEl.innerHTML = items.length
      ? `<div class="panel login-list" role="list">${items.map(rowHtml).join('')}</div>`
      : `<div class="empty">${icon('history')}<div class="empty-title">${esc(L.empty)}</div></div>`;
    moreEl.innerHTML = hasMore
      ? `<div class="center-pad"><button class="btn btn-sm" data-load>${esc(zh.load_more)}</button></div>`
      : (items.length > 10 ? `<p class="muted small" style="text-align:center;margin:12px 0 0">${esc(zh.no_more)}</p>` : '');
    const b = moreEl.querySelector('[data-load]');
    if (b) b.onclick = () => load(page + 1);
  };

  const load = async (p) => {
    if (loading) return;
    loading = true;
    const b = moreEl.querySelector('[data-load]');
    if (b) { b.disabled = true; b.textContent = zh.loading; }
    try {
      const r = await get('/api/me/logins?page=' + p);
      if (!ctx.isActive()) return;
      const got = Array.isArray(r && r.items) ? r.items : [];
      items.push(...got);
      page = Number(r && r.page) || p;
      hasMore = !!(r && r.has_more) && got.length > 0;
      const days = Number(r && (r.retention_days ?? r.log_retention_days));
      if (days > 0) retEl.textContent = L.retention(days);
      draw();
    } catch (e) {
      if (!ctx.isActive()) return;
      if (!items.length) {
        listEl.innerHTML = errorHtml(e.message);
        listEl.querySelector('[data-retry]').onclick = () => { listEl.innerHTML = spinnerHtml(); load(p); };
      } else {
        moreEl.innerHTML = errorHtml(e.message);
        moreEl.querySelector('[data-retry]').onclick = () => load(p);
      }
    } finally {
      loading = false;
    }
  };
  await load(1);
}
