import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { registerHooks } from 'node:module';

async function api() {
  const m = await import('../public/js/reading.js').catch(() => null);
  assert.ok(m, '字体与阅读状态模块尚未实现');
  return m;
}

const defaults = { font_scale: 1, font_size: 16, font_family: 'system', font_weight: 400, line_height: 1.6, letter_spacing: 0 };
const root = () => ({ style: { values: new Map(), setProperty(k, v) { this.values.set(k, v); } } });

test('阅读设置：旧账号缺省值保持默认；损坏配置不能写进CSS', async () => {
  const { normalizeReadingSettings, applyReadingSettings } = await api();
  assert.deepEqual(normalizeReadingSettings(), defaults);
  assert.deepEqual(normalizeReadingSettings({ font_size: Infinity, font_family: 'url(secret)', line_height: 9 }), defaults);
  assert.deepEqual(normalizeReadingSettings({ font_family: ['serif'] }), defaults, '字体白名单不接受数组伪装成字符串');
  const el = root();
  applyReadingSettings({ font_size: 24, font_scale: 1.2, font_family: 'serif', font_weight: 600, line_height: 2, letter_spacing: 1 }, el);
  assert.equal(el.style.values.get('--reading-font-size'), '24px');
  assert.equal(el.style.values.get('--reading-scale'), '1.2');
  assert.equal(el.style.values.get('--reading-line-height'), '2');
  assert.equal(el.style.values.get('--reading-letter-spacing'), '1px');
  assert.match(el.style.values.get('--reading-font-family'), /serif/);
  applyReadingSettings(null, el);
  assert.equal(el.style.values.get('--reading-font-size'), '', '默认时保留各区域原字号');
  assert.equal(el.style.values.get('--reading-line-height'), '', '默认时保留各区域原行距');
  assert.equal(el.style.values.get('--reading-scale'), '1');
});

test('阅读设置：合法边界可预览，非法字号/行距/字重给出对应字段错误', async () => {
  const { validateReadingSettings } = await api();
  assert.deepEqual(validateReadingSettings({ ...defaults, font_scale: .85, font_size: 28, line_height: 2.4, letter_spacing: -.5 }).errors, {});
  const invalid = validateReadingSettings({ ...defaults, font_size: 15.5, line_height: 2.41, font_weight: 700, font_family: 'bad', font_scale: NaN });
  for (const k of ['font_size', 'line_height', 'font_weight', 'font_family', 'font_scale']) assert.ok(invalid.errors[k], `${k} 有错误反馈`);
});

test('阅读设置：即时预览不污染账号，取消/离页恢复已保存值', async () => {
  const { createReadingSession } = await api();
  const user = { id: 1, reading_settings: { ...defaults, font_size: 18 } };
  const shown = [];
  const s = createReadingSession({ getUser: () => user, apply: (v) => shown.push(v), persist: async () => assert.fail('预览不保存') });
  s.preview({ font_size: 24 });
  assert.equal(shown.at(-1).font_size, 24);
  assert.equal(user.reading_settings.font_size, 18);
  s.dispose();
  assert.equal(shown.at(-1).font_size, 18);
});

test('阅读设置：保存成功才更新账户，恢复默认发送null并持久化', async () => {
  const { createReadingSession } = await api();
  const user = { id: 1, reading_settings: { ...defaults } };
  const bodies = [];
  const s = createReadingSession({ getUser: () => user, apply() {}, persist: async (body) => {
    bodies.push(body);
    return { user: { id: 1, reading_settings: body.reading_settings === null ? defaults : { ...user.reading_settings, ...body.reading_settings } } };
  } });
  s.preview({ font_size: 22, font_family: 'mono' });
  await s.save();
  assert.equal(user.reading_settings.font_size, 22);
  assert.equal(bodies[0].reading_settings.font_family, 'mono');
  await s.save(null);
  assert.deepEqual(bodies[1], { reading_settings: null });
  assert.deepEqual(user.reading_settings, defaults);
});

test('阅读设置：保存失败恢复已保存样式，不把未保存值混进账号', async () => {
  const { createReadingSession } = await api();
  const user = { id: 1, reading_settings: { ...defaults } };
  const shown = [];
  const s = createReadingSession({ getUser: () => user, apply: (v) => shown.push(v), persist: async () => { throw new Error('网络未连接'); } });
  s.preview({ font_size: 26 });
  await assert.rejects(s.save(), /网络未连接/);
  assert.equal(user.reading_settings.font_size, 16);
  assert.equal(shown.at(-1).font_size, 16);
  assert.equal(s.draft().font_size, 26, '失败后保留编辑值以便重试');
});

test('阅读设置：切换账号/退出后，旧请求不得覆盖新账号或旧字体', async () => {
  const { createReadingSession } = await api();
  let user = { id: 1, reading_settings: { ...defaults, font_size: 20 } };
  const previous = user;
  const shown = [];
  let resolve;
  const s = createReadingSession({ getUser: () => user, apply: (v) => shown.push(v), persist: () => new Promise((r) => { resolve = r; }) });
  s.preview({ font_size: 28 });
  const saving = s.save();
  user = { id: 2, reading_settings: { ...defaults, font_size: 14 } };
  s.dispose();
  resolve({ user: { id: 1, reading_settings: { ...defaults, font_size: 28 } } });
  await saving;
  assert.equal(user.reading_settings.font_size, 14);
  assert.equal(previous.reading_settings.font_size, 20);
  assert.equal(shown.at(-1).font_size, 14);
  user = null;
  s.dispose();
  assert.equal(shown.at(-1).font_size, 16);
});

test('阅读设置：保存中防重复提交，离页后同一账号的保存结果仍生效', async () => {
  const { createReadingSession } = await api();
  const user = { id: 1, reading_settings: { ...defaults } };
  let count = 0, resolve;
  const shown = [];
  const s = createReadingSession({ getUser: () => user, apply: (v) => shown.push(v), persist: () => { count++; return new Promise((r) => { resolve = r; }); } });
  s.preview({ font_size: 21 });
  const first = s.save();
  await s.save();
  assert.equal(count, 1);
  s.dispose();
  resolve({ user: { id: 1, reading_settings: { ...defaults, font_size: 21 } } });
  await first;
  assert.equal(user.reading_settings.font_size, 21);
  assert.equal(shown.at(-1).font_size, 21);
});

test('跨页面保存：后一次28先返回，旧页面20后返回不能倒回账户与CSS', async () => {
  const { createReadingSession } = await api();
  const user = { id: 1, reading_settings: { ...defaults } };
  const shown = [];
  let resolveOld, resolveNew;
  const oldResponse = new Promise((r) => { resolveOld = r; });
  const newResponse = new Promise((r) => { resolveNew = r; });
  const options = { getUser: () => user, apply: (v) => shown.push(v), persist: (body) => body.reading_settings.font_size === 20 ? oldResponse : newResponse };
  const first = createReadingSession(options);
  first.preview({ font_size: 20 });
  const oldSave = first.save();
  first.dispose();
  const second = createReadingSession(options);
  second.preview({ font_size: 28 });
  const newSave = second.save();
  resolveNew({ user: { id: 1, reading_settings: { ...defaults, font_size: 28 } } });
  resolveOld({ user: { id: 1, reading_settings: { ...defaults, font_size: 20 } } });
  await Promise.all([newSave, oldSave]);
  assert.equal(user.reading_settings.font_size, 28, '旧响应不能覆盖较新的保存');
  assert.equal(shown.at(-1).font_size, 28, 'CSS与最新保存保持一致');
  second.dispose();
  assert.equal(shown.at(-1).font_size, 28);
});

test('跨页面预览：旧保存成功仍入账户，但不能打断新页面尚未保存的28预览', async () => {
  const { createReadingSession } = await api();
  const user = { id: 1, reading_settings: { ...defaults } };
  const shown = [];
  let resolve;
  const options = { getUser: () => user, apply: (v) => shown.push(v), persist: () => new Promise((r) => { resolve = r; }) };
  const first = createReadingSession(options);
  first.preview({ font_size: 20 });
  const oldSave = first.save();
  first.dispose();
  const second = createReadingSession(options);
  second.preview({ font_size: 28 });
  resolve({ user: { id: 1, reading_settings: { ...defaults, font_size: 20 } } });
  await oldSave;
  assert.equal(user.reading_settings.font_size, 20, '离页后的有效保存仍生效');
  assert.equal(shown.at(-1).font_size, 28, '新页面的临时预览继续显示');
  assert.equal(second.draft().font_size, 28);
  second.dispose();
  assert.equal(shown.at(-1).font_size, 20, '结束新预览后使用最新已保存值');
});

test('跨页面失败：旧请求失败或旧页面再次清理，不得覆盖新页面预览', async () => {
  const { createReadingSession } = await api();
  const user = { id: 1, reading_settings: { ...defaults } };
  const shown = [];
  let reject;
  const options = { getUser: () => user, apply: (v) => shown.push(v), persist: () => new Promise((_r, no) => { reject = no; }) };
  const first = createReadingSession(options);
  first.preview({ font_size: 20 });
  const oldSave = first.save();
  first.dispose();
  const second = createReadingSession(options);
  second.preview({ font_size: 28 });
  reject(new Error('网络未连接'));
  await assert.rejects(oldSave, /网络未连接/);
  assert.equal(shown.at(-1).font_size, 28);
  first.dispose();
  assert.equal(shown.at(-1).font_size, 28, '旧清理不能取消其他页面的预览');
  assert.equal(user.reading_settings.font_size, 16);
  second.dispose();
});

test('资料保存的旧响应只更新此次资料字段，不能覆盖刚保存的字体或其他偏好', async () => {
  const { applyProfileUpdate } = await api();
  assert.equal(typeof applyProfileUpdate, 'function', '资料响应需要账户与字段隔离');
  const user = { id: 1, display_name: '旧名字', reading_settings: { ...defaults, font_size: 28 }, voice_auto_send: true };
  const stale = { user: { id: 1, display_name: '新名字', persona_name: '我', persona_desc: '新描述', reading_settings: { ...defaults, font_size: 20 }, voice_auto_send: false } };
  assert.equal(applyProfileUpdate(user, user, stale, { display_name: '新名字', persona_desc: '新描述' }, true), true);
  assert.equal(user.display_name, '新名字');
  assert.equal(user.persona_desc, '新描述');
  assert.equal(user.reading_settings.font_size, 28);
  assert.equal(user.voice_auto_send, true);
});

test('资料保存离页后同账号仍提交缓存，切换账户后旧响应不能污染账户', async () => {
  const { applyProfileUpdate } = await api();
  assert.equal(typeof applyProfileUpdate, 'function');
  const old = { id: 1, display_name: '甲' };
  const current = { id: 2, display_name: '乙', reading_settings: { ...defaults } };
  const response = { user: { display_name: '迟到的名字' } };
  assert.equal(applyProfileUpdate(old, current, response, { display_name: '迟到的名字' }, true), false);
  assert.equal(applyProfileUpdate(old, old, response, { display_name: '迟到的名字' }, false), true);
  assert.equal(old.display_name, '迟到的名字');
  assert.equal(current.display_name, '乙');
});

test('资料响应只合并本次实际提交字段，旧的全量display_name不能覆盖新名字', async () => {
  const { applyProfileUpdate } = await api();
  const user = { display_name: '新名字', persona_name: '旧人设' };
  applyProfileUpdate(user, user, { user: { display_name: '旧名字', persona_name: '新人设' } }, { persona_name: '新人设' });
  assert.equal(user.display_name, '新名字');
  assert.equal(user.persona_name, '新人设');
});

test('资料跨页面保存串行，第二页仅改人设不能把未编辑名字写回', async () => {
  const { createProfileSession } = await api();
  assert.equal(typeof createProfileSession, 'function');
  const user = { id: 1, display_name: '甲', persona_name: '', persona_desc: '' };
  let stored = { ...user }, release;
  const calls = [];
  const options = { getUser: () => user, persist: (body) => {
    calls.push(body);
    const finish = () => { stored = { ...stored, ...body }; return { user: { ...stored } }; };
    return calls.length === 1 ? new Promise((resolve) => { release = () => resolve(finish()); }) : Promise.resolve(finish());
  } };
  const first = createProfileSession(options);
  first.edit({ display_name: '乙' });
  const oldSave = first.save();
  first.dispose();
  const second = createProfileSession(options);
  second.edit({ persona_name: '新我' });
  const newSave = second.save();
  assert.deepEqual(calls, [{ display_name: '乙' }]);
  release();
  await Promise.all([oldSave, newSave]);
  assert.deepEqual(calls, [{ display_name: '乙' }, { persona_name: '新我' }]);
  assert.equal(user.display_name, '乙');
  assert.equal(second.draft().display_name, '乙');
  assert.equal(stored.display_name, '乙');
  assert.equal(stored.persona_name, '新我');
  second.dispose();
});

test('资料跨页面同时修改名字时按实际请求次序保存，刷新后也是最新名字', async () => {
  const { createProfileSession } = await api();
  const user = { display_name: '甲', persona_name: '', persona_desc: '' };
  let stored = { ...user }, release;
  const calls = [];
  const options = { getUser: () => user, persist: (body) => {
    calls.push(body);
    const finish = () => { stored = { ...stored, ...body }; return { user: { ...stored } }; };
    return calls.length === 1 ? new Promise((resolve) => { release = () => resolve(finish()); }) : Promise.resolve(finish());
  } };
  const first = createProfileSession(options);
  first.edit({ display_name: '乙' });
  const oldSave = first.save();
  first.dispose();
  const second = createProfileSession(options);
  second.edit({ display_name: '丙' });
  const newSave = second.save();
  assert.deepEqual(calls, [{ display_name: '乙' }]);
  release();
  await Promise.all([oldSave, newSave]);
  assert.deepEqual(calls, [{ display_name: '乙' }, { display_name: '丙' }]);
  assert.equal(user.display_name, '丙');
  assert.equal(stored.display_name, '丙');
  const reopened = createProfileSession({ ...options, getUser: () => ({ ...stored }) });
  assert.equal(reopened.draft().display_name, '丙');
  reopened.dispose(); second.dispose();
});

test('资料账号切换会阻止队列中的旧请求发送，并忽略正在返回的旧账号资料', async () => {
  const { createProfileSession } = await api();
  const oldUser = { id: 1, display_name: '甲', persona_name: '', persona_desc: '' };
  let user = oldUser, release;
  const calls = [];
  const options = { getUser: () => user, persist: (body) => { calls.push(body); return new Promise((resolve) => { release = resolve; }); } };
  const first = createProfileSession(options);
  first.edit({ display_name: '乙' });
  const oldSave = first.save(); first.dispose();
  const second = createProfileSession(options);
  second.edit({ persona_name: '旧账号人设' });
  const queued = second.save();
  user = { id: 2, display_name: '新账号' };
  second.dispose();
  release({ user: { ...oldUser, display_name: '乙' } });
  assert.deepEqual(await Promise.all([oldSave, queued]), [null, null]);
  assert.deepEqual(calls, [{ display_name: '乙' }]);
  assert.equal(user.display_name, '新账号');
  assert.equal(oldUser.display_name, '甲');
});

test('阅读旧保存提交同步新页草稿，保留新页已编辑家族且只发送实际编辑参数', async () => {
  const { createReadingSession } = await api();
  const user = { reading_settings: { ...defaults } };
  let stored = { ...defaults }, release;
  const calls = [], changed = [];
  const options = { getUser: () => user, apply() {}, persist: (body) => {
    calls.push(body);
    const finish = () => { stored = { ...stored, ...body.reading_settings }; return { user: { reading_settings: { ...stored } } }; };
    return calls.length === 1 ? new Promise((resolve) => { release = () => resolve(finish()); }) : Promise.resolve(finish());
  } };
  const first = createReadingSession(options);
  first.preview({ font_size: 20 });
  const oldSave = first.save();
  first.dispose();
  const second = createReadingSession({ ...options, onDraftChange: (draft) => changed.push(draft) });
  second.preview({ font_family: 'serif' });
  const newSave = second.save();
  assert.deepEqual(calls, [{ reading_settings: { font_size: 20 } }]);
  release();
  await Promise.all([oldSave, newSave]);
  assert.deepEqual(calls[1], { reading_settings: { font_family: 'serif' } });
  assert.equal(second.draft().font_size, 20);
  assert.equal(second.draft().font_family, 'serif');
  assert.ok(changed.some((draft) => draft.font_size === 20 && draft.font_family === 'serif'));
  assert.equal(stored.font_size, 20);
  second.dispose();
});

test('阅读队列中新页家族保存失败时，恢复旧页面刚保存20，保留合并后的重试草稿', async () => {
  const { createReadingSession } = await api();
  const user = { reading_settings: { ...defaults } };
  let release;
  const calls = [], shown = [];
  const options = { getUser: () => user, apply: (value) => shown.push(value), persist: (body) => {
    calls.push(body);
    return calls.length === 1 ? new Promise((resolve) => { release = () => resolve({ user: { reading_settings: { ...defaults, font_size: 20 } } }); }) : Promise.reject(new Error('网络未连接'));
  } };
  const first = createReadingSession(options);
  first.preview({ font_size: 20 });
  const oldSave = first.save(); first.dispose();
  const second = createReadingSession(options);
  second.preview({ font_family: 'serif' });
  const newSave = second.save();
  const failure = assert.rejects(newSave, /网络未连接/);
  release();
  await Promise.all([oldSave, failure]);
  assert.deepEqual(calls[1], { reading_settings: { font_family: 'serif' } });
  assert.equal(user.reading_settings.font_size, 20);
  assert.equal(user.reading_settings.font_family, 'system');
  assert.equal(shown.at(-1).font_size, 20);
  assert.equal(shown.at(-1).font_family, 'system');
  assert.equal(second.draft().font_size, 20);
  assert.equal(second.draft().font_family, 'serif');
  second.dispose();
});

test('阅读跨页面排队恢复默认仍发送null，并同步所有未编辑控件的默认草稿', async () => {
  const { createReadingSession } = await api();
  const user = { reading_settings: { ...defaults } };
  let release, stored = { ...defaults };
  const calls = [];
  const options = { getUser: () => user, apply() {}, persist: (body) => {
    calls.push(body);
    const finish = () => { stored = body.reading_settings === null ? { ...defaults } : { ...stored, ...body.reading_settings }; return { user: { reading_settings: { ...stored } } }; };
    return calls.length === 1 ? new Promise((resolve) => { release = () => resolve(finish()); }) : Promise.resolve(finish());
  } };
  const first = createReadingSession(options);
  first.preview({ font_size: 20 });
  const oldSave = first.save(); first.dispose();
  const second = createReadingSession(options);
  const reset = second.save(null);
  release();
  await Promise.all([oldSave, reset]);
  assert.deepEqual(calls, [{ reading_settings: { font_size: 20 } }, { reading_settings: null }]);
  assert.deepEqual(stored, defaults);
  assert.deepEqual(user.reading_settings, defaults);
  assert.deepEqual(second.draft(), defaults);
  second.dispose();
});

test('未保存预览恢复默认后，只改字体不能带回旧字号', async () => {
  const { createReadingSession } = await api();
  const user = { reading_settings: { ...defaults } }, calls = [];
  const s = createReadingSession({ getUser: () => user, apply() {}, persist: async (body) => {
    calls.push(body);
    return { user: { reading_settings: body.reading_settings === null ? { ...defaults } : { ...user.reading_settings, ...body.reading_settings } } };
  } });
  s.preview({ font_size: 28, font_family: 'mono' });
  await s.save(null);
  assert.deepEqual(s.draft(), defaults, '恢复默认也确认并清除本页旧草稿');
  s.preview({ font_family: 'serif' });
  await s.save();
  assert.deepEqual(calls, [{ reading_settings: null }, { reading_settings: { font_family: 'serif' } }]);
  assert.equal(user.reading_settings.font_size, 16);
  s.dispose();
});

test('恢复默认等待期间重新选择原预览值，保留较新编辑而不清掉其dirty', async () => {
  const { createReadingSession } = await api();
  const user = { reading_settings: { ...defaults } }, calls = [];
  let release;
  const s = createReadingSession({ getUser: () => user, apply() {}, persist: (body) => {
    calls.push(body);
    return body.reading_settings === null ? new Promise((resolve) => { release = () => resolve({ user: { reading_settings: { ...defaults } } }); }) : Promise.resolve({ user: { reading_settings: { ...user.reading_settings, ...body.reading_settings } } });
  } });
  s.preview({ font_size: 28, font_family: 'mono' });
  const reset = s.save(null);
  s.preview({ font_size: 28 });
  release(); await reset;
  assert.equal(s.draft().font_size, 28, '提交后重新选择的字号意图保留');
  assert.equal(s.draft().font_family, 'system', '没有重新编辑的旧字体清除');
  await s.save();
  assert.deepEqual(calls[1], { reading_settings: { font_size: 28 } });
  s.dispose();
});

let uiModules;
async function readingUi() {
  if (!uiModules) uiModules = (async () => {
    const hook = registerHooks({ resolve(specifier, context, next) {
      return next(specifier.startsWith('/js/') || specifier.startsWith('/i18n/') ? new URL(`../public${specifier}`, import.meta.url).href : specifier, context);
    } });
    try { return { ...(await import('../public/js/reading-ui.js')), ...(await import('../public/js/store.js')) }; }
    finally { hook.deregister(); }
  })();
  return uiModules;
}
class Control {
  #value = '';
  attrs = new Map();
  get value() { return this.#value; }
  set value(v) { this.#value = String(v); }
  setAttribute(k, v) { this.attrs.set(k, v); }
  removeAttribute(k) { this.attrs.delete(k); }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  focus() {}
}
function readingForm() {
  const form = new EventTarget(), nodes = new Map();
  const inputs = new Map(Object.keys(defaults).map((key) => { const control = new Control(); control.name = key; return [key, control]; }));
  for (const selector of ['[data-reading-error]', '[data-reading-status]', '[type="submit"]', '[data-reading-reset]', 'fieldset', '[data-output="font_size"]', '[data-output="font_scale"]', ...Object.keys(defaults).map((k) => `#rd-${k}-err`)]) nodes.set(selector, new Control());
  form.elements = { namedItem: (key) => inputs.get(key) };
  form.querySelector = (selector) => nodes.get(selector);
  form.setAttribute = () => {};
  form.isConnected = true;
  const fire = (type, target) => { const event = new Event(type, { cancelable: true }); if (target) Object.defineProperty(event, 'target', { value: target }); form.dispatchEvent(event); };
  return { form, input: (key) => inputs.get(key), change(key, value) { inputs.get(key).value = value; fire('input', inputs.get(key)); }, submit() { fire('submit'); } };
}
const settleUi = () => new Promise((resolve) => setImmediate(resolve));

test('阅读真实表单：未保存大字号恢复默认后，只改家族仅发送家族', async (t) => {
  const { mountReadingSettings, store } = await readingUi();
  const oldMe = store.me, oldFetch = globalThis.fetch, oldDocument = globalThis.document;
  t.after(() => { store.me = oldMe; globalThis.fetch = oldFetch; globalThis.document = oldDocument; });
  globalThis.document = { documentElement: root() };
  const user = store.me = { id: 1, reading_settings: { ...defaults } }, calls = [];
  globalThis.fetch = async (pathname, init) => {
    assert.equal(pathname, '/api/me');
    const body = JSON.parse(init.body); calls.push(body);
    return new Response(JSON.stringify({ user: { reading_settings: body.reading_settings === null ? { ...defaults } : { ...user.reading_settings, ...body.reading_settings } } }), { headers: { 'content-type': 'application/json' } });
  };
  const page = readingForm(); let cleanup;
  mountReadingSettings(page.form, { isActive: () => true, onCleanup: (fn) => { cleanup = fn; } });
  t.after(() => cleanup?.());
  page.change('font_size',28); page.change('font_family','mono');
  page.form.querySelector('[data-reading-reset]').onclick();
  await settleUi();
  assert.equal(page.input('font_size').value, '16');
  page.change('font_family','serif'); page.submit(); await settleUi();
  assert.deepEqual(calls, [{ reading_settings: null }, { reading_settings: { font_family: 'serif' } }]);
  assert.equal(user.reading_settings.font_size, 16);
});

for (const timing of ['提交后编辑', '提交前预览', '提交前排队']) test(`阅读真实表单：旧保存20${timing}家族不把未编辑字号写回16`, async (t) => {
  const { createReadingSession } = await api();
  const { mountReadingSettings, store } = await readingUi();
  const oldMe = store.me, oldFetch = globalThis.fetch, oldDocument = globalThis.document;
  t.after(() => { store.me = oldMe; globalThis.fetch = oldFetch; globalThis.document = oldDocument; });
  globalThis.document = { documentElement: root() };
  const user = store.me = { id: 1, reading_settings: { ...defaults } };
  let stored = { ...defaults }, release, cleanup;
  const calls = [];
  globalThis.fetch = async (path, init) => {
    assert.equal(path, '/api/me');
    const body = JSON.parse(init.body);
    calls.push(body);
    stored = body.reading_settings === null ? { ...defaults } : { ...stored, ...body.reading_settings };
    return new Response(JSON.stringify({ user: { id: 1, reading_settings: { ...stored } } }), { headers: { 'content-type': 'application/json' } });
  };
  const first = createReadingSession({ getUser: () => store.me, persist: (body) => new Promise((resolve) => { release = () => { stored = { ...stored, ...body.reading_settings }; resolve({ user: { id: 1, reading_settings: { ...stored } } }); }; }) });
  first.preview({ font_size: 20 });
  const oldSave = first.save();
  first.dispose();
  const page = readingForm();
  mountReadingSettings(page.form, { isActive: () => true, onCleanup: (fn) => { cleanup = fn; } });
  t.after(() => cleanup?.());
  assert.equal(page.input('font_size').value, '16');
  if (timing !== '提交后编辑') page.change('font_family', 'serif');
  if (timing === '提交前排队') { page.submit(); assert.deepEqual(calls, [], '等待旧请求写入后才发送新请求'); }
  release();
  await oldSave;
  assert.equal(page.input('font_size').value, '20', '新页未编辑的DOM控件跟随旧保存成功值');
  if (timing === '提交后编辑') page.change('font_family', 'serif');
  assert.equal(page.input('font_family').value, 'serif', '新页已经编辑的控件不被旧提交覆盖');
  if (timing !== '提交前排队') page.submit();
  await settleUi();
  assert.deepEqual(calls, [{ reading_settings: { font_family: 'serif' } }], '只提交用户实际修改的参数');
  assert.equal(stored.font_size, 20);
  assert.equal(user.reading_settings.font_size, 20);
  assert.equal(user.reading_settings.font_family, 'serif');
});

test('退出后直接渲染注册页也立即清除账号及字体，不依赖路由重建', async () => {
  const { clearReadingAccount, applyReadingSettings } = await api();
  assert.equal(typeof clearReadingAccount, 'function', '直接渲染注册页的退出需要立即清理');
  const el = root();
  const state = { me: { id: 1, reading_settings: { ...defaults, font_size: 28, font_scale: 1.3 } }, homeCache: { old: true } };
  applyReadingSettings(state.me.reading_settings, el);
  clearReadingAccount(state, el);
  assert.equal(state.me, null);
  assert.equal(state.homeCache, null);
  assert.equal(el.style.values.get('--reading-font-size'), '');
  assert.equal(el.style.values.get('--reading-scale'), '1');
});

test('跨页面实际保存串行：旧请求完成后才发送新请求，重新读取仍是最新28', async () => {
  const { createReadingSession } = await api();
  const user = { id: 1, reading_settings: { ...defaults } };
  let stored = { ...defaults }, completeOld;
  const calls = [];
  const options = { getUser: () => user, apply() {}, persist: (body) => {
    const value = { ...body.reading_settings };
    calls.push(value.font_size);
    if (value.font_size === 20) return new Promise((resolve) => { completeOld = () => {
      stored = { ...stored, ...value };
      resolve({ user: { id: 1, reading_settings: { ...stored } } });
    }; });
    stored = { ...stored, ...value };
    return Promise.resolve({ user: { id: 1, reading_settings: { ...stored } } });
  } };
  const first = createReadingSession(options);
  first.preview({ font_size: 20 });
  const oldSave = first.save();
  first.dispose();
  const second = createReadingSession(options);
  second.preview({ font_size: 28 });
  const newSave = second.save();
  assert.deepEqual(calls, [20], '第二页面必须等待第一请求写完再发送');
  completeOld();
  await Promise.all([oldSave, newSave]);
  assert.deepEqual(calls, [20, 28]);
  assert.equal(stored.font_size, 28, '再次读取持久化值为28');
  assert.equal(user.reading_settings.font_size, stored.font_size);
  second.dispose();
});

test('本地HTTP传输：跨页面PATCH串行，最后GET与重新进入的阅读设置一致', async (t) => {
  const { createReadingSession } = await api();
  let stored = { ...defaults }, releaseOld;
  const gate = new Promise((resolve) => { releaseOld = resolve; });
  const writes = [];
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'PATCH') {
        let raw = '';
        for await (const part of req) raw += part.toString();
        const settings = JSON.parse(raw).reading_settings;
        if (settings.font_size === 20) await gate;
        stored = settings === null ? { ...defaults } : { ...stored, ...settings };
        writes.push(stored.font_size);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ user: { id: 1, reading_settings: stored } }));
    } catch (e) { res.writeHead(500); res.end(e.message); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { releaseOld(); server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/me`;
  const user = { id: 1, reading_settings: { ...defaults } };
  const calls = [], shown = [];
  const options = { getUser: () => user, apply: (v) => shown.push(v), persist: async (body) => {
    calls.push(body.reading_settings.font_size);
    const response = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  } };
  const oldPage = createReadingSession(options);
  oldPage.preview({ font_size: 20 });
  const oldSave = oldPage.save();
  oldPage.dispose();
  const newPage = createReadingSession(options);
  newPage.preview({ font_size: 28 });
  const newSave = newPage.save();
  assert.deepEqual(calls, [20], '实际fetch尚未发送后一次PATCH');
  releaseOld();
  await Promise.all([oldSave, newSave]);
  assert.deepEqual(writes, [20, 28]);
  const refreshed = await (await fetch(url)).json();
  assert.equal(refreshed.user.reading_settings.font_size, 28);
  assert.equal(user.reading_settings.font_size, 28);
  newPage.dispose();
  const reopened = createReadingSession({ ...options, getUser: () => refreshed.user });
  assert.equal(reopened.draft().font_size, 28);
  assert.equal(shown.at(-1).font_size, 28);
  reopened.dispose();
});
