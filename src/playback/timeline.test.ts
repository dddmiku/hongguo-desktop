import {describe,it,expect} from 'vitest';
import {episodeDuration,availablePosition} from './timeline';
describe('完整剧集时间轴',()=>{
  it('2秒到50秒的增长清单始终显示独立源179秒总长',()=>{
    for(const produced of [2.08,10.08,18.08,26.08,50.08])expect(episodeDuration(179.34,179,produced,false)).toBe(179.34);
  });
  it('未知长度不会显示为当前片段长度，仅完整VOD可回退容器时长',()=>{
    expect(episodeDuration(0,0,10,false)).toBe(0);expect(episodeDuration(0,0,179,true)).toBe(179);
  });
  it('元数据可作独立回退，尚未产出的未来位置必须准备而非夹到片段末尾',()=>{
    expect(episodeDuration(undefined,179,10,false)).toBe(179);
    const ranges={length:1,start:()=>0,end:()=>10};expect(availablePosition(8,ranges)).toBe(true);expect(availablePosition(143,ranges)).toBe(false);
  });
});
