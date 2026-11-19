// Real Electron layout and HLS decoding, using local media in an isolated profile.
import { quietElectron as electron } from './quiet-electron.mjs';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
const root = process.cwd(), out = path.join(root, '_work/window-fullscreen');
await mkdir(out, { recursive: true });
try { await access(path.join(out, 'sample.m3u8')); } catch {
  execFileSync(path.join(root, 'runtime/ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=12', '-t', '120', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-threads', '2', '-g', '24', '-an', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', path.join(out, 'sample-%03d.ts'), path.join(out, 'sample.m3u8')], { timeout: 60000, windowsHide: true });
}
const server = createServer(async (req, res) => {
  const name = req.url?.split('?')[0].slice(1);
  if (!/^sample(?:-\d+\.ts|\.m3u8)$/.test(name || '')) { res.writeHead(404).end(); return; }
  try {
    const data = await readFile(path.join(out, name));
    res.writeHead(200, { 'Content-Type': name.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' }).end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const mediaUrl = `http://127.0.0.1:${server.address().port}/sample.m3u8`;
const installed = process.argv.includes('--installed'), packaged = process.argv.includes('--packaged'), checks = [], errors = [];
const resultName = installed ? 'installed' : packaged ? 'packaged' : 'source';
let instance, page;
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(JSON.stringify(checks.at(-1))); if (!ok) throw new Error(name); };
const geometry = () => page.evaluate(() => {
  const rect = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON();
  const v = document.querySelector('video[data-active=true]');
  return { stage: rect('.video-stage'), layout: rect('.playback-layout'), header: rect('.app-header'), viewport: { width: innerWidth, height: innerHeight }, fullscreen: !!document.fullscreenElement, sameVideo: v === window.__layoutVideo, time: v?.currentTime, paused: v?.paused };
});
const fillsWindow = data => Math.abs(data.layout.x) < 1 && Math.abs(data.layout.y) < 1 && Math.abs(data.layout.width - data.viewport.width) < 2 && Math.abs(data.layout.height - data.viewport.height) < 2 && data.header.height === 0;
const hover = () => page.locator('.video-stage').hover({ position: { x: 15, y: 15 } });
const windowButton = () => page.locator('.player-controls button').filter({ has: page.locator('svg.lucide-monitor') });
const nativeHit = async (x, y) => {
  const data = await instance.evaluate(({ BrowserWindow, screen }, point) => {
    const window = BrowserWindow.getAllWindows()[0], content = window.getContentBounds();
    const physical = screen.dipToScreenPoint({ x: content.x + Math.round(point.x), y: content.y + Math.round(point.y) });
    return { handle: window.getNativeWindowHandle().readBigUInt64LE().toString(), ...physical };
  }, { x, y });
  return JSON.parse(execFileSync('python', [path.join(root, 'tools/qa-window-hit-test.py')], { input: JSON.stringify(data), encoding: 'utf8', windowsHide: true, timeout: 5000 })).hit;
};
const observeControls = async () => page.evaluate(() => {
  const stage = document.querySelector('.video-stage');
  window.__controlObserver?.disconnect();
  window.__controlsFlashed = false;
  window.__controlObserver = new MutationObserver(records => {
    if (!stage.classList.contains('controls-hidden') || records.some(record => !record.oldValue?.split(' ').includes('controls-hidden'))) window.__controlsFlashed = true;
  });
  window.__controlObserver.observe(stage, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
});
const observeSeeks = async () => page.evaluate(() => {
  const stage = document.querySelector('.video-stage');
  for (const event of ['seeking', 'seeked']) stage.removeEventListener(event, window.__seekListener, true);
  window.__seekEvents = [];
  window.__seekListener = event => window.__seekEvents.push({ type: event.type, time: event.target.currentTime });
  for (const event of ['seeking', 'seeked']) stage.addEventListener(event, window.__seekListener, true);
  return document.querySelector('video[data-active=true]').currentTime;
});
const seekArrow = async (key, direction, paused = false) => {
  const before = await observeSeeks();
  await page.keyboard.press(key);
  await page.waitForFunction(({ before, direction, paused }) => {
    const video = document.querySelector('video[data-active=true]');
    return !video.seeking && video.paused === paused && direction * (video.currentTime - before) > 4
      && window.__seekEvents.some(event => event.type === 'seeked' && Math.abs(event.time - (before + direction * 5)) < 1);
  }, { before, direction, paused }, { timeout: 10000 });
  // A seek can emit playing after seeked; keep watching until the decoder settles.
  await page.waitForTimeout(400);
  return !(await page.evaluate(() => window.__controlsFlashed));
};
const quietArrows = async mode => {
  await page.keyboard.press('3');
  await page.waitForFunction(() => { const video = document.querySelector('video[data-active=true]'); return !video.seeking && !video.paused && video.currentTime > 35 && video.currentTime < 40; });
  await page.waitForSelector('.video-stage.controls-hidden');
  await observeControls();
  check(`${mode}右方向键快进五秒不弹控制栏`, await seekArrow('ArrowRight', 1));
  check(`${mode}左方向键快退五秒不弹控制栏`, await seekArrow('ArrowLeft', -1));
  const before = await observeSeeks();
  await page.keyboard.down('ArrowRight');
  await page.keyboard.down('ArrowRight');
  await page.keyboard.down('ArrowRight');
  await page.keyboard.up('ArrowRight');
  await page.waitForFunction(before => { const video = document.querySelector('video[data-active=true]'); return !video.seeking && !video.paused && video.currentTime - before > 14 && window.__seekEvents.some(event => event.type === 'seeked' && Math.abs(event.time - before - 15) < 1); }, before);
  await page.waitForTimeout(400);
  check(`${mode}长按方向键连续快进不弹控制栏`, !(await page.evaluate(() => window.__controlsFlashed)));
  await page.screenshot({ path: path.join(out, `${resultName}-${mode === '普通模式' ? 'normal' : 'fullscreen'}-keyboard-seek.png`) });
  await page.evaluate(() => window.__controlObserver.disconnect());
};
try {
  instance = await electron.launch({ ...(installed || packaged ? { executablePath: installed ? path.join(process.env.LOCALAPPDATA, 'Programs/hongguo-desktop/红果桌面.exe') : path.join(root, 'release/win-unpacked/红果桌面.exe'), args: [] } : { args: ['.'], cwd: root }), env: { ...process.env, HG_TEST_DATA_DIR: path.join(out, installed ? 'installed-profile' : packaged ? 'packaged-profile' : 'profile'), HG_TEST_BACKGROUND: '1', TEMP: out, TMP: out }, timeout: 60000 });
  page = await instance.firstWindow();
  page.on('pageerror', error => errors.push(error.name));
  await instance.evaluate(({ ipcMain }, url) => {
    let session = 0;
    const series = { id: '9999999999999999991', title: '窗口全屏演示', cover: '', intro: '本地布局回归画面', totalEpisodes: 80, tags: [], actors: [] };
    ipcMain.removeHandler('api:request');
    ipcMain.handle('api:request', (_event, route, options = {}) => {
      if (route === '/account/session') return { loggedIn: false, uid: '', nickname: '', avatar: '', mobile: '' };
      if (route === '/catalog/series/' + series.id) return { series, episodes: Array.from({ length: 80 }, (_, index) => ({ index: index + 1, vid: '9999999999999999992', title: `第 ${index + 1} 集`, duration: 120 })) };
      if (route.includes('/seasons')) return { seriesId: series.id, status: 'single', currentSeason: 1, seasons: [], complete: true };
      if (route.startsWith('/catalog/comments')) return { items: [], total: 0, cursor: 0, hasMore: false };
      if (route.startsWith('/catalog/danmaku')) return { items: [], start: 0, end: 120, hasMore: false, seriesId: series.id, vid: '9999999999999999992', source: 'mobile' };
      if (route.startsWith('/catalog/')) return { items: [series], hasMore: false, cursor: null };
      if (route.startsWith('/media/session')) return options.method === 'DELETE' ? {} : { id: 'layout-' + ++session, phase: 'complete', url, duration: 120 };
      if (route === '/media/cache/settings') return {};
      throw new Error('未预期的布局回归请求');
    });
  }, mediaUrl);
  await page.waitForSelector('.app-shell');
  await page.evaluate(() => window.hongguo.saveSettings({ autoplay: false, rate: 1, volume: 0, danmaku: { enabled: false } }));
  await page.reload();
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
  const search = page.getByLabel('搜索剧名、演员或关键词');
  await search.fill('窗口全屏演示'); await search.press('Enter');
  await page.locator('.series-card .series-poster-button').first().click();
  await page.getByRole('dialog').getByRole('button', { name: '播放第 1 集', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('video[data-active=true]')?.currentTime > .2, undefined, { timeout: 30000 });
  await page.evaluate(() => { window.__layoutVideo = document.querySelector('video[data-active=true]'); });
  const normal = await geometry();
  const bounds = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  await hover(); await windowButton().click();
  await page.waitForTimeout(200);
  const theater = await geometry();
  await page.screenshot({ path: path.join(out, `${resultName}-window-fullscreen.png`) });
  check('窗口全屏覆盖顶部导航和剧名栏并铺满四边', fillsWindow(theater), theater);
  check('窗口全屏不改变系统窗口尺寸和原解码器', !theater.fullscreen && theater.sameVideo && !theater.paused && JSON.stringify(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())) === JSON.stringify(bounds), { normalTime: normal.time, currentTime: theater.time });
  const topHit = await nativeHit(200, 16);
  check('窗口全屏顶部被Windows识别为可拖动标题区', topHit === 2, { hit: topHit });
  await page.mouse.move(400, 200);
  await page.waitForSelector('.video-stage.controls-hidden');
  check('控制栏收起后顶部仍可拖动', await nativeHit(200, 16) === 2);
  await observeControls();
  check('右键快进五秒时底部控制栏未弹出', await seekArrow('ArrowRight', 1));
  check('左键快退五秒时底部控制栏未弹出', await seekArrow('ArrowLeft', -1));
  await page.evaluate(() => {
    const video = document.querySelector('video[data-active=true]');
    Object.defineProperty(video, 'seekable', { configurable: true, get: () => ({ length: 0 }) });
    window.__layoutVideo = video;
  });
  const quietSwitch = await seekArrow('ArrowRight', 1);
  const switched = !(await geometry()).sameVideo;
  check('键盘跳到尚不可定位的位置时换解码器也不弹控制栏', quietSwitch && switched, { quietSwitch, switched });
  await page.evaluate(() => {
    delete window.__layoutVideo.seekable;
    window.__layoutVideo = document.querySelector('video[data-active=true]');
    window.__controlObserver.disconnect();
  });
  await hover();
  check('移动鼠标仍能显示底部控制栏', !(await page.locator('.video-stage').evaluate(stage => stage.classList.contains('controls-hidden'))));
  const exitBounds = await page.getByTitle('退出窗口全屏（Esc）', { exact: true }).boundingBox();
  check('退出按钮不在拖动区内', await nativeHit(exitBounds.x + exitBounds.width / 2, exitBounds.y + exitBounds.height / 2) === 1);
  await page.keyboard.press('Control+k');
  check('隐藏的搜索框不会抢走窗口全屏快捷键', await search.evaluate(node => document.activeElement !== node));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.player-theater'));
  check('Esc只退出窗口全屏并恢复导航和原视频', await page.locator('.app-header').isVisible() && (await geometry()).sameVideo && !await page.locator('video[data-active=true]').evaluate(node => node.paused));
  await quietArrows('普通模式');
  await page.locator('.content-scroll').evaluate(node => { node.scrollTop = 65; });
  const scroll = await page.locator('.content-scroll').evaluate(node => node.scrollTop);
  check('普通模式存在实际滚动位置', scroll > 0, { scroll });
  await page.keyboard.press('t'); await page.waitForSelector('.player-theater');
  await page.keyboard.press('t'); await page.waitForFunction(() => !document.querySelector('.player-theater'));
  await page.waitForFunction(expected => Math.abs(document.querySelector('.content-scroll').scrollTop - expected) < 1, scroll);
  check('T退出后恢复原来的浏览位置', Math.abs(await page.locator('.content-scroll').evaluate(node => node.scrollTop) - scroll) < 1);
  await page.keyboard.press('t'); await page.waitForSelector('.player-theater');
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 680));
  await page.waitForTimeout(150);
  check('窄窗口仍铺满软件并保留控制按钮', fillsWindow(await geometry()) && await windowButton().isVisible());
  await hover(); await page.getByTitle('评论', { exact: true }).click();
  check('窗口全屏评论面板位于软件范围内', await page.locator('.comments-panel').evaluate(node => { const r = node.getBoundingClientRect(); return r.top === 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1; }));
  await page.getByLabel('关闭评论', { exact: true }).click();
  await page.keyboard.press('f'); await page.waitForFunction(() => !!document.fullscreenElement);
  check('窗口全屏可以继续进入系统全屏', await page.locator('.playback-layout').evaluate(node => document.fullscreenElement === node));
  check('系统全屏不保留窗口拖动区', !await page.locator('.window-drag-region').isVisible() && await nativeHit(200, 16) === 1);
  await quietArrows('系统全屏');
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.fullscreenElement);
  check('系统全屏退出后仍保留窗口全屏', await page.locator('.player-theater').count() === 1 && fillsWindow(await geometry()));
  await hover(); await page.getByTitle('弹幕设置', { exact: true }).click();
  await page.keyboard.press('Escape');
  check('Esc先关闭弹幕设置再退出窗口全屏', !await page.getByRole('dialog', { name: '弹幕设置' }).count() && await page.locator('.player-theater').count() === 1);
  await page.keyboard.press('j');
  await page.waitForFunction(() => document.querySelector('video[data-active=true]')?.dataset.episode === '2', undefined, { timeout: 20000 });
  check('窗口全屏切集保持布局与实际解码', fillsWindow(await geometry()) && await page.locator('video[data-active=true]').evaluate(node => node.videoWidth > 0 && !node.paused));
  await hover(); await page.getByTitle('暂停（空格）').click();
  const pausedPosition = await observeSeeks();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(before => { const video = document.querySelector('video[data-active=true]'); return !video.seeking && Math.abs(video.currentTime - before - 5) < .1 && window.__seekEvents.some(event => event.type === 'seeked'); }, pausedPosition);
  check('手动暂停后方向键定位仍保持暂停并保留可用控制栏', (await geometry()).paused && !(await page.locator('.video-stage').evaluate(stage => stage.classList.contains('controls-hidden'))));
  const timeline = page.getByLabel('播放进度', { exact: true });
  await timeline.focus();
  const sliderBefore = await timeline.inputValue();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(before => Number(document.querySelector('input[aria-label=播放进度]').value) > Number(before), sliderBefore);
  await page.waitForFunction(() => { const video = document.querySelector('video[data-active=true]'); return !video.seeking && Math.abs(video.currentTime - Number(document.querySelector('input[aria-label=播放进度]').value)) < .05; });
  const sliderDelta = Number(await timeline.inputValue()) - Number(sliderBefore);
  check('进度滑块聚焦时方向键只微调滑块，不触发五秒快进', sliderDelta > 0 && sliderDelta < .2 && (await geometry()).paused, { sliderDelta });
  await timeline.evaluate(node => node.blur());
  const timelineBounds = await timeline.boundingBox();
  await timeline.click({ position: { x: timelineBounds.width * .4, y: timelineBounds.height / 2 } });
  await page.waitForFunction(() => { const video = document.querySelector('video[data-active=true]'); return !video.seeking && video.paused && Math.abs(video.currentTime - 48) < 2; });
  check('鼠标调整进度仍正常定位并显示控制栏', !(await page.locator('.video-stage').evaluate(stage => stage.classList.contains('controls-hidden'))));
  await page.keyboard.press('t'); await page.keyboard.press('t');
  check('切换窗口全屏保持手动暂停', await page.locator('video[data-active=true]').evaluate(node => node.paused));
  await hover(); await page.getByTitle('退出窗口全屏（Esc）', { exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.player-theater'));
  await page.keyboard.press('t'); await page.keyboard.press('Control+k'); await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.player-theater'));
  await page.getByRole('button', { name: '返回', exact: true }).click();
  check('结束播放后恢复首页与顶部栏', !await page.locator('.player-page').count() && await page.locator('.app-header').isVisible());
  check('无渲染异常且窗口静音', errors.length === 0 && await instance.evaluate(({ webContents }) => webContents.getAllWebContents().every(contents => contents.isAudioMuted())), { errors });
} catch (error) {
  checks.push({ name: '窗口全屏回归', ok: false, error: error.name, message: error.message.slice(0, 200) });
  console.error(error.name + ': ' + error.message.slice(0, 200)); process.exitCode = 1;
} finally {
  await writeFile(path.join(out, installed ? 'installed-result.json' : packaged ? 'packaged-result.json' : 'result.json'), JSON.stringify({ checks, errors }, null, 2));
  if (instance) { await instance.evaluate(({ app }) => app.quit()).catch(() => {}); await instance.close().catch(() => {}); }
  await new Promise(resolve => server.close(resolve));
}
