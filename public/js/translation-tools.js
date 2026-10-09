// 角色资料的手动翻译、历史版本与只读轮询。历史切换只选缓存，不生成译文。
import { zh } from '/i18n/zh.js';
import { get, post, encPath } from '/js/api.js';
import { loadTranslationModels, translationModelId } from '/js/translation-models.js';
import { esc, fmtDateTime } from '/js/util.js';
import { icon } from '/js/ui.js';
import { translateStatus } from '/js/charsheet.js';

const POLL_MS = 4000;
const SLOW_MS = 120000;
const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const numericId = (v) => /^\d+$/.test(String(v ?? '')) && Number(v) > 0 ? Number(v) : null;
const hasContract = (c) => Array.isArray(c?.translation_history) || 'default_translate_model_id' in (c || {});
const historyUsable = (item) => item?.current_source === true && ['ok', 'partial'].includes(item.status);
const sourceKey = (c) => c.translation_source_hash || JSON.stringify([c.name, c.tagline, c.tags, c.data, c.greeting]);
const snapshot = (c) => JSON.stringify([sourceKey(c), c.translate_status, c.translating, c.translated_at,
  c.selected_translation_id, c.selected_translation, c.translation_job, c.translation_history,
  c.name_zh, c.tagline_zh, c.tags_zh, c.data_zh, c.greeting_zh]);

/** 使用原生 select 保留键盘选择与移动端系统选择器；重绘只更新选项，不替换控件。 */
export function mountTranslationTools({ container, statusEl, character, path, source, ctx, onCharacter }) {
  const S = zh.sheet;
  const base = '/api/characters/' + encPath(path);
  const sourceQuery = '?source=' + encodeURIComponent(source);
  const controller = new AbortController();
  let ch = character || {}, disposed = false, mutationSeq = 0, modelSeq = 0;
  let models = [], modelsReady = false, modelsLoading = false, modelsError = '';
  let modelId = ch.selected_translation?.model_id ?? null;
  let actionBusy = '', localError = '', pollTimer = null, pollStart = 0, slow = false;
  let historyLoading = false, loadedMore = false, hasMore = false, nextBefore = null;
  const versions = new Map();
  const optionMarkup = new WeakMap();
  const active = () => !disposed && ctx.isActive();
  const jobPending = () => ch.translation_job?.status === 'pending' || translateStatus(ch) === 'pending';
  const selectedId = () => numericId(ch.selected_translation_id);
  const selectedItem = () => versions.get(selectedId()) || ch.selected_translation || null;

  container.innerHTML = `<div class="tr-tools-head"><h2 class="section-title">翻译与历史译文</h2></div>
    <div class="tr-fields">
      <div class="tr-field"><label for="tr-model">翻译 AI</label><select class="select" id="tr-model" data-tr-model aria-describedby="tr-model-hint"></select></div>
      <div class="tr-field"><label for="tr-history">显示的译文</label><select class="select" id="tr-history" data-tr-history aria-describedby="tr-history-hint"></select></div>
    </div>
    <p class="tr-hint" id="tr-model-hint" data-tr-model-hint role="status" aria-live="polite"></p>
    <p class="tr-hint" id="tr-history-hint">选择历史译文会立即切换，不重新调用 AI。</p>
    <div class="tr-actions">
      <button class="btn btn-secondary" type="button" data-tr-start>翻译</button>
      <button class="btn btn-secondary" type="button" data-tr-force>重新翻译</button>
      <button class="btn btn-secondary" type="button" data-tr-more hidden>继续加载历史译文</button>
      <button class="btn btn-secondary" type="button" data-tr-model-retry hidden>重新加载 AI</button>
    </div>
    <p class="tr-hint">翻译会优先复用所选 AI 的已有结果；重新翻译会生成新版本，已有译文会保留。</p>`;
  const modelEl = container.querySelector('[data-tr-model]');
  const historyEl = container.querySelector('[data-tr-history]');
  const modelHint = container.querySelector('[data-tr-model-hint]');
  const startEl = container.querySelector('[data-tr-start]');
  const forceEl = container.querySelector('[data-tr-force]');
  const moreEl = container.querySelector('[data-tr-more]');
  const modelRetryEl = container.querySelector('[data-tr-model-retry]');

  function ingest(next) {
    for (const item of [...(Array.isArray(next.translation_history) ? next.translation_history : []), next.selected_translation]) {
      if (item && numericId(item.id)) versions.set(Number(item.id), item);
    }
    if (!loadedMore) {
      hasMore = next.translation_history_has_more === true;
      nextBefore = numericId(next.translation_history_next_before_id);
    }
  }
  function options(el, html, value) {
    // 浏览器会把 disabled 等属性标准化，比较源字符串缓存以保留打开的原生选项。
    if (optionMarkup.get(el) !== html) { el.innerHTML = html; optionMarkup.set(el, html); }
    el.value = value == null ? '' : String(value);
  }
  function drawControls() {
    const defaultModel = models.find((m) => sameId(m.id, ch.default_translate_model_id));
    let modelHtml = `<option value="">${esc(defaultModel ? `系统默认（${defaultModel.name}）` : '系统默认翻译 AI')}</option>`;
    modelHtml += models.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}${m.transport === 'grok-cli' ? ' · 本机 CLI' : m.transport === 'api' ? ' · API' : ''}${m.provider ? ' · ' + esc(m.provider) : ''}</option>`).join('');
    const enabled = models.some((m) => sameId(m.id, modelId ?? ch.default_translate_model_id));
    if (modelId != null && !enabled) {
      const old = selectedItem() || [...versions.values()].find((v) => sameId(v.model_id, modelId));
      modelHtml += `<option value="${esc(modelId)}" disabled>${esc(old?.model_name || '原翻译 AI')}（历史可用，当前停用）</option>`;
    }
    options(modelEl, modelHtml, modelId);
    const list = [...versions.values()].sort((a, b) => Number(b.id) - Number(a.id));
    let historyHtml = '<option value="">跟随默认译文</option>';
    historyHtml += list.map((item) => {
      const state = item.current_source !== true ? ' · 原始内容已更新' : item.status === 'failed' ? ' · 翻译失败' : item.status === 'partial' ? ' · 部分译文' : '';
      const modelName = item.model_name || '旧版译文（AI 未记录）';
      const label = `${modelName} · v${item.version ?? item.id} · ${fmtDateTime(item.created_at)}${state}`;
      return `<option value="${esc(item.id)}"${historyUsable(item) ? '' : ' disabled'}>${esc(label)}</option>`;
    }).join('');
    if (selectedId() != null && !versions.has(selectedId())) {
      historyHtml += `<option value="${esc(selectedId())}">当前历史 #${esc(selectedId())}（继续加载查看）</option>`;
    }
    options(historyEl, historyHtml, selectedId());
    historyEl.disabled = actionBusy === 'select';
    modelEl.disabled = modelsLoading && !modelsReady;
    const busy = !!actionBusy || jobPending();
    startEl.disabled = forceEl.disabled = busy || !modelsReady || !enabled;
    container.setAttribute('aria-busy', String(!!actionBusy));
    startEl.textContent = actionBusy === 'translate' ? '正在翻译…' : '翻译';
    forceEl.textContent = actionBusy === 'force' ? '正在重新翻译…' : '重新翻译';
    moreEl.hidden = !hasMore;
    moreEl.disabled = historyLoading;
    moreEl.textContent = historyLoading ? '正在加载历史译文…' : '继续加载历史译文';
    modelRetryEl.hidden = !modelsError;
    modelRetryEl.disabled = modelsLoading;
    modelHint.textContent = modelsError || (modelsLoading ? '正在加载可选 AI…' : !models.length && modelsReady
      ? '暂未配置可用 AI，已有历史译文仍可选择。' : modelId != null && !enabled
        ? '当前历史译文仍可使用；请选择已启用的 AI 后再翻译。' : modelsReady && !enabled
          ? '系统默认翻译 AI 暂不可用，请选择已启用的 AI。' : actionBusy === 'select' ? '正在切换历史译文…' : '');
    modelHint.hidden = !modelHint.textContent;
  }
  function drawStatus() {
    const st = translateStatus(ch), job = ch.translation_job;
    let html = '', warn = false;
    if (localError || job?.status === 'failed') {
      const message = localError || job.error || '本次翻译失败，请稍后再试。';
      html = `${icon('alert')}<span>${esc(message)}${ch.data_zh ? ' · 已保留当前译文。' : ''}</span>`;
      warn = true;
    } else if (jobPending()) {
      const name = job?.model_name ? `（${job.model_name}）` : '';
      html = `<span class="spinner sm" aria-hidden="true"></span><span>${esc(slow
        ? '翻译仍在进行，已有译文可继续查看；会自动更新结果。' : `${S.translating}${name}`)}</span>`;
    } else if (st === 'failed' || st === 'partial') {
      html = `${icon('alert')}<span>${esc(st === 'failed' ? S.translate_failed : S.translate_partial)}</span>`;
      warn = true;
    } else if (!st && source === 'local') html = `<span>${esc(S.translate_on_request)}</span>`;
    // 兼容旧接口：保留原有状态条重试按钮及只含 source 的请求体。
    if (!hasContract(ch) && (st === 'failed' || st === 'partial' || (!st && source === 'local') || (st === 'pending' && slow))) {
      html += `<button class="btn btn-sm" type="button" data-tr-retry>${esc(!st ? S.translate_start : S.translate_retry)}</button>`;
    }
    statusEl.hidden = !html;
    statusEl.className = 'cs-status' + (warn ? ' warn' : '');
    if (statusEl.innerHTML !== html) statusEl.innerHTML = html;
    const retry = statusEl.querySelector('[data-tr-retry]');
    if (retry) retry.onclick = () => translate(false, true);
  }
  function redraw() { drawControls(); drawStatus(); }
  function receive(next, syncModel = false) {
    if (!active() || !next) return;
    const before = snapshot(ch);
    const previousSource = sourceKey(ch);
    ch = { ...ch, ...next };
    if (sourceKey(ch) !== previousSource) { versions.clear(); loadedMore = false; }
    ingest(ch);
    if (syncModel) modelId = ch.selected_translation?.model_id ?? selectedItem()?.model_id ?? null;
    redraw();
    if (snapshot(ch) !== before) onCharacter(ch);
  }
  async function loadEnabledModels(force = false) {
    if (modelsLoading || !active()) return;
    modelsLoading = true;
    modelsError = '';
    drawControls();
    try {
      const result = await loadTranslationModels(force);
      if (!active()) return;
      models = result.items;
      ch = { ...ch, default_translate_model_id: result.default_model_id };
      modelsReady = true;
    } catch (error) {
      if (active()) modelsError = error?.status ? error.message : zh.network_error;
    } finally {
      modelsLoading = false;
      if (active()) drawControls();
    }
  }
  async function translate(force, legacy = false) {
    if (!active() || actionBusy || jobPending()) return;
    if (!legacy && (force ? forceEl.disabled : startEl.disabled)) return;
    const seq = ++mutationSeq;
    actionBusy = force ? 'force' : 'translate';
    localError = '';
    clearTimeout(pollTimer);
    redraw();
    try {
      const body = legacy && !hasContract(ch) ? { source } : { source, model_id: translationModelId(modelId), force: force === true };
      const response = await post(base + '/translate' + sourceQuery, body, { signal: controller.signal });
      if (!active() || seq !== mutationSeq) return;
      slow = false;
      pollStart = 0;
      receive(response?.character || { translate_status: 'pending', translating: true });
    } catch (error) {
      if (active() && seq === mutationSeq && error?.name !== 'AbortError') localError = error?.status ? error.message : zh.network_error;
    } finally {
      if (active() && seq === mutationSeq) { actionBusy = ''; redraw(); schedulePoll(); }
    }
  }
  async function selectHistory() {
    if (!active() || actionBusy === 'select') return;
    const id = numericId(historyEl.value), item = versions.get(id);
    if (id != null && item && !historyUsable(item)) { drawControls(); return; }
    const seq = ++mutationSeq, pickedModelSeq = modelSeq;
    actionBusy = 'select';
    localError = '';
    clearTimeout(pollTimer);
    redraw();
    try {
      const response = await post(base + '/translations/select' + sourceQuery,
        { source, translation_id: id }, { signal: controller.signal });
      if (!active() || seq !== mutationSeq) return;
      receive(response?.character, modelSeq === pickedModelSeq);
    } catch (error) {
      if (active() && seq === mutationSeq && error?.name !== 'AbortError') localError = error?.status ? error.message : zh.network_error;
    } finally {
      if (active() && seq === mutationSeq) { actionBusy = ''; redraw(); schedulePoll(); }
    }
  }
  async function loadHistory() {
    if (!active() || historyLoading || !hasMore) return;
    historyLoading = true;
    const seq = mutationSeq, requestedSource = sourceKey(ch);
    drawControls();
    try {
      const query = new URLSearchParams({ source, limit: '50' });
      if (nextBefore != null) query.set('before_id', String(nextBefore));
      const response = await get(base + '/translations?' + query, { signal: controller.signal });
      if (!active() || seq !== mutationSeq || requestedSource !== sourceKey(ch)) return;
      for (const item of response?.items || []) if (item && numericId(item.id)) versions.set(Number(item.id), item);
      loadedMore = true;
      hasMore = response?.has_more === true;
      nextBefore = numericId(response?.next_before_id);
    } catch (error) {
      if (active() && seq === mutationSeq && requestedSource === sourceKey(ch) && error?.name !== 'AbortError') {
        localError = error?.status ? error.message : zh.network_error;
      }
    } finally {
      historyLoading = false;
      if (active()) redraw();
    }
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!active() || !jobPending()) { pollStart = 0; slow = false; return; }
    if (!pollStart) pollStart = Date.now();
    if (Date.now() - pollStart > SLOW_MS) { slow = true; drawStatus(); }
    // 排队也可能超过两分钟；持续只读轮询，不因超时重复提交付费翻译。
    pollTimer = setTimeout(async () => {
      if (!active()) return;
      const seq = mutationSeq;
      try {
        const response = await get(base + sourceQuery, { signal: controller.signal });
        if (!active() || seq !== mutationSeq) return;
        receive(response?.character);
      } catch { /* 临时断网保持当前译文，下次只读查询继续。 */ }
      if (active() && seq === mutationSeq) schedulePoll();
    }, POLL_MS);
  }
  modelEl.onchange = () => {
    modelId = translationModelId(modelEl.value);
    modelSeq++;
    drawControls();
  };
  historyEl.onchange = selectHistory;
  startEl.onclick = () => translate(false);
  forceEl.onclick = () => translate(true);
  moreEl.onclick = loadHistory;
  modelRetryEl.onclick = () => loadEnabledModels(true);
  const onModelFocus = () => { if (!modelsReady) loadEnabledModels(); };
  modelEl.addEventListener('focus', onModelFocus);
  ctx.onCleanup(() => {
    disposed = true;
    mutationSeq++;
    clearTimeout(pollTimer);
    controller.abort();
    modelEl.removeEventListener('focus', onModelFocus);
    modelEl.onchange = historyEl.onchange = null;
    startEl.onclick = forceEl.onclick = moreEl.onclick = modelRetryEl.onclick = null;
    const retry = statusEl.querySelector('[data-tr-retry]');
    if (retry) retry.onclick = null;
  });
  ingest(ch);
  if (selectedId() != null && modelId == null) modelId = selectedItem()?.model_id ?? null;
  redraw();
  schedulePoll();
  if (hasContract(ch)) loadEnabledModels();
}
