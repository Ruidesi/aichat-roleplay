// NAS只读FD池：Node不访问源文件系统；超时只在子进程真正回收后释放槽位。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { constants as osConstants } from 'node:os';
import { HttpError } from './util.mjs';

const LIMIT = 64 * 1024 * 1024;
const HEADER_LIMIT = 8192;
const DEFAULT_WORKER = fileURLToPath(new URL('./nas-image-reader.py', import.meta.url));
const FILE_ERRORS = new Set(['INVALID_FILE', 'ENOENT', 'ELOOP', 'ENOTDIR',
  'SHORT_READ', 'FILE_IDENTITY_CHANGED', 'DIRECTORY_IDENTITY_CHANGED', 'ROOT_IDENTITY_CHANGED']);
// 合法源OS错误可以是503；与未知/畸形协议错误分开，保持既有错误语义。
const WORKER_ERRORS = new Set([...FILE_ERRORS, ...Object.keys(osConstants.errno), 'WORKER_FAILED']);
function failure(reason) {
  const fileError = FILE_ERRORS.has(reason);
  return Object.assign(new HttpError(fileError ? 404 : 503,
    fileError ? '没有找到这张图片' : '图片库暂时不可用，请稍后重试',
    fileError ? 'image_not_found' : 'mirror_unavailable'), { reason });
}
function validFile(file) {
  return typeof file === 'string' && file.length > 0 && file.length <= 4096 && !path.isAbsolute(file)
    && !/[\x00-\x1f\x7f\\]/.test(file) && file.split('/').length <= 32
    && file.split('/').every(p => p && p !== '.' && p !== '..');
}
function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name}参数不正确`);
  return value;
}

export function createNasImageReader({ root, maxBytes = LIMIT, maxConcurrent = 4, maxPending = 32,
  timeoutMs = 15000, directoryCacheSize = 64, pythonCommand = '/usr/bin/python3', workerFile = DEFAULT_WORKER } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root || /[\x00-\x1f\x7f]/.test(root)) throw new TypeError('图片根目录不正确');
  integer(maxBytes, 12, LIMIT, '字节上限'); integer(maxConcurrent, 1, 4, '并发');
  integer(maxPending, 0, 32, '队列'); integer(timeoutMs, 1, 15000, '超时');
  integer(directoryCacheSize, 8, 64, '目录缓存');
  if (typeof pythonCommand !== 'string' || !pythonCommand || typeof workerFile !== 'string' || !path.isAbsolute(workerFile)) throw new TypeError('读取进程配置不正确');
  const workers = new Set(), queue = [];
  let closed = false, closing, nextId = 0;

  function settle(task, error, buf) {
    if (task.settled) return;
    task.settled = true;
    clearTimeout(task.timer);
    task.signal?.removeEventListener('abort', task.onAbort);
    if (error) task.reject(error); else task.resolve(buf);
  }
  function terminate(worker, reason) {
    if (worker.stopping) return;
    worker.stopping = reason;
    // 这里不移除worker，不settle active任务；close才证明SIGKILL后已回收。
    try { worker.child.kill('SIGKILL'); } catch {}
  }
  function cancel(task, reason) {
    if (task.settled) return;
    if (task.worker) terminate(task.worker, reason);
    else {
      const index = queue.indexOf(task); if (index >= 0) queue.splice(index, 1);
      settle(task, failure(reason));
    }
  }
  function complete(worker, error, buf) {
    const task = worker.task;
    worker.task = null;
    worker.header = Buffer.alloc(0); worker.body = null; worker.offset = 0;
    if (task) { task.worker = null; settle(task, error, buf); }
    pump();
  }
  function receive(worker, chunk) {
    if (worker.stopping) return;
    if (!worker.task) { terminate(worker, 'INVALID_IPC'); return; }
    // I/O回调可能在延迟的timer回调之前执行；不能把预算外响应当成功。
    if (performance.now() >= worker.task.deadline) { terminate(worker, 'TIMEOUT'); return; }
    let data = chunk;
    if (!worker.body) {
      const end = data.indexOf(10);
      const bytes = end < 0 ? data : data.subarray(0, end);
      if (worker.header.length + bytes.length > HEADER_LIMIT) { terminate(worker, 'INVALID_IPC'); return; }
      worker.header = Buffer.concat([worker.header, bytes]);
      if (end < 0) return;
      let h;
      try { h = JSON.parse(worker.header.toString('utf8')); } catch { terminate(worker, 'INVALID_IPC'); return; }
      data = data.subarray(end + 1);
      if (!h || Array.isArray(h) || h.id !== worker.task.id || typeof h.ok !== 'boolean') { terminate(worker, 'INVALID_IPC'); return; }
      if (!h.ok) {
        if (data.length || Object.keys(h).sort().join(',') !== 'code,id,ok' || !WORKER_ERRORS.has(h.code)) { terminate(worker, 'INVALID_IPC'); return; }
        complete(worker, failure(h.code)); return;
      }
      if (Object.keys(h).sort().join(',') !== 'id,length,ok' || !Number.isSafeInteger(h.length) || h.length < 12 || h.length > maxBytes) { terminate(worker, 'INVALID_IPC'); return; }
      worker.body = Buffer.allocUnsafe(h.length);
    }
    if (worker.offset + data.length > worker.body.length) { terminate(worker, 'INVALID_IPC'); return; }
    data.copy(worker.body, worker.offset); worker.offset += data.length;
    if (worker.offset === worker.body.length) complete(worker, null, worker.body);
  }
  function makeWorker(task) {
    let child;
    try {
      child = spawn(pythonCommand, ['-u', workerFile, root, String(maxBytes), String(directoryCacheSize)],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { PATH: '/usr/bin:/bin', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' } });
    } catch { settle(task, failure('WORKER_FAILED')); return null; }
    let resolveClosed;
    const worker = { child, task: null, stopping: null, header: Buffer.alloc(0), body: null, offset: 0,
      closed: new Promise(resolve => { resolveClosed = resolve; }) };
    workers.add(worker);
    child.stdout.on('data', chunk => receive(worker, chunk));
    // 丢弃诊断文本，不把本机路径或文件字节写入默认日志；异常输出同样有界。
    let stderrBytes = 0;
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > HEADER_LIMIT) terminate(worker, 'INVALID_IPC'); });
    child.stdin.on('error', () => terminate(worker, 'WORKER_FAILED'));
    child.on('error', () => terminate(worker, 'WORKER_FAILED'));
    child.once('close', () => {
      workers.delete(worker);
      if (worker.task) {
        const active = worker.task; worker.task = null; active.worker = null;
        settle(active, failure(worker.stopping || 'WORKER_FAILED'));
      }
      resolveClosed(); pump();
    });
    return worker;
  }
  function dispatch(worker, task) {
    worker.task = task; task.worker = worker;
    const request = JSON.stringify({ id: task.id, file: task.file });
    // 输入header上限以UTF-8字节计，避免多字节路径绕过协议限额。
    if (Buffer.byteLength(request) > HEADER_LIMIT) { cancel(task, 'INVALID_FILE'); return; }
    worker.child.stdin.write(request + '\n', error => { if (error) terminate(worker, 'WORKER_FAILED'); });
  }
  function pump() {
    if (closed) return;
    while (queue.length) {
      const task = queue[0];
      if (task.settled || performance.now() >= task.deadline) { queue.shift(); settle(task, failure('TIMEOUT')); continue; }
      let worker = [...workers].find(w => !w.task && !w.stopping);
      if (!worker && workers.size >= maxConcurrent) return;
      queue.shift();
      if (!worker) worker = makeWorker(task);
      if (worker) dispatch(worker, task);
    }
  }
  function read(file, { signal } = {}) {
    if (!validFile(file)) return Promise.reject(failure('INVALID_FILE'));
    if (closed) return Promise.reject(failure('CLOSED'));
    if (signal?.aborted) return Promise.reject(failure('ABORTED'));
    const canRun = [...workers].some(w => !w.task && !w.stopping) || workers.size < maxConcurrent;
    if (!canRun && queue.length >= maxPending) return Promise.reject(failure('QUEUE_FULL'));
    return new Promise((resolve, reject) => {
      const task = { id: ++nextId, file, signal, resolve, reject, settled: false, worker: null, deadline: performance.now() + timeoutMs };
      task.onAbort = () => cancel(task, 'ABORTED');
      task.timer = setTimeout(() => cancel(task, 'TIMEOUT'), timeoutMs);
      signal?.addEventListener('abort', task.onAbort, { once: true });
      queue.push(task); pump();
    });
  }
  function close() {
    if (closing) return closing;
    closed = true;
    for (const task of queue.splice(0)) settle(task, failure('CLOSED'));
    const waits = [...workers].map(worker => { terminate(worker, 'CLOSED'); return worker.closed; });
    closing = Promise.all(waits).then(() => undefined);
    return closing;
  }
  return { read, close };
}
