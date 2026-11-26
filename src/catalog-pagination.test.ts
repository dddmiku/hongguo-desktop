import {describe,expect,it} from 'vitest';
import {isExpiredCursor,mergeContinuation,resumableCursor} from './catalog-pagination';
const row=(id:string)=>({id,title:id});
describe('片单续页游标',()=>{
  it('缓存片单只用于显示，不把旧分页令牌当成现役游标',()=>{
    expect(resumableCursor(true,'stale')).toBe('');
    expect(resumableCursor(false,'fresh')).toBe('fresh');
    expect(resumableCursor(undefined,undefined)).toBe('');
  });
  it('令牌过期可从IPC仅保留的错误文案识别',()=>{
    expect(isExpiredCursor(Object.assign(new Error('x'),{code:'CURSOR_EXPIRED'}))).toBe(true);
    expect(isExpiredCursor(new Error("Error invoking remote method 'api:request': ContentRequestError: 榜单已更新，请刷新后继续"))).toBe(true);
    expect(isExpiredCursor(new Error('片单已更新，请刷新后继续浏览'))).toBe(true);
    expect(isExpiredCursor(new Error('榜单服务重复返回已有作品，已保留片单，请刷新重试'))).toBe(false);
    expect(isExpiredCursor(new Error('网络暂时不可用'))).toBe(false);
    expect(isExpiredCursor(null)).toBe(false);
  });
  it('续页去重且只采用新一页的真实游标与结束状态',()=>{
    expect(mergeContinuation([row('1'),row('2')],{items:[row('2'),row('3')],hasMore:true,cursor:'next'})).toEqual({items:[row('1'),row('2'),row('3')],hasMore:true,cursor:'next'});
    expect(mergeContinuation([row('1')],{items:[],hasMore:false,cursor:''})).toEqual({items:[row('1')],hasMore:false,cursor:''});
  });
});
