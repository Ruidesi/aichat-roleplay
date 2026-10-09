// 模型管理（契约 §8）：预置、key 加密存储、解析顺序、对外视图、接口地址 SSRF 校验。
// key 只在服务端用：/api/models 绝不返回 base_url / key / env 名；管理视图只给 key_set 与末 4 位。
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, mkdirSync, statSync } from 'node:fs';
import dns from 'node:dns';
import net from 'node:net';
import path from 'node:path';
import { HttpError, nowIso, str } from './util.mjs';
import { getSettings, setSetting, tx, fillPresetPrices, XAI_DEFAULT_PROXY } from './db.mjs';
import { readKeyFromEnvFile } from './llm.mjs';
import { checkProxyUrl } from './proxy.mjs';
import { CURRENCIES, isXaiUrl } from './pricing.mjs';

// ---------- 模型预置（实际可用模型以服务商和账户配置为准） ----------
// base 可以是固定地址，也可以是 { env: 'XXX' }（从 AI_KEYS_FILE 读）。
const THINKING_OFF = { thinking: { type: 'disabled' } };
export const PRESETS = [
  { name: 'DeepSeek 快速', provider: 'DeepSeek', base: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-flash', enabled: 1, isDefault: true, extra: THINKING_OFF },
  { name: 'DeepSeek 专业', provider: 'DeepSeek', base: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-v4-pro', enabled: 1, extra: THINKING_OFF },
  // 此提供商默认停用；配置有权访问聊天接口的 API 凭据后再启用。
  { name: 'Kimi', provider: '月之暗面', base: { env: 'KIMI_API_BASE_URL' }, keyEnv: 'KIMI_API_KEY', model: 'k3', enabled: 0, extra: null },
  // 预置模型及思考参数需按实际提供商能力调整。
  { name: '智谱 GLM', provider: '智谱', base: 'https://open.bigmodel.cn/api/paas/v4', keyEnv: 'GLM_API_KEY', model: 'glm-5.2', enabled: 0, extra: THINKING_OFF },
  { name: '小米 MiMo', provider: '小米', base: { env: 'XIAOMI_MIMO_BASE_URL' }, keyEnv: 'XIAOMI_MIMO_API_KEY', model: 'mimo-v2.6-flash', enabled: 0, extra: THINKING_OFF },
  // 通义的角色扮演专用模型。
  { name: '通义千问', provider: '阿里云', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyEnv: 'DASHSCOPE_API_KEY', model: 'qwen-flash-character', enabled: 0, extra: null },
  // 豆包的角色扮演专用模型。
  { name: '豆包', provider: '字节跳动', base: 'https://ark.cn-beijing.volces.com/api/v3', keyEnv: 'ARK_API_KEY', model: 'doubao-seed-character-260628', enabled: 0, extra: THINKING_OFF },
  // xAI 预置使用回环代理；部署时按实际网络环境调整。
  { name: 'Grok 快速', provider: 'xAI', base: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', model: 'grok-4.20-0309-non-reasoning', enabled: 1, extra: null, proxy: XAI_DEFAULT_PROXY },
];

/**
 * 首次预置。只在 models 表为空且从没预置过时运行；只插入 key（以及需要的 base 变量）在 AI_KEYS_FILE 里存在的项。
 * @returns {{id:number,name:string,enabled:number}[]} 本次插入的行
 */
export function seedModels(db, { keysFile, deepseekBase, deepseekModel } = {}) {
  const s = db.prepare("SELECT value FROM settings WHERE key = 'models_seeded'").get();
  if (s && s.value === '1') return [];
  if (db.prepare('SELECT 1 FROM models LIMIT 1').get()) { setSetting(db, 'models_seeded', '1'); return []; }
  const inserted = [];
  tx(db, () => {
    let sort = 0;
    for (const p of PRESETS) {
      if (!keysFile || !readKeyFromEnvFile(keysFile, p.keyEnv)) continue;
      let base = typeof p.base === 'string' ? p.base : readKeyFromEnvFile(keysFile, p.base.env);
      let model = p.model;
      if (p.keyEnv === 'DEEPSEEK_API_KEY') {
        if (deepseekBase) base = deepseekBase;
        if (p.isDefault && deepseekModel) model = deepseekModel;
      }
      base = String(base || '').trim().replace(/\/+$/, '');
      if (!base) continue;
      sort += 1;
      const r = db.prepare('INSERT INTO models(name, provider, base_url, api_key_env, api_key_enc, model, enabled, sort, extra_json, proxy_url, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)')
        .run(p.name, p.provider, base, p.keyEnv, model, p.enabled, sort, p.extra ? JSON.stringify(p.extra) : null, p.proxy || null, nowIso());
      const id = Number(r.lastInsertRowid);
      inserted.push({ id, name: p.name, enabled: p.enabled });
      if (p.isDefault) setSetting(db, 'default_model_id', id);
    }
    if (inserted.length) setSetting(db, 'models_seeded', '1');
    fillPresetPrices(db); // 契约 §10.2：预置单价
  });
  return inserted;
}

// ---------- key 加密（AES-256-GCM，密钥文件 DATA_DIR/secret.key，0600） ----------
const AAD = Buffer.from('aichat-model-key-v1');

/** 已存在的密钥文件（rsync / 备份恢复 / 手工拷贝来的）权限可能是 0644，读到就收紧成 0600。 */
function tightenSecretMode(file) {
  try {
    if (statSync(file).mode & 0o077) chmodSync(file, 0o600);
  } catch (e) {
    console.error(`[models] secret.key 权限收紧失败（${e.code || 'error'}）`);
  }
}

export function loadOrCreateSecret(file) {
  try {
    const hex = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) { tightenSecretMode(file); return Buffer.from(hex, 'hex'); }
  } catch { /* 还没有 */ }
  mkdirSync(path.dirname(file), { recursive: true });
  const key = crypto.randomBytes(32);
  try {
    writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') {
      const hex = readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) { tightenSecretMode(file); return Buffer.from(hex, 'hex'); }
      throw new Error('secret.key 格式不对');
    }
    throw e;
  }
  try { chmodSync(file, 0o600); } catch { /* ignore */ }
  return key;
}

export function encryptSecret(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(blob, key) {
  const [v, iv, tag, ct] = String(blob || '').split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('bad blob');
  const ivBuf = Buffer.from(iv, 'base64url');
  const tagBuf = Buffer.from(tag, 'base64url');
  // 认证标签必须是完整 16 字节：截短的标签会把伪造难度从 2^128 降到 2^32。
  if (ivBuf.length !== 12 || tagBuf.length !== 16) throw new Error('bad blob');
  const d = crypto.createDecipheriv('aes-256-gcm', key, ivBuf, { authTagLength: 16 });
  d.setAAD(AAD);
  d.setAuthTag(tagBuf);
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

// ---------- SSRF：管理员填的接口地址必须是 https 且不指向内网/环回 ----------
function ipv4Private(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && p[2] === 0)
    || (a === 192 && b === 0 && p[2] === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && p[2] === 100)
    || (a === 203 && b === 0 && p[2] === 113);
}

/** 是否内网 / 环回 / 链路本地 / 保留地址（IPv4 与 IPv6，含 IPv4 映射）。非法字符串按不安全处理。 */
export function isPrivateIp(ip) {
  const s = String(ip || '').replace(/^\[|\]$/g, '').toLowerCase();
  const fam = net.isIP(s);
  if (fam === 4) return ipv4Private(s);
  if (fam !== 6) return true;
  if (s === '::' || s === '::1') return true;
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s) || /^::(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return ipv4Private(mapped[1]);
  // ::ffff:7f00:1 这种十六进制写法的 IPv4 映射
  const hexMapped = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16);
    return ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(s.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((first & 0xff00) === 0xff00) return true; // 组播
  if (s.startsWith('64:ff9b:')) return true; // NAT64 可能映射到内网
  if (s.startsWith('2001:db8:')) return true;
  return false;
}

/** 语法检查：返回规范化地址（去掉末尾 /）或抛 400。不做 DNS。 */
export function checkBaseUrlSyntax(raw) {
  const s = str(raw, 500).trim();
  let u;
  try { u = new URL(s); } catch { throw new HttpError(400, '接口地址格式不正确'); }
  if (u.protocol !== 'https:') throw new HttpError(400, '接口地址必须是 https');
  if (u.username || u.password) throw new HttpError(400, '接口地址不能带账号密码');
  if (u.search || u.hash) throw new HttpError(400, '接口地址不能带查询参数');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new HttpError(400, '接口地址格式不正确');
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|intranet|corp)$/.test(host)) throw new HttpError(400, '接口地址不能指向内网');
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIP(bare) && isPrivateIp(bare)) throw new HttpError(400, '接口地址不能指向内网');
  if (!net.isIP(bare) && !host.includes('.')) throw new HttpError(400, '接口地址不能指向内网');
  return u.toString().replace(/\/+$/, '');
}

/** 完整检查：语法 + DNS 解析出的每个地址都不能是内网。 */
export async function checkBaseUrl(raw, { lookup = dns.promises.lookup } = {}) {
  const url = checkBaseUrlSyntax(raw);
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return url;
  let addrs;
  try { addrs = await lookup(host, { all: true, verbatim: true }); } catch { throw new HttpError(400, '接口地址的域名解析不了'); }
  if (!addrs?.length || addrs.some((a) => isPrivateIp(a.address))) throw new HttpError(400, '接口地址不能指向内网');
  return url;
}

export const PROXIED_DNS_TIMEOUT_MS = 2000;

/**
 * 走代理的模型（契约 §10.1）：语法检查 + 尽力而为的本地 DNS 检查。
 * 本地解析成功且有内网 / 环回地址 → 拒绝（防止借代理探测内网端口）；解析失败或超时 → 放行（本地 DNS 可能被污染，
 * 被污染的结果通常是公网假地址，不会误拦 api.x.ai）。
 */
export async function checkBaseUrlProxied(raw, { lookup = dns.promises.lookup, timeoutMs = PROXIED_DNS_TIMEOUT_MS } = {}) {
  const url = checkBaseUrlSyntax(raw);
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return url;
  let timer;
  const addrs = await Promise.race([
    Promise.resolve().then(() => lookup(host, { all: true, verbatim: true })).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
  if (Array.isArray(addrs) && addrs.some((a) => isPrivateIp(a?.address))) throw new HttpError(400, '接口地址不能指向内网');
  return url;
}

// ---------- 服务 ----------
export const KEY_ENV_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** 后台可用的 key 变量名只认预置项用到的（不能把中央密钥文件里任意一把 key 挂到模型上）。 */
export const ALLOWED_KEY_ENVS = new Set(PRESETS.map((p) => p.keyEnv));
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } };
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const RESERVED_EXTRA = new Set(['model', 'messages', 'stream', 'stream_options']);

/** 单价：空 = null；否则 0–100000 的数。 */
export function parsePrice(v, label = '单价') {
  if (v === null || v === '') return null;
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN);
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new HttpError(400, `${label}必须是不小于 0 的数字`);
  return n;
}

export function parseExtra(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  let o = v;
  if (typeof v === 'string') {
    if (v.length > 4000) throw new HttpError(400, '附加参数太长');
    try { o = JSON.parse(v); } catch { throw new HttpError(400, '附加参数必须是 JSON 对象'); }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new HttpError(400, '附加参数必须是 JSON 对象');
  for (const k of Object.keys(o)) if (RESERVED_EXTRA.has(k)) throw new HttpError(400, `附加参数里不能设置 ${k}`);
  const s = JSON.stringify(o);
  if (s.length > 4000) throw new HttpError(400, '附加参数太长');
  return Object.keys(o).length ? s : null;
}

export function createModelService({ db, keysFile = '', secretFile = '', lookup } = {}) {
  let secret = null;
  const secretKey = () => {
    if (!secret) secret = secretFile ? loadOrCreateSecret(secretFile) : crypto.randomBytes(32); // 无数据目录（测试）就用临时密钥
    return secret;
  };

  const all = () => db.prepare('SELECT * FROM models ORDER BY sort, id').all();
  const byId = (id) => (id === null || id === undefined || id === '' ? undefined : db.prepare('SELECT * FROM models WHERE id = ?').get(Number(id)));
  const enabledById = (id) => { const m = byId(id); return m && m.enabled ? m : undefined; };
  const firstEnabled = () => db.prepare('SELECT * FROM models WHERE enabled = 1 ORDER BY sort, id LIMIT 1').get();

  /** 全站默认：settings.default_model_id（启用）→ 第一个启用的。 */
  const systemDefault = () => enabledById(getSettings(db).default_model_id) || firstEnabled() || null;
  /** 用户默认：users.default_model_id（启用）→ 全站默认。 */
  const userDefault = (user) => enabledById(user?.default_model_id) || systemDefault();
  /** 会话生成用：chats.model_id（启用）→ 用户默认 → 全站默认 → 第一个启用的。停用的自动回落，不报错。 */
  const forChat = (chat, user) => enabledById(chat?.model_id) || userDefault(user);

  /** 校验普通用户提交的模型 id：必须存在且启用；null/'' 表示跟随默认。 */
  function requireEnabled(id, { allowNull = true } = {}) {
    if (id === null || id === '' || id === undefined) {
      if (allowNull) return null;
      throw new HttpError(400, '请选择模型');
    }
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, '模型不正确');
    const m = enabledById(n);
    if (!m) throw new HttpError(400, '这个模型不可用');
    return m;
  }

  function apiKeyOf(m) {
    if (!m) return '';
    if (m.api_key_enc) {
      try { return decryptSecret(m.api_key_enc, secretKey()); } catch { console.error(`[models] model ${m.id} 的 key 解不开（secret.key 变了？）`); return ''; }
    }
    if (m.api_key_env) return readKeyFromEnvFile(keysFile, m.api_key_env) || '';
    return '';
  }

  function extraOf(m) {
    if (!m?.extra_json) return {};
    try {
      const o = JSON.parse(m.extra_json);
      if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
      for (const k of RESERVED_EXTRA) delete o[k];
      return o;
    } catch { return {}; }
  }

  const publicView = (m) => (m ? { id: m.id, name: m.name, provider: m.provider } : null);
  const brief = (m) => (m ? { id: m.id, name: m.name } : null);

  function adminView(m) {
    const k = apiKeyOf(m);
    const inUse = db.prepare('SELECT COUNT(*) AS n FROM chats WHERE model_id = ?').get(m.id).n;
    return {
      id: m.id,
      name: m.name,
      provider: m.provider,
      base_url: m.base_url,
      model: m.model,
      enabled: m.enabled ? 1 : 0,
      sort: m.sort,
      extra_json: m.extra_json || '',
      key_source: m.api_key_enc ? 'stored' : m.api_key_env ? 'env' : 'none',
      key_env: m.api_key_env || null,
      key_set: !!k,
      // 中央密钥文件里的 key 不回末 4 位，只回 key_set。
      key_hint: k && m.api_key_enc ? k.slice(-4) : '',
      proxy_url: m.proxy_url || null,
      currency: m.currency || 'USD',
      price_in: m.price_in ?? null,
      price_in_cached: m.price_in_cached ?? null,
      price_out: m.price_out ?? null,
      can_sync_price: isXaiUrl(m.base_url),
      chats: inUse,
      is_default: getSettings(db).default_model_id === m.id,
      created_at: m.created_at,
    };
  }

  function listEnabled() {
    return db.prepare('SELECT * FROM models WHERE enabled = 1 ORDER BY sort, id').all();
  }

  /** 管理员新建 / 修改的输入校验。返回要写入的字段。 */
  async function validateInput(b, { partial, current = null }) {
    const out = {};
    // 出站代理（契约 §10.1）：只许本机；空 = 直连。先定代理，接口地址检查要看它。
    if (b.proxy_url !== undefined) out.proxy_url = checkProxyUrl(b.proxy_url);
    // 计费（契约 §10.2）：币种 + 三档每百万 token 单价，空 = 未填。
    if (b.currency !== undefined && b.currency !== null && b.currency !== '') {
      const c = String(b.currency).toUpperCase();
      if (!CURRENCIES.includes(c)) throw new HttpError(400, '币种只能是 USD 或 CNY');
      out.currency = c;
    }
    for (const [k, label] of [['price_in', '输入单价'], ['price_in_cached', '缓存输入单价'], ['price_out', '输出单价']]) {
      if (b[k] === undefined) continue;
      out[k] = parsePrice(b[k], label);
    }
    if (!partial || b.name !== undefined) {
      const v = str(b.name, 40).trim();
      if (!v) throw new HttpError(400, '显示名不能为空');
      out.name = v;
    }
    if (!partial || b.provider !== undefined) out.provider = str(b.provider, 40).trim();
    if (!partial || b.base_url !== undefined) {
      if (!str(b.base_url, 500).trim()) throw new HttpError(400, '接口地址不能为空');
      // 有代理时目标主机名由代理解析（本机 DNS 可能被污染）：只做字面量检查（https、非内网字面地址、非 localhost/.internal）。
      const proxy = out.proxy_url !== undefined ? out.proxy_url : (current?.proxy_url || null);
      const willProxy = proxy || (!partial && isXaiUrl(str(b.base_url, 500).trim())); // 新建 xAI 一定会配上默认代理
      out.base_url = willProxy
        ? await checkBaseUrlProxied(b.base_url, lookup ? { lookup } : undefined)
        : await checkBaseUrl(b.base_url, lookup ? { lookup } : undefined);
    }
    if (!partial || b.model !== undefined) {
      const v = str(b.model, 200).trim();
      if (!MODEL_ID_RE.test(v)) throw new HttpError(400, '模型 ID 不正确');
      out.model = v;
    }
    if (b.extra_json !== undefined) out.extra_json = parseExtra(b.extra_json);
    if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
    // key：留空 = 不改；填了 api_key 就加密存库并清掉 env；填 api_key_env 就改用变量。
    const key = typeof b.api_key === 'string' ? b.api_key.trim() : '';
    if (key) {
      if (key.length > 500 || /\s/.test(key)) throw new HttpError(400, '密钥格式不正确');
      out.api_key_enc = encryptSecret(key, secretKey());
      out.api_key_env = null;
    } else if (typeof b.api_key_env === 'string' && b.api_key_env.trim()) {
      const env = b.api_key_env.trim();
      if (!KEY_ENV_RE.test(env) || !ALLOWED_KEY_ENVS.has(env)) throw new HttpError(400, '密钥变量名不正确');
      out.api_key_env = env;
      out.api_key_enc = null;
    }
    return out;
  }

  /** 某个 key 变量允许发往的主机：预置项的接口地址（含从密钥文件读的地址）。 */
  function presetHostsFor(env) {
    const hosts = new Set();
    for (const p of PRESETS) {
      if (p.keyEnv !== env) continue;
      const base = typeof p.base === 'string' ? p.base : readKeyFromEnvFile(keysFile, p.base.env);
      const h = hostOf(base);
      if (h) hosts.add(h);
    }
    return hosts;
  }

  /**
   * 变量来源的 key 只能发往它本来的主机：预置地址，或这一行原本就用这个变量时的原地址。
   * 防止管理员把中央密钥文件里的 key 挂到自己控制的服务器上。
   */
  function assertEnvHost(env, baseUrl, current) {
    const h = hostOf(baseUrl);
    if (presetHostsFor(env).has(h)) return;
    if (current && current.api_key_env === env && hostOf(current.base_url) === h) return;
    throw new HttpError(400, '这个密钥变量不能用于该接口地址');
  }

  async function create(b) {
    const f = await validateInput(b, { partial: false });
    if (!f.api_key_enc && !f.api_key_env) throw new HttpError(400, '请填写密钥');
    if (f.api_key_env) assertEnvHost(f.api_key_env, f.base_url, null);
    // 契约 §10.1：新建 api.x.ai 模型没填代理 → 默认本机 42001。
    if (!f.proxy_url && isXaiUrl(f.base_url)) f.proxy_url = XAI_DEFAULT_PROXY;
    const max = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM models').get().m;
    const r = db.prepare(`INSERT INTO models(name, provider, base_url, api_key_env, api_key_enc, model, enabled, sort, extra_json, proxy_url, currency, price_in, price_in_cached, price_out, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(f.name, f.provider || '', f.base_url, f.api_key_env ?? null, f.api_key_enc ?? null, f.model, f.enabled ?? 1, max + 1, f.extra_json ?? null,
        f.proxy_url ?? null, f.currency || 'USD', f.price_in ?? null, f.price_in_cached ?? null, f.price_out ?? null, nowIso());
    return byId(Number(r.lastInsertRowid));
  }

  async function update(id, b) {
    const m = byId(id);
    if (!m) throw new HttpError(404, '没有找到这个模型');
    const f = await validateInput(b, { partial: true, current: m });
    // 只改代理（没改地址）：去掉代理 = 改回直连，要补做一次 DNS 内网检查。
    if (f.base_url === undefined && f.proxy_url === null && m.proxy_url) await checkBaseUrl(m.base_url, lookup ? { lookup } : undefined);
    // 只改代理（直连 → 走代理 / 换代理）：同样做一次尽力而为的 DNS 内网检查。
    if (f.base_url === undefined && f.proxy_url) await checkBaseUrlProxied(m.base_url, lookup ? { lookup } : undefined);
    // 接口地址换了主机：必须同时填新的密钥（旧的变量 / 密文一并清掉），不能带着旧 key 发到新地址。
    if (f.base_url !== undefined && hostOf(f.base_url) !== hostOf(m.base_url) && !f.api_key_enc) {
      throw new HttpError(400, '改了接口地址需要重新填写密钥');
    }
    const finalEnv = f.api_key_enc ? null : (f.api_key_env !== undefined ? f.api_key_env : m.api_key_env);
    if (finalEnv) assertEnvHost(finalEnv, f.base_url ?? m.base_url, m);
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE models SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), m.id);
    return byId(m.id);
  }

  /** 有会话在用 → 停用；否则真删。返回 { deleted } 或 { disabled }。 */
  function remove(id) {
    const m = byId(id);
    if (!m) throw new HttpError(404, '没有找到这个模型');
    const inUse = db.prepare('SELECT 1 FROM chats WHERE model_id = ? LIMIT 1').get(m.id);
    if (inUse) {
      db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(m.id);
      return { disabled: true };
    }
    tx(db, () => {
      db.prepare('UPDATE users SET default_model_id = NULL WHERE default_model_id = ?').run(m.id);
      if (getSettings(db).default_model_id === m.id) setSetting(db, 'default_model_id', '');
      db.prepare('DELETE FROM models WHERE id = ?').run(m.id);
    });
    return { deleted: true };
  }

  /** 写入单价（同步价格用）。 */
  function setPrices(id, p) {
    db.prepare('UPDATE models SET currency = ?, price_in = ?, price_in_cached = ?, price_out = ? WHERE id = ?')
      .run(p.currency || 'USD', p.price_in ?? null, p.price_in_cached ?? null, p.price_out ?? null, Number(id));
    return byId(id);
  }

  function order(ids) {
    if (!Array.isArray(ids)) throw new HttpError(400, 'ids 必须是列表');
    tx(db, () => {
      ids.forEach((id, i) => db.prepare('UPDATE models SET sort = ? WHERE id = ?').run(i + 1, Number(id)));
    });
  }

  return {
    all, byId, enabledById, listEnabled, systemDefault, userDefault, forChat, requireEnabled,
    apiKeyOf, extraOf, publicView, brief, adminView, create, update, remove, order, setPrices,
  };
}
