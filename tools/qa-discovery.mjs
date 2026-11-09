// Real upstream replies, isolated background profile, muted Electron. No account login or production data.
import { quietElectron as electron } from './quiet-electron.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(), out = path.join(root, '_work', 'discovery-qa');
await mkdir(out, { recursive: true });
const instance = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, HG_TEST_DATA_DIR: path.join(out, 'profile'), HG_TEST_BACKGROUND: '1', TEMP: out, TMP: out }, timeout: 60000 });
const page = await instance.firstWindow(), checks = [], errors = [];
page.on('pageerror', error => errors.push(error.name));
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(JSON.stringify(checks.at(-1))); if (!ok) throw new Error(name); };
const requests = () => instance.evaluate(() => globalThis.__discoveryRequests || []);
async function waitBoard(genre, board) {
  const deadline = Date.now() + 50000;
  while (Date.now() < deadline) {
    const row = (await requests()).find(row => row.route === `/catalog/rank?board=${board}&genre=${genre}` && row.status === 200);
    if (row) return row;
    await page.waitForTimeout(150);
  }
  throw new Error(`真实 ${genre}/${board} 片单未完成`);
}
async function loadedImages() {
  await page.waitForFunction(() => [...document.querySelectorAll('.discovery-content img')].filter(img => { const box = img.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight; }).every(img => img.complete && img.naturalWidth > 0), undefined, { timeout: 40000 });
}
try {
  await instance.evaluate(() => {
    globalThis.__discoveryRequests = []; globalThis.__discoveryOffline = false;
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const url = new URL(String(args[0]));
      if (!url.pathname.startsWith('/catalog/')) return original(...args);
      const row = { route: url.pathname + url.search, started: Date.now() }; globalThis.__discoveryRequests.push(row);
      if (globalThis.__discoveryOffline) { row.failed = true; throw new Error('QA isolated offline'); }
      // A real response is delayed to prove secondary sections do not hold up the hero.
      if (url.pathname === '/catalog/rank') await new Promise(resolve => setTimeout(resolve, 1800));
      const response = await original(...args), data = await response.clone().json();
      Object.assign(row, { status: response.status, ms: Date.now() - row.started, items: (data.items || []).map(item => ({ id: item.id, title: item.title, tags: item.tags })) });
      return response;
    };
  });
  await page.waitForSelector('.app-shell', { timeout: 60000 });
  await page.evaluate(() => localStorage.setItem('hongguo:catalog-selection-v1', JSON.stringify([['discover:short_play', { board: 'hot', sort: 'hot_score', theme: 'cate_5000', setting: 'cate_5221', background: 'cate_5338', expanded: true }]])));
  await page.reload();
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
  await page.waitForSelector('.discovery-hero-copy h2', { timeout: 90000 });
  for (let n = 0; n < 15 && !(await requests()).some(row => row.route === '/catalog/home?genre=short_play&mode=discover'); n++) await page.waitForTimeout(50);
  const firstRoutes = await requests();
  check('旧发现分类不再切成片库，首屏主视觉不等待榜单', !await page.locator('.category-shelf').count() && firstRoutes.some(row => row.route === '/catalog/home?genre=short_play&mode=discover') && !firstRoutes.some(row => row.route.startsWith('/catalog/browse') || row.route.startsWith('/catalog/filters')) && !firstRoutes.some(row => row.route.startsWith('/catalog/rank') && row.status), { routes: firstRoutes.map(row => row.route) });
  const hot = await waitBoard('short_play', 'hot'), latest = await waitBoard('short_play', 'new');
  await page.waitForFunction(() => document.querySelectorAll('.discovery-latest-strip .series-card').length > 0, undefined, { timeout: 10000 });
  const regions = await page.evaluate(() => ({ hero: document.querySelector('.discovery-hero')?.dataset.seriesId, hot: [...document.querySelectorAll('.discovery-hot-card')].map(node => node.dataset.seriesId), latest: [...document.querySelectorAll('.discovery-latest-strip [data-series-id]')].map(node => node.dataset.seriesId), all: [...document.querySelectorAll('.discovery-content [data-series-id]')].map(node => node.dataset.seriesId), topics: [...document.querySelectorAll('.discovery-topic')].map(node => ({ name: node.querySelector('h3').textContent, ids: [...node.querySelectorAll('[data-series-id]')].map(node => node.dataset.seriesId) })) }));
  const home = (await requests()).find(row => row.route === '/catalog/home?genre=short_play&mode=discover' && row.status === 200);
  check('主视觉、热播、新剧、主题、更多发现无重复作品', new Set(regions.all).size === regions.all.length && regions.hero === home.items[0].id && regions.hot.every(id => hot.items.some(row => row.id === id)) && regions.latest.every(id => latest.items.some(row => row.id === id)), { counts: { all: regions.all.length, hot: regions.hot.length, new: regions.latest.length, topics: regions.topics.length }, ids: regions.all });
  check('主题来自上游真实作品标签', regions.topics.length > 0 && regions.topics.every(topic => topic.ids.every(id => home.items.some(row => row.id === id && row.tags.includes(topic.name)))), { topics: regions.topics });
  await loadedImages(); await page.screenshot({ path: path.join(out, 'discover-wide.png') });
  check('主视觉与热播真实图片完成加载', await page.locator('.discovery-hero-poster img').evaluate(img => img.complete && img.naturalWidth > 0));

  const favorite = page.locator('.discovery-hero-favorite'), beforeFavorite = await favorite.getAttribute('aria-label');
  await favorite.click(); await page.waitForFunction(label => document.querySelector('.discovery-hero-favorite')?.getAttribute('aria-label') !== label, beforeFavorite);
  const library = await page.evaluate(() => window.hongguo.getLibrary());
  check('主视觉收藏实际写入独立本地片库', library.favorites.some(row => row.id === regions.hero));
  await favorite.click();
  await page.getByRole('button', { name: '查看剧集', exact: true }).click(); await page.waitForSelector('.detail-hero', { timeout: 60000 });
  check('主视觉详情打开同一真实剧集', await page.locator('.detail-hero h2').textContent() === home.items[0].title);
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();

  await page.locator('.content-scroll').evaluate(node => { node.scrollTop = 680; }); await loadedImages(); await page.screenshot({ path: path.join(out, 'discover-sections.png') });
  const previousScroll = await page.locator('.content-scroll').evaluate(node => node.scrollTop);
  await instance.evaluate(() => { globalThis.__discoveryOffline = true; });
  await page.locator('.top-nav').getByRole('button', { name: '探索片库', exact: true }).click();
  await page.locator('.top-nav').getByRole('button', { name: '发现', exact: true }).click();
  await page.waitForSelector('.discovery-hero-copy h2', { timeout: 1000 }); await page.waitForTimeout(900);
  const retained = await page.locator('.discovery-content [data-series-id]').evaluateAll(nodes => nodes.map(node => node.dataset.seriesId));
  const restoredScroll = await page.locator('.content-scroll').evaluate(node => node.scrollTop);
  check('模拟断网切页保留已有发现片单与滚动位置', regions.all.length === retained.length && regions.all.every(id => retained.includes(id)) && Math.abs(previousScroll - restoredScroll) <= 2, { previousScroll, restoredScroll, count: retained.length });
  await instance.evaluate(() => { globalThis.__discoveryOffline = false; });

  await page.locator('.content-scroll').evaluate(node => { node.scrollTop = 0; });
  await page.getByRole('button', { name: '完整榜单', exact: true }).click(); await page.waitForSelector('.chips .chip.active');
  check('发现更多热播进入真实排行榜', await page.getByRole('heading', { name: '热播排行榜', exact: true }).isVisible());
  await page.locator('.top-nav').getByRole('button', { name: '发现', exact: true }).click();
  await page.getByRole('button', { name: '更多题材', exact: true }).click(); await page.waitForSelector('.category-shelf');
  check('完整题材设定背景留在探索片库', await page.getByRole('heading', { name: '探索片库', exact: true }).isVisible() && await page.getByRole('button', { name: /全部分类|收起分类/ }).count() === 1);
  await page.locator('.top-nav').getByRole('button', { name: '发现', exact: true }).click();
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 800));
  await page.locator('.content-scroll').evaluate(node => { node.scrollTop = 0; }); await loadedImages(); await page.screenshot({ path: path.join(out, 'discover-narrow.png') });
  const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, content: document.querySelector('.content-scroll').scrollWidth }));
  check('960像素窗口无横向溢出且保留主视觉', width.document <= width.viewport && width.content <= width.viewport && await page.locator('.discovery-hero-poster').isVisible(), width);
  await page.getByRole('button', { name: '向右浏览新上架', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.discovery-latest-strip').scrollLeft > 0);
  check('窄窗口新上架左右按钮实际滚动片单', await page.locator('.discovery-latest-strip').evaluate(node => node.scrollLeft) > 0);
  await page.getByRole('button', { name: '向左浏览新上架', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.discovery-latest-strip').scrollLeft < 1);
  for (const [genre, name] of [['comic_series', '漫剧'], ['ai_series', 'AI 剧']]) {
    const before = (await requests()).length;
    await page.getByRole('tab', { name, exact: true }).click();
    const deadline = Date.now() + 90000;
    let data;
    while (Date.now() < deadline) {
      data = (await requests()).slice(before).find(row => row.route === `/catalog/home?genre=${genre}&mode=discover` && row.status === 200);
      if (data) break;
      await page.waitForTimeout(150);
    }
    if (!data?.items.length) throw new Error(`真实${name}发现流没有作品`);
    await page.waitForFunction(title => document.querySelector('.discovery-hero-copy h2')?.textContent === title, data.items[0].title);
    await waitBoard(genre, 'hot'); await waitBoard(genre, 'new'); await page.waitForTimeout(100);
    await loadedImages(); await page.screenshot({ path: path.join(out, `discover-${genre}.png`) });
    const genreRows = (await requests()).slice(before);
    const visible = await page.locator('.discovery-content [data-series-id]').evaluateAll(nodes => nodes.map(node => node.dataset.seriesId));
    check(`真实${name}发现展示正确作品类型且不载完整分类`, !genreRows.some(row => row.route.startsWith('/catalog/filters') || row.route.startsWith('/catalog/browse')) && new Set(visible).size === visible.length, { hero: data.items[0].title, count: visible.length, routes: genreRows.map(row => row.route) });
  }
  check('后台窗口静音且不可见，未触碰正式资料', await instance.evaluate(({ BrowserWindow, webContents }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()) && webContents.getAllWebContents().every(contents => contents.isAudioMuted())));
  check('发现页无渲染异常', errors.length === 0, errors);
} catch (error) {
  checks.push({ name: '发现验收', ok: false, error: error.name, message: error.message }); console.error(error.name + ': ' + error.message); process.exitCode = 1;
  await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
} finally {
  await writeFile(path.join(out, checks.some(row => !row.ok) ? 'failed-result.json' : 'result.json'), JSON.stringify({ checks, errors, requests: await requests() }, null, 2));
  await instance.evaluate(({ app }) => app.quit()).catch(() => {}); await instance.close().catch(() => {});
}
