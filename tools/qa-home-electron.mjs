import { _electron as electron } from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),data=path.join(root,'_work','home-real-client'),results=[];await mkdir(data,{recursive:true});
for(let run=0;run<2;run++){
  const start=Date.now(),app=await electron.launch({args:['.'],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:data},timeout:60000});const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.waitForSelector('.series-card',{timeout:90000});const cardsVisibleMs=Date.now()-start;
    await page.waitForFunction(()=>{const image=document.querySelector('.feature-backdrop img');return image?.complete&&image.naturalWidth>0;},undefined,{timeout:30000});const heroVisibleMs=Date.now()-start;
    const before=Date.now();await page.getByRole('button',{name:'观看历史',exact:true}).click();await page.waitForSelector('.library-page');await page.getByRole('button',{name:'发现',exact:true}).click();await page.waitForSelector('.series-card',{timeout:1000});const returnMs=Date.now()-before;
    results.push({run:run+1,cardsVisibleMs,heroVisibleMs,returnMs,cards:await page.locator('.series-card').count(),errors});console.log(JSON.stringify(results.at(-1)));
    await page.screenshot({path:path.join(data,`home-${run+1}.png`)});
  }finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
}
await writeFile(path.join(data,'verification.json'),JSON.stringify(results,null,2));
if(results.some(r=>r.errors.length)||results[1].cardsVisibleMs>2500)process.exitCode=1;
