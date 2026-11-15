export interface PlaybackRecoverySnapshot {
  time:number;now:number;enabled:boolean;paused:boolean;ended:boolean;seeking:boolean;
  bufferedAhead:number;failed?:boolean;
}
export type PlaybackRecoveryAction='resume'|'recover'|'reconnect'|'failed';

/** Bound recovery for an active playback intent even when HLS emits no fatal error. */
export class PlaybackRecovery {
  private time:number|null=null;
  private observedTime=0;
  private sampledAt=0;
  private progressAt=0;
  private recoverySince:number|null=null;
  private failureSince:number|null=null;
  private healthySince:number|null=null;
  private healthyTime=0;
  private actions=new Set<PlaybackRecoveryAction>();

  reset(){
    this.time=null;this.observedTime=0;this.sampledAt=0;this.progressAt=0;this.recoverySince=null;this.failureSince=null;
    this.healthySince=null;this.healthyTime=0;this.actions.clear();
  }
  /** Restart the no-progress failure window after a replacement source is ready. */
  rebase(now:number,time:number){
    if(!Number.isFinite(now)||!Number.isFinite(time))return;
    this.time=this.observedTime=time;this.sampledAt=this.progressAt=now;
    this.failureSince=now;this.healthySince=null;this.healthyTime=time;
  }
  private emit(action:PlaybackRecoveryAction,since:number){
    if(this.actions.has(action))return null;
    this.recoverySince??=since;this.failureSince??=since;this.actions.add(action);return action;
  }
  inspect(state:PlaybackRecoverySnapshot):PlaybackRecoveryAction|null{
    if(!state.enabled||state.ended){this.reset();return null;}
    if(!Number.isFinite(state.time)||!Number.isFinite(state.now))return null;
    if(state.seeking){
      this.time=null;this.healthySince=null;return null;
    }
    if(this.time===null||state.now<this.sampledAt){
      this.time=this.observedTime=state.time;this.sampledAt=this.progressAt=state.now;this.healthySince=null;
      return state.failed?this.emit('failed',state.now):null;
    }
    const delta=state.time-this.time,moving=state.time>this.observedTime+.000001,gap=state.now-this.sampledAt;
    this.observedTime=state.time;this.sampledAt=state.now;
    if(moving){
      if(this.healthySince===null||gap>750){this.healthySince=state.now;this.healthyTime=state.time;}
      // A decoder can advance a single sample then freeze again. Only sustained
      // decoded progress grants a fresh set of recovery attempts.
      if(state.now-this.healthySince>=1000&&state.time-this.healthyTime>=.5){
        this.actions.clear();this.recoverySince=null;this.failureSince=null;
      }
    }else this.healthySince=null;
    if(delta>=.05){this.time=state.time;this.progressAt=state.now;return null;}
    if(delta<-.05){this.time=state.time;this.progressAt=state.now;}
    const since=this.recoverySince??this.progressAt,elapsed=state.now-since;
    const failureElapsed=state.now-(this.failureSince??since);
    if(state.failed||failureElapsed>=18000)return this.emit('failed',since);
    if(this.actions.has('failed'))return null;
    if(elapsed>=10000)return this.emit('reconnect',since);
    if(elapsed>=5000)return this.emit('recover',since);
    if(state.paused&&state.now-this.progressAt>=1000)return this.emit('resume',since);
    return null;
  }
}
