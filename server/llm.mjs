// 大模型调用（契约 §5 / §8）：按模型行的 base_url / key / extra_json 调 OpenAI 兼容 /chat/completions。
// key 只在运行时读（env 文件或库里加密的），绝不返回给前端、绝不写日志；上游错误正文也不写日志、不转给前端。
import { readFileSync } from 'node:fs';
import dns from 'node:dns';
import https from 'node:https';
import { Readable } from 'node:stream';
import { HttpError } from './util.mjs';
import { checkBaseUrlSyntax, isPrivateIp } from './models.mjs';
import { createProxyFetch } from './proxy.mjs';
import { parseUsage } from './pricing.mjs';

// 流式超时（只认有效内容：data: 行里带 choices / usage 的 JSON；SSE 心跳注释 「: keep-alive」、空 data 不算，不续期）：
//   首个有效 delta 60 秒内必须到；之后两个有效 delta 之间最长 60 秒；整次调用总时长上限 5 分钟。
export const FIRST_BYTE_TIMEOUT_MS = 60000;
export const IDLE_TIMEOUT_MS = 60000;
export const TOTAL_TIMEOUT_MS = 5 * 60 * 1000;
const ERROR_BODY_MAX = 16 * 1024;

export const REFUSED_MESSAGE = '这个模型拒绝了这条内容，可以换个模型再试';
const TIMEOUT_MESSAGE = '回复超时，请稍后重试';

export function readKeyFromEnvFile(file, name = 'DEEPSEEK_API_KEY') {
  if (!file) return '';
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return ''; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || m[1] !== name) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    return v.trim();
  }
  return '';
}

// 审核 / 拒答类关键词（契约 §8.4）。只认具体短语：单独的 content / 安全 会把
// 「messages[1].content must be a string」「content too long」这类参数错误误判成拒答。
// xAI 审查拒答：403 {"code":"permission-denied","error":"I'm sorry, I can't help with that request."}
const REFUSAL_RE = /permission[ _-]?denied|can(?:no|')t help|unable to (?:help|assist)|content[ _-]?filter|content[ _-]?policy|content[ _-]?management|inappropriate|data_inspection_failed|sensitive|moderation|risk|safety|审核|敏感|违规|不良信息/i;

/** 是否内容审核类拒答：HTTP 451 一律算；HTTP 400/403 且正文含审核关键词。 */
export function isRefusal(status, bodyText) {
  if (status === 451) return true;
  return (status === 400 || status === 403) && REFUSAL_RE.test(String(bodyText || ''));
}

/** 上游 HTTP 错误 → 给前端的 HttpError（带 code）。不带上游正文。 */
export function upstreamError(status, bodyText) {
  if (isRefusal(status, bodyText)) return new HttpError(502, REFUSED_MESSAGE, 'refused');
  if (status === 401 || status === 403) return new HttpError(503, '对话服务暂时不可用，请联系管理员', 'upstream');
  if (status === 402) return new HttpError(503, '对话服务额度不足，请联系管理员', 'upstream');
  if (status === 429) return new HttpError(503, '对话服务繁忙，请稍后重试', 'upstream');
  if (status === 408 || status === 504) return new HttpError(504, TIMEOUT_MESSAGE, 'timeout');
  return new HttpError(502, '对话服务暂时不可用，请稍后重试', 'upstream');
}

async function readCappedText(r, max = ERROR_BODY_MAX) {
  if (!r.body) return '';
  const reader = r.body.getReader?.();
  if (!reader) { try { return (await r.text()).slice(0, max); } catch { return ''; } }
  const dec = new TextDecoder();
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
      if (out.length >= max) { try { await reader.cancel(); } catch { /* ignore */ } break; }
    }
  } catch { /* ignore */ }
  return out.slice(0, max);
}

// ---------- 出站：每次连接都只连校验过的 IP（防 DNS 重绑定） ----------
// fetch 会自己再解析一次域名，校验和连接之间可以被换成内网地址；这里用 node:https 并传自定义 lookup，
// 解析结果当场过滤，连接就用这批地址；servername 仍是原域名，SNI / 证书校验照常。

/** dns.lookup 的替身：解析出的地址只要有一个是内网 / 环回就整体拒绝。 */
export function createSafeLookup(baseLookup = dns.lookup) {
  return function safeLookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    if (typeof options === 'number') options = { family: options };
    const opts = { ...(options || {}), all: true, verbatim: true };
    baseLookup(hostname, opts, (err, addrs) => {
      if (err) return cb(err);
      const list = Array.isArray(addrs) ? addrs : [];
      if (!list.length || list.some((a) => isPrivateIp(a.address))) {
        const e = new Error('upstream host resolves to a private address');
        e.code = 'EPRIVATEADDR';
        return cb(e);
      }
      if (options?.all) cb(null, list);
      else cb(null, list[0].address, list[0].family);
    });
  };
}

const pinnedAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });

/**
 * 只支持 https 的极简 fetch：连接走 safeLookup，不跟随重定向（3xx 原样返回，按上游错误处理）。
 * 返回标准 Response（body 是 Web 流），上层代码与 fetch 通用。
 */
export function createPinnedFetch({ lookup = createSafeLookup(), agent = pinnedAgent } = {}) {
  return function pinnedFetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(url); } catch (e) { return reject(e); }
      if (u.protocol !== 'https:') return reject(new TypeError('only https is allowed'));
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
      const h = { ...headers };
      if (body !== undefined && body !== null) h['Content-Length'] = Buffer.byteLength(body);
      const req = https.request(u, { method, headers: h, lookup, agent, signal }, (res) => {
        const rh = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((x) => rh.append(k, x));
          else if (v !== undefined) rh.set(k, String(v));
        }
        const status = res.statusCode || 502;
        const noBody = method === 'HEAD' || status === 204 || status === 205 || status === 304;
        if (noBody) res.resume();
        try {
          resolve(new Response(noBody ? null : Readable.toWeb(res), { status: status >= 200 && status <= 599 ? status : 502, statusText: res.statusMessage || '', headers: rh }));
        } catch (e) { res.destroy(); reject(e); }
      });
      req.on('error', (e) => reject(signal?.aborted ? (signal.reason ?? e) : e));
      if (body !== undefined && body !== null) req.end(body); else req.end();
    });
  };
}

const defaultPinnedFetch = createPinnedFetch();
const defaultProxyFetch = createProxyFetch();

/** 默认的接口地址检查：语法层（https、非内网字面地址）；DNS 层由 safeLookup 在连接时把关。 */
const syntaxGuard = async (baseUrl) => { checkBaseUrlSyntax(baseUrl); };

const modelLabel = (m) => `${m?.name || '?'}#${m?.id ?? '?'}`;

/**
 * @param {object} o
 * @param {object} o.models            createModelService 的返回（取 key / extra / 默认模型）
 * @param {Function} [o.fetchImpl]        默认 pinnedFetch（只连 DNS 校验过的地址）
 * @param {Function|null} [o.checkUpstream]  每次调用前对 base_url 做语法层 SSRF 检查；测试连本机假上游时传 null
 */
export function createLlm({ models, fetchImpl, proxyFetch, checkUpstream, firstByteTimeoutMs = FIRST_BYTE_TIMEOUT_MS, idleTimeoutMs = IDLE_TIMEOUT_MS, totalTimeoutMs = TOTAL_TIMEOUT_MS } = {}) {
  const guard = checkUpstream === undefined ? syntaxGuard : checkUpstream;
  // checkUpstream: null = 关掉全部出站安全检查（只给连本机假上游的测试用），此时默认用普通 fetch。
  const doFetch = fetchImpl || (checkUpstream === null ? fetch : defaultPinnedFetch);
  // 模型配了 proxy_url（契约 §10.1）：走 CONNECT 隧道。目标主机名由代理解析（本机 DNS 可能被污染），
  // 所以不做本地 DNS 内网检查，但主机名字面量仍由 guard（checkBaseUrlSyntax）把关、必须 https。
  const doProxyFetch = proxyFetch || defaultProxyFetch;
  /** 上游不认 stream_options 的模型（按 id 记住，免得每次都多打一次）。 */
  const noStreamOptions = new Set();

  function pick(model) {
    const m = model || models?.systemDefault?.() || null;
    if (!m) throw new HttpError(503, '对话服务尚未配置，请联系管理员', 'upstream');
    return m;
  }

  function body(m, messages, opts) {
    return JSON.stringify({
      max_tokens: 1024,
      temperature: 0.9,
      ...opts.sampling,
      ...(models?.extraOf?.(m) || {}),
      model: m.model,
      messages,
      ...opts.stream,
    });
  }

  async function post(m, payload, signal, { path = '/chat/completions', method = 'POST' } = {}) {
    const key = models?.apiKeyOf?.(m) || '';
    if (!key) throw new HttpError(503, '对话服务尚未配置，请联系管理员', 'upstream');
    if (guard) {
      try { await guard(m.base_url); } catch {
        console.error(`[llm] ${modelLabel(m)} 接口地址没通过安全检查`);
        throw new HttpError(502, '对话服务暂时不可用，请联系管理员', 'upstream');
      }
    }
    let r;
    try {
      const url = `${String(m.base_url).replace(/\/+$/, '')}${path}`;
      const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json, text/event-stream' };
      if (payload !== undefined) headers['Content-Type'] = 'application/json';
      const init = { method, headers, body: payload, signal, redirect: 'error' };
      r = m.proxy_url ? await doProxyFetch(url, { ...init, proxyUrl: m.proxy_url }) : await doFetch(url, init);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (signal?.aborted && signal.reason?.name !== 'TimeoutError' && signal.reason?.code !== 'AC_TIMEOUT') throw e;
      if (signal?.aborted) throw new HttpError(504, TIMEOUT_MESSAGE, 'timeout');
      console.error(`[llm] ${modelLabel(m)} 连不上上游`);
      throw new HttpError(502, '对话服务暂时连不上，请稍后重试', 'upstream');
    }
    if (!r.ok) {
      const text = await readCappedText(r);
      const err = upstreamError(r.status, text);
      err.upstream_status = r.status;
      // 上游不认 stream_options（契约 §10.2：去掉重试一次）。只看状态码与参数名，不留正文。
      if (r.status === 400 && err.code !== 'refused' && /stream_options|include_usage/i.test(text)) err.stream_options_rejected = true;
      // 只记状态码与分类，不记正文（可能含用户内容）。
      console.error(`[llm] ${modelLabel(m)} upstream status ${r.status} → ${err.code}`);
      throw err;
    }
    return r;
  }

  /**
   * 流式聊天。onDelta(text) 每段回调。
   * 返回 { text, tokens_in, tokens_out, tokens_in_cached, tokens_reasoning, cost_ticks, usage, model, model_id, finish_reason }：
   * usage = 上游是否给了 usage（没给时 token 数为 0，由上层按字数粗估）。
   * 出错抛 HttpError（code = refused | upstream | timeout），err.partial = 已生成的部分，err.usage* 同上（上游已给 usage 时）。
   * signal：外部中断（客户端断开）→ 抛 { aborted: true }。
   */
  async function streamChat(messages, { onDelta, signal, model, max_tokens, temperature } = {}) {
    const m = pick(model);
    const ac = new AbortController();
    const onAbort = () => ac.abort(signal.reason);
    if (signal) { if (signal.aborted) ac.abort(signal.reason); else signal.addEventListener('abort', onAbort, { once: true }); }
    const timeoutErr = (why) => Object.assign(new Error('timeout'), { code: 'AC_TIMEOUT', why });
    // 三道时限都不被上游心跳续期：bump 只在收到有效内容 delta 时调用
    let timer = setTimeout(() => ac.abort(timeoutErr('first')), firstByteTimeoutMs);
    const totalTimer = setTimeout(() => ac.abort(timeoutErr('total')), totalTimeoutMs);
    const bump = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(timeoutErr('idle')), idleTimeoutMs); };
    let text = '';
    let usage = null, usedModel = m.model, finish_reason = null;
    const takeUsage = (u) => { const p = parseUsage(u); if (p) usage = p; };
    try {
      const sampling = {};
      if (max_tokens !== undefined) sampling.max_tokens = max_tokens;
      if (temperature !== undefined) sampling.temperature = temperature;
      const withOpts = !noStreamOptions.has(m.id);
      let r;
      try {
        r = await post(m, body(m, messages, { sampling, stream: withOpts ? { stream: true, stream_options: { include_usage: true } } : { stream: true } }), ac.signal);
      } catch (e) {
        if (!withOpts || !e?.stream_options_rejected) throw e;
        noStreamOptions.add(m.id);
        console.error(`[llm] ${modelLabel(m)} 不认 stream_options，去掉后重试`);
        r = await post(m, body(m, messages, { sampling, stream: { stream: true } }), ac.signal);
      }
      const ct = String(r.headers?.get?.('content-type') || '');
      if (ct.includes('application/json')) {
        // 有的上游在 200 里直接回 JSON 错误或整段结果
        const j = JSON.parse(await readCappedText(r, 1024 * 1024) || '{}');
        if (j.error) throw upstreamError(400, JSON.stringify(j.error));
        const ch = j.choices?.[0];
        const piece = ch?.message?.content || '';
        if (piece) { text += piece; onDelta?.(piece); }
        finish_reason = ch?.finish_reason || null;
        if (j.usage) takeUsage(j.usage);
        if (j.model) usedModel = j.model;
      } else {
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of r.body) {
          buf += decoder.decode(chunk, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let j;
            try { j = JSON.parse(data); } catch { continue; }
            if (j.error) {
              const e = upstreamError(400, JSON.stringify(j.error));
              console.error(`[llm] ${modelLabel(m)} 流中报错 → ${e.code}`);
              throw e;
            }
            // 有效内容 delta：带 choices（含思考 / 角色 / 结束标记）或 usage 的 JSON。心跳注释、空 data、[DONE] 不走到这里
            if (Array.isArray(j.choices) || j.usage) bump();
            if (j.model) usedModel = j.model;
            const ch = j.choices?.[0];
            const piece = ch?.delta?.content;
            if (piece) { text += piece; onDelta?.(piece); }
            if (ch?.finish_reason) finish_reason = ch.finish_reason;
            if (j.usage) takeUsage(j.usage);
          }
        }
      }
      if (finish_reason === 'content_filter' || finish_reason === 'sensitive') {
        console.error(`[llm] ${modelLabel(m)} finish_reason=${finish_reason} → refused`);
        throw new HttpError(502, REFUSED_MESSAGE, 'refused');
      }
    } catch (e) {
      const timedOut = ac.signal.aborted && ac.signal.reason?.code === 'AC_TIMEOUT';
      if (timedOut) console.error(`[llm] ${modelLabel(m)} 流式超时（${{ first: '首个有效内容未到', idle: '有效内容中断', total: '总时长超限' }[ac.signal.reason.why] || '超时'}），已生成 ${text.length} 字`);
      const err = e instanceof HttpError ? e
        : timedOut ? new HttpError(504, TIMEOUT_MESSAGE, 'timeout')
          : signal?.aborted ? Object.assign(new Error('aborted'), { aborted: true })
            : new HttpError(502, '回复中断，请重试', 'upstream');
      if (!(e instanceof HttpError) && !timedOut && !signal?.aborted) console.error(`[llm] ${modelLabel(m)} 回复中断（${e?.code || e?.name || 'error'}）`);
      err.partial = text;
      Object.assign(err, usageFields(usage));
      err.model = usedModel;
      err.model_id = m.id;
      throw err;
    } finally {
      clearTimeout(timer);
      clearTimeout(totalTimer);
      signal?.removeEventListener?.('abort', onAbort);
    }
    return { text, ...usageFields(usage), model: usedModel, model_id: m.id, finish_reason };
  }

  /** 非流式补全（用于翻译）。不传 model 用全站默认模型。返回带 usage 字段（同 streamChat）。 */
  // 非流式：AbortSignal.timeout 是从发请求起算的总时限（读正文也在内），上游发空行 / 心跳不会续期；最长不超过 totalTimeoutMs。
  async function complete(messages, { max_tokens = 1024, temperature = 0.3, timeoutMs = firstByteTimeoutMs, model } = {}) {
    const m = pick(model);
    const signal = AbortSignal.timeout(Math.max(1, Math.min(Number(timeoutMs) || firstByteTimeoutMs, totalTimeoutMs)));
    let r;
    try {
      r = await post(m, body(m, messages, { sampling: { max_tokens, temperature }, stream: { stream: false } }), signal);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(504, TIMEOUT_MESSAGE, 'timeout');
    }
    let j;
    try { j = await r.json(); } catch {
      // 响应头回来了、正文迟迟传不完（上游挂起）到点被掐断：算超时，不算「数据无法识别」
      if (signal.aborted) throw new HttpError(504, TIMEOUT_MESSAGE, 'timeout');
      throw new HttpError(502, '对话服务返回的数据无法识别', 'upstream');
    }
    const ch = j.choices?.[0];
    if (ch?.finish_reason === 'content_filter' || ch?.finish_reason === 'sensitive') throw new HttpError(502, REFUSED_MESSAGE, 'refused');
    return {
      text: ch?.message?.content || '',
      ...usageFields(parseUsage(j.usage)),
      model: j.model || m.model,
      model_id: m.id,
    };
  }

  /** 对上游发 GET 取 JSON（如 xAI /language-models 同步价格），走与对话相同的 key / 代理 / 安全检查。 */
  async function getJson(m, path, { timeoutMs = 20000 } = {}) {
    let r;
    try {
      r = await post(m, undefined, AbortSignal.timeout(timeoutMs), { path, method: 'GET' });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(504, TIMEOUT_MESSAGE, 'timeout');
    }
    const text = await readCappedText(r, 4 * 1024 * 1024);
    try { return JSON.parse(text); } catch { throw new HttpError(502, '对话服务返回的数据无法识别', 'upstream'); }
  }

  return { streamChat, complete, getJson };
}

/** usage（parseUsage 结果或 null）→ 返回 / 错误对象上的字段。 */
function usageFields(u) {
  return {
    usage: !!u,
    tokens_in: u?.tokens_in || 0,
    tokens_out: u?.tokens_out || 0,
    tokens_in_cached: u?.tokens_in_cached || 0,
    tokens_reasoning: u?.tokens_reasoning || 0,
    cost_ticks: u?.cost_ticks ?? null,
  };
}

/** 文本里中文字符占比够高就认为已经是中文，无需翻译。 */
export function looksChinese(s) {
  const t = String(s || '').replace(/\{\{[^}]*\}\}|<[^>]*>|\*|\s|[\p{P}\p{S}\d]/gu, '');
  if (!t) return true;
  const han = (t.match(/\p{Script=Han}/gu) || []).length;
  return han / t.length >= 0.3;
}

const TRANSLATE_SYSTEM = [
  '你是专业的文学翻译。把用户给出的角色扮演开场白翻译成自然流畅的简体中文（新加坡简体）。',
  '要求：只输出译文本身，不要任何解释或前后缀；',
  '原样保留 {{char}}、{{user}}、<BOT>、<USER> 等占位符；',
  '保留 *星号* 包住的动作描写格式和原有的换行、引号结构；',
  '人名可音译或保留原文；不要删减内容。',
].join('');

export async function translateGreeting(llm, text, { onResult, model, timeoutMs } = {}) {
  const src = String(text || '');
  if (!src.trim() || looksChinese(src)) return src;
  const r = await llm.complete([
    { role: 'system', content: TRANSLATE_SYSTEM },
    { role: 'user', content: src.slice(0, 6000) },
  ], { max_tokens: 2048, temperature: 0.3, ...(model ? { model } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  try { onResult?.(r); } catch (e) { console.error('[translate] 记录花费失败', e?.message || e); }
  const out = r.text.trim();
  if (!out) throw new Error('empty translation');
  return out;
}
