import test from 'node:test';
import assert from 'node:assert/strict';

async function api() {
  const m = await import('../public/js/chat-keyboard.js').catch(() => null);
  assert.ok(m, '聊天键盘行为模块尚未实现');
  return m;
}
const env = (fine, coarse) => ({ matchMedia: (q) => ({ matches: q.includes('fine') ? fine : coarse }) });
function event(type, fields = {}) {
  const e = new Event(type, { cancelable: true });
  for (const [k, v] of Object.entries(fields)) Object.defineProperty(e, k, { value: v });
  return e;
}
async function setup(device = env(true, false)) {
  const { bindChatKeyboard } = await api();
  const ta = new EventTarget();
  ta.value = '你好';
  let sent = 0, busy = false, time = 1000;
  const off = bindChatKeyboard(ta, { send: () => { sent++; }, isBusy: () => busy, environment: device, now: () => time });
  return { ta, off, sent: () => sent, busy: (v) => { busy = v; }, time: (v) => { time = v; }, fire(type = 'keydown', fields = {}) { const e = event(type, { key: 'Enter', ...fields }); ta.dispatchEvent(e); return e; } };
}

test('桌面Enter发送一次并阻止换行；Shift+Enter保留原生换行', async () => {
  const s = await setup();
  assert.equal(s.fire().defaultPrevented, true);
  assert.equal(s.sent(), 1);
  assert.equal(s.fire('keydown', { shiftKey: true }).defaultPrevented, false);
  assert.equal(s.sent(), 1);
  s.off();
  s.fire();
  assert.equal(s.sent(), 1, '离页解绑事件');
});

test('触屏电脑有精细指针仍可Enter发送，手机虚拟回车保留换行', async () => {
  const laptop = await setup(env(true, true));
  laptop.fire();
  assert.equal(laptop.sent(), 1);
  const phone = await setup(env(false, true));
  assert.equal(phone.fire().defaultPrevented, false);
  assert.equal(phone.sent(), 0);
});

test('手机Tab或修饰键之后断开物理键盘，虚拟Enter持续保留换行', async () => {
  const s = await setup(env(false, true));
  s.fire('keydown', { key: 'Tab', code: 'Tab' });
  s.fire('keydown', { key: 'Shift', code: 'ShiftLeft' });
  s.fire('keydown', { shiftKey: true });
  assert.equal(s.sent(), 0);
  assert.equal(s.fire('keydown', { code: '' }).defaultPrevented, false);
  assert.equal(s.sent(), 0);
});

test('中文输入法组合、keyCode229、compositionend尾随回车均不得误发送', async () => {
  const s = await setup();
  s.fire('compositionstart', { key: undefined });
  assert.equal(s.fire().defaultPrevented, false);
  s.fire('compositionend', { key: undefined });
  assert.equal(s.fire('keydown', { isComposing: true }).defaultPrevented, false);
  assert.equal(s.fire('keydown', { keyCode: 229 }).defaultPrevented, false);
  assert.equal(s.fire().defaultPrevented, false);
  assert.equal(s.sent(), 0);
  s.fire('keyup');
  s.fire();
  assert.equal(s.sent(), 1, '下一次明确Enter可以发送');
});

test('输入法结束未产生尾随回车时，短时保护到期后正常发送', async () => {
  const s = await setup();
  s.fire('compositionstart');
  s.fire('compositionend');
  s.time(1200);
  s.fire();
  assert.equal(s.sent(), 1);
});

test('生成中、空白输入与长按重复回车不发送，其他修饰组合不劫持', async () => {
  const s = await setup();
  s.busy(true);
  s.fire();
  assert.equal(s.sent(), 0);
  s.busy(false);
  s.ta.value = ' \n ';
  s.fire();
  assert.equal(s.sent(), 0);
  s.ta.value = '你好';
  s.fire('keydown', { repeat: true });
  assert.equal(s.sent(), 0);
  assert.equal(s.fire('keydown', { ctrlKey: true }).defaultPrevented, false);
  assert.equal(s.fire('keydown', { metaKey: true }).defaultPrevented, false);
});
