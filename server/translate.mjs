// 角色卡完整翻译（契约 §19.2）：
//   解析源 JSON → 抽文本叶子按路径编号 → 分批翻译（按 id 返回 JSON 并校验齐全）→ 回填到同构 JSON（card_json_zh）；
//   宏 {{char}}/{{user}}/<BOT>/<USER>、*星号*、markdown、换行逐叶校验数量一致，不一致的叶子保留原文。
// 契约 §19.3：两步——先建译名表（角色名 + 世界书全部触发词 + 正文里反复出现的专有名词 → {原词: 中文}，存 characters.glossary_json），
// 再翻正文（每批 system 附上本批用得到的译名表，专有名词一律按表翻译）。世界书触发词不送去翻译，直接写成「原词 ∪ 译名表里的中文名」。
// 已经是中文的叶子跳过。
// 列表（首页热门 / 搜索 / 货架）只翻 name / tagline（每批 ≤24 项），标签走全站共享的 tag_translations。
// 本模块前半部分是纯函数（便于单元测试），后半部分是带库与模型调用的服务。
import crypto from 'node:crypto';
import { HttpError, nowIso } from './util.mjs';
import { getSettings } from './db.mjs';
import { looksChinese } from './llm.mjs';
import { isDeepseekUrl } from './pricing.mjs';
import { createTranslationHistory, translationModelFingerprint } from './translation-history.mjs';

// ---------- 参数 ----------
export const SEG_MAX_CHARS = 3000;     // 单个翻译单元最长（长叶子按换行切段）
export const BATCH_MAX_CHARS = 6000;   // 一批原文总字数上限
export const BATCH_MAX_UNITS = 40;     // 一批最多几个单元
export const SHORT_BATCH_MAX_UNITS = 60;
export const LIST_BATCH_MAX = 24;      // 列表批量翻译每批 ≤24 项（契约 §19.2）
export const LIST_QUEUE_MAX = 480;     // 后台列表翻译排队上限（防翻页刷量；排不上的下次打开再排）
export const TRANSLATE_CONCURRENCY = 3;
export const TRANSLATE_MAX_TOKENS = 8000;
export const TRANSLATE_TIMEOUT_MS = 150000; // 长文本批（max_tokens 8000）单次超时
export const SHORT_TIMEOUT_MS = 45000;      // 短文本批（译名表 / 列表 / 标签，max_tokens 2000）单次超时
export const CARD_DEADLINE_MS = 105000;     // 整卡翻译总时限（契约 §19.2 前端 ≤2 分钟，留出轮询余量）；到点停下，有结果落 partial
export const TASK_UPSTREAM_MAX = 3;         // 同一任务连续几次「上游不可用」就整个任务熔断（不再试后面的批）
export const MODEL_TRIP_AFTER = 3;          // 同一模型连续几次「上游不可用」就熔断该模型
export const MODEL_TRIP_MS = 5 * 60 * 1000; // 模型熔断时长：期间翻译 / 整理改用下一个启用的 DeepSeek 模型，没有就跳过
export const GLOSSARY_MAX_TERMS = 200;  // 旧参数（仅兼容）：现在角色名、专有名词、触发词分开计上限，见下面三项
export const GLOSSARY_PROPER_MAX = 40;  // 从正文里扫出来的专有名词最多几个（独立名额，排在触发词前面）
export const GLOSSARY_KEYS_MAX = 1000;  // 世界书触发词最多几个（去重后；超出的计入缺失，状态为 partial 并写日志）
export const GLOSSARY_PROPER_MIN_COUNT = 3; // 正文里句中大写出现至少几次才算专有名词
export const KEY_ZH_MIN_CHARS = 2;      // 追加到触发词的中文至少几个字（单字如「门」「钱」在中文会话里到处命中）
export const PIECE_MAX_CHARS = 400;     // 重试轮把校验不过的长单元按段落拆成小片，相邻单行合并时每片最长几个字
export const CARD_CONCURRENCY = 3;      // 整卡翻译全站同时最多几张（技术性花费保护，其余排队）
export const CARD_QUEUE_MAX = LIST_QUEUE_MAX; // 整卡翻译排队上限（沿用列表翻译的排队上限；排满了本次不翻，下次打开再排）

/** chub definition 里要翻译的长文本字段（顶层）。name 单独处理（作为短文本）。 */
export const DEF_TEXT_FIELDS = ['description', 'personality', 'tavern_personality', 'scenario', 'first_message', 'example_dialogs', 'system_prompt', 'post_history_instructions'];
const LORE_FIELDS = ['embedded_lorebook', 'character_book'];
const KEY_FIELDS = ['keys', 'key', 'secondary_keys', 'keysecondary'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 不需要翻译：空白、已是中文、只有占位符 / 标点 / 数字。 */
export function needsTranslation(s) {
  const t = String(s ?? '');
  if (!t.trim()) return false;
  const letters = t.replace(/\{\{[^{}]*\}\}|<\s*\/?\s*[A-Za-z][^>]*>|[\s\p{P}\p{S}\d]/gu, '');
  if (!letters) return false;
  return !looksChinese(t);
}

/**
 * 抽叶子：返回 [{path, text, kind:'text'|'name'}]。path 为键 / 下标数组（相对 definition）。
 * 只抽白名单字段：顶层长文本、name、alternate_greetings[*]、世界书 entries 的 content / name / comment。
 * 世界书触发词不在这里（契约 §19.3：不送去翻译，走译名表，见 collectGlossaryTerms / loreKeyPaths）。
 */
export function collectLeaves(def) {
  const out = [];
  if (!isObj(def)) return out;
  const push = (path, v, kind) => { if (typeof v === 'string' && needsTranslation(v)) out.push({ path, text: v, kind }); };
  push(['name'], def.name, 'name');
  for (const k of DEF_TEXT_FIELDS) push([k], def[k], 'text');
  if (Array.isArray(def.alternate_greetings)) def.alternate_greetings.forEach((g, i) => push(['alternate_greetings', i], g, 'text'));
  for (const lf of LORE_FIELDS) {
    const lb = def[lf];
    if (!isObj(lb)) continue;
    const ents = lb.entries;
    const pairs = Array.isArray(ents) ? ents.map((e, i) => [i, e]) : isObj(ents) ? Object.entries(ents) : [];
    for (const [ei, e] of pairs) {
      if (!isObj(e)) continue;
      const base = [lf, 'entries', ei];
      push([...base, 'content'], e.content, 'text');
      push([...base, 'comment'], e.comment, 'name');
      push([...base, 'name'], e.name, 'name');
    }
  }
  return out;
}

/** 中文版里还留着原文整行（拆片重试时保留原文的段落）的正文叶子数。 */
export function residualLeaves(def, zh) {
  if (!isObj(def) || !isObj(zh)) return 0;
  let n = 0;
  for (const leaf of collectLeaves(def)) {
    if (leaf.kind !== 'text') continue;
    const z = getAt(zh, leaf.path);
    if (typeof z === 'string' && z !== leaf.text && hasResidualSource(leaf.text, z)) n += 1;
  }
  return n;
}

/** 世界书条目 [{path(条目), entry}]（entries 为数组或对象都认）。 */
function loreEntries(def) {
  const out = [];
  if (!isObj(def)) return out;
  for (const lf of LORE_FIELDS) {
    const lb = def[lf];
    if (!isObj(lb)) continue;
    const ents = lb.entries;
    const pairs = Array.isArray(ents) ? ents.map((e, i) => [i, e]) : isObj(ents) ? Object.entries(ents) : [];
    for (const [ei, e] of pairs) if (isObj(e)) out.push({ path: [lf, 'entries', ei], entry: e });
  }
  return out;
}

// 常见英语词（小写）：正文专有名词扫描里排除，免得 Your / Master / Queen / Dark 这类普通词进译名表（契约 §19.3 补丁）
const COMMON_WORDS = new Set(`about above across act action actually after again against age ago agree ah ahead air all allow almost alone along already also although always am among angel angry animal another answer any anyone anything anyway appear apple are area arm army around arrive art as ask asleep at attack attention aunt away awful baby back bad bag ball bank bar base bath battle bay beach bear beast beautiful beauty because become bed bedroom been beer before begin behind being believe bell below beneath beside best better between beyond big bird birthday bit bitch black blade blood blue board boat body bone book boss both bottom boy brain bread break breath bride bright bring brother brown build building burn business busy but buy by cake call calm came camp can cannot captain car card care careful carry case castle cat catch cause center chain chair chance change chapter character chest chief child children choice choose church city class clean clear close clothes cloud club coat cold college color come comfort command commander common company completely could council count country couple course court cousin cover crazy create creature crew cross crown cry cup cut dad daddy damn dance danger dark darkness darling date daughter day dead deal dear death decide deep demon desk detective devil did die different dinner dirty do doctor does dog doing dollar don done door down dragon draw dream dress drink drive drop dry duke during duty each ear early earth east easy eat edge either elf else emperor empire empress end enemy enough enter even evening event ever every everyone everything evil exactly except expect eye face fact fail fairy fall family far farm fast father fear feel feeling few field fight figure fill final finally find fine finger fire first fish fit five floor flower fly follow food fool foot for force forest forever forget forgive form forward four free friend from front full fun funny game garden gate gave general get ghost gift girl give glad glass go god goddess going gold golden gone good got grace grand great green grey ground group grow guard guess guest guild gun guy hair half hall hand handsome happen happy hard has hate have he head hear heart heaven hell hello help her here hero hey hi hidden high highness him himself his history hit hold hole home honey honor hope horse hospital hot hotel hour house how however huge human hundred hungry hurt husband ice idea if important in inside instead into is island it its itself job join just keep kid kill kind king kingdom kiss kitchen knight know knowledge lady lake land language large last late later laugh law lay lead learn least leave left leg less let letter level library lie life light like line lips listen little live long look lord lose lost lot love lovely low luck lucky ma'am mad madam made magic maid main majesty make man manager many map mark market marry master matter may maybe me mean meet member memory men middle might mind minute miss mission mistress mom mommy moment money monster month moon more morning most mother mountain mouth move movie much mum must my myself name nation nature near need neither never new next nice night nine no noble none nor normal north not note nothing notice now number nurse ocean of off offer office officer often oh okay old on once one only open or order other our out outside over own pack page pain palace paper parent park part party pass past path pay peace people perfect perhaps person personality phone pick picture piece place plan planet play player please point police poor power prince princess prison private probably problem professor promise protect pull punish pure push put queen question quick quiet quite race rain raise rather reach read ready real really reason red remember rest return rich ride right ring rise river road rock role room rose round royal rule run sad safe said same save say school sea second secret see seem sense servant serve set seven several shadow shall she ship shirt shit shop short should shoulder show side sight sign silence silver since sing sir sister sit six skin sky sleep slow small smile so soft soldier some someone something sometimes son song soon sorry soul sound south space speak special spell spirit stand star start state station stay step still stone stop store story strange street strong student study stuff such summer sun sure surprise sweet sword system table take talk tall teacher team tear tell temple ten than thank thanks that the their them then there these they thing think third this those though thought thousand three through throne time to today together told tomorrow tonight too top touch tower town train tree trouble true trust truth try turn two uncle under understand until up upon us use very village voice wait wake walk wall want war warm warrior was watch water way we weapon wear week well went were west what when where whether which while white who whole why wife wild will win wind window wine wing winter wish witch with within without woman women wonder wood word work world worry would write wrong yeah year yes yet you young your yours yourself
academy adventure adventurer agency alliance apprentice archer assassin bandit bard beta alpha omega boyfriend girlfriend butler cafe chancellor cleric clan colonel commander companion corporal corporation council crusade cult dean department detective director dungeon dwarf elder empire federation fortress guardian headmaster healer hunter inn journey knight legend legion mage maiden marshal mayor mercenary minister monk necromancer ninja oracle order orc paladin pirate priest priestess quest ranger realm rebel republic rogue saga samurai scholar sergeant sheriff shogun sorcerer sorceress squire student summoner tale tavern teacher tribe university vampire werewolf wizard universe galaxy online episode season volume legendary unlimited ultimate eternal ancient sacred holy`.split(/\s+/));
const STOP_CAPS = new Set(['i', "i'm", "i'll", "i've", "i'd", 'ok', 'okay', 'char', 'user', 'bot', 'the', 'a', 'an', 'and', 'but', 'or', 'oh', 'yes', 'no', 'mr', 'mrs', 'ms', 'dr', 'sir', 'miss', 'lady', 'lord', 'god', 'english', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const isKeyTerm = (s) => !!s && s.length <= 60 && !/\n/.test(s) && !/\{\{|<\s*(?:bot|user|char)\s*>/i.test(s) && !/^\/.*\/[a-z]*$/.test(s); // 跳过宏与正则式触发词

/**
 * 译名表要收的词（契约 §19.3）：角色名（只作整体词条，不按空格拆）、世界书全部 keys / secondary_keys，
 * 以及正文里的专有名词（见 scanProperNouns，最多 40 个）。返回原词数组（去重，不区分大小写）。
 */
export function collectGlossaryTerms(def, { name = '' } = {}) {
  return collectGlossary(def, { name }).terms;
}

/**
 * 同 collectGlossaryTerms，另返回 overflow（触发词超过 GLOSSARY_KEYS_MAX、没收进译名表的个数）。
 * 顺序与名额：角色名（不限）→ 正文专有名词（独立名额 GLOSSARY_PROPER_MAX）→ 世界书触发词（GLOSSARY_KEYS_MAX）。
 * @returns {{terms: string[], overflow: number}}
 */
export function collectGlossary(def, { name = '' } = {}) {
  const terms = [];
  const seen = new Set();
  const add = (t, cap = Infinity) => {
    const x = String(t ?? '').trim();
    if (!isKeyTerm(x) || !needsTranslation(x)) return 0;
    const k = x.toLowerCase();
    if (seen.has(k)) return 0;
    if (terms.length >= cap) return 1; // 超上限（只对触发词计数）
    seen.add(k);
    terms.push(x);
    return 0;
  };
  // 角色名只作整体词条（标题式长名字如「Yes My Liege」整体收，不拆成 Yes / My / Liege）
  const names = [name, isObj(def) ? def.name : ''].filter((x) => typeof x === 'string' && x.trim());
  for (const n of names) add(n);
  if (isObj(def)) scanProperNouns(def).forEach((w) => add(w));
  // 世界书触发词：独立上限（从此刻已收的词数往后数）；超出的计入 overflow，不静默丢
  const keyCap = terms.length + GLOSSARY_KEYS_MAX;
  const overKeys = new Set();
  for (const { entry } of loreEntries(def)) {
    for (const kf of KEY_FIELDS) if (Array.isArray(entry[kf])) for (const k of entry[kf]) if (typeof k === 'string' && add(k, keyCap)) overKeys.add(k.trim().toLowerCase());
  }
  return { terms, overflow: overKeys.size };
}

/** 正文要扫的全部文本（顶层长文本 + 备选开场白 + 世界书内容）。 */
function bodyTexts(def) {
  if (!isObj(def)) return [];
  return [...DEF_TEXT_FIELDS.map((k) => def[k]), ...(Array.isArray(def.alternate_greetings) ? def.alternate_greetings : []), ...loreEntries(def).map((x) => x.entry.content)]
    .filter((x) => typeof x === 'string');
}

/**
 * 正文专有名词扫描：只收同时满足下面全部条件的词（按出现次数排序，最多 GLOSSARY_PROPER_MAX 个）——
 *   ① 句中（前一个非空白字符不是句末标点 / 换行 / 引号 / 星号 / 括号等，即去掉句首位置）首字母大写出现 ≥ GLOSSARY_PROPER_MIN_COUNT 次；
 *   ② 在全文里从不以小写形式出现（区分大小写整词匹配）；③ 不在常见英语词表 / 停用词里。
 */
export function scanProperNouns(def) {
  const texts = bodyTexts(def);
  const all = texts.join('\n');
  const counts = new Map();
  for (const t of texts) {
    for (const m of t.matchAll(/[A-Za-z][A-Za-z'’-]*/g)) {
      const w = m[0].replace(/['’]s$/, '').replace(/[-'’]+$/, '');
      if (w.length < 3 || !/^[A-Z][a-z]/.test(w)) continue;
      const lw = w.toLowerCase();
      if (STOP_CAPS.has(lw) || COMMON_WORDS.has(lw)) continue;
      let j = m.index - 1;
      while (j >= 0 && (t[j] === ' ' || t[j] === '\t')) j -= 1;
      if (j < 0 || /[.!?。！？…\n"“”'‘’*:：;；(（\[{>\-—_~]/.test(t[j])) continue; // 句首 / 引号后 / 动作开头：可能只是普通词大写
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  const out = [];
  for (const [w, c] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    if (c < GLOSSARY_PROPER_MIN_COUNT) continue;
    const lw = w.toLowerCase();
    if (lw !== w && wordRe(lw).test(all)) continue; // 小写出现过：多半是普通词
    out.push(w);
    if (out.length >= GLOSSARY_PROPER_MAX) break;
  }
  return out;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 整词匹配（区分大小写；词边界按 Unicode 字母 / 数字 / 下划线判断，中日文词条同样适用）。 */
export function wordRe(term) {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escRe(String(term))}(?![\\p{L}\\p{N}_])`, 'u');
}

/** 译名表（对象）按原词查，不区分大小写。 */
export function glossaryLookup(glossary, term) {
  if (!glossary || typeof term !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(glossary, term)) return glossary[term];
  const k = term.trim().toLowerCase();
  for (const [o, z] of Object.entries(glossary)) if (o.toLowerCase() === k) return z;
  return null;
}

/** 本批原文里真正出现过（整词、区分大小写）的译名表条目 → system 附加段。 */
export function glossaryBlock(glossary, texts) {
  if (!glossary) return '';
  const hay = texts.join('\n');
  const lines = [];
  for (const [o, z] of Object.entries(glossary)) {
    if (!z || o === z) continue;
    if (wordRe(o).test(hay)) lines.push(`${o} → ${z}`);
  }
  if (!lines.length) return '';
  return `\n\n译名表（原文 → 中文）：这些专有名词按此表翻译，同一个名字全文只用这一种译法：\n${lines.join('\n')}`;
}

export function getAt(obj, path) {
  let cur = obj;
  for (const k of path) { if (cur === null || cur === undefined) return undefined; cur = cur[k]; }
  return cur;
}
export function setAt(obj, path, v) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
  cur[path[path.length - 1]] = v;
}

/**
 * 长文本切段：按换行切，段内不超过 max；换行串原样留在段与段之间（不交给模型）。
 * 返回 {parts:[{text}|{sep}]}；单行超长时按句末标点再切，再不行硬切。
 */
export function splitSegments(text, max = SEG_MAX_CHARS) {
  const s = String(text);
  if (s.length <= max) return [{ text: s }];
  const pieces = s.split(/(\n+)/); // [行, 换行串, 行, ...]
  const out = [];
  let cur = '';
  const flush = () => { if (cur) { out.push({ text: cur }); cur = ''; } };
  const pushLong = (line) => {
    // 句末切（保留标点在前一段）；还超长就硬切
    const sents = line.match(/[^.!?。！？]+[.!?。！？]+["'”’)\]]*\s*|[^.!?。！？]+$/g) || [line];
    let buf = '';
    for (const x of sents) {
      if (buf && buf.length + x.length > max) { out.push({ text: buf }); buf = ''; }
      if (x.length > max) { for (let i = 0; i < x.length; i += max) out.push({ text: x.slice(i, i + max) }); continue; }
      buf += x;
    }
    if (buf) out.push({ text: buf });
  };
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (i % 2 === 1) { // 换行串
      if (cur.length + p.length <= max) { cur += p; continue; }
      flush();
      out.push({ sep: p });
      continue;
    }
    if (cur.length + p.length <= max) { cur += p; continue; }
    flush();
    if (p.length > max) pushLong(p); else cur = p;
  }
  flush();
  // 段首尾的换行挪成分隔串（模型常丢首尾空白）
  const fixed = [];
  for (const x of out) {
    if (x.sep !== undefined) { fixed.push(x); continue; }
    const m = /^(\n*)([\s\S]*?)(\n*)$/.exec(x.text);
    if (m[1]) fixed.push({ sep: m[1] });
    if (m[2]) fixed.push({ text: m[2] });
    if (m[3]) fixed.push({ sep: m[3] });
  }
  return fixed;
}

const MACRO_RE = /\{\{[^{}]*\}\}|<\s*(?:bot|user|char)\s*>/gi;
const count = (s, re) => (String(s).match(re) || []).length;
const HEADING_RE = /^[ \t]*#{1,6}(?!#)/gm;
const macroBag = (s) => (String(s).match(MACRO_RE) || []).map((m) => m.replace(/\s+/g, '').toLowerCase()).sort().join('|');

/**
 * 逐叶校验（契约 §19.2）：宏、*星号*、换行、markdown（代码块围栏、标题行、列表行、引用行）数量与原文一致。
 * short（名字 / 标签 / 触发词）：只要求非空、不新增换行、宏一致。
 */
export function leafProblem(src, zh, { short = false } = {}) {
  if (typeof zh !== 'string' || !zh.trim()) return 'empty';
  if (macroBag(src) !== macroBag(zh)) return 'macro';
  if (short) return count(zh, /\n/g) <= count(src, /\n/g) ? null : 'newline';
  if (count(src, /\*/g) !== count(zh, /\*/g)) return 'star';
  if (count(src, /\n/g) !== count(zh, /\n/g)) return 'newline';
  if (count(src, /```/g) !== count(zh, /```/g)) return 'fence';
  // 标题行宽松比较：只数「行首 1–6 个 #」的行数，# 后有没有空格不管（原文「##标题」、译文「## 标题」算一致）
  if (count(src, HEADING_RE) !== count(zh, HEADING_RE)) return 'heading';
  if (count(src, /^\s*>/gm) !== count(zh, /^\s*>/gm)) return 'quote';
  return null;
}
export const checkLeaf = (src, zh, o = {}) => leafProblem(src, zh, o) === null;

/** 首尾空白不交给模型，回填时原样补回。 */
function wrapWs(text) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  return { lead: m[1], core: m[2], trail: m[3] };
}

/**
 * 把模型输出解析成 {id: 译文}。顺序：整段就是 JSON → 只剥「整段外层」的 ```json 围栏 → 第一个 { 到最后一个 }。
 * 不在中间找围栏：译文值里常有 ```（状态栏 / 代码块），旧写法会截到值里面去，整批判失败。
 */
export function parseIdJson(text) {
  const t = String(text || '').trim();
  const tryObj = (x) => { try { const o = JSON.parse(x); return isObj(o) ? o : null; } catch { return null; } };
  let o = tryObj(t);
  if (o) return o;
  const fence = /^```[A-Za-z]*[ \t]*\n?([\s\S]*?)\n?```\s*$/.exec(t);
  if (fence) { o = tryObj(fence[1].trim()); if (o) return o; }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  return tryObj(t.slice(a, b + 1));
}

const SYSTEM_LONG = [
  '你是专业的文学翻译，把角色扮演角色卡的内容翻译成自然流畅的简体中文（新加坡简体）。',
  '输入是一个 JSON 对象，键是编号，值是待翻译的原文。',
  '只输出一个 JSON 对象：键与输入完全相同、一个不少，值是对应译文；不要解释，不要代码块围栏。',
  '规则：原样保留 {{char}}、{{user}}、<BOT>、<USER> 等占位符，数量一致；',
  '保留 *星号*（星号个数必须与原文相同）、markdown 符号、引号结构；',
  '换行数量必须与原文完全一致（原文有几个换行，译文就有几个）；',
  '人名一律音译（有通行中文译名的用通行译名），不要按字面意思意译；地名、组织名、作品名可音译或意译；',
  '忠实翻译，不删减、不添加、不评论、不审查改写。',
].join('');

const SYSTEM_SHORT = [
  '你是专业翻译，把角色扮演网站上的短文本（角色名、一句话简介、标签、世界书触发词）翻译成简体中文（新加坡简体）。',
  '输入是一个 JSON 对象，键是编号，值是原文。',
  '只输出一个 JSON 对象：键与输入完全相同、一个不少，值是译文；不要解释，不要代码块围栏。',
  '角色名、人名：一律音译（有通行中文译名的用通行译名），不要按字面意思翻译成普通名词；作品名、称号、组织名才可以意译；',
  '一句话简介、标签与触发词：给出简洁的中文；',
  '原样保留 {{char}}、{{user}} 等占位符；不添加原文没有的内容。',
].join('');

const SYSTEM_GLOSSARY = [
  '你是专业的文学翻译，正在为一张角色扮演角色卡建立「译名表」，之后整张卡都按这张表统一翻译成简体中文（新加坡简体）。',
  '输入是一个 JSON 对象，键是编号，值是原词（角色名、世界书触发词、正文里的专有名词）。',
  '只输出一个 JSON 对象：键与输入完全相同、一个不少，值是中文译名；不要解释，不要代码块围栏。',
  '规则：人名一律音译（有通行中文译名的用通行译名，例如 Alice → 爱丽丝），绝不按字面意思翻译（例如 Cricket 作人名是「克里克特」而不是「蟋蟀」）；',
  '同一个人的全名与名、姓分开出现时，译法要一致（Lara Lightland → 劳拉·莱特兰，Lara → 劳拉，Lightland → 莱特兰）；',
  '地名、组织名、作品名、称号可以意译；普通词语给出最贴切、尽量具体的中文词（至少两个字）；',
  '原样保留 {{char}}、{{user}} 等占位符。',
].join('');

const SYSTEM_TAGS = [
  '你是专业翻译，下面是角色扮演角色卡网站上的分类标签（题材、人设、玩法、性别取向等），请翻译成简体中文（新加坡简体）。',
  '输入是一个 JSON 对象，键是编号，值是标签原文。',
  '只输出一个 JSON 对象：键与输入完全相同、一个不少，值是简短的中文标签（一般 2–6 个字）；不要解释，不要代码块围栏。',
  '按角色卡圈内的习惯意思翻译，不要按字面直译；专有名词（作品名、角色名）用通行中文译名，没有就音译。',
].join('');

/**
 * 平台元标签（契约外、取最稳妥做法）：chub 的卡格式 / 模型 / 前端标记，翻成中文没有意义还会误导 → 原样保留、不送翻；
 * 圈内词给固定译名。键一律小写。全站共享缓存里旧的错误译名（root=根、tavern=酒馆…）由这张表覆盖。
 */
export const TAG_KEEP = new Set(['root', 'tavern', 'cai', 'oai', 'gpt4', 'gpt-4', 'gpt-4o', 'gpt3', 'gpt-3.5', 'chatgpt', 'claude', 'mythomax', 'kayra', 'sillytavern', 'agnai', 'risuai', 'expressions',
  'v2 alternate greetings', 'alternate greetings', 'alt greetings', 'lorebook', 'chub', 'janitorai', 'janitor', 'llama', 'mixtral', 'mistral', 'gemini', 'deepseek', 'pygmalion', 'novelai', 'ooba', 'kobold', 'koboldai', 'tavernai', 'w++', 'plist', 'ali:chat', 'alichat']);
export const TAG_FIXED = new Map([
  ['vanilla', '常规向'], ['litrpg', '游戏化小说'], ['scenario', '剧情'], ['oc', '原创角色'], ['original character', '原创角色'], ['sfw', '全年龄'], ['nsfw', '成人'],
  ['nsfl', '重口'], ['rpg', '角色扮演游戏'], ['multiple characters', '多角色'], ['male', '男性'], ['female', '女性'], ['fluff', '温馨'], ['angst', '虐心'],
  ['wholesome', '暖心'], ['slice of life', '日常'], ['yandere', '病娇'], ['tsundere', '傲娇'], ['kuudere', '冷娇'], ['dandere', '怯娇'], ['isekai', '异世界'],
]);
/** 标签的固定处理：保留原词 / 固定译名 / null（需要查表或送翻）。 */
export function fixedTag(tag) {
  const k = String(tag || '').trim().toLowerCase();
  if (TAG_KEEP.has(k)) return String(tag);
  return TAG_FIXED.get(k) ?? null;
}

/** 单元装批：按顺序装，字数与个数都不超限。 */
export function packBatches(units, { maxChars = BATCH_MAX_CHARS, maxUnits = BATCH_MAX_UNITS } = {}) {
  const batches = [];
  let cur = [];
  let chars = 0;
  for (const u of units) {
    if (cur.length && (chars + u.text.length > maxChars || cur.length >= maxUnits)) { batches.push(cur); cur = []; chars = 0; }
    cur.push(u);
    chars += u.text.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 「上游不可用」：超时（504 / AbortError / TimeoutError）、上游 5xx、连不上。这类错误拆批重试没有意义（换小批照样卡），
 * 只重试一次并计入熔断。拒答（code=refused，也是 502）不算：它要靠拆批把出问题的那条隔离出来。
 */
export function isUpstreamDown(e) {
  if (!e) return false;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  if (e.code === 'refused') return false;
  if (['timeout', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET'].includes(e.code)) return true;
  const st = Number(e.status);
  return Number.isFinite(st) && st >= 500 && st < 600;
}

/**
 * 一次翻译任务的闸门（整卡 / 一批列表 / 一批标签各一个）：总截止时间 + 连续上游错误熔断。
 * stopped：null | 'deadline' | 'upstream'。停下以后，还没发出去的批直接算失败（调用方保留原文）。
 */
export function createTaskGuard({ deadlineMs = 0, maxUpstream = TASK_UPSTREAM_MAX, now = Date.now } = {}) {
  const deadline = deadlineMs > 0 ? now() + deadlineMs : 0;
  const g = {
    stopped: null, streak: 0, upstream: 0, deadline,
    /** 离截止还剩多少毫秒（没设截止返回 Infinity）。 */
    remaining: () => (deadline ? deadline - now() : Infinity),
    /** 还能不能发新的批（顺便把到点的标成 deadline）。 */
    open() {
      if (g.stopped) return false;
      if (deadline && now() >= deadline) { g.stopped = 'deadline'; return false; }
      return true;
    },
    fail(e) {
      if (!isUpstreamDown(e)) { g.streak = 0; return false; }
      g.upstream += 1;
      g.streak += 1;
      if (g.streak >= maxUpstream && !g.stopped) g.stopped = 'upstream';
      return true;
    },
    ok() { g.streak = 0; },
  };
  return g;
}

/**
 * 重试轮的占位符数量提示：模型常把反复出现的 {{user}} 合并成「自己 / 你」，宏数量对不上整条就被退回原文。
 * 重试时逐条写明「本条含 {{user}}×N、{{char}}×M」，要求原样出现同样次数。没有宏的批返回空串。
 */
export function macroHint(units) {
  const lines = [];
  for (const u of units) {
    const c = new Map();
    for (const m of String(u.text).match(MACRO_RE) || []) { const k = m.replace(/\s+/g, ''); c.set(k, (c.get(k) || 0) + 1); }
    if (c.size) lines.push(`${u.id}：${[...c].map(([k, n]) => `${k}×${n}`).join('、')}`);
  }
  if (!lines.length) return '';
  return `\n\n占位符数量硬性要求（上次这些条目的占位符数量对不上，整条被退回了）：下列编号的原文含占位符，译文里每种占位符出现的次数必须与下表完全相同。`
    + `原作者常把代词（themselves / his / her / him）也写成了 {{user}}，原文因此语法不通——照样逐个保留，宁可中文读起来重复，`
    + `也绝不能把任何一处改写成「自己」「你」「他」「她」「其」或省略、合并。`
    + `例：「{{user}} finds that {{user}} drawn into」→「{{user}}发现{{user}}被卷入」；「align {{user}} with」→「让{{user}}与……结盟」；「test {{user}}wits」→「考验{{user}}的智慧」。`
    + `输出前逐条数一遍占位符：\n${lines.join('\n')}`;
}

/**
 * 译文里是否还留着原文整行（拆片重试时校验不过的小片原样保留）：原文里需要翻译、≥ RESIDUAL_MIN_CHARS 字的行
 * 一字不差地出现在译文里，就算中英混合。用于复用旧译文时把这种叶子挑出来重翻。
 */
export const RESIDUAL_MIN_CHARS = 20;
export function hasResidualSource(src, zh) {
  const z = String(zh ?? '');
  if (!z) return false;
  for (const line of String(src ?? '').split('\n')) {
    const t = line.trim();
    // 至少 4 个英文词才算「一段没翻的话」（网址、代码、单个名字照抄不算）
    if (t.length >= RESIDUAL_MIN_CHARS && (t.match(/[A-Za-z]{2,}/g) || []).length >= 4 && needsTranslation(t) && z.includes(t)) return true;
  }
  return false;
}

/**
 * 翻译一组单元（{id, text, short}）。call(messages, {short, chars, timeoutMs}) → {text}（调用方负责计费）。
 * 每批按 id 返回 JSON 并校验齐全；缺的 / 校验不过的再单独重试一轮；仍不过的不出现在结果里（调用方保留原文）。
 * guard（createTaskGuard）：总截止时间 + 连续上游错误熔断；不传就每次调用新建一个（只有熔断、没有截止）。
 * 多段长单元拆片重试后仍有小片保留原文时，map 里是中英混合的拼接结果，kept 记下该单元保留了几片（调用方据此不算「已翻译」）。
 * @returns {Promise<{map: Map<string,string>, kept: Map<string,number>, calls:number, errors:number, upstreamErrors:number, stopped:null|'deadline'|'upstream'}>}
 */
export async function translateUnits(units, call, { concurrency = TRANSLATE_CONCURRENCY, systemFor = null, label = '', guard = null } = {}) {
  const map = new Map();
  const g = guard || createTaskGuard();
  const tag = label ? ' ' + label : '';
  let calls = 0;
  let errors = 0;
  let upstreamErrors = 0;
  // 第二轮（重试）用更小的批：一批里有一条被拒 / 出错时，不连累整批。
  // 例外：因「上游不可用」失败的单元按原批大小只重试一次（拆小了照样卡，只会成倍放大调用次数）。
  const runRound = async (list, retry = false, downIds = new Set()) => {
    const failed = [];
    const failedDown = new Set();
    const down = list.filter((u) => downIds.has(u.id));
    const rest = list.filter((u) => !downIds.has(u.id));
    const longs = rest.filter((u) => !u.short);
    const shorts = rest.filter((u) => u.short);
    const batches = [
      ...packBatches(longs, retry ? { maxChars: Math.ceil(BATCH_MAX_CHARS / 2), maxUnits: 10 } : {}).map((b) => ({ b, short: false })),
      ...packBatches(shorts, { maxUnits: retry ? 8 : SHORT_BATCH_MAX_UNITS }).map((b) => ({ b, short: true })),
      ...packBatches(down.filter((u) => !u.short)).map((b) => ({ b, short: false })),
      ...packBatches(down.filter((u) => u.short), { maxUnits: SHORT_BATCH_MAX_UNITS }).map((b) => ({ b, short: true })),
    ];
    // 重试轮里整批输出解析不了 / 被拒（多半是其中一条被拒 / 输出被截断）：对半拆开再试，最多拆 3 层，把出问题的那条隔离出来
    const runBatch = async (b, short, depth) => {
      if (!g.open()) { failed.push(...b); return; } // 任务已到点 / 已熔断：剩下的批不再发
      const input = {};
      for (const u of b) input[u.id] = u.text;
      let got = null;
      let why = null;
      let isDown = false;
      calls += 1;
      try {
        const sys = ((systemFor && systemFor(b, short)) || (short ? SYSTEM_SHORT : SYSTEM_LONG)) + (retry ? macroHint(b) : '');
        const left = g.remaining();
        const r = await call([
          { role: 'system', content: sys },
          { role: 'user', content: JSON.stringify(input) },
        ], { short, chars: b.reduce((a, u) => a + u.text.length, 0), ...(Number.isFinite(left) ? { timeoutMs: Math.max(1000, left) } : {}) });
        g.ok();
        got = parseIdJson(r?.text);
        if (!got) why = '输出不是合法 JSON（可能被截断）';
      } catch (e) {
        errors += 1;
        if (e?.fatal) throw e;
        isDown = g.fail(e);
        if (isDown) upstreamErrors += 1;
        why = `调用失败（${e?.status || e?.code || 'error'}${isDown ? '，上游不可用' : ''}）`;
      }
      if (isDown) {
        failed.push(...b);
        if (!retry) for (const u of b) failedDown.add(u.id);
        console.error(`[translate]${tag} 一批 ${b.length} 条失败：${why}${retry ? '（重试轮）' : '，稍后整批重试一次'}${g.stopped === 'upstream' ? `；连续 ${g.streak} 次上游不可用，本任务熔断` : ''}`);
        return;
      }
      if (why && retry && b.length > 1 && depth < 3) {
        console.error(`[translate]${tag} 一批 ${b.length} 条失败：${why}，拆开重试`);
        const mid = Math.ceil(b.length / 2);
        await runBatch(b.slice(0, mid), short, depth + 1);
        await runBatch(b.slice(mid), short, depth + 1);
        return;
      }
      let missing = 0;
      const rules = new Map();
      for (const u of b) {
        const zh = got && typeof got[u.id] === 'string' ? got[u.id] : null;
        const bad = zh === null ? null : leafProblem(u.text, zh, { short: u.short });
        if (zh !== null && !bad) { map.set(u.id, zh); continue; }
        failed.push(u);
        if (got && zh === null) missing += 1;
        if (bad) rules.set(bad, (rules.get(bad) || 0) + 1);
      }
      // 只记批大小与原因，不记原文
      if (why) console.error(`[translate]${tag} 一批 ${b.length} 条失败：${why}${retry ? '（重试轮）' : ''}`);
      else if (missing || rules.size) {
        console.error(`[translate]${tag} 一批 ${b.length} 条里 ${missing + [...rules.values()].reduce((a, x) => a + x, 0)} 条没收：${missing ? `缺编号 ${missing} 条` : ''}${[...rules].map(([k, n]) => ` 校验不过(${k}) ${n} 条`).join('')}${retry ? '（重试轮）' : ''}`);
      }
    };
    await pool(batches, concurrency, ({ b, short }) => runBatch(b, short, 0));
    return { failed, failedDown };
  };
  const first = await runRound(units);
  let keptPieces = 0;
  let mixedUnits = 0;
  const keptBy = new Map(); // 单元 id → 拆片重试后仍保留原文的小片数（这些单元的译文是中英混合，调用方不能算「已翻译」）
  if (first.failed.length && g.open()) {
    // 重试轮：校验不过 / 缺编号的多段长单元按段落拆成小片逐片翻译与校验（契约 §19.2 补丁）——
    // 只有校验不过的小片保留原文，其余回填，免得一处星号 / 宏对不上就整段人设退回英文。上游不可用的单元不拆（拆了照样卡）。
    const direct = [];
    const plans = [];
    for (const u of first.failed) {
      if (!u.short && !first.failedDown.has(u.id) && /\n/.test(u.text)) {
        let parts = splitParagraphs(u.text);
        if (parts.filter((x) => x.text !== undefined).length < 2) parts = splitParagraphs(u.text, 0); // 短的多行文本：逐行拆
        const pieces = parts.filter((x) => x.text !== undefined);
        if (pieces.length >= 2) {
          pieces.forEach((x, k) => { x.unit = { id: `${u.id}.${k + 1}`, text: x.core, short: false }; });
          plans.push({ u, parts });
          continue;
        }
      }
      direct.push(u);
    }
    await runRound([...direct, ...plans.flatMap((pl) => pl.parts.filter((x) => x.unit).map((x) => x.unit))], true, first.failedDown);
    for (const { u, parts } of plans) {
      let got = 0;
      let kept = 0;
      const out = parts.map((x) => {
        if (!x.unit) return x.sep;
        const t = map.get(x.unit.id);
        map.delete(x.unit.id);
        if (t === undefined) { kept += 1; return x.lead + x.core + x.trail; }
        got += 1;
        return x.lead + t.trim() + x.trail;
      }).join('');
      if (!got) continue;
      map.set(u.id, out);
      if (kept) { keptPieces += kept; mixedUnits += 1; keptBy.set(u.id, kept); }
    }
    if (plans.length) console.error(`[translate]${tag} ${plans.length} 段长文本按段落拆片重试${mixedUnits ? `：${mixedUnits} 段里有 ${keptPieces} 片校验不过，保留原文，其余已回填` : '，全部回填'}`);
  }
  if (g.stopped) console.error(`[translate]${tag} 提前结束（${g.stopped === 'deadline' ? '到了总时限' : `上游不可用，熔断`}），已翻 ${map.size}/${units.length} 条`);
  return { map, calls, errors, upstreamErrors, stopped: g.stopped, keptPieces, mixedUnits, kept: keptBy };
}

/**
 * 长文本按段落拆小片：空行处一定断开；单个换行处，相邻短行合并到 PIECE_MAX_CHARS 以内。
 * 返回 [{sep}|{text, lead, core, trail}]，按顺序拼回去等于原文；不需要翻译的行（纯符号 / 已是中文）作为 sep 原样保留。
 */
export function splitParagraphs(text, max = PIECE_MAX_CHARS) {
  const raw = String(text).split(/(\n+)/); // [行, 换行串, 行, ...]
  const groups = []; // {text} | {sep}
  let cur = null;
  for (let i = 0; i < raw.length; i++) {
    const x = raw[i];
    if (i % 2 === 1) {
      if (cur !== null && x === '\n' && i + 1 < raw.length && cur.length + 1 + raw[i + 1].length <= max && needsTranslation(raw[i + 1])) { cur += x; continue; }
      if (cur !== null) { groups.push({ text: cur }); cur = null; }
      groups.push({ sep: x });
      continue;
    }
    if (cur !== null) { cur += x; continue; } // 上面合并进来的下一行
    if (!x) continue;
    if (!needsTranslation(x)) { groups.push({ sep: x }); continue; }
    cur = x;
  }
  if (cur !== null) groups.push({ text: cur });
  return groups.map((gp) => {
    if (gp.sep !== undefined) return gp;
    const w = wrapWs(gp.text);
    return { text: gp.text, lead: w.lead, core: w.core, trail: w.trail };
  });
}

/**
 * 整卡翻译（纯流程，模型调用经 call 注入）。契约 §19.2 + §19.3：
 *   ① 先建译名表：collectGlossaryTerms → 一次短文本请求 {原词: 中文}（上次同源的译名表能覆盖全部词就直接复用，不再请求）；
 *   ② 再翻正文：每批 system 附上本批用得到的译名表；角色名直接取译名表里的译名（与正文一致）；
 *   ③ 世界书触发词不送翻：原词 ∪ 译名表里的中文名（中文少于 2 个字的不追加，免得「门」「钱」在中文会话里到处命中）。
 * 复用上一次同源译文的叶子，只在译名表没变时才复用（译名变了，旧叶子里的人名就对不上了）。
 * @param {object} def        chub definition（characters.card_json）
 * @param {{name?:string, tagline?:string, reuse?:object|null, glossary?:object|null}} meta
 *        reuse = 上一次同源的 card_json_zh；glossary = 上一次同源的译名表
 * @returns {Promise<{zh:object, name_zh:string|null, tagline_zh:string|null, glossary:object, status:'ok'|'partial'|'failed', units:number, translated:number, calls:number}>}
 */
export async function translateDefinition(def, { name = '', tagline = '', reuse = null, glossary: prevGlossary = null, guard = null } = {}, call) {
  const src = isObj(def) ? def : {};
  const zh = structuredClone(src);
  const g = guard || createTaskGuard();
  let calls = 0;

  // ① 译名表
  const { terms, overflow: keysOver } = collectGlossary(src, { name });
  if (keysOver) console.error(`[translate] 世界书触发词超上限 ${keysOver} 个（上限 ${GLOSSARY_KEYS_MAX}），这些触发词不追加中文，状态记为 partial`);
  const prev = isObj(prevGlossary) ? prevGlossary : {};
  const glossary = {};
  const ask = [];
  for (const t of terms) {
    const old = glossaryLookup(prev, t);
    if (typeof old === 'string' && old.trim() && checkLeaf(t, old, { short: true })) glossary[t] = old;
    else ask.push(t);
  }
  if (ask.length) {
    const gUnits = ask.map((t, i) => ({ id: String(i + 1), text: t, short: true }));
    const charName = (name || src.name || '').trim();
    const sys = SYSTEM_GLOSSARY + (charName ? `\n这张卡的角色名是：${charName}` : '');
    const r = await translateUnits(gUnits, call, { systemFor: () => sys, label: '译名表', guard: g });
    calls += r.calls;
    for (const u of gUnits) { const z = r.map.get(u.id); if (z) glossary[u.text] = z.trim(); }
    // 译名表这一步就因上游不可用 / 到点停下了：正文不再翻（照样会卡），整个任务按失败处理（调用方保留上一次的结果）
    const allDown = r.map.size === 0 && r.upstreamErrors > 0 && r.upstreamErrors === r.errors;
    if (r.stopped || allDown) throw Object.assign(new Error(`译名表阶段提前结束（${r.stopped || 'upstream'}）`), { stopped: r.stopped || 'upstream' });
  }
  // 译名表变了才不复用旧叶子：上一次的条目被改 / 被删算变了；只是新增条目（上次没翻出来、这次补上）不算，
  // 否则大卡每次「重试翻译」都要从头翻正文、永远翻不完。上一次压根没有译名表（旧版本结果）时，有词就算变了。
  const prevKeys = Object.keys(prev);
  const glossaryChanged = prevKeys.length === 0 ? Object.keys(glossary).length > 0 : prevKeys.some((k) => glossaryLookup(glossary, k) !== prev[k]);
  const glossaryMissing = terms.filter((t) => !glossary[t]).length + keysOver;

  // ② 正文
  const leaves = collectLeaves(src);
  const extra = [];
  const nameFromGlossary = needsTranslation(name) ? glossaryLookup(glossary, name.trim()) : null;
  if (needsTranslation(name) && !nameFromGlossary) extra.push({ path: ['__meta', 'name'], text: name, kind: 'name' });
  if (needsTranslation(tagline)) extra.push({ path: ['__meta', 'tagline'], text: tagline, kind: 'short' });
  const all = [...leaves, ...extra];

  // 叶子 → 单元：长叶子切段；相同原文只翻一次。
  const unitByText = new Map();
  const units = [];
  const unitFor = (text, short) => {
    const k = `${short ? 's' : 'l'}|${text}`;
    let u = unitByText.get(k);
    if (!u) { u = { id: String(units.length + 1), text, short }; unitByText.set(k, u); units.push(u); }
    return u;
  };
  const plans = all.map((leaf) => {
    const short = leaf.kind !== 'text';
    // 角色卡里的 name 字段：直接用译名表（保证与正文、聊天里的中文名一致）
    if (leaf.kind === 'name' && leaf.path.length === 1 && leaf.path[0] === 'name') {
      const g = glossaryLookup(glossary, leaf.text.trim());
      if (g) return { leaf, reused: g };
    }
    // 复用：上一次同源翻译里，这片叶子已经有校验过的译文（译名表没变时才复用）
    if (reuse && !glossaryChanged && leaf.path[0] !== '__meta' && leaf.kind === 'text') {
      const old = getAt(reuse, leaf.path);
      // 上一次拆片重试时有小片保留了原文（中英混合）的叶子不复用，重翻（否则「重试翻译」永远补不上那几段）
      if (typeof old === 'string' && old !== leaf.text && checkLeaf(leaf.text, old) && !hasResidualSource(leaf.text, old)) return { leaf, reused: old };
    }
    if (short) {
      const w = wrapWs(leaf.text);
      return { leaf, parts: [{ ws: w, unit: unitFor(w.core, true) }] };
    }
    const parts = splitSegments(leaf.text).map((p) => {
      if (p.sep !== undefined) return { sep: p.sep };
      const w = wrapWs(p.text);
      if (!needsTranslation(w.core)) return { sep: p.text }; // 纯符号 / 已是中文的段原样保留
      return { ws: w, unit: unitFor(w.core, false) };
    });
    return { leaf, parts };
  });

  const systemFor = (b, short) => (short ? SYSTEM_SHORT : SYSTEM_LONG) + glossaryBlock(glossary, b.map((u) => u.text));
  let map = new Map();
  let keptBy = new Map();
  if (units.length) {
    const r = await translateUnits(units, call, { systemFor, label: '正文', guard: g });
    map = r.map;
    keptBy = r.kept || new Map();
    calls += r.calls;
    // 上游不可用、正文一条都没翻出来：按失败处理（不拿更差的结果覆盖上一次的 partial）
    if (map.size === 0 && r.upstreamErrors > 0 && (r.stopped === 'upstream' || r.upstreamErrors === r.errors)) throw Object.assign(new Error('正文阶段上游不可用'), { stopped: r.stopped });
  }

  let translated = 0;
  let total = 0;
  let mixed = 0; // 写进了中英混合译文、但不算「已翻译」的叶子数（状态因此落 partial，前端出现「重试翻译」）
  let nameZh = nameFromGlossary ? nameFromGlossary.trim() : null;
  let taglineZh = null;
  for (const p of plans) {
    total += 1;
    let out;
    let partly = false;
    if (p.reused !== undefined) { out = p.reused; } else {
      let ok = true;
      out = p.parts.map((x) => {
        if (x.sep !== undefined) return x.sep;
        if (keptBy.has(x.unit.id)) partly = true;
        const t = map.get(x.unit.id);
        if (t === undefined) { ok = false; return x.ws.lead + x.ws.core + x.ws.trail; }
        return x.ws.lead + t.trim() + x.ws.trail;
      }).join('');
      // 切段后整叶再校验一次（各段都过了，整体一般也过；不过就整叶保留原文）
      if (ok && !checkLeaf(p.leaf.text, out, { short: p.leaf.kind !== 'text' })) ok = false;
      if (!ok) continue;
    }
    // 有小片保留了原文：译文照样写进去（多数段落已是中文），但这一叶不算翻完
    if (partly) mixed += 1; else translated += 1;
    const path = p.leaf.path;
    if (path[0] === '__meta') { if (path[1] === 'name') nameZh = out.trim(); else taglineZh = out.trim(); continue; }
    setAt(zh, path, out);
  }
  // ③ 触发词：原词 ∪ 译名表里的中文名（去重、不区分大小写；中文少于 2 个字的不追加）
  for (const { path } of loreEntries(src)) {
    const e = getAt(zh, path);
    if (!isObj(e)) continue;
    for (const kf of KEY_FIELDS) {
      const arr = e[kf];
      if (!Array.isArray(arr)) continue;
      const seen = new Set(arr.map((x) => String(x).toLowerCase()));
      const add = [];
      for (const k of arr) {
        if (typeof k !== 'string') continue;
        const z = glossaryLookup(glossary, k.trim());
        if (!z || [...z.trim()].length < KEY_ZH_MIN_CHARS || seen.has(z.trim().toLowerCase())) continue;
        seen.add(z.trim().toLowerCase());
        add.push(z.trim());
      }
      if (add.length) e[kf] = [...arr, ...add];
    }
  }
  if (nameZh && isObj(zh) && typeof src.name === 'string' && src.name === name) zh.name = nameZh;
  // 译名表里没翻出来的词也算没翻完（触发词少了中文、正文译名可能不统一）
  total += terms.length + keysOver;
  translated += terms.length + keysOver - glossaryMissing;
  const status = total === 0 || translated === total ? 'ok' : translated === 0 && mixed === 0 ? 'failed' : 'partial';
  if (mixed) console.error(`[translate] 正文 ${mixed} 片叶子仍有段落保留原文（中英混合），状态记为 partial，可「重试翻译」补齐`);
  return { zh, name_zh: nameZh, tagline_zh: taglineZh, glossary, status, units: total, translated, mixed, calls, stopped: g.stopped };
}

/** card_json + 名字 + 简介的哈希：源卡变化（chub 刷新后内容变了）就重翻。 */
export const sourceHash = (row) => crypto.createHash('sha256').update(JSON.stringify([row.card_json || '', row.name || '', row.tagline || ''])).digest('hex').slice(0, 32);

const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ======================================================================
// 服务：按需整卡翻译（同一角色并发只翻一次）、列表批量翻译、标签译名表、中文名搜索
// ======================================================================

export const TRANSLATE_STATUSES = ['pending', 'ok', 'partial', 'failed'];

/**
 * @param {object} o
 * @param {import('node:sqlite').DatabaseSync} o.db
 * @param {object} o.llm      complete(messages, {model, max_tokens, temperature, timeoutMs})
 * @param {object} o.models   模型服务（byId / listEnabled / systemDefault）
 * @param {object} o.costs    计费服务（recordSystem）
 */
export function createTranslationService({ db, llm, models, costs, grokCli = null }) {
  const inflight = new Map(); // character id → Promise
  const history = createTranslationHistory({ db, sourceHash });
  const manualInflight = new Map(); // 角色 + 原文版本 + 模型配置 → {promise, participants}
  const manualJobs = new Map(); // 用户 + 角色 → 最新意图；旧任务完成时不得抢回选择
  const userCharacterKey = (row, user) => `${user?.id}:${row?.id}`;
  const listInflight = new Set(); // chub path
  const tagInflight = new Set(); // tag
  const listQueue = new Map(); // chub path → {card, userId}
  const tagQueue = new Map(); // tag → userId
  let listTimer = null;
  // 翻不出来的（模型出错 / 拒答 / 校验不过）一段时间内不再排队，免得每次打开列表都重新花钱
  const LIST_BACKOFF_MS = 30 * 60 * 1000;
  const backoff = new Map(); // 'p:'+path | 't:'+tag → 到期时间
  const inBackoff = (k) => { const t = backoff.get(k); if (t && t > Date.now()) return true; if (t) backoff.delete(k); return false; };
  const setBackoff = (k, ms = LIST_BACKOFF_MS) => {
    if (backoff.size > 20000) { const now = Date.now(); for (const [x, t] of backoff) if (t <= now) backoff.delete(x); if (backoff.size > 20000) backoff.clear(); }
    backoff.set(k, Date.now() + ms);
  };

  // ---------- 模型熔断 ----------
  // 同一模型连续 MODEL_TRIP_AFTER 次「上游不可用」（超时 / 5xx / 连不上）→ 熔断 MODEL_TRIP_MS：
  // 期间翻译（以及语音整理）改用下一个启用的 DeepSeek 模型并写 warn；一个能用的都没有就直接跳过（列表 / 标签不排队，整卡记失败）。
  const health = new Map(); // model id → {streak, until}
  const tripped = (m) => { const h = m ? health.get(m.id) : null; return !!(h && h.until > Date.now()); };
  // 本机 CLI 的「内容没过校验 / 输出过长」是这张卡的问题，不是 CLI 不可用：不计入熔断（否则几张难卡就把本机翻译停 5 分钟）。
  // grok_cli_deadline 是排队等锁把整卡时限耗完、没起生成进程，同样不算 CLI 不可用。
  const CLI_CONTENT_ERRORS = new Set(['grok_cli_invalid', 'grok_cli_output_limit', 'grok_cli_deadline']);
  function noteFail(m, e) {
    if (!m || !isUpstreamDown(e) || CLI_CONTENT_ERRORS.has(e?.code)) return;
    const h = health.get(m.id) || { streak: 0, until: 0 };
    h.streak += 1;
    if (h.streak >= MODEL_TRIP_AFTER && h.until <= Date.now()) {
      h.until = Date.now() + MODEL_TRIP_MS;
      console.warn(`[translate] 模型 ${m.name || '?'}#${m.id} 连续 ${h.streak} 次上游不可用，熔断 ${Math.round(MODEL_TRIP_MS / 60000)} 分钟，${m.transport === 'grok-cli' ? '本机 CLI 翻译暂停' : '期间改用其他启用的 DeepSeek 模型'}`);
    }
    health.set(m.id, h);
  }
  function noteOk(m) { if (m && health.has(m.id)) health.delete(m.id); }
  /** 熔断剩余毫秒（没熔断返回 0）。 */
  const trippedFor = (m) => { const h = m ? health.get(m.id) : null; return h && h.until > Date.now() ? h.until - Date.now() : 0; };

  /** 没有熔断时的首选：settings.translate_model_id（启用）→「DeepSeek 快速」→ 任一启用的 DeepSeek → 全站默认。 */
  function preferredApi() {
    const s = getSettings(db);
    const byId = s.translate_model_id ? models.byId?.(s.translate_model_id) : null;
    if (byId && byId.enabled) return byId;
    const enabled = models.listEnabled?.() || [];
    return enabled.find((m) => m.name === 'DeepSeek 快速')
      || enabled.find((m) => isDeepseekUrl(m.base_url) && /flash/i.test(m.model))
      || enabled.find((m) => isDeepseekUrl(m.base_url))
      || models.systemDefault?.() || null;
  }
  function preferred() {
    const s = getSettings(db);
    if (s.translate_backend === 'cli') return grokCli?.byId(s.translate_cli_model === 'grok-4.7' ? -4507 : -4505) || null;
    return preferredApi();
  }
  function requireModel(id) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || (id <= 0 && id !== -4505 && id !== -4507)) throw new HttpError(400, '请选择有效的翻译模型');
    const m = id < 0 ? grokCli?.byId(id) : models.byId?.(id);
    if (!m?.enabled) throw new HttpError(400, '这个翻译模型不可用');
    return m;
  }
  const complete = (messages, options = {}) => {
    const m = options.model || preferred();
    if (!m && getSettings(db).translate_backend === 'cli') throw new HttpError(503, '本机 CLI 翻译尚未配置', 'cli_unavailable');
    if (m?.transport === 'grok-cli') return grokCli.complete(messages, { ...options, model: m });
    return llm.complete(messages, options);
  };
  const fellBack = new Map(); // 首选 id → 上次写 warn 的时间（每次熔断只写一次）
  /**
   * 翻译用模型。首选熔断时退到下一个启用且没熔断的 DeepSeek 模型（写 warn）；都不行：healthy=true 返回 null，否则仍返回首选。
   * @param {{healthy?: boolean}} [o]
   */
  function model({ healthy = false, apiOnly = false } = {}) {
    const p = apiOnly ? preferredApi() : preferred();
    if (!p || !tripped(p)) return p;
    if (p.transport === 'grok-cli') return healthy ? null : p;
    const alt = (models.listEnabled?.() || []).find((m) => m.id !== p.id && isDeepseekUrl(m.base_url) && !tripped(m));
    if (alt) {
      const last = fellBack.get(p.id) || 0;
      if (Date.now() - last > MODEL_TRIP_MS) {
        fellBack.set(p.id, Date.now());
        console.warn(`[translate] 模型 ${p.name || '?'}#${p.id} 熔断中，翻译 / 整理暂改用 ${alt.name || '?'}#${alt.id}`);
      }
      return alt;
    }
    return healthy ? null : p;
  }

  /** 一次模型调用：记 system_costs（kind=translate，user_id=触发者）。短文本批 45 秒超时，长文本 150 秒；都不超过任务剩余时间。 */
  const caller = (userId, m) => async (messages, { short, timeoutMs } = {}) => {
    let r;
    const base = short ? SHORT_TIMEOUT_MS : TRANSLATE_TIMEOUT_MS;
    // 任务进行中这个模型熔断了（别的任务连续超时触发）：剩下的批不再等，直接结束本任务
    if (tripped(m)) throw Object.assign(new HttpError(504, '翻译模型暂时不可用（熔断中）', 'timeout'), { fatal: true, tripped: true });
    try {
      r = await complete(messages, { model: m || undefined, max_tokens: short ? 2000 : TRANSLATE_MAX_TOKENS, temperature: 0.2, timeoutMs: Math.max(1000, Math.min(base, timeoutMs || base)) });
    } catch (e) {
      if (e?.usage) { try { costs?.recordSystem('translate', m, userId, e); } catch { /* ignore */ } }
      noteFail(m, e);
      // 没配置模型 / key / 额度 / 限流：后面的批也不用试了
      if (e instanceof HttpError && e.status === 503) e.fatal = true;
      throw e;
    }
    noteOk(m);
    try { costs?.recordSystem('translate', (r?.model_id && models.byId?.(r.model_id)) || m, userId, r); } catch (err) { console.error('[translate] 记录花费失败', err?.message || err); }
    return r;
  };
  async function translateCard(row, m, userId, options = {}) {
    if (m?.transport !== 'grok-cli') return translateDefinition(parseJson(row.card_json,{}) || {}, { name: row.name, tagline: row.tagline,
      ...options, guard: createTaskGuard({ deadlineMs: CARD_DEADLINE_MS }) }, caller(userId,m));
    try {
      // CLI 按卡分块、自带整卡总时限；透传 reuse / glossary 复用上次同源已过校验的叶子与译名项。
      const result = await grokCli.translateCard(row, { ...options, model: m });
      noteOk(m);
      try { costs?.recordSystem('translate',m,userId,result); } catch { /* 用量记录不影响译文 */ }
      return result;
    } catch (e) { noteFail(m,e); throw e; }
  }

  const rowById = (id) => db.prepare('SELECT * FROM characters WHERE id = ?').get(id);

  // ---------- 整卡翻译全站并发上限（技术性花费保护）----------
  // 同时最多 CARD_CONCURRENCY 张卡在翻，其余按先来后到排队（排队上限 CARD_QUEUE_MAX，排满本次不翻、下次打开再排）。
  // 排队期间该卡在 inflight 里，对外状态是「翻译中」；总时限 CARD_DEADLINE_MS 从真正开翻时算。
  let cardRunning = 0;
  const cardWaiters = []; // [{resolve, path, at}]
  const cardStats = { queued_total: 0, queue_peak: 0, rejected_total: 0, wait_ms_max: 0 };
  const cardSlotFree = () => cardRunning < CARD_CONCURRENCY;
  function acquireCard(path) {
    if (cardSlotFree()) { cardRunning += 1; return Promise.resolve(0); }
    const at = Date.now();
    cardStats.queued_total += 1;
    return new Promise((resolve) => {
      cardWaiters.push({ resolve, path, at });
      cardStats.queue_peak = Math.max(cardStats.queue_peak, cardWaiters.length);
      console.warn(`[translate] 整卡翻译排队：${path}（在翻 ${cardRunning}/${CARD_CONCURRENCY}，排队 ${cardWaiters.length}）`);
    });
  }
  function releaseCard() {
    const next = cardWaiters.shift();
    if (!next) { cardRunning = Math.max(0, cardRunning - 1); return; }
    const waited = Date.now() - next.at;
    cardStats.wait_ms_max = Math.max(cardStats.wait_ms_max, waited);
    console.warn(`[translate] 整卡翻译出队开翻：${next.path}（排队 ${Math.round(waited / 1000)} 秒，剩余排队 ${cardWaiters.length}）`);
    next.resolve(waited); // 名额直接交给下一个（cardRunning 不变）
  }
  /** 整卡翻译排队情况（日志 / 测试用）。 */
  const cardQueueStats = () => ({ running: cardRunning, queued: cardWaiters.length, max_running: CARD_CONCURRENCY, max_queue: CARD_QUEUE_MAX, ...cardStats });

  // 旧版本落成 'ok' 的卡里可能还有整段英文（拆片重试保留原文却算成已翻译）：对外按 'partial' 报，「重试翻译」才会出现、也才会重翻那几段。
  const residualMemo = new Map(); // id → {key, n}
  function residualOf(row) {
    const key = `${row.translate_hash}|${row.translated_at}|${(row.card_json_zh || '').length}`;
    const hit = residualMemo.get(row.id);
    if (hit && hit.key === key) return hit.n;
    const n = residualLeaves(parseJson(row.card_json, null), parseJson(row.card_json_zh, null));
    if (residualMemo.size > 5000) residualMemo.clear();
    residualMemo.set(row.id, { key, n });
    return n;
  }

  /** 当前行的翻译状态（对外）：源卡变了 / 从没翻过 → 'none'；在翻 → 'pending'；'ok' 但还留着原文段落 → 'partial'。 */
  function statusOf(row) {
    if (!row) return 'none';
    if (inflight.has(row.id)) return 'pending';
    if (!row.translate_status || row.translate_status === 'pending') return 'none';
    if (row.translate_hash !== sourceHash(row)) return 'none';
    if (row.translate_status === 'ok' && row.card_json_zh && residualOf(row) > 0) return 'partial';
    return row.translate_status;
  }

  /** 有能用的中文版（源卡没变、状态 ok/partial），不解析 JSON（列表里用）。 */
  function hasZh(row) {
    if (!row || !row.card_json_zh) return false;
    if (row.translate_status !== 'ok' && row.translate_status !== 'partial') return false;
    return row.translate_hash === sourceHash(row);
  }

  /** 能用于展示 / 提示词的中文版（源卡没变、状态 ok/partial）。 */
  function zhOf(row) {
    if (!hasZh(row)) return null;
    return parseJson(row.card_json_zh, null);
  }

  // 每个账号每天触发整卡翻译的次数（契约外、取最稳妥做法：settings.translate_daily_max，0 = 不限只记录；花费本来就逐笔记在 system_costs）
  const dailyStarts = new Map(); // userId → {day, n}
  const sgDayNow = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  function overDailyLimit(userId) {
    if (userId === null || userId === undefined) return false;
    const day = sgDayNow();
    const cur = dailyStarts.get(userId);
    const n = cur && cur.day === day ? cur.n : 0;
    const max = Number(getSettings(db).translate_daily_max) || 0;
    if (max > 0 && n >= max) return true;
    dailyStarts.set(userId, { day, n: n + 1 });
    if (dailyStarts.size > 20000) for (const [k, v] of dailyStarts) if (v.day !== day) dailyStarts.delete(k);
    return false;
  }

  /**
   * 开始（或复用在途的）整卡翻译。force：失败 / 部分翻译后用户点「重试翻译」（ok 的卡只有 super 能 force，见 characters.retryTranslation）。
   * 返回 Promise（解析为最新行）；不需要翻译 / 超过每日次数时返回 null。
   */
  function start(row, { userId = null, force = false, unlimited = false } = {}) {
    if (!row) return null;
    if (inflight.has(row.id)) return inflight.get(row.id);
    const st = statusOf(row);
    if (st === 'ok' && !force) return null;
    if ((st === 'partial' || st === 'failed') && !force) return null;
    if (!cardSlotFree() && cardWaiters.length >= CARD_QUEUE_MAX) {
      cardStats.rejected_total += 1;
      console.warn(`[translate] 整卡翻译排队已满（${CARD_QUEUE_MAX}），本次不翻 ${row.chub_path}，下次打开再排`);
      return null;
    }
    if (!unlimited && overDailyLimit(userId)) {
      console.warn(`[translate] 用户 #${userId} 今天触发整卡翻译已到上限，暂不翻译 ${row.chub_path}`);
      return null;
    }
    const hash = sourceHash(row);
    history.archiveLegacy(row);
    // 已翻好（ok）还强制重翻（只有 super）：从头翻，不复用旧叶子与旧译名表
    const same = row.translate_hash === hash && !(force && st === 'ok');
    const reuse = same ? parseJson(row.card_json_zh, null) : null;
    const prevGlossary = same ? parseJson(row.glossary_json, null) : null; // 源卡变了：译名表跟着重建
    // 「翻译中」只记在内存（inflight）：库里保留上一次的结果，重试 / 重翻期间聊天仍可用旧的中文设定（源卡没变时）。
    const p = (async () => {
      await acquireCard(row.chub_path);
      try { return await runCard(); } finally { releaseCard(); }
    })().finally(() => inflight.delete(row.id));
    async function runCard() {
      const m = model({ healthy: true }); // 排完队再选模型（排队期间模型可能熔断 / 恢复）
      const def = parseJson(row.card_json, {}) || {};
      let res;
      try {
        if (!m) throw new HttpError(503, preferred() ? '翻译模型暂时不可用（熔断中）' : '翻译服务尚未配置');
        // 整卡总时限 CARD_DEADLINE_MS：到点停下，有结果落 partial（前端显示「重试翻译」，重试时复用已翻好的部分）
        res = await translateCard(row,m,userId,{ reuse, glossary: prevGlossary });
      } catch (e) {
        console.error('[translate] 角色翻译失败：', row.chub_path, e?.message || e);
        res = null;
      }
      const cur = rowById(row.id);
      if (cur && res && (res.status === 'ok' || res.status === 'partial')) {
        history.append(row, { model: m, userId, result: { ...res,
          name_zh: res.name_zh ?? (needsTranslation(row.name) ? null : row.name),
          tagline_zh: res.tagline_zh ?? (needsTranslation(row.tagline) ? null : row.tagline) } });
      }
      // 翻译期间源卡又变了：仅保留旧源历史，不更新当前共享缓存。
      if (!cur || sourceHash(cur) !== hash) return cur;
      const now = nowIso();
      if (!res) {
        // 重试失败时，同源的旧结果（partial）保留不动；否则标 failed
        if (!(cur.translate_hash === hash && cur.card_json_zh && (cur.translate_status === 'ok' || cur.translate_status === 'partial'))) {
          db.prepare("UPDATE characters SET translate_status = 'failed', translate_hash = ?, translated_at = ? WHERE id = ?").run(hash, now, row.id);
        }
        return rowById(row.id);
      }
      const greetingZh = typeof res.zh.first_message === 'string' && res.zh.first_message !== def.first_message ? res.zh.first_message : null;
      db.prepare(`UPDATE characters SET card_json_zh = ?, name_zh = ?, tagline_zh = ?, glossary_json = ?, translate_status = ?, translate_hash = ?, translated_at = ?
        ${greetingZh !== null ? ', greeting_zh = ?' : ''} WHERE id = ?`)
        .run(...[JSON.stringify(res.zh), res.name_zh ?? (needsTranslation(cur.name) ? null : cur.name), res.tagline_zh ?? (needsTranslation(cur.tagline) ? null : cur.tagline),
          JSON.stringify(res.glossary || {}), res.status, hash, now, ...(greetingZh !== null ? [greetingZh] : []), row.id]);
      if (res.status !== 'ok') console.error(`[translate] ${row.chub_path} 翻译结果 ${res.status}：${res.translated}/${res.units}，调用 ${res.calls} 次${res.stopped ? `（${res.stopped === 'deadline' ? '到了总时限' : '上游不可用'}，提前结束）` : ''}`);
      // 卡上的标签也顺手翻（全站共享译名表）
      queueTags(parseJson(cur.tags_json, []), userId);
      return rowById(row.id);
    }
    inflight.set(row.id, p);
    return p;
  }

  /** 打开详情时调用：从没翻过 / 源卡变了 / 上次在翻时进程重启 → 后台开始翻。不等结果。 */
  function kick(row, { userId = null } = {}) {
    if (row && userId !== null) {
      const user = { id: userId }, ownJob = manualJobs.get(userCharacterKey(row,user));
      if (ownJob?.status === 'pending' && ownJob.hash === sourceHash(row)) return;
      if (history.selected(row,user)) return;
    }
    const st = statusOf(row);
    if (st === 'none') start(row, { userId })?.catch(() => {});
  }

  /** 在途的整卡翻译（等它，如新建会话要用中文开场白）。 */
  const pendingOf = (row) => (row ? inflight.get(row.id) || null : null);

  /** 当前用户手动任务摘要。任务内容与供应商错误不返回给客户端。 */
  function translationJob(row, user) {
    const job = manualJobs.get(userCharacterKey(row,user));
    if (!job || job.hash !== sourceHash(row)) return { status: 'none', model_id: null, model_name: null };
    return { status: job.status, model_id: job.model_id, model_name: job.model_name, ...(job.error ? { error: job.error } : {}) };
  }
  function selectTranslation(row, user, id) {
    history.archiveLegacy(row);
    history.select(row,user,id);
    manualJobs.delete(userCharacterKey(row,user));
    return rowById(row.id) || row;
  }
  const translationHistory = (row,user,options) => ({ ...history.list(row,user,options), default_translate_model_id: preferred()?.id ?? null });

  /** 指定AI的手动整卡翻译。只保存版本与发起者选择，绝不改写全站默认缓存。 */
  function manualTranslation(row, user, { modelId = null, force = false } = {}) {
    if (!row?.id || !user?.id) throw new HttpError(400, '无法翻译这个角色');
    let selectedModel;
    if (modelId === null || modelId === undefined || modelId === '') selectedModel = preferred();
    else {
      selectedModel = requireModel(modelId);
    }
    if (!selectedModel?.enabled) throw new HttpError(400, '这个模型不可用');
    const m = { ...selectedModel }, fingerprint = translationModelFingerprint(m), hash = sourceHash(row);
    history.archiveLegacy(row);
    const cached = history.latest(row,fingerprint,m.id);
    if (!force && cached) return selectTranslation(row,user,cached.id);
    // 「重新翻译」一张同模型、同源的部分译文：只补没过的叶子与译名项（大卡从头再翻要十几分钟，又可能停在同样几段）；已完整（ok）的强制重翻仍从头来。
    const continueFrom = force && cached?.status === 'partial'
      ? { reuse: parseJson(cached.card_json_zh, null), glossary: parseJson(cached.glossary_json, null) } : {};
    const key = `${row.id}:${hash}:${m.id}:${fingerprint}`, ownerKey = userCharacterKey(row,user);
    const job = { status: 'pending', model_id: m.id, model_name: m.name, hash };
    const existing = manualInflight.get(key);
    if (existing) {
      manualJobs.set(ownerKey,job); existing.participants.set(user.id,{ user, job });
      return rowById(row.id) || row;
    }
    if (!cardSlotFree() && cardWaiters.length >= CARD_QUEUE_MAX) throw new HttpError(429, '翻译排队已满，请稍后再试');
    if (user.role !== 'super' && overDailyLimit(user.id)) throw new HttpError(429, '今天的翻译次数已到上限');
    if (tripped(m)) throw new HttpError(503, '所选翻译模型暂时不可用，请稍后再试');
    manualJobs.set(ownerKey,job);
    if (manualJobs.size > 5000) for (const [k,j] of manualJobs) if (j.status !== 'pending') { manualJobs.delete(k); if (manualJobs.size <= 5000) break; }
    const entry = { participants: new Map([[user.id,{ user,job }]]), promise: null };
    entry.promise = (async () => {
      await acquireCard(row.chub_path);
      let result = null, error = null;
      try {
        // 出队时复核配置，禁止在排队期间被管理员换成另一AI或停用后仍然调用。
        const current = m.id < 0 ? grokCli?.byId(m.id) : models.byId?.(m.id);
        if (!current?.enabled || translationModelFingerprint(current) !== fingerprint) {
          throw new HttpError(400, '所选模型已更新或停用，请重新选择');
        }
        if (tripped(current)) throw new HttpError(503, '所选翻译模型暂时不可用，请稍后再试');
        result = await translateCard(row,m,user.id,continueFrom);
        if (result.status === 'failed') error = '翻译未完成，请稍后重试';
      } catch (e) {
        // 供应商错误可能包含地址和请求内容；外部只返回固定摘要。
        error = e?.status === 400 ? '所选模型已更新或停用，请重新选择'
          : String(e?.code || '').includes('cli_quota') ? '本机 CLI 额度不足或无法确认，翻译已暂停'
          : String(e?.code || '').endsWith('cli_unavailable') ? '本机 CLI 暂时不可用，请稍后重试' : '翻译失败，请稍后重试';
        // 诊断摘要只有阶段 / 耗时 / 会话 id / 规则名 / 指针 / CLI 错误摘要，不含原文译文
        const d = e?.diag && typeof e.diag === 'object' ? e.diag : null;
        const diag = d ? ['phase', 'elapsedMs', 'sessionId', 'rule', 'ptr', 'cliError'].filter((k) => d[k] !== undefined && d[k] !== null && d[k] !== '').map((k) => `${k}=${d[k]}`).join(' ') : '';
        console.error('[translate] 手动角色翻译失败：', row.chub_path, e?.code || e?.status || 'error', ...(diag ? [diag] : []));
      } finally { releaseCard(); }
      const cur = rowById(row.id);
      if (!cur) return null;
      const item = history.append(row,{ model: m, fingerprint, result: error ? null : result, userId: user.id,
        status: error ? 'failed' : result.status, error });
      for (const { user: participant,job: intent } of entry.participants.values()) {
        if (manualJobs.get(userCharacterKey(row,participant)) !== intent) continue;
        if (!db.prepare('SELECT id FROM users WHERE id=?').get(participant.id)) {
          manualJobs.delete(userCharacterKey(row,participant)); continue;
        }
        if (sourceHash(cur) === hash && !error) history.select(cur,participant,item.id);
        intent.status = error ? 'failed' : 'none'; intent.error = error;
      }
      return cur;
    })().catch(() => {
      for (const { user: participant,job: intent } of entry.participants.values()) {
        if (manualJobs.get(userCharacterKey(row,participant)) === intent) { intent.status = 'failed'; intent.error = '翻译失败，请稍后重试'; }
      }
      return rowById(row.id);
    }).finally(() => manualInflight.delete(key));
    manualInflight.set(key,entry);
    return rowById(row.id) || row;
  }

  // ---------- 标签译名表 ----------
  function tagMap(tags) {
    const list = [...new Set((tags || []).map(String).filter(Boolean))];
    const out = new Map();
    if (!list.length) return out;
    const stmt = db.prepare('SELECT zh FROM tag_translations WHERE tag = ?');
    for (const t of list) {
      if (!needsTranslation(t)) { out.set(t, t); continue; }
      const fx = fixedTag(t);
      if (fx !== null) { out.set(t, fx); continue; }
      const r = stmt.get(t.toLowerCase());
      if (r) out.set(t, r.zh);
    }
    return out;
  }

  function queueTags(tags, userId) {
    const have = tagMap(tags);
    let added = false;
    for (const t of tags || []) {
      const s = String(t);
      if (!s || have.has(s) || tagInflight.has(s.toLowerCase()) || tagQueue.has(s.toLowerCase()) || tagQueue.size >= LIST_QUEUE_MAX || inBackoff('t:' + s.toLowerCase())) continue;
      tagQueue.set(s.toLowerCase(), { tag: s, userId });
      added = true;
    }
    if (added) schedule();
    return added;
  }

  // ---------- 列表名 / 简介 ----------
  const listRow = (p) => db.prepare('SELECT * FROM chub_list_zh WHERE path = ?').get(p);

  /** 已有的列表译文：角色已整卡翻译过就用整卡的 name_zh / tagline_zh；否则用列表译文表（原文对得上才算）。 */
  function listZh(card) {
    const c = db.prepare('SELECT name, tagline, name_zh, tagline_zh FROM characters WHERE chub_path = ?').get(card.path);
    if (c && c.name === card.name && c.tagline === card.tagline) {
      const nz = c.name_zh || (needsTranslation(card.name) ? null : card.name);
      const tz = c.tagline_zh || (needsTranslation(card.tagline) ? null : card.tagline);
      if (nz !== null && tz !== null) return { name_zh: nz, tagline_zh: tz };
    }
    const r = listRow(card.path);
    if (r && r.name === card.name && r.tagline === card.tagline && r.name_zh !== null) {
      return { name_zh: r.name_zh, tagline_zh: r.tagline_zh ?? card.tagline };
    }
    if (!needsTranslation(card.name) && !needsTranslation(card.tagline)) return { name_zh: card.name, tagline_zh: card.tagline };
    return null;
  }

  /**
   * 给 Card 列表补中文（契约 §19.2「列表也要中文」）：name_zh / tagline_zh / tags_zh；缺的标 translating:true 并排进后台批量翻译。
   * 不阻塞：接口先返回已有译文。
   */
  function localizeCards(cards, { userId = null } = {}) {
    const list = Array.isArray(cards) ? cards : [];
    const allTags = list.flatMap((c) => c.tags || []);
    const tm = tagMap(allTags);
    let queued = false;
    const out = list.map((c) => {
      const z = listZh(c);
      const tags_zh = (c.tags || []).map((t) => tm.get(String(t)) ?? String(t));
      const tagMiss = (c.tags || []).some((t) => !tm.has(String(t)) && !inBackoff('t:' + String(t).toLowerCase()));
      let pending = false;
      if (!z && c.path && !inBackoff('p:' + c.path)) {
        if (listInflight.has(c.path) || listQueue.has(c.path)) pending = true;
        else if (listQueue.size < LIST_QUEUE_MAX) { listQueue.set(c.path, { card: c, userId }); queued = true; pending = true; }
      }
      return { ...c, name_zh: z ? z.name_zh : null, tagline_zh: z ? z.tagline_zh : null, tags_zh, ...(pending || tagMiss ? { translating: true } : {}) };
    });
    if (allTags.some((t) => !tm.has(String(t))) && queueTags(allTags, userId)) queued = true;
    if (queued) schedule();
    return out;
  }

  function schedule() {
    if (listTimer) return;
    listTimer = setTimeout(() => { listTimer = null; drain().catch((e) => console.error('[translate] 列表翻译失败：', e?.message || e)); }, 50);
    listTimer.unref?.();
  }

  /** 后台：列表项每批 ≤24 项（只翻 name / tagline），标签一批。 */
  async function drain() {
    const m = model({ healthy: true });
    if (!m) {
      // 没配置模型：清掉队列；模型都熔断了：排着的项按熔断剩余时间退避（列表不再显示「翻译中」，熔断结束后再打开会重排）
      const wait = trippedFor(preferred());
      if (wait > 0) {
        for (const p of listQueue.keys()) setBackoff('p:' + p, wait);
        for (const t of tagQueue.keys()) setBackoff('t:' + t, wait);
      }
      listQueue.clear(); tagQueue.clear(); return;
    }
    const jobs = [];
    while (listQueue.size) {
      const batch = [...listQueue.entries()].slice(0, LIST_BATCH_MAX);
      for (const [p] of batch) { listQueue.delete(p); listInflight.add(p); }
      jobs.push(translateListBatch(batch.map(([, v]) => v), m).finally(() => { for (const [p] of batch) listInflight.delete(p); }));
    }
    if (tagQueue.size) {
      const batch = [...tagQueue.values()];
      tagQueue.clear();
      for (const x of batch) tagInflight.add(x.tag.toLowerCase());
      jobs.push(translateTagBatch(batch, m).finally(() => { for (const x of batch) tagInflight.delete(x.tag.toLowerCase()); }));
    }
    await Promise.allSettled(jobs);
  }

  async function translateListBatch(items, m) {
    const units = [];
    const idx = [];
    items.forEach(({ card }, i) => {
      if (needsTranslation(card.name)) { units.push({ id: `${i + 1}n`, text: card.name.trim(), short: true }); }
      if (needsTranslation(card.tagline)) { units.push({ id: `${i + 1}t`, text: card.tagline.trim(), short: true }); }
      idx.push(card);
    });
    const userId = items.find((x) => x.userId)?.userId ?? null;
    let map = new Map();
    // 上游不可用（本批熔断 / 模型熔断）：没翻出来的只退避到模型熔断结束（至少 5 分钟），别 30 分钟都显示原文
    let wait = LIST_BACKOFF_MS;
    if (units.length) {
      let stopped = null;
      try { ({ map, stopped } = await translateUnits(units, caller(userId, m), { label: '列表' })); } catch (e) {
        console.error('[translate] 列表翻译失败：', e?.message || e);
        const w = e?.tripped || isUpstreamDown(e) ? Math.max(trippedFor(m), MODEL_TRIP_MS) : LIST_BACKOFF_MS;
        for (const card of idx) setBackoff('p:' + card.path, w);
        return;
      }
      if (stopped) wait = Math.max(trippedFor(m), MODEL_TRIP_MS);
    }
    const up = db.prepare(`INSERT INTO chub_list_zh(path, name, tagline, name_zh, tagline_zh, card_snapshot, translated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET name = excluded.name, tagline = excluded.tagline, name_zh = excluded.name_zh, tagline_zh = excluded.tagline_zh,
        card_snapshot = excluded.card_snapshot, translated_at = excluded.translated_at`);
    const now = nowIso();
    idx.forEach((card, i) => {
      const nz = needsTranslation(card.name) ? map.get(`${i + 1}n`) ?? null : card.name;
      const tz = needsTranslation(card.tagline) ? map.get(`${i + 1}t`) ?? null : card.tagline;
      // 名字没翻出来：不落库（否则会把原文当译文永久缓存），过一阵再试；简介没翻出来就先存名字、简介留空（显示原文）
      if (nz === null) { setBackoff('p:' + card.path, wait); return; }
      const snap = { path: card.path, name: card.name, tagline: card.tagline, avatar: card.avatar, tags: card.tags || [], nsfw: !!card.nsfw, stars: card.stars ?? null, chats: card.chats ?? null };
      up.run(card.path, card.name || '', card.tagline || '', nz.trim(), tz === null ? null : tz.trim(), JSON.stringify(snap), now);
    });
  }

  async function translateTagBatch(list, m) {
    const units = list.map((x, i) => ({ id: String(i + 1), text: x.tag, short: true }));
    const userId = list.find((x) => x.userId)?.userId ?? null;
    let map;
    let stopped = null;
    try { ({ map, stopped } = await translateUnits(units, caller(userId, m), { systemFor: () => SYSTEM_TAGS, label: '标签' })); } catch (e) {
      console.error('[translate] 标签翻译失败：', e?.message || e);
      const w = e?.tripped || isUpstreamDown(e) ? Math.max(trippedFor(m), MODEL_TRIP_MS) : LIST_BACKOFF_MS;
      for (const u of units) setBackoff('t:' + u.text.toLowerCase(), w);
      return;
    }
    const wait = stopped ? Math.max(trippedFor(m), MODEL_TRIP_MS) : LIST_BACKOFF_MS;
    const ins = db.prepare('INSERT INTO tag_translations(tag, zh, created_at) VALUES (?, ?, ?) ON CONFLICT(tag) DO UPDATE SET zh = excluded.zh');
    const now = nowIso();
    units.forEach((u) => { const zh = map.get(u.id); if (zh) ins.run(u.text.toLowerCase(), zh.trim().slice(0, 60), now); else setBackoff('t:' + u.text.toLowerCase(), wait); });
  }

  /** 等后台列表 / 标签翻译跑完（测试用）。 */
  async function idle() {
    for (let i = 0; i < 50; i++) {
      if (listTimer) { clearTimeout(listTimer); listTimer = null; await drain(); continue; }
      if (!listInflight.size && !tagInflight.size && !inflight.size && !manualInflight.size && !listQueue.size && !tagQueue.size) return;
      await Promise.allSettled([...inflight.values(), ...[...manualInflight.values()].map(entry => entry.promise)]);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * 中文名搜索（契约 §19.2）：在本地缓存过的卡里匹配 name_zh / tagline_zh（整卡翻译的与列表译文都算）。
   * nsfw=false 时不返回成人角色。返回 Card[]（带 _zh 字段），最多 limit 个。
   */
  function searchLocal(q, { nsfw = false, limit = 24 } = {}) {
    const kw = String(q || '').trim();
    if (!kw || !/\p{Script=Han}/u.test(kw)) return [];
    const pat = `%${kw.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const out = [];
    const seen = new Set();
    const rows = db.prepare(`SELECT * FROM characters WHERE (name_zh LIKE ? ESCAPE '\\' OR tagline_zh LIKE ? ESCAPE '\\') ${nsfw ? '' : 'AND nsfw = 0'} ORDER BY id DESC LIMIT ?`).all(pat, pat, limit);
    for (const r of rows) { seen.add(r.chub_path); out.push({ row: r }); }
    if (out.length < limit) {
      const lr = db.prepare("SELECT * FROM chub_list_zh WHERE (name_zh LIKE ? ESCAPE '\\' OR tagline_zh LIKE ? ESCAPE '\\') ORDER BY translated_at DESC LIMIT ?").all(pat, pat, limit * 2);
      for (const r of lr) {
        if (seen.has(r.path) || out.length >= limit) continue;
        const snap = parseJson(r.card_snapshot, null);
        if (!snap || (!nsfw && snap.nsfw)) continue;
        seen.add(r.path);
        out.push({ snap });
      }
    }
    return out;
  }

  return { model, requireModel, complete, isTripped: tripped, noteFail, noteOk, statusOf, hasZh, zhOf, start, kick, pendingOf, tagMap, queueTags, localizeCards, searchLocal, idle, cardQueueStats,
    translationHistory, selectTranslation, manualTranslation, selectedRow: history.selectedRow, translationJob, archiveTranslation: history.archiveLegacy };
}
