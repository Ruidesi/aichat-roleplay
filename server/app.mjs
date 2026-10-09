// HTTP 路由与处理（契约 §5）。
import { HttpError, sendJson, readBody, readBodyBuffer, clientIp, nowIso, sgDay, str, BASE_HEADERS } from './util.mjs';
import { getSettings, setSetting, tx, countActiveSupers, CARD_QUOTA_DEFAULTS, ABUSE_LIMIT_DEFAULTS, parseQuota } from './db.mjs';
import {
  hashPassword, verifyPassword, createSession, destroySession, destroyUserSessions, lookupSession,
  sessionCookie, parseCookies, COOKIE_NAME, SESSION_TTL_MS, LoginLimiter, publicUser, USERNAME_RE, DUMMY_HASH, roleOf,
} from './auth.mjs';
import { SORTS } from './chub.mjs';
import { createCharacterService, rowToCard, NSFW_FORBIDDEN, parseJson } from './characters.mjs';
import {
  normalizeCardData, normalizeCardMeta, cardDataFromBody, chubDefinitionToData, dataToDefinition, normalizeLorebook, selectLore,
  sniffImage, sanitizeAvatar, uploadPayload, parseImport, exportCardJson, exportCardPng, attachmentHeader, createCardAvatarStore,
  AVATAR_MAX_BYTES, IMPORT_MAX_BYTES, AVATAR_FILE_RE, IMAGE_MIME, TEXT_FIELDS, LIMITS as CARD_LIMITS,
} from './cards.mjs';
import { isValidChubPath } from './chub.mjs';
import { buildMessages, applyMacros, userCallName } from './prompt.mjs';
import {
  OVERRIDE_FIELDS, FILE_OVERRIDE_FIELDS, OVERRIDE_LABELS, pickFields, diffOverride, applyOverride, overrideDefinition, normalizePersona,
  personaDefaults, userWithPersona, chatOverride, chatPersona,
} from './chat-settings.mjs';
import { serveStatic } from './static.mjs';
import { mergeReadingSettings } from './reading-settings.mjs';
import { createMirrorImages, parseImageQuery } from './mirror-images.mjs';
import { createNasImageReader } from './nas-image-reader.mjs';
import { createNasApiReader } from './nas-api-reader.mjs';
import { createMirrorCharacters, characterSource } from './mirror-characters.mjs';
import { createModelService } from './models.mjs';
import { createGrokCliTranslation } from './grok-cli-translation.mjs';
import { createGrokQuotaReader } from './grok-cli-quota.mjs';
import { createCostService, CHAT_COST_SQL_LIVE } from './costs.mjs';
import { isXaiUrl, xaiPriceFromList, round6 } from './pricing.mjs';
import { writeLog, queryLogs, logKinds, change, parseRetentionDays } from './logs.mjs';
import {
  randomCode, normalizeCode, INVITE_CODE_LEN, RESET_CODE_LEN, RESET_CODE_TTL_MS, parseInviteNote, parseUserNote, parseMaxUses,
  parseInviteExpiry, inviteStatus, INVITE_STATUS_NAMES, INVITE_PUBLIC_REASONS, inviteLink, PUBLIC_BASE_URL_DEFAULT, FailLimiter,
  REGISTER_MAX_FAILS, REGISTER_WINDOW_MS, REGISTER_LOCK_MS, uaOf, queryMyLogins,
} from './accounts.mjs';
import {
  createCrawlerClient, sanitizeConfigPatch, scrubPaths, CRAWLER_OFFLINE, CRAWLER_PHASES, CRAWLER_PHASE_ACTIONS, CRAWLER_EXIT_ACTIONS, CRAWLER_PHASE_NAMES,
} from './crawler.mjs';
import nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { filesFromRequest, parseFilesIsolated, FILES_MAX, FILE_MAX_BYTES } from './fileparse.mjs';
import { rm, statfs } from 'node:fs/promises';
import {
  createUploadStore, createIndexCache, modeFor, chunkText, retrieve, retrievalQuery, buildFileMessages, kickoffText, fileChatTitle,
  estimateForModel, parseInstruction, RETRIEVAL_NOTICE,
} from './filechat.mjs';
import {
  createAsr, createClipStore, sniffAudio, asrCostUsd, formatTranscript, VOICE_MAX_BYTES, VOICE_RATE_PER_MINUTE, AUDIO_UPLOAD_TYPES, VOICE_UNAVAILABLE,
  VOICE_OPUS_MAX_BYTES, VOICE_MAX_SECONDS, VOICE_UNPROBED_MAX_BYTES, VOICE_MAX_BYTES_PER_SEC, VOICE_BAD_AUDIO, VOICE_TOO_LONG, VOICE_NOT_HEARD, probeDurationSec, looksSilent,
} from './voice.mjs';

const HOT_TTL_MS = 10 * 60 * 1000;
const HOT_COUNT = 24;
const MAX_MESSAGE_CHARS = 8000;
const NOT_FOUND_USER = '没有找到这个账号';
const ROLE_NAMES = { super: '超级管理员', admin: '管理员', tenant: '租户' };
const roleName = (r) => ROLE_NAMES[r] || r;
const limitText = (v) => (v === null || v === undefined ? '跟随全站' : (Number(v) === 0 ? '不限' : String(v)));
const LOCKED_LOG_THROTTLE_MS = 60 * 1000;
const NOT_FOUND_CHAT = '没有找到这个会话';
const NOT_FOUND_MESSAGE = '没有找到这条消息';
const NOT_FOUND_CARD = '没有找到这张卡片';
const CARD_GONE = '这个角色已不可用';
const GONE_CARD_NAME = '已不可用的角色';
const COMMUNITY_PAGE_SIZE = 24;
const ADMIN_CARDS_PAGE_SIZE = 30;
const CARD_BODY_LIMIT = 4 * 1024 * 1024;
const KIND_NAMES = { character: '人物卡', scenario: '剧情卡' };
const VIS_NAMES = { private: '私有', public: '站内公开' };

export function createApp({ db, chub, llm, avatars, config, models: modelSvc, cardAvatars: injectedCardAvatars = null, crawler: injectedCrawler = null, asr: injectedAsr = null, mirrorImages: injectedMirrorImages = null, grokCliTranslation: injectedGrokCliTranslation = null, grokCliReadQuota: injectedGrokCliReadQuota = null }) {
  const models = modelSvc || createModelService({
    db,
    keysFile: config.aiKeysFile || '',
    secretFile: config.dataDir ? nodePath.join(config.dataDir, 'secret.key') : '',
  });
  const costs = createCostService({ db });
  // CLI 翻译额度门槛（0 = 不限制）；没配置时沿用原先的 55%（测试与旧部署）。
  const cliMinPercent = Number.isFinite(config.grokCliMinRemainingPercent) ? config.grokCliMinRemainingPercent : 55;
  const readCliQuota = injectedGrokCliReadQuota || createGrokQuotaReader({ homeDir: config.grokCliHomeDir,
    probeModule: config.grokCliQuotaProbeModule, timeoutMs: 12000 });
  const grokCli = injectedGrokCliTranslation || (config.grokCliExecutable ? createGrokCliTranslation({
    executable: config.grokCliExecutable, readQuota: readCliQuota, tempDir: config.grokCliTempDir,
    proxyUrl: config.grokCliProxyUrl, minRemainingPercent: cliMinPercent,
  }) : null);
  /** 不读请求体就拒绝时用：回完断开连接（客户端可能还在发上百 MB）。 */
  const closeErr = (status, message, code) => { const e = new HttpError(status, message, code); e.closeConn = true; return e; };
  // 全站同时「正在读进内存的上传请求体」字节上限（按声明长度预占；没声明就按路由上限算）
  const UPLOAD_READING_MAX_BYTES = 300 * 1024 * 1024;
  let uploadBytesReading = 0;
  const mirrorCharacters = createMirrorCharacters({
    dbFile: config.mirrorDbFile,
    blockedPaths: () => db.prepare(`SELECT chub_path FROM characters WHERE nsfw=1 OR EXISTS
      (SELECT 1 FROM json_each(CASE WHEN json_valid(tags_json) THEN tags_json ELSE '[]' END) WHERE upper(value)='NSFW')`).all().map(r => r.chub_path),
  });
  const chars = createCharacterService({ db, chub, llm, costs, models, grokCli, mirror: mirrorCharacters });
  const imageAccessRow = db.prepare('SELECT nsfw,avatar_url,tags_json FROM characters WHERE chub_path=?');
  const imageAccessByUrl = db.prepare('SELECT chub_path AS full_path,nsfw,tags_json AS topics_json FROM characters WHERE avatar_url IN (?,?) LIMIT 65');
  const mirrorImages = injectedMirrorImages || createMirrorImages({
    dbFile: config.mirrorDbFile, imageDir: config.mirrorImageDir,
    cacheDir: config.mirrorThumbnailDir || (config.dataDir ? nodePath.join(config.dataDir, 'mirror-thumbnails') : ''),
    previewMaxBytes: config.mirrorPreviewCacheBytes,
    nasReader: config.mirrorNasFastRead ? createNasImageReader({ root: config.mirrorImageDir }) : null,
    // 44970 API 读取器优先，失败当次退回 SMB；配置不对就整体走 SMB，不影响启动。
    apiReader: config.mirrorNasReader === 'api' ? (() => { try { return createNasApiReader({ baseUrl: config.nasApiBase, keyFile: config.nasApiKeyFile,
      remoteRoot: config.nasApiRemoteRoot, timeoutMs: config.nasApiTimeoutMs }); } catch (e) { console.warn(`[nas-api] 配置不正确，镜像图片走 SMB：${e.message}`); return null; } })() : null,
    isAdultPath: p => {
      const r = imageAccessRow.get(p), tags = parseJson(r?.tags_json || '[]', []);
      return !!r?.nsfw || (Array.isArray(tags) && tags.some(t => String(t).toUpperCase() === 'NSFW'));
    },
    characterOfPath: p => imageAccessRow.get(p),
    charactersOfAvatarUrl: (raw, normalized) => imageAccessByUrl.all(raw, normalized),
  });
  let previewWarmupClosed = false;
  let cancelPreviewWarmupRead = null;
  async function warmPopularPreviews() {
    if (previewWarmupClosed || !mirrorCharacters.available()) return;
    if (config.dataDir) {
      const space = await statfs(config.dataDir);
      if (Number(space.bavail) * Number(space.bsize) < 8 * 1024 ** 3) return;
    }
    if (previewWarmupClosed) return;
    const ids = new Set();
    for (const nsfw of [false, true]) {
      for (const item of mirrorCharacters.list({ nsfw, limit: HOT_COUNT }).items) {
        const match = /^\/api\/images\/(a\.[1-9]\d*)\?variant=thumb$/.exec(item.avatar || '');
        if (match) ids.add(match[1]);
      }
    }
    const deadline = Date.now() + 90000;
    let completed = 0, failed = 0, consecutiveFailed = 0;
    // 一次一个后台任务，给前台的冷图转换保留另一个名额；命中SSD不读NAS。
    for (const id of [...ids].slice(0, 2 * HOT_COUNT)) {
      if (previewWarmupClosed || Date.now() >= deadline) break;
      try {
        const expired = Symbol('preview-warmup-expired');
        let timer;
        const budget = new Promise(resolve => {
          cancelPreviewWarmupRead = () => resolve(expired);
          timer = setTimeout(cancelPreviewWarmupRead, Math.max(1, deadline - Date.now()));
          timer.unref?.();
        });
        let result;
        try {
          result = await Promise.race([
            mirrorImages.read(id, { variant: 'thumb', user: { nsfw_enabled: true } }), budget,
          ]);
        } finally {
          clearTimeout(timer); cancelPreviewWarmupRead = null;
        }
        // 仅结束后台等待；已开始的NAS操作仍占原有IO槽直到真正完成。
        if (result === expired || previewWarmupClosed) break;
        completed++; consecutiveFailed = 0;
      } catch {
        failed++; if (++consecutiveFailed >= 3) break;
      }
    }
    if (!previewWarmupClosed) console.log(`[preview-cache] warmup completed=${completed} failed=${failed}`);
  }
  const previewWarmupTimer = config.mirrorPreviewWarmup ? setTimeout(() => {
    warmPopularPreviews().catch(() => { if (!previewWarmupClosed) console.log('[preview-cache] warmup skipped'); });
  }, 1000) : null;
  previewWarmupTimer?.unref?.();
  const mirrorAvatar = p => mirrorCharacters.avatar(p);
  const remoteAvatar = (p, fallback, evidence = {}) => mirrorImages.avatarUrl(p, fallback, evidence);
  const limiter = new LoginLimiter();
  // 契约 §13：公开重置按 IP+用户名限流（规则同登录，独立计数）；公开注册按 IP 限流（10 分钟失败 10 次锁 30 分钟）。
  const resetLimiter = new LoginLimiter();
  const registerLimiter = new FailLimiter({ max: REGISTER_MAX_FAILS, windowMs: REGISTER_WINDOW_MS, lockMs: REGISTER_LOCK_MS });
  const publicBase = config.publicBaseUrl || PUBLIC_BASE_URL_DEFAULT;
  const hotCache = new Map(); // 'nsfw'|'sfw' -> {at, items}
  const generating = new Set(); // chat id 正在生成

  // ---------- 日志（契约 §11）----------
  // 操作人 = 当前登录用户，ip = socket 远端地址（不信任 X-Forwarded-For）。写失败只 console.error，不影响业务。
  function audit(ctx, e) {
    writeLog(db, { actor: ctx?.user || null, ip: ctx?.req ? clientIp(ctx.req) || null : null, ...e });
  }
  const userLabel = (u) => (u ? `${u.username}${u.display_name && u.display_name !== u.username ? `（${u.display_name}）` : ''}` : '');
  // 已锁定期间的反复尝试每分钟最多记一条，防止被刷满日志表：
  // IP 整体被锁时按 IP 节流（换用户名也只算一条）；只有「用户名+IP」被锁时才按 用户名|IP 节流。
  // Map 有硬上限：清掉过期项后仍满，就不再记新 key（宁可少记，不让内存和日志表被刷涨）。
  const LOCKED_LOG_MAX_KEYS = 5000;
  const lockedLogAt = new Map();
  function shouldLogLocked(key) {
    const now = Date.now();
    const last = lockedLogAt.get(key);
    if (last !== undefined && now - last < LOCKED_LOG_THROTTLE_MS) return false;
    if (last === undefined && lockedLogAt.size >= LOCKED_LOG_MAX_KEYS) {
      for (const [k, t] of lockedLogAt) if (now - t >= LOCKED_LOG_THROTTLE_MS) lockedLogAt.delete(k);
      if (lockedLogAt.size >= LOCKED_LOG_MAX_KEYS) return false;
    }
    lockedLogAt.set(key, now);
    return true;
  }

  // ---------- 小工具 ----------
  // 写请求的请求体由 handleApi 先读完（ctx.rawBody），读完后再查一次会话、定角色，
  // 处理函数拿到的 ctx.user 一定是读完请求体之后的最新状态（防慢速请求体期间被降级/停用仍按旧权限执行）。
  // 同步解析：处理函数在鉴权与写库之间不会因为读请求体而让出事件循环。
  function readJson(ctx) {
    const raw = ctx.rawBody ?? '';
    if (!raw.trim()) return {};
    try {
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
      return v;
    } catch {
      throw new HttpError(400, '请求格式不正确');
    }
  }

  const userById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

  function adminUserView(u, today) {
    const usage = db.prepare('SELECT messages FROM usage_daily WHERE user_id = ? AND day = ?').get(u.id, today);
    const creator = u.created_by ? userById(u.created_by) : null;
    return {
      id: u.id,
      username: u.username,
      display_name: u.display_name || u.username,
      role: roleOf(u),
      is_admin: roleOf(u) !== 'tenant' ? 1 : 0,
      created_by: u.created_by ?? null,
      created_by_name: creator ? (creator.display_name || creator.username) : null,
      disabled: u.disabled ? 1 : 0,
      nsfw_enabled: u.nsfw_enabled ? 1 : 0,
      daily_limit: u.daily_limit ?? null,
      created_at: u.created_at,
      last_login_at: u.last_login_at || null,
      today_messages: usage?.messages || 0,
      deleted: u.deleted_at ? 1 : 0,
      deleted_at: u.deleted_at || null,
      note: u.note ?? null,
      invite_code_id: u.invite_code_id ?? null,
      must_change_password: u.must_change_password ? 1 : 0,
    };
  }

  // ---------- 会话对象：chub 角色或自建卡（契约 §12.1，二选一）----------
  const cardRowById = (id) => db.prepare('SELECT * FROM user_cards WHERE id = ?').get(Number(id));
  const cardAvatarUrl = (file) => (file && AVATAR_FILE_RE.test(file) ? `/api/card-avatar/${file}` : '');

  /** 文件会话（契约 §17）的资料行（不带全文）。 */
  const fileRowOf = (chatId) => db.prepare('SELECT id, chat_id, files_json, instruction, total_chars, mode, created_at FROM chat_files WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(chatId);
  const fileInfo = (f) => {
    const files = parseJson(f?.files_json, []) || [];
    return {
      files: files.map((x) => ({ name: x.name, type: x.type ?? null, chars: x.chars || 0, ok: !!x.ok, ...(x.error ? { error: x.error } : {}), ...(x.truncated ? { truncated: true } : {}) })),
      instruction: f?.instruction || '',
      mode: f?.mode || 'full',
      total_chars: f?.total_chars || 0,
      ...(f?.mode === 'retrieval' ? { notice: RETRIEVAL_NOTICE } : {}),
    };
  };
  /**
   * 文件会话的资料信息，instruction 给「生效值」（本会话设定里改过就用改后的，契约 §20.1），改过时另给 instruction_original。
   */
  const fileInfoOf = (c) => {
    const f = fileRowOf(c.id);
    const info = fileInfo(f);
    const eff = applyOverride({ instruction: f?.instruction || '' }, chatOverride(c)).instruction ?? '';
    return eff !== info.instruction ? { ...info, instruction: eff, instruction_original: info.instruction } : info;
  };
  /** 文件会话在列表 / 会话里显示的「角色」：文件图标 + 首个文件名（avatar 为空，kind='file'）。 */
  const fileSubject = (filesJson, full) => {
    const files = (parseJson(filesJson, []) || []).filter((x) => x.ok);
    const base = { path: null, user_card_id: null, kind: 'file', name: files[0]?.name || '文件', avatar: '', file_count: files.length };
    return full ? { ...base, tagline: '', tags: [], nsfw: false } : base;
  };

  /** 会话的「角色」：{type:'chub', row}、{type:'card', card} 或 {type:'file', file}。 */
  function subjectOf(c) {
    if (c.kind === 'file') return { type: 'file', file: fileRowOf(c.id) };
    if (c.user_card_id) return { type: 'card', card: cardRowById(c.user_card_id) };
    return { type: 'chub', row: chars.getRowById(c.character_id) };
  }

  /**
   * 自建卡在某个用户的会话里是否已不可用：卡已被作者删除、作者账号已删除，或卡被改成私有而看的人不是作者
   * （契约 §12.4「删后用户完全看不到」；v0.9 F3 覆盖改私有）。判定与「能不能继续聊」完全一致（cardUsableBy）。
   */
  const cardGoneForUsers = (k, viewer) => !viewer || !cardUsableBy(viewer, k);
  /** 已删卡在别人会话里的占位（不带名字、简介、标签、头像）。 */
  const goneSubject = (id, kind, full) => {
    const base = { path: null, user_card_id: id ?? null, kind: kind || 'character', name: GONE_CARD_NAME, avatar: '', unavailable: true };
    return full ? { ...base, tagline: '', tags: [], nsfw: false } : base;
  };

  /** 会话里显示的角色简要信息。自建卡 path 为 null，带 user_card_id 与 kind。隐藏对本人不可用的卡片。 */
  function subjectBrief(sub, { full = false, viewer = null } = {}) {
    if (sub.type === 'file') return fileSubject(sub.file?.files_json, full);
    if (sub.type === 'card') {
      const k = sub.card || {};
      if (cardGoneForUsers(sub.card, viewer)) return goneSubject(k.id, k.kind, full);
      const base = { path: null, user_card_id: k.id ?? null, kind: k.kind || 'character', name: k.name || '', avatar: cardAvatarUrl(k.avatar_file) };
      return full ? { ...base, tagline: k.tagline || '', tags: parseJson(k.tags_json, []), nsfw: !!k.nsfw } : base;
    }
    const card = rowToCard(sub.row);
    // 契约 §19.2：翻译可用时 name 给中文名，原名放 name_original（前端可小字附原名）
    const nm = chars.names(sub.row, viewer);
    const base = { path: card.path, user_card_id: null, kind: 'character', name: nm.name, name_zh: nm.name_zh, name_original: nm.name_original, avatar: mirrorCharacters.avatar(card.path), source: 'local' };
    return full ? { ...base, tagline: nm.tagline, tagline_zh: nm.tagline_zh, tagline_original: nm.tagline_original, tags: card.tags, nsfw: card.nsfw } : base;
  }

  /** 用户侧会话视图：费用只算未删消息（契约 §12.4）。 */
  function chatView(c, user) {
    const sub = subjectOf(c);
    const gone = sub.type === 'card' && cardGoneForUsers(sub.card, user);
    return {
      id: c.id,
      // v0.9 F4：卡对这个用户已不可用时，标题（建会话时取的卡名）也脱敏。
      title: gone ? GONE_CARD_NAME : c.title,
      kind: c.kind || (c.user_card_id ? 'user_card' : 'character'),
      character: subjectBrief(sub, { viewer: user }),
      model: models.brief(models.forChat(c, user)),
      ...costs.chatTotals(c.id),
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  }

  /** assistant 消息带计费字段（契约 §10.3）；用户消息不带。 */
  const costFields = (m) => (m.role === 'assistant'
    ? { cost_usd: m.cost_usd ?? null, cost_source: m.cost_source ?? null, tokens_in: m.tokens_in || 0, tokens_out: m.tokens_out || 0 }
    : {});
  const msgView = (m) => ({ id: m.id, role: m.role, content: m.content, created_at: m.created_at, ...costFields(m) });

  /** 本人的、未删除的会话；已删与从未存在的回应完全一致（契约 §12.4）。 */
  function ownChat(user, id) {
    const c = db.prepare('SELECT * FROM chats WHERE id = ?').get(Number(id));
    if (!c || c.user_id !== user.id || c.deleted_at) throw new HttpError(404, NOT_FOUND_CHAT);
    return c;
  }

  /**
   * 契约 §18.5：会话 / 消息被用户删除时，绑定的录音只标 deleted_at（保留文件存储，标记对应录音为已删除）；
   * 会话被删时，录在这个会话里、还没发送的录音也一并标记。
   */
  function markClipsDeleted(chatId, at = nowIso()) {
    db.prepare(`UPDATE voice_clips SET deleted_at = ? WHERE deleted_at IS NULL AND (
        message_id IN (SELECT id FROM messages WHERE chat_id = ? AND deleted_at IS NOT NULL)
        OR (message_id IS NULL AND chat_id = ? AND EXISTS (SELECT 1 FROM chats WHERE id = ? AND deleted_at IS NOT NULL)))`).run(at, chatId, chatId, chatId);
  }

  function effectiveLimit(user) {
    if (user.daily_limit !== null && user.daily_limit !== undefined) return Math.max(0, Number(user.daily_limit) || 0);
    return getSettings(db).default_daily_limit;
  }

  // 按用户的在途生成数：限额判断 = 已用 + 在途。checkLimit 与 reserve 在同一个同步段里完成，并发请求无法同时放行。
  const inflightByUser = new Map();
  function checkLimit(user) {
    const limit = effectiveLimit(user);
    if (!limit) return;
    const row = db.prepare('SELECT messages FROM usage_daily WHERE user_id = ? AND day = ?').get(user.id, sgDay());
    if ((row?.messages || 0) + (inflightByUser.get(user.id) || 0) >= limit) throw new HttpError(429, '今天的消息额度已用完');
  }
  function reserveSlot(userId) {
    inflightByUser.set(userId, (inflightByUser.get(userId) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (inflightByUser.get(userId) || 1) - 1;
      if (n > 0) inflightByUser.set(userId, n); else inflightByUser.delete(userId);
    };
  }

  /** messages=0：只记 token 与花费、不占每日条数（上游已扣费但没生成可保存的回复）。 */
  function recordUsage(userId, tokensIn, tokensOut, costUsd, messages = 1) {
    db.prepare(`
      INSERT INTO usage_daily(user_id, day, messages, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, day) DO UPDATE SET messages = messages + excluded.messages, tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out,
        cost_usd = cost_usd + excluded.cost_usd
    `).run(userId, sgDay(), messages, tokensIn || 0, tokensOut || 0, costUsd || 0);
  }

  // ---------- 登录 ----------
  async function login(ctx) {
    const b = await readJson(ctx);
    const username = str(b.username, 64).trim();
    const password = str(b.password, 256);
    const ip = clientIp(ctx.req);
    const ua = uaOf(ctx.req); // 契约 §14：登录事件记 user_agent（截断 300 字）
    if (!username || !password) throw new HttpError(400, '请输入用户名和密码');
    // 失败日志写尝试的用户名与原因，绝不写密码（契约 §11.2）。
    // 操作人是未登录的请求方，不是被尝试的账号：actor 留空，被尝试的账号只放 target 与 detail.username。
    const failLog = (u, reason) => writeLog(db, {
      level: 'warn', kind: 'auth.login', actor_id: null, actor_name: null, ip: ip || null,
      target_type: 'user', target_id: u ? u.id : null,
      summary: `登录失败：${username}（${reason}）`, detail: { result: 'fail', username, reason, user_agent: ua },
    });
    if (limiter.isLocked(username, ip)) {
      const throttleKey = limiter.ipLocked(ip) ? `ip|${ip}` : `user|${username.toLowerCase()}|${ip}`;
      if (shouldLogLocked(throttleKey)) {
        failLog(db.prepare('SELECT id, username, display_name FROM users WHERE username = ? AND deleted_at IS NULL').get(username), '锁定');
      }
      throw new HttpError(429, '尝试次数过多，请 10 分钟后再试');
    }
    const found = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    // 契约 §12.4：软删的账号不能登录，对外与不存在完全一样（用户名仍被占用）。
    const u = found && !found.deleted_at ? found : null;
    // 用户不存在也跑一遍 scrypt（对假哈希），让响应耗时一致，防凭耗时枚举用户名。
    const ok = verifyPassword(password, u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok) {
      const locked = limiter.fail(username, ip);
      failLog(u, u ? '密码错误' : '账号不存在');
      if (locked.user || locked.ip) {
        writeLog(db, {
          level: 'warn', kind: 'auth.lockout', actor_id: null, actor_name: null, ip: ip || null,
          target_type: 'user', target_id: u ? u.id : null,
          summary: locked.ip ? `IP ${ip} 登录失败次数过多，已锁定 10 分钟` : `${username} 连续登录失败，已锁定 10 分钟`,
          detail: { username, scope: locked.ip ? 'ip' : 'user', minutes: 10, user_agent: ua },
        });
      }
      throw new HttpError(401, '用户名或密码错误');
    }
    if (u.disabled) { failLog(u, '停用'); throw new HttpError(403, '账号已停用，请联系管理员'); }
    limiter.succeed(username, ip);
    const token = createSession(db, u.id);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), u.id);
    ctx.setCookie = sessionCookie(token, ctx.req, Math.floor(SESSION_TTL_MS / 1000));
    writeLog(db, { kind: 'auth.login', actor: u, ip: ip || null, target_type: 'user', target_id: u.id, summary: `${userLabel(u)} 登录成功`, detail: { result: 'ok', username: u.username, user_agent: ua } });
    return { user: publicUser(u) };
  }

  function logout(ctx) {
    let who = null;
    try { who = lookupSession(db, ctx.req)?.user || null; } catch { /* 查不到就不记 */ }
    destroySession(db, parseCookies(ctx.req.headers.cookie)[COOKIE_NAME]);
    if (who) audit({ ...ctx, user: who }, { kind: 'auth.logout', target_type: 'user', target_id: who.id, summary: `${userLabel(who)} 退出登录` });
    ctx.setCookie = sessionCookie('', ctx.req, 0);
    return { ok: true };
  }

  // v0.9 F9：未登录不再回 401（避免控制台网络错误），回 200 {user:null}；只有这一个接口这样，其余照旧 401。
  const me = (ctx) => ({ user: ctx.user ? publicUser(ctx.user) : null, site_name: getSettings(db).site_name });

  async function patchMe(ctx) {
    const b = await readJson(ctx);
    const sets = [];
    const vals = [];
    if (b.display_name !== undefined) {
      const v = str(b.display_name, 40).trim();
      if (!v) throw new HttpError(400, '显示名不能为空');
      sets.push('display_name = ?'); vals.push(v);
    }
    if (b.nsfw_enabled !== undefined) { sets.push('nsfw_enabled = ?'); vals.push(b.nsfw_enabled ? 1 : 0); }
    if (b.persona_name !== undefined) { sets.push('persona_name = ?'); vals.push(str(b.persona_name, 40).trim()); }
    if (b.persona_desc !== undefined) { sets.push('persona_desc = ?'); vals.push(str(b.persona_desc, 2000).trim()); }
    if (b.voice_auto_send !== undefined) { sets.push('voice_auto_send = ?'); vals.push(b.voice_auto_send ? 1 : 0); } // 契约 §18.3
    if (b.default_model_id !== undefined) {
      const m = models.requireEnabled(b.default_model_id);
      sets.push('default_model_id = ?'); vals.push(m ? m.id : null);
    }
    if (b.reading_settings !== undefined) {
      const v = mergeReadingSettings(userById(ctx.user.id)?.reading_settings_json, b.reading_settings);
      sets.push('reading_settings_json = ?'); vals.push(JSON.stringify(v));
    }
    if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, ctx.user.id);
    return { user: publicUser(userById(ctx.user.id)), site_name: getSettings(db).site_name };
  }

  async function changePassword(ctx) {
    const b = await readJson(ctx);
    const op = str(b.old_password, 256);
    if (!verifyPassword(op, ctx.user.password_hash)) throw new HttpError(400, '原密码不正确');
    const np = str(b.new_password, 256);
    if (np.length < 8) throw new HttpError(400, '新密码至少 8 位');
    if (np === op) throw new HttpError(400, '新密码不能与原密码相同');
    // 改密后清掉「首次登录强制改密」标记（契约 §13.3）。
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(np), ctx.user.id);
    // 所有旧会话一并作废，当前设备换发新会话。
    destroyUserSessions(db, ctx.user.id);
    const token = createSession(db, ctx.user.id);
    ctx.setCookie = sessionCookie(token, ctx.req, Math.floor(SESSION_TTL_MS / 1000));
    audit(ctx, {
      kind: 'auth.password_change', target_type: 'user', target_id: ctx.user.id,
      summary: `${userLabel(ctx.user)} ${ctx.user.must_change_password ? '设置了新密码（首次登录）' : '修改了自己的密码'}`,
      ...(ctx.user.must_change_password ? { detail: { first_login: true } } : {}),
    });
    return { ok: true, user: publicUser(userById(ctx.user.id)) };
  }

  // ---------- 角色 ----------
  function adultRole(path, evidence = {}) {
    const adult = row => {
      const tags = Array.isArray(row?.tags) ? row.tags : parseJson(row?.tags_json ?? row?.topics_json ?? '[]', []);
      return !!row?.nsfw || !!row?.nsfw_image ||
        (Array.isArray(tags) && tags.some(t => String(t).trim().toUpperCase() === 'NSFW'));
    };
    return adult(evidence) || adult(mirrorCharacters.metadata(path));
  }
  const allowedRole = (path, evidence, nsfw) => nsfw || !adultRole(path, evidence);

  // 应用缓存也属于本地资料。只取列表字段，完整卡与私有卡不进入此查询。
  function cachedRoleCards({ kw = '', tag = '', nsfw = false } = {}) {
    const params = [], where = ["card_json IS NOT NULL", "length(trim(card_json))>2"];
    if (kw) {
      const pattern = '%' + kw.replace(/[\\%_]/g, '\\$&') + '%';
      where.push("(name LIKE ? ESCAPE '\\' OR tagline LIKE ? ESCAPE '\\' OR name_zh LIKE ? ESCAPE '\\' OR tagline_zh LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern, pattern, pattern);
    }
    return db.prepare(`SELECT id,chub_path,name,tagline,name_zh,tagline_zh,avatar_url,tags_json,nsfw
      FROM characters WHERE ${where.join(' AND ')} ORDER BY id DESC`).all(...params)
      .filter(r => allowedRole(r.chub_path, r, nsfw))
      .map(r => ({ ...rowToCard(r), name_zh: r.name_zh, tagline_zh: r.tagline_zh, nsfw: adultRole(r.chub_path, r), cache_id: r.id }))
      .filter(c => !tag || c.tags.some(t => String(t).toLowerCase() === tag.toLowerCase()));
  }
  function cachePage(items, { kw, tag, sort, nsfw, cursor = '', offset = 0, limit = 24 }) {
    const filter = createHash('sha256').update(JSON.stringify([kw, tag, sort, nsfw])).digest('hex');
    let after = Number.MAX_SAFE_INTEGER;
    if (cursor) {
      try {
        if (cursor.length > 1024 || !/^cache\.[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const raw = cursor.slice(6), decoded = Buffer.from(raw, 'base64url').toString('utf8');
        if (Buffer.from(decoded).toString('base64url') !== raw) throw new Error();
        const c = JSON.parse(decoded);
        if (Object.keys(c).sort().join(',') !== 'after,filter,v' || c.v !== 1 || c.filter !== filter
            || !Number.isSafeInteger(c.after) || c.after < 1) throw new Error();
        after = c.after;
      } catch { throw new HttpError(400, '分页游标已失效，请重新加载', 'invalid_cursor'); }
    }
    const rest = items.filter(c => c.cache_id < after).slice(cursor ? 0 : offset);
    const shown = rest.slice(0, limit), hasMore = rest.length > limit;
    return { items: shown.map(({ cache_id, ...item }) => item), has_more: hasMore,
      next_cursor: hasMore ? 'cache.' + Buffer.from(JSON.stringify({ v: 1, after: shown.at(-1)?.cache_id ?? after, filter })).toString('base64url') : null };
  }
  async function hot(nsfw) {
    const k = nsfw ? 'nsfw' : 'sfw';
    const c = hotCache.get(k);
    if (c && Date.now() - c.at < HOT_TTL_MS) return c.items;
    try {
      const r = await chub.search({ q: '', sort: 'trending_downloads', page: 1, nsfw });
      const items = r.items.slice(0, HOT_COUNT);
      hotCache.set(k, { at: Date.now(), items });
      return items;
    } catch (e) {
      console.error('[home] hot failed:', e?.message || e);
      return c ? c.items : [];
    }
  }

  function shelvesWithItems({ nsfw = true } = {}) {
    const shelves = db.prepare('SELECT * FROM shelves ORDER BY sort, id').all();
    const items = db.prepare(`
      SELECT si.shelf_id, c.* FROM shelf_items si JOIN characters c ON c.id = si.character_id
      ORDER BY si.shelf_id, si.sort, c.id
    `).all();
    return shelves.map((s) => ({
      id: s.id,
      title: s.title,
      sort: s.sort,
      items: items.filter((r) => r.shelf_id === s.id && allowedRole(r.chub_path, r, nsfw)).map(r => {
        const card = rowToCard(r); return { ...card, avatar: mirrorAvatar(card.path, card.avatar, card) };
      }),
    }));
  }

  // 默认只读已有译文；明确选择外网资料时保留原后台翻译流程。
  const cachedListNames = db.prepare('SELECT name,tagline,name_zh,tagline_zh FROM characters WHERE chub_path=?');
  const cachedListTranslation = db.prepare('SELECT name,tagline,name_zh,tagline_zh FROM chub_list_zh WHERE path=?');
  function localize(items, user, source = 'local') {
    items = items.filter(item => allowedRole(item.path, item, !!user?.nsfw_enabled));
    if (source === 'remote') return chars.translations.localizeCards(items, { userId: user?.id ?? null })
      .map(item => ({ ...item, source, nsfw: adultRole(item.path, item), avatar: remoteAvatar(item.path, item.avatar, item) }));
    const tags = chars.translations.tagMap(items.flatMap(c => c.tags || []));
    return items.map(item => {
      let nameZh = item.name_zh ?? null, taglineZh = item.tagline_zh ?? null;
      for (const query of [cachedListNames, cachedListTranslation]) {
        const cached = query.get(item.path);
        if (cached && cached.name === item.name && cached.tagline === (item.tagline || '')) {
          nameZh ??= cached.name_zh; taglineZh ??= cached.tagline_zh;
        }
      }
      return { ...item, source: 'local', local: true, nsfw: adultRole(item.path, item), name_zh: nameZh, tagline_zh: taglineZh,
        tags_zh: (item.tags || []).map(t => tags.get(String(t)) ?? String(t)),
        avatar: mirrorCharacters.avatar(item.path), translating: false };
    });
  }

  async function home(ctx) {
    const source = characterSource(ctx.url.searchParams.get('source'));
    const nsfw = !!ctx.user.nsfw_enabled;
    const shelves = shelvesWithItems({ nsfw }).filter((s) => s.items.length).map(({ id, title, items }) => ({ id, title, items: localize(items, ctx.user, source) }));
    const items = source === 'local' ? (mirrorCharacters.available()
      ? mirrorCharacters.list({ nsfw, limit: HOT_COUNT }).items
      : cachedRoleCards({ nsfw }).slice(0, HOT_COUNT).map(({ cache_id, ...item }) => item)) : await hot(nsfw);
    return { source, mirror_available: mirrorCharacters.available(), shelves, hot: localize(items, ctx.user, source) };
  }

  async function search(ctx) {
    const s = getSettings(db);
    if (!s.allow_user_chub_search && roleOf(ctx.user) === 'tenant') throw new HttpError(403, '搜索功能暂未开放');
    const q = ctx.url.searchParams;
    const sort = q.get('sort') || 'download_count';
    if (!SORTS.includes(sort)) throw new HttpError(400, '排序方式不正确');
    const page = Math.min(100, Math.max(1, parseInt(q.get('page') || '1', 10) || 1));
    const kw = str(q.get('q'), 200).trim();
    const tag = str(q.get('tag'), 100).trim();
    const nsfw = !!ctx.user.nsfw_enabled;
    const source = characterSource(q.get('source'));
    if (source === 'local') {
      const cursor = q.get('cursor') || '', available = mirrorCharacters.available();
      const cached = cachedRoleCards({ kw, tag, nsfw });
      const orphan = available ? cached.filter(c => !mirrorCharacters.metadata(c.path)) : cached;
      const filter = { kw, tag, sort, nsfw };
      if (cursor.startsWith('cache.') || !available) {
        const r = cachePage(orphan, { ...filter, cursor, offset: (page - 1) * 24 });
        return { ...r, source, page, available: available || orphan.length > 0, mirror_available: available,
          cache_only: !available, items: localize(r.items, ctx.user) };
      }
      const listNames = kw ? db.prepare("SELECT path FROM chub_list_zh WHERE name_zh LIKE ? ESCAPE '\\' OR tagline_zh LIKE ? ESCAPE '\\'")
        .all(...Array(2).fill('%' + kw.replace(/[\\%_]/g, '\\$&') + '%')).map(r => r.path) : [];
      const r = mirrorCharacters.list({ q: kw, tag, sort, page, nsfw, cursor,
        includePaths: kw ? [...new Set([...cached.map(c => c.path), ...listNames])] : [] });
      if (r.has_more || !orphan.length) return { ...r, mirror_available: true, items: localize(r.items, ctx.user) };
      const extra = cachePage(orphan, { ...filter, limit: Math.max(0, 24 - r.items.length) });
      return { ...r, has_more: extra.has_more, next_cursor: extra.next_cursor, mirror_available: true,
        items: localize([...r.items, ...extra.items], ctx.user) };
    }
    // 契约 §19.2：本地缓存过的卡支持中文名搜索（在 chub 结果之外，额外匹配 name_zh / tagline_zh），第一页排在前面。
    const local = page === 1 && !tag ? chars.translations.searchLocal(kw, { nsfw }).map((x) => (x.row ? rowToCard(x.row) : x.snap)) : [];
    let r;
    try {
      r = await chub.search({ q: kw, tag, sort, page, nsfw });
    } catch (e) {
      if (!local.length) throw e;
      r = { items: [], page, has_more: false }; // chub 暂时连不上但本地有命中：先给本地的
    }
    const seen = new Set(local.map((c) => c.path));
    const items = [...local.map((c) => ({ ...c, local: true })), ...r.items.filter((c) => !seen.has(c.path))];
    return { ...r, source, items: localize(items, ctx.user, source) };
  }

  /**
   * 角色详情（契约 §19）：秒开——不等翻译；第一次打开（或源卡变了）在后台开始整卡翻译，
   * 前端按 translate_status（pending → ok / partial / failed）轮询本接口，翻完自动替换为中文。
   */
  async function characterDetail(ctx, path) {
    const source = characterSource(ctx.url.searchParams.get('source'));
    let row = await chars.ensure(path, { user: ctx.user, translate: false, source });
    if (source === 'remote') row = chars.kickTranslation(row, ctx.user) || row;
    const character = chars.detail(row, ctx.user);
    character.nsfw = adultRole(path, row);
    character.source = source;
    character.avatar = source === 'local' ? mirrorCharacters.avatar(path) : remoteAvatar(character.path, character.avatar, character);
    return { character };
  }

  /** 「重试翻译」（契约 §19.2：翻译失败显示原文并提供重试）。每人每分钟最多 6 次。 */
  const retryHits = new Map();
  async function characterRetranslate(ctx, path) {
    const b = readJson(ctx);
    const source = characterSource(ctx.url.searchParams.get('source') ?? b.source);
    const manual = Object.hasOwn(b, 'model_id') || Object.hasOwn(b, 'force');
    if (Object.hasOwn(b, 'force') && typeof b.force !== 'boolean') throw new HttpError(400, 'force 必须是布尔值');
    if (manual && b.model_id !== null && b.model_id !== undefined
      && (typeof b.model_id !== 'number' || !Number.isSafeInteger(b.model_id) || (b.model_id < 1 && ![-4505,-4507].includes(b.model_id)))) {
      throw new HttpError(400, '请选择有效的翻译模型');
    }
    const picked = manual && b.model_id !== null && b.model_id !== undefined ? chars.translations.requireModel(b.model_id) : null;
    const now = Date.now();
    const hits = (retryHits.get(ctx.user.id) || []).filter((t) => t > now - 60_000);
    if (hits.length >= 6) throw new HttpError(429, '操作太频繁，请稍后再试');
    hits.push(now);
    retryHits.set(ctx.user.id, hits);
    if (retryHits.size > 5000) for (const [k, v] of retryHits) if (!v.some((t) => t > now - 60_000)) retryHits.delete(k);
    const row0 = chars.getRow(path);
    if (!row0) throw new HttpError(404, '没有找到这个角色');
    let row = await chars.ensure(path, { user: ctx.user, translate: false, source });
    row = (manual ? chars.manualTranslation(row, ctx.user, { modelId: picked?.id ?? null, force: b.force === true })
      : chars.retryTranslation(row, ctx.user)) || row;
    const character = chars.detail(row, ctx.user);
    character.nsfw = adultRole(path, row);
    character.source = source;
    character.avatar = source === 'local' ? mirrorCharacters.avatar(path) : remoteAvatar(character.path, character.avatar, character);
    return { character };
  }

  /** 历史列表与切换只读已存译文；角色权限检查和原文来源与详情一致。 */
  async function characterTranslations(ctx, path) {
    const source = characterSource(ctx.url.searchParams.get('source'));
    const row = await chars.ensure(path, { user: ctx.user, translate: false, source });
    const rawBefore = ctx.url.searchParams.get('before_id');
    const rawLimit = ctx.url.searchParams.get('limit');
    const beforeId = rawBefore === null ? null : Number(rawBefore);
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if ((rawBefore !== null && (!/^\d+$/.test(rawBefore) || !Number.isSafeInteger(beforeId) || beforeId < 1))
      || (rawLimit !== null && (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200))) {
      throw new HttpError(400, '历史分页参数不正确');
    }
    return chars.translationHistory(row, ctx.user, { beforeId, limit });
  }

  async function characterSelectTranslation(ctx, path) {
    const b = readJson(ctx);
    if (!Object.hasOwn(b, 'translation_id') || (b.translation_id !== null
      && (typeof b.translation_id !== 'number' || !Number.isSafeInteger(b.translation_id) || b.translation_id < 1))) {
      throw new HttpError(400, '请选择有效的历史译文');
    }
    const source = characterSource(ctx.url.searchParams.get('source') ?? b.source);
    let row = await chars.ensure(path, { user: ctx.user, translate: false, source });
    row = chars.selectTranslation(row, ctx.user, b.translation_id) || row;
    const character = chars.detail(row, ctx.user);
    character.nsfw = adultRole(path, row);
    character.source = source;
    character.avatar = source === 'local' ? mirrorCharacters.avatar(path) : remoteAvatar(character.path, character.avatar, character);
    return { character };
  }

  async function avatar(ctx) {
    const u = ctx.url.searchParams.get('u') || '';
    const p = ctx.url.searchParams.get('p') || '';
    let image;
    if (p) {
      image = await mirrorImages.readAvatar(p, ctx.user);
      if (!image) {
        const remote = mirrorImages.avatarRemote(p, ctx.user);
        if (!remote) throw new HttpError(404, '没有找到这张图片');
        image = await avatars.get(remote);
      }
      const session = lookupSession(db, ctx.req);
      if (!session) throw new HttpError(401, '请先登录');
      mirrorImages.avatarRemote(p, session.user);
    } else {
      image = await avatars.get(mirrorImages.avatarLegacy(u, ctx.user));
      const session = lookupSession(db, ctx.req);
      if (!session) throw new HttpError(401, '请先登录');
      mirrorImages.avatarLegacy(u, session.user);
    }
    const { type, buf } = image;
    const cache = previewCacheHeaders(buf);
    if (previewNotModified(ctx, cache.ETag)) {
      ctx.res.writeHead(304, { ...BASE_HEADERS, ...cache });
      ctx.res.end(); return;
    }
    ctx.res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': type,
      'Content-Length': buf.length,
      ...cache,
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : buf);
    return undefined;
  }

  function imageList(ctx) {
    return mirrorImages.list({ ...parseImageQuery(ctx.url.searchParams), user: ctx.user });
  }
  function characterImages(ctx) {
    return mirrorImages.list({ ...parseImageQuery(ctx.url.searchParams, { characterRequired: true }), user: ctx.user });
  }
  function previewCacheHeaders(buf) {
    return { 'Cache-Control': 'private, no-cache', Vary: 'Cookie',
      ETag: `"${createHash('sha256').update(buf).digest('hex')}"` };
  }
  function previewNotModified(ctx, etag) {
    return String(ctx.req.headers['if-none-match'] || '').split(',')
      .some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag);
  }
  async function imageMedia(ctx, id) {
    const variant = ctx.url.searchParams.get('variant') || 'original';
    const image = await mirrorImages.read(id, { variant, user: ctx.user });
    // NAS读取与缩图可能让出事件循环：响应前重新确认会话和成人开关。
    const session = lookupSession(db, ctx.req);
    if (!session) throw new HttpError(401, '请先登录');
    mirrorImages.assertAllowed(id, session.user);
    const cache = variant === 'thumb' && ctx.url.searchParams.get('download') !== '1'
      ? previewCacheHeaders(image.buf) : { 'Cache-Control': 'private, no-store' };
    if (cache.ETag && previewNotModified(ctx, cache.ETag)) {
      ctx.res.writeHead(304, { ...BASE_HEADERS, ...cache });
      ctx.res.end(); return;
    }
    ctx.res.writeHead(200, {
      ...BASE_HEADERS, 'Content-Type': image.type, 'Content-Length': image.buf.length,
      ...cache,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      ...(ctx.url.searchParams.get('download') === '1' ? { 'Content-Disposition': `attachment; filename="${image.filename}"` } : {}),
    });
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : image.buf);
  }

  // ---------- 聊天 ----------
  /** 列表行 → 会话里的角色简要信息（chub 或自建卡）。 */
  /** 列表行里的自建卡是否对 viewer 不可用（与 cardGoneForUsers 同一判定）。 */
  const listCardGone = (r, viewer) => !!r.user_card_id && (!r.card_owner_id
    || cardGoneForUsers({ id: r.user_card_id, owner_id: r.card_owner_id, deleted_at: r.card_deleted_at, visibility: r.card_visibility }, viewer));
  function listSubject(r, { viewer = null } = {}) {
    if (r.kind === 'file') return fileSubject(r.file_files_json, false);
    if (r.user_card_id) {
      if (listCardGone(r, viewer)) return goneSubject(r.user_card_id, r.card_kind, false);
      return { path: null, user_card_id: r.user_card_id, kind: r.card_kind || 'character', name: r.card_name || '', avatar: cardAvatarUrl(r.card_avatar_file) };
    }
    const nm = chars.names({
      id: r.character_id,
      name: r.char_name, tagline: r.char_tagline, card_json: r.char_card_json, card_json_zh: r.char_has_zh ? '1' : null,
      translate_status: r.char_translate_status, translate_hash: r.char_translate_hash, name_zh: r.char_name_zh, tagline_zh: r.char_tagline_zh,
    }, viewer);
    return { path: r.chub_path, user_card_id: null, kind: 'character', name: nm.name, name_zh: nm.name_zh, name_original: nm.name_original,
      avatar: mirrorCharacters.avatar(r.chub_path), source: 'local' };
  }
  const SUBJECT_COLS = `c.chub_path, c.name AS char_name, c.avatar_url, c.nsfw AS char_nsfw, c.tags_json AS char_tags_json,
        c.tagline AS char_tagline, c.card_json AS char_card_json, (c.card_json_zh IS NOT NULL) AS char_has_zh, c.translate_status AS char_translate_status,
        c.translate_hash AS char_translate_hash, c.name_zh AS char_name_zh, c.tagline_zh AS char_tagline_zh,
        uc.name AS card_name, uc.kind AS card_kind, uc.avatar_file AS card_avatar_file, uc.deleted_at AS card_deleted_at, uc.owner_id AS card_owner_id,
        uc.visibility AS card_visibility,
        (SELECT cf.files_json FROM chat_files cf WHERE cf.chat_id = ch.id ORDER BY cf.id DESC LIMIT 1) AS file_files_json`;
  const SUBJECT_JOIN = 'LEFT JOIN characters c ON c.id = ch.character_id LEFT JOIN user_cards uc ON uc.id = ch.user_card_id';

  function listChats(ctx) {
    // 契约 §12.4：只列未删除的会话；最后一条与费用只算未删消息。
    const rows = db.prepare(`
      SELECT ch.*, ${SUBJECT_COLS},
        (SELECT content FROM messages m WHERE m.chat_id = ch.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) AS last_message,
        ${CHAT_COST_SQL_LIVE}
      FROM chats ch ${SUBJECT_JOIN}
      WHERE ch.user_id = ? AND ch.deleted_at IS NULL ORDER BY ch.updated_at DESC, ch.id DESC
    `).all(ctx.user.id);
    return {
      items: rows.map((r) => ({
        id: r.id,
        character: listSubject(r, { viewer: ctx.user }),
        title: listCardGone(r, ctx.user) ? GONE_CARD_NAME : r.title,
        kind: r.kind || (r.user_card_id ? 'user_card' : 'character'),
        model: models.brief(models.forChat(r, ctx.user)),
        last_message: (r.last_message || '').slice(0, 200),
        cost_usd: round6(r.cost_sum),
        cost_partial: !!r.cost_unpriced,
        updated_at: r.updated_at,
      })),
    };
  }

  async function createChat(ctx) {
    const b = await readJson(ctx);
    // 指定了就必须是启用的；没指定就用当时解析出的默认模型，写进 chats.model_id。
    const picked = b.model_id === undefined || b.model_id === null || b.model_id === '' ? null : models.requireEnabled(b.model_id);
    if (b.user_card_id !== undefined && b.user_card_id !== null && b.user_card_id !== '') return createCardChat(ctx, b, picked);
    const path = str(b.path, 300).trim();
    // 契约 §19.2：有在途的整卡翻译就等它（拿中文开场白与中文名），否则单独翻开场白。
    const row = await chars.ensureForChat(path, ctx.user, { source: characterSource(b.source) });
    const modelRow = picked || models.userDefault(ctx.user);
    const charName = chars.displayName(row, ctx.user);
    const greeting = applyMacros(chars.greetingZhOf(row, ctx.user), { char: charName, user: userCallName(ctx.user) });
    const now = nowIso();
    const chat = tx(db, () => {
      const r = db.prepare('INSERT INTO chats(user_id, character_id, title, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(ctx.user.id, row.id, charName, modelRow ? modelRow.id : null, now, now);
      const id = Number(r.lastInsertRowid);
      if (greeting.trim()) {
        db.prepare('INSERT INTO messages(chat_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(id, 'assistant', greeting, now);
      }
      return db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
    });
    return { chat: chatView(chat, ctx.user) };
  }

  /** POST /api/chats {user_card_id}：用自建卡开聊（私有卡只有作者，公开卡任何人；契约 §12.2）。 */
  function createCardChat(ctx, b, picked) {
    const card = usableCard(ctx.user, b.user_card_id);
    const modelRow = picked || models.userDefault(ctx.user);
    const data = parseJson(card.card_json, {});
    const greeting = applyMacros(data.first_mes || '', { char: card.name, user: userCallName(ctx.user) });
    const now = nowIso();
    const chat = tx(db, () => {
      const r = db.prepare("INSERT INTO chats(user_id, character_id, user_card_id, kind, title, model_id, created_at, updated_at) VALUES (?, NULL, ?, 'user_card', ?, ?, ?, ?)")
        .run(ctx.user.id, card.id, card.name, modelRow ? modelRow.id : null, now, now);
      const id = Number(r.lastInsertRowid);
      if (greeting.trim()) {
        db.prepare('INSERT INTO messages(chat_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(id, 'assistant', greeting, now);
      }
      return db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
    });
    return { chat: chatView(chat, ctx.user) };
  }

  /** PATCH /api/chats/:id {model_id}：切换模型，下一条回复起生效。null = 跟随默认。 */
  async function patchChat(ctx, id) {
    const c = ownChat(ctx.user, id);
    const b = await readJson(ctx);
    if (b.model_id === undefined) throw new HttpError(400, '请选择模型');
    const m = models.requireEnabled(b.model_id);
    db.prepare('UPDATE chats SET model_id = ? WHERE id = ?').run(m ? m.id : null, c.id);
    const fresh = db.prepare('SELECT * FROM chats WHERE id = ?').get(c.id);
    return { chat: chatView(fresh, ctx.user) };
  }

  function getChat(ctx, id) {
    const c = ownChat(ctx.user, id);
    const messages = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND deleted_at IS NULL ORDER BY id').all(c.id).map(msgView);
    return {
      chat: { ...chatView(c, ctx.user), settings_modified: !!(c.card_override_json || c.persona_override_json) },
      character: subjectBrief(subjectOf(c), { full: true, viewer: ctx.user }),
      ...(c.kind === 'file' ? { file: fileInfoOf(c) } : {}), // 契约 §17.4：不返回全文
      messages,
      events: chatEvents(c.id), // 契约 §20.1：「已更新本会话设定」等系统提示（after_message_id 之后显示）
    };
  }

  /** 删会话 = 软删（契约 §12.4）：会话与其未删消息都只设 deleted_at，用户侧从此完全看不到。 */
  function deleteChat(ctx, id) {
    const c = ownChat(ctx.user, id);
    if (generating.has(c.id)) throw new HttpError(409, '回复还在生成中，请稍后再删');
    const now = nowIso();
    const n = tx(db, () => {
      const r = db.prepare("UPDATE messages SET deleted_at = ?, deleted_reason = 'chat_delete' WHERE chat_id = ? AND deleted_at IS NULL").run(now, c.id);
      db.prepare('UPDATE chats SET deleted_at = ? WHERE id = ?').run(now, c.id);
      markClipsDeleted(c.id, now);
      return Number(r.changes || 0);
    });
    audit(ctx, {
      kind: 'chat.delete', target_type: 'chat', target_id: c.id,
      summary: `${userLabel(ctx.user)} 删除了会话 ${c.id}（${c.title || '未命名'}）`,
      detail: { chat_id: c.id, title: c.title, messages: n, user_card_id: c.user_card_id ?? null },
    });
    return { ok: true };
  }

  /**
   * 公共的生成流程。prepare() 在开流前做校验并返回 {userMessage?, extraUser?, events?}：
   * userMessage 先推送；extraUser 附在提示词最后（不存库，文件会话首条引导用）；events 在最前面推送（如新建会话的 chat）。
   * json=true：不开 SSE，事件收集起来返回（文件会话创建的同步模式）；客户端断开也照常生成并保存。
   */
  async function generate(ctx, chatId, prepare, { json = false } = {}) {
    const user = ctx.user;
    const c = ownChat(user, chatId);
    const sub = subjectOf(c);
    if (sub.type === 'card') {
      // 自建卡会话：卡被作者删除 / 改成私有后，别人不能再继续聊（作者本人删卡时会话已一并软删）。
      if (!cardUsableBy(user, sub.card)) throw new HttpError(403, CARD_GONE);
      if (sub.card.nsfw && !user.nsfw_enabled) throw new HttpError(403, NSFW_FORBIDDEN);
    } else if (sub.type === 'chub' && sub.row && !allowedRole(sub.row.chub_path, sub.row, !!user.nsfw_enabled)) throw new HttpError(403, NSFW_FORBIDDEN);
    if (generating.has(c.id)) throw new HttpError(409, '上一条回复还在生成中');
    checkLimit(user);
    generating.add(c.id);
    const releaseSlot = reserveSlot(user.id); // 与 checkLimit 同一同步段，防并发绕过每日上限
    let pre;
    try {
      pre = await prepare(c); // 可能抛 HttpError（仍在 JSON 阶段）
    } catch (e) {
      releaseSlot();
      generating.delete(c.id);
      throw e;
    }

    const { res } = ctx;
    const collected = [];
    let send;
    const ac = new AbortController();
    const onClose = () => { if (!res.writableEnded) ac.abort(); };
    let ping = null;
    if (json) {
      send = (event, data) => { collected.push({ event, data }); };
    } else {
      res.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      send = (event, data) => { if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      res.on('close', onClose);
      ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
    }

    // 解析顺序（契约 §8.2）：会话模型 → 用户默认 → 全站默认 → 第一个启用的；停用的自动回落。
    const modelRow = models.forChat(c, user);
    let promptText = '';
    // 计费（契约 §10.2）：上游 usage → 实价（xAI ticks）或按单价推算；没有 usage（停止 / 中断）按字数粗估。
    // 用当次调用实际用的模型行（llm 回 model_id）；单价取当前设置。
    const saveAssistant = (text, r) => {
      const now = nowIso();
      const billedModel = (r?.model_id && models.byId(r.model_id)) || modelRow;
      const k = costs.forReply(billedModel, r, { text, promptText, at: now });
      return tx(db, () => {
        const ins = db.prepare(`INSERT INTO messages(chat_id, role, content, created_at, tokens_in, tokens_out, model, tokens_in_cached, tokens_reasoning, cost_usd, cost_source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(c.id, 'assistant', text, now, k.tokens_in, k.tokens_out, r?.model || modelRow?.model || config.deepseekModel || null,
            k.tokens_in_cached, k.tokens_reasoning, k.cost_usd, k.cost_source);
        db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now, c.id);
        recordUsage(user.id, k.tokens_in, k.tokens_out, k.cost_usd);
        releaseSlot(); // 用量已落库，在途计数同步释放
        return db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(ins.lastInsertRowid));
      });
    };
    // 上游已回 usage（已扣费）但没有可保存的正文（只出了思考 token / 过滤发生在 usage 之后等）：
    // 不写空消息，只把 token 与花费记进 usage_daily（不占每日条数），免得用量页漏账。会话合计里没有这一笔。
    let billedOnly = false;
    const recordBilledOnly = (r) => {
      if (billedOnly || !r?.usage) return;
      billedOnly = true;
      try {
        const billedModel = (r.model_id && models.byId(r.model_id)) || modelRow;
        const k = costs.forReply(billedModel, r, { text: '', promptText, at: nowIso() });
        recordUsage(user.id, k.tokens_in, k.tokens_out, k.cost_usd, 0);
      } catch (err) { console.error('[chat] record usage failed', err?.message); }
    };

    try {
      for (const ev of pre?.events || []) send(ev.event, ev.data);
      if (pre?.userMessage) send('user', { message: msgView(pre.userMessage) });
      // 契约 §12.4：提示词历史只用未删消息。
      const history = db.prepare('SELECT role, content FROM messages WHERE chat_id = ? AND deleted_at IS NULL ORDER BY id').all(c.id);
      const messages = promptFor(sub, user, history, c, pre?.extraUser || '');
      promptText = messages.map((x) => String(x.content || '')).join('\n');
      const r = await llm.streamChat(messages, { signal: ac.signal, model: modelRow || undefined, onDelta: (text) => send('delta', { text }) });
      const text = r.text.trim();
      if (!text) { recordBilledOnly(r); throw new HttpError(502, '这次没有生成内容，请重试', 'upstream'); }
      const saved = saveAssistant(text, r);
      const tot = costs.chatTotals(c.id);
      send('done', { message: msgView(saved), chat_cost_usd: tot.cost_usd, chat_cost_partial: tot.cost_partial });
    } catch (e) {
      const partial = (e?.partial || '').trim();
      const partialMeta = {
        usage: !!e?.usage, tokens_in: e?.tokens_in || 0, tokens_out: e?.tokens_out || 0, tokens_in_cached: e?.tokens_in_cached || 0,
        tokens_reasoning: e?.tokens_reasoning || 0, cost_ticks: e?.cost_ticks ?? null, model: e?.model || null, model_id: e?.model_id ?? null,
      };
      if (e?.aborted) {
        // 用户主动停止：保留已生成的部分。
        if (partial) { try { saveAssistant(partial, partialMeta); } catch (err) { console.error('[chat] save partial failed', err?.message); } }
        else recordBilledOnly(partialMeta);
      } else {
        if (!(e instanceof HttpError)) console.error('[chat] generate failed:', e?.message || e);
        let saved = null;
        // 拒答 / 出错时已生成的部分照常保存（契约 §8.4）。
        if (partial) { try { saved = saveAssistant(partial, partialMeta); } catch { /* ignore */ } }
        else recordBilledOnly(partialMeta);
        const code = e instanceof HttpError ? (e.code || (e.status === 504 ? 'timeout' : 'upstream')) : 'upstream';
        logLlmError(ctx, { err: e, code, model: (e?.model_id && models.byId(e.model_id)) || modelRow, chatId: c.id, partial: !!partial });
        const tot = saved ? costs.chatTotals(c.id) : null;
        send('error', { error: e instanceof HttpError ? e.message : '回复失败，请重试', code, ...(saved ? { message: msgView(saved), chat_cost_usd: tot.cost_usd, chat_cost_partial: tot.cost_partial } : {}) });
      }
    } finally {
      if (ping) clearInterval(ping);
      releaseSlot();
      generating.delete(c.id);
      if (!json) {
        res.off('close', onClose);
        if (!res.writableEnded) res.end();
      }
    }
    return json ? collected : undefined;
  }

  /**
   * 组装提示词：chub 角色用 definition（embedded_lorebook 生效；契约 §19.2 有中文版优先用 card_json_zh、角色名用中文名）；
   * 自建卡用 V2 data（character_book 生效，剧情卡叙述者口吻）。契约 §20.1：再叠加本会话设定（card_override_json）与本会话人设。
   */
  function promptFor(sub, user, history, c = null, extraUser = '') {
    if (sub.type === 'file') return filePromptFor(sub, user, history, c, extraUser);
    const isCard = sub.type === 'card';
    let charName;
    let definition;
    let book;
    if (isCard) {
      const raw = parseJson(sub.card.card_json, {}) || {};
      charName = sub.card.name;
      definition = dataToDefinition(raw);
      book = raw.character_book;
    } else {
      const src = chars.promptSource(sub.row, user);
      charName = src.charName;
      definition = src.definition || {};
      book = normalizeLorebook(definition.embedded_lorebook || definition.character_book);
    }
    const ov = chatOverride(c);
    if (ov) {
      definition = overrideDefinition(definition, ov);
      if (typeof ov.name === 'string' && ov.name.trim()) charName = ov.name.trim();
      if (ov.character_book !== undefined) book = ov.character_book;
    }
    const u = userWithPersona(user, chatPersona(c));
    const lore = selectLore(book, history, { macros: { char: charName, user: userCallName(u) } });
    return buildMessages({ definition, charName, user: u, history, kind: isCard ? sub.card.kind : 'character', lore });
  }

  /**
   * 文件会话的提示词（契约 §17.2）：≤15 万字整份放 system；更长的走检索（最近 2 条用户消息 + 本条 → BM25 前 20 块）。
   * 「一句话说明」与附加规则可被本会话设定改（契约 §20.1）。
   */
  function filePromptFor(sub, user, history, c, extraUser = '') {
    const f = sub.file;
    if (!f) throw new HttpError(404, NOT_FOUND_CHAT);
    const settings = applyOverride({ instruction: f.instruction || '', system_prompt: '', post_history_instructions: '' }, chatOverride(c));
    const info = fileInfo(f);
    let file;
    let snippets = [];
    if (f.mode === 'retrieval') {
      const head = db.prepare('SELECT substr(text, 1, 3000) AS t FROM chat_files WHERE id = ?').get(f.id)?.t || '';
      file = { ...info, text: head };
      const idx = fileIndexes.get(c.id, () => db.prepare('SELECT text FROM chat_file_chunks WHERE chat_id = ? ORDER BY idx').all(c.id).map((r) => r.text));
      snippets = retrieve(idx, retrievalQuery(history));
    } else {
      file = { ...info, text: db.prepare('SELECT text FROM chat_files WHERE id = ?').get(f.id)?.text || '' };
    }
    return buildFileMessages({ file, snippets, settings, user: userWithPersona(user, chatPersona(c)), history, extraUser });
  }

  /** llm.error（契约 §11.2）：模型、会话、用户、code、HTTP 状态。不记对话内容、不记上游正文。 */
  function logLlmError(ctx, { err, code, model, chatId = null, source = 'chat', partial = false }) {
    const status = Number.isInteger(err?.upstream_status) ? err.upstream_status : null;
    const codeName = { refused: '拒答', timeout: '超时', upstream: '上游错误' }[code] || code;
    audit(ctx, {
      level: code === 'upstream' ? 'error' : 'warn',
      kind: 'llm.error',
      target_type: chatId ? 'chat' : 'model',
      target_id: chatId || model?.id || null,
      summary: `${model ? model.name : '对话服务'}${source === 'test' ? '（后台测试）' : ''}${codeName}${status ? `，HTTP ${status}` : ''}${chatId ? `，会话 ${chatId}` : ''}`,
      // 模型只留显示名 model_name 与上游模型 ID model（本地 id 已在 target 或 summary 里）；没有 HTTP 状态就不写这个键。
      detail: {
        source, code, ...(status !== null ? { http_status: status } : {}), chat_id: chatId,
        model_name: model?.name ?? null, model: model?.model ?? null,
        // 只有我们自己定的中文提示（HttpError），绝不放上游正文
        error: err instanceof HttpError ? err.message : null,
        partial_saved: partial,
      },
    });
  }

  async function postMessage(ctx, chatId) {
    return generate(ctx, chatId, async (c) => {
      const b = await readJson(ctx);
      const content = str(b.content, MAX_MESSAGE_CHARS + 1).trim();
      if (!content) throw new HttpError(400, '消息不能为空');
      if (content.length > MAX_MESSAGE_CHARS) throw new HttpError(400, `消息太长，最多 ${MAX_MESSAGE_CHARS} 字`);
      // 契约 §18.5：可带 voice_clip_id（只能用自己的、未用过的、未删的录音），绑定到这条用户消息；内容以输入框最终文字为准。
      const clipId = b.voice_clip_id === undefined || b.voice_clip_id === null || b.voice_clip_id === '' ? null : b.voice_clip_id;
      if (clipId !== null && !validId(clipId)) throw new HttpError(400, '录音不可用，请重新录音');
      const now = nowIso();
      const m = tx(db, () => {
        const r = db.prepare('INSERT INTO messages(chat_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(c.id, 'user', content, now);
        const mid = Number(r.lastInsertRowid);
        if (clipId !== null) {
          const u = db.prepare('UPDATE voice_clips SET chat_id = ?, message_id = ? WHERE id = ? AND user_id = ? AND message_id IS NULL AND deleted_at IS NULL')
            .run(c.id, mid, Number(clipId), ctx.user.id);
          if (!u.changes) throw new HttpError(400, '录音不可用，请重新录音');
        }
        db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now, c.id);
        return db.prepare('SELECT * FROM messages WHERE id = ?').get(mid);
      });
      return { userMessage: m };
    });
  }

  async function regenerate(ctx, chatId) {
    return generate(ctx, chatId, async (c) => {
      const msgs = db.prepare('SELECT id, role FROM messages WHERE chat_id = ? AND deleted_at IS NULL ORDER BY id').all(c.id);
      const last = msgs[msgs.length - 1];
      // 文件会话（契约 §17）：还没有用户消息时，重新生成的是 AI 首条（读完资料后的开场），带上首条引导。
      if (c.kind === 'file' && !msgs.some((m) => m.role === 'user')) {
        if (last) db.prepare("UPDATE messages SET deleted_at = ?, deleted_reason = 'regenerate' WHERE id = ?").run(nowIso(), last.id);
        const settings = applyOverride({ instruction: fileRowOf(c.id)?.instruction || '' }, chatOverride(c));
        return { extraUser: kickoffText(settings.instruction) };
      }
      if (!last) throw new HttpError(400, '还没有可以重新生成的回复');
      if (last.role === 'assistant') {
        if (!msgs.some((m) => m.role === 'user')) throw new HttpError(400, '还没有可以重新生成的回复');
        // 被替换的旧回复软删，保留真实用量记录。
        db.prepare("UPDATE messages SET deleted_at = ?, deleted_reason = 'regenerate' WHERE id = ?").run(nowIso(), last.id);
      }
      return {};
    });
  }

  function ownMessage(user, id) {
    const m = db.prepare('SELECT m.*, c.user_id, c.deleted_at AS chat_deleted_at FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = ?').get(Number(id));
    if (!m || m.user_id !== user.id || m.deleted_at || m.chat_deleted_at) throw new HttpError(404, NOT_FOUND_MESSAGE);
    if (generating.has(m.chat_id)) throw new HttpError(409, '回复还在生成中，请稍后');
    return m;
  }

  async function patchMessage(ctx, id) {
    const m = ownMessage(ctx.user, id);
    const b = await readJson(ctx);
    const content = str(b.content, MAX_MESSAGE_CHARS * 4).trim();
    if (!content) throw new HttpError(400, '内容不能为空');
    // 原地修改，保持消息 id 与顺序；不额外保存编辑前正文。
    if (content !== m.content) {
      db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, m.id);
    }
    return { message: msgView(db.prepare('SELECT * FROM messages WHERE id = ?').get(m.id)) };
  }

  /** 删消息（含其后所有消息）= 软删（契约 §12.4）。 */
  function deleteMessage(ctx, id) {
    const m = ownMessage(ctx.user, id);
    const now = nowIso();
    const r = tx(db, () => {
      const x = db.prepare("UPDATE messages SET deleted_at = ?, deleted_reason = 'user_delete' WHERE chat_id = ? AND id >= ? AND deleted_at IS NULL").run(now, m.chat_id, m.id);
      markClipsDeleted(m.chat_id, now);
      return x;
    });
    audit(ctx, {
      kind: 'message.delete', target_type: 'chat', target_id: m.chat_id,
      summary: `${userLabel(ctx.user)} 删除了会话 ${m.chat_id} 中的 ${Number(r.changes || 0)} 条消息`,
      detail: { chat_id: m.chat_id, from_message_id: m.id, messages: Number(r.changes || 0) },
    });
    return { ok: true };
  }

  /**
   * 改错字后从这里重新回复（契约 §20.2）：POST /api/messages/:id/rewind {content} → SSE。
   * 只能用于自己会话里的用户消息；生成中 409。原地更新该条→ 这条之后全部软删（edit_rewind）→ 按修改后的内容生成。
   */
  async function rewindMessage(ctx, id) {
    const m = ownMessage(ctx.user, id); // 本人、未删；生成中 409
    if (m.role !== 'user') throw new HttpError(400, '只能从你自己发的消息重新回复');
    const b = readJson(ctx);
    const content = str(b.content, MAX_MESSAGE_CHARS + 1).trim();
    if (!content) throw new HttpError(400, '消息不能为空');
    if (content.length > MAX_MESSAGE_CHARS) throw new HttpError(400, `消息太长，最多 ${MAX_MESSAGE_CHARS} 字`);
    let dropped = 0;
    let edited = false;
    const out = await generate(ctx, m.chat_id, async (c) => {
      const fresh = db.prepare('SELECT * FROM messages WHERE id = ? AND chat_id = ?').get(m.id, c.id);
      if (!fresh || fresh.deleted_at) throw new HttpError(404, NOT_FOUND_MESSAGE);
      const now = nowIso();
      const saved = tx(db, () => {
        if (content !== fresh.content) {
          db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, fresh.id);
          edited = true;
        }
        const r = db.prepare("UPDATE messages SET deleted_at = ?, deleted_reason = 'edit_rewind' WHERE chat_id = ? AND id > ? AND deleted_at IS NULL").run(now, c.id, fresh.id);
        dropped = Number(r.changes || 0);
        markClipsDeleted(c.id, now);
        db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now, c.id);
        return db.prepare('SELECT * FROM messages WHERE id = ?').get(fresh.id);
      });
      audit(ctx, {
        kind: 'chat.rewind', target_type: 'chat', target_id: c.id,
        summary: `${userLabel(ctx.user)} 在会话 ${c.id} 修改了前文并重新回复${dropped ? `（替换后面 ${dropped} 条）` : ''}`,
        detail: { chat_id: c.id, message_id: fresh.id, edited, replaced_messages: dropped },
      });
      return { userMessage: saved };
    });
    return out;
  }

  // ---------- 本会话设定（契约 §20.1）----------
  /** 会话的原设定（base）：chub 角色中文优先；自建卡用卡本身；文件会话（§17）只有说明与附加规则。 */
  function chatBase(c, sub = subjectOf(c), viewer = null) {
    if (c.kind === 'file') {
      let instruction = '';
      try { instruction = db.prepare('SELECT instruction FROM chat_files WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(c.id)?.instruction || ''; } catch { /* §17 的表还没有 */ }
      return { kind: 'file', fields: FILE_OVERRIDE_FIELDS, base: { instruction, system_prompt: '', post_history_instructions: '' } };
    }
    if (sub.type === 'card') {
      const data = normalizeCardData(parseJson(sub.card?.card_json, {}) || {});
      return { kind: sub.card?.kind || 'character', fields: OVERRIDE_FIELDS, base: { ...pickFields(data), name: sub.card?.name || '' } };
    }
    const src = chars.promptSource(sub.row, viewer);
    const data = chubDefinitionToData(src.definition);
    data.character_book = normalizeLorebook(src.definition.embedded_lorebook || src.definition.character_book);
    return { kind: 'character', fields: OVERRIDE_FIELDS, base: { ...pickFields(data), name: src.charName } };
  }

  function chatSettingsView(c, user) {
    const sub = c.kind === 'file' ? null : subjectOf(c);
    if (sub && sub.type === 'card' && cardGoneForUsers(sub.card, user)) throw new HttpError(403, CARD_GONE);
    const { kind, fields, base } = chatBase(c, sub || undefined, user);
    const override = chatOverride(c);
    const persona = chatPersona(c);
    const pd = personaDefaults(user);
    return {
      kind,
      fields,
      labels: Object.fromEntries([...fields, 'persona_name', 'persona_desc'].map((k) => [k, OVERRIDE_LABELS[k] || k])),
      base,
      override: override || null,
      effective: applyOverride(base, override),
      persona: persona || null,
      persona_default: pd,
      persona_effective: persona || { name: pd.name, desc: pd.desc },
      modified: !!(override || persona),
      can_save_to_card: !!(sub && sub.type === 'card' && sub.card && sub.card.owner_id === user.id && !sub.card.deleted_at),
    };
  }

  function getChatSettings(ctx, id) {
    return chatSettingsView(ownChat(ctx.user, id), ctx.user);
  }

  /** 会话事件（契约 §20.1「写入会话事件，不进提示词历史」）。 */
  function addChatEvent(chatId, kind, detail) {
    const last = db.prepare('SELECT id FROM messages WHERE chat_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1').get(chatId);
    db.prepare('INSERT INTO chat_events(chat_id, kind, after_message_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(chatId, kind, last?.id ?? null, detail ? JSON.stringify(detail) : null, nowIso());
  }
  const EVENT_TEXT = { settings_update: '已更新本会话设定，下一条回复起生效', settings_reset: '已恢复为原角色设定，下一条回复起生效' };
  function chatEvents(chatId) {
    return db.prepare('SELECT * FROM chat_events WHERE chat_id = ? ORDER BY id').all(chatId).map((e) => {
      const d = parseJson(e.detail_json, {}) || {};
      return { id: e.id, kind: e.kind, text: EVENT_TEXT[e.kind] || '', after_message_id: e.after_message_id ?? null, fields: Array.isArray(d.fields) ? d.fields : [], created_at: e.created_at };
    });
  }

  /**
   * PATCH /api/chats/:id/settings {override?, persona?, save_to_card?}：只影响这个会话，下一条回复起生效。
   * override：要改的字段（没给的不改；与原设定相同的不存）；null = 清掉角色设定的修改。persona：{name, desc}；null = 跟随「我的」。
   * save_to_card：自建卡作者「同时保存到我的卡片」→ 改原卡，本会话的角色设定修改随之清空（原卡已经是新值）。
   */
  function patchChatSettings(ctx, id) {
    const c = ownChat(ctx.user, id);
    if (generating.has(c.id)) throw new HttpError(409, '回复还在生成中，请稍后');
    const b = readJson(ctx);
    const sub = c.kind === 'file' ? null : subjectOf(c);
    if (sub && sub.type === 'card' && cardGoneForUsers(sub.card, ctx.user)) throw new HttpError(403, CARD_GONE);
    const { fields, base } = chatBase(c, sub || undefined, ctx.user);
    const oldOv = chatOverride(c);
    const oldPersona = chatPersona(c);
    let ov = oldOv;
    let persona = oldPersona;
    if (b.override !== undefined && b.override !== null && (typeof b.override !== 'object' || Array.isArray(b.override))) throw new HttpError(400, '设定格式不正确');
    if (b.override !== undefined) {
      // override = 本会话要与原设定不同的全部字段（替换语义：没给的字段 = 跟原设定一致）；
      // 也接受整张表单，与原设定相同的字段不存。null / {} = 清掉角色设定的修改。
      ov = b.override === null ? null : diffOverride(base, { ...base, ...b.override }, { fields });
    }
    if (b.persona !== undefined) persona = normalizePersona(b.persona, personaDefaults(ctx.user));
    let savedCard = null;
    if (b.save_to_card === true) {
      if (!sub || sub.type !== 'card' || !sub.card || sub.card.owner_id !== ctx.user.id || sub.card.deleted_at) throw new HttpError(403, '只有卡片作者能保存到原卡');
      if (ov) savedCard = saveOverrideToCard(ctx, sub.card, applyOverride(base, ov));
      ov = null;
    }
    const changed = [];
    const ovKeys = new Set([...Object.keys(oldOv || {}), ...Object.keys(ov || {})]);
    for (const k of ovKeys) if (JSON.stringify(oldOv?.[k] ?? null) !== JSON.stringify(ov?.[k] ?? null)) changed.push(k);
    if (JSON.stringify(oldPersona) !== JSON.stringify(persona)) {
      if ((oldPersona?.name ?? null) !== (persona?.name ?? null)) changed.push('persona_name');
      if ((oldPersona?.desc ?? null) !== (persona?.desc ?? null)) changed.push('persona_desc');
    }
    if (changed.length || savedCard) {
      tx(db, () => {
        db.prepare('UPDATE chats SET card_override_json = ?, persona_override_json = ? WHERE id = ?')
          .run(ov ? JSON.stringify(ov) : null, persona ? JSON.stringify(persona) : null, c.id);
        addChatEvent(c.id, 'settings_update', { fields: changed.map((k) => OVERRIDE_LABELS[k] || k), saved_to_card: !!savedCard });
      });
      audit(ctx, {
        kind: 'chat.override_update', target_type: 'chat', target_id: c.id,
        summary: `${userLabel(ctx.user)} 修改了会话 ${c.id} 的本会话设定：${changed.map((k) => OVERRIDE_LABELS[k] || k).join('、') || '（同步到原卡）'}`,
        // 只记改了哪些字段，不记内容
        detail: { chat_id: c.id, fields: changed, labels: changed.map((k) => OVERRIDE_LABELS[k] || k), saved_to_card: !!savedCard, user_card_id: savedCard?.id ?? null },
      });
    }
    const fresh = db.prepare('SELECT * FROM chats WHERE id = ?').get(c.id);
    return { ...chatSettingsView(fresh, ctx.user), ...(savedCard ? { card: cardView(savedCard, ctx.user, { full: false }) } : {}) };
  }

  /** 「同时保存到我的卡片」：名字 + 设定写回原卡（日志同 card.update，只记改了哪些字段）。 */
  function saveOverrideToCard(ctx, card, merged) {
    const oldData = normalizeCardData(parseJson(card.card_json, {}) || {});
    const patch = {};
    for (const k of OVERRIDE_FIELDS) if (k !== 'name') patch[k] = merged[k];
    const data = normalizeCardData(patch, { base: oldData, strict: true });
    checkCardSize(data);
    const name = String(merged.name || card.name).trim().slice(0, CARD_LIMITS.name) || card.name;
    const changes = [];
    if (name !== card.name) changes.push(change('name', META_LABELS.name, card.name, name));
    for (const k of OVERRIDE_FIELDS) {
      if (k === 'name') continue;
      if (JSON.stringify(oldData[k] ?? null) !== JSON.stringify(data[k] ?? null)) changes.push(change(k, CARD_FIELD_LABELS[k] || k, null, '已修改'));
    }
    if (!changes.length) return card;
    const r = db.prepare('UPDATE user_cards SET name = ?, card_json = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL')
      .run(name, JSON.stringify(data), nowIso(), card.id, ctx.user.id);
    if (!r.changes) throw new HttpError(404, NOT_FOUND_CARD);
    const after = cardRowById(card.id);
    audit(ctx, {
      kind: 'card.update', target_type: 'card', target_id: card.id,
      summary: `${userLabel(ctx.user)} 从会话设定保存${cardLabel(after)}：${changes.map((x) => x.label).join('、')}`,
      detail: { card_id: card.id, name: after.name, changes, from_chat: true },
    });
    return after;
  }

  /** DELETE /api/chats/:id/settings：恢复为原角色设定（角色设定与本会话人设都清掉）。 */
  function resetChatSettings(ctx, id) {
    const c = ownChat(ctx.user, id);
    if (generating.has(c.id)) throw new HttpError(409, '回复还在生成中，请稍后');
    if (c.card_override_json || c.persona_override_json) {
      const fields = [...Object.keys(chatOverride(c) || {}), ...(c.persona_override_json ? ['persona_name', 'persona_desc'] : [])];
      tx(db, () => {
        db.prepare('UPDATE chats SET card_override_json = NULL, persona_override_json = NULL WHERE id = ?').run(c.id);
        addChatEvent(c.id, 'settings_reset', { fields: fields.map((k) => OVERRIDE_LABELS[k] || k) });
      });
      audit(ctx, {
        kind: 'chat.override_update', target_type: 'chat', target_id: c.id,
        summary: `${userLabel(ctx.user)} 把会话 ${c.id} 恢复为原角色设定`,
        detail: { chat_id: c.id, reset: true, fields },
      });
    }
    return chatSettingsView(db.prepare('SELECT * FROM chats WHERE id = ?').get(c.id), ctx.user);
  }

  // ---------- 自建卡 / 剧情卡（契约 §12）----------
  // 可见性：作者（未删）| 站内公开（未删、作者账号未删）| super 只读（含私有、含已删）。不在范围内一律 404，与不存在一致。
  let avatarStore = injectedCardAvatars || null;
  function cardAvatars() {
    if (!avatarStore) {
      const dir = config.cardAvatarDir || (config.dataDir ? nodePath.join(config.dataDir, 'card-avatars') : '');
      if (!dir) throw new HttpError(500, '头像存储未配置');
      avatarStore = createCardAvatarStore(dir);
    }
    return avatarStore;
  }

  const ownerAlive = (card) => { const o = userById(card.owner_id); return !!o && !o.deleted_at; };
  const validId = (id) => /^\d{1,15}$/.test(String(id ?? ''));

  /** 能用（开聊 / 拷贝 / 导出 / 继续聊）：作者本人的未删卡；或未删、公开、作者账号未删的卡。 */
  function cardUsableBy(user, card) {
    if (!card || card.deleted_at) return false;
    if (card.owner_id === user.id) return true;
    return card.visibility === 'public' && ownerAlive(card);
  }

  /** 取一张能用的卡；forChat=true 时作者本人也要过成人内容开关（与 chub 角色一致）。 */
  function usableCard(user, id, { forChat = true } = {}) {
    const card = validId(id) ? cardRowById(id) : null;
    if (!cardUsableBy(user, card)) throw new HttpError(404, NOT_FOUND_CARD);
    if (card.nsfw && !user.nsfw_enabled && (forChat || card.owner_id !== user.id)) throw new HttpError(403, NSFW_FORBIDDEN);
    return card;
  }

  /** 作者本人的未删卡（改 / 删 / 传头像）；别人的（含公开卡）一律 404。 */
  function ownCard(user, id) {
    const card = validId(id) ? cardRowById(id) : null;
    if (!card || card.owner_id !== user.id || card.deleted_at) throw new HttpError(404, NOT_FOUND_CARD);
    return card;
  }

  /**
   * 「改编自」。源是自建卡且对 viewer 已不可用（源卡已删 / 改私有 / 源作者账号已删）时，
   * 非 super 只给 {type:'user', unavailable:true}，不给名字、作者、id（v0.9 F5）。super 照旧看全部。
   */
  function forkedFrom(k, viewer) {
    if (!k.forked_from_type) return null;
    if (k.forked_from_type === 'user' && !(viewer && isSuper(viewer))) {
      const src = validId(k.forked_from_ref) ? cardRowById(k.forked_from_ref) : null;
      if (!viewer || !cardUsableBy(viewer, src)) return { type: 'user', unavailable: true };
    }
    return {
      type: k.forked_from_type,
      path: k.forked_from_type === 'chub' ? k.forked_from_ref : null,
      id: k.forked_from_type === 'user' && validId(k.forked_from_ref) ? Number(k.forked_from_ref) : null,
      name: k.forked_from_name || '',
      author: k.forked_from_author || '',
    };
  }
  // v0.9 F6：会话数不算已软删账号的会话（社区 popular 排序同一口径）；super 的自建卡管理页仍按真实总数。
  const LIVE_CHAT_OWNER = 'AND x.user_id IN (SELECT id FROM users WHERE deleted_at IS NULL)';
  const cardChatCount = (id) => db.prepare(`SELECT COUNT(*) AS n FROM chats x WHERE x.user_card_id = ? AND x.deleted_at IS NULL ${LIVE_CHAT_OWNER}`).get(id).n;

  /**
   * 卡片视图。full：带全部设定（data 结构 + 同名字段平铺一份，前端两种读法都行）；admin：super 只读视图（作者账号、已删标记）。
   */
  function cardView(k, viewer, { full = true, admin = false, chats } = {}) {
    const owner = userById(k.owner_id);
    const out = {
      id: k.id,
      kind: k.kind,
      name: k.name,
      tagline: k.tagline || '',
      avatar: cardAvatarUrl(k.avatar_file),
      tags: parseJson(k.tags_json, []),
      nsfw: !!k.nsfw,
      visibility: k.visibility,
      author: owner ? { id: owner.id, name: owner.display_name || owner.username } : null,
      is_owner: !!viewer && k.owner_id === viewer.id,
      forked_from: forkedFrom(k, viewer),
      chats: chats ?? cardChatCount(k.id),
      created_at: k.created_at,
      updated_at: k.updated_at,
    };
    if (full) {
      const data = normalizeCardData(parseJson(k.card_json, {}) || {});
      out.data = data;
      Object.assign(out, data);
    }
    if (admin || (viewer && isSuper(viewer) && k.deleted_at)) {
      out.deleted = k.deleted_at ? 1 : 0;
      out.deleted_at = k.deleted_at || null;
    }
    if (admin) {
      out.owner = owner ? { id: owner.id, username: owner.username, display_name: owner.display_name || owner.username, role: roleOf(owner), deleted: owner.deleted_at ? 1 : 0 } : null;
    }
    return out;
  }

  const cardLabel = (k) => `${KIND_NAMES[k.kind] || '卡片'}「${k.name}」`;
  function checkCardSize(data) {
    if (JSON.stringify(data).length > CARD_LIMITS.cardBytes) throw new HttpError(400, '卡片内容太多，请精简后再保存');
  }

  // ---------- 自建卡防滥用（数量与频率上限，参数在站点设置里，0 = 不限；super 不受限）----------
  const cardWriteHits = new Map(); // user_id → 最近一分钟内的时间戳
  /** 新建 / 导入 / 拷贝 / 传头像前调用：每分钟次数上限（尝试即计数，失败的请求也算）。 */
  function checkCardWriteRate(user) {
    if (isSuper(user)) return;
    const lim = getSettings(db).card_writes_per_minute;
    if (!lim) return;
    const now = Date.now();
    const hits = (cardWriteHits.get(user.id) || []).filter((t) => t > now - 60_000);
    if (hits.length >= lim) { cardWriteHits.set(user.id, hits); throw new HttpError(429, '操作太频繁，请稍后再试'); }
    hits.push(now);
    cardWriteHits.set(user.id, hits);
    if (cardWriteHits.size > 5000) for (const [k, v] of cardWriteHits) if (!v.some((t) => t > now - 60_000)) cardWriteHits.delete(k);
  }
  /** 新建卡前调用：保留卡数上限（不含已删）与累计建卡上限（含已删，提示里不提「已删除」，保持删除无感知）。 */
  function checkCardQuota(user) {
    if (isSuper(user)) return;
    const s = getSettings(db);
    if (s.card_max_per_user) {
      const live = db.prepare('SELECT COUNT(*) AS n FROM user_cards WHERE owner_id = ? AND deleted_at IS NULL').get(user.id).n;
      if (live >= s.card_max_per_user) throw new HttpError(400, `每个账号最多保存 ${s.card_max_per_user} 张卡，请先删除不用的卡`);
    }
    if (s.card_max_total_per_user) {
      const all = db.prepare('SELECT COUNT(*) AS n FROM user_cards WHERE owner_id = ?').get(user.id).n;
      if (all >= s.card_max_total_per_user) throw new HttpError(400, '已达到建卡数量上限，请联系管理员');
    }
  }

  /** 新建一行卡（事务外调用方自己包）。meta 已规范化。返回新行。 */
  function insertCard(ownerId, meta, data, fork = null) {
    const now = nowIso();
    const r = db.prepare(`INSERT INTO user_cards(owner_id, kind, name, tagline, tags_json, nsfw, visibility, card_json,
        forked_from_type, forked_from_ref, forked_from_name, forked_from_author, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ownerId, meta.kind, meta.name, meta.tagline || '', meta.tags_json || '[]', meta.nsfw ? 1 : 0, meta.visibility || 'private', JSON.stringify(data),
      fork?.type ?? null, fork?.ref ?? null, fork?.name ?? null, fork?.author ?? null, now, now,
    );
    return cardRowById(Number(r.lastInsertRowid));
  }

  /** 头像落盘并写进卡；失败不影响卡本身（返回 false）。 */
  async function attachAvatar(card, buf) {
    if (!sniffImage(buf) || buf.length > AVATAR_MAX_BYTES) return false;
    try {
      const clean = sanitizeAvatar(buf); // 去掉元数据（导入 PNG 的原始 chara 块、EXIF/GPS 等）再落盘
      const file = await cardAvatars().save(card.id, clean.buf, clean.ext);
      db.prepare('UPDATE user_cards SET avatar_file = ? WHERE id = ?').run(file, card.id);
      return true;
    } catch (e) {
      console.error('[cards] 保存头像失败：', e?.message || e);
      return false;
    }
  }

  function myCards(ctx) {
    const kind = str(ctx.url.searchParams.get('kind'), 20).trim();
    const rows = kind
      ? db.prepare('SELECT * FROM user_cards WHERE owner_id = ? AND deleted_at IS NULL AND kind = ? ORDER BY updated_at DESC, id DESC').all(ctx.user.id, kind)
      : db.prepare('SELECT * FROM user_cards WHERE owner_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC').all(ctx.user.id);
    return { items: rows.map((k) => cardView(k, ctx.user, { full: false })) };
  }

  function createCard(ctx) {
    checkCardWriteRate(ctx.user);
    checkCardQuota(ctx.user);
    const b = readJson(ctx);
    const meta = normalizeCardMeta(b, { strict: true });
    const data = normalizeCardData(cardDataFromBody(b), { strict: true });
    checkCardSize(data);
    const card = insertCard(ctx.user.id, meta, data);
    audit(ctx, {
      kind: 'card.create', target_type: 'card', target_id: card.id,
      summary: `${userLabel(ctx.user)} 新建${cardLabel(card)}（${VIS_NAMES[card.visibility]}）`,
      detail: { card_id: card.id, name: card.name, kind: card.kind, visibility: card.visibility, nsfw: !!card.nsfw },
    });
    return { card: cardView(card, ctx.user) };
  }

  function getCard(ctx, id) {
    const card = validId(id) ? cardRowById(id) : null;
    // super：只读看任何卡（含私有、已删）。其他人：能用的卡；别人的成人卡要开成人内容。
    if (card && isSuper(ctx.user)) return { card: cardView(card, ctx.user) };
    const k = usableCard(ctx.user, id, { forChat: false });
    return { card: cardView(k, ctx.user) };
  }

  const CARD_FIELD_LABELS = {
    description: '人物描述 / 世界设定', personality: '性格', scenario: '场景', first_mes: '开场白', mes_example: '对话示例',
    system_prompt: '系统提示', post_history_instructions: '历史后提示', creator_notes: '作者说明',
    alternate_greetings: '备选开场白', character_book: '世界书', extensions: '扩展数据',
  };
  const META_LABELS = { name: '名字', tagline: '一句话简介', tags_json: '标签', nsfw: '成人内容', visibility: '可见性', kind: '类型' };
  function patchCard(ctx, id) {
    const card = ownCard(ctx.user, id);
    const b = readJson(ctx);
    const meta = normalizeCardMeta(b, { base: card, strict: true });
    const oldData = normalizeCardData(parseJson(card.card_json, {}) || {});
    const data = normalizeCardData(cardDataFromBody(b), { base: oldData, strict: true });
    checkCardSize(data);
    const sets = [];
    const vals = [];
    const changes = [];
    for (const [k, v] of Object.entries(meta)) {
      if (card[k] === v) continue;
      sets.push(`${k} = ?`); vals.push(v);
      const show = (x) => (k === 'visibility' ? VIS_NAMES[x] : k === 'kind' ? KIND_NAMES[x] : k === 'nsfw' ? (x ? '开' : '关') : k === 'tags_json' ? parseJson(x, []).join('、') : x);
      changes.push(change(k === 'tags_json' ? 'tags' : k, META_LABELS[k], show(card[k]), show(v)));
    }
    // 设定字段只记「改了哪些」，不写内容（日志不记用户创作的正文）。
    for (const k of [...Object.keys(TEXT_FIELDS), 'alternate_greetings', 'character_book', 'extensions']) {
      if (JSON.stringify(oldData[k] ?? null) !== JSON.stringify(data[k] ?? null)) changes.push(change(k, CARD_FIELD_LABELS[k] || k, null, '已修改'));
    }
    if (JSON.stringify(oldData) !== JSON.stringify(data)) { sets.push('card_json = ?'); vals.push(JSON.stringify(data)); }
    if (!sets.length) return { card: cardView(card, ctx.user) };
    sets.push('updated_at = ?'); vals.push(nowIso());
    const r = db.prepare(`UPDATE user_cards SET ${sets.join(', ')} WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`).run(...vals, card.id, ctx.user.id);
    if (!r.changes) throw new HttpError(404, NOT_FOUND_CARD);
    const after = cardRowById(card.id);
    audit(ctx, {
      kind: 'card.update', target_type: 'card', target_id: card.id,
      summary: `${userLabel(ctx.user)} 修改${cardLabel(after)}：${changes.map((c) => c.label).join('、')}`,
      detail: { card_id: card.id, name: after.name, changes },
    });
    return { card: cardView(after, ctx.user) };
  }

  /** 删卡 = 软删；作者自己用这张卡的会话一并软删（消息标 card_delete）。别人的会话保留，但不能再继续聊。 */
  function deleteCard(ctx, id) {
    const card = ownCard(ctx.user, id);
    const chatIds = db.prepare('SELECT id FROM chats WHERE user_card_id = ? AND user_id = ? AND deleted_at IS NULL').all(card.id, ctx.user.id).map((r) => r.id);
    if (chatIds.some((cid) => generating.has(cid))) throw new HttpError(409, '有回复正在生成中，请稍后再删');
    const now = nowIso();
    tx(db, () => {
      db.prepare('UPDATE user_cards SET deleted_at = ? WHERE id = ?').run(now, card.id);
      const msg = db.prepare("UPDATE messages SET deleted_at = ?, deleted_reason = 'card_delete' WHERE chat_id = ? AND deleted_at IS NULL");
      const ch = db.prepare('UPDATE chats SET deleted_at = ? WHERE id = ?');
      for (const cid of chatIds) { msg.run(now, cid); ch.run(now, cid); markClipsDeleted(cid, now); }
    });
    audit(ctx, {
      kind: 'card.delete', target_type: 'card', target_id: card.id,
      summary: `${userLabel(ctx.user)} 删除${cardLabel(card)}${chatIds.length ? `，连同 ${chatIds.length} 个会话` : ''}`,
      detail: { card_id: card.id, name: card.name, kind: card.kind, visibility: card.visibility, chats: chatIds },
    });
    return { ok: true };
  }

  function community(ctx) {
    const q = ctx.url.searchParams;
    const where = ["uc.visibility = 'public'", 'uc.deleted_at IS NULL', 'u.deleted_at IS NULL'];
    const vals = [];
    if (!ctx.user.nsfw_enabled) where.push('uc.nsfw = 0');
    const kind = str(q.get('kind'), 20).trim();
    if (kind) {
      if (!KIND_NAMES[kind]) throw new HttpError(400, '卡片类型不正确');
      where.push('uc.kind = ?'); vals.push(kind);
    }
    const kw = str(q.get('q'), 100).trim();
    if (kw) {
      const pat = `%${likeEscape(kw)}%`;
      where.push("(uc.name LIKE ? ESCAPE '\\' OR uc.tagline LIKE ? ESCAPE '\\')"); vals.push(pat, pat);
    }
    const tag = str(q.get('tag'), CARD_LIMITS.tag).trim();
    if (tag) { where.push('EXISTS (SELECT 1 FROM json_each(uc.tags_json) t WHERE lower(t.value) = lower(?))'); vals.push(tag); }
    const sort = q.get('sort') || 'new';
    if (sort !== 'new' && sort !== 'popular') throw new HttpError(400, '排序方式不正确');
    const page = Math.min(1000, Math.max(1, parseInt(q.get('page') || '1', 10) || 1));
    const rows = db.prepare(`
      SELECT uc.*, (SELECT COUNT(*) FROM chats x WHERE x.user_card_id = uc.id AND x.deleted_at IS NULL ${LIVE_CHAT_OWNER}) AS chat_count
      FROM user_cards uc JOIN users u ON u.id = uc.owner_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${sort === 'popular' ? 'chat_count DESC, uc.updated_at DESC, uc.id DESC' : 'uc.created_at DESC, uc.id DESC'}
      LIMIT ? OFFSET ?
    `).all(...vals, COMMUNITY_PAGE_SIZE + 1, (page - 1) * COMMUNITY_PAGE_SIZE);
    return {
      items: rows.slice(0, COMMUNITY_PAGE_SIZE).map((k) => cardView(k, ctx.user, { full: false, chats: k.chat_count })),
      page,
      has_more: rows.length > COMMUNITY_PAGE_SIZE,
    };
  }

  /** 拷贝二创（契约 §12.2）：源为 chub 角色或公开 / 自己的自建卡 → 新建一张私有卡归当前用户。 */
  async function forkCard(ctx) {
    checkCardWriteRate(ctx.user);
    checkCardQuota(ctx.user);
    const b = readJson(ctx);
    const user = ctx.user;
    let meta;
    let data;
    let fork;
    let avatarBuf = null;
    let copyFile = null;
    if (b.from === 'chub') {
      const p = str(b.path, 300).trim();
      if (!isValidChubPath(p)) throw new HttpError(400, '角色地址不正确');
      const source = characterSource(b.source);
      // 本地读取已缓存或已镜像的完整卡，同时核对当前成人标记。
      const row = await chars.ensure(p, { user, translate: false, source });
      data = chubDefinitionToData(parseJson(row.card_json, {}), { greetingZh: row.greeting_zh || '' });
      meta = {
        kind: 'character', name: `${row.name}（改编）`.slice(0, CARD_LIMITS.name), tagline: (row.tagline || '').slice(0, CARD_LIMITS.tagline),
        tags_json: JSON.stringify(parseJson(row.tags_json, []).slice(0, CARD_LIMITS.tags).map((t) => String(t).slice(0, CARD_LIMITS.tag))),
        nsfw: adultRole(p, row) ? 1 : 0, visibility: 'private',
      };
      fork = { type: 'chub', ref: row.chub_path, name: row.name, author: row.chub_path.split('/')[0] };
      try {
        avatarBuf = (await mirrorImages.readAvatar(row.chub_path, user))?.buf || null;
        if (!avatarBuf && source === 'remote' && row.avatar_url) avatarBuf = (await avatars.get(row.avatar_url)).buf;
      } catch (e) { if (e?.status === 403) throw e; console.error('[cards] 拷贝 chub 头像失败'); }
    } else if (b.from === 'user') {
      const src = usableCard(user, b.id, { forChat: false });
      const owner = userById(src.owner_id);
      data = normalizeCardData(parseJson(src.card_json, {}) || {});
      meta = { kind: src.kind, name: `${src.name}（改编）`.slice(0, CARD_LIMITS.name), tagline: src.tagline, tags_json: src.tags_json, nsfw: src.nsfw, visibility: 'private' };
      fork = { type: 'user', ref: String(src.id), name: src.name, author: owner ? (owner.display_name || owner.username) : '' };
      copyFile = src.avatar_file;
    } else {
      throw new HttpError(400, '拷贝来源不正确');
    }
    const card = insertCard(user.id, meta, data, fork);
    if (!avatarBuf && copyFile) avatarBuf = (await cardAvatars().read(copyFile).catch(() => null))?.buf || null;
    if (avatarBuf) await attachAvatar(card, avatarBuf); // 复制时同样去元数据（旧头像可能还带原始卡数据）
    const fresh = cardRowById(card.id);
    audit(ctx, {
      kind: 'card.fork', target_type: 'card', target_id: card.id,
      summary: `${userLabel(user)} 拷贝${fork.type === 'chub' ? ' chub 角色' : '自建卡'}「${fork.name}」为${cardLabel(fresh)}`,
      detail: { card_id: card.id, from: fork.type, ref: fork.ref, source_name: fork.name, source_author: fork.author },
    });
    return { card: cardView(fresh, user) };
  }

  /** 上传内容：raw 图片 / multipart，或 JSON {file|image: dataURL 或 base64}。 */
  function uploadFromCtx(ctx) {
    const ct = String(ctx.req.headers['content-type'] || '').toLowerCase();
    if (ct.startsWith('application/json')) {
      const b = readJson(ctx);
      const v = typeof b.file === 'string' ? b.file : typeof b.image === 'string' ? b.image : typeof b.data_url === 'string' ? b.data_url : null;
      if (v === null) return { json: b };
      const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(v);
      const buf = Buffer.from(m ? m[3] : v, 'base64');
      return { data: buf, contentType: m ? m[1] : '' };
    }
    return uploadPayload(ctx.rawBuf || Buffer.alloc(0), ctx.req.headers['content-type']);
  }

  async function uploadCardAvatar(ctx, id) {
    const card = ownCard(ctx.user, id);
    checkCardWriteRate(ctx.user);
    const up = uploadFromCtx(ctx);
    if (!up.data || !up.data.length) throw new HttpError(400, '没有收到图片');
    if (up.data.length > AVATAR_MAX_BYTES) throw new HttpError(413, '图片不能超过 5MB');
    const { buf: clean, ext } = sanitizeAvatar(up.data); // 校验魔数 + 去元数据（EXIF/GPS、PNG 文本块）
    const file = await cardAvatars().save(card.id, clean, ext);
    const r = db.prepare('UPDATE user_cards SET avatar_file = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL').run(file, nowIso(), card.id, ctx.user.id);
    if (!r.changes) { await cardAvatars().remove(file); throw new HttpError(404, NOT_FOUND_CARD); }
    if (card.avatar_file && card.avatar_file !== file) await cardAvatars().remove(card.avatar_file);
    const after = cardRowById(card.id);
    audit(ctx, {
      kind: 'card.update', target_type: 'card', target_id: card.id,
      summary: `${userLabel(ctx.user)} 修改${cardLabel(after)}：头像`,
      detail: { card_id: card.id, name: after.name, changes: [change('avatar', '头像', null, '已更换')], bytes: up.data.length, type: IMAGE_MIME[ext] },
    });
    return { card: cardView(after, ctx.user) };
  }

  async function importCard(ctx) {
    checkCardWriteRate(ctx.user);
    checkCardQuota(ctx.user);
    const up = uploadFromCtx(ctx);
    const parsed = up.json ? parseImport(Buffer.from(ctx.rawBody || '', 'utf8'), 'application/json') : parseImport(up.data, up.contentType);
    const meta = { kind: parsed.kind, name: parsed.name, tagline: parsed.tagline, tags_json: JSON.stringify(parsed.tags), nsfw: parsed.nsfw ? 1 : 0, visibility: 'private' };
    checkCardSize(parsed.data);
    const card = insertCard(ctx.user.id, meta, parsed.data);
    const warnings = [...parsed.warnings];
    if (parsed.avatar && !(await attachAvatar(card, parsed.avatar.buf))) warnings.push('头像没有保存成功');
    const fresh = cardRowById(card.id);
    audit(ctx, {
      kind: 'card.import', target_type: 'card', target_id: card.id,
      summary: `${userLabel(ctx.user)} 导入${cardLabel(fresh)}`,
      detail: { card_id: card.id, name: fresh.name, kind: fresh.kind, format: up.data && up.data[0] === 0x89 ? 'png' : 'json', lore_entries: parsed.data.character_book?.entries?.length || 0 },
    });
    return { card: cardView(fresh, ctx.user), warnings };
  }

  async function exportCard(ctx, id) {
    const format = ctx.url.searchParams.get('format') || 'json';
    if (format !== 'json' && format !== 'png') throw new HttpError(400, '导出格式不正确');
    const card = usableCard(ctx.user, id, { forChat: false });
    const owner = userById(card.owner_id);
    const json = exportCardJson(card, normalizeCardData(parseJson(card.card_json, {}) || {}), { creator: owner ? (owner.display_name || owner.username) : '' });
    let body;
    let type;
    if (format === 'json') {
      body = Buffer.from(JSON.stringify(json, null, 2), 'utf8');
      type = 'application/json; charset=utf-8';
    } else {
      const av = card.avatar_file ? await cardAvatars().read(card.avatar_file) : null;
      body = exportCardPng(json, av?.buf || null);
      type = 'image/png';
    }
    ctx.res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': type,
      'Content-Length': body.length,
      'Content-Disposition': attachmentHeader(card.name, format),
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : body);
    return undefined;
  }

  /** /api/card-avatar/<文件名>：公开（未删、作者未删）卡任何登录用户；其余只有作者与 super（契约 §12.1；v0.9 F7 去掉「有会话就放行」）。 */
  async function cardAvatar(ctx, file) {
    const m = AVATAR_FILE_RE.exec(file);
    const card = m ? cardRowById(Number(m[1])) : null;
    const u = ctx.user;
    const ok = card && card.avatar_file === file && (isSuper(u) || cardUsableBy(u, card));
    const img = ok ? await cardAvatars().read(file) : null;
    if (!img) throw new HttpError(404, '没有找到这张图片');
    ctx.res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': img.type,
      'Content-Length': img.buf.length,
      'Cache-Control': 'private, max-age=86400',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : img.buf);
    return undefined;
  }

  // super 只读：全部自建卡（含私有、含已删）。没有任何修改接口（契约 §12.3）。
  function adminListCards(ctx) {
    const q = ctx.url.searchParams;
    const where = [];
    const vals = [];
    const ownerId = (q.get('owner_id') || '').trim();
    if (ownerId) {
      if (!validId(ownerId)) throw new HttpError(400, '作者参数不正确');
      where.push('uc.owner_id = ?'); vals.push(Number(ownerId));
    }
    const vis = (q.get('visibility') || '').trim();
    if (vis) {
      if (!VIS_NAMES[vis]) throw new HttpError(400, '可见性参数不正确');
      where.push('uc.visibility = ?'); vals.push(vis);
    }
    const kind = (q.get('kind') || '').trim();
    if (kind) {
      if (!KIND_NAMES[kind]) throw new HttpError(400, '卡片类型不正确');
      where.push('uc.kind = ?'); vals.push(kind);
    }
    const kw = str(q.get('q'), 100).trim();
    if (kw) {
      const pat = `%${likeEscape(kw)}%`;
      where.push("(uc.name LIKE ? ESCAPE '\\' OR uc.tagline LIKE ? ESCAPE '\\')"); vals.push(pat, pat);
    }
    const incl = (q.get('include_deleted') ?? '1').trim();
    if (incl === '0' || incl === 'false') where.push('uc.deleted_at IS NULL');
    const page = Math.min(100000, Math.max(1, parseInt(q.get('page') || '1', 10) || 1));
    const rows = db.prepare(`
      SELECT uc.*, (SELECT COUNT(*) FROM chats x WHERE x.user_card_id = uc.id) AS chat_count
      FROM user_cards uc ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY uc.updated_at DESC, uc.id DESC LIMIT ? OFFSET ?
    `).all(...vals, ADMIN_CARDS_PAGE_SIZE + 1, (page - 1) * ADMIN_CARDS_PAGE_SIZE);
    return {
      items: rows.slice(0, ADMIN_CARDS_PAGE_SIZE).map((k) => cardView(k, ctx.user, { full: false, admin: true, chats: k.chat_count })),
      page,
      has_more: rows.length > ADMIN_CARDS_PAGE_SIZE,
    };
  }

  function adminGetCard(ctx, id) {
    const card = validId(id) ? cardRowById(id) : null;
    if (!card) throw new HttpError(404, NOT_FOUND_CARD);
    const chats = db.prepare('SELECT COUNT(*) AS n FROM chats WHERE user_card_id = ?').get(card.id).n;
    return { card: cardView(card, ctx.user, { admin: true, chats }) };
  }

  // ---------- 管理：账号（契约 §9.3）----------
  // super 看/管全部（但不能动别的 super）；admin 只看/管自己创建的租户，范围外一律 404（不泄露存在性）。
  const isSuper = (u) => roleOf(u) === 'super';

  /** 当前操作者能管理的账号；不在范围内与不存在一样回 404。 */
  function manageableUser(actor, id) {
    const u = userById(Number(id));
    // 已软删的账号对任何人都等同不存在（不能再改 / 再删 / 恢复；契约 §12.4）。
    if (u && !u.deleted_at && (isSuper(actor) || (roleOf(u) === 'tenant' && u.created_by === actor.id))) return u;
    throw new HttpError(404, NOT_FOUND_USER);
  }

  /** 请求体里要设的角色：role 优先，兼容旧前端的 is_admin。undefined = 没提。 */
  function requestedRole(b) {
    if (b.role !== undefined && b.role !== null && b.role !== '') {
      const r = String(b.role);
      if (r === 'super') throw new HttpError(403, '超级管理员只能用命令行脚本创建');
      if (r !== 'admin' && r !== 'tenant') throw new HttpError(400, '角色不正确');
      return r;
    }
    if (b.is_admin !== undefined && b.is_admin !== null) return b.is_admin ? 'admin' : 'tenant';
    return undefined;
  }

  function adminListUsers(ctx) {
    const today = sgDay();
    // super 看全部（含已删除，标 deleted）；admin 只看自己建的、未删除的租户。
    const rows = isSuper(ctx.user)
      ? db.prepare('SELECT * FROM users ORDER BY id').all()
      : db.prepare("SELECT * FROM users WHERE role = 'tenant' AND created_by = ? AND deleted_at IS NULL ORDER BY id").all(ctx.user.id);
    return { items: rows.map((u) => adminUserView(u, today)) };
  }

  function parseLimit(v) {
    if (v === null || v === '' ) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 1000000) throw new HttpError(400, '每日上限必须是 0 或正整数');
    return n;
  }

  async function adminCreateUser(ctx) {
    const b = await readJson(ctx);
    // admin：role 强制 tenant；明确要别的角色（含旧字段 is_admin）一律 403，先于参数校验，不给探测空间。
    if (!isSuper(ctx.user)) {
      const askRole = b.role !== undefined && b.role !== null && b.role !== '' && String(b.role) !== 'tenant';
      if (askRole || b.is_admin) throw new HttpError(403, '管理员只能创建租户');
    }
    const role = isSuper(ctx.user) ? requestedRole(b) || 'tenant' : 'tenant';
    const username = str(b.username, 64).trim();
    if (!USERNAME_RE.test(username)) throw new HttpError(400, '用户名只能用字母、数字、下划线、点或横线，2–32 位');
    const password = str(b.password, 256);
    if (password.length < 8) throw new HttpError(400, '密码至少 8 位');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, '用户名已存在');
    const daily_limit = b.daily_limit === undefined ? null : parseLimit(b.daily_limit);
    const note = parseUserNote(b.note);
    // 契约 §13.3：管理员直接开的号，首次登录必须先改密码（管理员知道的初始密码不能长期有效）。
    const r = db.prepare('INSERT INTO users(username, password_hash, display_name, is_admin, role, created_by, daily_limit, note, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)')
      .run(username, hashPassword(password), str(b.display_name, 40).trim() || username, role === 'tenant' ? 0 : 1, role, ctx.user.id, daily_limit, note, nowIso());
    const nu = userById(Number(r.lastInsertRowid));
    audit(ctx, {
      kind: 'user.create', target_type: 'user', target_id: nu.id,
      summary: `创建${roleName(role)}账号 ${userLabel(nu)}`,
      detail: { username: nu.username, display_name: nu.display_name, role, role_name: roleName(role), daily_limit: limitText(nu.daily_limit), note: nu.note ?? null, must_change_password: true },
    });
    return { user: adminUserView(nu, sgDay()) };
  }

  async function adminPatchUser(ctx, id) {
    const u = manageableUser(ctx.user, id);
    const b = await readJson(ctx);
    const self = u.id === ctx.user.id;
    if (isSuper(u) && !self) throw new HttpError(403, '不能修改其他超级管理员');
    // super 给自己原样传 role:'super' 视为没改；其余想设成 super 的一律 403（只能走脚本）。
    const wantRole = isSuper(ctx.user) && !(self && b.role === 'super') ? requestedRole(b) : undefined;
    if (!isSuper(ctx.user) && (b.role !== undefined || b.is_admin !== undefined)) throw new HttpError(403, '没有权限修改角色');
    const sets = [];
    const vals = [];
    let killSessions = false;
    if (b.display_name !== undefined) {
      const v = str(b.display_name, 40).trim();
      if (!v) throw new HttpError(400, '显示名不能为空');
      sets.push('display_name = ?'); vals.push(v);
    }
    // 契约 §13.3：管理接口不再接受 password 字段（含给自己改；自己改走 /api/me/password）。
    if (b.password !== undefined) throw new HttpError(400, '管理员不能修改用户密码，请发重置码');
    if (b.note !== undefined) { sets.push('note = ?'); vals.push(parseUserNote(b.note)); }
    if (b.disabled !== undefined) {
      if (self && b.disabled) throw new HttpError(400, '不能停用自己的账号');
      if (b.disabled && isSuper(u) && countActiveSupers(db) <= 1) throw new HttpError(400, '至少要保留一个启用的超级管理员');
      sets.push('disabled = ?'); vals.push(b.disabled ? 1 : 0);
      if (b.disabled) killSessions = true;
    }
    if (wantRole !== undefined && wantRole !== roleOf(u)) {
      // 只剩 super 改自己这一种情况会走到这里：super 不能被降级（也保证了最后一个 super 不会消失）。
      if (isSuper(u)) throw new HttpError(400, '不能降级超级管理员');
      sets.push('role = ?', 'is_admin = ?'); vals.push(wantRole, wantRole === 'tenant' ? 0 : 1);
    }
    const demoteAdmin = wantRole === 'tenant' && roleOf(u) === 'admin';
    if (b.daily_limit !== undefined) { sets.push('daily_limit = ?'); vals.push(parseLimit(b.daily_limit)); }
    tx(db, () => {
      if (sets.length) {
        // 兜底复核：admin 只能改仍由自己创建的租户（范围判断与写入同一事务、同一条件）。
        const r = isSuper(ctx.user)
          ? db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, u.id)
          : db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND role = 'tenant' AND created_by = ? AND deleted_at IS NULL`).run(...vals, u.id, ctx.user.id);
        if (!r.changes) throw new HttpError(404, NOT_FOUND_USER);
      }
      // 管理员被降成租户：他建的租户转给执行操作的超管（与删除管理员一致），免得变成只有超管能管的账号。
      if (demoteAdmin) db.prepare('UPDATE users SET created_by = ? WHERE created_by = ? AND id <> ?').run(ctx.user.id, u.id, u.id);
    });
    if (killSessions) destroyUserSessions(db, u.id);
    const after = userById(u.id);
    logUserPatch(ctx, u, after, { passwordReset: false, demoteAdmin });
    return { user: adminUserView(after, sgDay()) };
  }

  /** user.update（字段旧值→新值，密码只写「已重置」）+ user.disable / user.enable（契约 §11.2）。 */
  function logUserPatch(ctx, before, after, { passwordReset, demoteAdmin }) {
    const changes = [];
    if (before.display_name !== after.display_name) changes.push(change('display_name', '显示名', before.display_name, after.display_name));
    if (passwordReset) changes.push(change('password', '密码', null, '已重置'));
    if (roleOf(before) !== roleOf(after)) changes.push(change('role', '角色', roleName(roleOf(before)), roleName(roleOf(after))));
    if ((before.note ?? null) !== (after.note ?? null)) changes.push(change('note', '备注', before.note ?? null, after.note ?? null));
    if ((before.daily_limit ?? null) !== (after.daily_limit ?? null)) changes.push(change('daily_limit', '每日上限', limitText(before.daily_limit), limitText(after.daily_limit)));
    if (changes.length) {
      audit(ctx, {
        kind: 'user.update', target_type: 'user', target_id: after.id,
        summary: `修改账号 ${userLabel(after)}：${changes.map((x) => x.label).join('、')}`,
        detail: { username: after.username, changes, ...(demoteAdmin ? { tenants_transferred_to: ctx.user.id } : {}) },
      });
    }
    if (!!before.disabled !== !!after.disabled) {
      audit(ctx, {
        kind: after.disabled ? 'user.disable' : 'user.enable', target_type: 'user', target_id: after.id,
        summary: `${after.disabled ? '停用' : '启用'}账号 ${userLabel(after)}`,
        detail: { username: after.username, role: roleOf(after) },
      });
    }
  }

  function adminDeleteUser(ctx, id) {
    const u = manageableUser(ctx.user, id);
    if (u.id === ctx.user.id) throw new HttpError(400, '不能删除自己的账号');
    if (isSuper(u)) throw new HttpError(403, '不能删除其他超级管理员');
    // 契约 §12.4：删账号也是软删——设 deleted_at、踢掉登录；会话、消息、用量、自建卡全部保留（用量统计保留），
    // 用户名继续被占用；他的公开卡从社区隐藏。删掉的是管理员：他建的租户转给执行删除的超管（保留原逻辑）。
    tx(db, () => {
      const r = db.prepare('UPDATE users SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(nowIso(), u.id);
      if (!r.changes) throw new HttpError(404, NOT_FOUND_USER);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      db.prepare('UPDATE users SET created_by = ? WHERE created_by = ? AND id <> ?').run(ctx.user.id, u.id, u.id);
    });
    audit(ctx, {
      kind: 'user.delete', target_type: 'user', target_id: u.id,
      summary: `删除${roleName(roleOf(u))}账号 ${userLabel(u)}`,
      detail: { username: u.username, display_name: u.display_name, role: roleOf(u) },
    });
    return { ok: true };
  }

  function adminUsage(ctx) {
    const days = Math.min(366, Math.max(1, parseInt(ctx.url.searchParams.get('days') || '7', 10) || 7));
    const from = sgDay(new Date(Date.now() - (days - 1) * 86400000));
    const cols = 'SELECT ud.user_id, u.username, u.display_name, u.role, ud.day, ud.messages, ud.tokens_in, ud.tokens_out, ud.cost_usd FROM usage_daily ud JOIN users u ON u.id = ud.user_id';
    const rows = isSuper(ctx.user)
      ? db.prepare(`${cols} WHERE ud.day >= ? ORDER BY ud.day DESC, u.id`).all(from)
      : db.prepare(`${cols} WHERE ud.day >= ? AND u.role = 'tenant' AND u.created_by = ? ORDER BY ud.day DESC, u.id`).all(from, ctx.user.id);
    const items = rows.map((r) => ({ ...r, cost_usd: round6(r.cost_usd) }));
    const total_cost_usd = round6(rows.reduce((a, r) => a + (r.cost_usd || 0), 0));
    const out = { days, from, items, total_cost_usd };
    // super 另得翻译与测试花费（契约 §10.3）。
    if (isSuper(ctx.user)) out.system_costs = costs.systemTotals(sgDayStart(from, '开始日期').toISOString());
    return out;
  }

  // ---------- 查询工具 ----------
  const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

  /** 新加坡日期 YYYY-MM-DD → 当天 00:00（新加坡）的 UTC ISO。 */
  function sgDayStart(day, label) {
    const d = new Date(`${day}T00:00:00+08:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(d.getTime()) || sgDay(d) !== day) throw new HttpError(400, `${label}格式不正确`);
    return d;
  }

  function adminListShelves() {
    return { items: shelvesWithItems({ nsfw: true }) };
  }

  const shelfById = (id) => {
    const s = db.prepare('SELECT * FROM shelves WHERE id = ?').get(Number(id));
    if (!s) throw new HttpError(404, '没有找到这个货架');
    return s;
  };
  const shelfView = (id) => shelvesWithItems({ nsfw: true }).find((s) => s.id === Number(id));

  async function adminCreateShelf(ctx) {
    const b = await readJson(ctx);
    const title = str(b.title, 60).trim();
    if (!title) throw new HttpError(400, '货架标题不能为空');
    const max = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM shelves').get().m;
    const sort = b.sort === undefined ? max + 1 : Number(b.sort) || 0;
    const r = db.prepare('INSERT INTO shelves(title, sort, created_at) VALUES (?, ?, ?)').run(title, sort, nowIso());
    const sid = Number(r.lastInsertRowid);
    audit(ctx, { kind: 'shelf.create', target_type: 'shelf', target_id: sid, summary: `新建货架「${title}」`, detail: { title, sort } });
    return { shelf: shelfView(sid) };
  }

  async function adminPatchShelf(ctx, id) {
    const s = shelfById(id);
    const b = await readJson(ctx);
    if (b.title !== undefined) {
      const t = str(b.title, 60).trim();
      if (!t) throw new HttpError(400, '货架标题不能为空');
      db.prepare('UPDATE shelves SET title = ? WHERE id = ?').run(t, s.id);
    }
    if (b.sort !== undefined) db.prepare('UPDATE shelves SET sort = ? WHERE id = ?').run(Number(b.sort) || 0, s.id);
    const after = shelfById(s.id);
    const changes = [];
    if (after.title !== s.title) changes.push(change('title', '标题', s.title, after.title));
    if (after.sort !== s.sort) changes.push(change('sort', '排序', s.sort, after.sort));
    if (changes.length) {
      audit(ctx, { kind: 'shelf.update', target_type: 'shelf', target_id: s.id, summary: `修改货架「${after.title}」：${changes.map((x) => x.label).join('、')}`, detail: { changes } });
    }
    return { shelf: shelfView(s.id) };
  }

  function adminDeleteShelf(ctx, id) {
    const s = shelfById(id);
    const items = db.prepare('SELECT COUNT(*) AS n FROM shelf_items WHERE shelf_id = ?').get(s.id).n;
    tx(db, () => {
      db.prepare('DELETE FROM shelf_items WHERE shelf_id = ?').run(s.id);
      db.prepare('DELETE FROM shelves WHERE id = ?').run(s.id);
    });
    audit(ctx, { kind: 'shelf.delete', target_type: 'shelf', target_id: s.id, summary: `删除货架「${s.title}」`, detail: { title: s.title, items } });
    return { ok: true };
  }

  async function adminAddShelfItem(ctx, id) {
    const s = shelfById(id);
    const b = await readJson(ctx);
    const source = characterSource(b.source);
    const row = await chars.ensure(str(b.path, 300).trim(), { user: ctx.user, translate: false, source });
    if (source === 'remote') chars.kickTranslation(row, ctx.user);
    const max = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM shelf_items WHERE shelf_id = ?').get(s.id).m;
    const ins = db.prepare('INSERT OR IGNORE INTO shelf_items(shelf_id, character_id, sort) VALUES (?, ?, ?)').run(s.id, row.id, max + 1);
    if (ins.changes) {
      audit(ctx, { kind: 'shelf.add_item', target_type: 'shelf', target_id: s.id, summary: `货架「${s.title}」添加角色「${row.name}」`, detail: { shelf: s.title, path: row.chub_path, name: row.name } });
    }
    return { shelf: shelfView(s.id) };
  }

  function adminDeleteShelfItem(ctx, id, path) {
    const s = shelfById(id);
    const row = chars.getRow(path);
    const del = row ? db.prepare('DELETE FROM shelf_items WHERE shelf_id = ? AND character_id = ?').run(s.id, row.id) : null;
    if (del?.changes) {
      audit(ctx, { kind: 'shelf.remove_item', target_type: 'shelf', target_id: s.id, summary: `货架「${s.title}」移除角色「${row.name}」`, detail: { shelf: s.title, path: row.chub_path, name: row.name } });
    }
    return { shelf: shelfView(s.id) };
  }

  async function adminOrderShelf(ctx, id) {
    const s = shelfById(id);
    const b = await readJson(ctx);
    if (!Array.isArray(b.paths)) throw new HttpError(400, 'paths 必须是列表');
    tx(db, () => {
      b.paths.forEach((p, i) => {
        const row = chars.getRow(String(p));
        if (row) db.prepare('UPDATE shelf_items SET sort = ? WHERE shelf_id = ? AND character_id = ?').run(i + 1, s.id, row.id);
      });
    });
    audit(ctx, { kind: 'shelf.reorder', target_type: 'shelf', target_id: s.id, summary: `调整货架「${s.title}」里角色的顺序`, detail: { shelf: s.title, paths: b.paths.slice(0, 100).map((p) => str(p, 300)) } });
    return { shelf: shelfView(s.id) };
  }

  const adminGetSettings = () => ({ settings: getSettings(db) });
  const cliBrief = m => ({ id: m.id, name: m.name, provider: m.provider, model: m.model, transport: 'grok-cli', enabled: m.enabled });
  function translationModels() {
    return { items: [...(grokCli?.models() || []).map(cliBrief), ...models.listEnabled().map(m => ({ ...models.publicView(m), transport: 'api' }))],
      default_model_id: chars.translations.model()?.id ?? null, translate_backend: getSettings(db).translate_backend };
  }
  async function adminTranslationCliStatus() {
    const available = !!grokCli?.available();
    const quota = available ? await readCliQuota() : { ok: false, remainingPercent: null, collectedAt: new Date().toISOString(), status: 'unsupported' };
    return { available, quota, min_remaining_percent: cliMinPercent, reserve_percent: cliMinPercent > 0 ? Math.max(0, cliMinPercent - 5) : 0, models: (grokCli?.models() || []).map(cliBrief) };
  }

  // ---------- 模型（契约 §8.3） ----------
  function listModels() {
    const d = models.systemDefault();
    return { items: models.listEnabled().map(models.publicView), default_model_id: d ? d.id : null };
  }

  function adminListModels() {
    return { items: models.all().map(models.adminView), default_model_id: getSettings(db).default_model_id };
  }

  // 模型日志里比较的字段（key 单独处理：只写「已更换」，不写值、不写末 4 位）。
  const MODEL_FIELDS = [
    ['name', '显示名'], ['provider', '供应商'], ['base_url', '接口地址'], ['model', '模型 ID'], ['extra_json', '附加参数'],
    ['proxy_url', '出站代理'], ['currency', '币种'], ['price_in', '输入单价'], ['price_in_cached', '缓存输入单价'], ['price_out', '输出单价'],
  ];
  const modelBrief = (m) => ({ name: m.name, provider: m.provider, model: m.model });

  /** model.update（含 key「已更换」）+ model.enable / model.disable。 */
  function logModelChange(ctx, before, after, { summaryPrefix = '修改模型' } = {}) {
    const changes = [];
    for (const [f, label] of MODEL_FIELDS) {
      if ((before[f] ?? null) !== (after[f] ?? null)) changes.push(change(f, label, before[f], after[f]));
    }
    if ((before.api_key_enc ?? null) !== (after.api_key_enc ?? null) || (before.api_key_env ?? null) !== (after.api_key_env ?? null)) {
      changes.push(change('api_key', '密钥', null, '已更换'));
    }
    if (changes.length) {
      audit(ctx, {
        kind: 'model.update', target_type: 'model', target_id: after.id,
        summary: `${summaryPrefix}「${after.name}」：${changes.map((x) => x.label).join('、')}`,
        detail: { ...modelBrief(after), changes },
      });
    }
    if (!!before.enabled !== !!after.enabled) {
      audit(ctx, {
        kind: after.enabled ? 'model.enable' : 'model.disable', target_type: 'model', target_id: after.id,
        summary: `${after.enabled ? '启用' : '停用'}模型「${after.name}」`, detail: modelBrief(after),
      });
    }
  }

  async function adminCreateModel(ctx) {
    const m = await models.create(await readJson(ctx));
    audit(ctx, {
      kind: 'model.create', target_type: 'model', target_id: m.id,
      summary: `添加模型「${m.name}」（${m.model}）`,
      detail: {
        ...modelBrief(m), base_url: m.base_url, proxy_url: m.proxy_url || null, enabled: m.enabled ? 1 : 0,
        key_source: m.api_key_enc ? '后台填写' : m.api_key_env ? '密钥文件' : '无',
        currency: m.currency, price_in: m.price_in ?? null, price_in_cached: m.price_in_cached ?? null, price_out: m.price_out ?? null,
      },
    });
    return { model: models.adminView(m) };
  }

  async function adminPatchModel(ctx, id) {
    const before = models.byId(id);
    const m = await models.update(id, await readJson(ctx));
    if (before) logModelChange(ctx, before, m);
    return { model: models.adminView(m) };
  }

  function adminDeleteModel(ctx, id) {
    const before = models.byId(id);
    const r = models.remove(id);
    if (before && r.deleted) {
      audit(ctx, { kind: 'model.delete', target_type: 'model', target_id: before.id, summary: `删除模型「${before.name}」`, detail: modelBrief(before) });
    } else if (before && r.disabled && before.enabled) {
      audit(ctx, { kind: 'model.disable', target_type: 'model', target_id: before.id, summary: `停用模型「${before.name}」（有会话在用，删除改为停用）`, detail: { ...modelBrief(before), reason: '有会话在用' } });
    }
    return { ok: true, ...r };
  }

  async function adminOrderModels(ctx) {
    const b = await readJson(ctx);
    const before = models.all().map((m) => m.id);
    models.order(b.ids);
    const after = models.all();
    if (after.map((m) => m.id).join(',') !== before.join(',')) {
      audit(ctx, {
        kind: 'model.update', target_type: 'model', target_id: null, summary: '调整模型排序',
        detail: { changes: [change('order', '排序', before.join(','), after.map((m) => m.id).join(','))], order: after.map((m) => ({ id: m.id, name: m.name })) },
      });
    }
    return adminListModels();
  }

  /** 后台「测试」：用这个模型（启用与否都行）走一次真实的流式调用。 */
  async function adminTestModel(ctx, id) {
    const m = models.byId(id);
    if (!m) throw new HttpError(404, '没有找到这个模型');
    const t0 = Date.now();
    try {
      const r = await llm.streamChat([{ role: 'user', content: '用一句话打个招呼' }], { model: m, max_tokens: 64, temperature: 0.7 });
      const latency_ms = Date.now() - t0;
      const c = costs.recordSystem('test', m, ctx.user.id, r); // 契约 §10.2：测试花费记 system_costs
      const sample = r.text.trim().slice(0, 200);
      const cost = c ? { cost_usd: c.cost_usd, cost_source: c.cost_source } : { cost_usd: null, cost_source: null };
      if (!sample) return { ok: false, latency_ms, error: '没有返回内容', ...cost };
      return { ok: true, latency_ms, sample, ...cost };
    } catch (e) {
      if (e?.usage) costs.recordSystem('test', m, ctx.user.id, e);
      const code = e instanceof HttpError ? (e.code || (e.status === 504 ? 'timeout' : 'upstream')) : 'upstream';
      logLlmError(ctx, { err: e, code, model: m, source: 'test' });
      return { ok: false, latency_ms: Date.now() - t0, error: e instanceof HttpError ? e.message : '调用失败', code: e?.code || 'upstream' };
    }
  }

  /** 「从 xAI 同步价格」（契约 §10.2）：只对 api.x.ai 模型；走与对话相同的 key 与代理。 */
  async function adminSyncModelPrice(ctx, id) {
    const m = models.byId(id);
    if (!m) throw new HttpError(404, '没有找到这个模型');
    if (!isXaiUrl(m.base_url)) throw new HttpError(400, '只有 xAI 的模型能同步价格');
    const list = await llm.getJson(m, '/language-models');
    const p = xaiPriceFromList(list, m.model);
    if (!p) throw new HttpError(502, 'xAI 价格表里没有这个模型');
    const fresh = models.setPrices(m.id, p);
    const changes = [];
    for (const [f, label] of [['currency', '币种'], ['price_in', '输入单价'], ['price_in_cached', '缓存输入单价'], ['price_out', '输出单价']]) {
      if ((m[f] ?? null) !== (fresh[f] ?? null)) changes.push(change(f, label, m[f], fresh[f]));
    }
    audit(ctx, {
      kind: 'model.sync_price', target_type: 'model', target_id: m.id,
      summary: `从 xAI 同步模型「${m.name}」价格${changes.length ? '' : '（无变化）'}`,
      detail: { ...modelBrief(fresh), changes },
    });
    return { model: models.adminView(fresh), synced: { currency: p.currency, price_in: p.price_in, price_in_cached: p.price_in_cached, price_out: p.price_out } };
  }

  const SETTING_LABELS = {
    site_name: '站点名称', default_daily_limit: '默认每日上限', allow_user_chub_search: '允许租户搜索角色库',
    cny_to_usd: '人民币兑美元汇率', default_model_id: '全站默认模型', log_retention_days: '日志保留天数', translate_model_id: '翻译模型',
    voice_format_model_id: '语音整理模型', translate_backend: '翻译方式', translate_cli_model: '本机 CLI 翻译模型',
    card_max_per_user: '每个账号最多保留的卡数', card_max_total_per_user: '每个账号累计建卡上限', card_writes_per_minute: '每分钟建卡 / 传头像次数',
    translate_daily_max: '每人每天整卡翻译次数', voice_daily_max_clips: '每人每天录音条数', voice_daily_max_mb: '每人每天录音总量（MB）',
  };
  function settingText(k, v) {
    if (k === 'translate_backend') return v === 'cli' ? '本机 Grok CLI' : 'API';
    if (k === 'allow_user_chub_search') return v ? '允许' : '不允许';
    if (k === 'default_daily_limit' || k in CARD_QUOTA_DEFAULTS || k in ABUSE_LIMIT_DEFAULTS) return Number(v) === 0 ? '不限' : String(v);
    if (k === 'default_model_id' || k === 'translate_model_id' || k === 'voice_format_model_id') { if (v === null || v === undefined) return k === 'default_model_id' ? '未指定' : '默认（DeepSeek 快速）'; const m = models.byId(v); return m ? `${m.name}（#${m.id}）` : `#${v}`; }
    return v;
  }

  async function adminPatchSettings(ctx) {
    const before = getSettings(db);
    const out = await patchSettingsInner(ctx);
    const after = out.settings;
    const changes = [];
    for (const [k, label] of Object.entries(SETTING_LABELS)) {
      if (before[k] !== after[k]) changes.push(change(k, label, settingText(k, before[k]), settingText(k, after[k])));
    }
    if (changes.length) {
      audit(ctx, { kind: 'settings.update', target_type: 'settings', summary: `修改设置：${changes.map((x) => x.label).join('、')}`, detail: { changes } });
    }
    return out;
  }

  async function patchSettingsInner(ctx) {
    const b = await readJson(ctx);
    // 先全部校验再一次性写（事务），免得一半写进去一半报错，日志也就对得上。
    const w = [];
    if (b.site_name !== undefined) {
      const v = str(b.site_name, 40).trim();
      if (!v) throw new HttpError(400, '站点名称不能为空');
      w.push(['site_name', v]);
    }
    if (b.default_daily_limit !== undefined) w.push(['default_daily_limit', parseLimit(b.default_daily_limit) ?? 0]);
    if (b.allow_user_chub_search !== undefined) w.push(['allow_user_chub_search', b.allow_user_chub_search ? 1 : 0]);
    if (b.cny_to_usd !== undefined) {
      const n = typeof b.cny_to_usd === 'number' ? b.cny_to_usd : (typeof b.cny_to_usd === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(b.cny_to_usd) ? Number(b.cny_to_usd) : NaN);
      if (!Number.isFinite(n) || n <= 0 || n > 10) throw new HttpError(400, '人民币兑美元汇率必须是大于 0 的数字');
      w.push(['cny_to_usd', n]);
    }
    if (b.default_model_id !== undefined) {
      const m = models.requireEnabled(b.default_model_id);
      w.push(['default_model_id', m ? m.id : '']);
    }
    if (b.log_retention_days !== undefined) w.push(['log_retention_days', parseRetentionDays(b.log_retention_days)]);
    // 契约 §19.2：翻译模型（只能选启用的；null / '' = 默认「DeepSeek 快速」）
    if (b.translate_backend !== undefined) {
      if (!['cli','api'].includes(b.translate_backend)) throw new HttpError(400, '请选择有效的翻译方式');
      w.push(['translate_backend',b.translate_backend]);
    }
    if (b.translate_cli_model !== undefined) {
      if (!['grok-4.5','grok-4.7'].includes(b.translate_cli_model)) throw new HttpError(400, '请选择有效的本机 CLI 模型');
      w.push(['translate_cli_model',b.translate_cli_model]);
    }
    if (b.translate_model_id !== undefined) {
      const m = models.requireEnabled(b.translate_model_id);
      w.push(['translate_model_id', m ? m.id : '']);
    }
    // 契约 §18.2：语音整理模型（只能选启用的；null / '' = 默认「DeepSeek 快速」）
    if (b.voice_format_model_id !== undefined) {
      const m = models.requireEnabled(b.voice_format_model_id);
      w.push(['voice_format_model_id', m ? m.id : '']);
    }
    for (const k of [...Object.keys(CARD_QUOTA_DEFAULTS), ...Object.keys(ABUSE_LIMIT_DEFAULTS)]) {
      if (b[k] === undefined) continue;
      const n = parseQuota(b[k]);
      if (n === null) throw new HttpError(400, `${SETTING_LABELS[k]}必须是 0（不限）或正整数`);
      w.push([k, n]);
    }
    if (w.length) tx(db, () => { for (const [k, v] of w) setSetting(db, k, v); });
    return { settings: getSettings(db) };
  }

  // ---------- 邀请码（契约 §13.2，admin 与 super）----------
  const inviteById = (id) => db.prepare('SELECT * FROM invite_codes WHERE id = ?').get(Number(id));

  function inviteView(inv, { withUsers = true } = {}) {
    const creator = userById(inv.creator_id);
    const status = inviteStatus(inv, creator);
    const out = {
      id: inv.id,
      code: inv.code,
      note: inv.note,
      max_uses: inv.max_uses,
      used_count: inv.used_count,
      expires_at: inv.expires_at,
      disabled_at: inv.disabled_at ?? null,
      created_at: inv.created_at,
      status,
      status_name: INVITE_STATUS_NAMES[status],
      link: inviteLink(publicBase, inv.code),
      creator: creator ? { id: creator.id, username: creator.username, name: creator.display_name || creator.username } : { id: inv.creator_id, username: null, name: null },
    };
    if (withUsers) {
      out.users = db.prepare('SELECT id, username, display_name, created_at, disabled, deleted_at FROM users WHERE invite_code_id = ? ORDER BY id').all(inv.id)
        .map((u) => ({ id: u.id, username: u.username, display_name: u.display_name || u.username, registered_at: u.created_at, disabled: u.disabled ? 1 : 0, deleted: u.deleted_at ? 1 : 0 }));
    }
    return out;
  }

  /** admin 只能看 / 停用自己建的码；super 全部。范围外与不存在一样 404。 */
  function manageableInvite(actor, id) {
    const inv = inviteById(id);
    if (inv && (isSuper(actor) || inv.creator_id === actor.id)) return inv;
    throw new HttpError(404, '没有找到这个邀请码');
  }

  function adminCreateInvite(ctx) {
    const b = readJson(ctx);
    const note = parseInviteNote(b.note);
    const max_uses = parseMaxUses(b.max_uses);
    const expires_at = parseInviteExpiry(b);
    const now = nowIso();
    let inv = null;
    for (let i = 0; i < 8 && !inv; i++) {
      const code = randomCode(INVITE_CODE_LEN);
      try {
        const r = db.prepare('INSERT INTO invite_codes(code, creator_id, note, max_uses, used_count, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
          .run(code, ctx.user.id, note, max_uses, expires_at, now);
        inv = inviteById(Number(r.lastInsertRowid));
      } catch (e) {
        if (!/UNIQUE/i.test(String(e?.message))) throw e; // 撞码（概率极低）就换一个再试
      }
    }
    if (!inv) throw new HttpError(500, '生成邀请码失败，请重试');
    audit(ctx, {
      kind: 'invite.create', target_type: 'invite', target_id: inv.id,
      summary: `新建邀请码（${note}）：可用 ${max_uses} 次`,
      detail: { invite_id: inv.id, note, max_uses, expires_at },
    });
    return { invite: inviteView(inv) };
  }

  function adminListInvites(ctx) {
    const rows = isSuper(ctx.user)
      ? db.prepare('SELECT * FROM invite_codes ORDER BY id DESC').all()
      : db.prepare('SELECT * FROM invite_codes WHERE creator_id = ? ORDER BY id DESC').all(ctx.user.id);
    return { items: rows.map((r) => inviteView(r)) };
  }

  function adminDisableInvite(ctx, id) {
    const inv = manageableInvite(ctx.user, id);
    if (!inv.disabled_at) {
      db.prepare('UPDATE invite_codes SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL').run(nowIso(), inv.id);
      audit(ctx, {
        kind: 'invite.disable', target_type: 'invite', target_id: inv.id,
        summary: `停用邀请码（${inv.note}）`,
        detail: { invite_id: inv.id, note: inv.note, used_count: inv.used_count, max_uses: inv.max_uses },
      });
    }
    return { invite: inviteView(inviteById(inv.id)) };
  }

  // ---------- 公开注册（契约 §13.2，无需登录）----------
  const REGISTER_LOCKED = '尝试次数过多，请 30 分钟后再试';
  function registerFail(ip, msg, status = 400) {
    if (registerLimiter.fail(ip)) {
      writeLog(db, {
        level: 'warn', kind: 'auth.lockout', actor_id: null, actor_name: null, ip: ip || null,
        summary: `IP ${ip} 注册失败次数过多，已锁定 30 分钟`, detail: { scope: 'register', minutes: 30 },
      });
    }
    return new HttpError(status, msg);
  }

  /** 按码找邀请码并判断能不能用；返回 {inv, reason}（reason 为 INVITE_PUBLIC_REASONS 的键）。 */
  function lookupInvite(rawCode) {
    const code = normalizeCode(rawCode, INVITE_CODE_LEN);
    if (!code) return { inv: null, reason: 'format' };
    const inv = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code);
    if (!inv) return { inv: null, reason: 'not_found' };
    const st = inviteStatus(inv, userById(inv.creator_id));
    return { inv, reason: st === 'active' ? null : st };
  }

  function registerCheck(ctx) {
    const ip = clientIp(ctx.req);
    if (registerLimiter.isLocked(ip)) throw new HttpError(429, REGISTER_LOCKED);
    const raw = ctx.url.searchParams.get('code');
    const { reason } = lookupInvite(raw);
    if (!reason) return { ok: true };
    // 格式不对（还没输完）不算失败次数；完整的错码算，防撞库。
    if (reason !== 'format') registerFail(ip, '');
    return { ok: false, reason: INVITE_PUBLIC_REASONS[reason] };
  }

  function register(ctx) {
    const ip = clientIp(ctx.req);
    if (registerLimiter.isLocked(ip)) throw new HttpError(429, REGISTER_LOCKED);
    const b = readJson(ctx);
    const { inv, reason } = lookupInvite(b.code);
    if (reason) throw registerFail(ip, INVITE_PUBLIC_REASONS[reason]);
    const username = str(b.username, 64).trim();
    if (!USERNAME_RE.test(username)) throw registerFail(ip, '用户名只能用字母、数字、下划线、点或横线，2–32 位');
    const password = str(b.password, 256);
    if (password.length < 8) throw registerFail(ip, '密码至少 8 位');
    const display = str(b.display_name, 40).trim() || username;
    const hash = hashPassword(password); // 先算好（同步），事务里只做条件更新 + 插入
    const now = nowIso();
    // 事务 + 条件更新：并发抢最后一个名额不会超用；用户名唯一（软删账号也占用，COLLATE NOCASE）。
    // 失败计数（可能写 auth.lockout 日志）放在事务外，免得日志随回滚一起丢。
    let nu;
    try {
      nu = tx(db, () => {
        if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, '用户名已存在');
        const fresh = inviteById(inv.id);
        const st = inviteStatus(fresh, userById(fresh.creator_id));
        if (st !== 'active') throw new HttpError(400, INVITE_PUBLIC_REASONS[st]);
        const u = db.prepare(`UPDATE invite_codes SET used_count = used_count + 1
          WHERE id = ? AND used_count < max_uses AND disabled_at IS NULL AND expires_at > ?`).run(inv.id, now);
        if (!u.changes) throw new HttpError(400, INVITE_PUBLIC_REASONS.used_up);
        const r = db.prepare(`INSERT INTO users(username, password_hash, display_name, is_admin, role, created_by, note, invite_code_id, must_change_password, created_at, last_login_at)
          VALUES (?, ?, ?, 0, 'tenant', ?, ?, ?, 0, ?, ?)`).run(username, hash, display, fresh.creator_id, fresh.note, fresh.id, now, now);
        return userById(Number(r.lastInsertRowid));
      });
    } catch (e) {
      if (e instanceof HttpError) throw registerFail(ip, e.message, e.status);
      throw e;
    }
    const token = createSession(db, nu.id);
    ctx.setCookie = sessionCookie(token, ctx.req, Math.floor(SESSION_TTL_MS / 1000));
    writeLog(db, {
      kind: 'user.register', actor: nu, ip: ip || null, target_type: 'user', target_id: nu.id,
      summary: `${userLabel(nu)} 用邀请码注册（${inv.note}）`,
      detail: { username: nu.username, invite_id: inv.id, invite_note: inv.note, creator_id: inv.creator_id, user_agent: uaOf(ctx.req) },
    });
    return { user: publicUser(nu) };
  }

  // ---------- 重置码（契约 §13.3）----------
  function adminIssueResetCode(ctx, id) {
    const u = manageableUser(ctx.user, id);
    if (isSuper(u) && u.id !== ctx.user.id) throw new HttpError(403, '不能给其他超级管理员发重置码');
    const code = randomCode(RESET_CODE_LEN);
    const now = Date.now();
    const expires_at = new Date(now + RESET_CODE_TTL_MS).toISOString();
    tx(db, () => {
      // 同一用户签发新码，旧的未用码一律作废。
      db.prepare('UPDATE password_resets SET revoked_at = ? WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL').run(new Date(now).toISOString(), u.id);
      db.prepare('INSERT INTO password_resets(user_id, code_hash, issued_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(u.id, hashPassword(code), ctx.user.id, expires_at, new Date(now).toISOString());
    });
    audit(ctx, {
      kind: 'user.reset_code_issued', target_type: 'user', target_id: u.id,
      summary: `给 ${userLabel(u)} 签发了重置码（24 小时有效）`,
      detail: { username: u.username, expires_at },
    });
    // 明文只在这一次响应里出现（库里只存哈希）。
    return { code, expires_at, user: { id: u.id, username: u.username, display_name: u.display_name || u.username } };
  }

  const RESET_FAILED = '用户名或重置码不正确，或重置码已过期';
  function passwordReset(ctx) {
    const ip = clientIp(ctx.req);
    const b = readJson(ctx);
    const username = str(b.username, 64).trim();
    const rawCode = str(b.code, 64);
    const np = str(b.new_password, 256);
    if (!username || !rawCode.trim()) throw new HttpError(400, '请输入用户名和重置码');
    if (resetLimiter.isLocked(username, ip)) throw new HttpError(429, '尝试次数过多，请 10 分钟后再试');
    if (np.length < 8) throw new HttpError(400, '新密码至少 8 位');
    const found = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const u = found && !found.deleted_at ? found : null;
    const code = normalizeCode(rawCode, RESET_CODE_LEN);
    const row = u ? db.prepare(`SELECT * FROM password_resets WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      ORDER BY id DESC LIMIT 1`).get(u.id, nowIso()) : null;
    // 没有可用的码也跑一次 scrypt，耗时一致，防凭耗时探测。
    const ok = verifyPassword(code || '-', row ? row.code_hash : DUMMY_HASH) && !!row && !!code;
    if (!ok) {
      resetLimiter.fail(username, ip);
      throw new HttpError(400, RESET_FAILED);
    }
    resetLimiter.succeed(username, ip);
    const now = nowIso();
    tx(db, () => {
      const r = db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL').run(now, row.id);
      if (!r.changes) throw new HttpError(400, RESET_FAILED);
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(np), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); // 作废该用户全部登录
    });
    writeLog(db, {
      kind: 'user.password_reset', actor: u, ip: ip || null, target_type: 'user', target_id: u.id,
      summary: `${userLabel(u)} 用重置码设置了新密码`,
      detail: { username: u.username, issued_by: row.issued_by ?? null, user_agent: uaOf(ctx.req) },
    });
    return { ok: true };
  }

  // ---------- 我的登录记录（契约 §14）----------
  const myLogins = (ctx) => queryMyLogins(db, ctx.user.id, ctx.url.searchParams.get('page'));

  // ---------- 抓取监控（契约 §15）----------
  // 查看：admin 与 super；操作：只限 super。上游路径一律由固定模板 + 白名单参数拼出，token 只在服务端。
  const crawler = injectedCrawler || createCrawlerClient({ url: config.crawlerControlUrl, tokenFile: config.crawlerTokenFile });
  async function crawlerView(ctx, upstreamPath) {
    const r = await crawler.request('GET', upstreamPath);
    if (r.offline) return { online: false, message: r.message || CRAWLER_OFFLINE, can_control: isSuper(ctx.user) };
    if (!r.ok) return { online: false, message: r.error || CRAWLER_OFFLINE, can_control: isSuper(ctx.user) };
    return { online: true, can_control: isSuper(ctx.user), fetched_at: nowIso(), data: scrubPaths(r.json) };
  }
  /** 写操作：转发 → 记 crawler.* 日志（成功 info / 失败 warn，不记 token、不记上游正文）。 */
  async function crawlerWrite(ctx, { method = 'POST', upstreamPath, body, kind, summary, detail }) {
    const r = await crawler.request(method, upstreamPath, body);
    const okRes = !!r.ok;
    const err = r.offline ? (r.message || CRAWLER_OFFLINE) : (r.ok ? null : r.error);
    audit(ctx, {
      level: okRes ? 'info' : 'warn', kind, target_type: 'crawler', target_id: null,
      summary: `${userLabel(ctx.user)} ${summary}${okRes ? '' : `（失败：${err}）`}`,
      detail: { ...detail, ok: okRes, ...(okRes ? {} : { error: err, status: r.status ?? null }) },
    });
    if (r.offline) throw new HttpError(503, err);
    if (!r.ok) throw new HttpError(r.status >= 400 && r.status < 500 ? (r.status === 404 ? 404 : 400) : 502, err);
    return { ok: true, result: scrubPaths(r.json) };
  }
  const crawlerStatus = (ctx) => crawlerView(ctx, '/status');
  const crawlerExits = (ctx) => crawlerView(ctx, '/exits');
  function crawlerPhase(ctx, name, action) {
    if (!CRAWLER_PHASES.includes(name)) throw new HttpError(404, '没有这个抓取阶段');
    if (!CRAWLER_PHASE_ACTIONS.includes(action)) throw new HttpError(404, '不支持的操作');
    return crawlerWrite(ctx, {
      upstreamPath: `/phase/${name}/${action}`, kind: `crawler.phase_${action}`,
      summary: `${action === 'start' ? '开工' : '暂停'}抓取阶段「${CRAWLER_PHASE_NAMES[name]}」`, detail: { phase: name, action },
    });
  }
  function crawlerAll(ctx, which) {
    const pause = which === 'pause-all';
    return crawlerWrite(ctx, {
      upstreamPath: pause ? '/pause-all' : '/resume-all', kind: pause ? 'crawler.pause_all' : 'crawler.resume_all',
      summary: pause ? '暂停全部抓取' : '恢复全部抓取', detail: { action: which },
    });
  }
  function crawlerConfig(ctx) {
    const patch = sanitizeConfigPatch(readJson(ctx));
    return crawlerWrite(ctx, {
      method: 'PUT', upstreamPath: '/config', body: patch, kind: 'crawler.config',
      summary: `修改抓取配置：${Object.keys(patch).join('、')}`, detail: { patch },
    });
  }
  function crawlerExit(ctx, port, action) {
    if (!(port === 'direct' || (/^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535))) throw new HttpError(404, '没有这个出口');
    if (!CRAWLER_EXIT_ACTIONS.includes(action)) throw new HttpError(404, '不支持的操作');
    const b = readJson(ctx);
    const resetGroup = action === 'enable' && b.reset_group === true;
    const id = port === 'direct' ? 'direct' : String(Number(port));
    return crawlerWrite(ctx, {
      upstreamPath: `/exits/${id}/${action}${resetGroup ? '?reset_group=1' : ''}`, kind: action === 'enable' ? 'crawler.exit_enable' : 'crawler.exit_disable',
      summary: `${action === 'enable' ? '启用' : '停用'}抓取出口 ${id === 'direct' ? '直连' : id}${resetGroup ? '（连同 IP 组冷却一起清）' : ''}`,
      detail: { exit: id, action, reset_group: resetGroup },
    });
  }

  // ---------- 上传文件快速开聊（契约 §17）----------
  const dataPath = (key, sub) => config[key] || (config.dataDir ? nodePath.join(config.dataDir, sub) : '');
  const uploads = createUploadStore(dataPath('uploadDir', 'uploads'));
  const fileIndexes = createIndexCache();
  const parseDirs = () => {
    const tmp = dataPath('tmpUploadDir', 'tmp-parse');
    const bin = dataPath('binDir', 'bin');
    if (!tmp || !bin) throw new HttpError(500, '文件解析未配置');
    return { tmpDir: tmp, binDir: bin };
  };
  if (config.dataDir || config.uploadDir) {
    const sweep = () => uploads.sweep().catch(() => {});
    sweep();
    setInterval(sweep, 10 * 60 * 1000).unref();
  }
  // 解析会起子进程（textutil / PDF / OCR）：每个账号同时只解析一批，全站同时最多 2 批。
  // 名额在读请求体之前就占（路由 opts.preBody），拿不到直接拒，不先把上百 MB 的请求体读进内存。
  const parsingUsers = new Set();
  let parsingGlobal = 0;
  const PARSE_GLOBAL_MAX = 2;
  const PARSE_PER_HOUR = 30; // 每个账号每小时最多解析几批（防刷暂存与子进程）
  const parseHits = new Map();
  const DISK_MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024; // 数据盘剩余空间低于 5GB 就不再收上传 / 录音
  let diskCache = { at: 0, free: Infinity };
  /** 写入前检查 DATA_DIR 所在盘的剩余空间（10 秒缓存）；不够就 507 并记一条 warn。 */
  async function checkDisk(ctx) {
    const dir = config.dataDir || dataPath('uploadDir', 'uploads');
    if (!dir) return;
    if (Date.now() - diskCache.at > 10_000) {
      try { const st = await statfs(dir); diskCache = { at: Date.now(), free: Number(st.bavail) * Number(st.bsize) }; } catch { diskCache = { at: Date.now(), free: Infinity }; }
    }
    if (diskCache.free < DISK_MIN_FREE_BYTES) {
      console.warn(`[disk] 数据盘剩余 ${Math.round(diskCache.free / 1048576)}MB，低于 5GB，已拒绝上传 / 录音`);
      try { audit(ctx, { level: 'warn', kind: 'system.disk_low', target_type: 'system', summary: `数据盘剩余空间不足 5GB（${Math.round(diskCache.free / 1048576)}MB），已拒绝上传 / 录音`, detail: { free_mb: Math.round(diskCache.free / 1048576) } }); } catch { /* 日志写不进也照样拒 */ }
      throw closeErr(507, '服务器存储空间不足，请稍后再试');
    }
  }
  /** POST /api/file-chats/parse 的 preBody：读请求体之前占名额（按用户 + 全站）、查每小时次数与磁盘。返回释放函数。 */
  async function parseSlot(ctx) {
    const user = ctx.user;
    if (parsingUsers.has(user.id)) throw closeErr(429, '上一批文件还在解析，请稍候');
    if (parsingGlobal >= PARSE_GLOBAL_MAX) throw closeErr(503, '解析的人太多了，请稍后再试');
    const now = Date.now();
    const hits = (parseHits.get(user.id) || []).filter((t) => t > now - 3600_000);
    if (hits.length >= PARSE_PER_HOUR) { parseHits.set(user.id, hits); throw closeErr(429, '上传解析太频繁，请一小时后再试'); }
    await checkDisk(ctx);
    // await 之后重新检查（期间可能别的请求占了名额），检查与占用在同一个同步段里
    if (parsingUsers.has(user.id)) throw closeErr(429, '上一批文件还在解析，请稍候');
    if (parsingGlobal >= PARSE_GLOBAL_MAX) throw closeErr(503, '解析的人太多了，请稍后再试');
    hits.push(now);
    parseHits.set(user.id, hits);
    if (parseHits.size > 5000) for (const [k, v] of parseHits) if (!v.some((t) => t > now - 3600_000)) parseHits.delete(k);
    parsingUsers.add(user.id);
    parsingGlobal += 1;
    let released = false;
    return () => { if (released) return; released = true; parsingUsers.delete(user.id); parsingGlobal -= 1; };
  }

  /** 各启用模型的「每条消息大约花费」（前端切换模型时不用重新上传）。 */
  function fileEstimates(doc, preferredId) {
    const cny = getSettings(db).cny_to_usd;
    const at = nowIso();
    const list = models.listEnabled().map((m) => ({ model_id: m.id, model_name: m.name, ...estimateForModel(m, doc, { cnyToUsd: cny, at }) }));
    const pick = list.find((x) => x.model_id === preferredId) || list[0] || null;
    return { list, pick };
  }

  /** POST /api/file-chats/parse：上传（multipart 多文件 / 原始请求体 + X-File-Name / JSON base64）→ 解析结果 + upload_id（1 小时）。 */
  async function fileChatParse(ctx) {
    const user = ctx.user;
    let list = filesFromRequest(ctx.rawBuf || Buffer.alloc(0), ctx.req.headers);
    ctx.rawBuf = null;
    if (!list.length) throw new HttpError(400, '没有收到文件');
    if (list.length > FILES_MAX) throw new HttpError(400, `一次最多上传 ${FILES_MAX} 个文件`);
    let parsed;
    try {
      // worker 线程里解析，整批最多 180 秒（超时终止并收掉子进程）；名额由 preBody 占着，路由结束时释放
      parsed = await parseFilesIsolated(list, parseDirs());
    } finally {
      list = null;
    }
    const ok = parsed.files.some((f) => f.ok) && parsed.total_chars > 0;
    const mode = modeFor(parsed.total_chars);
    const preferred = models.userDefault(user);
    const est = fileEstimates({ text: parsed.text, total_chars: parsed.total_chars, mode }, preferred?.id);
    const upload_id = ok ? await uploads.put(user.id, parsed) : null;
    return {
      upload_id,
      ok,
      files: parsed.files,
      total_chars: parsed.total_chars,
      truncated: parsed.truncated,
      ...(parsed.truncated ? { warning: '文件合计超过 200 万字，超出的部分没有读入' } : {}),
      mode,
      ...(mode === 'retrieval' ? { notice: RETRIEVAL_NOTICE } : {}),
      estimate_per_message_usd: est.pick?.per_message_usd ?? null,
      estimate_first_message_usd: est.pick?.first_message_usd ?? null,
      estimate_model_id: est.pick?.model_id ?? null,
      estimates: est.list,
      expires_in_sec: 3600,
    };
  }

  /**
   * POST /api/file-chats {upload_id, instruction?, model_id?} → 新建文件会话并生成 AI 首条。
   * 请求头 Accept 含 text/event-stream：SSE（chat → delta… → done / error）；否则同步等首条生成完，回 {chat, message, error?}。
   */
  async function createFileChat(ctx) {
    const b = readJson(ctx);
    const user = ctx.user;
    const picked = b.model_id === undefined || b.model_id === null || b.model_id === '' ? null : models.requireEnabled(b.model_id);
    const instruction = parseInstruction(b.instruction);
    checkLimit(user); // 额度用完就不建空会话
    const rec = await uploads.get(user.id, b.upload_id);
    if (!rec) throw new HttpError(404, '上传的文件已过期，请重新上传');
    const okFiles = (rec.files || []).filter((f) => f.ok);
    if (!okFiles.length || !rec.text) throw new HttpError(400, '没有可用的文件内容');
    const modelRow = picked || models.userDefault(user);
    const mode = modeFor(rec.total_chars);
    const title = fileChatTitle(rec.files);
    const now = nowIso();
    const chat = tx(db, () => {
      const r = db.prepare("INSERT INTO chats(user_id, character_id, user_card_id, kind, title, model_id, created_at, updated_at) VALUES (?, NULL, NULL, 'file', ?, ?, ?, ?)")
        .run(user.id, title, modelRow ? modelRow.id : null, now, now);
      const id = Number(r.lastInsertRowid);
      db.prepare('INSERT INTO chat_files(chat_id, files_json, instruction, text, total_chars, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, JSON.stringify(rec.files), instruction, rec.text, rec.total_chars, mode, now);
      if (mode === 'retrieval') {
        const ins = db.prepare('INSERT INTO chat_file_chunks(chat_id, idx, text) VALUES (?, ?, ?)');
        chunkText(rec.text).forEach((t, i) => ins.run(id, i, t));
      }
      return db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
    });
    await uploads.remove(b.upload_id); // 正文已随会话保存
    audit(ctx, {
      kind: 'chat.file_create', target_type: 'chat', target_id: chat.id,
      summary: `${userLabel(user)} 上传 ${okFiles.length} 个文件开聊（${rec.total_chars} 字，${mode === 'retrieval' ? '检索模式' : '整份'}）`,
      // 只记文件名、字数、模式，不记正文与说明
      detail: { chat_id: chat.id, files: rec.files.map((f) => ({ name: f.name, chars: f.chars || 0, ok: !!f.ok })), total_chars: rec.total_chars, mode, has_instruction: !!instruction, model_id: modelRow?.id ?? null },
    });
    const sse = String(ctx.req.headers.accept || '').includes('text/event-stream');
    const kick = kickoffText(instruction);
    if (sse) {
      return generate(ctx, chat.id, async () => ({ extraUser: kick, events: [{ event: 'chat', data: { chat: chatView(chat, user) } }] }));
    }
    let events = [];
    let error = null;
    try {
      events = await generate(ctx, chat.id, async () => ({ extraUser: kick }), { json: true });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      error = e.message; // 会话已建好：首条没生成出来，用户可以点「重新生成」
    }
    const done = events.find((e) => e.event === 'done');
    const err = events.find((e) => e.event === 'error');
    const fresh = db.prepare('SELECT * FROM chats WHERE id = ?').get(chat.id);
    return {
      chat: chatView(fresh, user),
      file: fileInfo(fileRowOf(chat.id)),
      message: done?.data?.message || err?.data?.message || null,
      ...(error || err ? { error: error || err.data.error, code: err?.data?.code || null } : {}),
    };
  }

  /** GET /api/chats/:id/file-text：抽出的全文（仅会话本人，契约 §17.4）。 */
  function fileChatText(ctx, id) {
    const c = ownChat(ctx.user, id);
    if (c.kind !== 'file') throw new HttpError(404, '这个会话没有上传文件');
    const f = db.prepare('SELECT * FROM chat_files WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
    if (!f) throw new HttpError(404, '这个会话没有上传文件');
    return { ...fileInfo(f), text: f.text };
  }

  // ---------- 语音输入（契约 §18，按 18.5）----------
  const clips = createClipStore(dataPath('voiceDir', 'voice') || nodePath.join('.', 'voice'));
  const asr = injectedAsr || createAsr({ keysFile: config.aiKeysFile || '', baseUrl: config.asrBase, model: config.asrModel, tmpDir: dataPath('tmpUploadDir', 'tmp-parse') });
  const voiceHits = new Map();
  const voiceBusy = new Map(); // userId → 正在识别的条数
  const VOICE_CONCURRENT_PER_USER = 2;
  /** 24 小时内保存的录音条数与字节数。 */
  const voiceUsage24h = (userId) => db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM voice_clips WHERE user_id = ? AND created_at > ?')
    .get(userId, new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  const voiceWarned = new Map(); // userId → 已提示过的日期（超过建议量只记一次 warn）
  /**
   * POST /api/voice/transcribe 的 preBody：限流、每人同时最多 2 条、每日上限（settings，0 = 不限只记录）、磁盘余量——都在读请求体之前。
   */
  async function voiceSlot(ctx) {
    const user = ctx.user;
    checkVoiceRate(user);
    if ((voiceBusy.get(user.id) || 0) >= VOICE_CONCURRENT_PER_USER) throw closeErr(429, '上一段录音还在识别，请稍候');
    const st = getSettings(db);
    const use = voiceUsage24h(user.id);
    if ((st.voice_daily_max_clips > 0 && use.n >= st.voice_daily_max_clips) || (st.voice_daily_max_mb > 0 && use.b >= st.voice_daily_max_mb * 1048576)) {
      throw closeErr(429, '今天的语音输入次数已用完，请明天再试或改用打字');
    }
    if ((use.n >= 200 || use.b >= 200 * 1048576) && voiceWarned.get(user.id) !== sgDay()) {
      voiceWarned.set(user.id, sgDay());
      console.warn(`[voice] 用户 #${user.id} 24 小时内已保存 ${use.n} 条录音（${Math.round(use.b / 1048576)}MB）`);
    }
    await checkDisk(ctx);
    voiceBusy.set(user.id, (voiceBusy.get(user.id) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (voiceBusy.get(user.id) || 1) - 1;
      if (n > 0) voiceBusy.set(user.id, n); else voiceBusy.delete(user.id);
    };
  }
  function checkVoiceRate(user) {
    const now = Date.now();
    const hits = (voiceHits.get(user.id) || []).filter((t) => t > now - 60_000);
    if (hits.length >= VOICE_RATE_PER_MINUTE) { voiceHits.set(user.id, hits); throw new HttpError(429, '语音识别太频繁，请稍后再试'); }
    hits.push(now);
    voiceHits.set(user.id, hits);
    if (voiceHits.size > 5000) for (const [k, v] of voiceHits) if (!v.some((t) => t > now - 60_000)) voiceHits.delete(k);
  }

  /**
   * 整理用模型：settings.voice_format_model_id（启用）→「DeepSeek 快速」→ 翻译同一套回落。
   * 与翻译共用模型熔断：选中的模型连续超时 / 上游 5xx 被熔断时，退到翻译那套里没熔断的 DeepSeek 模型（翻译服务写 warn）；
   * 都熔断了返回 null（跳过整理、直接用识别原文，不再等 30 秒超时）。
   */
  function voiceFormatModel() {
    const s = getSettings(db);
    const tr = chars.translations;
    const m = s.voice_format_model_id ? models.byId(s.voice_format_model_id) : null;
    if (m && m.enabled && !tr?.isTripped?.(m)) return m;
    if (tr?.model) return tr.model({ healthy: true, apiOnly: true });
    return models.systemDefault() || null;
  }

  /**
   * POST /api/voice/transcribe（原始音频请求体，≤10MB；可选 ?chat_id= 录音所在会话、?duration_ms= 前端计时）
   * → 原件按原格式落盘 → 百炼识别 → DeepSeek 整理 → {clip_id, raw_text, formatted_text, cost_usd}。
   * 识别失败时保留录音和错误状态，返回 503 + code，前端退回浏览器自带识别。
   */
  async function voiceTranscribe(ctx) {
    const user = ctx.user; // 限流 / 名额 / 每日上限 / 磁盘已在 preBody（voiceSlot）里查过
    const buf = ctx.rawBuf || Buffer.alloc(0);
    ctx.rawBuf = null;
    if (!buf.length) throw new HttpError(400, '没有收到录音');
    if (buf.length > VOICE_MAX_BYTES) throw new HttpError(413, '录音太长了，请分段说');
    const kind = sniffAudio(buf, ctx.req.headers['content-type']);
    if (!kind) throw new HttpError(415, '不支持这种录音格式');
    // 契约 §18.1 最长 60 秒。不合格的一律不落盘：
    //  · afinfo 能读的（mp4 / m4a / aac）不论大小都读时长：超长 → 413；体积与时长对不上（每秒超过 384kbps）→ 415；
    //  · 读不出时长的（webm / ogg 本来就读不了，或文件头是伪造的）：超过 2MB（≈65 秒 × 256kbps）一律拒；
    //  · 识别后再用上游返回的实际秒数核对一次（见下面），超长的删文件、记 error。
    if ((kind.ext === 'webm' || kind.ext === 'ogg') && buf.length > VOICE_OPUS_MAX_BYTES) throw new HttpError(413, VOICE_TOO_LONG);
    const probedSec = await probeDurationSec(buf, kind.ext, dataPath('tmpUploadDir', 'tmp-parse'));
    if (probedSec !== null) {
      if (probedSec > VOICE_MAX_SECONDS) throw new HttpError(413, VOICE_TOO_LONG);
      if (buf.length > Math.max(VOICE_UNPROBED_MAX_BYTES, probedSec * VOICE_MAX_BYTES_PER_SEC)) throw new HttpError(415, VOICE_BAD_AUDIO);
    } else if (buf.length > VOICE_UNPROBED_MAX_BYTES) {
      throw new HttpError(kind.ext === 'webm' || kind.ext === 'ogg' ? 413 : 415, kind.ext === 'webm' || kind.ext === 'ogg' ? VOICE_TOO_LONG : VOICE_BAD_AUDIO);
    }
    const q = ctx.url.searchParams;
    let chatId = null;
    const qc = (q.get('chat_id') || '').trim();
    if (qc) {
      if (!validId(qc)) throw new HttpError(400, '会话参数不正确');
      chatId = ownChat(user, qc).id;
    }
    const dq = Number(q.get('duration_ms'));
    let durationMs = Number.isFinite(dq) && dq > 0 ? Math.min(Math.round(dq), 10 * 60 * 1000) : null;
    if (durationMs && durationMs > VOICE_MAX_SECONDS * 1000) throw new HttpError(413, VOICE_TOO_LONG); // 前端自己计的时就已超长：不落盘
    if (!durationMs && probedSec) durationMs = Math.round(probedSec * 1000);
    // 上传类型声明里的 codecs 参数（audio/webm;codecs=opus）原样带给上游，主类型以魔数为准
    const declared = String(ctx.req.headers['content-type'] || '').toLowerCase();
    const sendMime = declared.startsWith(kind.mime) ? declared.replace(/\s+/g, '') : kind.mime;
    const file = await clips.save(user.id, buf, kind.ext);
    const now = nowIso();
    const ins = db.prepare('INSERT INTO voice_clips(user_id, chat_id, file, mime, bytes, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, chatId, file, kind.mime, buf.length, durationMs, now);
    const clipId = Number(ins.lastInsertRowid);
    const cny = getSettings(db).cny_to_usd;
    let cost = 0;
    let costKnown = true;
    let raw = '';
    let tooLongSec = 0;
    try {
      const r = await asr.transcribe(buf, { mime: sendMime, ext: kind.ext });
      if (r.seconds && r.seconds > VOICE_MAX_SECONDS) tooLongSec = r.seconds;
      raw = r.text;
      if (r.seconds) {
        if (!durationMs) durationMs = Math.round(r.seconds * 1000);
        const c = asrCostUsd(r.seconds, cny);
        cost += c;
        costs.recordSystemCost('voice', { user_id: user.id, cost_usd: c });
      } else costKnown = false;
    } catch (e) {
      const msg = e instanceof HttpError ? e.message : VOICE_UNAVAILABLE;
      db.prepare('UPDATE voice_clips SET error = ?, duration_ms = ? WHERE id = ?').run(msg, durationMs, clipId);
      audit(ctx, {
        level: 'warn', kind: 'voice.error', target_type: 'voice', target_id: clipId,
        summary: `语音识别失败（${msg}${e?.upstream_status ? `，HTTP ${e.upstream_status}` : ''}）`,
        detail: { clip_id: clipId, stage: 'asr', code: e?.code || 'asr_unavailable', http_status: e?.upstream_status ?? null, bytes: buf.length, mime: kind.mime },
      });
      if (e instanceof HttpError) { e.code = e.code || 'asr_unavailable'; throw e; }
      throw new HttpError(503, VOICE_UNAVAILABLE, 'asr_unavailable');
    }
    // 上游按实际时长返回秒数：超过 60 秒（含余量）的事后核对——花费照记，删掉原件、记 error，不给结果
    if (tooLongSec) {
      db.prepare('UPDATE voice_clips SET error = ?, duration_ms = ?, cost_usd = ? WHERE id = ?').run(VOICE_TOO_LONG, Math.round(tooLongSec * 1000), Math.round(cost * 1e10) / 1e10, clipId);
      const abs = clips.abs(file);
      if (abs) await rm(abs, { force: true }).catch(() => {});
      console.warn(`[voice] 用户 #${user.id} 录音 #${clipId} 实际 ${Math.round(tooLongSec)} 秒，超过上限，已删除原件`);
      throw new HttpError(413, VOICE_TOO_LONG);
    }
    // 静音录音被识别出的幻觉文字（如「Thank you.」）：判为没听清，不整理、不填进输入框
    let notHeard = false;
    if (raw && looksSilent({ bytes: buf.length, durationMs, ext: kind.ext, text: raw })) {
      notHeard = true;
      db.prepare('UPDATE voice_clips SET error = ? WHERE id = ?').run(VOICE_NOT_HEARD, clipId);
    }
    let formatted = raw;
    const fm = raw && !notHeard ? voiceFormatModel() : null;
    if (raw && !notHeard && !fm) {
      console.warn('[voice] 整理模型都在熔断中，本条直接用识别原文');
    } else if (raw && !notHeard) {
      try {
        formatted = await formatTranscript(llm, raw, {
          model: fm || undefined,
          onResult: (r) => { const c = costs.recordSystem('voice', fm, user.id, r); if (c?.cost_usd !== null && c?.cost_usd !== undefined) cost += c.cost_usd; else costKnown = false; },
        });
        chars.translations?.noteOk?.(fm);
      } catch (e) {
        // 整理失败不影响：直接用识别原文
        chars.translations?.noteFail?.(fm, e);
        if (e?.usage) { try { costs.recordSystem('voice', fm, user.id, e); } catch { /* ignore */ } }
        audit(ctx, {
          level: 'warn', kind: 'voice.error', target_type: 'voice', target_id: clipId,
          summary: `语音整理失败，已用识别原文（${e instanceof HttpError ? e.message : '调用失败'}）`,
          detail: { clip_id: clipId, stage: 'format', code: e?.code || 'upstream', model: fm?.name ?? null },
        });
        formatted = raw;
      }
    }
    const costUsd = Math.round(cost * 1e10) / 1e10;
    db.prepare('UPDATE voice_clips SET raw_text = ?, formatted_text = ?, cost_usd = ?, duration_ms = ? WHERE id = ?').run(raw, notHeard ? '' : formatted, costUsd, durationMs, clipId);
    if (notHeard) return { clip_id: clipId, raw_text: '', formatted_text: '', cost_usd: round6(costUsd), cost_partial: !costKnown, empty: true, notice: VOICE_NOT_HEARD };
    return { clip_id: clipId, raw_text: raw, formatted_text: formatted, cost_usd: round6(costUsd), cost_partial: !costKnown, ...(raw ? {} : { empty: true }) };
  }

  // ---------- 路由表 ----------
  // auth: 'none' | 'user'（任何登录用户）| 'staff'（admin 或 super）| 'super'（只限超级管理员）
  // opts.raw：上传接口，请求体按 Buffer 读，允许图片 / multipart / octet-stream；opts.limit：请求体上限（字节）。
  const R = (method, pattern, auth, fn, opts = {}) => ({ method, pattern, auth, fn, opts });
  const routes = [
    R('POST', /^\/api\/login$/, 'none', login),
    R('POST', /^\/api\/logout$/, 'none', logout),
    R('GET', /^\/api\/me$/, 'user', me, { allowMustChange: true, optionalAuth: true }),
    R('PATCH', /^\/api\/me$/, 'user', patchMe),
    R('POST', /^\/api\/me\/password$/, 'user', changePassword, { allowMustChange: true }),
    R('GET', /^\/api\/me\/logins$/, 'user', myLogins),
    // 邀请码注册 + 公开重置（契约 §13），无需登录
    R('GET', /^\/api\/register\/check$/, 'none', registerCheck),
    R('POST', /^\/api\/register$/, 'none', register),
    R('POST', /^\/api\/password\/reset$/, 'none', passwordReset),
    R('GET', /^\/api\/home$/, 'user', home),
    R('GET', /^\/api\/translation\/models$/, 'user', translationModels),
    R('GET', /^\/api\/search$/, 'user', search),
    R('GET', /^\/api\/characters\/(.+\/.+)\/translations$/, 'user', characterTranslations),
    R('POST', /^\/api\/characters\/(.+\/.+)\/translations\/select$/, 'user', characterSelectTranslation, { limit: 4096 }),
    R('GET', /^\/api\/characters\/(.+)$/, 'user', characterDetail),
    R('POST', /^\/api\/characters\/(.+)\/translate$/, 'user', characterRetranslate, { limit: 4096 }),
    R('GET', /^\/api\/avatar$/, 'user', avatar),
    R('GET', /^\/api\/images$/, 'user', imageList),
    R('GET', /^\/api\/character-images$/, 'user', characterImages),
    R('GET', /^\/api\/images\/([^/]+)$/, 'user', imageMedia),
    R('GET', /^\/api\/chats$/, 'user', listChats),
    R('POST', /^\/api\/chats$/, 'user', createChat),
    R('GET', /^\/api\/chats\/(\d+)$/, 'user', getChat),
    R('DELETE', /^\/api\/chats\/(\d+)$/, 'user', deleteChat),
    R('PATCH', /^\/api\/chats\/(\d+)$/, 'user', patchChat),
    // 本会话设定（契约 §20.1）
    R('GET', /^\/api\/chats\/(\d+)\/settings$/, 'user', getChatSettings),
    R('PATCH', /^\/api\/chats\/(\d+)\/settings$/, 'user', patchChatSettings, { limit: CARD_BODY_LIMIT }),
    R('DELETE', /^\/api\/chats\/(\d+)\/settings$/, 'user', resetChatSettings),
    R('GET', /^\/api\/models$/, 'user', listModels),
    // 自建卡 / 剧情卡（契约 §12）
    R('GET', /^\/api\/my\/cards$/, 'user', myCards),
    R('POST', /^\/api\/cards$/, 'user', createCard, { limit: CARD_BODY_LIMIT }),
    R('POST', /^\/api\/cards\/fork$/, 'user', forkCard),
    R('POST', /^\/api\/cards\/import$/, 'user', importCard, { raw: true, limit: Math.ceil(IMPORT_MAX_BYTES * 1.4) }),
    R('GET', /^\/api\/cards\/(\d+)$/, 'user', getCard),
    R('PATCH', /^\/api\/cards\/(\d+)$/, 'user', patchCard, { limit: CARD_BODY_LIMIT }),
    R('DELETE', /^\/api\/cards\/(\d+)$/, 'user', deleteCard),
    R('POST', /^\/api\/cards\/(\d+)\/avatar$/, 'user', uploadCardAvatar, { raw: true, limit: Math.ceil(AVATAR_MAX_BYTES * 1.4) }),
    R('GET', /^\/api\/cards\/(\d+)\/export$/, 'user', exportCard),
    R('GET', /^\/api\/card-avatar\/([^/]+)$/, 'user', cardAvatar),
    R('GET', /^\/api\/community$/, 'user', community),
    R('POST', /^\/api\/chats\/(\d+)\/messages$/, 'user', postMessage),
    R('POST', /^\/api\/chats\/(\d+)\/regenerate$/, 'user', regenerate),
    R('PATCH', /^\/api\/messages\/(\d+)$/, 'user', patchMessage),
    R('DELETE', /^\/api\/messages\/(\d+)$/, 'user', deleteMessage),
    R('POST', /^\/api\/messages\/(\d+)\/rewind$/, 'user', rewindMessage),
    // 上传文件快速开聊（契约 §17）
    R('POST', /^\/api\/file-chats\/parse$/, 'user', fileChatParse, { raw: true, anyType: true, limit: FILE_MAX_BYTES * FILES_MAX + 2 * 1024 * 1024, preBody: parseSlot }),
    R('POST', /^\/api\/file-chats$/, 'user', createFileChat),
    R('GET', /^\/api\/chats\/(\d+)\/file-text$/, 'user', fileChatText),
    // 语音输入（契约 §18）
    R('POST', /^\/api\/voice\/transcribe$/, 'user', voiceTranscribe, { raw: true, types: AUDIO_UPLOAD_TYPES, limit: VOICE_MAX_BYTES, preBody: voiceSlot }),
    R('GET', /^\/api\/admin\/users$/, 'staff', adminListUsers),
    R('POST', /^\/api\/admin\/users$/, 'staff', adminCreateUser),
    R('PATCH', /^\/api\/admin\/users\/(\d+)$/, 'staff', adminPatchUser),
    R('DELETE', /^\/api\/admin\/users\/(\d+)$/, 'staff', adminDeleteUser),
    R('POST', /^\/api\/admin\/users\/(\d+)\/reset-code$/, 'staff', adminIssueResetCode),
    R('GET', /^\/api\/admin\/invites$/, 'staff', adminListInvites),
    R('POST', /^\/api\/admin\/invites$/, 'staff', adminCreateInvite),
    R('POST', /^\/api\/admin\/invites\/(\d+)\/disable$/, 'staff', adminDisableInvite),
    R('GET', /^\/api\/admin\/usage$/, 'staff', adminUsage),
    R('GET', /^\/api\/admin\/shelves$/, 'super', adminListShelves),
    R('POST', /^\/api\/admin\/shelves$/, 'super', adminCreateShelf),
    R('PATCH', /^\/api\/admin\/shelves\/(\d+)$/, 'super', adminPatchShelf),
    R('DELETE', /^\/api\/admin\/shelves\/(\d+)$/, 'super', adminDeleteShelf),
    R('POST', /^\/api\/admin\/shelves\/(\d+)\/items$/, 'super', adminAddShelfItem),
    R('DELETE', /^\/api\/admin\/shelves\/(\d+)\/items\/(.+)$/, 'super', adminDeleteShelfItem),
    R('POST', /^\/api\/admin\/shelves\/(\d+)\/order$/, 'super', adminOrderShelf),
    R('GET', /^\/api\/admin\/settings$/, 'super', adminGetSettings),
    R('GET', /^\/api\/admin\/translation\/cli-status$/, 'super', adminTranslationCliStatus),
    R('PATCH', /^\/api\/admin\/settings$/, 'super', adminPatchSettings),
    R('GET', /^\/api\/admin\/models$/, 'super', adminListModels),
    R('POST', /^\/api\/admin\/models$/, 'super', adminCreateModel),
    R('POST', /^\/api\/admin\/models\/order$/, 'super', adminOrderModels),
    R('PATCH', /^\/api\/admin\/models\/(\d+)$/, 'super', adminPatchModel),
    R('DELETE', /^\/api\/admin\/models\/(\d+)$/, 'super', adminDeleteModel),
    R('POST', /^\/api\/admin\/models\/(\d+)\/test$/, 'super', adminTestModel),
    R('POST', /^\/api\/admin\/models\/(\d+)\/sync-price$/, 'super', adminSyncModelPrice),
    R('GET', /^\/api\/admin\/cards$/, 'super', adminListCards),
    R('GET', /^\/api\/admin\/cards\/(\d+)$/, 'super', adminGetCard),
    // 系统日志（契约 §11.3）：只限 super，只读，访问本身不记日志。
    R('GET', /^\/api\/admin\/logs$/, 'super', (ctx) => queryLogs(db, ctx.url.searchParams)),
    R('GET', /^\/api\/admin\/logs\/kinds$/, 'super', () => logKinds(db)),
    // 抓取监控（契约 §15）：查看 staff，操作只限 super
    R('GET', /^\/api\/admin\/crawler\/status$/, 'staff', crawlerStatus),
    R('GET', /^\/api\/admin\/crawler\/exits$/, 'staff', crawlerExits),
    R('POST', /^\/api\/admin\/crawler\/phase\/([^/]+)\/([^/]+)$/, 'super', crawlerPhase, { limit: 4096 }),
    R('POST', /^\/api\/admin\/crawler\/(pause-all|resume-all)$/, 'super', crawlerAll, { limit: 4096 }),
    R('PUT', /^\/api\/admin\/crawler\/config$/, 'super', crawlerConfig, { limit: 16384 }),
    R('POST', /^\/api\/admin\/crawler\/exits\/([^/]+)\/([^/]+)$/, 'super', crawlerExit, { limit: 4096 }),
  ];

  /** CSRF：写请求校验 Origin 与 Host 一致（或没有 Origin），有请求体时必须是 JSON。 */
  const UPLOAD_TYPES = ['application/json', 'application/octet-stream', 'image/png', 'image/jpeg', 'image/webp', 'multipart/form-data'];
  function checkWrite(req, route) {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let oh = '';
      try { oh = new URL(origin).host; } catch { /* 'null' 等 */ }
      if (!oh || oh.toLowerCase() !== String(req.headers.host || '').toLowerCase()) throw new HttpError(403, '请求来源不被允许');
    }
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (route?.opts?.raw) {
      if (route.opts.anyType) return; // 文件解析：任何类型都收，按扩展名 / 魔数再判（不支持的给出支持列表）
      if (route.opts.types) {
        if (hasBody && !route.opts.types.some((t) => ct.startsWith(t))) throw new HttpError(415, '不支持这种录音格式');
        return;
      }
      if (hasBody && !UPLOAD_TYPES.some((t) => ct.startsWith(t))) throw new HttpError(415, '只支持上传 JSON、PNG、JPEG、WebP 文件');
      return;
    }
    if (hasBody && !ct.startsWith('application/json')) throw new HttpError(415, '请求格式必须是 JSON');
  }

  async function handleApi(req, res, url) {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const p = url.pathname;
    let route = null;
    let match = null;
    let pathMatched = false;
    for (const r of routes) {
      const m = r.pattern.exec(p);
      if (!m) continue;
      pathMatched = true;
      if (r.method === method) { route = r; match = m; break; }
    }
    if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? '不支持的请求方式' : '接口不存在');
    if (method !== 'GET') checkWrite(req, route);
    const ctx = { req, res, url, user: null, setCookie: null, rawBody: '' };
    // 鉴权一律看 role（契约 §9.2），is_admin 只是兼容字段。
    const authorize = () => {
      const s = lookupSession(db, req);
      if (!s && route.opts.optionalAuth && method === 'GET') { ctx.user = null; return; } // 只有 GET /api/me
      if (!s) throw new HttpError(401, '请先登录');
      ctx.user = s.user;
      if (s.refreshed) ctx.setCookie = sessionCookie(s.token, req, Math.floor(SESSION_TTL_MS / 1000));
      // 契约 §13.3：首次登录强制改密——只放行 GET /api/me 与 POST /api/me/password（/api/logout 不需登录本就放行）。
      if (s.user.must_change_password && !route.opts.allowMustChange) throw new HttpError(403, '请先修改初始密码', 'must_change_password');
      const role = roleOf(s.user);
      if (route.auth === 'staff' && role !== 'admin' && role !== 'super') throw new HttpError(403, '没有权限');
      if (route.auth === 'super' && role !== 'super') throw new HttpError(403, '没有权限');
    };
    if (route.auth !== 'none') authorize(); // 先挡掉没登录 / 没权限的，不替他们读请求体
    let release = null;
    try {
      if (method !== 'GET') {
        if (route.opts.raw) {
          // 上传：声明长度超限直接 413；名额（preBody）与全站「正在读的上传字节」都在读请求体之前占，拿不到就拒（不读进内存）
          const declared = Number(req.headers['content-length'] || 0);
          if (declared > route.opts.limit) throw closeErr(413, '提交的内容太大');
          if (route.opts.preBody) release = await route.opts.preBody(ctx);
          const reserve = declared > 0 ? declared : route.opts.limit;
          if (uploadBytesReading + reserve > UPLOAD_READING_MAX_BYTES) throw closeErr(503, '上传的人太多了，请稍后再试');
          uploadBytesReading += reserve;
          try {
            ctx.rawBuf = await readBodyBuffer(req, route.opts.limit);
          } finally {
            uploadBytesReading -= reserve;
          }
          if (String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) ctx.rawBody = ctx.rawBuf.toString('utf8');
        } else {
          ctx.rawBody = await readBody(req, route.opts.limit);
        }
        // 读请求体可能很慢（客户端可以慢速发送）；期间操作者可能已被停用、降级或登出。
        // 读完后重新查会话与角色，之后到写库之间不再有 await，鉴权与写入在同一个同步段里完成。
        if (route.auth !== 'none') authorize();
      }
      const args = match.slice(1).map((a) => { try { return decodeURIComponent(a); } catch { throw new HttpError(400, '地址不正确'); } });
      if (ctx.setCookie) res.setHeader('Set-Cookie', ctx.setCookie);
      const out = await route.fn(ctx, ...args);
      if (out === undefined) return; // 已自行响应（SSE / 图片）
      sendJson(res, 200, out, ctx.setCookie ? { 'Set-Cookie': ctx.setCookie } : {});
    } finally {
      ctx.rawBuf = null;
      if (release) release();
    }
  }

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { sendJson(res, 400, { error: '地址不正确' }); return; }
    try {
      if (url.pathname === '/healthz') { sendJson(res, 200, { ok: true }); return; }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) { await handleApi(req, res, url); return; }
      await serveStatic(req, res, url, config.publicDir);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500 && !(e instanceof HttpError)) console.error('[http]', req.method, url.pathname, e?.stack || e);
      // 带机器可读 code 的 HttpError（如 must_change_password）把 code 一并返回。
      // closeConn：请求体没读（名额不够 / 声明太大），回完就断开连接，不替对方收上百 MB
      if (!res.headersSent) sendJson(res, status, e instanceof HttpError ? { error: e.message, ...(e.code ? { code: e.code } : {}) } : { error: '服务器内部错误' }, e?.closeConn ? { Connection: 'close' } : {});
      else if (!res.writableEnded) res.end();
    }
  }

  return { handle, close: async () => {
    previewWarmupClosed = true; clearTimeout(previewWarmupTimer);
    cancelPreviewWarmupRead?.();
    mirrorImages.close(); mirrorCharacters.close();
    await grokCli?.close();
  } };
}
