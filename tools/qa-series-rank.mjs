// Compare the actual series rankings and details with the isolated desktop UI.
import {quietElectron as electron} from './quiet-electron.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd(),packaged=process.argv.includes('--packaged');
const mode=packaged?'packaged':'source',out=path.join(root,'_work','series-rank-qa',mode);
await mkdir(out,{recursive:true});
const env={...process.env,HG_TEST_DATA_DIR:path.join(out,'profile'),HG_TEST_BACKGROUND:'1',TEMP:out,TMP:out};
delete env.ELECTRON_RUN_AS_NODE;
const checks=[],errors=[],boards={};let instance,page,stage='启动隔离客户端';
const allPages=process.argv.includes('--all-pages');
const check=(name,ok,detail)=>{checks.push({name,ok,...(detail===undefined?{}:{detail})});console.log(JSON.stringify(checks.at(-1)));if(!ok)throw new Error(name);};
const route=board=>'/catalog/rank?board='+board+'&genre=series';
const validCover=value=>{try{return ['http:','https:'].includes(new URL(value).protocol);}catch{return false;}};
const summary=rows=>rows.map(row=>({id:row.id,title:row.title,tags:row.tags,totalEpisodes:row.totalEpisodes,coverAvailable:validCover(row.cover)}));
const visibleCoverState=()=>page.evaluate(()=>{const cards=Array.from(document.querySelectorAll('.catalog-page .series-card')).filter(card=>{const rect=card.getBoundingClientRect();return rect.width>0&&rect.height>0&&rect.top<innerHeight&&rect.bottom>0;});return {visible:cards.length,decoded:cards.filter(card=>{const image=card.querySelector('img.poster');return image?.complete&&image.naturalWidth>0;}).length};});
const getBoard=async board=>{
  stage='读取真实'+board+'榜单';
  const result=await page.evaluate(route=>window.hongguo.request(route,{timeout:90000}),route(board));
  check(board+'榜单实际返回有效作品',Array.isArray(result.items)&&result.items.length>0&&result.items.every(row=>/^\d+$/.test(row.id)),{items:result.items?.length||0});
  boards[board]={items:summary(result.items),hasMore:!!result.hasMore};
  return result;
};
const matchBoard=async data=>{
  await page.waitForFunction(ids=>{
    const actual=Array.from(document.querySelectorAll('.catalog-page .series-card'),card=>card.getAttribute('data-series-id'));
    return actual.length===ids.length&&actual.every((id,index)=>id===ids[index]);
  },data.items.map(row=>row.id),{timeout:90000});
};
const verifyBoard=async(board,label)=>{
  stage='对照'+label+'的真实结果';
  await page.getByRole('group',{name:'排行榜类型'}).getByRole('button',{name:label,exact:true}).click();
  const data=await getBoard(board);await matchBoard(data);
  const covers=data.items.slice(0,Math.min(6,data.items.length));
  check(label+'首屏作品提供真实封面地址',covers.length>=3&&covers.every(row=>validCover(row.cover)),{available:covers.filter(row=>validCover(row.cover)).length,checked:covers.length});
  stage='等待'+label+'首屏真实封面解码';
  await page.waitForFunction(()=>{const cards=Array.from(document.querySelectorAll('.catalog-page .series-card')).filter(card=>{const rect=card.getBoundingClientRect();return rect.width>0&&rect.height>0&&rect.top<innerHeight&&rect.bottom>0;});return cards.length>=3&&cards.every(card=>{const image=card.querySelector('img.poster');return image?.complete&&image.naturalWidth>0;});},undefined,{timeout:60000}).catch(()=>{});
  const coverState=await visibleCoverState();
  check(label+'首屏至少三张真实封面完成解码且无未完成封面',coverState.decoded>=3&&coverState.decoded===coverState.visible,coverState);
  await page.evaluate(async()=>{const images=Array.from(document.querySelectorAll('.catalog-page .series-card img.poster')).filter(image=>{const rect=image.getBoundingClientRect();return rect.width>0&&rect.height>0&&rect.top<innerHeight&&rect.bottom>0;});await Promise.all(images.map(image=>image.decode()));await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  stage='对照'+label+'的真实结果';
  const button=page.getByRole('group',{name:'排行榜类型'}).getByRole('button',{name:label,exact:true});
  check(label+'选中状态和显示结果与真实接口一致',await button.getAttribute('aria-pressed')==='true',{items:data.items.length,firstId:data.items[0].id});
  const season=data.items.find(row=>row.tags?.slice(0,2).some(tag=>/第\s*\d+\s*季/.test(tag)));
  const tag=season?.tags.slice(0,2).find(tag=>/第\s*\d+\s*季/.test(tag));
  check(label+'作品显示上游真实季数',!!season&&!!tag&&(await page.locator('.series-card[data-series-id="'+season.id+'"] .series-info p').innerText()).includes(tag));
  const ranks=await page.locator('.catalog-page .rank-number').allTextContents();
  check(label+'名次按真实返回顺序展示',ranks.length===data.items.length&&ranks.every((rank,index)=>rank===String(index+1).padStart(2,'0')));
  check(label+'分页入口与接口状态一致',await page.getByRole('button',{name:'加载更多故事',exact:true}).count()===(data.hasMore?1:0));
  await page.screenshot({path:path.join(out,board+'.png'),animations:'disabled'});
  return data;
};
const verifyPagination=async(board,label,first)=>{
  stage='核对'+label+'真实后续页';
  let expected=first,loaded=first.items.slice(),pageCount=1;
  const more=()=>page.getByRole('button',{name:'加载更多故事',exact:true});
  while(expected.hasMore&&(allPages||pageCount<4)){
    check(label+'后续页提供有效游标',typeof expected.cursor==='string'&&expected.cursor.length>0);
    const next=await page.evaluate(route=>window.hongguo.request(route,{timeout:90000}),route(board)+'&cursor='+encodeURIComponent(expected.cursor));
    check(label+'第'+(pageCount+1)+'页确实提供新增作品',next.items.length>0&&next.items.every(row=>!loaded.some(old=>old.id===row.id)),{items:next.items.length});
    await more().click();
    loaded=[...loaded,...next.items];expected=next;pageCount++;
    await matchBoard({items:loaded});
    const ranks=await page.locator('.catalog-page .rank-number').allTextContents();
    check(label+'第'+pageCount+'页保留已有作品且名次连续',new Set(loaded.map(row=>row.id)).size===loaded.length&&ranks.length===loaded.length&&ranks.every((rank,index)=>rank===String(index+1).padStart(2,'0')),{loaded:loaded.length});
    if(pageCount>=200)throw new Error('官方分页超过验收预算');
  }
  check(label+'分页按钮与实际官方末页一致',await more().count()===(expected.hasMore?1:0),{pages:pageCount,loaded:loaded.length,complete:!expected.hasMore});
  boards[board].pagination={pages:pageCount,loaded:loaded.length,complete:!expected.hasMore};
  stage='刷新'+label+'恢复首屏';
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  // Refresh creates a new official ranking session; obtain the new first page.
  await page.waitForFunction(()=>!document.querySelector('.refresh-button')?.disabled,undefined,{timeout:90000});
  const refreshed=await getBoard(board);await matchBoard(refreshed);
  return refreshed;
};

try{
  instance=await electron.launch({...(packaged?{executablePath:process.env.HG_QA_PACKAGED_PATH||path.join(root,'release','win-unpacked','红果桌面.exe'),args:[]}:{args:['.'],cwd:root}),env,timeout:60000});
  page=await instance.firstWindow();page.on('pageerror',error=>errors.push(error.name));
  await page.waitForSelector('.app-shell',{timeout:30000});
  // Only reset public preferences and cache inside this script's own profile.
  await page.evaluate(()=>{localStorage.removeItem('hongguo:catalog-selection-v1');localStorage.removeItem('hongguo:public-catalog-v1');localStorage.removeItem('hongguo:public-catalog-v2');});
  await page.reload();await page.waitForSelector('.app-shell',{timeout:30000});
  const profile=await instance.evaluate(({app})=>app.getPath('userData'));
  const session=await page.evaluate(()=>window.hongguo.request('/account/session'));
  check('使用独立访客数据目录',profile===env.HG_TEST_DATA_DIR&&!session.loggedIn);
  // Chromium does not necessarily load lazy cover images in a hidden QA window.
  // Show this isolated window without stealing focus; never rewrite image sources.
  await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());
  await page.waitForFunction(()=>document.visibilityState==='visible',undefined,{timeout:10000});
  stage='打开系列剧排行榜';
  await page.getByRole('button',{name:'排行榜',exact:true}).click();
  await page.getByRole('tab',{name:'系列剧',exact:true}).click();
  check('系列剧模式显示独立标题和子榜单',await page.getByRole('heading',{name:'系列剧排行榜',exact:true}).count()===1&&await page.getByRole('button',{name:'推荐榜',exact:true}).getAttribute('aria-pressed')==='true');
  const recommended=await verifyPagination('recommend','推荐榜',await verifyBoard('recommend','推荐榜'));
  const latest=await verifyPagination('new','新季榜',await verifyBoard('new','新季榜'));
  stage='快速切榜后核对结果';
  await page.getByRole('button',{name:'推荐榜',exact:true}).click();await page.getByRole('button',{name:'新季榜',exact:true}).click();
  await matchBoard(latest);
  check('快速切换后仍保持最终新季榜',await page.getByRole('button',{name:'新季榜',exact:true}).getAttribute('aria-pressed')==='true');
  stage='读取所选系列剧真实详情';
  const first=latest.items[0],details=await page.evaluate(id=>window.hongguo.request('/catalog/series/'+id,{timeout:90000}),first.id);
  check('榜单入口可读取原有剧集详情',details.series?.id===first.id&&Array.isArray(details.episodes)&&details.episodes.length>0&&details.episodes.every(episode=>Number.isInteger(episode.index)&&episode.index>0&&typeof episode.vid==='string'&&episode.vid.length>0),{episodes:details.episodes?.length||0});
  await page.locator('.series-card[data-series-id="'+first.id+'"] .series-poster-button').click();
  await page.waitForSelector('.detail-hero',{timeout:90000});
  await page.waitForFunction(expected=>document.querySelector('.detail-copy h2')?.textContent===expected,details.series.title,{timeout:90000});
  check('详情界面显示真实剧名和可播放集数',await page.locator('.episode-grid button').count()===Math.min(120,details.episodes.length)&&await page.locator('.episode-grid button').first().getAttribute('aria-label')==='播放第 '+details.episodes[0].index+' 集',{episodes:details.episodes.length});
  await page.screenshot({path:path.join(out,'detail.png')});
  await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
  stage='检查原榜单和独立选择';
  await page.getByRole('tab',{name:'漫剧',exact:true}).click();
  check('原漫剧分类仍显示热播榜与新剧榜',await page.getByRole('button',{name:'热播榜',exact:true}).count()===1&&await page.getByRole('button',{name:'新剧榜',exact:true}).count()===1&&await page.getByRole('button',{name:'推荐榜',exact:true}).count()===0);
  await page.getByRole('tab',{name:'系列剧',exact:true}).click();await matchBoard(latest);
  check('返回系列剧恢复独立新季榜选择',await page.getByRole('button',{name:'新季榜',exact:true}).getAttribute('aria-pressed')==='true');
  await page.getByRole('button',{name:'推荐榜',exact:true}).click();await matchBoard(recommended);
  check('返回推荐榜仍显示对应真实片单',await page.getByRole('button',{name:'推荐榜',exact:true}).getAttribute('aria-pressed')==='true');
  check('运行中无渲染异常且测试窗口静音',errors.length===0&&await instance.evaluate(({webContents})=>webContents.getAllWebContents().every(contents=>contents.isAudioMuted())));
}catch(error){checks.push({name:'系列剧验收中断',ok:false,stage,errorType:error.name});console.error(JSON.stringify(checks.at(-1)));process.exitCode=1;if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{
  if(instance){await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});}
  await writeFile(path.join(out,'result.json'),JSON.stringify({mode,checks,errors,boards},null,2));
}
