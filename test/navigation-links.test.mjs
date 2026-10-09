import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 只适配浏览器模块加载、DOM 和网络边界；执行真实视图、API 与渲染组件。
// 不启动后端、不读取密钥，fetch 只返回下面的离线资料。
class Element {
  innerHTML = '';
  value = '';
  style = {};
  classList = { toggle() {} };
  nodes = new Map();
  get firstElementChild() { return this.querySelector(':first-child'); }
  querySelector(selector) {
    if (!this.nodes.has(selector)) this.nodes.set(selector, new Element());
    return this.nodes.get(selector);
  }
  querySelectorAll() { return []; }
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  scrollIntoView() {}
  focus() {}
}

function offlineSite(t) {
  const requests = [], cleanups = [], modules = new Map();
  const tag = '原创 & 科幻/冒险';
  const character = {
    path: 'tester/character', name: '测试角色', tagline: '', avatar: '',
    tags: ['Anime', tag], tags_zh: ['动漫', tag], nsfw: false, stars: 0, chats: 0,
    greeting: '你好', greeting_zh: '你好', creator_notes: '', translate_status: 'ok',
    definition: { personality: '', tavern_personality: '', scenario: '', first_message: '你好',
      alternate_greetings: [], example_dialogs: '', system_prompt: '', post_history_instructions: '',
      description: '', embedded_lorebook: null },
  };
  const communityCard = {
    id: 7, owner_id: 2, owner_name: '另一位作者', kind: 'character',
    name: '社区角色', tagline: '', avatar: '', tags: [tag], nsfw: false,
    visibility: 'public', chats: 0, forked_from_type: null,
    card_json: { first_mes: '你好', alternate_greetings: [], description: '', personality: '',
      scenario: '', mes_example: '', system_prompt: '', post_history_instructions: '',
      creator_notes: '', character_book: null },
  };
  const location = { hash: '' };
  const sandbox = vm.createContext({
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    document: { addEventListener() {} },
    location, history: { replaceState(_state, _title, hash) { location.hash = hash; } },
    matchMedia: () => ({ matches: true }),
    IntersectionObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => { fn(); return 0; },
    fetch: async (path, options) => {
      assert.equal(options.method, 'GET', '离线导航测试不允许写请求');
      const url = new URL(path, 'https://offline.invalid');
      requests.push(url);
      let body;
      if (url.pathname === '/api/home') body = { shelves: [], hot: [] };
      else if (url.pathname === '/api/chats') body = { items: [] };
      else if (url.pathname === '/api/characters/tester/character') body = { character };
      else if (url.pathname === '/api/character-images') {
        assert.equal(url.searchParams.get('path'), 'tester/character');
        body = { available: true, items: [], page: 1, limit: 24, has_more: false };
      }
      else if (url.pathname === '/api/cards/7') body = { card: communityCard };
      else if (['/api/search', '/api/community'].includes(url.pathname)) body = { items: [], page: 1, has_more: false };
      else assert.fail('未声明的离线请求：' + url.pathname);
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    },
  });

  function load(path) {
    if (modules.has(path)) return modules.get(path);
    let source = readFileSync(new URL('../public' + path, import.meta.url), 'utf8');
    const imports = {};
    source = source.replace(/^import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"];\s*/gm,
      (_statement, bindings, dependency) => {
        imports[dependency] = load(dependency);
        return `const {${bindings}} = __imports[${JSON.stringify(dependency)}];\n`;
      });
    const exports = [...source.matchAll(/^export\s+(default\s+)?(?:async\s+)?(?:function|class|const|let)\s+(\w+)/gm)]
      .map((m) => m[1] ? `default: ${m[2]}` : m[2]);
    source = source.replace(/^export\s+(?:default\s+)?/gm, '');
    const factory = vm.runInContext(`(function(__imports) {\n${source}\nreturn {${exports.join(',')}};\n})`, sandbox, { filename: path });
    const exported = factory(imports);
    modules.set(path, exported);
    return exported;
  }

  load('/js/store.js').store.me = { id: 1, username: 'test', display_name: '测试者' };
  load('/i18n/zh.js').zh.quick_tags = ['Anime', tag];
  t.after(() => { for (const cleanup of cleanups) cleanup(); });

  async function render(view, hash, params = []) {
    const root = new Element();
    location.hash = hash;
    const query = new URLSearchParams(hash.split('?')[1] || '');
    await load(`/js/views/${view}.js`).default({
      root, query, params, setTitle() {}, navigate() {}, isActive: () => true,
      onCleanup: (fn) => cleanups.push(fn),
    });
    return root;
  }
  async function follow(href) {
    const before = requests.length;
    await render('search', href);
    const emitted = requests.slice(before);
    assert.equal(emitted.length, 1, '跟随搜索入口应发出一次角色库查询');
    return emitted[0];
  }
  return { render, follow };
}

function links(html) {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>/g)]
    .map((m) => m[1].replace(/&amp;/g, '&'));
}
const queryOf = (href) => new URLSearchParams(href.split('?')[1] || '');

test('看过社区后，首页分类仍查询Chub并保留原标签', async (t) => {
  const site = offlineSite(t);
  const home = await site.render('home', '#/');
  const categories = links(home.querySelector('#home-body').innerHTML).filter((h) => queryOf(h).has('tag'));
  assert.equal(categories.length, 2);
  for (const [index, wantedTag] of ['Anime', '原创 & 科幻/冒险'].entries()) {
    await site.follow('#/search?tab=community');
    const request = await site.follow(categories[index]);
    assert.equal(request.pathname, '/api/search');
    assert.equal(request.searchParams.get('tag'), wantedTag);
  }
});

test('看过社区后，首页热门的查看全部仍查询Chub热门排序', async (t) => {
  const site = offlineSite(t);
  const home = await site.render('home', '#/');
  const hot = links(home.querySelector('#home-body').innerHTML).find((h) => queryOf(h).has('sort'));
  assert.ok(hot, '首页应提供热门查看全部入口');
  await site.follow('#/search?tab=community');
  const request = await site.follow(hot);
  assert.equal(request.pathname, '/api/search');
  assert.equal(request.searchParams.get('sort'), 'trending_downloads');
});

test('看过社区后，Chub角色的中文标签仍查询Chub原标签', async (t) => {
  const site = offlineSite(t);
  const detail = await site.render('character', '#/c/tester/character', ['tester/character']);
  const tags = links(detail.firstElementChild.querySelector('[data-hero]').innerHTML).filter((h) => queryOf(h).has('tag'));
  assert.equal(tags.length, 2);
  for (const [index, wantedTag] of ['Anime', '原创 & 科幻/冒险'].entries()) {
    await site.follow('#/search?tab=community');
    const request = await site.follow(tags[index]);
    assert.equal(request.pathname, '/api/search');
    assert.equal(request.searchParams.get('tag'), wantedTag);
  }
});

test('社区角色标签始终查询社区，不受上次Chub页面影响', async (t) => {
  const site = offlineSite(t);
  const detail = await site.render('ucard', '#/u/7', ['7']);
  const tag = links(detail.firstElementChild.innerHTML).find((h) => queryOf(h).has('tag'));
  assert.ok(tag, '社区角色应提供标签入口');
  await site.follow('#/search?tab=chub');
  const request = await site.follow(tag);
  assert.equal(request.pathname, '/api/community');
  assert.equal(request.searchParams.get('tag'), '原创 & 科幻/冒险');
});

test('首页普通搜索入口继续记住用户上次选择的社区', async (t) => {
  const site = offlineSite(t);
  const home = await site.render('home', '#/');
  const search = links(home.innerHTML).find((h) => h === '#/search');
  assert.ok(search, '首页应提供不限定角色库的普通搜索入口');
  await site.follow('#/search?tab=community');
  const request = await site.follow(search);
  assert.equal(request.pathname, '/api/community');
});
