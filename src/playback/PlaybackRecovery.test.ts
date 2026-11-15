import {describe,expect,it} from 'vitest';
import {PlaybackRecovery,type PlaybackRecoverySnapshot} from './PlaybackRecovery';

const sample=(patch:Partial<PlaybackRecoverySnapshot>={}):PlaybackRecoverySnapshot=>({
  time:0,now:0,enabled:true,paused:false,ended:false,seeking:false,bufferedAhead:8,...patch,
});

describe('mid-playback recovery budget',()=>{
  it('does not recover a normally advancing video or a rate-independent playback sample',()=>{
    const guard=new PlaybackRecovery();
    expect(guard.inspect(sample())).toBeNull();
    for(let index=1;index<=20;index++){
      expect(guard.inspect(sample({time:index*.2,now:index*200}))).toBeNull();
    }
  });

  it('resumes an accidental pause once, then escalates a frozen playing intent',()=>{
    const guard=new PlaybackRecovery();
    guard.inspect(sample());
    expect(guard.inspect(sample({paused:true,now:1001}))).toBe('resume');
    expect(guard.inspect(sample({paused:true,now:2000}))).toBeNull();
    expect(guard.inspect(sample({paused:false,now:5001}))).toBe('recover');
    expect(guard.inspect(sample({paused:false,now:10001}))).toBe('reconnect');
    expect(guard.inspect(sample({paused:false,now:18001}))).toBe('failed');
    expect(guard.inspect(sample({paused:false,now:19001}))).toBeNull();
  });

  it('never wakes a manual pause, inactive deck, seeking state, or ended stream',()=>{
    for(const patch of [{enabled:false},{paused:true,enabled:false},{seeking:true},{ended:true}]){
      const guard=new PlaybackRecovery();
      guard.inspect(sample());
      expect(guard.inspect(sample({now:30000,...patch}))).toBeNull();
      expect(guard.inspect(sample({now:60000,...patch}))).toBeNull();
    }
  });

  it('does not repeat an action during one stall or after tiny progress bursts',()=>{
    const guard=new PlaybackRecovery();
    guard.inspect(sample());
    expect(guard.inspect(sample({now:5001}))).toBe('recover');
    expect(guard.inspect(sample({time:.1,now:5100}))).toBeNull();
    expect(guard.inspect(sample({time:.1,now:10001}))).toBe('reconnect');
    expect(guard.inspect(sample({time:.2,now:10100}))).toBeNull();
    expect(guard.inspect(sample({time:.2,now:18001}))).toBe('failed');
  });

  it('clears recovery budget only after one second of continuous real progress',()=>{
    const guard=new PlaybackRecovery();
    guard.inspect(sample());
    expect(guard.inspect(sample({now:5001}))).toBe('recover');
    expect(guard.inspect(sample({time:.1,now:5100}))).toBeNull();
    expect(guard.inspect(sample({time:.2,now:5500}))).toBeNull();
    expect(guard.inspect(sample({time:.3,now:6000}))).toBeNull();
    expect(guard.inspect(sample({time:.4,now:6100}))).toBeNull();
    expect(guard.inspect(sample({time:.5,now:6200}))).toBeNull();
    expect(guard.inspect(sample({time:.6,now:6300}))).toBeNull();
    expect(guard.inspect(sample({time:.7,now:6400}))).toBeNull();
    expect(guard.inspect(sample({time:.8,now:6500}))).toBeNull();
    expect(guard.inspect(sample({time:.9,now:6600}))).toBeNull();
    expect(guard.inspect(sample({time:1.0,now:6700}))).toBeNull();
    expect(guard.inspect(sample({time:1,now:11701}))).toBe('recover');
  });

  it('resets failure and the action budget when playback is disabled then reopened',()=>{
    const guard=new PlaybackRecovery();
    guard.inspect(sample());
    expect(guard.inspect(sample({now:18001}))).toBe('failed');
    expect(guard.inspect(sample({enabled:false,now:19000}))).toBeNull();
    expect(guard.inspect(sample({enabled:true,now:19001}))).toBeNull();
    expect(guard.inspect(sample({enabled:true,paused:true,now:20002}))).toBe('resume');
  });

  it('preserves an exhausted budget across sparse micro-progress and internal seeks',()=>{
    const guard=new PlaybackRecovery();
    guard.inspect(sample());
    expect(guard.inspect(sample({now:5001}))).toBe('recover');
    expect(guard.inspect(sample({time:.1,now:5200}))).toBeNull();
    expect(guard.inspect(sample({time:.1,seeking:true,now:6000}))).toBeNull();
    expect(guard.inspect(sample({time:.1,now:6500}))).toBeNull();
    expect(guard.inspect(sample({time:.2,now:9000}))).toBeNull();
    expect(guard.inspect(sample({time:.2,now:10001}))).toBe('reconnect');
    expect(guard.inspect(sample({time:.3,now:12000}))).toBeNull();
    expect(guard.inspect(sample({time:.3,now:18001}))).toBe('failed');
    expect(guard.inspect(sample({time:.4,now:20000}))).toBeNull();
    expect(guard.inspect(sample({time:.4,now:30000}))).toBeNull();
  });

  it('reports an externally failed recovery once and ignores invalid time samples',()=>{
    const guard=new PlaybackRecovery();
    expect(guard.inspect(sample({time:Number.NaN}))).toBeNull();
    guard.inspect(sample());
    expect(guard.inspect(sample({now:100,failed:true}))).toBe('failed');
    expect(guard.inspect(sample({now:200,failed:true}))).toBeNull();
  });

  it('accepts sustained progress sampled more frequently than the significance threshold',()=>{
    const guard=new PlaybackRecovery();
    guard.inspect(sample());
    expect(guard.inspect(sample({now:5001}))).toBe('recover');
    for(let index=1;index<=24;index++){
      expect(guard.inspect(sample({time:index*.0375,now:5001+index*50}))).toBeNull();
    }
    expect(guard.inspect(sample({time:.9,now:11202}))).toBe('recover');
  });

  it('rebases the failure window after reconnect without repeating recovery actions',()=>{
    const guard=new PlaybackRecovery();
    guard.inspect(sample());
    expect(guard.inspect(sample({now:5001}))).toBe('recover');
    expect(guard.inspect(sample({now:10001}))).toBe('reconnect');
    guard.rebase(12000,4.25);
    expect(guard.inspect(sample({time:4.25,now:12001}))).toBeNull();
    expect(guard.inspect(sample({time:4.25,now:17000}))).toBeNull();
    expect(guard.inspect(sample({time:4.25,now:29999}))).toBeNull();
    expect(guard.inspect(sample({time:4.25,now:30000}))).toBe('failed');
    expect(guard.inspect(sample({time:4.25,now:31000}))).toBeNull();
  });

  it('allows a fresh recovery cycle only after sustained decoded progress following rebase',()=>{
    const guard=new PlaybackRecovery();
    guard.inspect(sample());
    expect(guard.inspect(sample({now:5001}))).toBe('recover');
    expect(guard.inspect(sample({now:10001}))).toBe('reconnect');
    guard.rebase(11000,3);
    for(let index=1;index<=12;index++)expect(guard.inspect(sample({time:3+index*.06,now:11000+index*100}))).toBeNull();
    expect(guard.inspect(sample({time:3.72,now:12201}))).toBeNull();
    expect(guard.inspect(sample({time:3.72,now:17202}))).toBe('recover');
  });
});
