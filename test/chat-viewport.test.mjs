import test from 'node:test';
import assert from 'node:assert/strict';

// Node 没有布局与软键盘：这里只替代几何和帧调度，事件仍经过生产模块。
// 浏览器集成测试另用隔离账号；本文件不能证明真实 iOS 键盘行为。
async function setup() {
  const api = await import('../public/js/chat-viewport.js').catch(() => null);
  assert.ok(api, '聊天视口行为尚未实现');
  const environment = new EventTarget();
  const viewport = new EventTarget();
  Object.assign(viewport, { height: 812, offsetTop: 0, scale: 1 });
  environment.visualViewport = viewport;
  const frames = new Map();
  let frameId = 0;
  environment.requestAnimationFrame = (run) => { frames.set(++frameId, run); return frameId; };
  environment.cancelAnimationFrame = (id) => frames.delete(id);
  let observer;
  environment.ResizeObserver = class {
    constructor(run) { this.run = run; observer = this; }
    observe() {}
    disconnect() { this.run = null; }
  };
  const scroller = new EventTarget();
  Object.assign(scroller, { scrollHeight: 2400, clientHeight: 672, scrollTop: 1728 });
  scroller.scrollTo = ({ top }) => {
    scroller.scrollTop = Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight));
    scroller.dispatchEvent(new Event('scroll'));
  };
  const chat = { style: {} };
  Object.defineProperty(chat.style, 'height', {
    get() { return this.value; },
    set(value) { this.value = value; scroller.clientHeight = Number.parseFloat(value) - 140; },
  });
  const input = new EventTarget();
  const jumpButton = new EventTarget();
  jumpButton.hidden = true;
  const controller = api.bindChatViewport({ chat, scroller, input, jumpButton, environment, useVisualViewport: true });
  function fire(target, type, fields = {}) {
    const e = new Event(type);
    for (const [key, value] of Object.entries(fields)) Object.defineProperty(e, key, { value });
    target.dispatchEvent(e);
  }
  function flush() {
    const queued = [...frames.values()];
    frames.clear();
    for (const run of queued) run();
  }
  function history(top = 600) {
    fire(scroller, 'wheel', { deltaY: -300 });
    scroller.scrollTop = top;
    fire(scroller, 'scroll');
  }
  flush();
  return { environment, viewport, chat, scroller, input, jumpButton, controller, fire, flush, frames, history,
    resized() { observer?.run?.(); },
    gap() { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight; },
  };
}

test('聚焦输入框恢复最新消息，键盘缩小与平移后仍保持底部', async () => {
  const s = await setup();
  s.history();
  assert.equal(s.controller.following, false);
  s.fire(s.input, 'focus');
  s.viewport.height = 430;
  s.viewport.offsetTop = 110;
  s.fire(s.viewport, 'resize');
  s.fire(s.viewport, 'scroll');
  s.flush();
  assert.equal(s.chat.style.height, '430px');
  assert.equal(s.chat.style.top, '110px');
  assert.equal(s.gap(), 0);
  assert.equal(s.jumpButton.hidden, true);
  s.controller.cleanup();
});

test('键盘几何改变及浏览器自动滚动不能取消此前的置底意图', async () => {
  const s = await setup();
  // 浏览器可先改变滚动区几何并发出 scroll，然后才通知 visualViewport。
  s.scroller.clientHeight = 290;
  s.scroller.scrollTop -= 200;
  s.fire(s.scroller, 'scroll');
  s.viewport.height = 430;
  s.fire(s.viewport, 'resize');
  s.flush();
  assert.equal(s.controller.following, true);
  assert.equal(s.gap(), 0);
  s.scroller.scrollHeight += 300;
  s.controller.keepLatest();
  assert.equal(s.gap(), 0, '后续流式消息继续跟随');
  s.controller.cleanup();
});

test('用户上滑阅读历史时，键盘变化及新增消息保留阅读位置', async () => {
  const s = await setup();
  s.fire(s.scroller, 'touchstart', { touches: [{ clientY: 100 }] });
  s.fire(s.scroller, 'touchmove', { touches: [{ clientY: 200 }] });
  s.scroller.scrollTop = 600;
  s.fire(s.scroller, 'scroll');
  s.fire(s.scroller, 'touchend');
  s.viewport.height = 430;
  s.fire(s.viewport, 'resize');
  s.scroller.scrollHeight += 400;
  s.controller.keepLatest();
  s.flush();
  assert.equal(s.scroller.scrollTop, 600);
  assert.equal(s.controller.following, false);
  assert.equal(s.jumpButton.hidden, false);
  s.controller.cleanup();
});

test('明确发送或再次点击已聚焦输入框重新跟随，延迟布局后仍置底', async () => {
  const s = await setup();
  s.history();
  s.scroller.scrollHeight += 100;
  s.controller.followLatest();
  assert.equal(s.gap(), 0);
  s.scroller.clientHeight -= 120;
  s.resized();
  s.flush();
  assert.equal(s.gap(), 0);
  s.history();
  s.fire(s.input, 'pointerdown');
  s.flush();
  assert.equal(s.gap(), 0, '已经聚焦时也可点击输入框恢复底部');
  s.controller.cleanup();
});

test('输入框增长和窗口缩放保持跟随，读取历史时仅更新布局', async () => {
  const s = await setup();
  s.scroller.clientHeight -= 80;
  s.fire(s.input, 'input');
  s.flush();
  assert.equal(s.gap(), 0);
  s.history();
  s.viewport.height = 700;
  s.fire(s.environment, 'resize');
  s.flush();
  assert.equal(s.chat.style.height, '700px');
  assert.equal(s.scroller.scrollTop, 600);
  s.controller.cleanup();
});

test('拖动滚动条或滚动键阅读历史，回到底部与跳转按钮可恢复跟随', async () => {
  const s = await setup();
  s.fire(s.scroller, 'pointerdown', { clientY: 200 });
  s.scroller.scrollTop = 800;
  s.fire(s.scroller, 'scroll');
  assert.equal(s.controller.following, false);
  s.fire(s.scroller, 'keydown', { key: 'End' });
  s.scroller.scrollTop = s.scroller.scrollHeight - s.scroller.clientHeight;
  s.fire(s.scroller, 'scroll');
  assert.equal(s.controller.following, true);
  s.history();
  s.fire(s.jumpButton, 'click');
  assert.equal(s.gap(), 0);
  assert.equal(s.jumpButton.hidden, true);
  s.scroller.scrollHeight = 200;
  s.scroller.scrollTop = 0;
  s.fire(s.scroller, 'wheel', { deltaY: -100 });
  assert.equal(s.controller.following, true, '消息不足一屏时不能因向上滚动丢失跟随');
  s.controller.cleanup();
});

test('手机双指缩放与流式更新保留位置，缩回后恢复原跟随意图', async () => {
  const s = await setup();
  const height = s.chat.style.height;
  const top = s.scroller.scrollTop;
  s.viewport.scale = 2;
  s.viewport.height = 406;
  s.fire(s.viewport, 'resize');
  s.scroller.scrollHeight += 300;
  s.controller.keepLatest();
  s.flush();
  assert.equal(s.chat.style.height, height);
  assert.equal(s.scroller.scrollTop, top, '放大期间新增消息不能强迫置底');
  assert.equal(s.controller.following, true);
  s.viewport.scale = 1;
  s.viewport.height = 812;
  s.fire(s.viewport, 'resize');
  s.flush();
  assert.equal(s.gap(), 0, '缩回后继续先前的跟随');
  s.fire(s.scroller, 'touchstart', { touches: [{ clientY: 100 }, { clientY: 200 }] });
  s.fire(s.scroller, 'touchmove', { touches: [{ clientY: 150 }, { clientY: 250 }] });
  assert.equal(s.controller.following, true, '双指手势不应被当作单指阅读历史');
  s.history();
  s.viewport.scale = 2;
  s.viewport.height = 406;
  s.fire(s.viewport, 'resize');
  s.scroller.scrollHeight += 300;
  s.controller.keepLatest();
  s.flush();
  s.viewport.scale = 1;
  s.viewport.height = 812;
  s.fire(s.viewport, 'resize');
  s.flush();
  assert.equal(s.scroller.scrollTop, 600, '原来读历史时缩回也保留阅读位置');
  assert.equal(s.controller.following, false);
  s.controller.cleanup();
});

test('离页移除所有行为并取消待执行帧，后续事件不会移动聊天区', async () => {
  const s = await setup();
  s.history();
  s.viewport.height = 430;
  s.fire(s.viewport, 'resize');
  s.controller.cleanup();
  assert.equal(s.frames.size, 0);
  s.fire(s.input, 'focus');
  s.fire(s.input, 'input');
  s.fire(s.jumpButton, 'click');
  s.fire(s.viewport, 'resize');
  s.fire(s.environment, 'resize');
  s.resized();
  s.controller.followLatest();
  s.flush();
  assert.equal(s.scroller.scrollTop, 600);
  assert.equal(s.chat.style.height, '812px');
  assert.equal(s.frames.size, 0);
});
