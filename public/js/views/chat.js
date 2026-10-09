import { zh } from '/i18n/zh.js';
import { get, post, patch, del, postStream, ApiError } from '/js/api.js';
import { store } from '/js/store.js';
import { esc, formatMessage, isTouch, fmtCost, fmtInt, numOrNull } from '/js/util.js';
import { icon, avatar, fileAvatar, spinnerHtml, errorHtml, menu, confirmDialog, editTextDialog, openSheet, toast, toastError } from '/js/ui.js';
import { openChatSettings } from '/js/chatsettings.js';
import { loadModels, findModel, pickModelSheet } from '/js/models.js';
import { chatTarget, isFileChat, fileChatFiles } from '/js/cards.js';
import { mountVoice } from '/js/voice.js';
import { openFileInfo } from '/js/filechat.js';
import { bindChatKeyboard, desktopKeyboard } from '/js/chat-keyboard.js';
import { bindChatViewport } from '/js/chat-viewport.js';
import { CHAT_PAGE, clampShown, initialShown, windowStart, loadMoreShown, keepShown, shownAfterDelete, noteAnchorIndex, noteVisible } from '/js/chat-window.js';

export default async function chatView(ctx) {
  const { root, params, setTitle, navigate } = ctx;
  const T = zh.chat;
  const chatId = decodeURIComponent(params[0]);
  const base = '/api/chats/' + encodeURIComponent(chatId);

  root.innerHTML = `<div class="chat">
    <header class="chat-head">
      <button class="icon-btn" data-back aria-label="${esc(zh.back)}">${icon('back')}</button>
      <a class="who" data-who><div class="avatar-fallback" style="width:38px;height:38px"></div><div style="min-width:0"><div class="who-name">&nbsp;</div></div></a>
      <div class="head-meta">
        <button class="model-chip" type="button" data-model hidden></button>
        <span class="chat-cost" data-cost hidden></span>
      </div>
      <button class="icon-btn" data-menu aria-label="${esc(zh.more)}">${icon('more')}</button>
    </header>
    <div class="chat-scroll"><div class="chat-list" role="log" aria-live="polite">${spinnerHtml()}</div></div>
    <form class="composer">
      <button class="jump-btn" type="button" data-jump hidden aria-label="${esc(T.jump)}">${icon('down')}</button>
      <div class="chat-banner" data-banner role="status" hidden><span></span><button class="btn btn-sm banner-act" type="button" data-banner-act hidden></button><button class="icon-btn" type="button" data-banner-close aria-label="${esc(zh.close)}">${icon('x')}</button></div>
      <div class="chat-gone" data-gone role="status" hidden>${icon('lock')}<div><b>${esc(T.unavailable)}</b><span>${esc(T.unavailable_hint)}</span></div></div>
      <div class="composer-inner">
        <textarea rows="1" aria-label="${esc(T.input)}" aria-describedby="chat-keyboard-hint" placeholder="${esc(T.input)}" enterkeyhint="${desktopKeyboard() ? 'send' : 'enter'}" maxlength="8000"></textarea>
        <button class="send-btn" type="submit" aria-label="${esc(T.send)}" disabled>${icon('send')}</button>
      </div>
      <p class="composer-keyboard-hint" id="chat-keyboard-hint">${esc(desktopKeyboard() ? T.keyboard_hint : T.keyboard_hint_mobile)}</p>
    </form>
  </div>`;

  const el = root.querySelector('.chat');
  const scroller = el.querySelector('.chat-scroll');
  const list = el.querySelector('.chat-list');
  const ta = el.querySelector('textarea');
  const sendBtn = el.querySelector('.send-btn');
  const jumpBtn = el.querySelector('[data-jump]');
  const backBtn = el.querySelector('[data-back]');
  const banner = el.querySelector('[data-banner]');

  // 出错 / 停止的提示放在输入框上方，不会被整页重绘冲掉
  let lastNote = null; // {text, kind: 'error'|'info', action?: {label, run}}
  const bannerAct = banner.querySelector('[data-banner-act]');
  function showNote(note) {
    lastNote = note;
    banner.hidden = !note;
    banner.classList.toggle('info', !!note && note.kind === 'info');
    banner.firstElementChild.textContent = note ? note.text : '';
    const act = note && note.action;
    bannerAct.hidden = !act;
    bannerAct.textContent = act ? act.label : '';
    bannerAct.onclick = act ? () => act.run() : null;
  }
  banner.querySelector('[data-banner-close]').onclick = () => showNote(null);
  // 模型拒答（§8.4 code=refused）：错误条上直接给「换个模型」
  const refusedAction = (e) => (e && e.code === 'refused' ? { label: T.switch_model, run: () => switchModel({ fromRefused: true }) } : null);
  // 文件会话还没有 AI 开场（且还没开始对话）：错误 / 停止条上给「重新生成开场」
  const needsKickoff = () => isFile() && !messages.some((m) => m.role === 'user' || (m.role === 'assistant' && m.id != null));
  const kickoffAction = () => ({ label: zh.filechat.kickoff_regen, run: () => { showNote(null); regenerate(); } });
  const failAction = (e) => refusedAction(e) || (needsKickoff() ? kickoffAction() : null);
  // 只显示服务端给的中文说明；浏览器原生异常一律换成通用中文提示
  const errText = (e) => (e instanceof ApiError && e.message ? e.message : T.failed);
  // 开流前失败（额度用完、断网等）：提示放进输入框上方横幅，键盘弹起时也看得见（toast 会被 iOS 键盘挡住）
  const failNote = (e) => {
    if (e && e.name === 'AbortError') return;
    showNote({ text: e instanceof ApiError && e.message ? e.message : zh.network_error, kind: 'error', action: failAction(e) });
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  backBtn.onclick = () => (history.length > 1 ? history.back() : navigate('#/chats'));

  const viewport = bindChatViewport({ chat: el, scroller, input: ta, jumpButton: jumpBtn, useVisualViewport: isTouch() });
  ctx.onCleanup(viewport.cleanup);

  let character = {};
  // v0.9 F3：源卡被作者删除 / 改私有 / 作者账号已删 → 后端给 character.unavailable=true，会话只读
  const isGone = () => !!(character && (character.unavailable === true || character.unavailable === 1));
  const goneBox = el.querySelector('[data-gone]');
  const composerInner = el.querySelector('.composer-inner');
  function applyGone() {
    const g = isGone();
    goneBox.hidden = !g;
    composerInner.hidden = g;
    ta.disabled = g;
    if (g) { ta.value = ''; showNote(null); }
    el.querySelector('[data-model]').disabled = g;
  }
  let chatInfo = null; // 会话本身（含 user_card_id 时为自建卡会话）
  let fileInfo = null; // 文件会话（契约 §17）：{files, instruction, mode, total_chars}
  const isFile = () => !!fileInfo || isFileChat(chatInfo || {});
  // 角色头像；文件会话用文件图标
  const whoAvatar = (cls, size) => (isFile() ? fileAvatar(cls || 'avatar', size) : avatar(character.avatar, character.name, cls, size));
  let pendingClip = null; // 语音识别得到的 clip_id，随下一条消息发送（契约 §18.5）
  let chatModel = null; // {id, name}
  let localNotes = []; // 仅前端显示的系统提示 {afterId, text}
  let messages = []; // {id, role, content, node, streaming, error, note, cost_usd, cost_source, tokens_in, tokens_out}
  let chatCost = null; // 本会话合计（美元），null = 还没有数
  let chatPartial = false; // 有消息算不出费用 → 显示「约」
  let generating = false;
  let ac = null;

  ctx.onCleanup(() => { if (ac) ac.abort(); });

  const toMsg = (x) => ({
    id: x.id, role: x.role, content: x.content, created_at: x.created_at,
    cost_usd: x.cost_usd, cost_source: x.cost_source, tokens_in: x.tokens_in, tokens_out: x.tokens_out,
  });

  /* ---------- 渲染 ---------- */
  const lastAssistantIndex = () => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') return i;
    return -1;
  };

  function bubbleHtml(m) {
    if (m.streaming && !m.content) return `<span class="typing" role="status"><span class="sr-only">${esc(T.typing)}</span><i aria-hidden="true"></i><i aria-hidden="true"></i><i aria-hidden="true"></i></span>`;
    return formatMessage(m.content || (m.streaming ? '' : T.empty_reply), m.streaming, { paren: m.role === 'user' });
  }

  function msgNode(m) {
    const n = document.createElement('div');
    n.className = 'msg ' + (m.role === 'user' ? 'user' : 'ai');
    n.innerHTML = `${m.role === 'user' ? '' : whoAvatar()}
      <div class="msg-col">
        <div class="bubble${m.streaming && m.content ? ' caret' : ''}${m.error ? ' error' : ''}"></div>
        <div class="msg-note" hidden></div>
        <div class="msg-actions" hidden></div>
      </div>
      <button class="icon-btn msg-more" type="button" data-more aria-haspopup="menu" aria-label="${esc(zh.more)}" title="${esc(zh.more)}" hidden>${icon('more')}</button>`;
    m.node = n;
    updateNode(m);
    return n;
  }

  function updateNode(m) {
    const b = m.node.querySelector('.bubble');
    b.innerHTML = bubbleHtml(m);
    b.classList.toggle('caret', !!(m.streaming && m.content));
    b.classList.toggle('error', !!m.error);
    const note = m.node.querySelector('.msg-note');
    note.hidden = !m.note;
    note.textContent = m.note || '';
  }

  function updateActions() {
    const li = lastAssistantIndex();
    const last = messages.length - 1;
    messages.forEach((m, i) => {
      const a = m.node && m.node.querySelector('.msg-actions');
      if (!a) return;
      // 每条已保存的消息旁常驻「更多」按钮：读屏和键盘也能打开编辑 / 删除菜单
      m.node.querySelector('[data-more]').hidden = generating || m.id == null;
      const isLast = i === last && !generating && m.id != null && !isGone();
      if (isLast && m.role === 'assistant' && i === li && (i > 0 || isFile())) {
        a.hidden = false;
        a.innerHTML = `<button class="icon-btn" data-regen aria-label="${esc(T.regenerate)}" aria-describedby="regen-hint" title="${esc(zh.chatset.regen_hint)}">${icon('refresh')}</button>
        <button class="icon-btn" data-copy aria-label="${esc(zh.copy)}" title="${esc(zh.copy)}">${icon('copy')}</button>
        <span class="regen-hint" id="regen-hint">${esc(zh.chatset.regen_hint)}</span>`;
      } else if (isLast && m.role === 'user') {
        // 回复失败或停在出字前：最后一条是自己的消息，给一个「重新回复」
        a.hidden = false;
        a.innerHTML = `<button class="retry-btn" type="button" data-regen>${icon('refresh')}<span>${esc(T.retry_reply)}</span></button>`;
      } else {
        a.hidden = true;
        a.innerHTML = '';
      }
    });
  }

  // 长会话只为最后若干条建 DOM（messages 仍保留全部）。已渲染的消息总是数组末尾连续的一段：
  // 有 m.node 的就是已渲染的（含暂时移出页面、失败后会放回的），窗口按条数保存
  const renderedCount = () => messages.reduce((n, m) => n + (m.node ? 1 : 0), 0);

  function introHtml() {
    const F = zh.filechat;
    return isFile()
      ? `<div class="chat-intro">${fileAvatar('avatar', 72)}<b>${esc(target().name)}</b><span>${esc(fileInfo && fileInfo.instruction ? fileInfo.instruction : F.info_no_instruction)}</span>${fileInfo && fileInfo.mode === 'retrieval' ? `<span class="fc-intro-note">${esc(F.mode_retrieval)}</span>` : ''}</div>`
      : `<div class="chat-intro">${avatar(character.avatar, character.name, 'avatar', 72)}<b>${esc(character.name || '')}</b>${character.tagline ? `<span>${esc(character.tagline)}</span>` : ''}</div>`;
  }
  // 还有更早的消息没显示：列表顶部是「加载更早的消息」，全部显示完才换成开头简介
  const earlierHtml = (n) => `<div class="chat-more"><button class="btn btn-sm" type="button" data-earlier>${esc(T.load_earlier(n))}</button></div>`;

  /** 按窗口重绘；count 缺省 = 当前已显示条数（重绘不收回用户已展开的更早消息） */
  function renderAll(count = renderedCount()) {
    const start = windowStart(messages.length, clampShown(count, messages.length));
    for (let i = 0; i < start; i++) messages[i].node = null;
    list.innerHTML = start > 0 ? earlierHtml(start) : introHtml();
    const frag = document.createDocumentFragment();
    for (let i = start; i < messages.length; i++) frag.appendChild(msgNode(messages[i]));
    list.appendChild(frag);
    placeNotes(start, messages.length);
    updateActions();
    watchTop();
  }

  // 系统提示放回原来的位置；所在消息已被删除（删消息 / 从这里重新回复）时，挂到它之前最后一条还在的消息后面，
  // 设定修改仍然有效，不能让提示整条消失。所在消息还没加载出来时先不显示，等那段消息加载出来再一起放回。
  /** 插回锚点下标落在 [from, to) 的提示；from 为 0 时也包括挂在会话开头的 */
  function placeNotes(from, to) {
    for (const n of localNotes) {
      const idx = noteAnchorIndex(messages, n.afterId);
      if (!noteVisible(idx, from) || idx >= to) continue;
      const anchor = idx >= 0 ? messages[idx].node : list.querySelector('.chat-intro');
      if (!anchor) continue;
      let ref = anchor.nextSibling;
      while (ref && ref.classList && ref.classList.contains('sys-note')) ref = ref.nextSibling;
      list.insertBefore(sysNoteNode(n.text), ref);
    }
  }

  /* ---------- 加载更早的消息 ---------- */
  // 接近顶部（提前约 300px）自动加载上一批；按钮也能点、能用键盘操作
  const topObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => { if (entries.some((x) => x.isIntersecting)) loadEarlier(); }, { root: scroller, rootMargin: '300px 0px 0px 0px' })
    : null;
  ctx.onCleanup(() => { if (topObserver) topObserver.disconnect(); });
  // 每次重绘 / 加载后重新观察：加载完仍在顶部附近时会再收到一次通知，继续加载
  function watchTop() {
    if (!topObserver) return;
    topObserver.disconnect();
    const more = list.querySelector('.chat-more');
    if (more) topObserver.observe(more);
  }

  function loadEarlier() {
    if (!ctx.isActive()) return;
    const more = list.querySelector('.chat-more');
    const total = messages.length;
    const shown = renderedCount();
    const start = windowStart(total, shown);
    if (!more || start <= 0) return;
    const next = windowStart(total, loadMoreShown(total, shown, CHAT_PAGE));
    // 以原来最上面的内容为参照，插入后把它放回原来的屏幕位置，看到的内容不跳；
    // 不改「跟随最新」，也不触发置底
    const ref = (messages[start] && messages[start].node) || more.nextElementSibling;
    const before = ref ? ref.getBoundingClientRect().top : 0;
    const frag = document.createDocumentFragment();
    for (let i = next; i < start; i++) frag.appendChild(msgNode(messages[i]));
    more.after(frag);
    if (next > 0) more.querySelector('[data-earlier]').textContent = T.load_earlier(next);
    else { more.insertAdjacentHTML('afterend', introHtml()); more.remove(); }
    placeNotes(next, start);
    updateActions();
    if (ref && ref.isConnected) {
      const shift = ref.getBoundingClientRect().top - before;
      if (shift) scroller.scrollTop += shift;
    }
    watchTop();
  }

  function sysNoteNode(text) {
    const d = document.createElement('div');
    d.className = 'sys-note';
    d.innerHTML = `<span>${esc(text)}</span>`;
    return d;
  }

  function addSysNote(text, extra = {}) {
    let afterId = null;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].id != null) { afterId = messages[i].id; break; }
    localNotes.push({ afterId, text, ...extra });
    list.appendChild(sysNoteNode(text));
    viewport.keepLatest();
  }

  function append(m) {
    messages.push(m);
    list.appendChild(msgNode(m));
    return m;
  }

  // 流式更新合并到下一帧
  let rafPending = new Set();
  let updateFrame = null;
  ctx.onCleanup(() => {
    if (updateFrame !== null) cancelAnimationFrame(updateFrame);
    updateFrame = null;
    rafPending.clear();
  });
  function scheduleUpdate(m) {
    rafPending.add(m);
    if (updateFrame !== null) return;
    updateFrame = requestAnimationFrame(() => {
      updateFrame = null;
      const s = rafPending; rafPending = new Set();
      s.forEach(updateNode);
      viewport.keepLatest();
    });
  }

  /* ---------- 头部 ---------- */
  // 聊天对象：chub 角色（path）或自建卡（user_card_id，契约 §12.1）
  const target = () => chatTarget({ ...(chatInfo || {}), ...(fileInfo ? { kind: 'file', file: fileInfo } : {}), character });
  function drawHead() {
    const who = el.querySelector('[data-who]');
    const href = target().href;
    if (href) who.href = href; else who.removeAttribute('href');
    if (isFile()) {
      // 文件会话：名字 = 文件名，下面一个小标签，点开看文件列表与说明（契约 §17.1）
      const F = zh.filechat;
      const files = fileChatFiles({ file: fileInfo });
      const tag = files.length > 1 ? F.tag_files(files.length) : F.info_title;
      const first = (files.find((x) => x.ok !== false) || files[0] || {}).name || target().name;
      who.innerHTML = `${fileAvatar()}<div style="min-width:0"><div class="who-name">${esc(first)}</div><div class="who-sub"><span class="file-tag">${icon('file')}<span>${esc(tag)}</span></span></div></div>`;
      who.setAttribute('role', 'button');
      who.tabIndex = 0;
      who.setAttribute('aria-label', `${target().name}，${F.info_title}`);
      setTitle(target().name || F.title);
      drawModelChip();
      return;
    }
    who.removeAttribute('role');
    who.innerHTML = `${avatar(character.avatar, character.name)}<div style="min-width:0"><div class="who-name">${esc(character.name || '')}</div>${character.tagline ? `<div class="who-sub">${esc(character.tagline)}</div>` : ''}</div>`;
    setTitle(character.name || T.input);
    drawModelChip();
  }

  const modelChip = el.querySelector('[data-model]');
  function drawModelChip() {
    const name = chatModel && chatModel.name;
    modelChip.hidden = !name;
    modelChip.innerHTML = name ? `${icon('model')}<span>${esc(name)}</span>${icon('down', 'chev')}` : '';
    modelChip.setAttribute('aria-label', name ? `${T.model_label}：${name}，${T.menu_model}` : T.menu_model);
    modelChip.title = T.menu_model;
  }
  modelChip.onclick = () => { if (!isGone()) switchModel(); };

  /* ---------- 本会话花费（契约 §10.4） ---------- */
  const T_COST = zh.cost;
  const costEl = el.querySelector('[data-cost]');
  function drawCost() {
    const txt = fmtCost(chatCost, chatPartial);
    // 顶部金额默认隐藏，避免打断剧情；费用仍可在消息详情查看。
    costEl.hidden = true;
    costEl.textContent = txt ? T_COST.chat(txt) : '';
    costEl.title = txt ? T_COST.chat_label(txt) : '';
  }
  function setChatCost(chat) {
    if (!chat) return;
    if ('cost_usd' in chat) chatCost = numOrNull(chat.cost_usd);
    if ('cost_partial' in chat) chatPartial = !!chat.cost_partial;
    drawCost();
  }
  // 删除消息等改变合计的操作后，从服务端取最新合计（只更新花费，不重绘消息）
  async function refreshCost() {
    try {
      const r = await get(base);
      if (ctx.isActive() && !generating) setChatCost(r.chat);
    } catch { /* 花费刷新失败不打扰 */ }
  }

  /* ---------- 切换模型 ---------- */
  let switching = false;
  async function switchModel({ fromRefused = false } = {}) {
    if (switching) return;
    switching = true;
    try {
      let data;
      try { data = await loadModels(true); } catch (e) { toastError(e); return; }
      if (!ctx.isActive()) return;
      const curId = chatModel ? chatModel.id : null;
      const id = await pickModelSheet({ items: data.items, value: curId, title: zh.models.chat_title, hint: zh.models.chat_hint });
      if (id === undefined || id === null || !ctx.isActive()) return;
      const m = findModel(data.items, id);
      if (!m || (curId != null && String(m.id) === String(curId))) return;
      const r = await patch(base, { model_id: m.id });
      if (!ctx.isActive()) return;
      chatModel = (r && r.chat && r.chat.model) || { id: m.id, name: m.name };
      drawModelChip();
      const switchedText = T.model_switched(chatModel.name || m.name);
      addSysNote(switchedText);
      if (fromRefused && !generating) {
        // 从「拒答」错误条进来：顺手给一键「用新模型重新回复」，与消息下方的重新回复同一逻辑
        showNote({ kind: 'info', text: switchedText, action: { label: T.retry_with_new_model, run: () => { showNote(null); regenerate(); } } });
      } else if (lastNote && lastNote.action) {
        showNote(null);
      }
      store.homeCache = null;
    } catch (e) {
      toastError(e);
    } finally { switching = false; }
  }

  /* ---------- 会话事件（契约 §20.1：改设定写入会话事件，只在前端显示，不进提示词） ---------- */
  // 兼容 r.events 或 r.chat.events：[{kind|type, after_message_id|message_id, created_at}]
  function applyEvents(r) {
    const evs = Array.isArray(r && r.events) ? r.events : (r && r.chat && Array.isArray(r.chat.events) ? r.chat.events : null);
    if (!evs) return;
    const notes = [];
    for (const ev of evs) {
      const k = String((ev && (ev.kind || ev.type)) || '');
      if (!/override|settings/.test(k)) continue;
      const text = /reset|restore|delete|clear/.test(k) ? zh.chatset.restored : zh.chatset.updated;
      let afterId = ev.after_message_id ?? ev.message_id ?? null;
      if (afterId == null && ev.created_at) {
        // 没给位置：放在事件发生前的最后一条消息之后
        const t = Date.parse(ev.created_at);
        for (const m of messages) if (m.id != null && m.created_at && Date.parse(m.created_at) <= t) afterId = m.id;
      }
      notes.push({ afterId, text, ev: true });
    }
    // 服务端给了事件就以服务端为准（替换本地刚插的同类提示），其他本地提示（切换模型）保留
    localNotes = localNotes.filter((n) => !n.ev).concat(notes);
  }

  /* ---------- 加载 ---------- */
  async function load(keepScroll) {
    const r = await get(base);
    if (!ctx.isActive()) return;
    character = r.character || {};
    chatInfo = r.chat || null;
    fileInfo = r.file || (r.chat && r.chat.file) || null;
    chatModel = (r.chat && r.chat.model) || null;
    const prevTotal = messages.length;
    const prevShown = renderedCount();
    messages = (r.messages || []).map(toMsg);
    applyEvents(r);
    setChatCost(r.chat);
    drawHead();
    // 首次进入只显示最后一页；回复结束后的重新加载保持用户已展开的范围
    renderAll(keepScroll ? keepShown(prevShown, prevTotal, messages.length, CHAT_PAGE) : initialShown(messages.length, CHAT_PAGE));
    applyGone();
    if (!keepScroll || viewport.following) viewport.followLatest();
  }

  // 首次加载失败就停在错误页等「重试」，成功后才继续往下挂输入框等事件（否则重试成功也发不出消息）
  for (;;) {
    try {
      await load();
      break;
    } catch (e) {
      if (!ctx.isActive()) return;
      list.innerHTML = errorHtml(e.status === 404 ? zh.character.not_found : e.message);
      const b = list.querySelector('[data-retry]');
      if (!b || e.status === 404) return;
      await new Promise((resolve) => { b.onclick = resolve; });
      if (!ctx.isActive()) return;
      list.innerHTML = spinnerHtml();
    }
  }

  /* ---------- 输入框 ---------- */
  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 160) + 'px';
  };
  const updateSendBtn = () => {
    sendBtn.classList.toggle('stop', generating);
    sendBtn.innerHTML = generating ? icon('stop') : icon('send');
    sendBtn.setAttribute('aria-label', generating ? T.stop : T.send);
    sendBtn.disabled = !generating && (isGone() || !ta.value.trim());
  };
  ta.addEventListener('input', () => { autosize(); updateSendBtn(); if (!ta.value.trim()) pendingClip = null; });
  ctx.onCleanup(bindChatKeyboard(ta, { send: submit, isBusy: () => generating, isBlocked: isGone }));
  el.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (generating) { stop(); return; }
    submit();
  });

  function setGenerating(v) {
    generating = v;
    // 生成中让读屏等结果出来再播报，不读半截句子
    if (v) list.setAttribute('aria-busy', 'true'); else list.removeAttribute('aria-busy');
    updateSendBtn();
    updateActions();
  }

  let kickRun = null; // 上传页带过来、仍在生成的开场（store.kickoff）
  function stop() {
    if (ac) ac.abort();
    else if (kickRun) kickRun.abort();
  }

  /* ---------- 流式生成 ---------- */
  // 停止 / 出错后和服务端对齐。停止时服务端要等上游真正中断才保存部分内容，所以稍等再拉；
  // 若本地已显示了部分内容而服务端还没存好，再等一轮。
  async function resync(hadPartial) {
    const delays = hadPartial ? [800, 1500] : [800];
    for (let k = 0; k < delays.length; k++) {
      await sleep(delays[k]);
      if (!ctx.isActive() || generating) return;
      try {
        const r = await get(base);
        if (!ctx.isActive() || generating) return;
        const ms = r.messages || [];
        const lastRole = ms.length ? ms[ms.length - 1].role : '';
        if (lastRole === 'user' && hadPartial && k < delays.length - 1) continue;
        character = r.character || character;
        if (r.chat && 'model' in r.chat) chatModel = r.chat.model || null;
        const prevTotal = messages.length;
        const prevShown = renderedCount();
        messages = ms.map(toMsg);
        setChatCost(r.chat);
        drawHead();
        renderAll(keepShown(prevShown, prevTotal, messages.length, CHAT_PAGE));
        applyGone();
        updateSendBtn();
        viewport.keepLatest();
        return;
      } catch { return; }
    }
  }

  async function runStream(url, body, { userMsg, onFailBeforeStart } = {}) {
    showNote(null);
    const ai = append({ id: null, role: 'assistant', content: '', streaming: true });
    viewport.followLatest();
    setGenerating(true);
    const myAc = new AbortController();
    ac = myAc;
    let started = false;
    let streamError = null;
    let finished = false;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await postStream(url, body, {
            signal: myAc.signal,
            onEvent: (ev, d) => {
              if (ev === 'user') {
                started = true;
                if (userMsg && d.message) {
                  userMsg.id = d.message.id;
                  userMsg.content = d.message.content ?? userMsg.content;
                  if (userMsg.node) updateNode(userMsg);
                }
              } else if (ev === 'delta') {
                started = true;
                ai.content += (d && d.text) || '';
                scheduleUpdate(ai);
              } else if (ev === 'done') {
                started = true;
                finished = true;
                if (d && d.message) {
                  ai.id = d.message.id;
                  if (typeof d.message.content === 'string') ai.content = d.message.content;
                  for (const k of ['cost_usd', 'cost_source', 'tokens_in', 'tokens_out']) if (k in d.message) ai[k] = d.message[k];
                }
                // 回复完成即用服务端给的会话最新合计刷新头部
                if (d && 'chat_cost_usd' in d) {
                  chatCost = numOrNull(d.chat_cost_usd);
                  if (d.message && numOrNull(d.message.cost_usd) == null) chatPartial = true;
                  if ('chat_cost_partial' in d) chatPartial = !!d.chat_cost_partial;
                  drawCost();
                }
              } else if (ev === 'error') {
                // 流已建立后的错误：服务端已受理（重新生成时旧回复已删），不能按「未受理」回滚界面
                started = true;
                streamError = new ApiError((d && d.error) || T.failed, 0, (d && typeof d.code === 'string' && d.code) || '');
              }
            },
          });
          break;
        } catch (e) {
          // 刚停止就再发：服务端可能还在收尾上一条（409），静默等一下重试一次
          if (e instanceof ApiError && e.status === 409 && !started && attempt === 0 && !myAc.signal.aborted) {
            await sleep(600);
            if (myAc.signal.aborted) { const a = new Error('aborted'); a.name = 'AbortError'; throw a; }
            continue;
          }
          throw e;
        }
      }
      if (streamError) throw streamError;
      if (!finished && !ai.id) throw new ApiError(T.failed);
      ai.streaming = false;
      updateNode(ai);
    } catch (e) {
      ai.streaming = false;
      if (e && e.name === 'AbortError') {
        if (!ctx.isActive()) return;
        const hadPartial = !!ai.content;
        if (hadPartial) { ai.note = T.stopped; updateNode(ai); }
        else { ai.node.remove(); messages = messages.filter((m) => m !== ai); }
        showNote({ text: T.stopped, kind: 'info', action: needsKickoff() ? kickoffAction() : null });
        if (ac === myAc) ac = null;
        setGenerating(false);
        resync(hadPartial);
        return;
      }
      if (!started && onFailBeforeStart) {
        // 请求未被受理：撤回界面上的消息
        ai.node.remove();
        messages = messages.filter((m) => m !== ai);
        onFailBeforeStart(e);
      } else {
        if (!ai.content) {
          // 一个字都没生成（例如被拒答）：服务端不保存这条，移除占位气泡，只留输入框上方的错误条
          ai.node.remove();
          messages = messages.filter((m) => m !== ai);
          updateActions();
        } else {
          ai.error = true;
          ai.note = errText(e);
          updateNode(ai);
        }
        showNote({ text: errText(e), kind: 'error', action: failAction(e) });
        if (ac === myAc) ac = null;
        setGenerating(false);
        resync(false);
      }
    } finally {
      if (ac === myAc) ac = null;
      if (generating && ctx.isActive()) setGenerating(false);
      viewport.keepLatest();
      store.homeCache = null;
    }
  }

  async function submit() {
    const text = ta.value.trim();
    if (!text || generating || isGone()) return;
    ta.value = '';
    autosize();
    // 语音识别过：带上 clip_id 绑定到这条消息；发送的内容以输入框最终文字为准（契约 §18.5）
    const clip = pendingClip;
    pendingClip = null;
    const body = { content: text };
    if (clip != null) body.voice_clip_id = clip;
    const userMsg = append({ id: null, role: 'user', content: text });
    await runStream(base + '/messages', body, {
      userMsg,
      onFailBeforeStart: (e) => {
        userMsg.node.remove();
        messages = messages.filter((m) => m !== userMsg);
        if (!ta.value) { ta.value = text; autosize(); if (clip != null && pendingClip == null) pendingClip = clip; }
        updateSendBtn();
        updateActions();
        failNote(e);
      },
    });
    if (!isTouch() && viewport.following) ta.focus({ preventScroll: true });
  }

  async function regenerate() {
    if (generating || isGone()) return;
    if (!messages.length) {
      // 文件会话还没有开场（生成失败 / 被拒答 / 中断）：重新生成 AI 首条（契约 §17.1）
      if (!isFile()) return;
      await runStream(base + '/regenerate', {}, { onFailBeforeStart: (e) => { updateActions(); failNote(e); } });
      return;
    }
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === 'user') {
      // 最后一条是自己的消息（上次没回成功）：不删任何东西，直接让角色回复
      if (lastMsg.id == null) return;
      await runStream(base + '/regenerate', {}, {
        onFailBeforeStart: (e) => { updateActions(); failNote(e); },
      });
      return;
    }
    const li = lastAssistantIndex();
    if (li !== messages.length - 1 || (li < 1 && !(li === 0 && isFile()))) return;
    const old = messages[li];
    if (old.node) old.node.remove();
    messages.splice(li, 1);
    await runStream(base + '/regenerate', {}, {
      onFailBeforeStart: (e) => {
        messages.splice(li, 0, old);
        if (old.node) list.appendChild(old.node);
        updateActions();
        failNote(e);
      },
    });
  }

  /* ---------- 消息操作 ---------- */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = document.createElement('textarea');
      t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch { /* */ }
      t.remove();
    }
    toast(zh.copied);
  }

  // 气泡菜单里的一行小字：本条 $0.000123 · 输入 1,234 / 输出 56
  function msgCostNote(m) {
    if (m.role !== 'assistant') return '';
    const amt = fmtCost(m.cost_usd, m.cost_source === 'estimate');
    // 开场白等非模型生成的消息：没有金额且 token 都是 0 / 空 → 不显示花费行
    const hasTok = (Number(m.tokens_in) || 0) > 0 || (Number(m.tokens_out) || 0) > 0;
    if (!amt && !hasTok) return '';
    const parts = [amt ? T_COST.msg(amt) : T_COST.msg_unknown];
    if (hasTok) parts.push(T_COST.tokens(fmtInt(m.tokens_in), fmtInt(m.tokens_out)));
    return parts.join(' · ');
  }

  /** 编辑用户消息：返回 {action:'save'|'rewind', content} 或 null */
  function editUserDialog(value) {
    const C = zh.chatset;
    return new Promise((resolve) => {
      const s = openSheet(`
        <div class="sheet-title">${esc(C.edit_user_title)}</div>
        <div class="field"><textarea class="textarea" rows="6" maxlength="8000" aria-label="${esc(C.edit_user_title)}"></textarea></div>
        <p class="hint ss-hint">${esc(C.edit_rewind_hint)}</p>
        <div class="sheet-actions edit-actions">
          <button class="btn" type="button" data-a="save">${esc(C.edit_save)}</button>
          <button class="btn btn-primary" type="button" data-a="rewind">${icon('refresh')}<span>${esc(C.edit_rewind)}</span></button>
        </div>`, { label: C.edit_user_title, onClose: (v) => resolve(v && typeof v === 'object' ? v : null) });
      const ta = s.el.querySelector('textarea');
      ta.value = value || '';
      const go = (action) => {
        const content = ta.value;
        if (!content.trim()) { ta.focus(); return; }
        s.close({ action, content });
      };
      s.el.querySelector('[data-a="save"]').onclick = () => go('save');
      s.el.querySelector('[data-a="rewind"]').onclick = () => go('rewind');
      setTimeout(() => ta.focus(), 50);
    });
  }

  /** 保存并从这里重新回复（契约 §20.2）：POST /api/messages/:id/rewind {content} → SSE */
  async function rewindFrom(m, content) {
    if (generating || isGone() || m.id == null) return;
    const i = messages.indexOf(m);
    if (i < 0) return;
    const after = messages.slice(i + 1);
    if (after.length && !await confirmDialog(zh.chatset.rewind_confirm, { title: zh.chatset.rewind_confirm_title, danger: true, ok: zh.chatset.rewind_ok })) return false;
    if (!ctx.isActive() || generating) return;
    const oldContent = m.content;
    const oldNotes = localNotes.map((n) => ({ ...n }));
    // 先在界面上撤掉之后的消息、换上新文字；服务端没受理就原样恢复。
    // 之后的系统提示（本会话设定已更新 / 切换模型）仍然有效：改挂到这条消息后面，显示在新回复之前
    const afterIds = new Set(after.filter((x) => x.id != null).map((x) => String(x.id)));
    localNotes = localNotes.map((n) => (n.afterId != null && afterIds.has(String(n.afterId)) ? { ...n, afterId: m.id } : n));
    messages.splice(i + 1);
    after.forEach((x) => x.node && x.node.remove());
    m.content = content;
    updateNode(m);
    updateActions();
    await runStream('/api/messages/' + encodeURIComponent(m.id) + '/rewind', { content }, {
      userMsg: m,
      onFailBeforeStart: (e) => {
        m.content = oldContent;
        localNotes = oldNotes;
        messages.push(...after);
        renderAll();
        failNote(e);
      },
    });
    store.homeCache = null;
  }

  async function messageMenu(m) {
    if (generating || m.id == null) return;
    const v = await menu([
      { icon: 'copy', label: zh.copy, value: 'copy' },
      ...(isGone() ? [] : [{ icon: 'edit', label: zh.edit, value: 'edit' }]),
      ...(!isGone() && m.role === 'assistant' && messages[messages.length - 1] === m && (messages.indexOf(m) > 0 || isFile()) ? [{ icon: 'refresh', label: T.regenerate, value: 'regen' }] : []),
      { icon: 'trash', label: T.delete_title, value: 'delete', danger: true },
    ], { note: msgCostNote(m) });
    if (v === 'copy') copyText(m.content);
    else if (v === 'regen') regenerate();
    else if (v === 'edit' && m.role === 'user') {
      // 契约 §20.2：用户消息可「保存」或「保存并从这里重新回复」
      let res = null;
      let draft = m.content;
      for (;;) {
        res = await editUserDialog(draft);
        if (!res || !ctx.isActive()) return;
        if (res.action !== 'rewind') break;
        // 「从这里重新回复」的确认点了取消：改好的文字不丢，回到编辑框
        if (await rewindFrom(m, res.content) === false && ctx.isActive() && messages.includes(m)) { draft = res.content; continue; }
        return;
      }
      if (res.content === m.content) return;
      try {
        const r = await patch('/api/messages/' + encodeURIComponent(m.id), { content: res.content });
        m.content = (r && r.message && r.message.content) || res.content;
        updateNode(m);
      } catch (e) { toastError(e); }
    } else if (v === 'edit') {
      // AI 回复：只「保存」，作为后续上下文生效
      const nv = await editTextDialog({ title: T.edit_title, value: m.content });
      if (nv == null || nv.trim() === '' || nv === m.content) return;
      try {
        const r = await patch('/api/messages/' + encodeURIComponent(m.id), { content: nv });
        m.content = (r && r.message && r.message.content) || nv;
        updateNode(m);
      } catch (e) { toastError(e); }
    } else if (v === 'delete') {
      if (!await confirmDialog(T.delete_confirm, { title: T.delete_confirm_title, danger: true, ok: zh.delete })) return;
      try {
        await del('/api/messages/' + encodeURIComponent(m.id));
        const i = messages.indexOf(m);
        messages.splice(i);
        // 按条数重绘：挂在被删消息后的系统提示改挂到之前最后一条还在的消息后面，只放一次（不留孤立 / 重复的提示）；
        // 删的是窗口里第一条已渲染的消息时窗口会清空，此时至少显示一页，并停在最新的位置
        renderAll(shownAfterDelete(renderedCount(), messages.length, CHAT_PAGE));
        viewport.followLatest();
        store.homeCache = null;
        refreshCost();
      } catch (e) { toastError(e); }
    }
  }

  list.addEventListener('click', (e) => {
    if (e.target.closest('[data-earlier]')) { loadEarlier(); return; }
    const msgEl = e.target.closest('.msg');
    if (!msgEl) return;
    const m = messages.find((x) => x.node === msgEl);
    if (!m) return;
    if (e.target.closest('[data-regen]')) { regenerate(); return; }
    if (e.target.closest('[data-copy]')) { copyText(m.content); return; }
    if (e.target.closest('[data-more]')) { messageMenu(m); return; }
    // 点气泡打开菜单：鼠标 / 触屏的快捷方式
    if (e.target.closest('.bubble')) {
      const sel = window.getSelection && String(window.getSelection());
      if (sel) return; // 正在选字，不打断
      messageMenu(m);
    }
  });

  /* ---------- 本会话设定（契约 §20.1） ---------- */
  function openSettings() {
    openChatSettings({
      chatId, character, chatInfo,
      onSaved: ({ name, reset }) => {
        if (!ctx.isActive()) return;
        if (name && name !== character.name) { character = { ...character, name }; drawHead(); }
        addSysNote(reset ? zh.chatset.restored : zh.chatset.updated, { ev: true });
      },
    });
  }

  /* ---------- 头部菜单 ---------- */
  el.querySelector('[data-menu]').onclick = async () => {
    const gone = isGone();
    const v = await menu([
      ...(gone ? [] : [{ icon: 'model', label: T.menu_model, value: 'model' }]),
      ...(gone ? [] : [{ icon: 'edit', label: zh.chatset.menu, value: 'settings' }]),
      ...(isFile() ? [{ icon: 'file', label: zh.filechat.info_title, value: 'fileinfo' }] : []),
      ...(target().href ? [{ icon: 'user', label: T.menu_profile, value: 'profile' }] : []),
      ...(target().body ? [{ icon: 'plus', label: T.menu_new, value: 'new' }] : []),
      { icon: 'trash', label: T.menu_delete, value: 'delete', danger: true },
    ], { title: character.name, note: gone ? T.unavailable : '' });
    if (v === 'model' && !gone) switchModel();
    else if (v === 'settings' && !gone) openSettings();
    else if (v === 'fileinfo') openInfo();
    else if (v === 'profile' && target().href) navigate(target().href);
    else if (v === 'new' && target().body) {
      try {
        if (generating) stop();
        const r = await post('/api/chats', target().body);
        store.homeCache = null;
        navigate('#/chat/' + encodeURIComponent(r.chat.id), true);
      } catch (e) { toastError(e); }
    } else if (v === 'delete') {
      if (!await confirmDialog(zh.chats.delete_confirm, { title: zh.chats.delete_title, danger: true, ok: zh.delete })) return;
      try {
        if (generating) stop();
        await del(base);
        store.homeCache = null;
        toast(zh.chats.deleted);
        navigate('#/chats', true);
      } catch (e) { toastError(e); }
    }
  };

  /* ---------- 文件会话：点头部看文件资料 ---------- */
  const whoEl = el.querySelector('[data-who]');
  const openInfo = () => { if (isFile()) openFileInfo({ chatId, file: fileInfo, textUrl: base + '/file-text' }); };
  whoEl.addEventListener('click', (e) => { if (isFile()) { e.preventDefault(); openInfo(); } });
  whoEl.addEventListener('keydown', (e) => { if (isFile() && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openInfo(); } });

  /* ---------- 语音输入（契约 §18） ---------- */
  const voice = mountVoice({
    composer: el.querySelector('form'),
    inner: composerInner,
    sendBtn,
    chatId,
    isBlocked: () => isGone(),
    autoSend: () => !!(store.me && (store.me.voice_auto_send === true || store.me.voice_auto_send === 1)),
    onCleanup: ctx.onCleanup,
    onText: ({ text, clipId, auto }) => {
      if (!ctx.isActive() || isGone()) return;
      const had = ta.value.trim();
      // 输入框里已有草稿：接在后面，不自动发送，交给用户确认
      ta.value = had ? ta.value.replace(/\s+$/, '') + text : text;
      if (clipId != null) pendingClip = clipId;
      autosize();
      updateSendBtn();
      if (auto && !had && !generating) { submit(); return; }
      ta.focus({ preventScroll: true });
      try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch { /* */ }
    },
  });
  if (isGone()) voice.setDisabled(true);

  // 文件会话的 AI 首条（契约 §17.1）：上传页收到会话 id 就跳过来，开场的流仍由上传页在后台读，
  // 进度通过 store.kickoff 交给这里实时显示；失败 / 被拒答 / 中断就在输入框上方给「重新生成开场」
  const kick = store.kickoff && String(store.kickoff.chatId) === String(chatId) ? store.kickoff : null;
  if (isFile() && !isGone() && !messages.some((m) => m.role === 'assistant')) {
    if (kick && kick.state === 'running') attachKickoff(kick);
    else if (kick && kick.state === 'done') { store.kickoff = null; load(true).then(updateSendBtn).catch(() => {}); }
    else if (kick && (kick.state === 'error' || kick.state === 'aborted')) {
      store.kickoff = null;
      if (kick.state === 'error') showNote({ text: errText(kick.error), kind: 'error', action: failAction(kick.error) });
      else showNote({ text: T.stopped, kind: 'info', action: kickoffAction() });
      resync(!!kick.text);
    } else waitKickoff();
  } else if (kick && kick.state !== 'running') store.kickoff = null;

  function attachKickoff(k) {
    const ph = append({ id: null, role: 'assistant', content: k.text || '', streaming: true, note: k.text ? '' : zh.filechat.reading });
    kickRun = k;
    setGenerating(true);
    viewport.followLatest();
    const finish = () => {
      k.listeners.delete(onKick);
      if (kickRun === k) kickRun = null;
      if (store.kickoff === k) store.kickoff = null;
      ph.streaming = false;
      if (ctx.isActive()) setGenerating(false);
    };
    const onKick = (type) => {
      if (!ctx.isActive()) { k.listeners.delete(onKick); return; }
      if (type === 'delta') {
        ph.content = k.text;
        ph.note = '';
        scheduleUpdate(ph);
        return;
      }
      finish();
      if (type === 'done') {
        load(true).then(updateSendBtn).catch(() => { updateNode(ph); updateActions(); });
        return;
      }
      const hadPartial = !!ph.content;
      if (!hadPartial) { ph.node.remove(); messages = messages.filter((m) => m !== ph); }
      else { ph.error = type === 'error'; ph.note = type === 'error' ? errText(k.error) : T.stopped; updateNode(ph); }
      updateActions();
      if (type === 'error') showNote({ text: errText(k.error), kind: 'error', action: failAction(k.error) });
      else showNote({ text: T.stopped, kind: 'info', action: needsKickoff() ? kickoffAction() : null });
      resync(hadPartial);
    };
    k.listeners.add(onKick);
    // 离开聊天页不停止开场生成（回来时服务端已保存），只是不再显示
    ctx.onCleanup(() => { k.listeners.delete(onKick); if (kickRun === k) kickRun = null; });
  }

  // 刷新 / 稍后再进来时不知道开场还在不在生成：如实提示并给「重新生成开场」，同时在后台查几次，出来了就显示
  function waitKickoff() {
    const note = { text: zh.filechat.kickoff_missing, kind: 'info', action: kickoffAction() };
    showNote(note);
    (async () => {
      for (let i = 0; i < 30; i++) {
        await sleep(2000);
        if (!ctx.isActive() || generating || messages.some((m) => m.role === 'assistant' || m.role === 'user')) return;
        try {
          const r = await get(base);
          if (!ctx.isActive() || generating || messages.some((m) => m.role === 'assistant' || m.role === 'user')) return;
          if ((r.messages || []).some((m) => m.role === 'assistant')) {
            await load(true);
            if (lastNote === note) showNote(null);
            updateSendBtn();
            return;
          }
        } catch { /* 下一轮再试 */ }
      }
    })();
  }

  updateSendBtn();
  if (!isTouch() && !isGone()) ta.focus();
}
