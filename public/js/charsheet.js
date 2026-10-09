// 角色查看页「全部设定」（契约 §19.1 / §19.2）：chub 角色与自建卡共用。
// - 字段归一：同时认 Tavern V2 data（description/personality/first_mes/mes_example/character_book…）
//   与 chub definition（personality=描述、tavern_personality=性格、first_message、example_dialogs、embedded_lorebook、description=作者说明）。
// - 分区展示：每区可折叠，长文默认只显示前 6 行；有中文译文时中文为主，每区可「查看原文」。
import { zh } from '/i18n/zh.js';
import { esc, formatMessage, stripMarkup } from '/js/util.js';
import { icon, cardNameParts } from '/js/ui.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : typeof v === 'string' ? v : String(v));

function parseObj(v) {
  if (isObj(v)) return v;
  if (typeof v === 'string' && v.trim()) { try { const o = JSON.parse(v); return isObj(o) ? o : null; } catch { return null; } }
  return null;
}

const looksChub = (o) => ['first_message', 'example_dialogs', 'tavern_personality', 'embedded_lorebook'].some((k) => k in o);

function normKeys(v) {
  if (Array.isArray(v)) return v.map(str).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

/** 世界书条目：entries 可能是数组，也可能是 {id: entry} 对象 */
export function loreEntries(book) {
  const b = parseObj(book);
  if (!b) return [];
  let list = b.entries;
  if (isObj(list)) list = Object.values(list);
  if (!Array.isArray(list)) return [];
  return list.filter(isObj).map((e) => ({
    keys: normKeys(e.keys ?? e.key),
    secondary_keys: normKeys(e.secondary_keys ?? e.keysecondary),
    content: str(e.content),
    enabled: !(e.enabled === false || e.disable === true || e.enabled === 0),
    constant: e.constant === true || e.constant === 1,
    name: str(e.name || e.comment),
  }));
}

/**
 * 任意来源的设定 → 统一结构：
 * {description, personality, scenario, greetings[], mes_example, system_prompt, post_history_instructions, creator_notes, lore[]}
 * 输入为空返回 null。
 */
export function normDef(src) {
  let o = parseObj(src);
  if (!o) return null;
  if (isObj(o.data) && (o.spec || o.spec_version || !looksChub(o))) o = o.data; // 整张 V2 卡 {spec, data}
  if (isObj(o.definition)) o = o.definition;
  const chub = looksChub(o);
  const first = chub ? str(o.first_message) : str(o.first_mes ?? o.first_message);
  const alts = Array.isArray(o.alternate_greetings) ? o.alternate_greetings.map(str) : [];
  return {
    description: chub ? str(o.personality) : str(o.description),
    personality: chub ? str(o.tavern_personality) : str(o.personality),
    scenario: str(o.scenario),
    greetings: [first, ...alts].filter((g) => g.trim()),
    mes_example: chub ? str(o.example_dialogs) : str(o.mes_example ?? o.example_dialogs),
    system_prompt: str(o.system_prompt),
    post_history_instructions: str(o.post_history_instructions),
    creator_notes: chub ? str(o.description) : str(o.creator_notes),
    lore: loreEntries(chub ? (o.embedded_lorebook || o.character_book) : (o.character_book || o.embedded_lorebook)),
  };
}

const first = (...xs) => xs.find((x) => x != null && x !== '');

/**
 * chub 角色详情接口 → {orig, zh, status}
 * 原文：character.data / card / definition / card_json；译文：data_zh / card_zh / definition_zh / card_json_zh。
 * 旧接口只有 greeting / greeting_zh / creator_notes / description_zh 时也能显示。
 */
export function chubSheet(ch) {
  ch = ch || {};
  let orig = normDef(first(ch.data, ch.card, ch.definition, ch.card_json));
  if (!orig) {
    orig = { description: '', personality: '', scenario: '', greetings: [], mes_example: '', system_prompt: '', post_history_instructions: '', creator_notes: '', lore: [] };
  }
  if (!orig.greetings.length && str(ch.greeting).trim()) orig.greetings = [str(ch.greeting)];
  if (!orig.creator_notes && ch.creator_notes) orig.creator_notes = str(ch.creator_notes);
  let tr = normDef(first(ch.data_zh, ch.card_zh, ch.definition_zh, ch.card_json_zh));
  if (!tr && (str(ch.greeting_zh).trim() || str(ch.description_zh).trim())) {
    // 只有开场白译文（v0.9 及以前）
    tr = { description: str(ch.description_zh), personality: '', scenario: '', greetings: str(ch.greeting_zh).trim() ? [str(ch.greeting_zh)] : [], mes_example: '', system_prompt: '', post_history_instructions: '', creator_notes: '', lore: [] };
  }
  return { orig, zh: tr, status: translateStatus(ch) };
}

/** 'pending' | 'ok' | 'partial' | 'failed' | '' */
export function translateStatus(ch) {
  if (!ch) return '';
  const s = str(ch.translate_status).toLowerCase();
  if (ch.translating === true || s === 'pending' || s === 'translating' || s === 'running') return 'pending';
  if (s === 'ok' || s === 'done') return 'ok';
  if (s === 'partial' || s === 'failed') return s;
  return '';
}

/** 标签的中文：tags_zh 可以是与 tags 对齐的数组，也可以是 {原词: 中文} */
export function tagZh(ch, tag, i) {
  const t = ch && ch.tags_zh;
  if (Array.isArray(t)) return str(t[i]).trim() || '';
  if (isObj(t)) return str(t[tag] ?? t[String(tag).toLowerCase()]).trim() || '';
  return '';
}

/** 卡片名字：{main 显示用中文名, orig 小字原名（与 main 相同时为空）} */
export const cardNames = (c) => cardNameParts(c);
export const cardTagline = (c) => str(first(c && c.tagline_zh, c && c.tagline));

/* ---------- 渲染 ---------- */

function macro(text, names) {
  if (!text) return '';
  return String(text)
    .replace(/\{\{\s*char\s*\}\}|<BOT>/gi, names.char || '{{char}}')
    .replace(/\{\{\s*user\s*\}\}|<USER>/gi, names.user || '{{user}}');
}

const SECTIONS = [
  { key: 'creator_notes', title: (S) => S.creator_notes },
  { key: 'description', title: (S, scn) => (scn ? S.description_scenario : S.description) },
  { key: 'personality', title: (S) => S.personality },
  { key: 'scenario', title: (S) => S.scenario },
  { key: 'greetings', title: (S) => S.greetings, list: true },
  { key: 'mes_example', title: (S) => S.mes_example },
  { key: 'system_prompt', title: (S) => S.system_prompt },
  { key: 'post_history_instructions', title: (S) => S.post_history_instructions },
  { key: 'lore', title: (S) => S.lorebook, lore: true },
];

const hasVal = (def, key) => {
  if (!def) return false;
  const v = def[key];
  if (Array.isArray(v)) return v.some((x) => (isObj(x) ? (x.content || '').trim() || x.keys.length : String(x).trim()));
  return !!str(v).trim();
};
const sameVal = (a, b, key) => JSON.stringify(a && a[key]) === JSON.stringify(b && b[key]);

function textBlock(text, { label = '', chub = false, key = '' } = {}) {
  let t = String(text || '').trim();
  if (chub && key === 'creator_notes') t = stripMarkup(t);
  if (!t) return '';
  return `<div class="cs-item">${label ? `<div class="cs-item-label">${esc(label)}</div>` : ''}
    <div class="prose cs-clamp">${formatMessage(t)}</div>
    <button class="link-btn cs-more" type="button" data-cs-more hidden>${esc(zh.sheet.show_more)}</button></div>`;
}

function loreHtml(list, names) {
  const S = zh.sheet;
  return list.map((e, i) => {
    const badges = [e.constant ? `<span class="cs-badge on">${esc(S.lore_constant)}</span>` : '', !e.enabled ? `<span class="cs-badge off">${esc(S.lore_disabled)}</span>` : ''].join('');
    const keys = e.keys.length ? e.keys.map((k) => `<span class="cs-key">${esc(k)}</span>`).join('') : `<span class="muted small">${esc(S.lore_no_keys)}</span>`;
    return `<div class="cs-lore${e.enabled ? '' : ' off'}">
      <div class="cs-lore-head"><span class="cs-item-label">${esc(e.name || S.lore_entry(i + 1))}</span>${badges}</div>
      <div class="cs-keys" aria-label="${esc(S.lore_keys)}"><span class="cs-keys-label">${esc(S.lore_keys)}</span>${keys}</div>
      ${textBlock(macro(e.content, names))}
    </div>`;
  }).join('');
}

/**
 * 把设定画进 container。state 用来在重绘（例如翻译完成）时保留每区的「原文 / 中文」与折叠状态。
 * opts: {orig, zh, scenario(剧情卡), chub, names:{char, char_orig, user}}
 */
export function renderSheet(container, opts, state = { mode: new Map(), closed: new Set(), expanded: new Set() }) {
  const S = zh.sheet;
  const { orig, scenario = false, chub = false } = opts;
  const tr = opts.zh || null;
  const names = opts.names || {};
  const parts = [];
  for (const sec of SECTIONS) {
    const hasO = hasVal(orig, sec.key);
    const hasZ = hasVal(tr, sec.key);
    if (!hasO && !hasZ) continue;
    const canToggle = hasO && hasZ && !sameVal(orig, tr, sec.key);
    const mode = !hasZ ? 'orig' : (state.mode.get(sec.key) || (canToggle || hasZ ? 'zh' : 'orig'));
    const def = mode === 'zh' ? tr : orig;
    const nm = { char: mode === 'zh' ? names.char : (names.char_orig || names.char), user: names.user };
    let body;
    if (sec.list) {
      const gs = def.greetings;
      body = gs.map((g, i) => textBlock(macro(g, nm), { label: S.greeting_n(i + 1, gs.length) })).join('');
    } else if (sec.lore) {
      body = loreHtml(def.lore, nm);
    } else {
      body = textBlock(macro(def[sec.key], nm), { chub, key: sec.key });
    }
    if (!body) continue;
    const count = sec.lore ? `<span class="cs-count">${esc(S.lorebook_count(def.lore.length))}</span>` : (sec.list && def.greetings.length > 1 ? `<span class="cs-count">${esc(S.lorebook_count(def.greetings.length))}</span>` : '');
    const open = !state.closed.has(sec.key);
    parts.push(`<section class="section cs-sec" data-sec="${sec.key}">
      <details class="panel cs-fold"${open ? ' open' : ''}>
        <summary class="cs-head"><span class="section-title">${esc(sec.title(S, scenario))}</span>${count}${mode === 'orig' && canToggle ? `<span class="cs-badge">${esc(S.original_badge)}</span>` : ''}</summary>
        <div class="cs-body">
          ${canToggle ? `<div class="cs-tools"><button class="link-btn cs-toggle" type="button" data-cs-toggle aria-pressed="${mode === 'orig'}">${icon('globe')}<span>${esc(mode === 'orig' ? S.view_translation : S.view_original)}</span></button></div>` : ''}
          ${body}
        </div>
      </details>
    </section>`);
  }
  container.innerHTML = parts.length ? parts.join('') : `<p class="muted small cs-empty">${esc(S.empty)}</p>`;

  // 事件：折叠记忆、原文切换、长文展开
  container.querySelectorAll('.cs-sec').forEach((secEl) => {
    const key = secEl.dataset.sec;
    const det = secEl.querySelector('details');
    det.addEventListener('toggle', () => { if (det.open) state.closed.delete(key); else state.closed.add(key); if (det.open) measure(secEl, state, key); });
    const tg = secEl.querySelector('[data-cs-toggle]');
    if (tg) {
      tg.onclick = () => {
        const cur = tg.getAttribute('aria-pressed') === 'true' ? 'orig' : 'zh';
        state.mode.set(key, cur === 'orig' ? 'zh' : 'orig');
        renderSheet(container, opts, state);
        const again = container.querySelector(`[data-sec="${key}"] [data-cs-toggle]`);
        if (again) again.focus();
      };
    }
    measure(secEl, state, key);
  });
  return state;
}

// 长文只显示前 6 行：渲染后量一下是否被截断，截断了才露出「展开全文」
function measure(secEl, state, key) {
  requestAnimationFrame(() => {
    secEl.querySelectorAll('.cs-item').forEach((item, idx) => {
      const p = item.querySelector('.cs-clamp, .cs-unclamped');
      const btn = item.querySelector('[data-cs-more]');
      if (!p || !btn) return;
      const id = key + ':' + idx;
      if (state.expanded.has(id)) {
        p.classList.remove('cs-clamp'); p.classList.add('cs-unclamped');
        btn.hidden = false; btn.textContent = zh.sheet.show_less;
      } else if (p.classList.contains('cs-clamp')) {
        if (!p.clientHeight) return; // 折叠着，展开时再量
        btn.hidden = !(p.scrollHeight > p.clientHeight + 2);
      }
      btn.onclick = () => {
        const open = p.classList.contains('cs-clamp');
        p.classList.toggle('cs-clamp', !open);
        p.classList.toggle('cs-unclamped', open);
        btn.textContent = open ? zh.sheet.show_less : zh.sheet.show_more;
        if (open) state.expanded.add(id); else state.expanded.delete(id);
      };
    });
  });
}
