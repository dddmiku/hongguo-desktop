import {_electron as electron} from '@playwright/test';
import {mkdir,copyFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),data=path.join(root,'_work','cloud-history-qa');await mkdir(data,{recursive:true});
await copyFile(path.join(process.env.APPDATA,'红果桌面','account-session.dpapi'),path.join(data,'account-session.dpapi'));
const app=await electron.launch({args:['.'],cwd:root,env:{...process.env,HG_TEST_DATA_DIR:data},timeout:60000});const page=await app.firstWindow(),pages=[];
try{
  const session=await page.evaluate(()=>window.hongguo.request('/account/session'));if(!session.loggedIn)throw new Error('当前账号不可用');
  let cursor='',seen=new Set(),duplicates=0;
  for(let n=0;n<12;n++){
    const p=await page.evaluate(cursor=>window.hongguo.request('/account/history?limit=100&refresh=true'+(cursor?'&cursor='+encodeURIComponent(cursor):'')),cursor);
    if(p.warning)throw new Error(p.warning);
    for(const item of p.items){if(seen.has(item.series.id))duplicates++;seen.add(item.series.id);if(item.watchedAt>100000000000)throw new Error('观看时间未归一');}
    pages.push({page:n+1,items:p.items.length,total:p.total,hasMore:p.hasMore,complete:p.complete});
    if(!p.hasMore)break;if(!p.nextCursor||p.nextCursor===cursor)throw new Error('分页未前进');cursor=p.nextCursor;
  }
  const result={pages,unique:seen.size,duplicates,complete:pages.at(-1)?.complete};console.log(JSON.stringify(result));await writeFile(path.join(data,'result.json'),JSON.stringify(result,null,2));
}finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
