// Regression for a series whose season count exceeds the old discovery limit.
import {expect} from '@playwright/test';
import {quietElectron as electron} from './quiet-electron.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
os.setPriority(0,os.constants.priority.PRIORITY_BELOW_NORMAL);
const root=process.cwd(),installed=process.argv.includes('--installed'),out=path.join(root,'_work/season-enumeration',installed?'installed-ui':'current-ui');
await mkdir(out,{recursive:true});
const instance=await electron.launch({...(installed?{executablePath:path.join(process.env.LOCALAPPDATA,'Programs/hongguo-desktop/红果桌面.exe'),args:[]}:{args:['.'],cwd:root}),env:{...process.env,HG_TEST_DATA_DIR:path.join(out,'profile'),HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:60000});
const page=await instance.firstWindow(),checks=[],errors=[];
page.on('pageerror',error=>errors.push(error.name));
const first='7637569673411709976',title='谁说没灵根不能修仙的？之无灵证道';
const check=(name,ok,details)=>{checks.push({name,ok,...(details?{details}:{})});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
try{
  await page.waitForSelector('.app-shell');
  await page.getByLabel('搜索剧名、演员或关键词').fill('谁说没灵根不能修仙');
  await page.getByLabel('搜索剧名、演员或关键词').press('Enter');
  await page.locator(`.series-card[data-series-id="${first}"]`).first().waitFor({timeout:90000});
  await page.locator(`.series-card[data-series-id="${first}"]`).first().locator('.series-poster-button').click();
  const sheet=page.getByRole('dialog');
  await expect.poll(()=>sheet.locator('.season-overview-card').count(),{timeout:180000,intervals:[300,800,1500]}).toBe(46);
  const rows=await sheet.locator('.season-overview-card').evaluateAll(nodes=>nodes.map(node=>({number:Number(node.querySelector('small')?.textContent.match(/\d+/)?.[0]),title:node.querySelector('strong')?.textContent,total:Number(node.querySelector('em')?.textContent.match(/\d+/)?.[0])})));
  check('真实系列概览显示1至46季并按序排列',rows.length===46&&rows.every((row,index)=>row.number===index+1));
  check('各季总集数均由官方详情取得',rows.every(row=>row.total>0)&&rows[0].total===78&&rows[1].total===94&&rows[44].total===108,{first:rows[0].total,second:rows[1].total,fortyFifth:rows[44].total,fortySixth:rows[45].total});
  check('查询范围未穷尽时明确显示已找到而非全部数量',(await sheet.getByLabel('全部季概览').innerText()).includes('已找到 46 季'));
  await sheet.getByRole('button',{name:/^查看第 45 季：/}).click();
  await expect.poll(()=>sheet.locator('.detail-hero h2').textContent(),{timeout:90000}).toBe(title+'45季');
  await expect.poll(()=>sheet.locator('.season-overview-card').count(),{timeout:90000}).toBe(46);
  check('从第45季查看仍保留46季概览且当前季高亮',await sheet.getByRole('button',{name:/^查看第 45 季：/}).getAttribute('aria-current')==='true');
  check('季概览始终提供局部刷新入口',await sheet.getByLabel('刷新季信息').isEnabled());
  await sheet.getByRole('button',{name:/^查看第 45 季：/}).scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(out,'forty-five.png')});
  check('测试全程隐藏静音',await instance.evaluate(({BrowserWindow,webContents})=>BrowserWindow.getAllWindows().every(window=>!window.isVisible())&&webContents.getAllWebContents().every(contents=>contents.isAudioMuted())));
  check('无渲染异常',errors.length===0);
}catch(error){checks.push({name:'大于40季的真实概览验收',ok:false,errorType:error.name});console.error(error.name);process.exitCode=1;}
finally{await writeFile(path.join(out,'result.json'),JSON.stringify({checks,errors},null,2));await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
