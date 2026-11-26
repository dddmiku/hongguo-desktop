// Real Electron: an expired continuation token must recover without a manual refresh.
import { quietElectron as electron } from './quiet-electron.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd(), out = path.join(root, '_work/catalog-pagination');
await mkdir(out, { recursive: true });
const installed = process.argv.includes('--installed'), packaged = process.argv.includes('--packaged');
const executable = installed
  ? process.env.HG_QA_EXECUTABLE || path.join(process.env.ProgramFiles, 'hongguo-desktop/红果桌面.exe')
  : process.env.HG_QA_PACKAGED_PATH || path.join(root, 'release/win-unpacked/红果桌面.exe');
const mode = installed ? 'installed' : packaged ? 'packaged' : 'source';
const profile = path.join(out, 'profile-' + mode);
const checks = [], errors = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(JSON.stringify(checks.at(-1))); if (!ok) process.exitCode = 1; };
let instance, page;
const series = (suffix, title) => ({ id: '9999999999999997' + suffix, title, cover: '', intro: '', totalEpisodes: 10, tags: [], actors: [] });
try {
  instance = await electron.launch({ ...(installed || packaged ? { executablePath: executable, args: [] } : { args: ['.'], cwd: root }),
    env: { ...process.env, HG_TEST_DATA_DIR: profile, HG_TEST_BACKGROUND: '1', TEMP: out, TMP: out }, timeout: 60000 });
  page = await instance.firstWindow();
  page.on('pageerror', error => errors.push(error.name));
  const actualProfile = await instance.evaluate(({ app }) => app.getPath('userData'));
  if (path.resolve(actualProfile) !== profile) throw new Error('QA profile is not isolated');
  await instance.evaluate(({ ipcMain }) => {
    const state = globalThis.__paginationAudit = { requests: [], firstPages: 0, expired: false, browseFirstPages: 0 };
    const rows = [1, 2, 3, 4].map((n) => ({ id: '99999999999999980' + n, title: '分页剧 ' + n, cover: '', intro: '', totalEpisodes: 10, tags: [], actors: [] }));
    const fixture = (route) => {
      const url = new URL(route, 'http://fixture.invalid');
      if (url.pathname === '/account/session') return { loggedIn: false, uid: '', nickname: '', avatar: '', mobile: '' };
      if (url.pathname.startsWith('/catalog/filters')) return { filters: { groups: [] } };
      if (url.pathname === '/catalog/browse') {
        state.requests.push({ path: url.pathname, cursor: url.searchParams.get('cursor'), theme: url.searchParams.get('theme'), refresh: url.searchParams.get('refresh') });
        if (!url.searchParams.get('cursor')) return { items: rows.slice(0, 2), hasMore: true, cursor: ++state.browseFirstPages === 1 ? 'expired-token' : 'fresh-token', filters: { groups: [] } };
        if (url.searchParams.get('cursor') === 'expired-token') return { detail: { code: 'CURSOR_EXPIRED', message: '片单已更新，请刷新后继续浏览' } };
        return { items: rows.slice(2), hasMore: false, cursor: '', filters: { groups: [] } };
      }
      if (url.pathname === '/catalog/rank') {
        state.requests.push({ path: url.pathname, cursor: url.searchParams.get('cursor'), refresh: url.searchParams.get('refresh') });
        if (!url.searchParams.get('cursor')) {
          state.firstPages++;
          return { items: rows.slice(0, 2), hasMore: true, cursor: state.firstPages === 1 ? 'expired-token' : 'fresh-token' };
        }
        if (url.searchParams.get('cursor') === 'expired-token') {
          state.expired = true;
          return { detail: { code: 'CURSOR_EXPIRED', message: '榜单已更新，请刷新后继续' } };
        }
        return { items: rows.slice(2), hasMore: false, cursor: '' };
      }
      if (url.pathname.startsWith('/catalog/')) return { items: [], hasMore: false, cursor: '' };
      if (route === '/media/cache/settings') return {};
      throw new Error('Unexpected fixture route');
    };
    ipcMain.removeHandler('api:request');
    // Mirror Supervisor's error shape: a non-ok HTTP response becomes an Error carrying `code`.
    ipcMain.handle('api:request', async (_event, route) => {
      const result = fixture(route);
      if (result?.detail?.code === 'CURSOR_EXPIRED') throw new Error(result.detail.message);
      return result;
    });
  });
  await page.waitForSelector('.app-shell');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('.app-shell');
  await page.getByRole('button', { name: '排行榜', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.series-card').length === 2);
  const before = await page.evaluate(() => [...document.querySelectorAll('.series-card')].map(card => card.dataset.seriesId));
  await page.getByRole('button', { name: '加载更多故事' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.series-card').length === 4 && !document.querySelector('.catalog-warning'), undefined, { timeout: 8000 });
  const after = await page.evaluate(() => ({
    ids: [...document.querySelectorAll('.series-card')].map(card => card.dataset.seriesId),
    warning: document.querySelector('.catalog-warning')?.textContent || '',
    recovered: document.querySelector('.catalog-recovered')?.textContent || '',
    loadMoreVisible: !!document.querySelector('.load-more'),
  }));
  const state = await instance.evaluate(() => globalThis.__paginationAudit);
  check('过期分页触发一次受控 CURSOR_EXPIRED', state.expired, state.requests);
  check('过期后自动重取同榜单首页并从新游标续页，无需手动刷新', state.requests.filter(request => !request.cursor).length === 2 && state.requests.some(request => request.cursor === 'fresh-token'), state.requests);
  check('续页结果真实追加且去重，结束后隐藏加载更多', after.ids.length === 4 && new Set(after.ids).size === 4 && after.ids.slice(0, 2).join() === before.join() && !after.loadMoreVisible && !after.warning && after.recovered.includes('榜单已更新') && after.recovered.includes('自动继续加载'), after);
  // 探索片库也走分页令牌；同一段自愈必须保留当前筛选条件。
  await page.getByRole('button', { name: '探索片库', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.series-card').length === 2, undefined, { timeout: 8000 });
  const browseBefore = await page.evaluate(() => [...document.querySelectorAll('.series-card')].map(card => card.dataset.seriesId));
  await page.getByRole('button', { name: '加载更多故事' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.series-card').length === 4 && !document.querySelector('.catalog-warning'), undefined, { timeout: 8000 });
  const browseState = await instance.evaluate(() => globalThis.__paginationAudit.requests.filter((request) => request.path === '/catalog/browse'));
  const browseAfter = await page.evaluate(() => [...document.querySelectorAll('.series-card')].map(card => card.dataset.seriesId));
  check('探索片库过期续页也自动重取同筛选首页并追加', browseState.filter((request) => !request.cursor && request.refresh === 'true').length === 1 && browseState.some((request) => request.cursor === 'fresh-token') && browseAfter.length === 4 && browseAfter.slice(0, 2).join() === browseBefore.join(), browseState);
  check('无渲染异常且测试实例静音隐藏', errors.length === 0 && await instance.evaluate(({ BrowserWindow, webContents }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()) && webContents.getAllWebContents().every(contents => contents.isAudioMuted())), errors);
} catch (error) {
  const diagnostic = page ? await page.evaluate(() => ({
    cards: [...document.querySelectorAll('.series-card')].map(card => card.dataset.seriesId),
    warning: document.querySelector('.catalog-warning')?.textContent || '',
    loadMore: !!document.querySelector('.load-more'),
    loadingText: document.querySelector('.load-more button')?.textContent || '',
  })).catch(() => null) : null;
  const audit = instance ? await instance.evaluate(() => globalThis.__paginationAudit || null).catch(() => null) : null;
  check('执行分页回归', false, { errorType: error.name, message: String(error.message).slice(0, 300), diagnostic, audit });
} finally {
  if (instance) { await instance.evaluate(({ app }) => app.quit()).catch(() => {}); await instance.close().catch(() => {}); }
  await writeFile(path.join(out, mode + '-result.json'), JSON.stringify({ checks, errors }, null, 2));
  if (checks.some(check => !check.ok)) process.exitCode = 1;
}
