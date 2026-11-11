import {describe,it,expect} from 'vitest';
import {PlaybackCheckpoint} from './PlaybackCheckpoint';

describe('progress through HLS media reloads',()=>{
  it('retains the displayed progress when reload resets currentTime to zero',()=>{
    let clock=0;const video={readyState:4,currentTime:12,paused:false,ended:false,playbackRate:1.5};
    const checkpoint=new PlaybackCheckpoint(video,0,()=>clock);checkpoint.capture();
    video.readyState=0;video.currentTime=0;clock=200;checkpoint.capture();
    expect(checkpoint.read()).toBeCloseTo(12.3);
  });
  it('does not advance a user-paused video during a disconnected reload',()=>{
    let clock=0;const video={readyState:4,currentTime:12,paused:true,ended:false,playbackRate:1};
    const checkpoint=new PlaybackCheckpoint(video,0,()=>clock);checkpoint.capture();
    video.readyState=0;video.currentTime=0;clock=5000;
    expect(checkpoint.read()).toBe(12);
  });
  it('retains a backwards seek instead of restoring the previous higher position',()=>{
    const video={readyState:4,currentTime:12,paused:true,ended:false,playbackRate:1};
    const checkpoint=new PlaybackCheckpoint(video,0,()=>0);checkpoint.capture();video.currentTime=2;checkpoint.capture();
    video.readyState=0;video.currentTime=0;expect(checkpoint.read()).toBe(2);
  });
  it('does not turn a long disconnected wait into skipped content',()=>{
    let clock=0;const video={readyState:4,currentTime:12,paused:false,ended:false,playbackRate:1};
    const checkpoint=new PlaybackCheckpoint(video,0,()=>clock);checkpoint.capture();video.readyState=0;video.currentTime=0;clock=20000;
    expect(checkpoint.read()).toBe(12.25);
  });
});
