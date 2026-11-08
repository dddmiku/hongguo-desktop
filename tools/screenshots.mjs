import {quietElectron as electron} from './quiet-electron.mjs';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
const root=process.cwd(),out=path.join(root,'docs','screenshots');await mkdir(out,{recursive:true});
const instance=await electron.launch({args:['.'],env:{...process.env,HG_TEST_DATA_DIR:path.join(root,'_work','public-screenshots')},timeout:60000});
const page=await instance.firstWindow();
try{
  await page.waitForSelector('.series-card',{timeout:90000});await page.screenshot({path:path.join(out,'home.png')});
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'浅色',exact:true}).click();await page.waitForTimeout(300);await page.screenshot({path:path.join(out,'settings-light.png')});
}finally{await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
