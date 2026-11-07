import {afterEach,expect,it,vi} from 'vitest';

afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
const setup=(answer:unknown)=>{
  const decodingInfo=vi.fn().mockResolvedValue(answer);
  vi.stubGlobal('navigator',{mediaCapabilities:{decodingInfo}});
  vi.stubGlobal('MediaSource',{isTypeSupported:()=>true});
  return decodingInfo;
};
it('仅解码支持不足以绕开兼容转码，必须实际硬解且流畅',async()=>{
  setup({supported:true,smooth:true,powerEfficient:false});
  const {hardwareHevc}=await import('./capabilities');
  expect(await hardwareHevc()).toBe(false);
});
it('同一渲染器只检测一次，预加载复用真实硬解结果',async()=>{
  const detect=setup({supported:true,smooth:true,powerEfficient:true});
  const {hardwareHevc}=await import('./capabilities');
  expect(await Promise.all([hardwareHevc(),hardwareHevc()])).toEqual([true,true]);
  expect(detect).toHaveBeenCalledOnce();
});
it('检测异常安全回退到兼容转码',async()=>{
  setup(null).mockRejectedValue(new Error('driver unavailable'));
  const {hardwareHevc}=await import('./capabilities');
  expect(await hardwareHevc()).toBe(false);
});
