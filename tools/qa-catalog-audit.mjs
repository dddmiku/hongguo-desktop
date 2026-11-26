// Real App/Catalog lifecycle: account changes while search is in flight.
// Only synthetic account events and local fixtures; no real login or profile changes.
import { quietElectron as electron } from './quiet-electron.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(), out = path.join(root, '_work/catalog-isolation-audit');
await mkdir(out, { recursive: true });
const installed = process.argv.includes('--installed');
const packaged = process.argv.includes('--packaged');
const mode = installed ? 'installed' : packaged ? 'packaged' : 'source';
const profile = path.join(out, 'profile-' + mode);
const executablePath = installed
  ? process.env.HG_QA_EXECUTABLE || path.join(process.env.ProgramFiles, 'hongguo-desktop/红果桌面.exe')
  : process.env.HG_QA_PACKAGED_PATH || path.join(root, 'release/win-unpacked/红果桌面.exe');
const checks = [];
let instance, page;
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail }); console.log(JSON.stringify(checks.at(-1)));
  if (!ok) process.exitCode = 1;
};
const calls = () => instance.evaluate(() => globalThis.__catalogAudit.requests);
try {
  instance = await electron.launch({
    ...(installed || packaged ? { executablePath, args: [] } : { args: ['.'], cwd: root }),
    env: { ...process.env, HG_TEST_DATA_DIR: profile, HG_TEST_BACKGROUND: '1', TEMP: out, TMP: out },
    timeout: 60000,
  });
  page = await instance.firstWindow();
  if (path.resolve(await instance.evaluate(({ app }) => app.getPath('userData'))) !== profile) throw new Error('Profile isolation failed');
  await instance.evaluate(({ ipcMain }) => {
    const audit = globalThis.__catalogAudit = { account: 'fixture-a', requests: [], pending: [], hold: false };
    const series = (account, query = '') => ({ id: (account === 'fixture-a' ? '88887777' : '88887778') + (query === '隔离测试二' ? '02' : '01'), title: account + (query ? ':' + query : ''),
      cover: '', intro: '', totalEpisodes: 10, tags: [], actors: [] });
    ipcMain.removeHandler('api:request');
    ipcMain.handle('api:request', async (_event, route) => {
      if (route === '/account/session') return { loggedIn: true, uid: audit.account, nickname: '受控账号', mobile: '', avatar: '' };
      const url = new URL(route, 'http://fixture.invalid');
      if (url.pathname === '/catalog/search') {
        const account = audit.account;
        audit.requests.push({ account, query: url.searchParams.get('q') });
        const payload = { items: [series(account, url.searchParams.get('q'))], hasMore: false, cursor: '' };
        if (!audit.hold) return payload;
        return await new Promise(resolve => audit.pending.push({ account, finish: () => resolve(payload) }));
      }
      if (url.pathname === '/catalog/search/suggestions') return { items: [], queries: [] };
      if (url.pathname.startsWith('/catalog/')) return { items: [series(audit.account)], hasMore: false, cursor: '' };
      if (url.pathname === '/media/cache/settings') return {};
      throw new Error('Unexpected fixture route');
    });
    ipcMain.removeHandler('library:sync');
    ipcMain.handle('library:sync', () => ({ library: { history: [], favorites: [] }, warnings: [] }));
  });
  await page.waitForSelector('.app-shell');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('.app-shell');
  await page.getByRole('button', { name: '我的账号', exact: true }).waitFor();
  await instance.evaluate(() => { globalThis.__catalogAudit.hold = true; });
  const search = page.getByLabel('搜索剧名、演员或关键词', { exact: true });
  await search.fill('隔离测试'); await search.press('Enter');
  for (let tries = 0; tries < 50 && !(await calls()).some(row => row.account === 'fixture-a'); tries++) await page.waitForTimeout(20);
  check('账号 A 的搜索已经进入真实 IPC 并保持在途', (await calls()).some(row => row.account === 'fixture-a'), await calls());
  await instance.evaluate(({ BrowserWindow }) => {
    const audit = globalThis.__catalogAudit; audit.account = 'fixture-b';
    BrowserWindow.getAllWindows()[0].webContents.send('session:changed',
      { loggedIn: true, uid: 'fixture-b', nickname: '受控账号 B', mobile: '', avatar: '' });
  });
  for (let tries = 0; tries < 50 && !(await calls()).some(row => row.account === 'fixture-b'); tries++) await page.waitForTimeout(20);
  check('换号后相同关键词重新请求账号 B 的搜索', (await calls()).some(row => row.account === 'fixture-b'), await calls());
  await instance.evaluate(() => {
    const audit = globalThis.__catalogAudit;
    audit.pending.filter(row => row.account === 'fixture-a').forEach(row => row.finish());
  });
  await page.waitForTimeout(200);
  const during = await page.locator('.series-title').allTextContents();
  check('账号 A 的迟到搜索不能显示在账号 B 页面', !during.some(title => title.startsWith('fixture-a:')), { during });
  await instance.evaluate(() => {
    const audit = globalThis.__catalogAudit;
    audit.pending.filter(row => row.account === 'fixture-b').forEach(row => row.finish());
    audit.hold = false;
  });
  await page.waitForTimeout(200);
  const after = await page.locator('.series-title').allTextContents();
  check('账号 B 页面最终显示自己的搜索结果', after.includes('fixture-b:隔离测试') && !after.some(title => title.startsWith('fixture-a:')), { after });
  // Returning through a second keyword exercises the private memory cache too.
  const beforeSecondQuery = (await calls()).length;
  await search.fill('隔离测试二'); await search.press('Enter');
  await page.waitForFunction(() => document.querySelector('.series-title')?.textContent === 'fixture-b:隔离测试二');
  const second = await page.locator('.series-card').evaluateAll(cards => cards.map(card => card.dataset.seriesId));
  check('第二个关键词独立发出搜索请求并显示对应作品',
    (await calls()).slice(beforeSecondQuery).some(row => row.account === 'fixture-b' && row.query === '隔离测试二')
      && second.length === 1 && second[0] === '8888777802', { second });
  const beforeReturn = (await calls()).length;
  await search.fill('隔离测试'); await search.press('Enter');
  await page.waitForFunction(() => document.querySelector('.series-title')?.textContent === 'fixture-b:隔离测试');
  for (let tries = 0; tries < 50 && !(await calls()).slice(beforeReturn).some(row => row.query === '隔离测试'); tries++) await page.waitForTimeout(20);
  const returned = await page.locator('.series-title').allTextContents();
  check('返回旧关键词不复用账号 A 或第二关键词的结果', !returned.some(title => title.startsWith('fixture-a:'))
    && returned.includes('fixture-b:隔离测试') && !returned.includes('fixture-b:隔离测试二')
    && (await calls()).slice(beforeReturn).some(row => row.account === 'fixture-b' && row.query === '隔离测试'), { returned });
  check('隔离窗口隐藏且静音', await instance.evaluate(({ BrowserWindow, webContents }) => BrowserWindow.getAllWindows().every(window => !window.isVisible())
    && webContents.getAllWebContents().every(contents => contents.isAudioMuted())));
} catch (error) {
  check('隔离回归执行失败', false, { name: error.name });
} finally {
  await writeFile(path.join(out, 'result-' + mode + '.json'), JSON.stringify({ checks }, null, 2));
  if (instance) { await instance.evaluate(({ app }) => app.quit()).catch(() => {}); await instance.close().catch(() => {}); }
}
