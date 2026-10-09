// 区分触屏电脑和手机虚拟键盘。中文候选确认回车不能发送消息。
export function desktopKeyboard(environment = globalThis) {
  if (typeof environment.matchMedia !== 'function') return true;
  return environment.matchMedia('(any-pointer: fine)').matches || !environment.matchMedia('(pointer: coarse)').matches;
}

export function bindChatKeyboard(textarea, { send, isBusy = () => false, isBlocked = () => false, environment = globalThis, now = Date.now }) {
  let composing = false, compositionGuardUntil = 0;
  const start = () => { composing = true; compositionGuardUntil = 0; };
  const end = () => { composing = false; compositionGuardUntil = now() + 80; };
  const keyup = (e) => { if (e.key === 'Enter') compositionGuardUntil = 0; };
  const keydown = (e) => {
    if (e.key !== 'Enter') { if (!composing) compositionGuardUntil = 0; return; }
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || composing || e.isComposing || e.keyCode === 229) return;
    if (compositionGuardUntil > now()) return;
    if (!desktopKeyboard(environment)) return;
    e.preventDefault();
    if (e.repeat || isBusy() || isBlocked() || !String(textarea.value || '').trim()) return;
    send();
  };
  const listeners = { compositionstart: start, compositionend: end, keyup, keydown };
  for (const [type, fn] of Object.entries(listeners)) textarea.addEventListener(type, fn);
  return () => { for (const [type, fn] of Object.entries(listeners)) textarea.removeEventListener(type, fn); };
}
