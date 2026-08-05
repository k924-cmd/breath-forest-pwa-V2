import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';

const frontendUrl = new URL('../', import.meta.url);

async function readFrontendFile(path) {
  return readFile(new URL(path, frontendUrl), 'utf8');
}

function inlineBootstrap(html) {
  const match = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(match, 'index.html 应包含内联启动恢复脚本');
  return match[1];
}

test('入口先恢复本地 Service Worker/缓存，再动态导入版本化 main', async () => {
  const [html, serviceWorker] = await Promise.all([
    readFrontendFile('index.html'),
    readFrontendFile('sw.js')
  ]);
  const bootstrap = inlineBootstrap(html);
  assert.doesNotMatch(html, /<script[^>]+type=["']module["'][^>]+src=/);
  assert.match(bootstrap, /getRegistrations\(\)/);
  assert.match(bootstrap, /registration => registration\.unregister\(\)/);
  assert.match(bootstrap, /cacheName\.startsWith\(CACHE_PREFIX\)/);
  assert.match(bootstrap, /await import\(`\.\/src\/main\.js\?v=\$\{APP_VERSION\}`\)/);
  assert.ok(bootstrap.indexOf('await clearLocalAppCaches()') < bootstrap.indexOf('await import('));

  const version = bootstrap.match(/APP_VERSION = '([^']+)'/)?.[1];
  assert.ok(version);
  assert.match(html, new RegExp(`styles\\.css\\?v=${version}`));
  assert.match(serviceWorker, new RegExp(`src/main\\.js\\?v=${version}`));
});

test('前端模块图的相对 JS 导入全部使用入口版本号', async () => {
  const html = await readFrontendFile('index.html');
  const version = inlineBootstrap(html).match(/APP_VERSION = '([^']+)'/)?.[1];
  const sourceRoot = new URL('src/', frontendUrl);
  const sourceFiles = (await readdir(sourceRoot, { recursive: true }))
    .filter(path => path.endsWith('.js'));
  let importCount = 0;

  for (const path of sourceFiles) {
    const source = await readFile(new URL(path.replaceAll('\\', '/'), sourceRoot), 'utf8');
    for (const match of source.matchAll(/from\s+['"](\.\.?\/[^'"]+\.js)(?:\?v=([^'"]+))?['"]/g)) {
      importCount += 1;
      assert.equal(match[2], version, `${path} 的 ${match[1]} 未绑定当前入口版本`);
    }
  }

  assert.ok(importCount > 0);
});

test('旧 Service Worker 控制页面时，入口独立注销并只清理呼吸森林缓存后重载', async () => {
  const html = await readFrontendFile('index.html');
  const version = inlineBootstrap(html).match(/APP_VERSION = '([^']+)'/)?.[1];
  const events = [];
  const context = {
    URL,
    Promise,
    console: { error: (...args) => events.push(`error:${args.length}`) },
    location: {
      hostname: '127.0.0.1',
      href: 'http://127.0.0.1:4173/',
      replace: value => events.push(`replace:${value}`)
    },
    history: { replaceState: () => events.push('history') },
    navigator: {
      serviceWorker: {
        controller: { state: 'activated' },
        getRegistrations: async () => [{ unregister: async () => { events.push('unregister'); return true; } }]
      }
    },
    caches: {
      keys: async () => {
        events.push('cache-keys');
        return ['breath-forest-ui-v2', 'another-app-cache'];
      },
      delete: async name => {
        events.push(`delete:${name}`);
        return true;
      }
    },
    document: {
      querySelector: () => ({ replaceChildren: () => {} }),
      createElement: () => ({ textContent: '' })
    }
  };
  context.window = context;
  vm.runInNewContext(inlineBootstrap(html), context, { filename: 'index-bootstrap.js' });
  await context.window.__BREATH_FOREST_BOOTSTRAP__;

  assert.deepEqual(events.slice(0, 3), ['unregister', 'cache-keys', 'delete:breath-forest-ui-v2']);
  assert.equal(events.some(event => event === 'delete:another-app-cache'), false);
  const replacement = events.find(event => event.startsWith('replace:'));
  assert.match(replacement, new RegExp(`bf-bootstrap=${version}`));
  assert.equal(events.some(event => event.startsWith('error:')), false);
});
