// 自建角色卡 / 剧情卡的公共逻辑（契约 §12）：字段归一、卡片网格、开聊、拷贝二创、导入导出、删除。
// 后端字段名以契约为准；对还没定死的细节做宽松兼容（嵌套 / 平铺两种写法都认）。
import { zh } from '/i18n/zh.js';
import { get, post, del, upload, ApiError } from '/js/api.js';
import { store } from '/js/store.js';
import { esc, fmtNum, encodeHashPath } from '/js/util.js';
import { icon, avatar, toast, toastError, confirmDialog } from '/js/ui.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const truthy = (v) => v === true || v === 1 || v === '1';
const str = (v) => (v == null ? '' : String(v));

function parseJson(v) {
  if (isObj(v)) return v;
  if (typeof v === 'string' && v.trim()) { try { const o = JSON.parse(v); return isObj(o) ? o : {}; } catch { return {}; } }
  return {};
}

/** 卡片定义（Tavern V2 data）：card_json 可能是对象、字符串，或整张 V2 卡（{spec, data}） */
export function cardData(c) {
  if (!c) return {};
  let d = parseJson(c.card_json != null ? c.card_json : c.data != null ? c.data : c.definition);
  if (isObj(d.data) && (d.spec || d.spec_version)) d = d.data;
  return d;
}

/** 头像地址：后端给 avatar / avatar_url；只给文件名时按 §12.1 拼读取地址 */
export function cardAvatarUrl(c) {
  if (!c) return '';
  if (c.avatar) return c.avatar;
  if (c.avatar_url) return c.avatar_url;
  if (c.avatar_file) return '/api/card-avatar/' + encodeURIComponent(String(c.avatar_file).split('/').pop());
  return '';
}

/** 改编来源：{type:'chub'|'user', ref, name, author} 或 null */
export function forkOf(c) {
  if (!c) return null;
  const f = isObj(c.forked_from) ? c.forked_from : null;
  const type = str(f ? f.type : c.forked_from_type);
  if (!type) return null;
  // v0.9 F5：源卡已删 / 改私有 / 源作者已删时，后端只给 {type, unavailable:true}，不带名字、作者与 id
  if (f && truthy(f.unavailable)) return { type, ref: '', name: '', author: '', unavailable: true };
  return {
    type,
    ref: str(f ? (f.ref ?? f.path ?? f.id) : c.forked_from_ref),
    name: str(f ? f.name : c.forked_from_name),
    author: str(f ? f.author : c.forked_from_author),
  };
}

/** 作者：{id, name} */
export function ownerOf(c) {
  if (!c) return { id: null, name: '' };
  // 管理视图给 owner 对象；普通视图给 author:{id,name}；字符串作者只作兜底
  const o = isObj(c.owner) ? c.owner : (isObj(c.author) ? c.author : null);
  const strAuthor = typeof c.author === 'string' ? c.author : '';
  return {
    id: o ? (o.id ?? null) : (c.owner_id ?? null),
    name: str(o ? (o.display_name || o.name || o.username || '') : (c.owner_name || c.owner_display_name || strAuthor || '')),
  };
}

export function isMine(c) {
  if (!c) return false;
  if ('is_owner' in c) return truthy(c.is_owner);
  if ('mine' in c) return truthy(c.mine);
  const o = ownerOf(c);
  return o.id != null && store.me && String(o.id) === String(store.me.id);
}

/** 统一后的卡片对象（列表 / 详情共用） */
export function normCard(c) {
  c = c || {};
  return {
    raw: c,
    id: c.id,
    kind: c.kind === 'scenario' ? 'scenario' : 'character',
    name: str(c.name),
    tagline: str(c.tagline),
    avatar: cardAvatarUrl(c),
    tags: Array.isArray(c.tags) ? c.tags.map(str).filter(Boolean) : parseJsonArr(c.tags_json),
    nsfw: truthy(c.nsfw),
    visibility: c.visibility === 'public' ? 'public' : 'private',
    fork: forkOf(c),
    owner: ownerOf(c),
    mine: isMine(c),
    chats: Number(c.chats ?? c.chat_count ?? 0) || 0,
    created_at: c.created_at,
    updated_at: c.updated_at,
    deleted_at: c.deleted_at || null,
    data: cardData(c),
  };
}
function parseJsonArr(v) {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  if (typeof v === 'string' && v.trim()) { try { const a = JSON.parse(v); return Array.isArray(a) ? a.map(str).filter(Boolean) : []; } catch { return []; } }
  return [];
}

export const cardHref = (id) => '#/u/' + encodeURIComponent(id);
export const editHref = (id) => '#/cards/' + encodeURIComponent(id) + '/edit';

/** 改编来源一行：「改编自 XXX · 原作者 YYY」，带链接（chub → 角色详情；站内 → 卡片详情） */
export function forkLineHtml(fork, { link = true } = {}) {
  if (!fork) return '';
  const U = zh.ucard;
  if (fork.unavailable) return `<p class="fork-line">${icon('fork')}<span>${esc(U.forked_from)} ${esc(U.fork_unavailable)}</span></p>`;
  const name = fork.name || U.fork_unknown;
  let href = '';
  if (link && fork.ref) href = fork.type === 'chub' ? '#/c/' + encodeHashPath(fork.ref) : cardHref(fork.ref);
  const nameHtml = href ? `<a href="${esc(href)}">${esc(name)}</a>` : esc(name);
  const src = fork.type === 'chub' ? `<span class="fork-src">${esc(U.fork_from_chub)}</span>` : '';
  return `<p class="fork-line">${icon('fork')}<span>${esc(U.forked_from)} ${nameHtml}${fork.author ? ` · ${esc(U.orig_author)} ${esc(fork.author)}` : ''}${src}</span></p>`;
}

/** 网格里的一张自建卡（社区 / 创作） */
export function ucardGridHtml(c0) {
  const c = c0 && c0.raw ? c0 : normCard(c0);
  const K = zh.kinds;
  const badges = [c.kind === 'scenario' ? `<span class="card-badge kind">${esc(K.scenario)}</span>` : '', c.nsfw ? '<span class="card-badge">18+</span>' : ''].filter(Boolean).join('');
  return `<a class="card" href="${cardHref(c.id)}">
    <div class="card-img">${avatar(c.avatar, c.name, 'card-avatar')}${badges ? `<div class="card-badges">${badges}</div>` : ''}</div>
    <div class="card-body">
      <div class="card-name">${esc(c.name)}</div>
      <div class="card-tag">${esc(c.tagline)}</div>
      <div class="card-meta">
        ${c.owner.name ? `<span class="card-author">${icon('user')}${esc(c.owner.name)}</span>` : ''}
        ${c.chats ? `<span>${icon('chat_bubble')}${fmtNum(c.chats)}</span>` : ''}
        ${c.fork ? `<span title="${esc(zh.ucard.forked_badge)}">${icon('fork')}</span>` : ''}
      </div>
    </div>
  </a>`;
}

/** 卡片徽标（列表行用） */
export function cardBadgesHtml(c, { kind = true, vis = true } = {}) {
  const parts = [];
  if (kind) parts.push(`<span class="badge kind-${c.kind}">${esc(zh.kinds[c.kind])}</span>`);
  if (vis) parts.push(`<span class="badge vis-${c.visibility}">${esc(zh.visibility[c.visibility])}</span>`);
  if (c.nsfw) parts.push('<span class="badge nsfw">18+</span>');
  if (c.fork) parts.push(`<span class="badge fork">${esc(zh.ucard.forked_badge)}</span>`);
  if (c.deleted_at) parts.push(`<span class="badge deleted">${esc(zh.deleted_by_user)}</span>`);
  return parts.join('');
}

/* ---------- 会话目标：chub 角色 或 自建卡 ---------- */
/**
 * 从会话（或会话里的 character 对象）解析出聊天对象：
 * {userCardId, path, name, avatar, href(资料页), body(开新会话的请求体)}
 */
/** 是否文件会话：kind='file'，或带 file 信息（GET /api/chats/:id 的 file，列表项的 file / files / file_name） */
export function isFileChat(x) {
  if (!x) return false;
  const c = isObj(x.chat) ? x.chat : null;
  if (x.kind === 'file' || (c && c.kind === 'file')) return true;
  return isObj(x.file) || Array.isArray(x.files) || (typeof x.file_name === 'string' && x.file_name !== '');
}

/** 文件会话的文件列表 [{name, chars, ok, error}] */
export function fileChatFiles(x) {
  if (!x) return [];
  const f = isObj(x.file) ? x.file : (isObj(x.chat) && isObj(x.chat.file) ? x.chat.file : null);
  let files = f && (f.files ?? f.files_json);
  if (files == null) files = x.files ?? x.files_json;
  if (typeof files === 'string') { try { files = JSON.parse(files); } catch { files = null; } }
  return Array.isArray(files) ? files.filter((v) => v && typeof v === 'object') : [];
}

/** 文件会话显示名：首个文件名（多个时加「等 N 个文件」） */
export function fileChatName(x) {
  const files = fileChatFiles(x);
  const first = (files.find((f) => f.ok !== false) || files[0] || {}).name || (x && (x.file_name || x.first_file_name)) || (x && x.title) || '';
  const n = files.length || Number(x && x.file_count) || 0;
  return n > 1 ? `${first} ${zh.filechat.tag_more(n)}` : String(first || zh.filechat.list_badge);
}

export function chatTarget(chatOrChar) {
  const x = chatOrChar || {};
  const ch = isObj(x.character) ? x.character : x;
  // 文件会话（契约 §17）：没有角色卡，名字取首个文件名，不给详情链接、不能「开始新对话」
  if (isFileChat(x)) return { userCardId: null, path: '', name: fileChatName(x), avatar: '', href: '', body: null, file: true };
  const uc = isObj(x.user_card) ? x.user_card : null;
  const ucId = x.user_card_id ?? ch.user_card_id ?? (uc && uc.id) ?? null;
  // v0.9 F3：卡对当前用户已不可用（作者删卡 / 改私有 / 作者账号已删）——不给详情链接、不能开新会话
  if (truthy(ch.unavailable)) {
    return { userCardId: ucId, path: '', name: str(ch.name), avatar: '', href: '', body: null, unavailable: true };
  }
  if (ucId != null && ucId !== '') {
    return {
      userCardId: ucId, path: '',
      name: str(ch.name || (uc && uc.name)), avatar: cardAvatarUrl(ch) || (uc ? cardAvatarUrl(uc) : ''),
      href: cardHref(ucId), body: { user_card_id: ucId },
    };
  }
  const path = str(ch.path);
  return { userCardId: null, path, name: str(ch.name), avatar: str(ch.avatar), href: path ? '#/c/' + encodeHashPath(path) : '', body: path ? { path } : null };
}

/* ---------- 动作 ---------- */
/** 用自建卡开新会话并进入 */
export async function startCardChat(id, navigate) {
  const r = await post('/api/chats', { user_card_id: id });
  store.homeCache = null;
  navigate('#/chat/' + encodeURIComponent(r.chat.id));
}

/** 拷贝并二次创作：成功后直接进编辑器。btn 可选，用于显示进行中状态 */
export async function forkCard(src, navigate, btn) {
  const label = btn ? btn.querySelector('span:last-child') : null;
  const old = label ? label.textContent : '';
  if (btn) { btn.disabled = true; if (label) label.textContent = zh.ucard.forking; }
  try {
    const r = await post('/api/cards/fork', src);
    const c = (r && (r.card || r.item)) || r;
    if (!c || c.id == null) throw new ApiError(zh.server_error, 500);
    toast(zh.ucard.forked);
    navigate(editHref(c.id));
  } catch (e) {
    toastError(e);
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; if (label) label.textContent = old; }
  }
}

const safeName = (s) => (String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 60) || 'card');

/** 导出：fetch 成 blob 再下载（出错时能给中文提示） */
export async function exportCard(c, format) {
  try {
    const res = await fetch(`/api/cards/${encodeURIComponent(c.id)}/export?format=${format === 'png' ? 'png' : 'json'}`, { credentials: 'same-origin' });
    if (!res.ok) {
      let msg = '';
      try { const j = await res.json(); msg = j && j.error; } catch { /* */ }
      throw new ApiError(msg || (res.status >= 500 ? zh.server_error : zh.network_error), res.status);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName(c.name)}.${format === 'png' ? 'png' : 'json'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(zh.ucard.exported);
  } catch (e) {
    if (e instanceof ApiError) toastError(e); else toast(zh.network_error, 'error');
  }
}

/** 删除（软删，但界面统一提示永久删除）。返回是否已删除 */
export async function deleteCard(c) {
  if (!await confirmDialog(zh.delete_forever, { title: zh.ucard.delete_title(c.name), danger: true, ok: zh.delete })) return false;
  try {
    await del('/api/cards/' + encodeURIComponent(c.id));
    store.homeCache = null;
    toast(zh.deleted_done);
    return true;
  } catch (e) { toastError(e); return false; }
}

/** 选择文件并导入（Tavern V2 JSON 或带 chara 数据的 PNG），成功返回新卡 */
export function pickAndImport() {
  const C = zh.create;
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,.png,application/json,image/png';
    inp.style.display = 'none';
    document.body.appendChild(inp);
    let done = false;
    const finish = (v) => { if (done) return; done = true; inp.remove(); resolve(v); };
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      if (!f) { finish(null); return; }
      const name = f.name.toLowerCase();
      const isPng = f.type === 'image/png' || name.endsWith('.png');
      const isJson = f.type === 'application/json' || name.endsWith('.json');
      if (!isPng && !isJson) { toast(C.import_bad_type, 'error'); finish(null); return; }
      if (f.size > 10 * 1024 * 1024) { toast(C.import_too_big, 'error'); finish(null); return; }
      toast(C.importing);
      try {
        const r = await upload('/api/cards/import', f, isPng ? 'image/png' : 'application/json');
        const c = (r && (r.card || r.item)) || null;
        if (!c || c.id == null) throw new ApiError(zh.server_error, 500);
        toast(C.imported);
        finish(c);
      } catch (e) { toastError(e); finish(null); }
    });
    // 用户取消选择：focus 回到页面时收尾（部分浏览器没有 cancel 事件）
    inp.addEventListener('cancel', () => finish(null));
    inp.click();
  });
}

/** 上传头像（png/jpeg/webp，≤5MB）；返回服务端给的新卡或头像地址 */
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const AVATAR_MAX = 5 * 1024 * 1024;
export async function uploadAvatar(id, file) {
  const r = await upload('/api/cards/' + encodeURIComponent(id) + '/avatar', file, file.type);
  const c = r && (r.card || r.item);
  return { card: c || null, avatar: (c && cardAvatarUrl(c)) || (r && (r.avatar || r.avatar_url)) || '' };
}

/** 拉一张卡（详情 / 编辑器） */
export async function loadCard(id) {
  const r = await get('/api/cards/' + encodeURIComponent(id));
  return normCard((r && (r.card || r.item)) || r);
}
