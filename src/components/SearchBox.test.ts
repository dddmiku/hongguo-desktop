import {describe,expect,it,vi} from 'vitest';
import type {NativeBridge,Series} from '../../shared/contracts';
import {requestSearchSuggestions,searchText,suggestionQuery} from './SearchBox';
const series=(number:number):Series=>({id:String(12345678+number),title:`作品${number}`,cover:'',intro:'',totalEpisodes:30,tags:['爱情'],actors:[]});
const bridge=(request:(route:string,options?:unknown)=>Promise<unknown>)=>({request} as Pick<NativeBridge,'request'>);

describe('顶部搜索建议读取边界',()=>{
  it('过滤未完成或纯标点关键词，同时保留完整文字和单个数字',()=>{
    expect(suggestionQuery('红')).toBe('');expect(suggestionQuery('，？ ')).toBe('');
    expect(suggestionQuery(' 红果 ')).toBe('红果');expect(suggestionQuery('a')).toBe('a');expect(suggestionQuery('2')).toBe('2');
    expect(searchText('红\n果')).toBe('红果');
  });
  it('请求使用编码关键词、15秒上限，并去重最多展示八部作品',async()=>{
    const request=vi.fn(async()=>({items:[series(0),series(0),...Array.from({length:12},(_,index)=>series(index+1))]}));
    const rows=await requestSearchSuggestions(bridge(request),'红果 & 春风',new AbortController().signal);
    expect(request).toHaveBeenCalledWith('/catalog/search/suggestions?query='+encodeURIComponent('红果 & 春风'),{timeout:15000});
    expect(rows).toHaveLength(8);expect(new Set(rows.map(row=>row.id)).size).toBe(8);
  });
  it('失焦取消后在途IPC返回也不能交付到建议列表',async()=>{
    let finish!:(value:{items:Series[]})=>void;
    const request=vi.fn(()=>new Promise<{items:Series[]}>(done=>{finish=done;}));
    const abort=new AbortController();const pending=requestSearchSuggestions(bridge(request),'红果',abort.signal);
    abort.abort();finish({items:[series(0)]});
    await expect(pending).rejects.toMatchObject({name:'AbortError'});
  });
  it('已取消查询不发新请求，结构错误给出可重试业务提示',async()=>{
    const request=vi.fn(async()=>({items:null}));const abort=new AbortController();abort.abort();
    await expect(requestSearchSuggestions(bridge(request),'红果',abort.signal)).rejects.toMatchObject({name:'AbortError'});expect(request).not.toHaveBeenCalled();
    await expect(requestSearchSuggestions(bridge(request),'红果',new AbortController().signal)).rejects.toThrow('搜索结果暂时不可用，请重试。');
  });
});
