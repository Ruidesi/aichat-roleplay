// v0.8（契约 §13 / §14）：邀请码全生命周期、公开注册（并发最后一个名额、IP 限流）、管理接口拒收 password、
// 直接开号首次登录强制改密、重置码（只存哈希、仅返回一次、24h、新码作废旧码、权限范围）与公开重置（作废全部登录、限流）、
// 我的登录记录（只看自己、含失败与锁定、UA 解析）、任何接口不返回密码哈希与重置码哈希、迁移 v6 → v7。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { openDb, SCHEMA_VERSION } from '../server/db.mjs';
import { hashPassword } from '../server/auth.mjs';
import { createApp } from '../server/app.mjs';
import { HttpError, nowIso } from '../server/util.mjs';
import { nodeToCard } from '../server/chub.mjs';
import { deviceOf, CODE_ALPHABET, parseInviteExpiry, inviteStatus } from '../server/accounts.mjs';
import { tmpDir, cleanupTmp, listenFree, Client } from './helpers.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NODES = {
  'tester/safe-girl': { fullPath: 'tester/safe-girl', name: 'Safe Girl', tagline: 'hi', avatar_url: 'https://avatars.charhub.io/a/safe.webp', topics: [], nsfw_image: false,
    definition: { name: 'Safe Girl', first_message: '你好', personality: '友好' } },
};
const fakeChub = {
  async search() { return { items: Object.values(NODES).map(nodeToCard), page: 1, has_more: false }; },
  async character(p) { if (!NODES[p]) throw new HttpError(404, '没有找到这个角色'); return structuredClone(NODES[p]); },
};
const fakeLlm = {
  async streamChat(messages, { onDelta }) { onDelta('好的'); return { text: '好的', tokens_in: 7, tokens_out: 3, model: 'fake-model' }; },
  async complete() { return { text: '译文', tokens_in: 1, tokens_out: 1 }; },
};

const PORTS = [44989, 44988, 44987, 44986, 44985, 44984, 44983, 44982];
const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};
let dir, db, main;
const servers = [];
const clients = [];
const id = {};
const who = {};

const makeApp = () => createApp({ db, chub: fakeChub, llm: fakeLlm, avatars: { get: async () => ({ type: 'image/png', buf: Buffer.from('x') }) },
  config: { publicDir: path.join(dir, 'pub'), deepseekModel: 'fake', cardAvatarDir: path.join(dir, 'card-avatars') } });
let auxApp = null;
let auxBase = '';
/**
 * 限流器在 app 实例内存里。测限流 / 会产生很多失败的用例用「副实例」：同一个库、固定一个端口，
 * 每次调用换一个新的 app（新限流器），互不干扰。返回副实例地址。
 */
async function startApp() {
  auxApp = makeApp();
  if (!auxBase) {
    const server = http.createServer((req, res) => auxApp.handle(req, res));
    auxBase = `http://127.0.0.1:${await listenFree(server, PORTS)}`;
    servers.push(server);
  }
  return auxBase;
}
const client = (base = main) => { const c = new Client(base); clients.push(c); return c; };

async function login(name, pw, base = main, headers) {
  const c = client(base);
  const r = await c.post('/api/login', { username: name, password: pw }, headers);
  assert.equal(r.status, 200, `${name} 登录：${r.text}`);
  return c;
}
/** 直接开的号：登录后自己改一次密码（走正规流程），返回已解锁的客户端。 */
async function loginFirst(name, pw, newPw) {
  const c = await login(name, pw);
  const r = await c.post('/api/me/password', { old_password: pw, new_password: newPw });
  assert.equal(r.status, 200, r.text);
  return c;
}
const userRow = (username) => db.prepare('SELECT * FROM users WHERE username = ?').get(username);

before(async () => {
  dir = tmpDir('unit-invites');
  db = openDb(path.join(dir, 'aichat.sqlite'));
  id.super = Number(db.prepare("INSERT INTO users(username, password_hash, display_name, is_admin, role, created_at) VALUES ('root', ?, '超管', 1, 'super', ?)")
    .run(hashPassword('root-pass-1'), nowIso()).lastInsertRowid);
  const server = http.createServer(makeApp().handle);
  main = `http://127.0.0.1:${await listenFree(server, PORTS)}`;
  servers.push(server);
  who.super = await login('root', 'root-pass-1');
  for (const [k, name] of [['adminA', 'adma'], ['adminB', 'admb']]) {
    const r = await who.super.post('/api/admin/users', { username: name, password: `${name}-init-1`, display_name: name.toUpperCase(), role: 'admin' });
    assert.equal(r.status, 200, r.text);
    id[k] = r.json.user.id;
    who[k] = await loginFirst(name, `${name}-init-1`, `${name}-pass-1`);
  }
});

after(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  // 兜底：整个文件里所有响应都不得出现密码哈希 / 重置码哈希
  const all = clients.flatMap((c) => c.bodies).join('\n');
  assert.ok(!all.includes('scrypt$'), '响应里出现了 scrypt 哈希');
  assert.ok(!/password_hash|code_hash/.test(all), '响应里出现了哈希字段名');
  db.close();
  cleanupTmp(dir);
});

// ---------- 纯函数 ----------
test('UA 解析成简短中文设备描述', () => {
  assert.equal(deviceOf(UA.chromeWin), 'Chrome · Windows');
  assert.equal(deviceOf(UA.safariIphone), 'Safari · iPhone');
  assert.equal(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'), 'Safari · Mac');
  assert.equal(deviceOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36'), 'Chrome · Android');
  assert.equal(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0'), 'Edge · Windows');
  assert.equal(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50'), '微信 · iPhone');
  assert.equal(deviceOf('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'), 'Firefox · Linux');
  assert.equal(deviceOf('curl/8.7.1'), '命令行或程序');
  assert.equal(deviceOf(''), '未知设备');
  assert.equal(deviceOf(undefined), '未知设备');
});

test('v0.9 F8：服务器时区是 UTC / 纽约时，不带时区的到期时间仍按 +08:00 解析', () => {
  const mod = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'accounts.mjs')).href;
  const code = `import(${JSON.stringify(mod)}).then((m) => { const now = Date.parse('2026-10-01T00:00:00Z');
    console.log(JSON.stringify([m.parseInviteExpiry({ expires_at: '2026-12-01T10:00' }, now), m.parseInviteExpiry({ expires_at: '2026-12-01T10:00:00' }, now), m.parseInviteExpiry({ expires_at: '2026-12-01' }, now)])); });`;
  for (const tz of ['UTC', 'America/New_York']) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim()), ['2026-12-01T02:00:00.000Z', '2026-12-01T02:00:00.000Z', '2026-12-01T15:59:59.999Z'], tz);
  }
});

test('有效期解析：天数 / ISO / 纯日期（新加坡当天结束）；过去、超长、缺省都拒绝', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(parseInviteExpiry({ expires_in_days: 7 }, now), '2026-10-08T00:00:00.000Z');
  assert.equal(parseInviteExpiry({ expires_at: '2026-10-05' }, now), '2026-10-05T15:59:59.999Z');
  assert.equal(parseInviteExpiry({ expires_at: '2026-10-02T08:00:00+08:00' }, now), '2026-10-02T00:00:00.000Z');
  // v0.9 F8：不带时区的日期时间按新加坡时间（+08:00）解析；带 Z / ±hh:mm 的照原样
  assert.equal(parseInviteExpiry({ expires_at: '2026-12-01T10:00' }, now), '2026-12-01T02:00:00.000Z');
  assert.equal(parseInviteExpiry({ expires_at: '2026-12-01T10:00:00' }, now), '2026-12-01T02:00:00.000Z');
  assert.equal(parseInviteExpiry({ expires_at: '2026-12-01T10:00:00.500' }, now), '2026-12-01T02:00:00.500Z');
  assert.equal(parseInviteExpiry({ expires_at: '2026-12-01T10:00:00Z' }, now), '2026-12-01T10:00:00.000Z');
  assert.equal(parseInviteExpiry({ expires_at: '2026-12-01T10:00-05:00' }, now), '2026-12-01T15:00:00.000Z');
  for (const bad of ['2026-12-01T10', '2026-12-01T10:00+0800', '2026-12-01T10:00:00 +08:00', '2026-12-01T25:00']) {
    assert.throws(() => parseInviteExpiry({ expires_at: bad }, now), HttpError, bad);
  }
  for (const b of [{}, { expires_in_days: 0 }, { expires_in_days: 3651 }, { expires_in_days: 1.5 }, { expires_at: '2026-09-30' }, { expires_at: 'tomorrow' }, { expires_at: '2040-01-01' }]) {
    assert.throws(() => parseInviteExpiry(b, now), HttpError, JSON.stringify(b));
  }
  const inv = { disabled_at: null, expires_at: '2026-10-08T00:00:00.000Z', used_count: 0, max_uses: 1 };
  const creator = { role: 'admin', disabled: 0, deleted_at: null };
  assert.equal(inviteStatus(inv, creator, now), 'active');
  assert.equal(inviteStatus({ ...inv, used_count: 1 }, creator, now), 'used_up');
  assert.equal(inviteStatus(inv, creator, Date.parse('2026-10-09T00:00:00Z')), 'expired');
  assert.equal(inviteStatus({ ...inv, disabled_at: 'x' }, creator, now), 'disabled');
  assert.equal(inviteStatus(inv, { ...creator, disabled: 1 }, now), 'creator_inactive');
  assert.equal(inviteStatus(inv, { ...creator, deleted_at: 'x' }, now), 'creator_inactive');
  assert.equal(inviteStatus(inv, { ...creator, role: 'tenant' }, now), 'creator_inactive');
});

// ---------- 邀请码 ----------
test('建邀请码：备注必填 1–100 字、次数 1–10000、必须有有效期；码 10 位不含易混字符；链接格式', async () => {
  const bad = [
    [{ max_uses: 1, expires_in_days: 7 }, /备注/],
    [{ note: '   ', max_uses: 1, expires_in_days: 7 }, /备注/],
    [{ note: '字'.repeat(101), max_uses: 1, expires_in_days: 7 }, /备注/],
    [{ note: '好', max_uses: 0, expires_in_days: 7 }, /使用次数/],
    [{ note: '好', max_uses: 10001, expires_in_days: 7 }, /使用次数/],
    [{ note: '好', max_uses: 1 }, /有效期/],
    [{ note: '好', max_uses: 1, expires_at: '2000-01-01' }, /晚于现在/],
  ];
  for (const [b, re] of bad) {
    const r = await who.adminA.post('/api/admin/invites', b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.match(r.json.error, re);
  }
  const r = await who.adminA.post('/api/admin/invites', { note: '字'.repeat(100), max_uses: 3, expires_in_days: 7 });
  assert.equal(r.status, 200, r.text);
  const inv = r.json.invite;
  assert.equal(inv.code.length, 10);
  for (const ch of inv.code) assert.ok(CODE_ALPHABET.includes(ch), `码里有易混字符 ${ch}`);
  assert.ok(!/[0O1IL]/.test(inv.code));
  assert.equal(inv.link, `http://localhost:44982/#/register?code=${inv.code}`);
  assert.deepEqual([inv.max_uses, inv.used_count, inv.status, inv.status_name], [3, 0, 'active', '有效']);
  assert.ok(Math.abs(Date.parse(inv.expires_at) - (Date.now() + 7 * 86400000)) < 60000);
  assert.deepEqual(inv.users, []);
  // 租户不能建；未登录 401
  const t = await registerTenant(await newInvite(who.adminA), 'tn-x');
  assert.equal((await t.post('/api/admin/invites', { note: '好', max_uses: 1, expires_in_days: 1 })).status, 403);
  assert.equal((await t.get('/api/admin/invites')).status, 403);
  assert.equal((await client().post('/api/admin/invites', { note: '好', max_uses: 1, expires_in_days: 1 })).status, 401);
});

async function newInvite(c, extra = {}) {
  const r = await c.post('/api/admin/invites', { note: '测试邀请', max_uses: 5, expires_in_days: 7, ...extra });
  assert.equal(r.status, 200, r.text);
  return r.json.invite;
}
async function registerTenant(inv, username, base = main) {
  const c = client(base);
  const r = await c.post('/api/register', { code: inv.code, username, display_name: `显示-${username}`, password: `${username}-pass-1` });
  assert.equal(r.status, 200, r.text);
  return c;
}

test('注册：成功即登录，身份 tenant，created_by = 码创建者，备注 = 码备注；used_count +1；小写与带空格的码也认', async () => {
  const inv = await newInvite(who.adminA, { note: '小区群', max_uses: 2 });
  const c = client();
  const chk = await c.get(`/api/register/check?code=${inv.code}`);
  assert.deepEqual(chk.json, { ok: true });
  const r = await c.post('/api/register', { code: ` ${inv.code.toLowerCase()} `, username: 'reg1', display_name: '注册一号', password: 'reg1-pass-1' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.user.role, 'tenant');
  assert.equal(r.json.user.must_change_password, false);
  assert.equal(r.json.user.display_name, '注册一号');
  const me = await c.get('/api/me');
  assert.equal(me.status, 200, '注册后自动登录');
  assert.equal((await c.get('/api/home')).status, 200, '注册用户不需要强制改密');
  const u = userRow('reg1');
  assert.deepEqual([u.role, u.created_by, u.note, u.invite_code_id, u.must_change_password], ['tenant', id.adminA, '小区群', inv.id, 0]);
  // 创建者能在自己的租户列表里看到并管理；另一个管理员 404
  const listA = (await who.adminA.get('/api/admin/users')).json.items.find((x) => x.id === u.id);
  assert.equal(listA.note, '小区群');
  assert.equal(listA.invite_code_id, inv.id);
  assert.equal(listA.created_by, id.adminA);
  assert.equal((await who.adminB.patch(`/api/admin/users/${u.id}`, { note: '改' })).status, 404);
  assert.equal((await who.adminA.patch(`/api/admin/users/${u.id}`, { note: '小区群 · 已核实' })).json.user.note, '小区群 · 已核实');
  // 邀请码列表：used_count、注册用户
  const listed = (await who.adminA.get('/api/admin/invites')).json.items.find((x) => x.id === inv.id);
  assert.equal(listed.used_count, 1);
  assert.deepEqual(listed.users.map((x) => [x.id, x.username, x.display_name]), [[u.id, 'reg1', '注册一号']]);
  assert.ok(listed.users[0].registered_at);
});

test('check / 注册不泄露备注与创建者；码不存在 / 格式不对 / 已用完 / 已过期 / 已停用 / 创建者停用都拒绝', async () => {
  const base = await startApp(); // 独立限流器
  const c = client(base);
  const inv = await newInvite(who.adminA, { note: '秘密备注XYZ', max_uses: 1 });
  let r = await c.get(`/api/register/check?code=${inv.code}`);
  assert.ok(!r.text.includes('秘密备注XYZ') && !r.text.includes('adma') && !r.text.includes('ADMA'));
  assert.deepEqual((await c.get('/api/register/check?code=ABC')).json, { ok: false, reason: '邀请码格式不正确' });
  assert.deepEqual((await c.get('/api/register/check?code=ABCDEFGHJK')).json, { ok: false, reason: '邀请码不存在' });
  await registerTenant(inv, 'reg-full', base);
  assert.deepEqual((await c.get(`/api/register/check?code=${inv.code}`)).json, { ok: false, reason: '邀请码已用完' });
  r = await c.post('/api/register', { code: inv.code, username: 'reg-full2', password: 'xxxx-pass-1' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, '邀请码已用完');
  assert.ok(!r.text.includes('秘密备注XYZ'));

  const exp = await newInvite(who.adminA);
  db.prepare('UPDATE invite_codes SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), exp.id);
  assert.equal((await c.post('/api/register', { code: exp.code, username: 'reg-exp', password: 'xxxx-pass-1' })).json.error, '邀请码已过期');
  assert.equal((await who.adminA.get('/api/admin/invites')).json.items.find((x) => x.id === exp.id).status, 'expired');

  const dis = await newInvite(who.adminA);
  assert.equal((await who.adminB.post(`/api/admin/invites/${dis.id}/disable`)).status, 404, '别的管理员不能停用');
  assert.equal((await who.adminA.post(`/api/admin/invites/${dis.id}/disable`)).json.invite.status, 'disabled');
  assert.equal((await c.post('/api/register', { code: dis.code, username: 'reg-dis', password: 'xxxx-pass-1' })).json.error, '邀请码已停用');
  // 停用不能撤销，也不能改次数 / 有效期（没有对应接口）
  assert.equal((await who.adminA.patch(`/api/admin/invites/${dis.id}`, { max_uses: 9 })).status, 404);

  // 创建者账号停用 → 码失效；恢复后可用。软删 → 永久失效
  const adm = await who.super.post('/api/admin/users', { username: 'adm-c', password: 'adm-c-init-1', role: 'admin' });
  const admc = await loginFirst('adm-c', 'adm-c-init-1', 'adm-c-pass-1');
  const ci = await newInvite(admc);
  await who.super.patch(`/api/admin/users/${adm.json.user.id}`, { disabled: 1 });
  assert.deepEqual((await c.get(`/api/register/check?code=${ci.code}`)).json, { ok: false, reason: '邀请码已失效' });
  assert.equal((await c.post('/api/register', { code: ci.code, username: 'reg-ci', password: 'xxxx-pass-1' })).status, 400);
  assert.equal((await who.super.get('/api/admin/invites')).json.items.find((x) => x.id === ci.id).status, 'creator_inactive');
  await who.super.patch(`/api/admin/users/${adm.json.user.id}`, { disabled: 0 });
  await registerTenant(ci, 'reg-ci', base);
  await who.super.del(`/api/admin/users/${adm.json.user.id}`);
  assert.equal((await c.post('/api/register', { code: ci.code, username: 'reg-ci2', password: 'xxxx-pass-1' })).status, 400);
  // 删管理员时他的租户转给超管（原逻辑），邀请注册的租户也一样
  assert.equal(userRow('reg-ci').created_by, id.super);

  // 用户名唯一（含软删用户占用、不分大小写）；密码至少 8 位；用户名格式（换新限流器，上面的失败已接近 10 次）
  await startApp();
  const ok = await newInvite(who.adminA);
  assert.equal((await c.post('/api/register', { code: ok.code, username: 'REG1', password: 'xxxx-pass-1' })).status, 409);
  assert.equal((await c.post('/api/register', { code: ok.code, username: 'adm-c', password: 'xxxx-pass-1' })).status, 409, '软删账号仍占用用户名');
  assert.equal((await c.post('/api/register', { code: ok.code, username: 'reg-short', password: 'short' })).status, 400);
  assert.equal((await c.post('/api/register', { code: ok.code, username: '坏 名字', password: 'xxxx-pass-1' })).status, 400);
  assert.equal(db.prepare('SELECT used_count FROM invite_codes WHERE id = ?').get(ok.id).used_count, 0, '失败的注册不占名额');
});

test('并发抢最后一个名额不超用', async () => {
  const base = await startApp();
  const inv = await newInvite(who.adminA, { max_uses: 3 });
  await registerTenant(inv, 'race-0', base);
  await registerTenant(inv, 'race-1', base);
  const tries = await Promise.all(Array.from({ length: 6 }, (_, i) => client(base).post('/api/register', { code: inv.code, username: `race-x${i}`, password: 'race-pass-1' })));
  assert.equal(tries.filter((r) => r.status === 200).length, 1, tries.map((r) => r.status).join(','));
  assert.ok(tries.filter((r) => r.status !== 200).every((r) => r.status === 400 && r.json.error === '邀请码已用完'));
  assert.equal(db.prepare('SELECT used_count FROM invite_codes WHERE id = ?').get(inv.id).used_count, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE invite_code_id = ?').get(inv.id).n, 3);
});

test('注册按 IP 限流：10 分钟内失败 10 次锁 30 分钟（锁定后正确的码也不行）；check 里完整的错码也计数', async () => {
  const base = await startApp();
  const c = client(base);
  const inv = await newInvite(who.adminA);
  for (let i = 0; i < 5; i++) assert.equal((await c.get('/api/register/check?code=ZZZZZZZZZZ')).json.ok, false);
  for (let i = 0; i < 2; i++) assert.equal((await c.get('/api/register/check?code=ZZ')).json.ok, false); // 没输完的不算
  for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/register', { code: 'ZZZZZZZZZZ', username: `rl-${i}`, password: 'xxxx-pass-1' })).status, 400);
  const last = await c.post('/api/register', { code: 'ZZZZZZZZZZ', username: 'rl-9', password: 'xxxx-pass-1' });
  assert.equal(last.status, 400, '第 10 次失败本身仍返回原因');
  const locked = await c.post('/api/register', { code: inv.code, username: 'rl-ok', password: 'xxxx-pass-1' });
  assert.equal(locked.status, 429);
  assert.match(locked.json.error, /30 分钟/);
  assert.equal((await c.get(`/api/register/check?code=${inv.code}`)).status, 429);
  assert.equal(userRow('rl-ok'), undefined);
  assert.ok(db.prepare("SELECT 1 FROM logs WHERE kind = 'auth.lockout' AND detail_json LIKE '%register%'").get(), '记一条锁定日志');
  // 其他实例（不同进程 = 不同计数）不受影响，说明锁在本 IP 计数上
  await registerTenant(inv, 'rl-ok2');
});

test('邀请码列表：admin 只看自己的，super 看全部且带创建者名', async () => {
  const a = await newInvite(who.adminA, { note: 'A 的码' });
  const b = await newInvite(who.adminB, { note: 'B 的码' });
  const la = (await who.adminA.get('/api/admin/invites')).json.items;
  assert.ok(la.some((x) => x.id === a.id) && !la.some((x) => x.id === b.id));
  assert.ok(la.every((x) => x.creator.id === id.adminA));
  const ls = (await who.super.get('/api/admin/invites')).json.items;
  const sb = ls.find((x) => x.id === b.id);
  assert.ok(ls.some((x) => x.id === a.id));
  assert.deepEqual([sb.creator.id, sb.creator.name], [id.adminB, 'ADMB']);
  assert.equal((await who.super.post(`/api/admin/invites/${b.id}/disable`)).json.invite.status, 'disabled', 'super 能停用任何人的码');
  assert.equal((await who.adminA.post('/api/admin/invites/999999/disable')).status, 404);
});

// ---------- 密码自主 ----------
test('管理接口拒收 password（admin 与 super，含给自己）；直接开号带备注、首次登录强制改密', async () => {
  const tid = (await who.adminA.post('/api/admin/users', { username: 'direct-t', password: 'direct-init-1', note: '线下开号' })).json.user.id;
  for (const [c, target] of [[who.adminA, tid], [who.super, tid], [who.super, id.super], [who.adminA, tid]]) {
    const r = await c.patch(`/api/admin/users/${target}`, { password: 'whatever-pass-1' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, '管理员不能修改用户密码，请发重置码');
  }
  assert.equal((await who.adminB.patch(`/api/admin/users/${tid}`, { password: 'whatever-pass-1' })).status, 404, '范围外仍先 404，不泄露存在性');
  const row = userRow('direct-t');
  assert.deepEqual([row.must_change_password, row.note], [1, '线下开号']);
  assert.equal((await who.adminA.get('/api/admin/users')).json.items.find((x) => x.id === tid).must_change_password, 1);
  assert.equal((await who.adminA.post('/api/admin/users', { username: 'direct-n', password: 'direct-init-1', note: '字'.repeat(101) })).status, 400);

  const c = client();
  const lr = await c.post('/api/login', { username: 'direct-t', password: 'direct-init-1' });
  assert.equal(lr.status, 200);
  assert.equal(lr.json.user.must_change_password, true);
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.must_change_password, true);
  const blocked = [
    ['GET', '/api/home'], ['GET', '/api/chats'], ['GET', '/api/models'], ['GET', '/api/me/logins'], ['PATCH', '/api/me', { display_name: 'x' }],
    ['POST', '/api/chats', { path: 'tester/safe-girl' }], ['GET', '/api/my/cards'], ['GET', '/api/community'], ['GET', '/api/search?q=a'],
    ['GET', '/api/characters/tester/safe-girl'], ['POST', '/api/cards', { kind: 'character', name: 'x' }],
  ];
  for (const [m, p, b] of blocked) {
    const r = await c.req(m, p, b);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.deepEqual(r.json, { error: '请先修改初始密码', code: 'must_change_password' }, `${m} ${p}`);
  }
  // 直接开的管理员同样被拦（管理接口也一样）
  await who.super.post('/api/admin/users', { username: 'direct-a', password: 'direct-init-1', role: 'admin' });
  const da = await login('direct-a', 'direct-init-1');
  assert.equal((await da.get('/api/admin/users')).json.code, 'must_change_password');
  assert.equal((await da.post('/api/admin/invites', { note: 'x', max_uses: 1, expires_in_days: 1 })).json.code, 'must_change_password');
  // 新密码不能等于旧密码；太短；原密码错
  assert.match((await c.post('/api/me/password', { old_password: 'direct-init-1', new_password: 'direct-init-1' })).json.error, /不能与原密码相同/);
  assert.equal((await c.post('/api/me/password', { old_password: 'direct-init-1', new_password: 'short' })).status, 400);
  assert.equal((await c.post('/api/me/password', { old_password: 'wrong-pass-1', new_password: 'direct-new-1' })).status, 400);
  const ch = await c.post('/api/me/password', { old_password: 'direct-init-1', new_password: 'direct-new-1' });
  assert.equal(ch.status, 200, ch.text);
  assert.equal(ch.json.user.must_change_password, false);
  assert.equal(userRow('direct-t').must_change_password, 0);
  assert.equal((await c.get('/api/home')).status, 200, '改密后放行');
  // 退出不受拦截
  const d2 = await login('direct-a', 'direct-init-1');
  assert.equal((await d2.post('/api/logout')).status, 200);
  assert.equal((await d2.get('/api/me')).json.user, null);
});

test('重置码：权限范围、8 位仅返回一次、库里只存哈希、24 小时、新码作废旧码、用过作废、重置后旧登录全部失效且清强制改密', async () => {
  const base = await startApp();
  const inv = await newInvite(who.adminA);
  const t = await registerTenant(inv, 'rs-t', base);
  const tid = userRow('rs-t').id;
  const tb = await registerTenant(await newInvite(who.adminB), 'rs-b', base);
  const bid = userRow('rs-b').id;
  // 范围：adminA 只能给自己的租户；不能给别人的租户 / 管理员 / 超管 / 自己；租户 403；super 不能给别的 super
  assert.equal((await who.adminA.post(`/api/admin/users/${bid}/reset-code`)).status, 404);
  assert.equal((await who.adminA.post(`/api/admin/users/${id.adminB}/reset-code`)).status, 404);
  assert.equal((await who.adminA.post(`/api/admin/users/${id.super}/reset-code`)).status, 404);
  assert.equal((await who.adminA.post(`/api/admin/users/${id.adminA}/reset-code`)).status, 404);
  assert.equal((await t.post(`/api/admin/users/${bid}/reset-code`)).status, 403);
  const s2 = Number(db.prepare("INSERT INTO users(username, password_hash, display_name, is_admin, role, created_at) VALUES ('root2', ?, '超管二', 1, 'super', ?)").run(hashPassword('root2-pass-1'), nowIso()).lastInsertRowid);
  assert.equal((await who.super.post(`/api/admin/users/${s2}/reset-code`)).status, 403);
  assert.equal((await who.super.post(`/api/admin/users/${bid}/reset-code`)).status, 200, 'super 可给任何非 super');
  assert.equal((await who.super.post(`/api/admin/users/${id.adminB}/reset-code`)).status, 200);

  const r1 = await who.adminA.post(`/api/admin/users/${tid}/reset-code`);
  assert.equal(r1.status, 200, r1.text);
  assert.match(r1.json.code, /^[A-Z2-9]{8}$/);
  assert.ok(!/[0O1IL]/.test(r1.json.code));
  assert.ok(Math.abs(Date.parse(r1.json.expires_at) - (Date.now() + 24 * 3600000)) < 60000);
  const rows = db.prepare('SELECT * FROM password_resets WHERE user_id = ?').all(tid);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].code_hash.startsWith('scrypt$') && !rows[0].code_hash.includes(r1.json.code), '只存哈希');
  assert.ok(!(await who.adminA.get('/api/admin/users')).text.includes(r1.json.code), '列表里拿不到');
  // 新码作废旧码
  const r2 = await who.adminA.post(`/api/admin/users/${tid}/reset-code`);
  const anon = client(base);
  const reset = (code, pw = 'rs-new-pass-1', username = 'rs-t') => anon.post('/api/password/reset', { username, code, new_password: pw });
  assert.equal((await reset(r1.json.code)).status, 400, '旧码已作废');
  assert.equal((await reset(r2.json.code, 'short')).status, 400, '新密码太短');
  assert.equal((await reset(r2.json.code, 'rs-new-pass-1', 'rs-b')).status, 400, '码与用户名不匹配');
  // 带强制改密标记的用户：重置后清零
  db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(tid);
  const ok = await reset(r2.json.code.toLowerCase());
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json, { ok: true });
  assert.equal((await t.get('/api/me')).json.user, null, '旧登录全部失效');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(tid).n, 0);
  assert.equal(userRow('rs-t').must_change_password, 0);
  const nt = await login('rs-t', 'rs-new-pass-1');
  assert.equal((await nt.get('/api/home')).status, 200);
  assert.equal((await reset(r2.json.code, 'rs-new-pass-2')).status, 400, '用过的码不能再用');
  // 过期
  const r3 = await who.adminA.post(`/api/admin/users/${tid}/reset-code`);
  db.prepare('UPDATE password_resets SET expires_at = ? WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL').run(new Date(Date.now() - 1000).toISOString(), tid);
  assert.equal((await reset(r3.json.code)).status, 400, '过期');
  // 被别人拿到的旧会话 tb 不受影响
  assert.equal((await tb.get('/api/me')).status, 200);
});

test('公开重置按 IP+用户名限流：连续 5 次错码锁 10 分钟（锁定期间正确的码也不行）', async () => {
  const base = await startApp();
  const inv = await newInvite(who.adminA);
  await registerTenant(inv, 'rl-r', base);
  const uid = userRow('rl-r').id;
  const code = (await who.adminA.post(`/api/admin/users/${uid}/reset-code`)).json.code;
  const c = client(base);
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/password/reset', { username: 'rl-r', code: 'ZZZZZZZZ', new_password: 'rl-new-pass-1' })).status, 400);
  const r = await c.post('/api/password/reset', { username: 'rl-r', code, new_password: 'rl-new-pass-1' });
  assert.equal(r.status, 429);
  assert.equal((await client(base).post('/api/login', { username: 'rl-r', password: 'rl-new-pass-1' })).status, 401, '没被改');
  // 不存在的用户名同样返回统一的错误（不泄露账号是否存在）
  const g = await client(await startApp()).post('/api/password/reset', { username: 'nobody-here', code: 'ABCDEFGH', new_password: 'xxxx-pass-1' });
  assert.equal(g.status, 400);
  assert.equal(g.json.error, '用户名或重置码不正确，或重置码已过期');
});

// ---------- 我的登录记录 ----------
test('我的登录记录：只返回自己的；成功 / 失败（密码错误、账号停用）/ 锁定 / 注册 / 重置都在；UA 解析；不返回原始 detail', async () => {
  const base = await startApp();
  const inv = await newInvite(who.adminA);
  const reg = client(base);
  const rr = await reg.post('/api/register', { code: inv.code, username: 'lg-u', display_name: '记录', password: 'lg-pass-1' }, { 'user-agent': UA.safariIphone });
  assert.equal(rr.status, 200);
  const uid = rr.json.user.id;
  const anon = client(base);
  assert.equal((await anon.post('/api/login', { username: 'lg-u', password: 'wrong-pass-1' }, { 'user-agent': UA.chromeWin })).status, 401);
  await who.adminA.patch(`/api/admin/users/${uid}`, { disabled: 1 });
  assert.equal((await anon.post('/api/login', { username: 'lg-u', password: 'lg-pass-1' })).status, 403);
  await who.adminA.patch(`/api/admin/users/${uid}`, { disabled: 0 });
  for (let i = 0; i < 4; i++) await anon.post('/api/login', { username: 'lg-u', password: 'wrong-pass-1' });
  assert.equal((await anon.post('/api/login', { username: 'lg-u', password: 'lg-pass-1' })).status, 429);
  const code = (await who.adminA.post(`/api/admin/users/${uid}/reset-code`)).json.code;
  assert.equal((await client(base).post('/api/password/reset', { username: 'lg-u', code, new_password: 'lg-pass-2' }, { 'user-agent': UA.chromeWin })).status, 200);
  const me = await login('lg-u', 'lg-pass-2', await startApp(), { 'user-agent': UA.chromeWin });
  // 别人的登录（adminA）不能出现在这里
  const r = await me.get('/api/me/logins');
  assert.equal(r.status, 200, r.text);
  const items = r.json.items;
  assert.equal(r.json.page, 1);
  assert.equal(r.json.has_more, false);
  for (const it of items) {
    assert.deepEqual(Object.keys(it).filter((k) => !['at', 'result', 'reason', 'event', 'event_name', 'ip', 'device'].includes(k)), [], '只给约定字段');
    assert.equal(it.ip, '127.0.0.1');
  }
  assert.ok(!r.text.includes('lg-pass') && !r.text.includes('user_agent') && !r.text.includes('Mozilla'), '不返回原始 detail / UA');
  const seq = items.map((x) => [x.event, x.result, x.reason ?? null]);
  assert.deepEqual(seq[0], ['login', 'success', null]);
  assert.equal(items[0].device, 'Chrome · Windows');
  assert.deepEqual(seq[1], ['password_reset', 'success', null]);
  assert.ok(seq.some((x) => x[1] === 'locked' && x[2] === '尝试过多被锁'), JSON.stringify(seq));
  assert.ok(seq.some((x) => x[0] === 'login' && x[1] === 'fail' && x[2] === '账号停用'));
  assert.equal(seq.filter((x) => x[0] === 'login' && x[1] === 'fail' && x[2] === '密码错误').length, 5);
  const last = items[items.length - 1];
  assert.deepEqual([last.event, last.result, last.device], ['register', 'success', 'Safari · iPhone']);
  const firstFail = items.filter((x) => x.result === 'fail').at(-1);
  assert.equal(firstFail.device, 'Chrome · Windows');
  // 按时间倒序
  for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].at >= items[i].at);
  // 管理员 / 超管也能看自己的；看到的只有自己
  const a = await who.adminA.get('/api/me/logins');
  assert.equal(a.status, 200);
  assert.ok(a.json.items.length >= 1 && a.json.items.every((x) => x.event === 'login'));
  assert.equal((await who.super.get('/api/me/logins')).status, 200);
  assert.equal((await client().get('/api/me/logins')).status, 401);
  // 分页每页 30
  const t = nowIso();
  const ins = db.prepare("INSERT INTO logs(at, level, kind, target_type, target_id, ip, summary, detail_json) VALUES (?, 'info', 'auth.login', 'user', ?, '10.0.0.1', 'x', ?)");
  for (let i = 0; i < 40; i++) ins.run(new Date(Date.parse(t) - 86400000 * 2 - i * 1000).toISOString(), uid, JSON.stringify({ result: 'ok' }));
  const p1 = (await me.get('/api/me/logins')).json;
  const p2 = (await me.get('/api/me/logins?page=2')).json;
  assert.equal(p1.items.length, 30);
  assert.equal(p1.has_more, true);
  assert.equal(p2.page, 2);
  const total = items.length + 1 + 40; // +1：刚才 login() 之前的记录已含在 items；分页时再算一次自己
  assert.ok(p2.items.length > 0 && p2.items.length <= total - 30);
  assert.equal(p2.items.at(-1).device, '未知设备');
});

// ---------- 迁移 ----------
test('迁移 v6 → v9：旧账号 note 为空、不强制改密；新表与索引就位；幂等', () => {
  const d = path.join(dir, 'mig7'); mkdirSync(d, { recursive: true });
  const file = path.join(d, 'aichat.sqlite');
  let x = openDb(file, { upTo: 6 });
  x.prepare("INSERT INTO users(username, password_hash, display_name, role, created_at) VALUES ('old', 'h', '旧', 'tenant', '2026-10-01T00:00:00.000Z')").run();
  const before = x.prepare('SELECT * FROM users').all().map((r) => ({ ...r }));
  x.close();
  x = openDb(file);
  assert.equal(SCHEMA_VERSION, 12);
  assert.equal(x.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  const after = x.prepare('SELECT * FROM users').all().map((r) => ({ ...r }));
  assert.deepEqual(after.map(({ note, invite_code_id, must_change_password, voice_auto_send, reading_settings_json, ...rest }) => rest), before);
  assert.deepEqual(after.map((u) => u.reading_settings_json), ['{}']);
  assert.deepEqual(after.map((u) => [u.note, u.invite_code_id, u.must_change_password]), [[null, null, 0]]);
  assert.deepEqual(x.prepare('PRAGMA table_info(invite_codes)').all().map((c) => c.name),
    ['id', 'code', 'creator_id', 'note', 'max_uses', 'used_count', 'expires_at', 'disabled_at', 'created_at']);
  assert.deepEqual(x.prepare('PRAGMA table_info(password_resets)').all().map((c) => c.name),
    ['id', 'user_id', 'code_hash', 'issued_by', 'expires_at', 'used_at', 'revoked_at', 'created_at']);
  assert.ok(x.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_logs_target_at'").get());
  assert.deepEqual(JSON.parse(x.prepare("SELECT detail_json FROM logs WHERE kind = 'system.migrate' ORDER BY id DESC LIMIT 1").get().detail_json), { from: 6, to: SCHEMA_VERSION });
  // v8 保留迁移编号，新数据库不再创建会话审查的编辑历史表。
  assert.deepEqual(x.prepare('PRAGMA table_info(message_edits)').all(), []);
  assert.throws(() => x.prepare("INSERT INTO invite_codes(code, creator_id, note, max_uses, expires_at, created_at) VALUES ('A', 1, 'n', 0, 'x', 'x')").run(), /CHECK/);
  assert.deepEqual(x.prepare('PRAGMA foreign_key_check').all(), []);
  x.close();
  x = openDb(file);
  assert.equal(x.prepare("SELECT COUNT(*) AS n FROM logs WHERE kind = 'system.migrate'").get().n, 2);
  x.close();
});
