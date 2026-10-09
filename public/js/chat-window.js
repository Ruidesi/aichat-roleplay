// 聊天记录渲染窗口：消息数组保留全部，只有最后 shown 条建 DOM（纯函数，不依赖 DOM，前端与测试共用）。
// 窗口按「已显示条数」保存而不是下标：新增消息自动计入，删除 / 截断后夹在 [0, 总数] 内。

/** 聊天页每批条数 */
export const CHAT_PAGE = 30;

const count = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** 把显示条数夹在 [0, total] 内 */
export function clampShown(shown, total) {
  return Math.min(count(shown), count(total));
}

/** 首次进入会话显示的条数 */
export function initialShown(total, page = CHAT_PAGE) {
  return clampShown(page, total);
}

/** 第一条已渲染消息的下标（= 还没渲染的更早消息条数） */
export function windowStart(total, shown) {
  return count(total) - clampShown(shown, total);
}

/** 加载更早一批后的显示条数 */
export function loadMoreShown(total, shown, page = CHAT_PAGE) {
  return clampShown(clampShown(shown, total) + count(page), total);
}

/**
 * 重新加载（回复结束、对齐服务端）后的显示条数：已展开的范围不收回，
 * 末尾新增的消息计入窗口；消息变少时夹到总数；不少于一页。
 */
export function keepShown(prevShown, prevTotal, total, page = CHAT_PAGE) {
  const added = Math.max(0, count(total) - count(prevTotal));
  return Math.max(clampShown(count(prevShown) + added, total), initialShown(total, page));
}

/** 删除一条消息（连同之后的全部）后的显示条数：剩下的已渲染条数，窗口被删空时至少一页 */
export function shownAfterDelete(shownLeft, total, page = CHAT_PAGE) {
  return Math.max(clampShown(shownLeft, total), initialShown(total, page));
}

/**
 * 系统提示挂在哪条消息后面：精确匹配的消息下标；那条已被删除时退到它之前最后一条还在的消息；
 * 都没有返回 -1（挂在会话开头）。messages 只需要有 id。
 */
export function noteAnchorIndex(messages, afterId) {
  if (afterId == null || !Array.isArray(messages)) return -1;
  const key = String(afterId);
  for (let i = 0; i < messages.length; i++) if (messages[i] && messages[i].id != null && String(messages[i].id) === key) return i;
  const k = Number(afterId);
  if (!Number.isFinite(k)) return -1;
  let best = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m && m.id != null && Number(m.id) < k) best = i;
  }
  return best;
}

/** 提示现在能不能显示：锚点消息已渲染；挂在会话开头的要等全部消息显示完（开头简介出现）才显示 */
export function noteVisible(anchorIndex, start) {
  const s = count(start);
  return anchorIndex < 0 ? s === 0 : anchorIndex >= s;
}
