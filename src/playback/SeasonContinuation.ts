import type {NativeBridge,NextSeason,SeriesDetail} from '../../shared/contracts';

export type SeasonDestination={result:NextSeason;detail:SeriesDetail|null};

/** Resolve once per season, share pending discovery and discard responses from a departed season. */
export class SeasonContinuation {
  private generation=0;
  private source='';
  private pending:Promise<SeasonDestination>|null=null;
  constructor(private bridge:Pick<NativeBridge,'request'>){}
  reset(){this.generation++;this.source='';this.pending=null;}
  resolve(source:string,refresh=false):Promise<SeasonDestination>{
    if(this.source===source&&this.pending&&!refresh)return this.pending;
    this.reset();this.source=source;const generation=this.generation;
    const current=()=>generation===this.generation;
    const check=()=>{if(!current())throw new DOMException('Season discovery cancelled','AbortError');};
    const pending=(async()=>{
      const result=await this.bridge.request<NextSeason>(`/catalog/series/${source}/next-season${refresh?'?refresh=true':''}`,{timeout:90000});
      check();
      if(result.seriesId!==source)throw new Error('下一季信息与当前剧集不一致');
      if(result.status!=='found')return {result,detail:null};
      if(!result.next||result.next.id===source||!result.firstEpisode)throw new Error('下一季暂时没有可播放的内容');
      const detail=await this.bridge.request<SeriesDetail>(`/catalog/series/${result.next.id}`,{timeout:60000});
      check();
      if(detail.series.id!==result.next.id||!detail.episodes.some(item=>item.index===result.firstEpisode))throw new Error('下一季剧集暂未就绪');
      return {result,detail};
    })();
    this.pending=pending;
    void pending.catch(()=>{if(current())this.pending=null;});
    return pending;
  }
}
