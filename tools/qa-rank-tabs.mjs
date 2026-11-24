// Real packaged-app regression: rank tabs order and default selection.
import {quietElectron as electron} from './quiet-electron.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),out=path.join(root,'_work/rank-tabs');
await mkdir(out,{recursive:true});
const packaged=process.argv.includes('--packaged');
const executable=process.env.HG_QA_PACKAGED_PATH||path.join(root,'release/win-unpacked/红果桌面.exe');
const resultName=packaged?'packaged':'source';
const checks=[],errors=[];
const check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log(JSON.stringify(checks.at(-1)));};
let instance,page;
try{
  instance=await electron.launch({...((!packaged)?{args:['.'],cwd:root}:{executablePath:executable,args:[]}),env:{...process.env,HG_TEST_DATA_DIR:path.join(out,'profile-'+resultName),HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out},timeout:60000});
  page=await instance.firstWindow();
  page.on('pageerror',e=>errors.push(e.name));
  await instance.evaluate(({ipcMain})=>{
    const series={id:'9999999999999997771',title:'排行页签演示',cover:'',intro:'',totalEpisodes:10,tags:[],actors:[]};
    ipcMain.removeHandler('api:request');
    const fixture=(route)=>{
      if(route==='/account/session')return{loggedIn:false,uid:'',nickname:'',avatar:'',mobile:''};
      if(route.startsWith('/catalog/rank'))return{items:[series],hasMore:false,cursor:null};
      if(route.startsWith('/catalog/filters'))return{groups:[]};
      if(route.startsWith('/catalog/'))return{items:[series],hasMore:false,cursor:null};
      if(route==='/media/cache/settings')return{};
      throw new Error('unexpected '+route);
    };
    ipcMain.handle('api:request',(_e,route)=>fixture(route));
  });
  await page.waitForSelector('.app-shell');
  await page.getByRole('button',{name:'排行榜',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.catalog-filter'));
  await page.waitForTimeout(600);
  const tabs=await page.locator('.genre-tabs button').allTextContents();
  check('排行榜页签顺序为 系列剧/漫剧/AI剧/真人短剧',JSON.stringify(tabs)===JSON.stringify(['系列剧','漫剧','AI 剧','真人短剧']),{tabs});
  const active=await page.locator('.genre-tabs button.active').textContent();
  check('排行榜默认选中第一个页签（系列剧）',active==='系列剧',{active});
  const heading=await page.locator('.section-heading h2').textContent();
  check('默认榜单标题为系列剧推荐榜',heading.includes('系列剧'),{heading});
  // 用户主动点过页签后，选择必须保留（不能每次都强制跳回系列剧）。
  await page.locator('.genre-tabs button',{hasText:'漫剧'}).click();
  await page.waitForTimeout(500);
  const picked=await page.locator('.genre-tabs button.active').textContent();
  check('主动切换排行榜页签后保持所选类型',picked==='漫剧',{picked});
  const pickedHeading=await page.locator('.section-heading h2').textContent();
  check('切换后榜单标题不再是系列剧',!pickedHeading.includes('系列剧'),{pickedHeading});
  check('无渲染异常',errors.length===0,{errors});
}catch(error){
  checks.push({name:'harness',ok:false,error:error.name,message:String(error.message).slice(0,300)});
  console.error(error.name+': '+String(error.message).slice(0,300));process.exitCode=1;
  if(page)await page.screenshot({path:path.join(out,'failure-'+resultName+'.png')}).catch(()=>{});
}finally{
  await writeFile(path.join(out,'result-'+resultName+'.json'),JSON.stringify({checks,errors},null,2));
  if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
}
