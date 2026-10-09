// 全局状态（当前用户、站点名称）
import { zh } from '/i18n/zh.js';

export const store = {
  me: null,
  siteName: zh.site_name,
  homeCache: null, // 首页数据缓存，返回首页时先显示
  modelsCache: null, // GET /api/models 短缓存 {at, data}
  kickoff: null, // 文件会话开场生成中（上传页后台读流，聊天页显示）{chatId, state, text, error, listeners, abort}
};
