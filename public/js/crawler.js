// 管理 → 抓取（契约 §15）：chub 镜像抓取进度、出口池、最近事件；super 额外可开工 / 暂停 / 改配置 / 启停出口。
// 数据经 aichat 后端转发（/api/admin/crawler/*），前端拿不到控制口令。每 10 秒自动刷新，离开标签或页面即停。
import { zh } from '/i18n/zh.js';
import { get, post, put } from '/js/api.js';
import { esc, fmtInt, fmtDateTime } from '/js/util.js';
import { icon, confirmDialog, menu, toast, toastError } from '/js/ui.js';

const C = zh.admin.crawler;
const PHASES = ['list', 'card', 'avatar', 'fullimg', 'gallery-meta', 'gallery-img'];
const FILE_PHASES = new Set(['avatar', 'fullimg', 'gallery-img']);
const REFRESH_MS = 10000;
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// 记住本页的展开 / 筛选状态（切走再回来不丢）
const ui = { exitFilter: 'all', exitsOpen: false };

/* ---------- 格式化 ---------- */
function fmtGB(b) {
  const g = num(b) / 1e9;
  if (g < 10) return `${g.toFixed(2)} GB`;
  if (g < 100) return `${g.toFixed(1)} GB`;
  return `${fmtInt(Math.round(g))} GB`;
}
function fmtBytes(b) {
  b = num(b);
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} KB`;
  return `${Math.round(b)} B`;
}
function fmtRate(n) {
  n = num(n);
  return n >= 10 ? fmtInt(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '');
}
/** 剩余时长 → 中文（约 3 小时 20 分）；short=true 时 1 分钟以内显示秒数 */
function fmtDur(sec, short = false) {
  sec = Math.max(0, Math.round(num(sec)));
  if (sec < 60) return short ? C.dur_s(sec) : C.dur_lt1m;
  const m = Math.round(sec / 60);
  if (m < 60) return C.dur_m(m);
  const h = Math.floor(sec / 3600);
  if (h < 24) return C.dur_h(h, Math.round((sec - h * 3600) / 60) % 60);
  const d = Math.floor(sec / 86400);
  return C.dur_d(d, Math.floor((sec - d * 86400) / 3600));
}
/** 现在起 sec 秒后的时刻 → 10 月 3 日 14:00 */
function fmtAt(sec) {
  const t = new Date(Date.now() + num(sec) * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return C.date_time(t.getMonth() + 1, t.getDate(), p(t.getHours()), p(t.getMinutes()));
}
function fmtClock(v) {
  const t = new Date(v || Date.now());
  if (isNaN(t)) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}
const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);
const fmtPct = (p) => (p >= 99.95 || p === 0 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`);
const phaseName = (p) => C.phase_names[p] || p;
const hostName = (h) => C.hosts[h] || h;

/* ---------- 阶段 ---------- */
function phaseProgress(p, ph) {
  const db = isObj(ph.db) ? ph.db : {};
  if (p === 'list') {
    const total = num(db.windows);
    const done = num(db.windowsDone);
    const finished = ph.state === 'done' || !!db.finishedAt;
    return { pct: finished ? 100 : pct(done, total), text: total ? C.windows_of(fmtInt(done), fmtInt(total)) : '' };
  }
  const total = num(db.total);
  const pending = num(db.pending);
  const done = Math.max(0, total - pending);
  return { pct: pct(done, total), text: total ? C.done_of(fmtInt(done), fmtInt(total)) : '' };
}

function phaseHtml(p, ph, canControl) {
  const prog = phaseProgress(p, ph);
  // 抓取器对跑完后没再开工的阶段报 idle：进度已满时按「已完成」显示
  let st = String(ph.state || 'idle');
  if (st === 'idle' && prog.pct >= 100) st = 'done';
  const counts = isObj(ph.db) && isObj(ph.db.counts) ? ph.db.counts : {};
  const r1 = isObj(ph.rate1m) ? ph.rate1m : {};
  const r10 = isObj(ph.rate10m) ? ph.rate10m : {};
  const perSec = num(r1.perSec) || num(r10.perSec);
  const bps = num(r1.bytesPerSec) || num(r10.bytesPerSec);
  const meta = [];
  if (prog.text) meta.push(prog.text);
  if (st === 'running') {
    meta.push(C.rate(fmtRate(perSec)));
    if (FILE_PHASES.has(p) && bps > 0) meta.push(C.rate_bytes(fmtBytes(bps)));
    if (ph.etaSec != null && num(ph.etaSec) > 0) meta.push(`${C.eta(fmtDur(ph.etaSec))}（${C.eta_at(fmtAt(ph.etaSec))}）`);
  }
  const notes = [];
  if (FILE_PHASES.has(p) && ph.etaKind === 'download') {
    if (num(counts.spooled)) notes.push(C.spooled_n(fmtInt(counts.spooled)));
    notes.push(C.nas_ok_n(fmtInt(counts.ok)));
    const nr = isObj(ph.nasRate1m) ? ph.nasRate1m : {};
    if (num(nr.perSec) || num(nr.bytesPerSec)) notes.push(C.nas_rate(fmtRate(nr.perSec), num(nr.bytesPerSec) ? fmtBytes(nr.bytesPerSec) : ''));
  }
  if (num(counts.failed)) notes.push(C.failed_n(fmtInt(counts.failed)));
  if (num(counts.gone)) notes.push(C.gone_n(fmtInt(counts.gone)));
  if (st === 'running' && num(ph.workers)) notes.push(C.workers(fmtInt(ph.workers)));
  const name = phaseName(p);
  let btn = '';
  if (canControl) {
    btn = st === 'running'
      ? `<button class="btn btn-sm" type="button" data-act="phase" data-phase="${esc(p)}" data-do="pause">${esc(C.pause)}</button>`
      : `<button class="btn btn-sm btn-primary" type="button" data-act="phase" data-phase="${esc(p)}" data-do="start">${icon('play')}<span>${esc(C.start)}</span></button>`;
  }
  return `<div class="cr-phase">
    <div class="cr-phase-head">
      <b>${esc(name)}</b><span class="badge cr-st cr-st-${esc(st)}">${esc(st === 'done' && ph.etaKind === 'download' ? C.download_done : C.states[st] || st)}</span>
      <span class="cr-pct">${esc(fmtPct(prog.pct))}</span>
    </div>
    <div class="cr-progress" role="progressbar" aria-label="${esc(name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(prog.pct)}"><i style="width:${prog.pct.toFixed(2)}%"></i></div>
    <div class="cr-phase-foot">
      <div class="cr-phase-meta">
        ${meta.length ? `<div>${esc(meta.join(' · '))}</div>` : ''}
        ${notes.length ? `<div class="muted">${esc(notes.join(' · '))}</div>` : ''}
        ${ph.nasPaused ? `<div class="cr-warn">${esc(C.nas_paused)}</div>` : ''}
        ${ph.error ? `<div class="cr-warn">${esc(String(ph.error).slice(0, 200))}</div>` : ''}
      </div>
      ${btn}
    </div>
  </div>`;
}

/* ---------- 出口 ---------- */
function exitRegion(x) {
  if (x.id === 'direct' || x.kind === 'direct') return C.direct;
  let n = String(x.name || '').split(/[|｜]/)[0];
  n = n.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '').replace(/[\d\s_-]+$/, '').trim();
  return n || String(x.id);
}
function exitState(x) {
  const hosts = isObj(x.hosts) ? Object.values(x.hosts).filter(isObj) : [];
  const cooling = hosts.filter((h) => h.cooling);
  if (x.gone) return { k: 'off', text: C.st_gone };
  if (x.manualDisabled) return { k: 'off', text: C.st_disabled };
  if (x.removed) return { k: 'warn', text: C.st_removed(fmtDur(x.removedLeftSec, true)) };
  if (num(x.refusedLeftSec) > 0) return { k: 'warn', text: C.st_refused(fmtDur(x.refusedLeftSec, true)) };
  if (cooling.length) return { k: 'warn', text: C.st_cooling(fmtDur(Math.max(...cooling.map((h) => num(h.cooldownLeftSec))), true)) };
  if (!x.usable) return { k: x.id === 'direct' ? 'off' : 'bad', text: x.why ? `${C.st_bad}：${x.why}` : C.st_bad };
  return { k: 'ok', text: C.st_ok };
}
function exitLabel(x) {
  const r = exitRegion(x);
  return x.id === 'direct' ? r : `${r} · ${C.port(x.id)}`;
}
function exitHtml(x, canControl) {
  const s = exitState(x);
  const stats = isObj(x.stats) ? x.stats : {};
  const ok = num(stats.ok);
  const total = ok + num(stats.fail);
  const rate = total ? C.success(fmtPct(pct(ok, total))) : C.success_none;
  const sub = [x.id === 'direct' ? '' : C.port(x.id), x.ratio != null ? C.ratio(x.ratio) : ''].filter(Boolean).join(' · ');
  let btn = '';
  if (canControl && !x.gone) {
    btn = x.manualDisabled
      ? `<button class="btn btn-sm" type="button" data-act="exit" data-id="${esc(x.id)}" data-do="enable">${esc(C.enable)}</button>`
      : `<button class="btn btn-sm btn-danger" type="button" data-act="exit" data-id="${esc(x.id)}" data-do="disable">${esc(C.disable)}</button>`;
  }
  return `<div class="cr-exit">
    <span class="status-dot cr-dot-${s.k}" aria-hidden="true"></span>
    <div class="cr-exit-main">
      <div class="cr-exit-title" title="${esc(x.name || '')}"><b>${esc(exitRegion(x))}</b>${sub ? `<span class="muted small"> · ${esc(sub)}</span>` : ''}</div>
      <div class="cr-exit-sub"><span class="cr-k-${s.k}">${esc(s.text)}</span> · ${esc(rate)}</div>
    </div>
    ${btn}
  </div>`;
}

/* ---------- 事件 ---------- */
function eventHtml(ev) {
  const d = isObj(ev.detail) ? ev.detail : {};
  const extra = [];
  if (ev.host) extra.push(hostName(ev.host));
  const ex = d.port ?? d.exit ?? d.id;
  if (ex != null && (typeof ex === 'string' || typeof ex === 'number')) extra.push(C.event_exit(ex));
  if (typeof d.phase === 'string') extra.push(phaseName(d.phase));
  const wait = d.waitSec ?? d.waitedSec ?? d.waited_sec;
  if (wait != null && Number.isFinite(Number(wait))) extra.push(C.event_wait(fmtDur(wait, true)));
  const msg = ev.kind === 'phase_error' && typeof (d.error ?? d.message) === 'string' ? String(d.error ?? d.message).slice(0, 120) : '';
  return `<div class="cr-event">
    <span class="cr-event-at">${esc(fmtDateTime(ev.at))}</span>
    <span class="cr-event-main"><b>${esc(C.event_kinds[ev.kind] || ev.kind || '')}</b>${extra.length ? `<span class="muted"> · ${esc(extra.join(' · '))}</span>` : ''}${msg ? `<span class="cr-event-msg">${esc(msg)}</span>` : ''}</span>
  </div>`;
}

/* ---------- 配置表单 ---------- */
const CFG_FIELDS = [
  { g: 'exit', k: 'per_exit_rps', t: 'num' },
  { g: 'exit', k: 'per_exit_concurrency', t: 'int' },
  { g: 'exit', k: 'use_direct', t: 'bool' },
  { g: 'exit', k: 'prefer_cheap', t: 'bool' },
  { g: 'exit', k: 'cheap_only', t: 'bool' },
  { g: 'exit', k: 'group_by_ip', t: 'bool' },
  { g: 'global', k: 'global_max_concurrency', t: 'int' },
  { g: 'global', k: 'global_max_rps', t: 'num' },
  { g: 'cooldown', k: 'cooldown_base_ms', t: 'num', scale: 1000 },
  { g: 'cooldown', k: 'cooldown_max_ms', t: 'num', scale: 1000 },
  { g: 'cooldown', k: 'remove_after', t: 'int' },
  { g: 'cooldown', k: 'remove_ms', t: 'num', scale: 60000 },
  { g: 'file', k: 'file_concurrency', t: 'int' },
  { g: 'file', k: 'write_queue_max_mb', t: 'int' },
  { g: 'spool', k: 'file_spool_enabled', t: 'bool' },
  { g: 'spool', k: 'spool_max_gb', t: 'num', min: 1, max: 10000 },
  { g: 'spool', k: 'spool_reserve_gb', t: 'num', min: 0, max: 10000 },
  { g: 'spool', k: 'spool_drain_paused', t: 'bool' },
];
const shown = (f, v) => (f.t === 'bool' ? !!v : f.scale ? Math.round((num(v) / f.scale) * 1000) / 1000 : num(v));

function configFormHtml(cfg) {
  const groups = ['exit', 'global', 'cooldown', 'file', 'spool'];
  const fieldHtml = (f) => {
    const v = cfg[f.k];
    const id = `cr-cfg-${f.k}`;
    if (f.t === 'bool') {
      return `<label class="cr-cfg-bool" for="${id}"><span>${esc(C.cfg[f.k])}</span><span class="switch"><input id="${id}" type="checkbox" role="switch" data-cfg="${esc(f.k)}"${v ? ' checked' : ''}><span></span></span></label>`;
    }
    return `<div class="field"><label for="${id}">${esc(C.cfg[f.k])}</label><input id="${id}" class="input" type="number" inputmode="decimal" min="${f.min ?? 0}"${f.max != null ? ` max="${f.max}"` : ''} step="${f.t === 'int' ? '1' : 'any'}" data-cfg="${esc(f.k)}" value="${esc(shown(f, v))}"></div>`;
  };
  const workers = isObj(cfg.phase_max_workers) ? cfg.phase_max_workers : null;
  return `<form class="panel panel-pad cr-config" novalidate>
    <div class="cr-sec-title">${esc(C.config_title)}</div>
    <p class="muted small">${esc(C.config_lead)}</p>
    ${groups.map((g) => {
      const fs = CFG_FIELDS.filter((f) => f.g === g && cfg[f.k] !== undefined);
      return fs.length ? `<fieldset class="cr-cfg-group"><legend>${esc(C.config_groups[g])}</legend><div class="cr-cfg-grid">${fs.map(fieldHtml).join('')}</div></fieldset>` : '';
    }).join('')}
    ${workers ? `<fieldset class="cr-cfg-group"><legend>${esc(C.config_groups.workers)}</legend><div class="cr-cfg-grid">${PHASES.filter((p) => workers[p] !== undefined).map((p) => `<div class="field"><label for="cr-w-${esc(p)}">${esc(phaseName(p))}</label><input id="cr-w-${esc(p)}" class="input" type="number" inputmode="numeric" min="0" step="1" data-worker="${esc(p)}" value="${esc(num(workers[p]))}"></div>`).join('')}</div></fieldset>` : ''}
    <div class="form-error" role="alert"></div>
    <div class="cr-cfg-actions">
      <button class="btn btn-sm" type="button" data-cfg-reset>${esc(C.config_reset)}</button>
      <button class="btn btn-sm btn-primary" type="submit">${esc(C.config_save)}</button>
    </div>
  </form>`;
}

/** 收集表单里改动过的项 → {patch, lines}；有非法值时返回 {error} */
function collectConfig(form, cfg) {
  const patch = {};
  const lines = [];
  const show = (f, v) => (f.t === 'bool' ? (v ? C.on : C.off) : String(v));
  for (const f of CFG_FIELDS) {
    if (cfg[f.k] === undefined) continue;
    const inp = form.querySelector(`[data-cfg="${f.k}"]`);
    if (!inp) continue;
    const before = shown(f, cfg[f.k]);
    let after;
    if (f.t === 'bool') after = !!inp.checked;
    else {
      const raw = inp.value.trim();
      after = raw === '' ? NaN : Number(raw);
      if (!Number.isFinite(after) || after < 0 || (f.t === 'int' && !Number.isInteger(after))) return { error: C.config_invalid(C.cfg[f.k]), input: inp };
      if ((f.min != null && after < f.min) || (f.max != null && after > f.max)) return { error: C.config_range(C.cfg[f.k], f.min, f.max), input: inp };
    }
    if (after === before) continue;
    patch[f.k] = f.scale ? Math.round(after * f.scale) : after;
    lines.push(`${C.cfg[f.k]}：${show(f, before)} → ${show(f, after)}`);
  }
  const workers = isObj(cfg.phase_max_workers) ? cfg.phase_max_workers : {};
  for (const inp of form.querySelectorAll('[data-worker]')) {
    const p = inp.dataset.worker;
    const raw = inp.value.trim();
    const after = raw === '' ? NaN : Number(raw);
    const label = `${C.config_groups.workers} · ${phaseName(p)}`;
    if (!Number.isInteger(after) || after < 0) return { error: C.config_invalid(label), input: inp };
    if (after === num(workers[p])) continue;
    (patch.phase_max_workers ||= {})[p] = after;
    lines.push(`${label}：${num(workers[p])} → ${after}`);
  }
  return { patch, lines };
}

/* ---------- 主视图 ---------- */
/**
 * body：标签内容容器；ctx：路由上下文；
 * isCurrent()：本标签是否仍是当前显示的标签；setStop(fn)：登记「离开本标签」时的清理（停定时器）。
 */
export async function crawlerTab(body, ctx, { isCurrent = () => ctx.isActive(), setStop = () => {} } = {}) {
  let status = null; // GET /api/admin/crawler/status 的响应
  let exits = null; // GET /api/admin/crawler/exits 的响应（失败为 null）
  let loading = false;
  let busy = false;
  let alive = true;
  let configFor = null; // 当前表单基于的配置对象（null = 还没画）

  async function fetchAll() {
    const [s, e] = await Promise.all([
      get('/api/admin/crawler/status'),
      get('/api/admin/crawler/exits').catch(() => null),
    ]);
    status = s || {};
    exits = e && e.online && isObj(e.data) ? e : null;
  }

  body.innerHTML = `
    <p class="muted small cr-lead"></p>
    <div class="cr-top"><span class="muted small" data-upd aria-live="off"></span><button class="btn btn-sm" type="button" data-refresh>${icon('refresh')}<span>${esc(C.refresh)}</span></button></div>
    <div data-main></div>
    <div data-config></div>`;
  const leadEl = body.querySelector('.cr-lead');
  const updEl = body.querySelector('[data-upd]');
  const mainEl = body.querySelector('[data-main]');
  const cfgEl = body.querySelector('[data-config]');
  const refreshBtn = body.querySelector('[data-refresh]');

  // 首次加载失败（无权限 / 断网）交给 admin 的错误页 +「重试」
  try {
    await fetchAll();
  } catch (e) {
    if (!isCurrent()) return; // 已切走：不把错误页画到别的标签上
    throw e;
  }
  if (!isCurrent() || !alive) return;

  function render() {
    const s = status || {};
    const canControl = s.can_control === true;
    leadEl.textContent = canControl ? C.lead : `${C.lead}${C.lead_view}`;
    updEl.textContent = s.fetched_at ? C.updated(fmtClock(s.fetched_at)) : '';
    if (!s.online) {
      mainEl.innerHTML = `<div class="panel"><div class="empty cr-offline">${icon('alert')}<div class="empty-title">${esc(s.message || C.offline_title)}</div><p>${esc(C.offline_hint)}</p></div></div>`;
      cfgEl.innerHTML = '';
      configFor = null;
      return;
    }
    const d = isObj(s.data) ? s.data : {};
    const phases = isObj(d.phases) ? d.phases : {};
    const storage = isObj(d.storage) ? d.storage : {};
    const ex = exits ? exits.data : {};
    const pool = isObj(ex.pool) ? ex.pool : isObj(d.pool) ? d.pool : {};
    const hosts = isObj(ex.hosts) ? ex.hosts : isObj(d.hosts) ? d.hosts : {};
    const exitList = Array.isArray(ex.exits) ? ex.exits : Array.isArray(d.exits) ? d.exits : [];

    // 总览
    const listDb = isObj(phases.list) && isObj(phases.list.db) ? phases.list.db : {};
    const cardDb = isObj(phases.card) && isObj(phases.card.db) ? phases.card.db : {};
    const totalChars = num(listDb.chars) || num(cardDb.total);
    const etas = PHASES.map((p) => phases[p]).filter((ph) => isObj(ph) && ph.state === 'running' && num(ph.etaSec) > 0).map((ph) => num(ph.etaSec));
    const eta = etas.length ? Math.max(...etas) : 0;
    const nas = isObj(storage.nas) ? storage.nas : {};
    const written = isObj(storage.written) ? storage.written : {};
    const writtenSum = num(written.avatar) + num(written.fullimg) + num(written.gallery);
    const nw = isObj(storage.nasWrite) ? storage.nasWrite : {};
    const spool = isObj(storage.spool) ? storage.spool : null;
    const downloadEta = !!spool?.enabled || PHASES.some((p) => phases[p]?.etaKind === 'download');
    const dbBytes = isObj(storage.db) ? storage.db.bytes : null;
    const vol = isObj(storage.volume) ? storage.volume : {};
    const stat = (label, value, ...subs) => `<div class="cr-stat"><div class="cr-stat-label">${esc(label)}</div><div class="cr-stat-value">${esc(value)}</div>${subs.filter(Boolean).map((x) => `<div class="cr-stat-sub">${esc(x)}</div>`).join('')}</div>`;
    const overview = `<section class="panel panel-pad">
      <div class="cr-sec-title">${esc(C.overview)}</div>
      <div class="cr-stats">
        ${stat(C.total_chars, totalChars ? fmtInt(totalChars) : '—')}
        ${stat(downloadEta ? C.download_eta : C.overall_eta, eta ? fmtDur(eta) : C.eta_none, eta ? C.eta_at(fmtAt(eta)) : '', d.running ? [C.running, d.uptimeSec != null ? C.uptime(fmtDur(d.uptimeSec)) : ''].filter(Boolean).join(' · ') : C.stopped)}
        ${stat(C.exits_usable, pool.total != null ? `${fmtInt(pool.usable)} / ${fmtInt(pool.total)}` : '—', pool.groups != null ? C.pool_groups(fmtInt(pool.groups)) : '')}
        ${stat(C.written, writtenSum ? fmtGB(writtenSum) : '—', C.written_detail(fmtGB(written.avatar), fmtGB(written.fullimg), fmtGB(written.gallery)), nas.ready === false ? C.nas2_down : (nas.freeBytes != null ? `nas2 ${C.nas2_free(fmtGB(nas.freeBytes))}` : ''), num(nw.pendingFiles) ? C.write_queue(fmtInt(nw.pendingFiles), fmtBytes(nw.pendingBytes)) : '')}
        ${stat(C.db_size, dbBytes != null ? fmtGB(dbBytes) : '—', vol.freeBytes != null ? C.disk_free(fmtGB(vol.freeBytes)) : '')}
        ${spool ? stat(C.spool_title, C.spool_usage(fmtGB(spool.usedBytes), fmtGB(spool.maxBytes)),
          spool.enabled ? C.spool_enabled : C.spool_disabled,
          C.spool_pending(fmtInt(spool.pendingFiles), fmtBytes(spool.pendingBytes)),
          spool.freeBytes != null ? C.spool_free(fmtGB(spool.freeBytes), fmtGB(spool.reserveBytes)) : '',
          spool.waitReason ? C.spool_wait_reasons[spool.waitReason] || String(spool.waitReason) : num(spool.waitingN) ? C.spool_wait : '') : ''}
        ${spool ? stat(C.spool_drain, C.nas_rate(fmtRate(spool.rate1m?.perSec), num(spool.rate1m?.bytesPerSec) ? fmtBytes(spool.rate1m.bytesPerSec) : ''),
          spool.drainPaused ? (spool.enabled ? C.spool_drain_paused : C.spool_drain_paused_only) : C.spool_drain_active(fmtInt(spool.active), fmtInt(spool.concurrency)),
          !spool.drainPaused && spool.etaSec != null && num(spool.pendingFiles) ? C.spool_queue_eta(fmtDur(spool.etaSec)) : '') : ''}
      </div>
    </section>`;

    // 各阶段
    const phaseList = PHASES.filter((p) => isObj(phases[p]));
    const controls = canControl ? `<div class="cr-actions">
        <button class="btn btn-sm" type="button" data-act="all" data-do="pause-all">${esc(C.pause_all)}</button>
        <button class="btn btn-sm" type="button" data-act="all" data-do="resume-all">${esc(C.resume_all)}</button>
      </div>` : '';
    const phasesHtml = `<section class="panel panel-pad">
      <div class="cr-sec-head"><div class="cr-sec-title">${esc(C.phases_title)}</div>${controls}</div>
      ${phaseList.map((p) => phaseHtml(p, phases[p], canControl)).join('')}
    </section>`;

    // 出口池
    const states = exitList.map((x) => ({ x, s: exitState(x) }));
    const bad = states.filter((o) => o.s.k !== 'ok');
    const filtered = ui.exitFilter === 'bad' ? bad : states;
    const poolChips = [
      pool.cheap != null ? C.pool_cheap(fmtInt(pool.cheap)) : '',
      num(pool.unhealthy) ? C.pool_unhealthy(fmtInt(pool.unhealthy)) : '',
      num(pool.removed) ? C.pool_removed(fmtInt(pool.removed)) : '',
      num(pool.manualDisabled) ? C.pool_disabled(fmtInt(pool.manualDisabled)) : '',
      pool.direct != null ? (pool.direct ? C.pool_direct_on : C.pool_direct_off) : '',
    ].filter(Boolean);
    const poolHtml = `<section class="panel panel-pad">
      <div class="cr-sec-title">${esc(C.pool_title)}</div>
      ${pool.total != null ? `<p class="cr-line">${esc(C.pool_summary(fmtInt(pool.usable), fmtInt(pool.total), fmtInt(pool.groups)))}</p>` : ''}
      ${poolChips.length ? `<p class="muted small cr-line">${esc(poolChips.join(' · '))}</p>` : ''}
      ${pool.proxyDown ? `<p class="cr-warn">${esc(C.proxy_down)}</p>` : ''}
      <div class="cr-hosts">${Object.entries(hosts).filter(([, h]) => isObj(h)).map(([k, h]) => `<div class="cr-host">
        <b>${esc(hostName(k))}</b>
        <span class="muted small">${esc(C.host_line(fmtInt(h.usable), fmtInt(h.cooling), fmtInt(h.active), fmtInt(h.waiting)))}</span>
        ${h.blocked ? `<span class="cr-warn">${esc(C.host_blocked)}</span>` : ''}
      </div>`).join('')}</div>
      ${exitList.length ? `<details class="cr-exits" data-exits${ui.exitsOpen ? ' open' : ''}>
        <summary>${esc(C.exits_title)}（${fmtInt(exitList.length)}）</summary>
        <div class="chips cr-filter" role="group" aria-label="${esc(C.exits_title)}">
          <button class="chip sm${ui.exitFilter === 'all' ? ' active' : ''}" type="button" data-xf="all" aria-pressed="${ui.exitFilter === 'all'}">${esc(C.filter_all)} ${fmtInt(states.length)}</button>
          <button class="chip sm${ui.exitFilter === 'bad' ? ' active' : ''}" type="button" data-xf="bad" aria-pressed="${ui.exitFilter === 'bad'}">${esc(C.filter_bad)} ${fmtInt(bad.length)}</button>
        </div>
        ${filtered.length ? `<div class="cr-exit-list">${filtered.map((o) => exitHtml(o.x, canControl)).join('')}</div>` : `<p class="muted small">${esc(C.filter_empty)}</p>`}
      </details>` : ''}
    </section>`;

    // 最近事件
    const events = (Array.isArray(d.events) ? d.events.filter(isObj) : []).slice().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    const eventsHtml = `<section class="panel panel-pad">
      <div class="cr-sec-title">${esc(C.events_title)}</div>
      ${events.length ? `<div class="cr-events">${events.map(eventHtml).join('')}</div>` : `<p class="muted small">${esc(C.events_empty)}</p>`}
    </section>`;

    mainEl.innerHTML = overview + phasesHtml + poolHtml + eventsHtml;
    const det = mainEl.querySelector('[data-exits]');
    if (det) det.addEventListener('toggle', () => { ui.exitsOpen = det.open; });

    // 配置表单只在第一次（或保存 / 还原后）画，自动刷新不冲掉正在编辑的内容
    if (canControl && isObj(d.config)) {
      if (!configFor) drawConfig(d.config);
    } else {
      cfgEl.innerHTML = '';
      configFor = null;
    }
  }

  function drawConfig(cfg) {
    configFor = cfg;
    cfgEl.innerHTML = configFormHtml(cfg);
    const form = cfgEl.querySelector('form');
    const err = form.querySelector('.form-error');
    form.querySelector('[data-cfg-reset]').onclick = () => {
      const latest = status && status.data && isObj(status.data.config) ? status.data.config : cfg;
      drawConfig(latest);
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      form.querySelectorAll('[aria-invalid]').forEach((x) => x.removeAttribute('aria-invalid'));
      const r = collectConfig(form, configFor);
      if (r.error) {
        err.textContent = r.error;
        r.input.setAttribute('aria-invalid', 'true');
        r.input.focus();
        return;
      }
      if (!r.lines.length) { toast(C.config_nochange); return; }
      if (!await confirmDialog(C.confirm_config(r.lines.join('\n')), { title: C.config_title, ok: C.config_save })) return;
      const ok = await write(() => put('/api/admin/crawler/config', r.patch), C.config_saved);
      if (ok && isCurrent() && alive) {
        const latest = status && status.data && isObj(status.data.config) ? status.data.config : null;
        if (latest) drawConfig(latest);
      }
    });
  }

  async function refresh({ quiet = false } = {}) {
    if (loading || !alive) return;
    loading = true;
    if (!quiet) { refreshBtn.disabled = true; updEl.textContent = C.refreshing; }
    try {
      await fetchAll();
      if (!isCurrent() || !alive) return;
      render();
    } catch (e) {
      if (!isCurrent() || !alive) return;
      updEl.textContent = C.refresh_failed;
      if (!quiet) toastError(e);
    } finally {
      loading = false;
      refreshBtn.disabled = false;
    }
  }

  /** 写操作：成功提示 + 立即刷新；失败显示后端的中文说明。返回是否成功。 */
  async function write(fn, okMsg) {
    if (busy) return false;
    busy = true;
    try {
      await fn();
      toast(okMsg);
      await refresh({ quiet: true });
      return true;
    } catch (e) {
      toastError(e);
      return false;
    } finally { busy = false; }
  }

  async function onAction(b) {
    const act = b.dataset.act;
    const what = b.dataset.do;
    if (act === 'phase') {
      const p = b.dataset.phase;
      const name = phaseName(p);
      const start = what === 'start';
      if (!await confirmDialog(start ? C.confirm_start(name) : C.confirm_pause(name), { title: C.confirm_title, ok: start ? C.start : C.pause, danger: !start })) return;
      await write(() => post(`/api/admin/crawler/phase/${encodeURIComponent(p)}/${start ? 'start' : 'pause'}`, {}), start ? C.done_start : C.done_pause);
    } else if (act === 'all') {
      const pause = what === 'pause-all';
      if (!await confirmDialog(pause ? C.confirm_pause_all : C.confirm_resume_all, { title: C.confirm_title, ok: pause ? C.pause_all : C.resume_all, danger: pause })) return;
      await write(() => post(`/api/admin/crawler/${pause ? 'pause-all' : 'resume-all'}`, {}), pause ? C.done_pause_all : C.done_resume_all);
    } else if (act === 'exit') {
      const id = b.dataset.id;
      const list = (exits && Array.isArray(exits.data.exits) ? exits.data.exits : (status && status.data && Array.isArray(status.data.exits) ? status.data.exits : []));
      const x = list.find((e) => String(e.id) === id) || { id };
      const label = exitLabel(x);
      const url = `/api/admin/crawler/exits/${encodeURIComponent(id)}/${what === 'enable' ? 'enable' : 'disable'}`;
      if (what === 'disable') {
        if (!await confirmDialog(C.confirm_disable(label), { title: C.confirm_title, ok: C.disable, danger: true })) return;
        await write(() => post(url, {}), C.done_disable);
      } else {
        const mode = await menu([
          { label: C.enable_only, value: 'one' },
          { label: C.enable_group, value: 'group' },
        ], { title: label });
        if (!mode) return;
        const group = mode === 'group';
        if (!await confirmDialog(group ? C.confirm_enable_group(label) : C.confirm_enable(label), { title: C.confirm_title, ok: C.enable })) return;
        await write(() => post(url, group ? { reset_group: true } : {}), C.done_enable);
      }
    }
  }

  body.onclick = (e) => {
    if (e.target.closest('[data-refresh]')) { refresh(); return; }
    const xf = e.target.closest('[data-xf]');
    if (xf) { ui.exitFilter = xf.dataset.xf === 'bad' ? 'bad' : 'all'; render(); return; }
    const b = e.target.closest('[data-act]');
    if (b && !busy) onAction(b);
  };

  render();

  // 每 10 秒自动刷新；页面在后台、正在执行操作时跳过这一拍
  const timer = setInterval(() => {
    if (!alive) return;
    if (!isCurrent()) { stop(); return; }
    if (document.hidden || busy) return;
    refresh({ quiet: true });
  }, REFRESH_MS);
  function stop() { alive = false; clearInterval(timer); }
  setStop(stop);
}
