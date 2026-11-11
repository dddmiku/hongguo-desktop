// Verify the reported title using real suggestion, drama search and season interfaces.
import {expect} from '@playwright/test';
import {quietElectron as electron} from './quiet-electron.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);
const root=process.cwd(),installed=process.argv.includes('--installed'),work=path.join(root,'_work/search-v2',installed?'installed-ui':'current-ui');await mkdir(work,{recursive:true});
const instance=await electron.launch({...(installed?{executablePath:path.join(process.env.LOCALAPPDATA,'Programs/hongguo-desktop/红果桌面.exe'),args:[]}:{args:['.'],cwd:root}),env:{...process.env,HG_TEST_DATA_DIR:path.join(work,'profile'),HG_TEST_BACKGROUND:'1',TEMP:work,TMP:work},timeout:60000});
const page=await instance.firstWindow(),checks=[],errors=[];page.on('pageerror',error=>errors.push(error.name));
const title='无敌财神！我觉醒了唯一隐藏职业',first='7663491547907755033';
const check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
try{
 await page.waitForSelector('.app-shell');
 const input=page.getByLabel('搜索剧名、演员或关键词');await input.fill('无敌财神');
 await page.getByRole('listbox',{name:'搜索建议'}).waitFor({timeout:20000});
 const matches=await page.getByRole('option').evaluateAll(nodes=>nodes.map(node=>node.textContent));
 check('输入时取得官网真实建议和集数',matches.length>0&&matches.some(text=>text.includes(title)),{count:matches.length});
 await page.locator('.top-brand').click();await expect(page.locator('.search-suggestions')).toHaveCount(0);
 check('输入框失焦隐藏建议',true);
 await input.fill(title);await input.press('Enter');
 await page.locator(`.series-card[data-series-id="${first}"]`).first().waitFor({timeout:60000});
 const familyCount=()=>page.locator('.series-card').evaluateAll(nodes=>nodes.filter(node=>['7663491547907755033','7672980478944611352','7679746591594384409','7687248701831515198','7697459723225795646','7703825719729589310'].includes(node.dataset.seriesId)).length);
 let family=await familyCount();
 for(let index=0;index<4&&family<6;index++){
  const more=page.getByRole('button',{name:/加载更多故事/});if(!await more.count())break;
  await more.click();await expect(more).not.toBeDisabled({timeout:45000});family=await familyCount();
 }
 check('完整剧名搜索取得手机剧集分类的六季',family>=6,{found:family});
 await page.locator(`.series-card[data-series-id="${first}"]`).first().locator('.series-poster-button').click();
 const sheet=page.getByRole('dialog');await expect.poll(()=>sheet.locator('.season-overview-card').count(),{timeout:120000}).toBe(6);
 const totals=await sheet.locator('.season-overview-card em').allTextContents();
 check('季概览核对六季官方集数',JSON.stringify(totals)===JSON.stringify([77,85,118,200,188,154].map(number=>`${number} 集`)),totals);
 await sheet.getByRole('button',{name:/^查看第 6 季：/}).click();await expect.poll(()=>sheet.locator('.detail-hero h2').textContent(),{timeout:60000}).toBe(title+'第六季');
 check('切换详情后第六季高亮且保留所有季',await sheet.getByRole('button',{name:/^查看第 6 季：/}).getAttribute('aria-current')==='true');
 await sheet.getByLabel('全部季概览').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(work,'six-seasons.png')});
 check('全程隐藏静音且无渲染异常',errors.length===0&&await instance.evaluate(({BrowserWindow,webContents})=>BrowserWindow.getAllWindows().every(window=>!window.isVisible())&&webContents.getAllWebContents().every(contents=>contents.isAudioMuted())));
}catch(error){checks.push({name:'真实实时搜索和六季验证',ok:false,errorType:error.name});console.error(error.name);process.exitCode=1;}
finally{await writeFile(path.join(work,'result.json'),JSON.stringify({checks,errors},null,2));await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
