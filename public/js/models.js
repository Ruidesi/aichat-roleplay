// 模型列表与「选择模型」单选组件（我的 / 聊天页共用）
import { zh } from '/i18n/zh.js';
import { get } from '/js/api.js';
import { store } from '/js/store.js';
import { esc } from '/js/util.js';
import { icon, openSheet } from '/js/ui.js';

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/** GET /api/models，结果短暂缓存在 store；force 时重新拉 */
export async function loadModels(force = false) {
  const c = store.modelsCache;
  if (!force && c && Date.now() - c.at < 60000) return c.data;
  const r = await get('/api/models');
  const data = { items: Array.isArray(r && r.items) ? r.items : [], default_model_id: r ? r.default_model_id ?? null : null };
  store.modelsCache = { at: Date.now(), data };
  return data;
}

export const findModel = (items, id) => (items || []).find((m) => sameId(m.id, id)) || null;

/**
 * 单选列表 HTML。value=null 表示「跟随系统默认」（仅 withFollow 时出现）。
 * 每个选项是 role=radio 的按钮，data-mid 为模型 id（跟随为空串）。
 */
export function modelOptionsHtml({ items, value, withFollow = false, siteDefaultName = '' }) {
  const M = zh.models;
  const opt = (mid, title, sub, checked) => `
    <button type="button" class="model-opt${checked ? ' checked' : ''}" role="radio" aria-checked="${checked ? 'true' : 'false'}" data-mid="${esc(mid)}">
      <span class="model-opt-main"><span class="model-opt-name">${esc(title)}</span>${sub ? `<span class="model-opt-sub">${esc(sub)}</span>` : ''}</span>
      <span class="model-opt-check" aria-hidden="true">${icon('check')}</span>
    </button>`;
  let h = '';
  if (withFollow) h += opt('', M.follow, M.follow_sub(siteDefaultName), value == null);
  h += items.map((m) => opt(m.id, m.name, m.provider || '', sameId(m.id, value))).join('');
  return h;
}

/** 单选组的方向键 / roving tabindex */
export function wireRadioGroup(group, onPick) {
  const opts = () => [...group.querySelectorAll('[role="radio"]')];
  const sync = () => {
    const all = opts();
    const cur = all.find((b) => b.getAttribute('aria-checked') === 'true') || all[0];
    all.forEach((b) => { b.tabIndex = b === cur ? 0 : -1; });
  };
  sync();
  group.addEventListener('click', (e) => {
    const b = e.target.closest('[role="radio"]');
    if (b && !b.disabled) onPick(b.dataset.mid === '' ? null : b.dataset.mid, b);
  });
  group.addEventListener('keydown', (e) => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'];
    if (!keys.includes(e.key)) return;
    const all = opts();
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    all[(i + d + all.length) % all.length].focus();
  });
  return {
    set(id) {
      opts().forEach((b) => {
        const on = id == null ? b.dataset.mid === '' : sameId(b.dataset.mid, id);
        b.classList.toggle('checked', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      sync();
    },
  };
}

/**
 * 底部弹层选择模型。返回所选模型 id；关闭未选返回 undefined。
 */
export function pickModelSheet({ items, value, title, hint }) {
  const M = zh.models;
  return new Promise((resolve) => {
    const s = openSheet(`
      <div class="sheet-title" id="pm-t">${esc(title || M.title)}</div>
      ${hint ? `<p class="sheet-text small">${esc(hint)}</p>` : ''}
      ${items.length
        ? `<div class="model-list" role="radiogroup" aria-labelledby="pm-t">${modelOptionsHtml({ items, value })}</div>`
        : `<div class="empty">${esc(M.empty)}</div>`}
      <div class="sheet-actions"><button class="btn" type="button" data-a="no">${esc(zh.cancel)}</button></div>`,
    { label: title || M.title, onClose: (v) => resolve(v) });
    s.el.querySelector('[data-a="no"]').onclick = () => s.close(undefined);
    const group = s.el.querySelector('[role="radiogroup"]');
    if (group) {
      wireRadioGroup(group, (id) => s.close(id));
      const cur = group.querySelector('[aria-checked="true"]') || group.querySelector('[role="radio"]');
      setTimeout(() => cur && cur.focus(), 50);
    }
  });
}
