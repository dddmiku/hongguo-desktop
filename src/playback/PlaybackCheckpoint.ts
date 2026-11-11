type VideoState=Pick<HTMLVideoElement,'readyState'|'currentTime'|'paused'|'ended'|'playbackRate'>;

/** Keep the last displayed position when an HLS reload empties the media element. */
export class PlaybackCheckpoint {
  private position:number;
  private sampledAt:number;
  private playing=false;
  private rate=1;
  constructor(private video:VideoState,start:number,private now=()=>performance.now()){
    this.position=start;this.sampledAt=now();
  }
  capture(){
    if(this.video.readyState<2||!Number.isFinite(this.video.currentTime))return;
    this.position=this.video.currentTime;this.sampledAt=this.now();
    this.playing=!this.video.paused&&!this.video.ended;this.rate=this.video.playbackRate;
  }
  read(){
    if(this.video.readyState>=2){this.capture();return this.video.currentTime;}
    // Interpolate at most one normal timeupdate interval; waiting for a network
    // timeout must never skip seconds that were not actually displayed.
    return Math.max(0,this.position+(this.playing?Math.min(250,Math.max(0,this.now()-this.sampledAt))*this.rate/1000:0));
  }
}
