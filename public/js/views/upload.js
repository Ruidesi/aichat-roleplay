// 上传文件快速开聊（契约 §17）：拖拽 / 选择文件 → 解析结果 → 一句话说明 + 模型 + 预计花费 → 开始聊天
import { zh } from '/i18n/zh.js';
import { uploadForm, postJsonOrStream, ApiError } from '/js/api.js';
import { store } from '/js/store.js';
import { esc, fmtInt, fmtUsd, numOrNull, isTouch } from '/js/util.js';
import { icon, toastError } from '/js/ui.js';
import { loadModels, findModel } from '/js/models.js';

// 与契约 §16.1 / §17.1 的格式一致（服务端最终裁决，这里只做提前提示）
const EXTS = ['txt', 'md', 'markdown', 'csv', 'json', 'srt', 'log',
  'doc', 'docx', 'rtf', 'rtfd', 'odt', 'html', 'htm', 'webarchive',
  'pdf', 'epub', 'pptx', 'xlsx', 'png', 'jpg', 'jpeg', 'webp', 'heic'];
const MAX_FILES = 5;
const MAX_BYTES = 20 * 1024 * 1024;
const extOf = (name) => { const m = /\.([a-z0-9]+)$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
const sameFile = (a, b) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

export default async function uploadView(ctx) {
  const { root, setTitle, navigate } = ctx;
  const F = zh.filechat;
  setTitle(F.title);
  const touch = isTouch();

  root.innerHTML = `<div class="page page-narrow fc-page">
    <div class="fc-top">
      <button class="icon-btn" type="button" data-back aria-label="${esc(zh.back)}">${icon('back')}</button>
      <h1 class="page-title">${esc(F.title)}</h1>
    </div>
    <p class="muted small fc-lead">${esc(F.lead)}</p>
    <label class="fc-drop" data-drop>
      <input type="file" multiple accept="${EXTS.map((e) => '.' + e).join(',')}" data-input class="sr-only">
      <span class="fc-drop-icon">${icon('upload')}</span>
      <span class="fc-drop-title" data-drop-title>${esc(touch ? F.drop_title_touch : F.drop_title)}</span>
      <span class="fc-drop-sub">${esc(F.limits)}</span>
    </label>
    <p class="fc-formats">${esc(F.formats)}</p>
    <div class="form-error fc-err" role="alert" data-err></div>
    <section class="fc-result" data-result hidden>
      <div class="panel">
        <div class="panel-title fc-res-head"><span>${esc(F.files_title)}</span><span class="fc-total" data-total></span></div>
        <div data-files></div>
        <div class="fc-file-acts">
          <button class="btn btn-sm" type="button" data-add>${icon('plus')}<span>${esc(F.add_more)}</span></button>
          <button class="btn btn-sm" type="button" data-reselect>${icon('refresh')}<span>${esc(F.reselect)}</span></button>
        </div>
      </div>
      <p class="fc-note" data-mode hidden></p>
      <form class="panel panel-pad fc-form" data-form novalidate>
        <div class="field"><label for="fc-ins">${esc(F.instruction)}</label>
          <textarea id="fc-ins" class="textarea" name="instruction" rows="2" maxlength="500" placeholder="${esc(F.instruction)}" aria-describedby="fc-ins-hint"></textarea>
          <span class="hint" id="fc-ins-hint">${esc(F.instruction_hint)}</span></div>
        <div class="field"><label for="fc-model">${esc(F.model)}</label>
          <select id="fc-model" class="input select" name="model" disabled><option>${esc(zh.loading)}</option></select></div>
        <p class="fc-estimate" data-estimate></p>
        <button class="btn btn-primary btn-block" type="submit" data-start disabled>${icon('chats')}<span>${esc(F.start)}</span></button>
      </form>
    </section>
    <div style="height:24px"></div>
  </div>`;

  const drop = root.querySelector('[data-drop]');
  const input = root.querySelector('[data-input]');
  const errEl = root.querySelector('[data-err]');
  const result = root.querySelector('[data-result]');
  const filesEl = root.querySelector('[data-files]');
  const totalEl = root.querySelector('[data-total]');
  const modeEl = root.querySelector('[data-mode]');
  const form = root.querySelector('[data-form]');
  const sel = form.model;
  const startBtn = root.querySelector('[data-start]');
  const estEl = root.querySelector('[data-estimate]');
  const dropTitle = root.querySelector('[data-drop-title]');

  root.querySelector('[data-back]').onclick = () => (history.length > 1 ? history.back() : navigate('#/chats'));

  let picked = []; // 本地 File 对象（上传过期时用来重新解析）
  let parsed = null; // 解析接口的返回
  let busy = false;
  let models = { items: [], default_model_id: null };
  let ac = null;
  ctx.onCleanup(() => { if (ac) ac.abort(); });

  /* ---------- 模型 ---------- */
  const fillModels = async () => {
    try { models = await loadModels(); } catch { models = { items: [], default_model_id: null }; }
    if (!ctx.isActive()) return;
    const items = models.items;
    const mine = store.me && findModel(items, store.me.default_model_id);
    const def = mine || findModel(items, models.default_model_id) || items[0] || null;
    sel.innerHTML = items.length
      ? items.map((m) => `<option value="${esc(m.id)}">${esc(mine && String(m.id) === String(mine.id) ? F.model_default(m.name) : m.name)}</option>`).join('')
      : `<option value="">${esc(zh.models.empty)}</option>`;
    if (def) sel.value = String(def.id);
    sel.disabled = !items.length || busy;
    drawEstimate();
  };
  sel.addEventListener('change', drawEstimate);

  /* ---------- 预计花费 ---------- */
  // 返回 {per, first}（美元，算不出为 null）
  function estimateFor(modelId) {
    if (!parsed) return { per: null, first: null };
    // 兼容：数字，或按模型给的 {model_id: usd} / estimates:[{model_id, per_message_usd, first_message_usd}]
    const e = parsed.estimate_per_message_usd;
    if (e && typeof e === 'object' && !Array.isArray(e)) {
      if (modelId != null && String(modelId) in e) return { per: numOrNull(e[String(modelId)]), first: null };
      return { per: numOrNull(e.default), first: null };
    }
    // 顶层数字是服务端按 estimate_model_id 算的：只在模型对得上（或没标模型）时拿来兜底，免得把别的模型的价钱显示出来
    const topMatches = parsed.estimate_model_id == null || modelId == null || String(parsed.estimate_model_id) === String(modelId);
    const top = topMatches
      ? { per: numOrNull(e), first: numOrNull(parsed.estimate_first_message_usd) }
      : { per: null, first: null };
    if (Array.isArray(parsed.estimates)) {
      const hit = parsed.estimates.find((x) => x && String(x.model_id) === String(modelId));
      if (hit) {
        const per = numOrNull(hit.per_message_usd ?? hit.usd ?? hit.estimate_per_message_usd);
        const first = numOrNull(hit.first_message_usd ?? hit.estimate_first_message_usd);
        if (per != null) return { per, first };
        return top;
      }
    }
    return top;
  }
  function drawEstimate() {
    if (!parsed) { estEl.textContent = ''; return; }
    const { per, first } = estimateFor(sel.value || null);
    const s = per == null ? '' : fmtUsd(per);
    if (!s) { estEl.textContent = F.estimate_none; return; }
    const f = first != null && first > per ? fmtUsd(first) : '';
    estEl.textContent = f ? F.estimate_with_first(s, f) : F.estimate(s);
  }

  /* ---------- 选择 / 校验文件 ---------- */
  const okCount = () => (parsed && Array.isArray(parsed.files) ? parsed.files.filter((f) => f && f.ok !== false && (Number(f.chars) || 0) > 0).length : 0);

  function precheck(list) {
    if (list.length > MAX_FILES) return F.too_many;
    for (const f of list) {
      if (!EXTS.includes(extOf(f.name))) return F.bad_type(f.name);
      if (f.size > MAX_BYTES) return F.too_big(f.name);
      if (f.size === 0) return F.empty_file(f.name);
    }
    return '';
  }

  function drawFiles() {
    const files = (parsed && Array.isArray(parsed.files)) ? parsed.files : [];
    filesEl.innerHTML = files.map((f, i) => {
      const ok = f.ok !== false && !f.error;
      return `<div class="row fc-file${ok ? '' : ' bad'}">
        <span class="fc-file-ic">${icon(ok ? 'file' : 'alert')}</span>
        <div class="row-main">
          <div class="row-title">${esc(f.name || '')}</div>
          <div class="row-sub${ok ? '' : ' fc-file-err'}">${esc(ok ? F.file_ok(fmtInt(f.chars)) : (f.error || F.file_failed))}</div>
        </div>
        <button class="icon-btn" type="button" data-rm="${i}" aria-label="${esc(F.remove_file(f.name || ''))}" title="${esc(F.remove_file(f.name || ''))}">${icon('x')}</button>
      </div>`;
    }).join('');
    const total = numOrNull(parsed && parsed.total_chars);
    totalEl.textContent = total != null ? F.total(fmtInt(total)) : '';
    const notes = [];
    if (parsed && parsed.mode === 'retrieval') notes.push(F.mode_retrieval);
    if (parsed && (parsed.truncated === true || parsed.truncated === 1)) notes.push(F.truncated);
    if (parsed && !okCount()) notes.push(F.none_ok);
    modeEl.hidden = !notes.length;
    modeEl.textContent = notes.join(' ');
    modeEl.classList.toggle('bad', !!parsed && !okCount());
    root.querySelector('[data-add]').hidden = picked.length >= MAX_FILES;
    startBtn.disabled = busy || !okCount() || !parsed.upload_id;
    drawEstimate();
  }

  function setBusy(v, label) {
    busy = v;
    drop.classList.toggle('busy', v);
    input.disabled = v;
    dropTitle.textContent = v ? (label || F.parsing) : (touch ? F.drop_title_touch : F.drop_title);
    form.querySelectorAll('textarea, select, button').forEach((b) => { b.disabled = v; });
    root.querySelectorAll('[data-add], [data-reselect], [data-rm]').forEach((b) => { b.disabled = v; });
    if (!v) { sel.disabled = !models.items.length; startBtn.disabled = !okCount() || !(parsed && parsed.upload_id); }
  }

  async function parse(list) {
    errEl.textContent = '';
    const bad = precheck(list);
    if (bad) { errEl.textContent = bad; return false; }
    if (!list.length) { picked = []; parsed = null; result.hidden = true; return false; }
    const fd = new FormData();
    for (const f of list) fd.append('files', f, f.name);
    ac = new AbortController();
    setBusy(true, F.uploading(0));
    try {
      const r = await uploadForm('/api/file-chats/parse', fd, {
        signal: ac.signal,
        onProgress: (p) => { if (ctx.isActive()) dropTitle.textContent = p == null ? F.parsing : F.uploading(p); },
      });
      if (!ctx.isActive()) return false;
      picked = list.slice();
      parsed = r || {};
      if (!Array.isArray(parsed.files)) parsed.files = list.map((f) => ({ name: f.name, chars: 0, ok: false }));
      result.hidden = false;
      return true;
    } catch (e) {
      if (e && e.name === 'AbortError') return false;
      if (!ctx.isActive()) return false;
      errEl.textContent = e instanceof ApiError && e.message ? e.message : F.parse_failed;
      return false;
    } finally {
      ac = null;
      if (ctx.isActive()) { setBusy(false); if (parsed) drawFiles(); }
    }
  }

  // add=true 时追加到已选文件（同一文件不重复），否则替换
  async function choose(fileList, add) {
    let list = [...fileList];
    if (!list.length || busy) return;
    if (add) list = picked.concat(list.filter((f) => !picked.some((p) => sameFile(p, f))));
    await parse(list);
  }

  let addMode = false;
  input.addEventListener('change', () => { const fl = input.files; const a = addMode; addMode = false; choose(fl, a).finally(() => { input.value = ''; }); });
  root.querySelector('[data-add]').onclick = () => { addMode = true; input.click(); };
  root.querySelector('[data-reselect]').onclick = () => { addMode = false; input.click(); };
  filesEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]');
    if (!b || busy) return;
    const i = +b.dataset.rm;
    const name = parsed && parsed.files[i] && parsed.files[i].name;
    // 按名字找本地文件（服务端顺序与上传顺序一致时按下标兜底）
    let k = picked.findIndex((f) => f.name === name);
    if (k < 0) k = i;
    const rest = picked.filter((_, j) => j !== k);
    if (!rest.length) { picked = []; parsed = null; result.hidden = true; errEl.textContent = ''; return; }
    parse(rest);
  });

  // 拖拽（桌面）
  let depth = 0;
  const setDrag = (on) => { drop.classList.toggle('drag', on); if (!busy) dropTitle.textContent = on ? F.drop_active : (touch ? F.drop_title_touch : F.drop_title); };
  drop.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; setDrag(true); });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  drop.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) setDrag(false); });
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    setDrag(false);
    const fl = e.dataTransfer && e.dataTransfer.files;
    if (fl && fl.length) choose(fl, !!parsed);
  });
  // 拖到拖拽区以外时不要让浏览器直接打开文件
  const stopNav = (e) => { if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) e.preventDefault(); };
  window.addEventListener('dragover', stopNav);
  window.addEventListener('drop', stopNav);
  ctx.onCleanup(() => { window.removeEventListener('dragover', stopNav); window.removeEventListener('drop', stopNav); });

  /* ---------- 开始聊天 ---------- */
  // 收到会话 id（SSE 'chat' 事件）就立刻进聊天页；开场的流不随离开本页中止，在后台读完，
  // 进度放进 store.kickoff 交给聊天页实时显示（失败 / 中断也由聊天页给「重新生成开场」）
  async function start(retried) {
    if (!parsed || !parsed.upload_id) return;
    const body = { upload_id: parsed.upload_id };
    const ins = form.instruction.value.trim();
    if (ins) body.instruction = ins;
    if (sel.value) body.model_id = /^\d+$/.test(sel.value) ? Number(sel.value) : sel.value;
    errEl.textContent = '';
    const kac = new AbortController(); // 不挂到本页的清理上：离开页面也不会中断开场生成
    setBusy(true, F.starting);
    startBtn.innerHTML = `<span class="spinner sm" aria-hidden="true"></span><span>${esc(F.starting)}</span>`;
    let chatId = null;
    let kick = null;
    let preErr = null; // 会话建好之前流里就报错（少见）
    const emit = (type) => { for (const fn of [...kick.listeners]) { try { fn(type); } catch { /* 聊天页自己处理 */ } } };
    const settle = (state, err) => {
      if (!kick || kick.state !== 'running') return;
      kick.state = state;
      if (err) kick.error = err;
      emit(state);
    };
    const enterChat = () => {
      store.homeCache = null;
      if (ctx.isActive()) navigate('#/chat/' + encodeURIComponent(chatId), true);
    };
    try {
      const r = await postJsonOrStream('/api/file-chats', body, {
        signal: kac.signal,
        onEvent: (ev, d) => {
          if (chatId == null) {
            const id = d && ((d.chat && d.chat.id) ?? d.chat_id ?? (d.message && d.message.chat_id));
            if (id != null) {
              chatId = id;
              kick = { chatId: id, state: 'running', text: '', error: null, listeners: new Set(), abort: () => kac.abort() };
              store.kickoff = kick;
              enterChat();
            }
          }
          if (!kick) { if (ev === 'error') preErr = new ApiError((d && d.error) || zh.chat.failed, 0, (d && typeof d.code === 'string' && d.code) || ''); return; }
          if (ev === 'delta') { kick.text += (d && d.text) || ''; emit('delta'); }
          else if (ev === 'done') settle('done');
          else if (ev === 'error') settle('error', new ApiError((d && d.error) || zh.chat.failed, 0, (d && typeof d.code === 'string' && d.code) || ''));
        },
      });
      if (kick) { settle('error', new ApiError(zh.chat.failed, 0)); return; } // 流结束却没有 done
      // 服务端按 JSON 返回（整段生成完才回）：照旧进聊天页
      if (r && r.chat && r.chat.id != null) chatId = r.chat.id;
      else if (r && r.chat_id != null) chatId = r.chat_id;
      if (!ctx.isActive()) return;
      if (chatId == null) throw preErr || new ApiError(zh.server_error, 0);
      enterChat();
    } catch (e) {
      // 会话已建好（已跳到聊天页）：错误交给聊天页显示
      if (kick) { settle(e && e.name === 'AbortError' ? 'aborted' : 'error', e && e.name === 'AbortError' ? null : (e instanceof ApiError ? e : new ApiError(zh.network_error, 0))); return; }
      if (!ctx.isActive() || (e && e.name === 'AbortError')) return;
      // 暂存的正文已过期（1 小时）：用本地文件重新解析一次再开
      if (!retried && e instanceof ApiError && (e.status === 404 || e.status === 410 || e.code === 'upload_expired') && picked.length) {
        startBtn.innerHTML = `${icon('chats')}<span>${esc(F.start)}</span>`;
        setBusy(false);
        errEl.textContent = F.expired;
        if (await parse(picked) && ctx.isActive() && okCount()) { errEl.textContent = ''; await start(true); }
        return;
      }
      errEl.textContent = e instanceof ApiError && e.message ? e.message : zh.network_error;
      toastError(e);
    } finally {
      if (ctx.isActive()) {
        startBtn.innerHTML = `${icon('chats')}<span>${esc(F.start)}</span>`;
        setBusy(false);
      }
    }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); if (!busy) start(false); });

  fillModels();
}
