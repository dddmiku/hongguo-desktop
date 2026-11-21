import {describe,it,expect} from 'vitest';
import {PlaybackEnd,type EndState} from './PlaybackEnd';
const state=(patch:Partial<EndState>={}):EndState=>({id:'episode-150',time:42.21,duration:42.466,bufferedEnd:42.392,sealed:true,ended:false,playing:true,seeking:false,enabled:true,now:0,rate:1,...patch});
describe('sealed playback completion',()=>{
  it.each([.75,1,3])('recovers a sealed frozen tail at %sx after its remaining play time plus decode margin',rate=>{
    const guard=new PlaybackEnd(),sample={...state(),rate};
    const wait=Math.max(250,(sample.duration-sample.time)/rate*1000+150);
    expect(guard.inspect(sample)).toBe(false);
    expect(guard.inspect({...sample,now:wait-1})).toBe(false);
    expect(guard.inspect({...sample,now:wait})).toBe(true);
  });
  it.each([.75,1,3])('does not cut the tail while its timeline still advances at %sx',rate=>{
    const guard=new PlaybackEnd();
    for(let n=0;n<20;n++)expect(guard.inspect({...state({time:42.21+n*.003,now:n*200}),rate})).toBe(false);
  });
  it('does not cut playing samples, an unsealed playlist or a mid-episode buffer stall',()=>{const guard=new PlaybackEnd();for(let n=0;n<8;n++)expect(guard.inspect(state({time:41+n*.1,now:n*300}))).toBe(false);expect(guard.inspect(state({sealed:false,now:3000}))).toBe(false);expect(guard.inspect(state({time:20,bufferedEnd:20.1,now:5000}))).toBe(false);});
  it('manual pause, navigation and seeking never turn into automatic next episode',()=>{for(const patch of [{playing:false},{enabled:false},{seeking:true}]){const guard=new PlaybackEnd();guard.inspect(state());expect(guard.inspect(state({...patch,now:5000}))).toBe(false);}});
  it.each([.75,1,3])('pause, disabled playback and seeking restart the frozen-tail clock at %sx',rate=>{
    for(const patch of [{playing:false},{enabled:false},{seeking:true}]){
      const guard=new PlaybackEnd(),sample={...state(),rate};
      const wait=Math.max(250,(sample.duration-sample.time)/rate*1000+150);
      guard.inspect(sample);expect(guard.inspect({...sample,...patch,now:5000})).toBe(false);
      expect(guard.inspect({...sample,now:5001})).toBe(false);
      expect(guard.inspect({...sample,now:5000+wait})).toBe(true);
    }
  });
  it('never treats an unsealed stream, missing final buffer or a mid-episode stall as completion',()=>{
    for(const patch of [{sealed:false},{bufferedEnd:42.0},{time:41.9},{time:20,bufferedEnd:20.1}]){
      const guard=new PlaybackEnd(),sample={...state(patch),rate:3};
      expect(guard.inspect(sample)).toBe(false);expect(guard.inspect({...sample,now:10000})).toBe(false);
    }
  });
  it.each([0,NaN,Infinity])('invalid rate %s uses the normal-speed safety budget',rate=>{
    const guard=new PlaybackEnd(),sample={...state(),rate};
    const wait=(sample.duration-sample.time)*1000+150;
    guard.inspect(sample);expect(guard.inspect({...sample,now:wait-1})).toBe(false);
    expect(guard.inspect({...sample,now:wait})).toBe(true);
  });
  it('ended and fallback share a single transition per session; a new session can finish again',()=>{const guard=new PlaybackEnd();expect(guard.claim('episode-150')).toBe(true);expect(guard.claim('episode-150')).toBe(false);expect(guard.inspect(state({now:5000}))).toBe(false);expect(guard.inspect(state({id:'episode-151'}))).toBe(false);expect(guard.inspect(state({id:'episode-151',now:1000}))).toBe(true);expect(guard.claim('episode-151')).toBe(true);});
});
