// PNG 小工具（契约 §12.2 导入导出）：零依赖解析 / 重组 chunk、读写 tEXt 块（Tavern 卡的 chara / ccv3）、生成纯色占位图。
// CRC 用 node:zlib.crc32（Node 22.2+）；没有就用本文件里的查表实现，两者结果一致（测试里核对）。
import zlib from 'node:zlib';

export const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** 查表 CRC-32（与 zlib.crc32 相同的多项式）。 */
export function crc32Table(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const crc32 = typeof zlib.crc32 === 'function' ? (buf) => zlib.crc32(buf) >>> 0 : crc32Table;

export const isPng = (buf) => Buffer.isBuffer(buf) && buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG);

/**
 * 拆 chunk。返回 [{type, data}]；结构不对（截断、长度越界、CRC 错）抛 Error。
 * 只做结构校验，不解码图像。
 */
export function readChunks(buf, { checkCrc = true, maxChunks = 10000 } = {}) {
  if (!isPng(buf)) throw new Error('不是 PNG');
  const out = [];
  let p = 8;
  while (p < buf.length) {
    if (p + 12 > buf.length) throw new Error('PNG 被截断');
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('PNG 块类型不正确');
    if (len > buf.length - p - 12) throw new Error('PNG 块长度越界');
    const data = buf.subarray(p + 8, p + 8 + len);
    if (checkCrc) {
      const want = buf.readUInt32BE(p + 8 + len);
      if (crc32(buf.subarray(p + 4, p + 8 + len)) !== want) throw new Error('PNG 校验和不正确');
    }
    out.push({ type, data });
    p += 12 + len;
    if (type === 'IEND') break;
    if (out.length > maxChunks) throw new Error('PNG 块太多');
  }
  if (!out.length || out[0].type !== 'IHDR') throw new Error('PNG 缺少 IHDR');
  if (out[out.length - 1].type !== 'IEND') throw new Error('PNG 缺少 IEND');
  return out;
}

export function makeChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export function writeChunks(chunks) {
  return Buffer.concat([PNG_SIG, ...chunks.map((c) => makeChunk(c.type, c.data))]);
}

/** tEXt：keyword\0text（latin1）。返回 {keyword, text} 或 null。 */
export function parseText(data) {
  const i = data.indexOf(0);
  if (i < 1 || i > 79) return null;
  return { keyword: data.toString('latin1', 0, i), text: data.toString('latin1', i + 1) };
}

/**
 * zTXt 解压总预算（防压缩炸弹）：整张图所有解压出来的文本合计不超过 12MB（与导入文件上限同量级，
 * 未压缩的 tEXt 本来就受上传大小限制）；每个关键字最多尝试解压一次，解压失败也不再试第二块。
 */
export const TEXT_INFLATE_TOTAL_MAX = 12 * 1024 * 1024;

const textKeyword = (data) => {
  const i = data.indexOf(0);
  return i >= 1 && i <= 79 ? data.toString('latin1', 0, i) : null;
};

/**
 * 读文本块（tEXt；zTXt 解压；iTXt 只认未压缩的）。返回 Map(keyword → text)，同名取第一个。
 * keywords：只要这些关键字（导入卡片传 ['chara','ccv3']），其他块连解压都不做；不传 = 全部。
 * 所有取到的文本（解压后）累计超过 totalMax → 抛 Error（调用方转成「PNG 文件已损坏或过大」）。
 */
export function readTextChunks(buf, { keywords = null, inflateMax = TEXT_INFLATE_TOTAL_MAX } = {}) {
  const want = keywords ? new Set(keywords) : null;
  const out = new Map();
  const tried = new Set();
  let inflated = 0;
  for (const c of readChunks(buf)) {
    if (c.type !== 'tEXt' && c.type !== 'zTXt' && c.type !== 'iTXt') continue;
    const keyword = textKeyword(c.data);
    if (!keyword || (want && !want.has(keyword)) || out.has(keyword) || tried.has(keyword)) continue; // 不要的、已取到 / 已试过的：直接跳过，不解压
    const i = keyword.length;
    let text = null;
    if (c.type === 'tEXt') text = c.data.toString('latin1', i + 1);
    else if (c.type === 'zTXt') {
      if (c.data[i + 1] !== 0) continue;
      tried.add(keyword);
      const room = inflateMax - inflated;
      if (room <= 0) throw new Error('PNG 文本块过大');
      let raw;
      try { raw = zlib.inflateSync(c.data.subarray(i + 2), { maxOutputLength: room }); } catch (e) {
        if (e && e.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('PNG 文本块过大');
        continue;
      }
      inflated += raw.length;
      text = raw.toString('latin1');
    } else if (c.data[i + 1] === 0) {
      // iTXt：keyword\0 compFlag compMethod lang\0 translated\0 text(utf8)；只认未压缩（compFlag=0）
      const j = c.data.indexOf(0, i + 3);
      const k = j >= 0 ? c.data.indexOf(0, j + 1) : -1;
      if (k >= 0) text = c.data.toString('utf8', k + 1);
    }
    if (text === null) continue;
    out.set(keyword, text);
  }
  return out;
}

/** 头像保留的 PNG 块（图像与色彩、APNG 动画）；其余（tEXt/zTXt/iTXt/eXIf/tIME/私有块）一律去掉。 */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'bKGD', 'acTL', 'fcTL', 'fdAT', 'cICP']);

/** 去掉 PNG 里的元数据块（文本、EXIF、时间、私有块）。结构不对抛 Error。 */
export function stripPngMetadata(buf) {
  return writeChunks(readChunks(buf).filter((c) => PNG_KEEP.has(c.type)));
}

/**
 * 把 tEXt 块写进 PNG：先去掉同名（以及 removeKeywords 里列出的）旧文本块，新块插在 IEND 前。
 * text 必须是 latin1 可表示的（Tavern 用 base64，天然满足）。
 */
export function withTextChunk(buf, keyword, text, { removeKeywords = [] } = {}) {
  const drop = new Set([keyword, ...removeKeywords]);
  const chunks = readChunks(buf).filter((c) => {
    if (c.type !== 'tEXt' && c.type !== 'zTXt' && c.type !== 'iTXt') return true;
    const i = c.data.indexOf(0);
    const kw = i > 0 ? c.data.toString('latin1', 0, i) : '';
    return !drop.has(kw);
  });
  const data = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]);
  const iend = chunks.length - 1;
  chunks.splice(iend, 0, { type: 'tEXt', data });
  return writeChunks(chunks);
}

/** 生成纯色 RGB PNG（导出 PNG 时没有可用 PNG 头像的占位图）。 */
export function solidPng(width = 400, height = 600, [r, g, b] = [0x5b, 0x6b, 0x8c]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return writeChunks([
    { type: 'IHDR', data: ihdr },
    { type: 'IDAT', data: zlib.deflateSync(raw) },
    { type: 'IEND', data: Buffer.alloc(0) },
  ]);
}
