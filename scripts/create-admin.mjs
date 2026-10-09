#!/usr/bin/env node
// 命令行建 / 重置超级管理员或管理员（契约 §9.2）。
// 用法：DATA_DIR=./data node scripts/create-admin.mjs <用户名> [--role super|admin] [--display 显示名]
//   --role 默认 super。超级管理员只能用这个脚本创建。
//   密码从环境变量 ADMIN_PASSWORD 读；没给就在终端里提示输入（不回显）。
import { loadConfig } from '../server/config.mjs';
import { openDb, countActiveSupers } from '../server/db.mjs';
import { hashPassword, destroyUserSessions, USERNAME_RE } from '../server/auth.mjs';
import { nowIso } from '../server/util.mjs';
import { writeLog } from '../server/logs.mjs';

function usage(msg) {
  if (msg) console.error(msg);
  console.error('用法：node scripts/create-admin.mjs <用户名> [--role super|admin] [--display 显示名]（--role 默认 super；密码走环境变量 ADMIN_PASSWORD 或交互输入）');
  process.exit(1);
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c) => { data += c; });
      stdin.on('end', () => resolve(data.split(/\r?\n/)[0] || ''));
      return;
    }
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let pw = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); resolve(pw);
      } else if (ch === '\u0003') { stdout.write('\n'); process.exit(130); }
      else if (ch === '\u007f' || ch === '\b') pw = pw.slice(0, -1);
      else pw += ch;
    };
    stdin.on('data', onData);
  });
}

const args = process.argv.slice(2);
const username = args[0];
if (!username || username.startsWith('-')) usage();
if (!USERNAME_RE.test(username)) usage('用户名只能用字母、数字、下划线、点或横线，2–32 位');
function flag(name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) usage(`${name} 后面要跟值`);
  return v;
}
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--role' || args[i] === '--display') { i++; continue; }
  usage(`不认识的参数：${args[i]}`);
}
const display = flag('--display') || '';
const role = flag('--role') ?? 'super';
if (role !== 'super' && role !== 'admin') usage('--role 只能是 super 或 admin');
const ROLE_ZH = { super: '超级管理员', admin: '管理员' };

let password = process.env.ADMIN_PASSWORD || '';
if (!password) password = await promptHidden('新密码（至少 8 位）：');
if (password.length < 8) usage('密码至少 8 位');

const config = loadConfig();
const db = openDb(config.dbFile);
const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
if (u) {
  // 保证至少一个启用的 super：不能把最后一个启用的超级管理员降成管理员。
  if (u.role === 'super' && role !== 'super' && !u.disabled && countActiveSupers(db) <= 1) {
    db.close();
    usage(`${u.username} 是最后一个启用的超级管理员，不能降为管理员`);
  }
  // 运维脚本：对已软删的账号等同恢复（清 deleted_at）。
  db.prepare('UPDATE users SET password_hash = ?, role = ?, is_admin = 1, disabled = 0, deleted_at = NULL, must_change_password = 0' + (display ? ', display_name = ?' : '') + ' WHERE id = ?')
    .run(...[hashPassword(password), role, ...(display ? [display] : []), u.id]);
  destroyUserSessions(db, u.id);
  const roleZh = (r) => ({ super: '超级管理员', admin: '管理员', tenant: '租户' })[r] || r;
  const changes = [{ field: 'password', label: '密码', from: null, to: '已重置' }];
  if (u.role !== role) changes.push({ field: 'role', label: '角色', from: roleZh(u.role), to: roleZh(role) });
  if (display && display !== u.display_name) changes.push({ field: 'display_name', label: '显示名', from: u.display_name, to: display });
  writeLog(db, { level: 'warn', kind: 'user.update', actor_name: '命令行脚本', target_type: 'user', target_id: u.id,
    summary: `命令行重置${ROLE_ZH[role]} ${u.username}`, detail: { username: u.username, changes } });
  if (u.deleted_at) writeLog(db, { level: 'warn', kind: 'user.update', actor_name: '命令行脚本', target_type: 'user', target_id: u.id, summary: `命令行恢复已删除的账号 ${u.username}`, detail: { username: u.username, changes: [{ field: 'deleted', label: '已删除', from: '是', to: '否' }] } });
  if (u.disabled) writeLog(db, { kind: 'user.enable', actor_name: '命令行脚本', target_type: 'user', target_id: u.id, summary: `命令行启用账号 ${u.username}`, detail: { username: u.username, role } });
  console.log(`已重置${ROLE_ZH[role]} ${u.username} 的密码（旧登录已全部失效）。数据目录：${config.dataDir}`);
} else {
  const r = db.prepare('INSERT INTO users(username, password_hash, display_name, is_admin, role, created_at) VALUES (?, ?, ?, 1, ?, ?)')
    .run(username, hashPassword(password), display || username, role, nowIso());
  writeLog(db, { kind: 'user.create', actor_name: '命令行脚本', target_type: 'user', target_id: Number(r.lastInsertRowid),
    summary: `命令行创建${ROLE_ZH[role]}账号 ${username}`, detail: { username, display_name: display || username, role, role_name: ROLE_ZH[role] } });
  console.log(`已创建${ROLE_ZH[role]} ${username}。数据目录：${config.dataDir}`);
}
db.close();
