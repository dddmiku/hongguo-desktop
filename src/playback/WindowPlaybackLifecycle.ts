/** Keeps playback suspension idempotent while allowing focus to re-arm media recovery. */
export class WindowPlaybackLifecycle {
  constructor(
    private readonly suspendPlayback:()=>void,
    private readonly resumePlayback:()=>void,
    private visible:boolean,
  ){}

  setVisible(visible:boolean){
    if(this.visible===visible)return;
    this.visible=visible;
    if(visible)this.resumePlayback();else this.suspendPlayback();
  }

  focus(){
    if(this.visible)this.resumePlayback();
  }
}
