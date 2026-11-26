import {describe,it,expect} from 'vitest';
import type {BrowserWindow} from 'electron';
import {PipWindow} from './pip-window';
const work={x:0,y:0,width:2560,height:1400};
function windowMock(){
  const state={bounds:{x:100,y:100,width:960,height:680},normal:{x:100,y:100,width:960,height:680},maximized:false,full:false,topmost:false,minimum:[940,640],maximizable:true};
  return {state,window:{
    getBounds:()=>state.bounds,getNormalBounds:()=>state.normal,isMaximized:()=>state.maximized,isFullScreen:()=>state.full,
    isAlwaysOnTop:()=>state.topmost,getMinimumSize:()=>state.minimum,isMaximizable:()=>state.maximizable,
    unmaximize:()=>{state.maximized=false;},setFullScreen:(v:boolean)=>{state.full=v;},setMinimumSize:()=>{},
    setMaximizable:(v:boolean)=>{state.maximizable=v;},setBounds:(v:typeof state.bounds)=>{state.bounds=v;state.normal=v;},
    setAlwaysOnTop:(v:boolean)=>{state.topmost=v;},maximize:()=>{state.maximized=true;},
  }};
}
describe('PiP native lifecycle',()=>{
  it('keeps topmost after a repeated enter and restores the pre-PiP state on exit',()=>{
    const m=windowMock(),pip=new PipWindow(m.window as unknown as BrowserWindow,()=>work);
    expect(pip.enter()).toBe(true);
    expect(m.state.topmost).toBe(true);
    expect(pip.enter()).toBe(true);
    expect(m.state.topmost).toBe(true);
    expect(pip.exit()).toBe(true);
    expect(m.state.topmost).toBe(false);
    expect(m.state.bounds).toEqual({x:100,y:100,width:960,height:680});
  });
  it('restores a pre-existing topmost window instead of always clearing it',()=>{
    const m=windowMock();m.state.topmost=true;const pip=new PipWindow(m.window as unknown as BrowserWindow,()=>work);
    pip.enter();expect(m.state.topmost).toBe(true);pip.exit();expect(m.state.topmost).toBe(true);
  });
  it('does not duplicate work when the renderer leaves during the enter IPC',()=>{
    const m=windowMock(),pip=new PipWindow(m.window as unknown as BrowserWindow,()=>work);
    pip.enter();pip.exit();expect(pip.exit()).toBe(false);expect(m.state.bounds).toEqual({x:100,y:100,width:960,height:680});
  });
});
