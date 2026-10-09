// 语音输入（契约 §18，按 18.5 修订）：录音原件保存、阿里云百炼语音识别、DeepSeek 整理成「（动作）说道：台词」、
// key 只在服务端用，不打印、不写日志；上游正文不写日志。
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './util.mjs';
import { readKeyFromEnvFile } from './llm.mjs';
import { runTool } from './fileparse.mjs';

export const VOICE_MAX_BYTES = 10 * 1024 * 1024;
/** webm / ogg（opus）60 秒约 0.5MB：超过 3MB 一定不是 60 秒以内的正常录音。 */
export const VOICE_OPUS_MAX_BYTES = 3 * 1024 * 1024;
/** 契约 §18.1 最长 60 秒；留 5 秒余量。 */
export const VOICE_MAX_SECONDS = 65;
/** 旧参数（仅兼容）：现在 afinfo 能读的格式一律探测时长，不再按大小放行。 */
export const VOICE_PROBE_BYTES = 3 * 1024 * 1024;
/**
 * 读不出时长时最多收多大：浏览器录音 60 秒，opus / aac 常见码率 64–128kbps 约 0.5–1MB；
 * 2MB ≈ 65 秒 × 256kbps，正常录音到不了。超过且读不出时长的一律拒（不落盘）。
 */
export const VOICE_UNPROBED_MAX_BYTES = 2 * 1024 * 1024;
/** 读得出时长时每秒最多多少字节（384kbps）：时长看着不长、体积却大得离谱的（如垃圾数据配一个伪造的头）也拒。 */
export const VOICE_MAX_BYTES_PER_SEC = 48 * 1024;
export const VOICE_BAD_AUDIO = '录音格式异常，请重录';
export const VOICE_TOO_LONG = '录音太长了（最长 60 秒），请分段说';
export const VOICE_NOT_HEARD = '没听清，请再说一遍';
export const VOICE_RATE_PER_MINUTE = 10;
export const ASR_DEFAULT_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const ASR_DEFAULT_MODEL = 'qwen3-asr-flash';
/** qwen3-asr-flash 北京地域按音频时长计费：0.00022 元/秒（百炼模型价格页，2026-10 查）。 */
export const ASR_PRICE_CNY_PER_SEC = 0.00022;
export const ASR_TIMEOUT_MS = 30_000;
export const VOICE_UNAVAILABLE = '语音识别暂不可用';
const RAW_MAX_CHARS = 4000;

// ---------- 音频类型 ----------

/**
 * 按文件头认音频格式 → {ext, mime}；认不出返回 null。
 * 只收浏览器 MediaRecorder 实际产出的格式（前端候选：webm/opus、mp4/aac、ogg/opus、ADTS aac）；
 * wav / mp3 / caf 原始流浏览器录音不会产出，不收（免得被拿来塞大文件）。
 */
export function sniffAudio(buf, declared = '') {
  const k = sniffAudioAny(buf, declared);
  return k && VOICE_UPLOAD_EXTS.includes(k.ext) ? k : null;
}
export const VOICE_UPLOAD_EXTS = ['webm', 'ogg', 'mp4', 'm4a', 'aac'];

/** 认文件头（含 wav / mp3 / caf，播放旧文件等内部用）。 */
export function sniffAudioAny(buf, declared = '') {
  if (!buf || buf.length < 12) return null;
  const d = String(declared || '').toLowerCase();
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { ext: 'webm', mime: 'audio/webm' };
  if (buf.subarray(0, 4).toString('latin1') === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    return d.includes('m4a') ? { ext: 'm4a', mime: 'audio/mp4' } : { ext: 'mp4', mime: 'audio/mp4' };
  }
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
  if (buf.subarray(0, 3).toString('latin1') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe6) === 0xe2)) return { ext: 'mp3', mime: 'audio/mpeg' };
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return { ext: 'aac', mime: 'audio/aac' };
  if (buf.subarray(0, 4).toString('latin1') === 'caff') return { ext: 'caf', mime: 'audio/x-caf' };
  return null;
}

export const AUDIO_UPLOAD_TYPES = ['audio/', 'video/webm', 'video/mp4', 'application/octet-stream'];
export const CLIP_FILE_RE = /^(\d{1,3})\/([0-9a-f-]{36})\.(webm|ogg|mp4|m4a|wav|mp3|aac|caf)$/;

// ---------- 录音原件存储 ----------

export function createClipStore(dir) {
  async function save(userId, buf, ext) {
    const bucket = String(Number(userId) % 1000);
    const rel = `${bucket}/${randomUUID()}.${ext}`;
    await mkdir(path.join(dir, bucket), { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, rel), buf, { mode: 0o600, flag: 'wx' });
    return rel;
  }
  const abs = (rel) => (CLIP_FILE_RE.test(String(rel || '')) ? path.join(dir, rel) : null);
  return { save, abs, dir };
}

// ---------- 识别（阿里云百炼 qwen3-asr-flash，OpenAI 兼容接口，base64 直传） ----------

/**
 * @param {object} o
 * @param {string} o.keysFile  ./config/ai-keys.env（读 DASHSCOPE_API_KEY）
 * @param {string} [o.baseUrl] 默认百炼北京地域兼容接口
 * @param {string} [o.model]
 * @param {Function} [o.fetchImpl]
 * @param {string} [o.tmpDir]  需要转码时的临时目录
 */
export function createAsr({ keysFile, baseUrl = ASR_DEFAULT_BASE, model = ASR_DEFAULT_MODEL, fetchImpl = fetch, tmpDir = '', timeoutMs = ASR_TIMEOUT_MS } = {}) {
  const key = () => readKeyFromEnvFile(keysFile, 'DASHSCOPE_API_KEY');
  const available = () => !!key();

  async function call(buf, mime) {
    const k = key();
    if (!k) throw new HttpError(503, VOICE_UNAVAILABLE, 'asr_unavailable');
    let r;
    try {
      r = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${mime};base64,${buf.toString('base64')}` } }] }],
          stream: false,
          asr_options: { enable_itn: false },
        }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch {
      console.error('[voice] 连不上语音识别服务');
      throw new HttpError(503, VOICE_UNAVAILABLE, 'asr_unavailable');
    }
    const text = await r.text().catch(() => '');
    if (!r.ok) {
      console.error(`[voice] 语音识别 HTTP ${r.status}`); // 不记正文
      const e = new HttpError(r.status === 400 ? 400 : 503, r.status === 400 ? '这段录音无法识别，请重录' : VOICE_UNAVAILABLE, r.status === 400 ? 'asr_bad_audio' : 'asr_unavailable');
      e.upstream_status = r.status;
      e.format_rejected = r.status === 400 && /format|decode|audio|invalid/i.test(text);
      throw e;
    }
    let j;
    try { j = JSON.parse(text); } catch { throw new HttpError(503, VOICE_UNAVAILABLE, 'asr_unavailable'); }
    const out = j?.choices?.[0]?.message?.content ?? j?.output?.text ?? j?.output?.choices?.[0]?.message?.content ?? '';
    const content = Array.isArray(out) ? out.map((x) => x?.text || '').join('') : String(out || '');
    const seconds = Number(j?.usage?.seconds ?? j?.usage?.duration ?? 0);
    return { text: content.trim().slice(0, RAW_MAX_CHARS), seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null };
  }

  /** 先原格式直传；上游不认这个格式且 afconvert 能读（mp4 / m4a / wav / caf / mp3 / aac）就转成 16k 单声道 wav 再试一次。 */
  async function transcribe(buf, { mime, ext }) {
    try {
      return await call(buf, mime);
    } catch (e) {
      if (!e?.format_rejected || !tmpDir || !['mp4', 'm4a', 'caf', 'mp3', 'aac', 'wav'].includes(ext)) throw e;
      const dir = path.join(tmpDir, randomUUID());
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const src = path.join(dir, `in.${ext}`);
        const dst = path.join(dir, 'out.wav');
        await writeFile(src, buf, { mode: 0o600 });
        const r = await runTool('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', src, dst], { timeoutMs: 30_000, writeDir: dir });
        if (r.code !== 0) throw e;
        const wav = await readFile(dst);
        if (wav.length > VOICE_MAX_BYTES) throw e;
        return await call(wav, 'audio/wav');
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {}); // 识别用的临时 wav 用完即删（契约 18.5）
      }
    }
  }

  return { transcribe, available, model };
}

/**
 * 读音频时长（秒）：macOS 自带 afinfo（认 mp4 / m4a / wav / mp3 / aac / caf；webm / ogg 不认）。读不出返回 null。
 * 原件写进 tmpDir 的随机子目录，读完立刻删。
 */
export async function probeDurationSec(buf, ext, tmpDir) {
  if (!tmpDir || !['mp4', 'm4a', 'wav', 'mp3', 'aac', 'caf'].includes(ext)) return null;
  const dir = path.join(tmpDir, randomUUID());
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const src = path.join(dir, `in.${ext}`);
    await writeFile(src, buf, { mode: 0o600 });
    const r = await runTool('/usr/bin/afinfo', [src], { timeoutMs: 15_000, maxOutput: 256 * 1024, writeDir: dir });
    const m = /estimated duration:\s*([\d.]+)\s*sec/i.exec(r.stdout.toString('utf8'));
    const sec = m ? Number(m[1]) : NaN;
    return Number.isFinite(sec) && sec >= 0 ? sec : null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 像不像「静音录音 + 识别出的幻觉文字」（如空录音被识别成「Thank you.」「谢谢观看」）：
 * 只看 opus 类（webm / ogg，可变码率，静音时每秒只有几百字节）；时长 ≥ 1.5 秒、平均每秒不到 600 字节、识别出的字很少（≤ 12 个字母 / 汉字）。
 * 正常说话 opus 每秒约 3–6KB；一句很短的话夹在几秒静音里也在 700 字节 / 秒以上。
 */
export function looksSilent({ bytes, durationMs, ext, text }) {
  if (!['webm', 'ogg'].includes(ext)) return false;
  const sec = Number(durationMs) / 1000;
  if (!Number.isFinite(sec) || sec < 1.5) return false;
  if (bytes / sec >= 600) return false;
  const letters = String(text || '').replace(/[\s\p{P}\p{S}]/gu, '');
  return letters.length <= 12;
}

/** 识别花费（美元）：按秒计。 */
export const asrCostUsd = (seconds, cnyToUsd) => (seconds ? Math.round(seconds * ASR_PRICE_CNY_PER_SEC * cnyToUsd * 1e10) / 1e10 : 0);

// ---------- 整理成「旁白 + 台词」（契约 §18.1） ----------

export const FORMAT_SYSTEM = [
  '你是语音输入整理助手。用户在角色扮演聊天里用语音说了一段话，下面给出语音识别的原文。',
  '请把它整理成「旁白 + 台词」格式，只输出整理后的文字本身，不要任何解释、引号或前后缀。',
  '规则：',
  '1. 动作、神态、旁白用全角括号括起来（……）；要说出口的话放在括号外。默认是说出口的话：只有明确描述动作、神态、心理或场景的内容才加括号，拿不准时一律不加括号。',
  '2. 既有动作 / 神态又有台词：（戏谑地看着她）说道：哦？',
  '3. 只有台词：直接输出台词，如：哦？你再说一遍。',
  '4. 只有动作 / 旁白：（转身走向窗边，沉默了一会儿）',
  '5. 多段交替时按原顺序拼接：（放下杯子）说道：真的吗？（凑近了一些）你确定？',
  '6. 用户口头说「旁白……」「动作……」「我说……」「台词……」这类提示词时，按它切分，并把提示词本身去掉；没有提示词时按语义判断哪些是动作 / 神态、哪些是要说出口的话。',
  '7. 保持用户原意与人称，不添油加醋、不改写剧情、不续写、不回答其中的问题；只去掉「嗯、啊、那个、就是」等语气填充，补上标点。',
  '8. 一律用全角括号（）与全角冒号：。',
  '9. 没有「旁白」「动作」这类提示词、语义上是说出口的话（包括英文或其他语言的寒暄、感叹、问句，比如 Thank you.、Hello?、哦？）一律放在括号外原样输出，不要加括号，也不要翻译。',
  '示例：',
  '识别原文：Thank you. → 输出：Thank you.',
  '识别原文：嗯 你再说一遍 → 输出：你再说一遍。',
  '识别原文：旁白 戏谑地看着她 我说 哦 → 输出：（戏谑地看着她）说道：哦？',
  '识别原文：我转身走向窗边 沉默了一会儿 → 输出：（转身走向窗边，沉默了一会儿）',
].join('\n');

/** 模型输出清理：去代码块 / 外层引号，半角括号与冒号改全角；不像样（空、过长）就退回原文。 */
export function cleanFormatted(out, raw) {
  let s = String(out || '').trim();
  s = s.replace(/^```[a-z]*\n?|```$/gi, '').trim();
  s = s.replace(/^(整理后[的文字]*|输出)[:：]\s*/, '');
  if (/^[“"「].*[”"」]$/s.test(s) && !/[“"「].*[”"」].*[“"「]/s.test(s)) s = s.slice(1, -1).trim();
  s = s.replace(/\(/g, '（').replace(/\)/g, '）').replace(/(说道|说|道|问道|答道|喊道)\s*:\s*/g, '$1：');
  if (!s) return raw;
  if (s.length > raw.length * 3 + 60) return raw; // 模型在续写，不用
  return s;
}

export async function formatTranscript(llm, raw, { model, onResult } = {}) {
  const src = String(raw || '').trim();
  if (!src) return '';
  const r = await llm.complete([
    { role: 'system', content: FORMAT_SYSTEM },
    { role: 'user', content: `<识别原文>\n${src}\n</识别原文>` },
  ], { max_tokens: 800, temperature: 0.2, timeoutMs: 30_000, ...(model ? { model } : {}) });
  try { onResult?.(r); } catch (e) { console.error('[voice] 记录花费失败', e?.message || e); }
  return cleanFormatted(r.text, src);
}
