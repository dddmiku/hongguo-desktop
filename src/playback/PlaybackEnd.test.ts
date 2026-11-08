import {describe,it,expect} from 'vitest';
import {PlaybackEnd,type EndState} from './PlaybackEnd';
const state=(patch:Partial<EndState>={}):EndState=>({id:'episode-150',time:42.21,duration:42.466,bufferedEnd:42.392,sealed:true,ended:false,playing:true,seeking:false,enabled:true,now:0,...patch});
describe('sealed playback completion',()=>{
  it('recovers the real HEVC audio/video tail stall only after it stops advancing',()=>{const guard=new PlaybackEnd();expect(guard.inspect(state())).toBe(false);expect(guard.inspect(state({now:799}))).toBe(false);expect(guard.inspect(state({now:800}))).toBe(true);});
  it('does not cut playing samples, an unsealed playlist or a mid-episode buffer stall',()=>{const guard=new PlaybackEnd();for(let n=0;n<8;n++)expect(guard.inspect(state({time:41+n*.1,now:n*300}))).toBe(false);expect(guard.inspect(state({sealed:false,now:3000}))).toBe(false);expect(guard.inspect(state({time:20,bufferedEnd:20.1,now:5000}))).toBe(false);});
  it('manual pause, navigation and seeking never turn into automatic next episode',()=>{for(const patch of [{playing:false},{enabled:false},{seeking:true}]){const guard=new PlaybackEnd();guard.inspect(state());expect(guard.inspect(state({...patch,now:5000}))).toBe(false);}});
  it('ended and fallback share a single transition per session; a new session can finish again',()=>{const guard=new PlaybackEnd();expect(guard.claim('episode-150')).toBe(true);expect(guard.claim('episode-150')).toBe(false);expect(guard.inspect(state({now:5000}))).toBe(false);expect(guard.inspect(state({id:'episode-151'}))).toBe(false);expect(guard.inspect(state({id:'episode-151',now:1000}))).toBe(true);expect(guard.claim('episode-151')).toBe(true);});
});
