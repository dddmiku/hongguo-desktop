import {describe,expect,it} from 'vitest';
import {playbackBufferConfig} from './BufferBudget';

describe('倍速适配的播放器前向缓冲',()=>{
  it('三倍速时预热保留4秒现实播放量，活动槽保留8秒',()=>{
    expect(playbackBufferConfig(3,true)).toMatchObject({maxBufferLength:12,maxMaxBufferLength:18});
    expect(playbackBufferConfig(3,false)).toMatchObject({maxBufferLength:24,maxMaxBufferLength:30});
  });
  it('正常倍速保留当前基线且异常速率回退到1倍速',()=>{
    expect(playbackBufferConfig(1,true)).toMatchObject({maxBufferLength:6,maxMaxBufferLength:12});
    expect(playbackBufferConfig(1,false)).toMatchObject({maxBufferLength:18,maxMaxBufferLength:30});
    expect(playbackBufferConfig(Number.NaN,true)).toEqual(playbackBufferConfig(1,true));
  });
  it('前台暂停提供一分钟前向缓冲，倍速不会无限放大暂停预算',()=>{
    for(const rate of [.75,1,3,Number.NaN]){
      const paused=playbackBufferConfig(rate,false,true);
      expect(paused.maxBufferLength).toBe(60);
      expect(paused.maxMaxBufferLength).toBe(60);
      expect(paused.backBufferLength).toBe(playbackBufferConfig(rate,false).backBufferLength);
    }
  });
  it('暂停预缓冲不扩大下一集预热预算，恢复播放使用正常预算',()=>{
    expect(playbackBufferConfig(3,true,true)).toEqual(playbackBufferConfig(3,true));
    expect(playbackBufferConfig(3,false,false)).toEqual(playbackBufferConfig(3,false));
  });
});
