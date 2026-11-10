import {describe,expect,it,vi} from 'vitest';
import type {NativeBridge,SeasonOverview} from '../../shared/contracts';
import {requestSeasonOverview} from './SeasonOverview';

const source='12345678';
const overview:SeasonOverview={seriesId:source,status:'single',source:null,currentSeason:1,seasons:[]};
const bridge=(request:(route:string,options?:unknown)=>Promise<unknown>)=>({request} as Pick<NativeBridge,'request'>);

describe('全部季读取边界',()=>{
  it('错误作品的响应进入可重试错误，后续刷新可以读到当前作品',async()=>{
    let attempt=0;
    const request=vi.fn(async()=>attempt++===0?{...overview,seriesId:'87654321'}:overview);
    const api=bridge(request);
    await expect(requestSeasonOverview(api,source)).rejects.toThrow('季信息与当前剧集不一致，请重试');
    await expect(requestSeasonOverview(api,source,true)).resolves.toBe(overview);
    expect(request.mock.calls[1]).toEqual([`/catalog/series/${source}/seasons?refresh=true`,{timeout:90000}]);
  });
  it('正确作品的单季结果保持正常并使用现有超时预算',async()=>{
    const request=vi.fn(async()=>overview);
    await expect(requestSeasonOverview(bridge(request),source)).resolves.toBe(overview);
    expect(request).toHaveBeenCalledWith(`/catalog/series/${source}/seasons`,{timeout:90000});
  });
  it('不完整的当季结果保留完整性提示，刷新能补回其余官方季',async()=>{
    const first={id:source,title:'第一季',cover:'',intro:'',totalEpisodes:12,tags:[],actors:[]};
    const partial:SeasonOverview={...overview,complete:false,warning:'部分季暂未补齐，可刷新重试。',seasons:[{season:1,series:first}]};
    const complete:SeasonOverview={...partial,status:'found',complete:true,warning:undefined,seasons:[...partial.seasons,{season:2,series:{...first,id:'87654321',title:'第二季',totalEpisodes:22}}]};
    const request=vi.fn(async(route:string)=>route.includes('refresh=true')?complete:partial);
    const api=bridge(request);
    const current=await requestSeasonOverview(api,source);
    expect(current.complete).toBe(false);expect(current.warning).toBe(partial.warning);expect(current.seasons).toEqual(partial.seasons);
    const refreshed=await requestSeasonOverview(api,source,true);
    expect(refreshed.complete).toBe(true);expect(refreshed.seasons.map(item=>item.season)).toEqual([1,2]);
    expect(current.complete).toBe(false);expect(current.seasons).toHaveLength(1);
  });
});
