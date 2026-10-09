// 每个账号的阅读偏好。预览只改 CSS，保存成功才更新账号；无浏览器副作用，便于行为测试。
import { zh } from '../i18n/zh.js';
export const READING_DEFAULTS = Object.freeze({
  font_scale: 1, font_size: 16, font_family: 'system', font_weight: 400, line_height: 1.6, letter_spacing: 0,
});
export const READING_FAMILIES = Object.freeze({
  system: 'var(--font)',
  sans: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Helvetica Neue", Arial, sans-serif',
  serif: '"Songti SC", "Noto Serif CJK SC", "Noto Serif SC", SimSun, Georgia, serif',
  mono: 'ui-monospace, "SFMono-Regular", "Noto Sans Mono CJK SC", Menlo, Consolas, monospace',
});
const numeric = (v, min, max, integer = false) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v));
const rules = {
  font_scale: (v) => numeric(v, .85, 1.3),
  font_size: (v) => numeric(v, 14, 28, true),
  font_family: (v) => typeof v === 'string' && Object.hasOwn(READING_FAMILIES, v),
  font_weight: (v) => [400, 500, 600].includes(v),
  line_height: (v) => numeric(v, 1.2, 2.4),
  letter_spacing: (v) => numeric(v, -.5, 2),
};
const errorsZh = zh.reading.errors;

export function normalizeReadingSettings(value) {
  const out = { ...READING_DEFAULTS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [k, valid] of Object.entries(rules)) if (valid(value[k])) out[k] = value[k];
  return out;
}

export function validateReadingSettings(value) {
  const errors = {};
  for (const [k, valid] of Object.entries(rules)) if (!valid(value?.[k])) errors[k] = errorsZh[k];
  return { errors, settings: Object.keys(errors).length ? null : normalizeReadingSettings(value) };
}

export function applyReadingSettings(value, root = globalThis.document?.documentElement) {
  const s = normalizeReadingSettings(value);
  if (!root?.style) return s;
  const values = {
    '--reading-scale': s.font_scale,
    '--reading-font-size': s.font_size === READING_DEFAULTS.font_size ? '' : `${s.font_size}px`,
    '--reading-font-family': READING_FAMILIES[s.font_family],
    '--reading-font-weight': s.font_weight,
    '--reading-line-height': s.line_height === READING_DEFAULTS.line_height ? '' : s.line_height,
    '--reading-letter-spacing': `${s.letter_spacing}px`,
  };
  for (const [k, v] of Object.entries(values)) root.style.setProperty(k, String(v));
  return s;
}

// 队列和预览按本次登录对象共享，跨页面也只有一个实际保存请求在执行。
// WeakMap 不跨账号保留字体；旧登录的请求也不能更新新登录对象。
const accounts = new WeakMap();
function accountState(owner) {
  if (!owner || typeof owner !== 'object') return null;
  if (!accounts.has(owner)) accounts.set(owner, {
    tail: null, saveVersion: 0, committedVersion: 0, previewVersion: 0, preview: null,
    readingListeners: new Set(), profileListeners: new Set(), profileQueue: { tail: null },
  });
  return accounts.get(owner);
}
function enqueueSave(account, action) {
  const request = account.tail ? account.tail.then(action) : new Promise((resolve) => resolve(action()));
  const settled = request.then(() => undefined, () => undefined);
  account.tail = settled;
  settled.then(() => { if (account.tail === settled) account.tail = null; });
  return request;
}

const profileKeys = ['display_name', 'persona_name', 'persona_desc'];
export function applyProfileUpdate(owner, currentUser, response, submitted) {
  if (!owner || currentUser !== owner) return false;
  // 资料请求不会修改阅读/语音等偏好；全量 user 可能是另一次保存之前的快照。
  for (const key of profileKeys) {
    if (!Object.hasOwn(submitted || {}, key)) continue;
    const source = response?.user && Object.hasOwn(response.user, key) ? response.user : submitted;
    if (source && Object.hasOwn(source, key)) owner[key] = source[key];
  }
  return true;
}

// 只记录真正编辑的字段。其他页面提交后，未编辑字段跟随已保存值；
// 编辑/排队中的字段继续保留，避免整份旧表单快照覆盖新提交。
function editableDraft(initial, onChange) {
  let baseline = { ...initial }, draft = { ...initial };
  const dirty = new Set();
  const versions = Object.fromEntries(Object.keys(initial).map((key) => [key, 0]));
  return {
    edit(patch) {
      for (const key of Object.keys(initial)) if (Object.hasOwn(patch, key)) {
        versions[key]++;
        draft[key] = patch[key];
        if (draft[key] === baseline[key]) dirty.delete(key); else dirty.add(key);
      }
    },
    sync(saved, submitted, submittedVersions) {
      const fields = [];
      for (const key of Object.keys(initial)) {
        if ((submitted && Object.hasOwn(submitted, key) && draft[key] === submitted[key] && (!submittedVersions || versions[key] === submittedVersions[key])) || draft[key] === saved[key]) dirty.delete(key);
        if (!dirty.has(key)) { draft[key] = saved[key]; fields.push(key); }
      }
      baseline = { ...saved };
      onChange?.({ ...draft }, { fields });
    },
    value: () => ({ ...draft }),
    versions: () => ({ ...versions }),
    changes: () => Object.fromEntries([...dirty].map((key) => [key, draft[key]])),
  };
}

export function createProfileSession({ getUser, persist, onDraftChange }) {
  const owner = getUser(), account = accountState(owner), token = {};
  const current = () => owner != null && getUser() === owner;
  let disposed = false, busy = false;
  const initial = Object.fromEntries(profileKeys.map((key) => [key, owner?.[key] || '']));
  const state = editableDraft(initial, (draft, detail) => { if (!disposed && current()) onDraftChange?.(draft, detail); });
  const sync = (saved, source, submitted, versions) => { if (current()) state.sync(saved, source === token ? submitted : undefined, source === token ? versions : undefined); };
  account?.profileListeners.add(sync);
  return {
    edit(patch) { if (!disposed && current()) state.edit(patch); },
    draft: state.value,
    async save() {
      if (busy || disposed || !current()) return null;
      const body = state.changes();
      const versions = state.versions();
      if (!Object.keys(body).length) return state.value();
      busy = true;
      try {
        const response = await enqueueSave(account.profileQueue, () => current() ? persist(body) : null);
        if (!current()) return null;
        if (!applyProfileUpdate(owner, getUser(), response, body)) return null;
        const saved = Object.fromEntries(profileKeys.map((key) => [key, owner[key] || '']));
        if (disposed) state.sync(saved, body, versions);
        for (const listener of account.profileListeners) listener(saved, token, body, versions);
        return saved;
      } finally { busy = false; }
    },
    dispose() { disposed = true; account?.profileListeners.delete(sync); },
  };
}

export function clearReadingAccount(state, root) {
  state.me = null;
  state.homeCache = null;
  applyReadingSettings(null, root);
}

export function createReadingSession({ getUser, persist, apply = applyReadingSettings, onDraftChange }) {
  const owner = getUser();
  const account = accountState(owner);
  const token = {};
  let disposed = false, busy = false;
  // 同一账号也可能退出后重新登录：除 id 外还要确认仍是原来的登录状态对象。
  const current = () => owner != null && getUser() === owner;
  const state = editableDraft(normalizeReadingSettings(owner?.reading_settings), (draft, detail) => {
    if (account?.preview?.token === token) account.preview.settings = draft;
    if (!disposed && current()) onDraftChange?.(draft, detail);
  });
  const sync = (saved, source, submitted, versions) => { if (current()) state.sync(saved, source === token ? submitted : undefined, source === token ? versions : undefined); };
  account?.readingListeners.add(sync);
  const restore = () => {
    const user = getUser();
    apply(normalizeReadingSettings(accountState(user)?.preview?.settings || user?.reading_settings));
  };
  function clearPreview(version) {
    if (account?.preview?.token === token && (version === undefined || account.preview.version === version)) account.preview = null;
  }
  function preview(patch) {
    if (disposed || !current()) return { errors: {} };
    const result = validateReadingSettings({ ...state.value(), ...patch });
    if (result.settings) {
      state.edit(patch);
      const draft = state.value();
      account.preview = { token, version: ++account.previewVersion, settings: draft };
      apply(draft);
    }
    return result;
  }
  async function save(value) {
    if (busy || disposed || !current()) return null;
    const result = value === null ? { settings: { ...READING_DEFAULTS }, errors: {} } : validateReadingSettings({ ...state.value(), ...value });
    if (!result.settings) throw new Error(Object.values(result.errors)[0]);
    if (value && typeof value === 'object') state.edit(value);
    // 恢复默认确认的是提交前的草稿；不能让旧预览在下一次单项保存时复活。
    const snapshot = value === null ? state.value() : state.changes();
    const versions = state.versions();
    if (value !== null && !Object.keys(snapshot).length) return normalizeReadingSettings(owner.reading_settings);
    const saveVersion = ++account.saveVersion;
    const previewVersion = account.preview?.token === token ? account.preview.version : null;
    busy = true;
    try {
      const response = await enqueueSave(account, () => current() ? persist({ reading_settings: value === null ? null : snapshot }) : null);
      if (!current()) return null;
      if (!response?.user || !Object.hasOwn(response.user, 'reading_settings')) throw new Error(zh.reading.save_unconfirmed);
      const saved = normalizeReadingSettings(response.user.reading_settings);
      if (saveVersion <= account.committedVersion) return null;
      account.committedVersion = saveVersion;
      owner.reading_settings = saved; // 只更新最新完成的保存；较新的失败会恢复这个确实已保存的值。
      clearPreview(previewVersion);
      if (disposed) state.sync(saved, snapshot, versions);
      for (const listener of account.readingListeners) listener(saved, token, snapshot, versions);
      restore(); // 较新页面正在预览时保留它；没有预览时，离页完成的保存仍生效。
      return saved;
    } catch (e) {
      if (current()) { clearPreview(previewVersion); restore(); }
      throw e;
    } finally { busy = false; }
  }
  return { preview, save, draft: state.value, dispose() { disposed = true; account?.readingListeners.delete(sync); clearPreview(); restore(); } };
}
