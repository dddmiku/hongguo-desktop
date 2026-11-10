// Verify the reported full title and every official season through the actual PC interface.
import {expect} from '@playwright/test';
import {quietElectron as electron} from './quiet-electron.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);
const root=process.cwd(),installed=process.argv.includes('--installed');
const out=path.join(root,'_work/search-season-fix',installed?'installed':'current');
await mkdir(out,{recursive:true});
const instance=await electron.launch({...(installed?{executablePath:path.join(process.env.LOCALAPPDATA,'Programs/hongguo-desktop/红果桌面.exe'),args:[]}:{args:['.'],cwd:root}),
  env:{...process.env,HG_TEST_DATA_DIR:path.join(out,'profile'),HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:60000});
const page=await instance.firstWindow(),checks=[],errors=[];
page.on('pageerror',error=>errors.push(error.name));
const title='觉醒伪神：神明弃我我自为神',first='7673742740500270105',seventh='7697852455970671678';
const check=(name,ok,details)=>{checks.push({name,ok,...(details?{details}:{})});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
try{
  await page.waitForSelector('.app-shell');
  await page.getByLabel('搜索剧名、演员或关键词').fill(title);
  await page.getByLabel('搜索剧名、演员或关键词').press('Enter');
  await page.locator(`.series-card[data-series-id="${first}"]`).first().waitFor({timeout:90000});
  const family=await page.locator('.series-card').evaluateAll((nodes,title)=>nodes.map(node=>({id:node.dataset.seriesId,title:node.querySelector('.series-title')?.textContent})).filter(row=>row.title?.startsWith(title)),title);
  check('全称搜索显示同作品全部八季',family.length===8&&family.some(row=>row.id===seventh),{count:family.length});
  await page.locator(`.series-card[data-series-id="${seventh}"]`).first().locator('.series-poster-button').click();
  const sheet=page.getByRole('dialog');
  await sheet.locator('.season-overview-card').first().waitFor({timeout:120000});
  const seasons=await sheet.locator('.season-overview-card').evaluateAll(nodes=>nodes.map(node=>({current:node.getAttribute('aria-current'),id:node.dataset.seriesId||node.getAttribute('aria-label'),total:node.querySelector('em')?.textContent})));
  check('第七季详情显示八季真实总集数',seasons.length===8&&seasons.every((row,index)=>row.total===`${[127,139,120,152,192,192,193,213][index]} 集`),{totals:seasons.map(row=>row.total)});
  check('当前第七季高亮',seasons[6].current==='true');
  await sheet.getByRole('button',{name:/^查看第 8 季：/}).click();
  await expect.poll(()=>sheet.locator('.detail-hero h2').textContent(),{timeout:90000}).toBe(title+'8');
  check('直接查看第八季并显示213集',await sheet.locator('.detail-meta').textContent().then(text=>text.includes('213 集')));
  await sheet.getByLabel('全部季概览').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(out,'seasons.png')});
  if(process.argv.includes('--playback')){
    await page.evaluate(()=>window.hongguo.saveSettings({volume:0,rate:1,autoplay:false,danmaku:{enabled:false}}));
    await sheet.getByRole('button',{name:'播放第 1 集',exact:true}).click();
    const decoded=()=>page.waitForFunction(()=>{const video=document.querySelector('video[data-active=true]');return video?.videoWidth>0&&video.currentTime>.2&&!video.paused&&!document.querySelector('.player-error');},undefined,{timeout:180000});
    await decoded();
    await page.evaluate(()=>{window.__minimizeVideo=document.querySelector('video[data-active=true]');});
    await instance.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setBounds({x:-32000,y:-32000,width:1120,height:800});window.showInactive();window.minimize();});
    await page.waitForFunction(()=>window.__minimizeVideo.paused);
    const frozen=await page.evaluate(()=>window.__minimizeVideo.currentTime);
    await page.waitForTimeout(350);
    check('正式客户端最小化暂停实际解码视频',await page.evaluate(at=>window.__minimizeVideo.paused&&Math.abs(window.__minimizeVideo.currentTime-at)<.1,frozen));
    await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].restore());await decoded();
    check('恢复窗口继续原视频和原位置',await page.evaluate(at=>document.querySelector('video[data-active=true]')===window.__minimizeVideo&&window.__minimizeVideo.currentTime>=at,frozen));
    await page.keyboard.press('k');await page.waitForFunction(()=>window.__minimizeVideo.paused);
    await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].minimize());
    await page.waitForTimeout(200);
    await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].restore());
    await page.waitForTimeout(400);
    check('手动暂停后恢复窗口仍保持暂停',await page.evaluate(()=>window.__minimizeVideo.paused));
    await page.keyboard.press('k');await decoded();
    check('恢复后播放按钮仍能继续实际播放',true);
    await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());
  }
  check('无内部IPC错误前缀',!(await page.locator('body').innerText()).includes('Error invoking remote method'));
  check('测试窗口隐藏静音',await instance.evaluate(({BrowserWindow,webContents})=>BrowserWindow.getAllWindows().every(window=>!window.isVisible())&&webContents.getAllWebContents().every(contents=>contents.isAudioMuted())));
  check('无渲染异常',errors.length===0);
}catch(error){checks.push({name:'全称搜索和全部季验收',ok:false,errorType:error.name});process.exitCode=1;console.error(error.name);}
finally{await writeFile(path.join(out,'result.json'),JSON.stringify({checks,errors},null,2));await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
