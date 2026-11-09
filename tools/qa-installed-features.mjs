// Installed feature checks with public content and an independent, silent account-free profile.
import {expect} from '@playwright/test';
import {quietElectron as electron} from './quiet-electron.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),out=path.join(root,'_work/installed-features');await mkdir(out,{recursive:true});
const expected=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
const instance=await electron.launch({executablePath:path.join(process.env.LOCALAPPDATA,'Programs/hongguo-desktop/红果桌面.exe'),args:[],env:{...process.env,HG_TEST_DATA_DIR:path.join(out,'profile'),HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:60000});
const page=await instance.firstWindow(),checks=[],errors=[];page.on('pageerror',error=>errors.push(error.name));
const check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
try{
 await page.waitForSelector('.app-shell');const health=await page.evaluate(()=>window.hongguo.request('/health'));check('安装版版本与独立内容服务正常',health.version===expected&&health.ok&&health.signer,{version:health.version});
 await page.locator('.discovery-hero').waitFor({timeout:90000});check('发现主视觉与完整片库不重复',await page.locator('.discovery-content').count()===1&&await page.locator('.category-shelf').count()===0);
 check('新图标显示实际图片',await page.locator('.brand-icon').evaluate(img=>img.complete&&img.naturalWidth>0));
 await page.getByLabel('搜索剧名、演员或关键词').fill('觉醒伪神：神明弃我我自为神');await page.getByLabel('搜索剧名、演员或关键词').press('Enter');
 await page.locator('.series-card').first().waitFor({timeout:90000});
 const search=await page.evaluate(()=>window.hongguo.request('/catalog/search?q='+encodeURIComponent('觉醒伪神：神明弃我我自为神')));
 const first=search.items[0],overview=await page.evaluate(id=>window.hongguo.request('/catalog/series/'+id+'/seasons',{timeout:90000}),first.id);
 check('全称搜索前八条按八季显示且不重复',overview.seasons.length===8&&new Set(search.items.slice(0,8).map(x=>x.id)).size===8&&overview.seasons.every(x=>search.items.slice(0,8).some(y=>y.id===x.series.id)),{seasons:overview.seasons.map(x=>({season:x.season,episodes:x.series.totalEpisodes}))});
 await page.locator(`.series-card[data-series-id="${first.id}"]`).first().locator('.series-poster-button').click();await page.locator('.season-overview-card').first().waitFor({timeout:90000});check('详情实际显示八季概览',await page.locator('.season-overview-card').count()===8);
 await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'登录账号',exact:true}).click();
 await page.getByRole('tab',{name:'扫码登录',exact:true}).click();await page.locator('.qr-login-code img').waitFor({timeout:45000});
 check('安装版扫码选项生成官方二维码',await page.locator('.qr-login-code img').evaluate(img=>img.complete&&img.naturalWidth>0));
 await page.getByRole('button',{name:'取消扫码',exact:true}).click();await expect.poll(()=>page.locator('.qr-login-cancelled').count()).toBe(1);check('扫码取消与验证码选项可切换',true);await page.getByRole('tab',{name:'验证码登录',exact:true}).click();await page.getByLabel('手机号',{exact:true}).waitFor();
 check('扫码验收未更改正式账号',!(await page.evaluate(()=>window.hongguo.request('/account/session'))).loggedIn);
 check('窗口保持隐藏静音',await instance.evaluate(({BrowserWindow,webContents})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible())&&webContents.getAllWebContents().every(c=>c.isAudioMuted())));
 check('无界面异常',errors.length===0,errors);
}catch(error){checks.push({name:'安装功能回归',ok:false,errorType:error.name,message:error.message});console.error(error.name+': '+error.message);process.exitCode=1;}
finally{await writeFile(path.join(out,'result.json'),JSON.stringify({checks,errors},null,2));await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
