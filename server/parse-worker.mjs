// 文件解析 worker（契约 §17 复用 §16.1）：主线程只负责收发，正文抽取全在这里跑，超时由主线程整体终止。
import { parentPort, workerData } from 'node:worker_threads';
import { parseFiles, setSpawnHook } from './fileparse.mjs';

setSpawnHook((type, pid) => parentPort.postMessage({ type, pid }));
const files = (workerData.files || []).map((f) => ({ name: f.name, data: Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength) }));
parseFiles(files, { tmpDir: workerData.tmpDir, binDir: workerData.binDir })
  .then((result) => parentPort.postMessage({ type: 'done', result }))
  .catch((e) => parentPort.postMessage({ type: 'error', status: e?.status || null, message: e?.status ? e.message : null }));
