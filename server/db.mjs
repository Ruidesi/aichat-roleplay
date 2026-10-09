// node:sqlite 建表与迁移（契约 §4）。PRAGMA user_version 记迁移版本。
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { presetPriceFor, costOf, hasPrice, isXaiUrl, DEFAULT_CNY_TO_USD } from './pricing.mjs';
import { writeLog, parseRetentionDays, DEFAULT_LOG_RETENTION_DAYS } from './logs.mjs';

export const XAI_DEFAULT_PROXY = 'http://127.0.0.1:42001';

const MIGRATIONS = [
  // v1：初始表
  `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    is_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    nsfw_enabled INTEGER NOT NULL DEFAULT 0,
    persona_name TEXT NOT NULL DEFAULT '',
    persona_desc TEXT NOT NULL DEFAULT '',
    daily_limit INTEGER NULL,
    created_at TEXT NOT NULL,
    last_login_at TEXT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chub_path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    tagline TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    nsfw INTEGER NOT NULL DEFAULT 0,
    card_json TEXT NOT NULL DEFAULT '{}',
    greeting_zh TEXT NULL,
    fetched_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shelves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shelf_items (
    shelf_id INTEGER NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    sort INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (shelf_id, character_id)
  );
  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    character_id INTEGER NOT NULL REFERENCES characters(id),
    title TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id, updated_at);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    model TEXT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
  CREATE TABLE IF NOT EXISTS usage_daily (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    messages INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  `,
  // v2（契约 §8）：模型表；用户默认模型；会话模型。只加表加列，旧数据不动。
  `
  CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    base_url TEXT NOT NULL,
    api_key_env TEXT NULL,
    api_key_enc TEXT NULL,
    model TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0,
    extra_json TEXT NULL,
    created_at TEXT NOT NULL
  );
  ALTER TABLE users ADD COLUMN default_model_id INTEGER NULL;
  ALTER TABLE chats ADD COLUMN model_id INTEGER NULL;
  `,
  // v3（契约 §9）：三层权限。users 加 role / created_by；按旧 is_admin 推出角色；旧数据不动。
  //   用户名 admin 且在 v0.2 里仍是启用的管理员（is_admin=1 AND disabled=0）→ super；
  //     v0.2 里被降成普通用户或被停用的 admin 账号不升 super（防普通用户被提成超管 / 迁出 0 个启用的 super）。
  //   兜底：还没有启用的 super 时，把 id 最小的启用管理员升为 super，保证至少一个启用的 super。
  //   其他 is_admin=1 → admin；其余 → tenant。
  //   已有账号（除 super 本身）的 created_by = 那个启用的 super 的 id（没有就留空）。is_admin 按 role 同步（只为兼容，不再用于鉴权）。
  `
  ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'tenant';
  ALTER TABLE users ADD COLUMN created_by INTEGER NULL;
  UPDATE users SET role = 'super' WHERE username = 'admin' AND is_admin = 1 AND disabled = 0;
  UPDATE users SET role = 'super'
    WHERE id = (SELECT id FROM users WHERE is_admin = 1 AND disabled = 0 ORDER BY id LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'super' AND disabled = 0);
  UPDATE users SET role = 'admin' WHERE is_admin = 1 AND role <> 'super';
  UPDATE users SET created_by = (SELECT id FROM users WHERE role = 'super' AND disabled = 0 ORDER BY id LIMIT 1)
    WHERE role <> 'super';
  UPDATE users SET is_admin = CASE WHEN role = 'tenant' THEN 0 ELSE 1 END;
  CREATE INDEX IF NOT EXISTS idx_users_created_by ON users(created_by);
  CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at);
  `,
  // v4（契约 §10）：出站代理 + 计费。SQL 加列加表，再用 JS 做：xAI 行自动设代理、预置单价（只填空着的）、旧消息费用回填。
  migrateV4,
  // v5（契约 §11）：系统 / 操作日志。只加表，旧数据不动。
  `
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
    kind TEXT NOT NULL,
    actor_id INTEGER NULL,
    actor_name TEXT NULL,
    target_type TEXT NULL,
    target_id INTEGER NULL,
    ip TEXT NULL,
    summary TEXT NOT NULL DEFAULT '',
    detail_json TEXT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_logs_at ON logs(at);
  CREATE INDEX IF NOT EXISTS idx_logs_kind_at ON logs(kind, at);
  CREATE INDEX IF NOT EXISTS idx_logs_actor_at ON logs(actor_id, at);
  `,
  // v6（契约 §12）：自建角色卡 / 剧情卡 + 全面软删除。chats 要让 character_id 可空（与 user_card_id 二选一），只能重建表；
  // 重建期间外键检查由 openDb 关掉（官方 12 步法），完事后 foreign_key_check 复核。旧数据一条不丢。
  migrateV6,
  // v7（契约 §13 / §14）：邀请码、重置码、账号备注、首次登录强制改密；登录记录按 target 查的索引。只加表加列，旧数据不动
  // （旧账号 note 为空、must_change_password=0）。password_resets.revoked_at：同一用户签发新码时旧码作废（契约没写列，最稳妥做法）。
  `
  CREATE TABLE IF NOT EXISTS invite_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    creator_id INTEGER NOT NULL REFERENCES users(id),
    note TEXT NOT NULL,
    max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 10000),
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    disabled_at TEXT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_invite_codes_creator ON invite_codes(creator_id, id);
  ALTER TABLE users ADD COLUMN note TEXT NULL;
  ALTER TABLE users ADD COLUMN invite_code_id INTEGER NULL REFERENCES invite_codes(id);
  ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_users_invite ON users(invite_code_id);
  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    code_hash TEXT NOT NULL,
    issued_by INTEGER NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT NULL,
    revoked_at TEXT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id, id);
  CREATE INDEX IF NOT EXISTS idx_logs_target_at ON logs(target_type, target_id, at);
  `,
  // v8：保留历史迁移编号。旧部署已有存储保持原样，新库无需新增表。
  () => {},
  // v9（契约 §19 / §20）：角色卡完整翻译缓存 + 全站标签译名表 + 列表译文；会话设定覆盖 + 会话事件。只加表加列，旧数据不动。
  //   characters.translate_hash：card_json + 名字 + 简介的哈希，源卡内容变了就重翻（契约「card_json 哈希变则重翻」）。
  //   chub_list_zh：列表里还没打开过（没进 characters）的 chub 卡的 name / tagline 译文（契约只写了「服务端批量翻译」，存这张表最稳妥），
  //     card_snapshot 供中文名搜索返回卡片。
  //   chat_events：「已更新本会话设定」之类的会话事件（契约 §20.1「写入会话事件，不进提示词历史」）。
  `
  ALTER TABLE characters ADD COLUMN card_json_zh TEXT NULL;
  ALTER TABLE characters ADD COLUMN name_zh TEXT NULL;
  ALTER TABLE characters ADD COLUMN tagline_zh TEXT NULL;
  ALTER TABLE characters ADD COLUMN tags_zh_json TEXT NULL;
  ALTER TABLE characters ADD COLUMN translated_at TEXT NULL;
  ALTER TABLE characters ADD COLUMN translate_status TEXT NULL CHECK (translate_status IS NULL OR translate_status IN ('pending','ok','partial','failed'));
  ALTER TABLE characters ADD COLUMN translate_hash TEXT NULL;
  CREATE INDEX IF NOT EXISTS idx_characters_name_zh ON characters(name_zh);
  CREATE TABLE IF NOT EXISTS tag_translations (
    tag TEXT PRIMARY KEY,
    zh TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chub_list_zh (
    path TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    tagline TEXT NOT NULL DEFAULT '',
    name_zh TEXT NULL,
    tagline_zh TEXT NULL,
    card_snapshot TEXT NULL,
    translated_at TEXT NOT NULL
  );
  ALTER TABLE chats ADD COLUMN card_override_json TEXT NULL;
  ALTER TABLE chats ADD COLUMN persona_override_json TEXT NULL;
  CREATE TABLE IF NOT EXISTS chat_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id),
    kind TEXT NOT NULL,
    after_message_id INTEGER NULL,
    detail_json TEXT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_events_chat ON chat_events(chat_id, id);
  `,
  // v10（契约 §17 / §18）：文件会话 + 语音输入。chats 加 kind，文件会话 character_id / user_card_id 都为空，
  // 原 CHECK 不允许，只能重建表（同 v6 的做法，外键检查由 openDb 关掉，完事 foreign_key_check 复核）。
  // system_costs.kind 的 CHECK 也要放开 'voice'（以及 §16 预留的 'generate'），同样重建。旧数据一条不丢。
  migrateV10,
  // v11（契约 §19.3）：整卡翻译的译名表 {原词: 中文}（源卡变了跟着重建）。只加列。
  `
  ALTER TABLE characters ADD COLUMN glossary_json TEXT NULL;
  `,
  // v12（契约 §21）：每个账号的阅读设定。只加列，旧资料、密码和会话不动。
  `
  ALTER TABLE users ADD COLUMN reading_settings_json TEXT NOT NULL DEFAULT '{}';
  `,
  // v13：整卡翻译保留模型与版本历史；每个账号独立选择译文。旧缓存与会话保持原样。
  `
  CREATE TABLE character_translations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    source_hash TEXT NOT NULL,
    model_id INTEGER NULL,
    model_name TEXT NOT NULL,
    model_provider TEXT NOT NULL,
    model_slug TEXT NOT NULL,
    model_fingerprint TEXT NOT NULL,
    card_json_zh TEXT NULL,
    name_zh TEXT NULL,
    tagline_zh TEXT NULL,
    glossary_json TEXT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok','partial','failed')),
    created_at TEXT NOT NULL,
    created_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    version INTEGER NOT NULL DEFAULT 1,
    error TEXT NULL
  );
  CREATE INDEX idx_character_translations_source ON character_translations(character_id, source_hash, id);
  CREATE INDEX idx_character_translations_model ON character_translations(character_id, source_hash, model_fingerprint, id);
  CREATE TABLE user_character_translation_selections (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    translation_id INTEGER NULL REFERENCES character_translations(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, character_id)
  );
  `,
  // v14：CLI 翻译的成人向标记与人工复核提示，旧译文保持原样。
  `ALTER TABLE character_translations ADD COLUMN review_json TEXT NULL;`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

const SGT_OFFSET_MS = 8 * 3600 * 1000;
/** UTC ISO → 新加坡日期（不依赖 Intl，迁移里用）。 */
const sgDayOf = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t + SGT_OFFSET_MS).toISOString().slice(0, 10) : null; };

function migrateV4(db) {
  db.exec(`
    ALTER TABLE models ADD COLUMN proxy_url TEXT NULL;
    ALTER TABLE models ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
    ALTER TABLE models ADD COLUMN price_in REAL NULL;
    ALTER TABLE models ADD COLUMN price_in_cached REAL NULL;
    ALTER TABLE models ADD COLUMN price_out REAL NULL;
    ALTER TABLE messages ADD COLUMN tokens_in_cached INTEGER NULL;
    ALTER TABLE messages ADD COLUMN tokens_reasoning INTEGER NULL;
    ALTER TABLE messages ADD COLUMN cost_usd REAL NULL;
    ALTER TABLE messages ADD COLUMN cost_source TEXT NULL;
    ALTER TABLE usage_daily ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS system_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('translate','test')),
      model_id INTEGER NULL,
      user_id INTEGER NULL,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_in_cached INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NULL,
      cost_source TEXT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_system_costs_created ON system_costs(created_at);
  `);
  const models = db.prepare('SELECT * FROM models ORDER BY id').all();
  // 1. api.x.ai 且没配代理的行：默认走本机代理（不改 enabled）。
  const setProxy = db.prepare('UPDATE models SET proxy_url = ? WHERE id = ?');
  for (const m of models) if (!m.proxy_url && isXaiUrl(m.base_url)) setProxy.run(XAI_DEFAULT_PROXY, m.id);
  // 2. 预置单价：三档都空着的行才填（币种一起填）。
  fillPresetPrices(db);
  // 3. 旧消息回填：有 token 数、模型有单价的 assistant 消息，按当前单价补 cost_usd（estimate）；同时累加进 usage_daily。
  const rate = Number(db.prepare("SELECT value FROM settings WHERE key = 'cny_to_usd'").get()?.value);
  const cnyToUsd = Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_CNY_TO_USD;
  const priced = db.prepare('SELECT * FROM models ORDER BY id').all();
  const byId = new Map(priced.map((m) => [m.id, m]));
  const byModel = new Map();
  for (const m of priced) if (!byModel.has(m.model)) byModel.set(m.model, m);
  const rows = db.prepare(`
    SELECT m.id, m.tokens_in, m.tokens_out, m.model, m.created_at, ch.model_id AS chat_model_id, ch.user_id
    FROM messages m JOIN chats ch ON ch.id = m.chat_id
    WHERE m.role = 'assistant' AND m.cost_usd IS NULL AND (m.tokens_in > 0 OR m.tokens_out > 0)
  `).all();
  const upd = db.prepare("UPDATE messages SET cost_usd = ?, cost_source = 'estimate' WHERE id = ?");
  const addDaily = db.prepare('UPDATE usage_daily SET cost_usd = cost_usd + ? WHERE user_id = ? AND day = ?');
  // 每个 (用户, 日) 现存消息的 token 合计与各模型用量，供第 4 步补算已删除 / 重新生成的那部分。
  const seen = new Map(); // `${user_id}|${day}` → { tin, tout, byModel: Map(modelRow → tokens) }
  const seenOf = (uid, day) => {
    const k = `${uid}|${day}`;
    let v = seen.get(k);
    if (!v) { v = { tin: 0, tout: 0, byModel: new Map() }; seen.set(k, v); }
    return v;
  };
  for (const r of rows) {
    // 先认消息里记的真实模型 ID；对不上再用会话当时的模型行。
    const chatModel = byId.get(r.chat_model_id);
    const m = (chatModel && chatModel.model === r.model) ? chatModel : (byModel.get(r.model) || chatModel);
    const day = sgDayOf(r.created_at);
    if (day) {
      const v = seenOf(r.user_id, day);
      v.tin += r.tokens_in || 0;
      v.tout += r.tokens_out || 0;
      if (m && hasPrice(m)) v.byModel.set(m, (v.byModel.get(m) || 0) + (r.tokens_in || 0) + (r.tokens_out || 0));
    }
    if (!m) continue;
    // 按消息自己的时刻计价（DeepSeek 分时）。
    const { cost_usd } = costOf(m, { tokens_in: r.tokens_in, tokens_in_cached: 0, tokens_out: r.tokens_out, tokens_reasoning: 0, cost_ticks: null }, { cnyToUsd, usageEstimated: true, at: r.created_at });
    if (cost_usd === null) continue;
    upd.run(cost_usd, r.id);
    if (day) addDaily.run(cost_usd, r.user_id, day);
  }
  // 4. usage_daily 里有、现存消息里没有的 token（回复被删除 / 重新生成 / 会话被删）：按该用户当天用得最多的模型补算一笔估算；
  //    当天没有可认的消息就用用户默认模型 → 全站默认 → 第一个模型。不知道具体时刻，按当天 10:00（北京 / 新加坡时间）计价：
  //    工作日按 DeepSeek 高峰价（可能偏高），周末与法定节假日按空闲价。
  const settingDefault = Number(db.prepare("SELECT value FROM settings WHERE key = 'default_model_id'").get()?.value);
  const userDefaults = new Map(db.prepare('SELECT id, default_model_id FROM users').all().map((u) => [u.id, u.default_model_id]));
  const pricedOnly = (m) => (m && hasPrice(m) ? m : null);
  const fallbackModel = (uid) => pricedOnly(byId.get(userDefaults.get(uid))) || pricedOnly(byId.get(settingDefault))
    || priced.slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id - b.id).find(hasPrice) || null;
  const daily = db.prepare('SELECT user_id, day, tokens_in, tokens_out FROM usage_daily WHERE tokens_in > 0 OR tokens_out > 0').all();
  for (const d of daily) {
    const v = seen.get(`${d.user_id}|${d.day}`);
    const remIn = Math.max(0, (d.tokens_in || 0) - (v?.tin || 0));
    const remOut = Math.max(0, (d.tokens_out || 0) - (v?.tout || 0));
    if (!remIn && !remOut) continue;
    let m = null;
    let best = -1;
    for (const [mm, n] of v?.byModel || []) if (n > best) { best = n; m = mm; }
    if (!m) m = fallbackModel(d.user_id);
    if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(d.day)) continue;
    const { cost_usd } = costOf(m, { tokens_in: remIn, tokens_in_cached: 0, tokens_out: remOut, tokens_reasoning: 0, cost_ticks: null }, { cnyToUsd, usageEstimated: true, at: `${d.day}T02:00:00.000Z` });
    if (cost_usd === null) continue;
    addDaily.run(cost_usd, d.user_id, d.day);
  }
}

function migrateV6(db) {
  const oldSeq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'chats'").get()?.seq ?? 0;
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL DEFAULT 'character' CHECK (kind IN ('character','scenario')),
      name TEXT NOT NULL DEFAULT '',
      tagline TEXT NOT NULL DEFAULT '',
      avatar_file TEXT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      nsfw INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
      card_json TEXT NOT NULL DEFAULT '{}',
      forked_from_type TEXT NULL CHECK (forked_from_type IS NULL OR forked_from_type IN ('chub','user')),
      forked_from_ref TEXT NULL,
      forked_from_name TEXT NULL,
      forked_from_author TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_cards_owner ON user_cards(owner_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_user_cards_public ON user_cards(visibility, updated_at);

    CREATE TABLE chats_v6 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character_id INTEGER NULL REFERENCES characters(id),
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      model_id INTEGER NULL,
      user_card_id INTEGER NULL REFERENCES user_cards(id),
      deleted_at TEXT NULL,
      CHECK ((character_id IS NULL) <> (user_card_id IS NULL))
    );
    INSERT INTO chats_v6(id, user_id, character_id, title, created_at, updated_at, model_id)
      SELECT id, user_id, character_id, title, created_at, updated_at, model_id FROM chats;
    DROP TABLE chats;
    ALTER TABLE chats_v6 RENAME TO chats;
    CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at);
    CREATE INDEX IF NOT EXISTS idx_chats_card ON chats(user_card_id);

    ALTER TABLE messages ADD COLUMN deleted_at TEXT NULL;
    ALTER TABLE messages ADD COLUMN deleted_reason TEXT NULL;
    ALTER TABLE users ADD COLUMN deleted_at TEXT NULL;
  `);
  // AUTOINCREMENT 计数器跟着搬：新会话 id 不能复用被硬删过的旧 id（会话 id 是唯一标识）。
  if (oldSeq > 0) {
    const cur = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'chats'").get();
    if (!cur) db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('chats', ?)").run(oldSeq);
    else if (cur.seq < oldSeq) db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'chats'").run(oldSeq);
  }
  const bad = db.prepare('PRAGMA foreign_key_check').all();
  if (bad.length) throw new Error(`迁移 v6 外键检查不通过：${bad.length} 处`);
}

function migrateV10(db) {
  const seqOf = (name) => db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(name)?.seq ?? 0;
  const chatSeq = seqOf('chats');
  const costSeq = seqOf('system_costs');
  db.exec(`
    CREATE TABLE chats_v10 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character_id INTEGER NULL REFERENCES characters(id),
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      model_id INTEGER NULL,
      user_card_id INTEGER NULL REFERENCES user_cards(id),
      deleted_at TEXT NULL,
      card_override_json TEXT NULL,
      persona_override_json TEXT NULL,
      kind TEXT NOT NULL DEFAULT 'character' CHECK (kind IN ('character','user_card','file')),
      CHECK ((kind = 'file' AND character_id IS NULL AND user_card_id IS NULL)
          OR (kind <> 'file' AND (character_id IS NULL) <> (user_card_id IS NULL)))
    );
    INSERT INTO chats_v10(id, user_id, character_id, title, created_at, updated_at, model_id, user_card_id, deleted_at, card_override_json, persona_override_json, kind)
      SELECT id, user_id, character_id, title, created_at, updated_at, model_id, user_card_id, deleted_at, card_override_json, persona_override_json,
        CASE WHEN user_card_id IS NOT NULL THEN 'user_card' ELSE 'character' END FROM chats;
    DROP TABLE chats;
    ALTER TABLE chats_v10 RENAME TO chats;
    CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at);
    CREATE INDEX IF NOT EXISTS idx_chats_card ON chats(user_card_id);

    CREATE TABLE system_costs_v10 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('translate','test','voice','generate')),
      model_id INTEGER NULL,
      user_id INTEGER NULL,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_in_cached INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NULL,
      cost_source TEXT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO system_costs_v10 SELECT id, kind, model_id, user_id, tokens_in, tokens_in_cached, tokens_out, cost_usd, cost_source, created_at FROM system_costs;
    DROP TABLE system_costs;
    ALTER TABLE system_costs_v10 RENAME TO system_costs;
    CREATE INDEX IF NOT EXISTS idx_system_costs_created ON system_costs(created_at);

    CREATE TABLE IF NOT EXISTS chat_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL REFERENCES chats(id),
      files_json TEXT NOT NULL DEFAULT '[]',
      instruction TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      total_chars INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'full' CHECK (mode IN ('full','retrieval')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_files_chat ON chat_files(chat_id);
    CREATE TABLE IF NOT EXISTS chat_file_chunks (
      chat_id INTEGER NOT NULL REFERENCES chats(id),
      idx INTEGER NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (chat_id, idx)
    );

    CREATE TABLE IF NOT EXISTS voice_clips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      chat_id INTEGER NULL REFERENCES chats(id),
      message_id INTEGER NULL REFERENCES messages(id),
      file TEXT NOT NULL,
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NULL,
      raw_text TEXT NOT NULL DEFAULT '',
      formatted_text TEXT NOT NULL DEFAULT '',
      cost_usd REAL NULL,
      error TEXT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_voice_clips_user ON voice_clips(user_id, id);
    CREATE INDEX IF NOT EXISTS idx_voice_clips_chat ON voice_clips(chat_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_clips_message ON voice_clips(message_id) WHERE message_id IS NOT NULL;

    ALTER TABLE users ADD COLUMN voice_auto_send INTEGER NOT NULL DEFAULT 0;
  `);
  // AUTOINCREMENT 计数器跟着搬（被删过的旧 id 不复用）。
  for (const [name, seq] of [['chats', chatSeq], ['system_costs', costSeq]]) {
    if (seq <= 0) continue;
    const cur = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(name);
    if (!cur) db.prepare('INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)').run(name, seq);
    else if (cur.seq < seq) db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(seq, name);
  }
  const bad = db.prepare('PRAGMA foreign_key_check').all();
  if (bad.length) throw new Error(`迁移 v10 外键检查不通过：${bad.length} 处`);
}

/** 给三档单价都空着的模型行填预置单价（迁移与首次预置共用）。返回填了几行。 */
export function fillPresetPrices(db) {
  const rows = db.prepare('SELECT id, base_url, model FROM models WHERE price_in IS NULL AND price_in_cached IS NULL AND price_out IS NULL').all();
  const upd = db.prepare('UPDATE models SET currency = ?, price_in = ?, price_in_cached = ?, price_out = ? WHERE id = ?');
  let n = 0;
  for (const r of rows) {
    const p = presetPriceFor(r.base_url, r.model);
    if (!p) continue;
    upd.run(p.currency, p.price_in, p.price_in_cached ?? null, p.price_out, r.id);
    n += 1;
  }
  return n;
}

export const ROLES = ['super', 'admin', 'tenant'];

/** 启用中的 super 个数（「最后一个 super」保护用）。 */
export function countActiveSupers(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'super' AND disabled = 0 AND deleted_at IS NULL").get().n;
}

export const SETTING_DEFAULTS = {
  site_name: 'AI 角色聊天',
  default_daily_limit: '0',
  allow_user_chub_search: '1',
  default_model_id: '',
  cny_to_usd: String(DEFAULT_CNY_TO_USD),
  log_retention_days: String(DEFAULT_LOG_RETENTION_DAYS),
};

/** @param {{upTo?:number}} [opts] upTo：只迁移到这个版本（测试用，模拟旧版本线上库）。 */
export function openDb(dbFile, { upTo = MIGRATIONS.length } = {}) {
  mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const cur = db.prepare('PRAGMA user_version').get().user_version;
  // 有迁移要跑时先关外键（事务里改不了这个开关）：v6 要重建 chats 表，开着外键 DROP TABLE 会把 messages 级联删光。
  // 每个迁移步骤自己在提交前做 foreign_key_check；全部跑完再打开。
  const target = Math.min(MIGRATIONS.length, Math.max(0, upTo));
  if (cur < target) db.exec('PRAGMA foreign_keys = OFF');
  for (let v = cur; v < target; v++) {
    db.exec('BEGIN');
    try {
      const step = MIGRATIONS[v];
      if (typeof step === 'function') step(db); else db.exec(step);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
      try { db.close(); } catch { /* ignore */ }
      throw e;
    }
  }
  db.exec('PRAGMA foreign_keys = ON');
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(SETTING_DEFAULTS)) ins.run(k, v);
  // 契约 §11.2：迁移版本有变化就记一条 system.migrate（写失败不影响启动）。
  if (cur < target) {
    writeLog(db, {
      kind: 'system.migrate',
      summary: `数据库从版本 ${cur} 升级到 ${target}`,
      detail: { from: cur, to: target },
    });
  }
  return db;
}

/**
 * 自建卡防滥用参数（策略由用户定，这里只给默认值；0 = 不限）。不写进 SETTING_DEFAULTS：
 * 没改过就不落库，读不到时用这里的默认值（不影响旧库 settings 表的内容）。
 *  card_max_per_user        每个账号同时保留的卡数（不含已删）
 *  card_max_total_per_user  每个账号累计建卡数（含已删；软删的数据和头像仍占空间）
 *  card_writes_per_minute   每个账号每分钟新建 / 导入 / 拷贝 / 传头像的次数
 */
export const CARD_QUOTA_DEFAULTS = { card_max_per_user: 200, card_max_total_per_user: 1000, card_writes_per_minute: 10 };
/**
 * 防刷量的每日上限（v1.0 复核补，契约外；策略由用户定，0 = 不限、只记录——花费 / 录音本来就逐笔落库）：
 *  translate_daily_max     每个账号每天触发整卡翻译的次数
 *  voice_daily_max_clips   每个账号 24 小时内保存的录音条数
 *  voice_daily_max_mb      每个账号 24 小时内保存的录音总量（MB）
 */
// 录音两项默认非 0（v1.0 第 2 轮复核）：录音原件要落盘，不设上限一个账号就能把磁盘写到 5GB 保护线、全站上传与语音一起停摆；
// 默认值与原来的「超过就写 warn」建议量对齐（300 条 / 300MB），super 可在设置里改，改成 0 = 不限。
export const ABUSE_LIMIT_DEFAULTS = { translate_daily_max: 0, voice_daily_max_clips: 300, voice_daily_max_mb: 300 };
export const CARD_QUOTA_MAX = 1000000;
export const parseQuota = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);
  return Number.isInteger(n) && n >= 0 && n <= CARD_QUOTA_MAX ? n : null;
};

export function getSettings(db) {
  const out = { ...SETTING_DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return {
    site_name: String(out.site_name || SETTING_DEFAULTS.site_name),
    default_daily_limit: Math.max(0, parseInt(out.default_daily_limit, 10) || 0),
    allow_user_chub_search: String(out.allow_user_chub_search) === '0' ? 0 : 1,
    default_model_id: /^\d+$/.test(String(out.default_model_id ?? '')) ? Number(out.default_model_id) : null,
    cny_to_usd: (() => { const n = Number(out.cny_to_usd); return Number.isFinite(n) && n > 0 ? n : DEFAULT_CNY_TO_USD; })(),
    log_retention_days: parseRetentionDays(out.log_retention_days, { fallback: true }),
    // 契约 §19.2：翻译模型；不落默认值（没改过就没有这一行），null = 默认「DeepSeek 快速」
    translate_model_id: /^\d+$/.test(String(out.translate_model_id ?? '')) ? Number(out.translate_model_id) : null,
    translate_backend: out.translate_backend === 'cli' ? 'cli' : 'api',
    translate_cli_model: out.translate_cli_model === 'grok-4.7' ? 'grok-4.7' : 'grok-4.5',
    // 契约 §18.2：语音整理模型；同上，null = 默认「DeepSeek 快速」
    voice_format_model_id: /^\d+$/.test(String(out.voice_format_model_id ?? '')) ? Number(out.voice_format_model_id) : null,
    ...Object.fromEntries(Object.entries(CARD_QUOTA_DEFAULTS).map(([k, d]) => [k, out[k] === undefined ? d : (parseQuota(out[k]) ?? d)])),
    ...Object.fromEntries(Object.entries(ABUSE_LIMIT_DEFAULTS).map(([k, d]) => [k, out[k] === undefined ? d : (parseQuota(out[k]) ?? d)])),
  };
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

/** 事务包装（DatabaseSync 是同步的，函数内不要 await）。 */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
