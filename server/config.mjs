// 配置全走环境变量（契约 §2）。
import os from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 应用版本（system.start 日志用）。 */
export const APP_VERSION = '1.1.0';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// 镜像图片读取方式：api = 44970 目录授权 API（失败当次退回 SMB）；smb = SMB 挂载；fast = codex 实验读取器。
// 缺省：生产且密钥文件存在 → api，否则 smb（测试/开发不碰真实 44970）。
function nasReaderMode(env, keyFile) {
  const production = env.NODE_ENV === 'production';
  const explicit = env.MIRROR_NAS_READER;
  if (explicit === 'fast') return production && process.platform !== 'win32' ? 'fast' : 'smb';
  if (explicit === 'api' || explicit === 'smb') return explicit;
  if (production && process.platform !== 'win32' && env.MIRROR_NAS_FAST_READ === '1') return 'fast';
  return production && existsSync(keyFile) ? 'api' : 'smb';
}

const percentOr = (v, d) => { const n = Number(v); return v === undefined || v === '' || !Number.isFinite(n) ? d : Math.min(100, Math.max(0, n)); };

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(ROOT, expandHome(env.DATA_DIR || './data'));
  const previewBytes = Number(env.MIRROR_PREVIEW_CACHE_BYTES || 1024 * 1024 * 1024);
  const nasApiKeyFile = expandHome(env.NAS_API_KEY_FILE || './config/nas-api.env');
  const nasReader = nasReaderMode(env, nasApiKeyFile);
  const nasApiTimeout = Number(env.NAS_API_TIMEOUT_MS);
  return {
    port: Number(env.PORT || 44982),
    dataDir,
    dbFile: path.join(dataDir, 'aichat.sqlite'),
    avatarDir: path.join(dataDir, 'avatars'),
    cardAvatarDir: path.join(dataDir, 'card-avatars'),
    // 图片索引在SSD，已完成图片在NAS；两处目录独立，镜像连接只读。
    mirrorDbFile: path.resolve(ROOT, expandHome(env.MIRROR_DB_FILE || './data/mirror/mirror.sqlite')),
    mirrorImageDir: path.resolve(ROOT, expandHome(env.MIRROR_IMAGE_DIR || './data/mirror-images')),
    mirrorThumbnailDir: path.join(dataDir, 'mirror-thumbnails'),
    mirrorPreviewCacheBytes: Number.isFinite(previewBytes)
      ? Math.min(4 * 1024 ** 3, Math.max(128 * 1024 ** 2, Math.floor(previewBytes))) : 1024 ** 3,
    // 生产后台只预热有限热门预览；测试/本地开发默认不触发NAS读取。
    mirrorPreviewWarmup: env.NODE_ENV === 'production' && env.MIRROR_PREVIEW_WARMUP !== '0',
    mirrorNasReader: nasReader,
    // codex 实验读取器：只在 MIRROR_NAS_READER=fast（或旧开关 MIRROR_NAS_FAST_READ=1）时启用。
    mirrorNasFastRead: nasReader === 'fast',
    // 44970 API：密钥只从文件读进服务端内存。
    nasApiBase: (env.NAS_API_BASE || 'http://127.0.0.1:44970/openapi/v1').replace(/\/+$/, ''),
    nasApiKeyFile,
    nasApiRemoteRoot: (env.NAS_API_REMOTE_ROOT || 'example/mirror').replace(/\/+$/, ''),
    nasApiTimeoutMs: Number.isSafeInteger(nasApiTimeout) && nasApiTimeout >= 1000 ? Math.min(nasApiTimeout, 12000) : 6000,
    publicDir: path.resolve(ROOT, expandHome(env.PUBLIC_DIR || './public')),
    aiKeysFile: expandHome(env.AI_KEYS_FILE || './config/ai-keys.env'),
    deepseekModel: env.DEEPSEEK_MODEL || 'deepseek-flash',
    deepseekBase: (env.DEEPSEEK_BASE || 'https://api.deepseek.com').replace(/\/+$/, ''),
    // 本机订阅 CLI 仅供翻译；账户凭据由 CLI 自己管理。
    grokCliExecutable: expandHome(env.GROK_CLI_PATH || '~/.local/node/bin/grok'),
    // launchd不会继承终端代理；CLI显式使用本机已配置出口。
    grokCliProxyUrl: env.GROK_CLI_PROXY_URL || 'http://127.0.0.1:42001',
    grokCliHomeDir: os.homedir(),
    // CLI 翻译的额度门槛（剩余额度百分比，0–100）：0 = 不限制，恢复门槛设 GROK_CLI_MIN_REMAINING_PERCENT=55。
    grokCliMinRemainingPercent: percentOr(env.GROK_CLI_MIN_REMAINING_PERCENT, 0),
    grokCliQuotaProbeModule: expandHome(env.GROK_CLI_QUOTA_PROBE_MODULE || './integrations/ai-usage-probes.js'),
    grokCliTempDir: path.join(dataDir, 'tmp-grok-translate'),
    chubApiKey: env.CHUB_API_KEY || '',
    adminBootstrapPassword: env.ADMIN_BOOTSTRAP_PASSWORD || '',
    publicBaseUrl: (env.PUBLIC_BASE_URL || 'http://localhost:44982').replace(/\/+$/, ''), // 邀请链接前缀（契约 §13.2）
    // 抓取监控（契约 §15）：只认本机回环地址；token 每次请求时从文件读，不缓存、不打印。
    crawlerControlUrl: env.CRAWLER_CONTROL_URL || 'http://127.0.0.1:17990',
    crawlerTokenFile: expandHome(env.CRAWLER_CONTROL_TOKEN_FILE || './config/crawler-control.token'),
    sslDir: expandHome(env.SSL_DIR || './config/ssl'),
    // 契约 §17：上传解析的临时目录（解析完立即删）、upload_id 暂存（1 小时）、Swift 小工具编译产物
    tmpUploadDir: path.join(dataDir, 'tmp-parse'),
    uploadDir: path.join(dataDir, 'uploads'),
    binDir: path.join(dataDir, 'bin'),
    // 契约 §18.5：录音原件
    voiceDir: path.join(dataDir, 'voice'),
    asrBase: (env.DASHSCOPE_ASR_BASE || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
    asrModel: env.DASHSCOPE_ASR_MODEL || 'qwen3-asr-flash',
  };
}
