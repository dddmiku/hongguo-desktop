// Genuine mobile API data and decoded video; no account, synthetic comments or public writes.
import {expect} from '@playwright/test';
import {quietElectron as electron} from './quiet-electron.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd(), out = path.join(root, '_work', 'danmaku-qa'); await mkdir(out, { recursive: true });
const installed = process.argv.includes('--installed');
const packaged = process.argv.includes('--packaged');
const env = { ...process.env, HG_TEST_DATA_DIR: path.join(root, '_work', installed ? 'danmaku-installed-data' : packaged ? 'danmaku-packaged-data' : 'danmaku-data'), TEMP: out, TMP: out };
const executable = installed ? path.join(process.env.LOCALAPPDATA, 'Programs', 'hongguo-desktop', '红果桌面.exe') : path.join(root, 'release', 'win-unpacked', '红果桌面.exe');
const launch = installed || packaged ? { executablePath: executable, args: [], env, timeout: 60000 } : { args: ['.'], cwd: root, env, timeout: 60000 };
const instance = await electron.launch(launch);
const page = await instance.firstWindow(), checks = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(JSON.stringify(checks.at(-1))); if (!ok) throw new Error(name); };
const media = () => page.locator('video[data-active=true]').evaluate(video => ({ time: video.currentTime, duration: video.duration, width: video.videoWidth, episode: video.dataset.episode, paused: video.paused, rate: video.playbackRate }));
const pixels = () => page.locator('.danmaku-canvas').evaluate(canvas => {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let occupied = 0, hash = 2166136261;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]) { occupied++; hash = Math.imul(hash ^ i ^ data[i] ^ data[i + 3], 16777619); }
  return { occupied, hash: hash >>> 0, text: canvas.getAttribute('aria-label'), active: Number(canvas.dataset.activeCount), width: canvas.width, height: canvas.height };
});
try {
  await page.waitForSelector('.app-shell', { timeout: 30000 });
  await page.evaluate(() => window.hongguo.saveSettings({ quality: '1080p', autoplay: false, rate: 1, volume: 0, danmaku: { enabled: true, opacity: .8, fontSize: 22, area: .5, density: 'standard', blockedWords: [] } }));
  await page.reload(); await page.waitForSelector('.app-shell');
  await page.evaluate(() => {
    window.__danmakuDraw = [];
    window.__emojiDraw = [];
    window.__literalEmoji = [];
    const original = CanvasRenderingContext2D.prototype.strokeText;
    CanvasRenderingContext2D.prototype.strokeText = function (...args) {
      if (this.canvas.classList.contains('danmaku-canvas')) {
        if (/\[(爽|送花|鼓掌|爱慕)\]/.test(args[0])) window.__literalEmoji.push(args[0]);
        const video = document.querySelector('video[data-active=true]');
        window.__danmakuDraw.push({ x: args[1], y: args[2], font: this.font, alpha: this.globalAlpha, width: this.canvas.width, height: this.canvas.height, time: video?.currentTime, paused: video?.paused });
        if (window.__danmakuDraw.length > 100) window.__danmakuDraw.shift();
      }
      return original.apply(this, args);
    };
    const originalImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (this.canvas.classList.contains('danmaku-canvas')) {
        window.__emojiDraw.push({ source: args[0].src, originalWidth: args[0].naturalWidth, width: args[3], height: args[4] });
        if (window.__emojiDraw.length > 200) window.__emojiDraw.shift();
      }
      return originalImage.apply(this, args);
    };
  });
  const query = '人前小保姆';
  await page.getByLabel('搜索剧名、演员或关键词').fill(query); await page.getByLabel('搜索剧名、演员或关键词').press('Enter');
  const card = page.locator('.series-card[data-series-id="7699859403758914622"]').first(); await card.waitFor({ timeout: 90000 });
  await card.locator('.series-poster-button').click(); await page.waitForSelector('.detail-hero', { timeout: 90000 });
  const details = await page.evaluate(() => window.hongguo.request('/catalog/series/7699859403758914622'));
  const source = await page.evaluate(({ seriesId, duration }) => window.hongguo.request(`/catalog/danmaku?seriesId=${seriesId}&episode=1&duration=${duration}`), { seriesId: details.series.id, duration: details.episodes[0].duration });
  check('读取手机真实弹幕而非普通评论', source.source === 'mobile' && source.vid === details.episodes[0].vid && source.items.length > 0 && source.items.every(item => typeof item.time === 'number'), { vid: source.vid, count: source.items.length, start: source.start, end: source.end, sample: source.items[0] });
  await page.getByRole('dialog').getByRole('button', { name: '播放第 1 集', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('video[data-active=true]')?.currentTime > .2, undefined, { timeout: 180000 });
  await page.waitForFunction(() => Number(document.querySelector('.danmaku-canvas')?.dataset.activeCount) > 0, undefined, { timeout: 30000 });
  await page.waitForFunction(() => { const canvas = document.querySelector('.danmaku-canvas'), data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let count = 0; for (let i = 3; i < data.length; i += 4) if (data[i] && ++count > 200) return true; return false; }, undefined, { timeout: 10000 });
  const drawn = await pixels(), current = await media();
  check('真实时间点出现实际文字像素', drawn.occupied > 20 && source.items.some(item => drawn.text.includes(item.text) && item.time <= current.time + .1), { current, drawn });
  await page.waitForTimeout(4000); await page.screenshot({ path: path.join(out, 'playing.png') });
  const emoji = await page.evaluate(() => ({ images: window.__emojiDraw, literal: window.__literalEmoji, count: Number(document.querySelector('.danmaku-canvas').dataset.emojiCount) }));
  check('手机表情实际绘制图片并替换文字标记', emoji.images.some(item => item.source.includes('emoji_dr_53-') && item.originalWidth > 0) && emoji.images.some(item => item.source.includes('emoji_dr_51-')) && emoji.count > 0 && emoji.literal.length === 0,
    { count: emoji.count, imageSources: [...new Set(emoji.images.map(item => item.source.split('/').at(-1)))], literalTokens: emoji.literal });
  await page.keyboard.press('k'); await page.waitForFunction(() => document.querySelector('video[data-active=true]')?.paused);
  await page.waitForTimeout(100); // Wait for the first paint acknowledging the real pause event.
  const stopped = await pixels(); await page.waitForTimeout(800); const frozen = await pixels();
  check('暂停时弹幕画面完全冻结', stopped.occupied > 20 && stopped.hash === frozen.hash, { before: stopped, after: frozen, draws: await page.evaluate(() => window.__danmakuDraw.slice(-6)) });
  await page.keyboard.press('k'); await page.waitForTimeout(800); const moved = await pixels();
  check('恢复播放后继续移动', moved.occupied > 20 && moved.hash !== frozen.hash,{media:await media(),frozen,moved,window:await page.evaluate(()=>({hidden:document.hidden,visibility:document.visibilityState,stage:document.querySelector('.danmaku-canvas').getBoundingClientRect().toJSON()}))});
  await page.keyboard.press('d'); await page.waitForFunction(() => document.querySelector('.danmaku-canvas')?.dataset.activeCount === '0');
  check('D关闭弹幕不停止视频', (await pixels()).occupied === 0 && !(await media()).paused);
  await page.keyboard.press('d'); await page.locator('.video-stage').hover({ position: { x: 30, y: 30 } });
  await page.getByRole('button', { name: '弹幕设置', exact: true }).click();
  await page.getByLabel('弹幕密度').selectOption('dense'); await page.getByLabel('弹幕字号').selectOption('26');
  await page.getByLabel('弹幕显示区域').selectOption('.25');
  const beforeOpacity = await media(); await page.getByLabel('弹幕不透明度').focus(); await page.keyboard.press('ArrowLeft');
  await expect.poll(()=>page.evaluate(async()=> (await window.hongguo.getSettings()).danmaku.opacity)).toBeLessThan(.8);
  const preferences = await page.evaluate(() => window.hongguo.getSettings());
  check('显示设置已保存且滑块方向键不跳视频', preferences.danmaku.fontSize === 26 && preferences.danmaku.area === .25 && preferences.danmaku.density === 'dense' && (await media()).time >= beforeOpacity.time, preferences.danmaku);
  await page.screenshot({ path: path.join(out, 'settings.png') });
  await page.keyboard.press('Escape'); await page.waitForSelector('.danmaku-panel', { state: 'detached' });
  await page.keyboard.press('f'); await page.waitForFunction(() => !!document.fullscreenElement);
  const fullscreen = await page.locator('.danmaku-canvas').evaluate(canvas => ({ width: canvas.clientWidth, height: canvas.clientHeight, expectedWidth: innerWidth, expectedHeight: innerHeight }));
  check('弹幕在真全屏内覆盖正确区域', fullscreen.width === fullscreen.expectedWidth && fullscreen.height === fullscreen.expectedHeight, fullscreen);
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.fullscreenElement);
  const later = await page.evaluate(() => window.hongguo.request('/catalog/danmaku?seriesId=7699859403758914622&episode=1&position=30&duration=179.42'));
  await writeFile(path.join(out, 'later-window.json'), JSON.stringify(later, null, 2));
  check('后续时间段读取对应场景', later.start === 30 && later.end > 30 && later.items.every(item => item.time >= 29 && item.time < later.end + 1), { count: later.items.length, start: later.start, end: later.end });
  const wanted = Math.max(30, later.items[0].time - 1);
  await page.locator('.video-stage').hover({ position: { x: 30, y: 30 } });
  const track = await page.locator('.timeline input').boundingBox();
  const full = await page.locator('.timeline input').evaluate(input => Number(input.max));
  await page.mouse.click(track.x + 6 + (track.width - 12) * wanted / full, track.y + track.height / 2);
  await page.waitForFunction(time => { const v = document.querySelector('video[data-active=true]'); return v && v.currentTime >= time && !v.paused; }, wanted, { timeout: 120000 });
  await page.waitForFunction(texts => texts.some(text => document.querySelector('.danmaku-canvas')?.getAttribute('aria-label')?.includes(text)), later.items.map(item => item.text), { timeout: 30000 });
  const seeked = await pixels(), atSeek = await media();
  check('拖动后只显示目标场景的弹幕', !seeked.text.includes(source.items[0].text) && later.items.some(item => seeked.text.includes(item.text)), { media: atSeek, text: seeked.text });
  await page.locator('.video-stage').hover({ position: { x: 30, y: 30 } }); await page.getByLabel('播放倍速').selectOption('3');
  await page.waitForFunction(() => document.querySelector('video[data-active=true]')?.playbackRate === 3);
  check('三倍速仍实际播放且弹幕没有错误', (await media()).rate === 3 && !errors.length);
  await page.keyboard.press('j');
  await page.waitForFunction(() => document.querySelector('video[data-active=true]')?.dataset.episode === '2', undefined, { timeout: 120000 });
  const nextPage = await page.evaluate(() => window.hongguo.request('/catalog/danmaku?seriesId=7699859403758914622&episode=2'));
  check('切集使用对应视频ID并保留播放器', nextPage.vid === details.episodes[1].vid && nextPage.vid !== source.vid && await page.locator('.player-page').count() === 1, { vid: nextPage.vid });
  check('没有渲染异常', errors.length === 0, errors);
  await writeFile(path.join(out, 'mobile-data.json'), JSON.stringify({ first: source, later, second: nextPage }, null, 2));
} catch (error) { checks.push({ name: '弹幕验收', ok: false, error: error.message }); console.error(error.stack); process.exitCode = 1; await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); }
finally { await writeFile(path.join(out, installed ? 'installed-result.json' : packaged ? 'packaged-result.json' : 'result.json'), JSON.stringify({ installed, packaged, checks, errors }, null, 2)); await instance.evaluate(({ app }) => app.quit()).catch(() => {}); await instance.close().catch(() => {}); }
