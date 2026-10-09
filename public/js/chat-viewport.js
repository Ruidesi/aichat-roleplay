// 将「跟随最新消息」作为用户意图保存，避免软键盘产生的 scroll 改写它。
export function bindChatViewport({ chat, scroller, input, jumpButton, environment = window, useVisualViewport = true }) {
  const viewport = useVisualViewport ? environment.visualViewport : null;
  const listeners = [];
  let following = true;
  let userScroll = false;
  let touchY = null;
  let pointerDown = false;
  let frame = null;
  let active = true;
  const listen = (target, type, run, options) => {
    target.addEventListener(type, run, options);
    listeners.push(() => target.removeEventListener(type, run, options));
  };
  const showJump = () => { jumpButton.hidden = following; };
  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2;
  const zoomed = () => viewport && viewport.scale && viewport.scale !== 1;
  const scrollBottom = (smooth = false) => {
    if (zoomed()) return;
    userScroll = false;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };
  function syncLayout() {
    frame = null;
    if (!active || zoomed()) return;
    if (viewport && viewport.height > 0) {
      const height = viewport.height + 'px';
      const top = viewport.offsetTop + 'px';
      if (chat.style.height !== height) chat.style.height = height;
      if (chat.style.top !== top) chat.style.top = top;
      chat.style.bottom = 'auto';
    }
    if (following) scrollBottom();
  }
  function scheduleLayout() {
    if (active && frame === null) frame = environment.requestAnimationFrame(syncLayout);
  }
  function geometryChanged() {
    userScroll = false;
    scheduleLayout();
  }
  function followLatest(smooth = false) {
    if (!active) return;
    following = true;
    showJump();
    scrollBottom(smooth);
    if (!smooth) scheduleLayout();
  }
  function keepLatest() {
    if (!active || !following) return;
    scrollBottom();
    scheduleLayout();
  }
  function readHistory() {
    if (scroller.scrollTop <= 0) return;
    following = false;
    showJump();
  }
  listen(scroller, 'scroll', () => {
    // 程序置底、浏览器聚焦平移和布局变化也会发 scroll；仅用户滚动可取消跟随。
    if (!userScroll || zoomed()) return;
    following = atBottom();
    if (following) userScroll = false;
    showJump();
  }, { passive: true });
  listen(scroller, 'wheel', (e) => {
    userScroll = true;
    if (e.deltaY < 0) readHistory();
  }, { passive: true });
  listen(scroller, 'touchstart', (e) => {
    userScroll = e.touches.length === 1;
    touchY = userScroll ? e.touches[0]?.clientY ?? null : null;
  }, { passive: true });
  listen(scroller, 'touchmove', (e) => {
    if (e.touches.length !== 1) { userScroll = false; touchY = null; return; }
    userScroll = true;
    const y = e.touches[0]?.clientY;
    if (y != null && touchY != null && y > touchY) readHistory();
    touchY = y ?? null;
  }, { passive: true });
  listen(scroller, 'touchend', () => { touchY = null; }, { passive: true });
  listen(scroller, 'touchcancel', () => { touchY = null; }, { passive: true });
  listen(scroller, 'pointerdown', () => { pointerDown = true; userScroll = true; }, { passive: true });
  listen(scroller, 'pointermove', () => { if (pointerDown) userScroll = true; }, { passive: true });
  listen(environment, 'pointerup', () => { pointerDown = false; }, { passive: true });
  listen(environment, 'pointercancel', () => { pointerDown = false; }, { passive: true });
  listen(scroller, 'keydown', (e) => {
    if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) return;
    userScroll = true;
    if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) readHistory();
  });
  listen(input, 'focus', () => followLatest());
  listen(input, 'pointerdown', () => followLatest());
  listen(input, 'click', () => followLatest());
  listen(input, 'input', geometryChanged);
  listen(jumpButton, 'click', () => followLatest(true));
  listen(environment, 'resize', geometryChanged);
  if (viewport) {
    listen(viewport, 'resize', geometryChanged);
    listen(viewport, 'scroll', geometryChanged);
  }
  // 横幅、语音面板、输入框增高都会改变消息区；不要等待下一段流式回复。
  const observer = environment.ResizeObserver ? new environment.ResizeObserver(geometryChanged) : null;
  observer?.observe(scroller);
  observer?.observe(input);
  scheduleLayout();
  return {
    get following() { return following; },
    followLatest,
    keepLatest,
    cleanup() {
      active = false;
      if (frame !== null) environment.cancelAnimationFrame(frame);
      frame = null;
      observer?.disconnect();
      listeners.forEach((off) => off());
    },
  };
}
