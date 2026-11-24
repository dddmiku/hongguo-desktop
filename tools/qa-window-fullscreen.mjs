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
const focusOnly=process.argv.includes('--focus-only');
const packagedPath = process.env.HG_QA_PACKAGED_PATH || path.join(root, 'release/win-unpacked/红果桌面.exe');
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
const seekArrow = async (key, direction, paused = false, seconds = 5) => {
  const before = await observeSeeks();
  await page.keyboard.press(key);
  await page.waitForFunction(({ before, direction, paused, seconds }) => {
    const video = document.querySelector('video[data-active=true]');
    const tolerance = seconds === 1 ? .35 : 1;
    return !video.seeking && video.paused === paused
      && window.__seekEvents.some(event => event.type === 'seeked' && Math.abs(event.time - (before + direction * seconds)) < tolerance);
  }, { before, direction, paused, seconds }, { timeout: 10000 });
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
  check(`${mode}Shift+右方向键快进一秒不弹控制栏`, await seekArrow('Shift+ArrowRight', 1, false, 1));
  check(`${mode}Shift+左方向键快退一秒不弹控制栏`, await seekArrow('Shift+ArrowLeft', -1, false, 1));
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
const shortcuts = () => page.getByRole('dialog', { name: '播放快捷键', exact: true });
const helpButton = () => page.getByRole('button', { name: '播放快捷键', exact: true });
const inspectShortcutDialog = async (mode, fullscreen, theater) => {
  const decoded = await geometry();
  await page.keyboard.press('?');
  await shortcuts().waitFor();
  const entries = await shortcuts().getByRole('listitem').allTextContents();
  check(mode + '问号打开完整快捷键面板', entries.length === 13 && entries.some(entry => entry.includes('快退 / 快进 1 秒')));
  await page.keyboard.press('j');
  await page.locator('video[data-active=true]').evaluate(node => node.focus());
  const after = await geometry();
  check(mode + '帮助面板锁住焦点并隔离播放快捷键', await shortcuts().evaluate(node => node.contains(document.activeElement)) && !after.paused && after.sameVideo === decoded.sameVideo);
  await page.keyboard.press('Escape');
  await shortcuts().waitFor({ state: 'hidden' });
  check(mode + 'Esc 只关闭快捷键面板', await page.locator('.player-page').count() === 1 && (await geometry()).fullscreen === fullscreen && (await page.locator('.player-theater').count() > 0) === theater);
  return entries;
};
const focusSeek=async()=>{
  await hover();
  if(!await page.locator('video[data-active=true]').evaluate(video=>video.paused))await page.getByTitle('暂停（空格）').click();
  const timeline=page.getByLabel('播放进度'),bounds=await timeline.boundingBox();
  const seekState=()=>timeline.evaluate(input=>{const video=document.querySelector('video[data-active=true]'),style=getComputedStyle(input);return{time:video.currentTime,paused:video.paused,focused:document.activeElement===input,focusVisible:input.matches(':focus-visible'),outlineStyle:style.outlineStyle,outlineWidth:style.outlineWidth,outlineColor:style.outlineColor};});
  const settled=()=>page.waitForFunction(()=>{const video=document.querySelector('video[data-active=true]');return video.paused&&!video.seeking&&Math.abs(video.currentTime-Number(document.querySelector('input[aria-label=播放进度]').value))<.05;});
  await timeline.click({position:{x:bounds.width*.4,y:bounds.height/2}});await settled();
  const pointer=await seekState();await page.keyboard.press('ArrowRight');await settled();const arrow=await seekState();
  await page.screenshot({path:path.join(out,`${resultName}-pointer-seek-focus.png`)});
  check('鼠标定位后方向键快进五秒，进度条不残留白框或焦点',!pointer.focused&&Math.abs(arrow.time-pointer.time-5)<.05&&!arrow.focused&&Number.parseFloat(arrow.outlineWidth)===0,{before:pointer,after:arrow,seekDelta:arrow.time-pointer.time});
  await timeline.focus();const keyboard=await seekState();await page.keyboard.press('ArrowRight');await settled();const fine=await seekState();
  await page.screenshot({path:path.join(out,`${resultName}-keyboard-seek-focus.png`)});
  check('键盘主动聚焦保留原生微调，但不画进度条长白框',fine.focused&&fine.focusVisible&&fine.time-keyboard.time>.05&&fine.time-keyboard.time<.2&&Number.parseFloat(fine.outlineWidth)===0,{before:keyboard,after:fine,seekDelta:fine.time-keyboard.time});
  await timeline.click({position:{x:bounds.width*.4,y:bounds.height/2}});await settled();const shifted=await seekState();
  await page.keyboard.press('Shift+ArrowRight');await settled();const afterShift=await seekState();
  check('鼠标定位后Shift方向键仍只快进一秒',!afterShift.focused&&Math.abs(afterShift.time-shifted.time-1)<.05,{seekDelta:afterShift.time-shifted.time});
  await page.mouse.move(bounds.x+bounds.width*.3,bounds.y+bounds.height/2);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.6,bounds.y+bounds.height/2,{steps:5});await page.mouse.up();await settled();
  const drag=await seekState();await page.keyboard.press('ArrowRight');await settled();const afterDrag=await seekState();
  check('拖动释放后方向键仍快进五秒，不被滑块截走',!drag.focused&&Math.abs(afterDrag.time-drag.time-5)<.05,{before:drag,after:afterDrag,seekDelta:afterDrag.time-drag.time});
  const volume=page.getByLabel('音量'),volumeBefore=Number(await volume.inputValue()),timeBefore=(await seekState()).time;await volume.focus();await page.keyboard.press('ArrowRight');
  await page.waitForFunction(before=>Number(document.querySelector('input[aria-label=音量]').value)>before,volumeBefore);
  check('音量滑块保留原生方向键，不触发视频快进',Math.abs((await seekState()).time-timeBefore)<.05&&Number(await volume.inputValue())>volumeBefore);
};
try {
  instance = await electron.launch({ ...(installed || packaged ? { executablePath: installed ? process.env.HG_QA_EXECUTABLE||path.join(process.env.LOCALAPPDATA, 'Programs/hongguo-desktop/红果桌面.exe') : packagedPath, args: [] } : { args: ['.'], cwd: root }), env: { ...process.env, HG_TEST_DATA_DIR: path.join(out, installed ? 'installed-profile' : packaged ? 'packaged-profile' : 'profile'), HG_TEST_BACKGROUND: '1', TEMP: out, TMP: out }, timeout: 60000 });
  page = await instance.firstWindow();
  page.on('pageerror', error => errors.push(error.name));
  await instance.evaluate(({ ipcMain }, url) => {
    let session = 0;
    const series = { id: '9999999999999999991', title: '窗口全屏演示', cover: '', intro: '本地布局回归画面', totalEpisodes: 80, tags: [], actors: [] };
    ipcMain.removeHandler('api:request');
    const fixtureRequest=(route, options = {}) => {
      if (route === '/account/session') return { loggedIn: false, uid: '', nickname: '', avatar: '', mobile: '' };
      if (route === '/catalog/series/' + series.id) return { series, episodes: Array.from({ length: 80 }, (_, index) => ({ index: index + 1, vid: '9999999999999999992', title: `第 ${index + 1} 集`, duration: 120 })).filter(episode => episode.index !== 2) };
      if (route.includes('/seasons')) return { seriesId: series.id, status: 'single', currentSeason: 1, seasons: [], complete: true };
      if (route.startsWith('/catalog/comments')) return { items: [], total: 0, cursor: 0, hasMore: false };
      if (route.startsWith('/catalog/danmaku')) return { items: [], start: 0, end: 120, hasMore: false, seriesId: series.id, vid: '9999999999999999992', source: 'mobile' };
      if (route.startsWith('/catalog/')) return { items: [series], hasMore: false, cursor: null };
      if (route.startsWith('/media/session')) return options.method === 'DELETE' ? {} : { id: route==='/media/session'?'layout-'+ ++session:route.split('/').at(-1), phase: 'complete', url, duration: 120 };
      if (route === '/media/cache/settings') return {};
      throw new Error('未预期的布局回归请求');
    };
    ipcMain.handle('api:request',(_event,route,options)=>fixtureRequest(route,options));
    ipcMain.removeHandler('media:request');
    ipcMain.handle('media:request',(_event,route,options)=>({ok:true,data:fixtureRequest(route,options)}));
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
  if(focusOnly){await hover();await windowButton().click();await page.waitForTimeout(200);await focusSeek();}
  else{
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
  check('窗口全屏 Shift+右方向键快进一秒不弹控制栏', await seekArrow('Shift+ArrowRight', 1, false, 1));
  check('窗口全屏 Shift+左方向键快退一秒不弹控制栏', await seekArrow('Shift+ArrowLeft', -1, false, 1));
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
  await inspectShortcutDialog('窗口全屏', false, true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.player-theater'));
  check('Esc只退出窗口全屏并恢复导航和原视频', await page.locator('.app-header').isVisible() && (await geometry()).sameVideo && !await page.locator('video[data-active=true]').evaluate(node => node.paused));
  await quietArrows('普通模式');
  const shortcutEntries = await inspectShortcutDialog('普通模式', false, false);
  await search.focus();
  await search.press('?');
  check('搜索输入问号不打开播放快捷键表', (await search.inputValue()).includes('?') && !await shortcuts().count());
  await search.fill('');
  await search.evaluate(node => node.blur());
  await hover();
  await helpButton().click();
  await shortcuts().waitFor();
  await shortcuts().getByRole('button', { name: '关闭播放快捷键' }).click();
  check('点击按钮打开快捷键表，关闭后归还焦点', await helpButton().evaluate(node => node === document.activeElement));
  await page.keyboard.press('Shift+Tab');
  await page.waitForSelector('.video-stage.controls-hidden');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.player-controls')).opacity === '1');
  check('键盘焦点留在控制栏时提示仍可见', await page.locator('.player-controls').evaluate(node => node.contains(document.activeElement) && document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle !== 'none'));
  const muted = await page.locator('video[data-active=true]').evaluate(node => node.muted);
  const mute = page.getByTitle('静音（M）', { exact: true });
  await mute.focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(prior => document.querySelector('video[data-active=true]').muted !== prior, muted);
  check('空格操作焦点静音按钮，保持播放和键盘焦点', !(await geometry()).paused && await mute.evaluate(node => document.activeElement === node));
  await mute.evaluate(node => node.blur());
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
  const normalBounds = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds());
  await hover(); await page.getByTitle('画中画置顶小窗', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.player-pip'));
  await page.waitForTimeout(350);
  const pipState = await instance.evaluate(({ BrowserWindow, screen }) => { const w = BrowserWindow.getAllWindows()[0]; return { always: w.isAlwaysOnTop(), bounds: w.getBounds(), normal: w.getNormalBounds(), maximized: w.isMaximized(), work: screen.getPrimaryDisplay().workArea }; });
  const expectedPipWidth = Math.min(480, pipState.work.width - 24);
  check('画中画窗口置顶且缩小到右下角', pipState.always && !pipState.maximized && Math.abs(pipState.bounds.width - expectedPipWidth) < 2 && Math.abs(pipState.bounds.height - Math.round(expectedPipWidth * 9 / 16)) < 2 && pipState.bounds.x + pipState.bounds.width <= pipState.work.x + pipState.work.width + 1 && pipState.bounds.y + pipState.bounds.height <= pipState.work.y + pipState.work.height + 1, pipState);
  check('画中画期间播放保持且画面仍在解码', await page.locator('video[data-active=true]').evaluate(v => v.videoWidth > 0 && !v.paused));
  await page.locator('video[data-active=true]').evaluate(v => v.pause());
  const pipPaused = await page.locator('video[data-active=true]').evaluate(v => v.paused);
  await hover(); await page.getByTitle('退出置顶小窗', { exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.player-pip'));
  await page.waitForTimeout(350);
  const restored = await instance.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { always: w.isAlwaysOnTop(), bounds: w.getNormalBounds(), max: w.isMaximized() }; });
  check('退出画中画恢复原窗口尺寸且取消置顶', !restored.always && Math.abs(restored.bounds.width - normalBounds.width) < 2 && Math.abs(restored.bounds.height - normalBounds.height) < 2 && Math.abs(restored.bounds.x - normalBounds.x) < 2 && Math.abs(restored.bounds.y - normalBounds.y) < 2, { before: normalBounds, after: restored });
  await page.locator('video[data-active=true]').evaluate(v => { if (!v.paused) v.play(); });
  await page.keyboard.press('f'); await page.waitForFunction(() => !!document.fullscreenElement);
  check('窗口全屏可以继续进入系统全屏', await page.locator('.playback-layout').evaluate(node => document.fullscreenElement === node));
  check('系统全屏不保留窗口拖动区', !await page.locator('.window-drag-region').isVisible() && await nativeHit(200, 16) === 1);
  await quietArrows('系统全屏');
  await inspectShortcutDialog('系统全屏', true, true);
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.fullscreenElement);
  check('系统全屏退出后仍保留窗口全屏', await page.locator('.player-theater').count() === 1 && fillsWindow(await geometry()));
  await hover(); await page.getByTitle('弹幕设置', { exact: true }).click();
  await page.keyboard.press('Escape');
  check('Esc先关闭弹幕设置再退出窗口全屏', !await page.getByRole('dialog', { name: '弹幕设置' }).count() && await page.locator('.player-theater').count() === 1);
  await page.keyboard.press('j');
  await page.waitForFunction(() => document.querySelector('video[data-active=true]')?.dataset.episode === '3', undefined, { timeout: 20000 });
  check('窗口全屏切集跳过缺号并保持布局与实际解码', fillsWindow(await geometry()) && await page.locator('video[data-active=true]').evaluate(node => node.videoWidth > 0 && !node.paused));
  await hover(); await page.getByTitle('暂停（空格）').click();
  const pausedPosition = await observeSeeks();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(before => { const video = document.querySelector('video[data-active=true]'); return !video.seeking && Math.abs(video.currentTime - before - 5) < .1 && window.__seekEvents.some(event => event.type === 'seeked'); }, pausedPosition);
  check('手动暂停后方向键定位仍保持暂停并保留可用控制栏', (await geometry()).paused && !(await page.locator('.video-stage').evaluate(stage => stage.classList.contains('controls-hidden'))));
  const timeline = page.getByLabel('播放进度', { exact: true });
  const spokenProgress = await timeline.getAttribute('aria-valuetext');
  check('读屏可获取进度的分秒和总时长', /^[0-9]+ 分 [0-9]+ 秒，共 2 分 0 秒$/.test(spokenProgress), { spokenProgress });
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
  await page.getByRole('button', { name: '上一集', exact: true }).click();
  await page.waitForFunction(() => { const video = document.querySelector('video[data-active=true]'); return video?.dataset.episode === '1' && video.videoWidth > 0; });
  check('上一集同样按可播放列表跳过缺号', true);
  await page.getByRole('button', { name: '返回', exact: true }).click();
  check('结束播放后恢复首页与顶部栏', !await page.locator('.player-page').count() && await page.locator('.app-header').isVisible());
  await page.locator('.header-settings').click();
  const settingsEntries = await page.locator('.player-shortcut-list').getByRole('listitem').allTextContents();
  check('设置和播放器快捷键表一致', JSON.stringify(settingsEntries) === JSON.stringify(shortcutEntries));
  }
  check('无渲染异常且窗口静音', errors.length === 0 && await instance.evaluate(({ webContents }) => webContents.getAllWebContents().every(contents => contents.isAudioMuted())), { errors });
} catch (error) {
  checks.push({ name: '窗口全屏回归', ok: false, error: error.name, message: error.message.slice(0, 200) });
  console.error(error.name + ': ' + error.message.slice(0, 200)); process.exitCode = 1;
} finally {
  await writeFile(path.join(out, focusOnly?`focus-${resultName}-result.json`:installed ? 'installed-result.json' : packaged ? 'packaged-result.json' : 'result.json'), JSON.stringify({ checks, errors }, null, 2));
  if (instance) { await instance.evaluate(({ app }) => app.quit()).catch(() => {}); await instance.close().catch(() => {}); }
  await new Promise(resolve => server.close(resolve));
}
