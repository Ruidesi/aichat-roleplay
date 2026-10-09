// 会话消费（契约 §10.2 / §10.3）：一次回复的计费落库字段、系统花费（翻译 / 测试）、会话合计。
import { getSettings } from './db.mjs';
import { costOf, estimateTokens, reasoningBilledSeparately, round6 } from './pricing.mjs';
import { nowIso } from './util.mjs';

/** 上游给了 usage：llm 明确标了 usage:true；或没标（旧接口 / 测试替身）但 token 数非零。 */
const hasUsage = (r) => !!r && (r.usage === true || (r.usage === undefined && ((r.tokens_in || 0) > 0 || (r.tokens_out || 0) > 0)));

export function createCostService({ db }) {
  const rate = () => getSettings(db).cny_to_usd;

  /**
   * llm 返回（或错误对象）→ 要写进 messages 的计费字段。
   * 上游给了 usage 就照算；没给（停止 / 中断 / 上游不报）就按字数粗估：输出 = 已生成文本，输入 = 本次发出的提示词，标 estimate。
   * @param {object|null} m  模型行
   * @param {object} r      streamChat 的结果或错误对象（usage、tokens_*、cost_ticks）
   * @param {{text?:string, promptText?:string, at?:string}} o  at = 计费时刻（消息 created_at；DeepSeek 分时计价用）
   */
  function forReply(m, r, { text = '', promptText = '', at } = {}) {
    let usage;
    let usageEstimated = false;
    if (hasUsage(r)) {
      usage = {
        tokens_in: r.tokens_in || 0,
        tokens_in_cached: r.tokens_in_cached || 0,
        tokens_out: r.tokens_out || 0,
        tokens_reasoning: r.tokens_reasoning || 0,
        cost_ticks: r.cost_ticks ?? null,
      };
    } else {
      usageEstimated = true;
      usage = { tokens_in: estimateTokens(promptText), tokens_in_cached: 0, tokens_out: estimateTokens(text), tokens_reasoning: 0, cost_ticks: null };
    }
    const { cost_usd, cost_source } = m ? costOf(m, usage, { cnyToUsd: rate(), usageEstimated, at }) : { cost_usd: null, cost_source: null };
    return {
      tokens_in: usage.tokens_in,
      tokens_in_cached: usage.tokens_in_cached,
      tokens_out: usage.tokens_out,
      tokens_reasoning: usage.tokens_reasoning,
      cost_usd,
      cost_source,
    };
  }

  /** 翻译 / 后台测试的花费记进 system_costs（不算进会话）。上游没给 usage 就不记（无从推算输入）。 */
  function recordSystem(kind, m, userId, r) {
    if (!hasUsage(r)) return null;
    const usage = { tokens_in: r.tokens_in || 0, tokens_in_cached: r.tokens_in_cached || 0, tokens_out: r.tokens_out || 0, tokens_reasoning: r.tokens_reasoning || 0, cost_ticks: r.cost_ticks ?? null };
    const at = nowIso();
    const c = m ? costOf(m, usage, { cnyToUsd: rate(), at }) : { cost_usd: null, cost_source: null };
    // 输出 token 与 estimateUsd 同一口径：只有思考 token 另计的厂商（xAI 等）才加上，completion_tokens 已含思考的不重复计。
    const tokensOut = usage.tokens_out + (reasoningBilledSeparately(m?.base_url, usage) ? (usage.tokens_reasoning || 0) : 0);
    db.prepare('INSERT INTO system_costs(kind, model_id, user_id, tokens_in, tokens_in_cached, tokens_out, cost_usd, cost_source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(kind, m?.id ?? null, userId ?? null, usage.tokens_in, usage.tokens_in_cached, tokensOut, c.cost_usd, c.cost_source, at);
    return c;
  }

  /** 直接记一笔已知金额的系统花费（契约 §18.2：语音识别按秒计费，没有 token）。 */
  function recordSystemCost(kind, { model_id = null, user_id = null, cost_usd = null, cost_source = 'estimate' } = {}) {
    db.prepare('INSERT INTO system_costs(kind, model_id, user_id, tokens_in, tokens_in_cached, tokens_out, cost_usd, cost_source, created_at) VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?)')
      .run(kind, model_id, user_id, cost_usd, cost_usd === null ? null : cost_source, nowIso());
  }

  /**
   * 会话合计：cost_usd（到 $0.000001）+ cost_partial（有模型生成的回复算不出费用）。
   * 用户会话视图只合计未删除的消息；真实用量由独立统计记录保存。
   */
  function chatTotals(chatId) {
    const r = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS cost,
        EXISTS (SELECT 1 FROM messages x WHERE x.chat_id = ? AND x.role = 'assistant' AND x.model IS NOT NULL AND x.cost_usd IS NULL AND x.deleted_at IS NULL) AS partial
      FROM messages WHERE chat_id = ? AND deleted_at IS NULL
    `).get(chatId, chatId);
    return { cost_usd: round6(r.cost), cost_partial: !!r.partial };
  }

  /** 时间段内 system_costs 合计（super 的用量页）。fromIso 为 UTC ISO 下界。 */
  function systemTotals(fromIso) {
    const rows = db.prepare('SELECT kind, COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced FROM system_costs WHERE created_at >= ? GROUP BY kind').all(fromIso);
    const out = { cost_usd: 0, translate_usd: 0, test_usd: 0, voice_usd: 0, count: 0, cost_partial: false };
    for (const r of rows) {
      out.count += r.n;
      out.cost_usd += r.cost;
      if (r.kind === 'translate') out.translate_usd += r.cost;
      if (r.kind === 'test') out.test_usd += r.cost;
      if (r.kind === 'voice') out.voice_usd += r.cost;
      if (r.unpriced) out.cost_partial = true;
    }
    out.cost_usd = round6(out.cost_usd);
    out.translate_usd = round6(out.translate_usd);
    out.test_usd = round6(out.test_usd);
    out.voice_usd = round6(out.voice_usd);
    return out;
  }

  return { forReply, recordSystem, recordSystemCost, chatTotals, systemTotals };
}

/** SQL 片段：会话合计（用户侧列表用，只算未删消息；ch 为 chats 别名）。 */
export const CHAT_COST_SQL_LIVE = `
  (SELECT COALESCE(SUM(mc.cost_usd), 0) FROM messages mc WHERE mc.chat_id = ch.id AND mc.deleted_at IS NULL) AS cost_sum,
  EXISTS (SELECT 1 FROM messages mp WHERE mp.chat_id = ch.id AND mp.deleted_at IS NULL AND mp.role = 'assistant' AND mp.model IS NOT NULL AND mp.cost_usd IS NULL) AS cost_unpriced`;
