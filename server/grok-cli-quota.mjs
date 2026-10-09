// Grok订阅额度只读守卫：复用现成OAuth账单GET，绝不运行CLI、续期或写入凭据。
// 只输出四个公开字段，异常详情与probe中的身份信息不向调用方透传。
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SAFE_STATUSES = new Set(['ok', 'credential_missing', 'credential_expired', 'rejected', 'unreachable', 'unsupported', 'error']);
const NO_NUDGE = async () => ({ ok: false, detail: '只读采集禁止启动CLI或续期' });
const UNKNOWN = Symbol('quota-timeout');
const publicResult = (ok, remainingPercent, status) => ({ ok, remainingPercent, collectedAt: new Date().toISOString(), status });

/** probeModule为配置路径，或测试注入的{resolveProbeDeps,createGrokProbe}；不猜账号或模块位置。 */
export function createGrokQuotaReader({ homeDir, probeModule, timeoutMs = 12000 } = {}) {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(60000, Math.max(1, Math.floor(timeoutMs))) : 12000;
  let loadedModule;
  const loadModule = () => {
    if (!loadedModule) loadedModule = typeof probeModule === 'string'
      ? import(pathToFileURL(path.resolve(probeModule)).href) : Promise.resolve(probeModule);
    return loadedModule;
  };
  return async function readQuota() {
    if (typeof homeDir !== 'string' || !homeDir.trim() || !probeModule) return publicResult(false, null, 'unsupported');
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(async () => {
          const module = await loadModule();
          if (typeof module?.resolveProbeDeps !== 'function' || typeof module?.createGrokProbe !== 'function') throw new Error('unsupported-probe');
          // 同时覆盖resolver输入及其返回值，旧probe过期分支只能得到纯拒绝stub。
          const resolved = module.resolveProbeDeps({ homeDir, timeoutMs: timeout, nudgeCli: NO_NUDGE });
          const deps = { ...resolved, homeDir, timeoutMs: timeout, nudgeCli: NO_NUDGE };
          const probe = module.createGrokProbe(deps);
          if (typeof probe?.probe !== 'function') throw new Error('unsupported-probe');
          return probe.probe();
        }),
        new Promise(resolve => { timer = setTimeout(() => resolve(UNKNOWN), timeout); }),
      ]);
      if (result === UNKNOWN) return publicResult(false, null, 'unreachable');
      const status = SAFE_STATUSES.has(result?.status) ? result.status : 'error';
      if (status !== 'ok') return publicResult(false, null, status);
      // Array.from将稀疏窗口也视为未知；不能略过无效窗口或虚构缺失窗口100%。
      const used = Array.isArray(result.windows) ? Array.from(result.windows, window => window?.usedPercent) : [];
      const complete = used.length > 0 && used.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100);
      if (!complete) return publicResult(false, null, 'unsupported');
      return publicResult(true, Math.min(...used.map(value => 100 - value)), 'ok');
    } catch {
      return publicResult(false, null, 'error');
    } finally {
      clearTimeout(timer);
    }
  };
}
