// Final installed binary smoke test. Playback uses a separate, logged-out profile.
import { _electron as electron } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(), out = path.join(root, '_work', 'installed-final-qa');
await mkdir(out, { recursive: true });
const executable = path.join(process.env.LOCALAPPDATA, 'Programs', 'hongguo-desktop', '红果桌面.exe');
const env = { ...process.env, TEMP: out, TMP: out, HG_TEST_DATA_DIR: path.join(root, '_work', 'installed-final-data') };
const instance = await electron.launch({ executablePath: executable, args: [], env, timeout: 60000 });
const page = await instance.firstWindow(), checks = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail }); console.log(JSON.stringify(checks.at(-1)));
  if (!ok) throw new Error(name);
};
await instance.evaluate(() => {
  globalThis.__installedCatalog = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const url = new URL(String(args[0]));
    const response = await original(...args);
    if (url.pathname === '/catalog/browse') {
      const data = await response.clone().json();
      globalThis.__installedCatalog.push({ route: url.pathname + url.search, status: response.status,
        items: (data.items || []).map(item => ({ id: item.id, title: item.title, tags: item.tags })) });
    }
    return response;
  };
});
async function lastCategory(theme, after) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const found = await instance.evaluate(({ theme, after }) => globalThis.__installedCatalog.slice(after).find(row => new URL(row.route, 'http://local').searchParams.get('theme') === theme), { theme, after });
    if (found) return found;
    await page.waitForTimeout(100);
  }
  throw new Error('Installed category request timed out');
}
try {
  await page.waitForSelector('.app-shell', { timeout: 30000 });
  const state = await page.evaluate(async () => ({ health: await window.hongguo.request('/health'), session: await window.hongguo.request('/account/session') }));
  check('最终安装版版本和独立测试配置', state.health.ok && state.health.signer && state.health.version === '1.1.0' && !state.session.loggedIn,
    { version: state.health.version, healthy: state.health.ok, signer: state.health.signer, loggedOut: !state.session.loggedIn });
  const filters = await page.evaluate(() => window.hongguo.request('/catalog/filters?genre=short_play'));
  const options = filters.filters.groups.find(group => group.type === 'category_dim_theme').items;
  await page.waitForSelector('.category-theme button', { timeout: 90000 });
  for (const name of ['动作', '爱情', '年代', '传奇']) {
    const option = options.find(item => item.name === name);
    const before = await instance.evaluate(() => globalThis.__installedCatalog.length);
    await page.getByRole('group', { name: '题材', exact: true }).getByRole('button', { name, exact: true }).click();
    const reply = await lastCategory(option.id, before);
    await page.waitForFunction(titles => {
      const current = [...document.querySelectorAll('.catalog-page .series-title')].map(node => node.textContent);
      return !document.querySelector('.catalog-page .refresh-button')?.disabled && titles.every(title => current.includes(title));
    }, reply.items.map(item => item.title));
    check(`安装版${name}入口与真实结果`, reply.status === 200 && reply.items.length > 0 && reply.items.every(item => item.tags.includes(name)),
      { route: reply.route, count: reply.items.length, matching: reply.items.filter(item => item.tags.includes(name)).length });
  }
  await page.screenshot({ path: path.join(out, 'installed-categories.png') });

  await page.evaluate(() => window.hongguo.saveSettings({ quality: '1080p', rate: 1, autoplay: false, volume: 0 }));
  await page.reload(); await page.waitForSelector('.app-shell');
  await page.evaluate(() => window.hongguo.request('/media/cache/clear', { method: 'POST' }));
  const query = '人前小保姆';
  await page.getByLabel('搜索剧名、演员或关键词').fill(query);
  await page.getByLabel('搜索剧名、演员或关键词').press('Enter');
  const card = page.locator('.series-card').filter({ hasText: query }).first();
  await card.waitFor({ timeout: 90000 }); await card.locator('.series-poster-button').click();
  await page.waitForSelector('.detail-hero', { timeout: 90000 });
  const start = Date.now();
  await page.getByRole('dialog').locator('.episode-grid button').first().click();
  await page.waitForFunction(() => {
    const video = document.querySelector('video[data-active=true]');
    return video?.videoWidth > 0 && video.currentTime > .1 && !video.paused;
  }, undefined, { timeout: 180000 });
  const samples = [];
  for (let n = 0; n < 12; n++) {
    samples.push(await page.evaluate(() => {
      const video = document.querySelector('video[data-active=true]'), slider = document.querySelector('input[aria-label="播放进度"]');
      return { position: video.currentTime, mediaDuration: Number.isFinite(video.duration) ? video.duration : null,
        total: Number(slider.max), width: video.videoWidth, height: video.videoHeight, paused: video.paused };
    }));
    await page.waitForTimeout(250);
  }
  check('安装版冷播放使用完整179.42秒总长且保持稳定', samples.every(item => item.width > 0 && Math.abs(item.total - 179.42) < .05) && new Set(samples.map(item => item.total)).size === 1,
    { firstPlayingMs: Date.now() - start - 3000, total: samples[0].total, samples });
  await page.keyboard.press('k');
  await page.screenshot({ path: path.join(out, 'installed-timeline.png') });
  const dataPath = await instance.evaluate(({ app }) => app.getPath('userData'));
  const stored = JSON.parse(await readFile(path.join(dataPath, 'library.json'), 'utf8'));
  check('测试播放没有真实账号云同步队列', Object.keys(stored.outbox || {}).length === 0, { pending: Object.keys(stored.outbox || {}).length });
  check('最终安装版没有渲染异常', errors.length === 0, { errors });
} catch (error) {
  checks.push({ name: '最终安装版简验', ok: false, error: error.message }); console.error(error.stack); process.exitCode = 1;
  await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
} finally {
  await writeFile(path.join(out, 'isolated-result.json'), JSON.stringify({ checks, errors }, null, 2));
  await instance.evaluate(({ app }) => app.quit()).catch(() => {}); await instance.close().catch(() => {});
}
