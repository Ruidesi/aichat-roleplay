import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// 执行实际浏览器模块；只替代浏览器的事件边界和fetch，不启动后端或连接外网。
let modules;
async function images() {
  if (!modules) modules = (async () => {
    const oldDocument = globalThis.document;
    globalThis.document = new EventTarget();
    const hook = registerHooks({ resolve(specifier, context, next) {
      return next(specifier.startsWith('/js/') || specifier.startsWith('/i18n/')
        ? new URL(`../public${specifier}`, import.meta.url).href : specifier, context);
    } });
    try {
      const module = await import('../public/js/images.js').catch(() => null);
      assert.ok(module, '图片UI模块尚未实现');
      return { ...module, ...(await import('../public/js/image-viewer.js')), zh: (await import('../public/i18n/zh.js')).zh };
    } finally { hook.deregister(); globalThis.document = oldDocument; }
  })();
  return modules;
}

test('缩略图和原图只接受本站受保护媒体地址', async (t) => {
  const { safeImageUrl } = await images();
  const previous = globalThis.location;
  globalThis.location = { origin: 'https://offline.invalid' };
  t.after(() => { globalThis.location = previous; });
  assert.equal(safeImageUrl('/api/images/neutral-1?variant=original'), '/api/images/neutral-1?variant=original');
  assert.equal(safeImageUrl('https://offline.invalid/api/images/neutral-1?variant=thumb'), '/api/images/neutral-1?variant=thumb');
  for (const src of [
    'javascript:alert(1)', 'data:image/svg+xml,neutral', 'https://outside.invalid/api/images/neutral-1',
    '//outside.invalid/api/images/neutral-1', '/api/images/../admin', '/api/images/%2e%2e/admin',
    '/api/images/neutral-1\\other', '/api/images/neutral-1\n', '/unprotected/neutral.jpg',
  ]) assert.equal(safeImageUrl(src), '', src);
});

test('图库筛选实际发出带编码角色路径的GET并传递中断信号', async (t) => {
  const { getImagePage } = await images();
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  const controller = new AbortController();
  let requested;
  globalThis.fetch = async (pathname, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.signal, controller.signal);
    requested = new URL(pathname, 'https://offline.invalid');
    return new Response(JSON.stringify({ available: true, items: [], page: 2, limit: 24, has_more: false }),
      { headers: { 'Content-Type': 'application/json' } });
  };
  await getImagePage({ kind: 'fullimg', q: '星图 & 云', character: '编目员/星图?副本', page: 2 }, { signal: controller.signal });
  assert.equal(requested.pathname, '/api/images');
  assert.deepEqual(Object.fromEntries(requested.searchParams), {
    kind: 'fullimg', q: '星图 & 云', character: '编目员/星图?副本', page: '2', limit: '24',
  });
});

test('角色图集独立查询角色完整路径，不混入全站图库', async (t) => {
  const { getCharacterImagePage } = await images();
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  let requested;
  globalThis.fetch = async (pathname) => {
    requested = new URL(pathname, 'https://offline.invalid');
    return new Response(JSON.stringify({ available: true, items: [], page: 1, limit: 24, has_more: false }),
      { headers: { 'Content-Type': 'application/json' } });
  };
  await getCharacterImagePage('编目员/星图 & 问号?');
  assert.equal(requested.pathname, '/api/character-images');
  assert.deepEqual(Object.fromEntries(requested.searchParams), { path: '编目员/星图 & 问号?', page: '1', limit: '24' });
});

test('图库分享链接保留类型、搜索和角色筛选', async () => {
  const { galleryHref } = await images();
  const href = galleryHref({ kind: 'gallery', q: '星图 & 云', character: '编目员/星图?副本' });
  const query = new URLSearchParams(href.split('?')[1]);
  assert.equal(href.split('?')[0], '#/gallery');
  assert.deepEqual(Object.fromEntries(query), { kind: 'gallery', q: '星图 & 云', character: '编目员/星图?副本' });
  assert.equal(galleryHref({ kind: 'unknown' }), '#/gallery');
});

test('图库继续浏览时发送游标，可超过旧页数上限并保持中断能力', async (t) => {
  const { getImagePage } = await images();
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  const controller = new AbortController();
  let requested;
  globalThis.fetch = async (pathname, init) => {
    requested = new URL(pathname, 'https://offline.invalid');
    assert.equal(init.signal, controller.signal);
    return new Response(JSON.stringify({ available: true, items: [], page: 501, limit: 24, has_more: false }),
      { headers: { 'Content-Type': 'application/json' } });
  };
  await getImagePage({ kind: 'gallery', page: 501, cursor: 'eyJ2IjoxfQ' }, { signal: controller.signal });
  assert.equal(requested.searchParams.get('page'), '501');
  assert.equal(requested.searchParams.get('cursor'), 'eyJ2IjoxfQ');
});

test('角色图片继续加载发送对应游标，首屏请求保持无游标', async (t) => {
  const { getCharacterImagePage } = await images();
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  const requests = [];
  globalThis.fetch = async (pathname) => {
    requests.push(new URL(pathname, 'https://offline.invalid'));
    return new Response(JSON.stringify({ available: true, items: [], has_more: false }),
      { headers: { 'Content-Type': 'application/json' } });
  };
  await getCharacterImagePage('fixture/neutral', 1);
  await getCharacterImagePage('fixture/neutral', 501, { cursor: 'eyJ2IjoxfQ' });
  assert.equal(requests[0].searchParams.has('cursor'), false);
  assert.equal(requests[1].searchParams.get('cursor'), 'eyJ2IjoxfQ');
  assert.equal(requests[1].searchParams.get('page'), '501');
});

test('图卡预览按钮和角色入口可单独操作，文案安全转义', async () => {
  const { imageCardHtml, zh } = await images();
  const html = imageCardHtml({ id: 'neutral-1', kind: 'gallery', character_name: '星图 <script>',
    character_path: '编目员/星图 & 云', thumbnail_url: '/api/images/neutral-1?variant=thumb',
    original_url: '/api/images/neutral-1?variant=original', download_url: '/api/images/neutral-1?variant=original&download=1',
    source: 'nas', bytes: 128 }, 0);
  assert.match(html, /<button\b[^>]*data-image-index="0"/);
  assert.match(html, /href="#\/c\/%E7%BC%96%E7%9B%AE%E5%91%98\/%E6%98%9F%E5%9B%BE%20%26%20%E4%BA%91"/);
  assert.match(html, /星图 &lt;script&gt;/);
  assert.ok(html.includes(zh.images.types.gallery));
  assert.doesNotMatch(html, /<script>/);
});

test('权限和缺图错误显示不同状态，不误报为空库', async () => {
  const { imageErrorMessage, zh } = await images();
  assert.equal(imageErrorMessage({ status: 403 }), zh.images.permission_denied);
  assert.equal(imageErrorMessage({ status: 404 }), zh.images.not_found);
  assert.notEqual(imageErrorMessage({ status: 0 }), zh.images.empty);
});

test('下载网络失败显示下载提示，权限错误仍保留原权限说明', async () => {
  const { imageErrorMessage, zh } = await images();
  assert.equal(imageErrorMessage({ status: 503 }, { download: true }), zh.images.download_failed);
  assert.equal(imageErrorMessage({ status: 403 }, { download: true }), zh.images.permission_denied);
});

test('手机横滑切图，纵向滚动和多指缩放不误切图，离开后解绑', async () => {
  const { bindImageSwipe } = await images();
  assert.equal(typeof bindImageSwipe, 'function', '尚未提供手机切图手势');
  const stage = new EventTarget();
  let previous = 0, next = 0;
  const off = bindImageSwipe(stage, { previous: () => previous++, next: () => next++ });
  const fire = (type, id, x, y) => {
    const event = new Event(type);
    for (const [key, value] of Object.entries({ pointerId: id, pointerType: 'touch', clientX: x, clientY: y })) Object.defineProperty(event, key, { value });
    stage.dispatchEvent(event);
  };
  fire('pointerdown', 1, 200, 100); fire('pointerup', 1, 110, 105);
  assert.deepEqual([previous, next], [0, 1]);
  fire('pointerdown', 1, 100, 100); fire('pointerup', 1, 110, 210);
  assert.deepEqual([previous, next], [0, 1]);
  fire('pointerdown', 1, 100, 100); fire('pointerdown', 2, 150, 100);
  fire('pointerup', 2, 160, 100); fire('pointerup', 1, 190, 100);
  assert.deepEqual([previous, next], [0, 1]);
  fire('pointerdown', 1, 100, 100); fire('pointerup', 1, 190, 100);
  assert.deepEqual([previous, next], [1, 1]);
  off(); fire('pointerdown', 1, 200, 100); fire('pointerup', 1, 100, 100);
  assert.deepEqual([previous, next], [1, 1]);
});
