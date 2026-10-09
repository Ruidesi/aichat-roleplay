// 让 `node --test test/` 在 Node 22 下可用：Node 22 把目录参数当成一个模块去加载（即本文件），
// 这里再起一个子进程，用 node --test 跑本目录下全部 *.test.mjs，退出码原样传回。
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(__dirname, f));
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', ...files], { stdio: ['ignore', 2, 2], env, cwd: path.join(__dirname, '..') });
process.exitCode = r.status === null ? 1 : r.status;
