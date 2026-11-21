import {describe,expect,it,vi} from 'vitest';
import {WindowPlaybackLifecycle} from './WindowPlaybackLifecycle';

describe('窗口返回前台时重新武装播放',()=>{
  it('焦点恢复事件即使没有收到可见性切换也会重新启动播放',()=>{
    const suspend=vi.fn(),resume=vi.fn();
    const lifecycle=new WindowPlaybackLifecycle(suspend,resume,true);
    lifecycle.focus();
    expect(suspend).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledOnce();
  });
  it('重复的 show/restore 通知不会重复暂停或重启，真正隐藏再恢复各执行一次',()=>{
    const suspend=vi.fn(),resume=vi.fn();
    const lifecycle=new WindowPlaybackLifecycle(suspend,resume,true);
    lifecycle.setVisible(false);lifecycle.setVisible(false);
    lifecycle.setVisible(true);lifecycle.setVisible(true);
    expect(suspend).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });
  it('焦点返回可强制重试已可见窗口的媒体恢复',()=>{
    const resume=vi.fn();
    const lifecycle=new WindowPlaybackLifecycle(vi.fn(),resume,true);
    lifecycle.focus();lifecycle.focus();
    expect(resume).toHaveBeenCalledTimes(2);
  });
});
