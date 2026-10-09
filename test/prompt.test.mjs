import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMacros, buildMessages, userCallName, LANGUAGE_RULE, DEFAULT_SYSTEM, HISTORY_MAX_CHARS, EXAMPLE_MAX_CHARS } from '../server/prompt.mjs';
import { looksChinese, readKeyFromEnvFile } from '../server/llm.mjs';

test('宏替换：{{char}}/<BOT>/{{user}}/<USER>，不区分大小写', () => {
  const out = applyMacros('{{char}} 看着 {{user}}；<BOT> 和 <USER>；{{Char}} {{ USER }}', { char: '小美', user: '阿明' });
  assert.equal(out, '小美 看着 阿明；小美 和 阿明；小美 阿明');
  assert.equal(applyMacros(null, { char: 'a', user: 'b' }), '');
  // 替换值里带 $ 不被当成正则替换模式
  assert.equal(applyMacros('{{user}}', { user: '$&$1' }), '$&$1');
});

test('用户称呼：persona_name > display_name > username', () => {
  assert.equal(userCallName({ persona_name: 'P', display_name: 'D', username: 'u' }), 'P');
  assert.equal(userCallName({ persona_name: '', display_name: 'D', username: 'u' }), 'D');
  assert.equal(userCallName({ username: 'u' }), 'u');
});

test('system 组装：各字段 + 用户人设 + 语言规则，宏在所有字段生效', () => {
  const def = {
    system_prompt: '你是 {{char}}，对 {{user}} 很友好。',
    personality: '<BOT> 是一名侦探',
    tavern_personality: '冷静',
    scenario: '{{user}} 走进事务所',
    example_dialogs: '<START>\n{{user}}: 你好\n{{char}}: 请坐',
    post_history_instructions: '记住 {{user}} 的名字',
  };
  const user = { display_name: '阿明', persona_desc: '{{user}} 是学生' };
  const msgs = buildMessages({ definition: def, charName: '福尔摩斯', user, history: [
    { role: 'assistant', content: '欢迎，{{user}}' },
    { role: 'user', content: '你好 {{char}}' },
  ] });
  const sys = msgs[0];
  assert.equal(sys.role, 'system');
  assert.match(sys.content, /^你是 福尔摩斯，对 阿明 很友好。/);
  assert.match(sys.content, /福尔摩斯 是一名侦探/);
  assert.match(sys.content, /冷静/);
  assert.match(sys.content, /阿明 走进事务所/);
  assert.match(sys.content, /阿明 是学生/);
  assert.match(sys.content, /阿明: 你好\n福尔摩斯: 请坐/);
  assert.ok(sys.content.includes(LANGUAGE_RULE));
  assert.ok(!/\{\{|<BOT>|<USER>/i.test(JSON.stringify(msgs)), '还有没替换的宏');
  assert.deepEqual(msgs[1], { role: 'assistant', content: '欢迎，阿明' });
  assert.deepEqual(msgs[2], { role: 'user', content: '你好 福尔摩斯' });
  assert.deepEqual(msgs[3], { role: 'system', content: '记住 阿明 的名字' });
});

test('没有 system_prompt 用默认；没有 post_history 不追加', () => {
  const msgs = buildMessages({ definition: {}, charName: 'A', user: { display_name: 'B' }, history: [{ role: 'user', content: 'hi' }] });
  assert.ok(msgs[0].content.startsWith(applyMacros(DEFAULT_SYSTEM, { char: 'A', user: 'B' })));
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].role, 'user');
});

test('示例对话截断到约 2000 字，历史从新往旧装约 24000 字', () => {
  const ex = 'x'.repeat(EXAMPLE_MAX_CHARS * 2);
  const history = [];
  for (let i = 0; i < 60; i++) history.push({ role: i % 2 ? 'user' : 'assistant', content: `${i}:` + 'y'.repeat(1000) });
  const msgs = buildMessages({ definition: { example_dialogs: ex }, charName: 'A', user: { display_name: 'B' }, history });
  assert.ok(!msgs[0].content.includes('x'.repeat(EXAMPLE_MAX_CHARS + 1)));
  assert.ok(msgs[0].content.includes('x'.repeat(EXAMPLE_MAX_CHARS)));
  const hist = msgs.slice(1);
  const total = hist.reduce((n, m) => n + m.content.length, 0);
  assert.ok(total <= HISTORY_MAX_CHARS, `历史 ${total} 超长`);
  assert.ok(hist.length >= 20 && hist.length < 60);
  assert.ok(hist[hist.length - 1].content.startsWith('59:'), '最新一条必须保留');
  // 保留的是最近的连续一段
  const first = Number(hist[0].content.split(':')[0]);
  assert.equal(first, 60 - hist.length);
});

test('超长的单条最新消息也至少保留', () => {
  const msgs = buildMessages({ definition: {}, charName: 'A', user: {}, history: [{ role: 'user', content: 'z'.repeat(HISTORY_MAX_CHARS + 10) }] });
  assert.equal(msgs.length, 2);
});

test('中文判定与 env 文件解析', async () => {
  assert.equal(looksChinese('*她笑了* 你好呀，{{user}}！'), true);
  assert.equal(looksChinese('*She smiles* Hello there, {{user}}!'), false);
  assert.equal(looksChinese(''), true);
  const { writeFileSync } = await import('node:fs');
  const { tmpDir, cleanupTmp } = await import('./helpers.mjs');
  const dir = tmpDir('envparse');
  const f = dir + '/k.env';
  writeFileSync(f, '# c\nexport OTHER=1\nexport DEEPSEEK_API_KEY="abc-123"\n');
  assert.equal(readKeyFromEnvFile(f), 'abc-123');
  writeFileSync(f, "DEEPSEEK_API_KEY='q'\n");
  assert.equal(readKeyFromEnvFile(f), 'q');
  assert.equal(readKeyFromEnvFile(dir + '/missing'), '');
  cleanupTmp(dir);
});
