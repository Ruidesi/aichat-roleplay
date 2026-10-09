// AI 角色聊天 · 后端入口（契约见 CONTRACT.md）。
import { loadConfig, APP_VERSION } from './server/config.mjs';
import { openDb, countActiveSupers } from './server/db.mjs';
import { hashPassword, purgeExpiredSessions } from './server/auth.mjs';
import { createChub, createAvatarCache } from './server/chub.mjs';
import { createLlm } from './server/llm.mjs';
import { createApp } from './server/app.mjs';
import { createModelService, seedModels } from './server/models.mjs';
import { createCostService } from './server/costs.mjs';
import path from 'node:path';
import { startServer } from './server/net.mjs';
import { nowIso } from './server/util.mjs';
import { writeLog, purgeOldLogs } from './server/logs.mjs';
import { ensureSwiftTool } from './server/fileparse.mjs';

const config = loadConfig();
const db = openDb(config.dbFile);

// 首次启动：库里没有启用的超级管理员且给了 ADMIN_BOOTSTRAP_PASSWORD → 建（或恢复）超级管理员 admin（契约 §9）。
if (!countActiveSupers(db) && config.adminBootstrapPassword) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (existing) {
    db.prepare("UPDATE users SET role = 'super', is_admin = 1, disabled = 0, deleted_at = NULL, password_hash = ? WHERE id = ?").run(hashPassword(config.adminBootstrapPassword), existing.id);
    writeLog(db, { level: 'warn', kind: 'user.update', actor_name: '系统', target_type: 'user', target_id: existing.id,
      summary: '启动时恢复超级管理员 admin（ADMIN_BOOTSTRAP_PASSWORD）',
      detail: { username: 'admin', changes: [{ field: 'role', label: '角色', from: null, to: '超级管理员' }, { field: 'password', label: '密码', from: null, to: '已重置' }] } });
  } else {
    const r = db.prepare("INSERT INTO users(username, password_hash, display_name, is_admin, role, created_at) VALUES (?, ?, ?, 1, 'super', ?)")
      .run('admin', hashPassword(config.adminBootstrapPassword), '超级管理员', nowIso());
    writeLog(db, { kind: 'user.create', actor_name: '系统', target_type: 'user', target_id: Number(r.lastInsertRowid),
      summary: '启动时创建超级管理员 admin（ADMIN_BOOTSTRAP_PASSWORD）', detail: { username: 'admin', role: 'super', role_name: '超级管理员' } });
  }
  console.log('[boot] 已创建超级管理员账号 admin');
}

const models = createModelService({ db, keysFile: config.aiKeysFile, secretFile: path.join(config.dataDir, 'secret.key') });
const seeded = seedModels(db, { keysFile: config.aiKeysFile, deepseekBase: config.deepseekBase, deepseekModel: config.deepseekModel });
if (seeded.length) console.log(`[boot] 已预置模型 ${seeded.length} 个：${seeded.map((m) => `${m.name}${m.enabled ? '' : '（停用）'}`).join('、')}`);

const chub = createChub({ apiKey: config.chubApiKey });
const llm = createLlm({ models });
const avatars = createAvatarCache({ dir: config.avatarDir });
const app = createApp({ db, chub, llm, avatars, config, models });

// 刚预置完：逐个真调一次确认能通（契约 §8.1）。默认启用的若因 key / 模型 ID 不对（401/403/404）不通就改成停用；
// 网络抖动、超时等不改状态。结果只写日志（不含 key、不含上游正文）。MODEL_SEED_PROBE=0 可关。
if (seeded.length && process.env.MODEL_SEED_PROBE !== '0') {
  (async () => {
    for (const s of seeded) {
      const m = models.byId(s.id);
      if (!m) continue;
      const t0 = Date.now();
      try {
        const r = await llm.streamChat([{ role: 'user', content: '用一句话打个招呼' }], { model: m, max_tokens: 32, temperature: 0.7 });
        try { createCostService({ db }).recordSystem('test', m, null, r); } catch { /* 记账失败不影响 */ }
        console.log(`[models] 预置检查 ${m.name}（${m.model}）通，${Date.now() - t0}ms，${r.text.trim() ? '有回复' : '空回复'}`);
      } catch (e) {
        const hard = e?.code === 'upstream' && [401, 403, 404].includes(e?.upstream_status);
        console.log(`[models] 预置检查 ${m.name}（${m.model}）不通：${e?.message || e}（${e?.code || 'error'}）${m.enabled && hard ? '，已停用' : ''}`);
        if (m.enabled && hard) {
          db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(m.id);
          writeLog(db, { level: 'warn', kind: 'model.disable', actor_name: '系统', target_type: 'model', target_id: m.id,
            summary: `预置检查不通，已停用模型「${m.name}」（HTTP ${e.upstream_status}）`,
            detail: { name: m.name, model: m.model, reason: '预置检查不通', http_status: e.upstream_status } });
        }
      }
    }
  })().catch(() => {});
}

purgeExpiredSessions(db);
setInterval(() => { try { purgeExpiredSessions(db); } catch { /* ignore */ } }, 6 * 3600 * 1000).unref();

// 契约 §11.1：超期日志启动时清一次，之后每天一次（保留天数在设置里，默认 90）。
purgeOldLogs(db);
setInterval(() => purgeOldLogs(db), 24 * 3600 * 1000).unref();

// 契约 §16.1 / §17：PDF 抽字与图片 OCR 的 Swift 小工具，启动后在后台编译到 DATA_DIR/bin（已是最新就跳过；失败了首次使用时再试）。
if (process.env.SWIFT_WARMUP !== '0') {
  setTimeout(() => { ensureSwiftTool('pdftext', config.binDir).then(() => ensureSwiftTool('ocr', config.binDir)).catch(() => {}); }, 2000).unref();
}

const server = startServer({ handle: app.handle, port: config.port, sslDir: config.sslDir });
writeLog(db, { kind: 'system.start', summary: `服务启动：版本 ${APP_VERSION}，端口 ${config.port}`, detail: { version: APP_VERSION, port: config.port, node: process.version, pid: process.pid } });

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  // 先取消并回收本机 CLI 子进程，避免服务重启遗留翻译进程。
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  try { await app.close(); } catch { /* 关闭失败仍继续退出 */ }
  clearTimeout(deadline);
  try { db.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
