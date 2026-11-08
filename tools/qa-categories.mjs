// Exercise the real Electron bridge and gateway; every catalog reply comes from the upstream.
import {quietElectron as electron} from './quiet-electron.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(), out = path.join(root, '_work', 'category-ui-qa');
await mkdir(out, { recursive: true });
const instance = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env,
  HG_TEST_DATA_DIR: path.join(root, '_work', 'category-ui-data'), TEMP: out, TMP: out }, timeout: 60000 });
const page = await instance.firstWindow(), checks = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail }); console.log(JSON.stringify(checks.at(-1)));
  if (!ok) throw new Error(name + ': ' + JSON.stringify(detail));
};

await instance.evaluate(() => {
  globalThis.__categoryRequests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const address = new URL(String(args[0]));
    if (!address.pathname.startsWith('/catalog/')) return original(...args);
    const row = { route: address.pathname + address.search, started: Date.now() };
    globalThis.__categoryRequests.push(row);
    const response = await original(...args);
    const data = await response.clone().json();
    Object.assign(row, { status: response.status, ms: Date.now() - row.started,
      items: (data.items || []).map(item => ({ id: item.id, title: item.title, tags: item.tags })),
      filters: data.filters, hasMore: data.hasMore, cursor: data.cursor });
    return response;
  };
});
const requestCount = () => instance.evaluate(() => globalThis.__categoryRequests.length);
const requests = () => instance.evaluate(() => globalThis.__categoryRequests);
async function waitRequest(after, wanted) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const found = (await requests()).slice(after).find(row => row.status && wanted(new URL(row.route, 'http://local')));
    if (found) { if (found.status !== 200) throw new Error('Category HTTP ' + found.status); return found; }
    await page.waitForTimeout(100);
  }
  throw new Error('No completed real category request');
}
async function rendered(row) {
  await page.waitForFunction(titles => {
    const current = [...document.querySelectorAll('.catalog-page .series-title')].map(node => node.textContent);
    return !document.querySelector('.catalog-page .refresh-button')?.disabled && titles.every(title => current.includes(title));
  }, row.items.map(item => item.title), { timeout: 10000 });
}
async function chooseTheme(name, id) {
  const before = await requestCount();
  await page.getByRole('group', { name: '题材', exact: true }).getByRole('button', { name, exact: true }).click();
  const row = await waitRequest(before, url => url.pathname === '/catalog/browse' && url.searchParams.get('theme') === id && !url.searchParams.get('cursor'));
  await rendered(row);
  check(`真实${name}分类请求与结果`, row.items.length > 0 && row.items.every(item => item.tags.includes(name)),
    { route: row.route, count: row.items.length, matchingTags: row.items.filter(item => item.tags.includes(name)).length, ms: row.ms, examples: row.items.slice(0, 3) });
  return row;
}

try {
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1440, height: 1000 }));
  await page.waitForSelector('.app-shell', { timeout: 30000 });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.theme-options').getByRole('button', { name: '深色', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.getByRole('button', { name: '发现', exact: true }).click();
  const panel = await page.evaluate(() => window.hongguo.request('/catalog/filters?genre=short_play'));
  const themes = panel.filters.groups.find(group => group.type === 'category_dim_theme').items;
  const ids = Object.fromEntries(themes.map(option => [option.name, option.id]));
  check('分类面板来自真实上游且保留三维选项', ['动作', '爱情', '年代', '传奇'].every(name => ids[name]) && panel.filters.groups.length === 3,
    { groups: panel.filters.groups.map(group => ({ type: group.type, name: group.name, count: group.items.length })), shortcutIds: Object.fromEntries(['动作', '爱情', '年代', '传奇'].map(name => [name, ids[name]])) });
  await page.waitForSelector('.category-theme button', { timeout: 90000 });
  const reset = page.getByRole('button', { name: '重置筛选', exact: true });
  if (await reset.count()) { await reset.click(); await page.waitForFunction(() => !document.querySelector('.category-selection')); }
  if (await page.getByRole('button', { name: '收起分类', exact: true }).count()) await page.getByRole('button', { name: '收起分类', exact: true }).click();
  check('首页直接可见四个常用分类', (await Promise.all(['动作', '爱情', '年代', '传奇'].map(name => page.getByRole('group', { name: '题材', exact: true }).getByRole('button', { name, exact: true }).isVisible()))).every(Boolean));
  await page.screenshot({ path: path.join(out, 'home-categories.png') });

  await chooseTheme('动作', ids['动作']);
  const love = await chooseTheme('爱情', ids['爱情']);
  check('爱情题材真实提供后续页', love.hasMore && !!love.cursor, { hasMore: love.hasMore });
  const beforeMore = await requestCount();
  await page.getByRole('button', { name: '加载更多故事', exact: true }).click();
  const second = await waitRequest(beforeMore, url => url.pathname === '/catalog/browse' && url.searchParams.get('theme') === ids['爱情'] && !!url.searchParams.get('cursor'));
  await rendered(second);
  const unique = new Set([...love.items, ...second.items].map(item => item.id));
  check('分类分页继续同一题材且展示真实新作品', second.items.length > 0 && second.items.every(item => item.tags.includes('爱情')) && unique.size > love.items.length && await page.locator('.catalog-page .series-card').count() === unique.size,
    { route: second.route, previous: love.items.length, newItems: second.items.length, visible: unique.size, examples: second.items.slice(0, 2) });
  const era = await chooseTheme('年代', ids['年代']);
  check('切换分类重新从第一页展示', await page.locator('.catalog-page .series-card').count() === era.items.length, { count: era.items.length, route: era.route });
  await chooseTheme('传奇', ids['传奇']);

  let before = await requestCount();
  await page.getByRole('button', { name: '探索片库', exact: true }).click();
  let row = await waitRequest(before, url => url.pathname === '/catalog/browse' && url.searchParams.get('genre') === 'short_play');
  await rendered(row);
  if (await reset.count()) { before = await requestCount(); await reset.click(); row = await waitRequest(before, url => url.pathname === '/catalog/browse' && !url.searchParams.get('theme') && !url.searchParams.get('setting') && !url.searchParams.get('background')); await rendered(row); }
  if (await page.getByRole('button', { name: '全部分类', exact: true }).count()) await page.getByRole('button', { name: '全部分类', exact: true }).click();
  const grid = await page.locator('.category-theme .category-options').evaluate(node => ({ display: getComputedStyle(node).display, columns: getComputedStyle(node).gridTemplateColumns.split(' ').length, count: node.children.length }));
  check('展开分类展示真实多列题材、设定和背景', grid.display === 'grid' && grid.columns >= 4 && await page.getByRole('group', { name: '设定', exact: true }).isVisible() && await page.getByRole('group', { name: '背景', exact: true }).isVisible(), grid);

  const backgrounds = panel.filters.groups.find(group => group.type === 'category_dim_epoch').items;
  const modern = backgrounds.find(option => option.name === '现代') || backgrounds[0];
  before = await requestCount();
  await page.getByRole('group', { name: '背景', exact: true }).getByRole('button', { name: modern.name, exact: true }).click();
  row = await waitRequest(before, url => url.pathname === '/catalog/browse' && url.searchParams.get('background') === modern.id);
  await rendered(row);
  const roles = panel.filters.groups.find(group => group.type === 'category_dim_role').items;
  const role = roles.find(option => row.items.some(item => item.tags.includes(option.name)));
  check('背景筛选真实请求与结果字段匹配', row.items.length > 0 && row.items.every(item => item.tags.includes(modern.name)), { route: row.route, examples: row.items.slice(0, 2) });
  if (!role) throw new Error('No real role intersection in the selected background');
  before = await requestCount();
  await page.getByRole('group', { name: '设定', exact: true }).getByRole('button', { name: role.name, exact: true }).click();
  row = await waitRequest(before, url => url.pathname === '/catalog/browse' && url.searchParams.get('setting') === role.id && url.searchParams.get('background') === modern.id);
  await rendered(row);
  check('设定与背景组合对应真实片单', row.items.length > 0 && row.items.every(item => item.tags.includes(role.name) && item.tags.includes(modern.name)), { route: row.route, count: row.items.length, examples: row.items.slice(0, 2) });
  await page.locator('.content-scroll').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: path.join(out, 'expanded-dark.png') });

  before = await requestCount();
  await page.getByRole('tab', { name: '漫剧', exact: true }).click();
  const comic = await waitRequest(before, url => url.pathname === '/catalog/browse' && url.searchParams.get('genre') === 'comic_series');
  await rendered(comic);
  check('切换作品类型不会发送真人的筛选 ID', !new URL(comic.route, 'http://local').searchParams.get('setting') && !new URL(comic.route, 'http://local').searchParams.get('background'), { route: comic.route, count: comic.items.length });
  before = await requestCount();
  await page.getByRole('tab', { name: '真人短剧', exact: true }).click();
  row = await waitRequest(before, url => url.pathname === '/catalog/browse' && url.searchParams.get('genre') === 'short_play' && url.searchParams.get('setting') === role.id && url.searchParams.get('background') === modern.id);
  await rendered(row);
  check('返回真人分类恢复原设定、背景和展开状态', await page.getByRole('group', { name: '设定', exact: true }).getByRole('button', { name: role.name, exact: true }).getAttribute('aria-pressed') === 'true' && await page.getByRole('button', { name: '收起分类', exact: true }).count() === 1, { route: row.route });

  const expectedTitles = row.items.map(item => item.title);
  await page.getByRole('button', { name: '我的收藏', exact: true }).click();
  const returning = Date.now();
  await page.getByRole('button', { name: '探索片库', exact: true }).click();
  await page.locator('.catalog-page .series-card').first().waitFor({ timeout: 800 });
  const visibleTitles = await page.locator('.catalog-page .series-title').allTextContents();
  check('离开片库再返回恢复缓存片单与筛选', expectedTitles.every(title => visibleTitles.includes(title)) && await page.getByRole('group', { name: '背景', exact: true }).getByRole('button', { name: modern.name, exact: true }).getAttribute('aria-pressed') === 'true', { ms: Date.now() - returning, count: visibleTitles.length });
  await page.reload();
  await page.getByRole('button', { name: '探索片库', exact: true }).click();
  await page.locator('.catalog-page .series-card').first().waitFor({ timeout: 1200 });
  check('重启页面保留公开分类偏好与片单缓存', await page.getByRole('group', { name: '背景', exact: true }).getByRole('button', { name: modern.name, exact: true }).getAttribute('aria-pressed') === 'true');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.theme-options').getByRole('button', { name: '浅色', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.getByRole('button', { name: '探索片库', exact: true }).click();
  await page.locator('.content-scroll').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: path.join(out, 'expanded-light.png') });
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 800));
  await page.waitForTimeout(150);
  const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  check('窄窗口分类与入口没有横向溢出', width.document <= width.viewport, width);
  await page.locator('.content-scroll').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: path.join(out, 'expanded-narrow.png') });
  check('界面没有运行异常', errors.length === 0, { errors });
} catch (error) {
  checks.push({ name: '分类验收', ok: false, error: error.message }); console.error(error.stack); process.exitCode = 1;
  await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
} finally {
  await writeFile(path.join(out, checks.some(row => !row.ok) ? 'failed-result.json' : 'result.json'), JSON.stringify({ checks, errors, requests: await requests() }, null, 2));
  await instance.evaluate(({ app }) => app.quit()).catch(() => {}); await instance.close().catch(() => {});
}
