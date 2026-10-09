// 语音输入（契约 §18 / §18.5）：麦克风按钮 + 录音面板 + 上传识别 + 浏览器识别回退 + 权限指引。
// 手机：按住说话、松开结束、上滑取消；桌面（鼠标 / 键盘）：点一下开始、再点一下结束。最长 60 秒。
import { zh } from '/i18n/zh.js';
import { upload, ApiError } from '/js/api.js';
import { esc } from '/js/util.js';
import { icon, toast, openSheet } from '/js/ui.js';

const MAX_MS = 60000;
const MIN_MS = 600; // 短于这个当误触
const CANCEL_DY = 60; // 上滑超过这么多像素算取消
const BARS = 7;

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition || null) : null;
const canRecord = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

/** MediaRecorder 能产出的格式：Chrome / Firefox 为 webm/opus，Safari 为 mp4/aac */
export function pickMime() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  const list = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/aac'];
  return list.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || '';
}

/** 上传用的 Content-Type：去掉 codecs 参数，只留主类型 */
export const baseMime = (t) => String(t || '').split(';')[0].trim().toLowerCase() || 'audio/webm';

function platformOf() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

/** 麦克风权限被拒的开启指引（当前平台排第一并突出） */
export function showPermissionHelp() {
  const V = zh.voice;
  const p = platformOf();
  const order = [p, ...['ios', 'android', 'desktop'].filter((x) => x !== p)];
  const s = openSheet(`
    <div class="sheet-title">${icon('mic')} ${esc(V.perm_title)}</div>
    <p class="sheet-text small">${esc(V.perm_lead)}</p>
    <ul class="perm-list">${order.map((k, i) => `<li class="${i === 0 ? 'cur' : ''}">${esc(V['perm_' + k])}</li>`).join('')}</ul>
    <div class="sheet-actions"><button class="btn btn-primary" type="button" data-a="ok">${esc(V.perm_ok)}</button></div>`, { label: V.perm_title });
  s.el.querySelector('[data-a="ok"]').onclick = () => s.close();
}

const fmtClock = (ms) => {
  const s = Math.min(60, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * 挂到聊天输入区。
 * opts: { composer（form）, inner（.composer-inner）, sendBtn, chatId, isBlocked()→bool, onText({text, clipId, auto}), autoSend()→bool, onCleanup }
 * 返回 { busy()→bool, cancel() }
 */
export function mountVoice(opts) {
  const V = zh.voice;
  const { composer, inner, sendBtn, chatId, isBlocked, onText, autoSend } = opts;
  const recordOk = canRecord();
  // 服务端识别失败 / 不能录音 → 改用浏览器识别（Web Speech）
  // 两样都没有时按钮照样显示，点了给出说明（非安全连接时提示原因）
  let fallback = !recordOk && !!SR;
  let fallbackNoted = false;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mic-btn';
  btn.setAttribute('aria-label', V.mic);
  btn.title = V.mic;
  btn.innerHTML = icon('mic');
  inner.insertBefore(btn, sendBtn);

  const panel = document.createElement('div');
  panel.className = 'voice-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'status');
  panel.innerHTML = `
    <div class="vp-bars" aria-hidden="true">${'<i></i>'.repeat(BARS)}</div>
    <div class="vp-main"><span class="vp-time" data-time>0:00</span><span class="vp-hint" data-hint></span></div>
    <button class="btn btn-sm vp-cancel" type="button" data-cancel>${esc(V.cancel)}</button>
    <button class="btn btn-sm btn-primary vp-done" type="button" data-done>${esc(V.done)}</button>`;
  composer.insertBefore(panel, inner);
  const bars = [...panel.querySelectorAll('.vp-bars i')];
  const timeEl = panel.querySelector('[data-time]');
  const hintEl = panel.querySelector('[data-hint]');
  const cancelBtn = panel.querySelector('[data-cancel]');
  const doneBtn = panel.querySelector('[data-done]');

  // 状态：idle | starting | recording | working（识别中）
  let state = 'idle';
  let holdMode = false; // 按住说话（触屏）
  let released = false; // 按住模式下，录音还没开始就已松手
  let cancelArmed = false;
  let startY = 0;
  let pressAt = 0;
  let stream = null;
  let rec = null;
  let chunks = [];
  let audioCtx = null;
  let analyser = null;
  let raf = 0;
  let t0 = 0;
  let maxTimer = 0;
  let sr = null;
  let srText = '';
  let srInterim = '';
  let workAc = null;
  let workTimer = 0;
  let lastTouch = 0;
  let destroyed = false;

  function setState(s) {
    state = s;
    btn.classList.toggle('rec', s === 'recording' || s === 'starting');
    btn.classList.toggle('working', s === 'working');
    btn.setAttribute('aria-pressed', s === 'recording' ? 'true' : 'false');
    btn.setAttribute('aria-label', s === 'recording' && !holdMode ? V.mic_stop : V.mic);
    panel.hidden = s === 'idle';
    panel.classList.toggle('working', s === 'working');
    panel.classList.toggle('hold', holdMode);
    composer.classList.toggle('voice-on', s !== 'idle');
    cancelBtn.hidden = s === 'idle';
    doneBtn.hidden = !(s === 'recording' && !holdMode);
    if (s !== 'recording') panel.classList.remove('armed');
    drawHint();
  }

  function drawHint() {
    if (state === 'working') return;
    if (state === 'starting') { hintEl.textContent = ''; return; }
    if (fallback) hintEl.textContent = srInterim || srText || (holdMode ? V.hint_hold : V.hint_tap);
    else hintEl.textContent = cancelArmed ? V.hint_release_cancel : (holdMode ? V.hint_hold : V.hint_tap);
  }

  function setWorking(text) {
    setState('working');
    timeEl.innerHTML = '<span class="spinner sm" aria-hidden="true"></span>';
    hintEl.textContent = text;
  }

  function releaseMedia() {
    cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(maxTimer);
    if (stream) { stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* */ } }); stream = null; }
    if (audioCtx) { try { audioCtx.close(); } catch { /* */ } audioCtx = null; analyser = null; }
    bars.forEach((b) => { b.style.transform = ''; });
  }

  function tick() {
    const ms = performance.now() - t0;
    timeEl.textContent = `${fmtClock(ms)} / 1:00`;
    if (analyser) {
      const buf = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      bars.forEach((b, i) => {
        const w = 1 - Math.abs(i - (BARS - 1) / 2) / BARS;
        b.style.transform = `scaleY(${(0.18 + level * w * (0.7 + Math.random() * 0.3)).toFixed(3)})`;
      });
    } else {
      // 浏览器识别模式拿不到音量：做一个轻微的呼吸动画
      const ph = ms / 260;
      bars.forEach((b, i) => { b.style.transform = `scaleY(${(0.3 + 0.25 * Math.abs(Math.sin(ph + i * 0.7))).toFixed(3)})`; });
    }
    raf = requestAnimationFrame(tick);
  }

  function beginClock() {
    t0 = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
    clearTimeout(maxTimer);
    maxTimer = setTimeout(() => {
      if (state !== 'recording') return;
      toast(V.max_reached);
      finish();
    }, MAX_MS);
  }

  function micError(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError' || n === 'not-allowed' || n === 'service-not-allowed') showPermissionHelp();
    else if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'audio-capture') toast(V.no_device, 'error');
    else if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') toast(V.busy, 'error');
    else toast(V.unavailable, 'error');
  }

  /* ---------- 录音（服务端识别） ---------- */
  async function startRecord() {
    if (!window.isSecureContext) { toast(V.insecure, 'error'); return; }
    setState('starting');
    const asked = performance.now();
    // 音量动画用的 AudioContext 要在手势里同步创建，否则 iOS Safari 会一直处于挂起状态
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { audioCtx = new AC(); if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {}); }
    } catch { audioCtx = null; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      releaseMedia();
      setState('idle');
      micError(e);
      return;
    }
    if (destroyed || state !== 'starting') { releaseMedia(); return; }
    // 按住模式：等权限弹窗期间已经松手 → 这次不录，提示再按一次
    if (holdMode && released) {
      releaseMedia();
      setState('idle');
      if (performance.now() - asked > 700) toast(V.granted_retry); else toast(V.too_short);
      return;
    }
    const mime = pickMime();
    try {
      rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      try { rec = new MediaRecorder(stream); } catch (e2) { releaseMedia(); setState('idle'); micError(e2); return; }
    }
    chunks = [];
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    try {
      if (audioCtx) {
        const src = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      }
    } catch { analyser = null; }
    try { rec.start(250); } catch (e) { releaseMedia(); setState('idle'); micError(e); return; }
    cancelArmed = false;
    setState('recording');
    beginClock();
  }

  function stopRecorder() {
    return new Promise((resolve) => {
      const r = rec;
      rec = null;
      if (!r || r.state === 'inactive') { resolve(r ? r.mimeType : ''); return; }
      r.onstop = () => resolve(r.mimeType || '');
      try { r.stop(); } catch { resolve(r.mimeType || ''); }
    });
  }

  async function finishRecord() {
    const dur = Math.round(performance.now() - t0);
    clearTimeout(maxTimer);
    const recMime = await stopRecorder();
    releaseMedia();
    if (dur < MIN_MS) { setState('idle'); toast(V.too_short); return; }
    const type = baseMime(recMime || (chunks[0] && chunks[0].type) || pickMime());
    const blob = new Blob(chunks, { type });
    chunks = [];
    if (!blob.size) { setState('idle'); toast(V.empty); return; }
    await transcribe(blob, type, dur);
  }

  async function transcribe(blob, type, dur) {
    setWorking(V.recognizing);
    // 识别与整理在服务端一次完成；等得稍久时把提示换成「正在整理…」
    clearTimeout(workTimer);
    workTimer = setTimeout(() => { if (state === 'working') hintEl.textContent = V.formatting; }, 2500);
    workAc = new AbortController();
    const qs = new URLSearchParams({ duration_ms: String(dur) });
    if (chatId != null) qs.set('chat_id', String(chatId));
    try {
      const r = await upload('/api/voice/transcribe?' + qs, blob, type, { signal: workAc.signal });
      if (destroyed) return;
      const text = String((r && (r.formatted_text || r.raw_text)) || '').trim();
      setState('idle');
      if (!text) { toast(V.empty); return; }
      onText({ text, clipId: r.clip_id ?? null, auto: !!(autoSend && autoSend()) });
    } catch (e) {
      if (destroyed) return;
      setState('idle');
      if (e && e.name === 'AbortError') return;
      const unavailable = e instanceof ApiError && (e.status === 501 || e.status === 502 || e.status === 503 || e.status === 504 || /unavailable/.test(e.code || ''));
      if (unavailable && SR) {
        fallback = true;
        toast(V.fallback_on);
      } else if (unavailable) {
        toast(V.unavailable, 'error');
      } else {
        toast((e instanceof ApiError && e.status && e.message) || V.failed, 'error');
      }
    } finally {
      clearTimeout(workTimer);
      workAc = null;
    }
  }

  /* ---------- 浏览器识别（回退） ---------- */
  function startSpeech() {
    if (!SR) { toast(V.unavailable, 'error'); return; }
    srText = '';
    srInterim = '';
    let rcg;
    try {
      rcg = new SR();
      rcg.lang = 'zh-CN';
      rcg.interimResults = true;
      rcg.continuous = true;
      rcg.maxAlternatives = 1;
    } catch { toast(V.unavailable, 'error'); return; }
    sr = rcg;
    let cancelled = false;
    rcg.onresult = (ev) => {
      let fin = '';
      let tmp = '';
      for (let i = 0; i < ev.results.length; i++) {
        const t = ev.results[i][0] ? ev.results[i][0].transcript : '';
        if (ev.results[i].isFinal) fin += t; else tmp += t;
      }
      srText = fin;
      srInterim = fin + tmp;
      drawHint();
    };
    rcg.onerror = (ev) => {
      const err = ev && ev.error;
      if (err === 'aborted') return;
      cancelled = true;
      if (err === 'no-speech') toast(V.empty);
      else micError({ name: err });
    };
    rcg.onend = () => {
      const wasCancel = cancelled || rcg._cancel;
      sr = null;
      releaseMedia();
      setState('idle');
      if (wasCancel || destroyed) return;
      const dur = performance.now() - t0;
      const text = (srText || srInterim).trim();
      if (!text) { if (dur >= MIN_MS) toast(V.empty); else toast(V.too_short); return; }
      onText({ text, clipId: null, auto: !!(autoSend && autoSend()) });
    };
    try { rcg.start(); } catch (e) { sr = null; micError(e); return; }
    cancelArmed = false;
    setState('recording');
    hintEl.textContent = V.listening;
    beginClock();
  }

  /* ---------- 开始 / 结束 / 取消 ---------- */
  function begin() {
    if (state !== 'idle' || (isBlocked && isBlocked())) return;
    if (!recordOk && !SR) { toast(window.isSecureContext ? V.unavailable : V.insecure, 'error'); return; }
    if (fallback && !recordOk && !fallbackNoted) { fallbackNoted = true; toast(V.fallback_only); }
    if (fallback) startSpeech(); else startRecord();
  }

  function finish() {
    if (state !== 'recording') return;
    if (fallback) {
      if (sr) { setWorking(V.recognizing); try { sr.stop(); } catch { /* */ } }
      return;
    }
    setWorking(V.recognizing);
    finishRecord();
  }

  function cancel() {
    if (state === 'idle') return;
    if (state === 'working') { if (workAc) workAc.abort(); setState('idle'); return; }
    if (sr) { sr._cancel = true; try { sr.abort(); } catch { /* */ } sr = null; }
    if (rec) { rec.ondataavailable = null; try { rec.stop(); } catch { /* */ } rec = null; }
    chunks = [];
    releaseMedia();
    cancelArmed = false;
    setState('idle');
  }

  /* ---------- 手势 ---------- */
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return; // 鼠标走 click
    e.preventDefault();
    lastTouch = Date.now();
    if (state === 'working') return;
    if (state !== 'idle') { cancel(); return; }
    holdMode = true;
    released = false;
    cancelArmed = false;
    startY = e.clientY;
    pressAt = performance.now();
    try { btn.setPointerCapture(e.pointerId); } catch { /* */ }
    begin();
  });
  btn.addEventListener('pointermove', (e) => {
    if (!holdMode || (state !== 'recording' && state !== 'starting')) return;
    const armed = startY - e.clientY > CANCEL_DY;
    if (armed !== cancelArmed) {
      cancelArmed = armed;
      panel.classList.toggle('armed', armed);
      drawHint();
    }
  });
  const onRelease = (e, isCancel) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    lastTouch = Date.now();
    if (!holdMode) return;
    released = true;
    if (state === 'starting') return; // 权限弹窗中：startRecord 会处理
    if (state !== 'recording') return;
    if (isCancel || cancelArmed) { cancel(); return; }
    if (performance.now() - pressAt < MIN_MS && !fallback) { cancel(); toast(V.too_short); return; }
    finish();
  };
  btn.addEventListener('pointerup', (e) => onRelease(e, false));
  btn.addEventListener('pointercancel', (e) => onRelease(e, true));
  btn.addEventListener('click', () => {
    if (Date.now() - lastTouch < 900) return; // 触屏手势已处理
    if (state === 'idle') { holdMode = false; begin(); } else if (state === 'recording' && !holdMode) finish();
    else if (state === 'starting' || state === 'working') { /* 等待中 */ }
  });
  cancelBtn.onclick = () => cancel();
  doneBtn.onclick = () => finish();
  const onKey = (e) => { if (e.key === 'Escape' && state !== 'idle' && !document.querySelector('.overlay')) cancel(); };
  document.addEventListener('keydown', onKey);
  // 切到后台 / 锁屏时放弃录音，免得麦克风一直占用
  const onVis = () => { if (document.hidden && (state === 'recording' || state === 'starting')) cancel(); };
  document.addEventListener('visibilitychange', onVis);

  const destroy = () => {
    destroyed = true;
    cancel();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
  };
  if (opts.onCleanup) opts.onCleanup(destroy);

  return {
    busy: () => state !== 'idle',
    cancel,
    setDisabled(v) { btn.disabled = !!v; if (v) cancel(); },
    destroy,
  };
}
