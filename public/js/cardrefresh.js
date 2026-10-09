// 列表里还在翻译的 chub 卡（契约 §19.2：接口先返回已有译文，缺的标 translating:true，前端稍后自动刷新一次）
import { cardHtml } from '/js/ui.js';

export const REFRESH_DELAY_MS = 8000;

export const hasTranslating = (items) => Array.isArray(items) && items.some((x) => x && x.translating === true);

/** 按 path 把容器里的卡片换成新数据（只换已在页面上的卡，不改顺序、不动滚动位置） */
export function patchCards(container, items) {
  if (!container || !Array.isArray(items)) return 0;
  let n = 0;
  for (const it of items) {
    if (!it || !it.path) continue;
    const sel = `.card[data-path="${CSS.escape(String(it.path))}"]`;
    container.querySelectorAll(sel).forEach((el) => {
      const source = it.source === 'remote' ? 'remote' : 'local';
      if ((el.dataset.source || 'local') !== source) return;
      const tpl = document.createElement('template');
      tpl.innerHTML = cardHtml(it).trim();
      const fresh = tpl.content.firstElementChild;
      if (fresh) { el.replaceWith(fresh); n++; }
    });
  }
  return n;
}

/**
 * items 里有 translating 时，延时调用 refetch() 一次，拿到的新卡按 path 替换到 container 里。
 * refetch 返回卡片数组（或 Promise）。返回取消函数。
 */
export function refreshOnce(ctx, container, items, refetch, delay = REFRESH_DELAY_MS) {
  if (!hasTranslating(items)) return () => {};
  let cancelled = false;
  const t = setTimeout(async () => {
    if (cancelled || !ctx.isActive()) return;
    try {
      const fresh = await refetch();
      if (cancelled || !ctx.isActive()) return;
      patchCards(container, fresh);
    } catch { /* 刷新失败不打扰，保持原文 */ }
  }, delay);
  const cancel = () => { cancelled = true; clearTimeout(t); };
  ctx.onCleanup(cancel);
  return cancel;
}
