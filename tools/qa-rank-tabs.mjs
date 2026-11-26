// Real Electron navigation with an isolated, silent guest profile and local API fixtures.
// Check the selected tab, displayed items and actual IPC requests together.
import { quietElectron as electron } from './quiet-electron.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd(), out = path.join(root, '_work/rank-tabs');
await mkdir(out, { recursive: true });
const installed = process.argv.includes('--installed'), packaged = process.argv.includes('--packaged');
const executable = installed
  ? process.env.HG_QA_EXECUTABLE || path.join(process.env.ProgramFiles, 'hongguo-desktop/红果桌面.exe')
  : process.env.HG_QA_PACKAGED_PATH || path.join(root, 'release/win-unpacked/红果桌面.exe');
const resultName = installed ? 'installed' : packaged ? 'packaged' : 'source';
const profile = path.join(out, 'profile-' + resultName);
const checks = [], errors = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(JSON.stringify(checks.at(-1)));
  if (!ok) process.exitCode = 1;
};
let instance, page;
const state = () => page.evaluate(() => ({
  active: document.querySelector('.genre-tabs button.active')?.textContent,
  heading: document.querySelector('.section-heading h2')?.textContent,
  ids: [...document.querySelectorAll('.series-card')].map(card => card.dataset.seriesId),
}));
const requests = () => instance.evaluate(() => globalThis.__rankAuditRequests);
const ids = { series: '9999999999999997701', comic_series: '9999999999999997702', ai_series: '9999999999999997703', short_play: '9999999999999997704' };
const titles = { series: '系列剧', comic_series: '漫剧', ai_series: 'AI 剧', short_play: '真人短剧' };
async function selectAndCheck(genre, name) {
  const before = (await requests()).length;
  await page.getByRole('tab', { name: titles[genre], exact: true }).click();
  let settled = true;
  try {
    await page.waitForFunction(({ title, id }) => document.querySelector('.genre-tabs button.active')?.textContent === title
      && document.querySelector('.series-card')?.dataset.seriesId === id,
    { title: titles[genre], id: ids[genre] }, { timeout: 1200 });
  } catch { settled = false; }
  const after = await state(), emitted = (await requests()).slice(before).filter(request => request.kind === 'rank');
  check(name, settled && emitted.some(request => request.genre === genre), { ...after, requests: emitted });
}
try {
  instance = await electron.launch({ ...(installed || packaged ? { executablePath: executable, args: [] } : { args: ['.'], cwd: root }),
    env: { ...process.env, HG_TEST_DATA_DIR: profile, HG_TEST_BACKGROUND: '1', TEMP: out, TMP: out }, timeout: 60000 });
  page = await instance.firstWindow();
  page.on('pageerror', error => errors.push(error.name));
  const actualProfile = await instance.evaluate(({ app }) => app.getPath('userData'));
  if (path.resolve(actualProfile) !== profile) throw new Error('QA profile is not isolated');
  await instance.evaluate(({ ipcMain }, fixtureIds) => {
    globalThis.__rankAuditRequests = [];
    const fixture = route => {
      if (route === '/account/session') return { loggedIn: false, uid: '', nickname: '', avatar: '', mobile: '' };
      const query = new URL(route, 'http://fixture.invalid'), genre = query.searchParams.get('genre') || 'short_play';
      if (query.pathname.startsWith('/catalog/filters')) return { filters: { groups: [] } };
      if (query.pathname.startsWith('/catalog/')) {
        globalThis.__rankAuditRequests.push({ kind: query.pathname.split('/').at(-1), genre, board: query.searchParams.get('board') });
        const id = fixtureIds[genre] || fixtureIds.short_play;
        return { items: [{ id, title: '受控片单 ' + genre, cover: '', intro: '', totalEpisodes: 10, tags: [], actors: [] }], hasMore: false, cursor: '' };
      }
      if (route === '/media/cache/settings') return {};
      throw new Error('Unexpected fixture route');
    };
    ipcMain.removeHandler('api:request');
    ipcMain.handle('api:request', (_event, route) => fixture(route));
  }, ids);
  await page.waitForSelector('.app-shell');
  // This storage belongs exclusively to the fixture profile checked above.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('.app-shell');
  const rankStart = (await requests()).length;
  await page.getByRole('button', { name: '排行榜', exact: true }).click();
  await page.waitForFunction(id => document.querySelector('.series-card')?.dataset.seriesId === id, ids.series);
  const tabs = await page.getByRole('tab').allTextContents();
  const initialRanks = (await requests()).slice(rankStart).filter(request => request.kind === 'rank');
  check('排行榜四类顺序正确且默认仅请求系列剧推荐榜', JSON.stringify(tabs) === JSON.stringify(['系列剧', '漫剧', 'AI 剧', '真人短剧'])
    && initialRanks.length > 0 && initialRanks.every(request => request.genre === 'series' && request.board === 'recommend'), { tabs, ...await state(), requests: initialRanks });
  await page.waitForTimeout(500);
  // Same as the parent genre: onGenre alone cannot trigger a render here.
  await selectAndCheck('short_play', '默认系列剧可立即切换至真人短剧（父级类型未变化）');
  await selectAndCheck('comic_series', '切换漫剧实际请求并显示漫剧片单');
  // Series has no parent onGenre callback; the tab must own reactive state.
  await selectAndCheck('series', '从漫剧切回系列剧立即请求并显示系列剧片单');
  await selectAndCheck('ai_series', '切换 AI 剧实际请求并显示 AI 片单');
  await page.getByRole('button', { name: '探索片库', exact: true }).click();
  await page.getByRole('tab', { name: '真人短剧', exact: true }).click();
  await page.waitForFunction(id => document.querySelector('.series-card')?.dataset.seriesId === id, ids.short_play);
  const afterBrowse = (await requests()).length;
  await page.getByRole('button', { name: '排行榜', exact: true }).click();
  await page.waitForFunction(id => document.querySelector('.series-card')?.dataset.seriesId === id, ids.ai_series);
  check('片库切分类不覆盖已选排行榜类型', (await state()).active === 'AI 剧'
    && (await requests()).slice(afterBrowse).some(request => request.kind === 'rank' && request.genre === 'ai_series'), await state());
  await selectAndCheck('short_play', '已在片库选择真人短剧后排行榜仍可切换到真人短剧');
  await selectAndCheck('series', '跨页面返回后仍能切回系列剧');
  check('隔离窗口隐藏且静音', await instance.evaluate(({ BrowserWindow, webContents }) => BrowserWindow.getAllWindows().every(window => !window.isVisible())
    && webContents.getAllWebContents().every(contents => contents.isAudioMuted())));
  check('无渲染异常', errors.length === 0, { errors });
} catch (error) {
  checks.push({ name: '排行榜回归执行失败', ok: false, error: error.name });
  console.error('排行榜回归未完成：' + error.name);
  process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(out, 'failure-' + resultName + '.png') }).catch(() => {});
} finally {
  await writeFile(path.join(out, 'result-' + resultName + '.json'), JSON.stringify({ checks, errors }, null, 2));
  if (instance) { await instance.evaluate(({ app }) => app.quit()).catch(() => {}); await instance.close().catch(() => {}); }
}
