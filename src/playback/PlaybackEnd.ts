export interface EndState {
  id:string;time:number;duration:number;bufferedEnd:number;sealed:boolean;ended:boolean;
  playing:boolean;seeking:boolean;enabled:boolean;now:number;rate:number;
}

/** Treat the real ended event as authoritative; recover only a sealed stream frozen at its final samples. */
export class PlaybackEnd {
  private id='';
  private time=0;
  private since=0;
  private completed=false;
  reset(){this.id='';this.time=0;this.since=0;this.completed=false;}
  claim(id:string){if(this.id!==id){this.id=id;this.completed=false;}if(this.completed)return false;this.completed=true;return true;}
  inspect(state:EndState){
    if(this.id!==state.id){this.id=state.id;this.time=state.time;this.since=state.now;this.completed=false;}
    if(this.completed)return false;
    const tail=Math.min(state.duration,state.bufferedEnd);
    const atTail=state.sealed&&tail>0&&state.duration-tail<=.4&&tail-state.time<=.3&&state.time<=state.duration+.1;
    if(!state.enabled||!state.playing||state.seeking||!Number.isFinite(state.time)||!atTail){this.time=state.time;this.since=state.now;return false;}
    if(state.ended)return true;
    if(Math.abs(state.time-this.time)>.000001){this.time=state.time;this.since=state.now;return false;}
    // Wait long enough for all remaining samples at the actual speed, plus a
    // decode margin. A sealed A/V tail mismatch need not freeze every cut for 800ms.
    const rate=Number.isFinite(state.rate)&&state.rate>0?state.rate:1;
    const wait=Math.max(250,Math.max(0,state.duration-state.time)/rate*1000+150);
    return state.now>=this.since+wait;
  }
}
