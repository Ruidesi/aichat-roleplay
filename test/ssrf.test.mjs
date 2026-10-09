import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAvatarUrl, avatarProxyUrl, isValidChubPath, isNsfwNode, nodeToCard } from '../server/chub.mjs';

test('头像白名单：放行 charhub.io / chub.ai 及其子域的 https', () => {
  for (const u of [
    'https://avatars.charhub.io/avatars/a/b/avatar.webp',
    'https://charhub.io/x.png',
    'https://cdn.charhub.io/x.png',
    'https://chub.ai/x.png',
    'https://images.chub.ai/x.png',
    'https://avatars.charhub.io:443/a.png',
  ]) assert.ok(checkAvatarUrl(u), u);
});

test('头像白名单：拒绝其他主机、http、端口、账号、相似域名、内网', () => {
  for (const u of [
    'http://avatars.charhub.io/a.png',
    'https://evil.com/a.png',
    'https://charhub.io.evil.com/a.png',
    'https://evilcharhub.io/a.png',
    'https://notchub.ai/a.png',
    'https://avatars.charhub.io:8443/a.png',
    'https://user:pw@avatars.charhub.io/a.png',
    'https://127.0.0.1/a.png',
    'https://localhost/a.png',
    'https://169.254.169.254/latest/meta-data',
    'file:///etc/passwd',
    'javascript:alert(1)',
    '//avatars.charhub.io/a.png',
    '',
    'https://.charhub.io/a.png',
    null,
    'https://avatars.charhub.io/' + 'a'.repeat(3000),
  ]) assert.equal(checkAvatarUrl(u), null, String(u).slice(0, 60));
});

test('Card 里的 avatar 一律是代理地址；不在白名单的直接给空', () => {
  assert.equal(avatarProxyUrl('https://avatars.charhub.io/a.png'), '/api/avatar?u=' + encodeURIComponent('https://avatars.charhub.io/a.png'));
  assert.equal(avatarProxyUrl('https://evil.com/a.png'), '');
  const card = nodeToCard({ fullPath: 'u/x', name: 'X', tagline: 't', avatar_url: 'https://avatars.charhub.io/a.png', topics: ['A', 'NSFW'], starCount: 3, nChats: 4 });
  assert.deepEqual(card, { path: 'u/x', name: 'X', tagline: 't', avatar: avatarProxyUrl('https://avatars.charhub.io/a.png'), tags: ['A', 'NSFW'], nsfw: true, stars: 3, chats: 4 });
});

test('chub 路径校验与 NSFW 判定', () => {
  assert.ok(isValidChubPath('Anonymous/nemo-the-god-child-7e89024a12d6'));
  assert.ok(!isValidChubPath('../etc/passwd'));
  assert.ok(!isValidChubPath('a/b/c'));
  assert.ok(!isValidChubPath('a'));
  assert.ok(!isValidChubPath('a/b?x=1'));
  assert.ok(isNsfwNode({ nsfw_image: true, topics: [] }));
  assert.ok(isNsfwNode({ topics: ['nsfw'] }));
  assert.ok(!isNsfwNode({ topics: ['SFW'] }));
});
