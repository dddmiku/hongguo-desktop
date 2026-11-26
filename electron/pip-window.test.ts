import {describe,it,expect} from 'vitest';
import {miniWindowBounds,visibleBounds} from './pip-window';

describe('mini-window placement',()=>{
  it('keeps a mini window on the selected monitor despite an offscreen parent',()=>{
    expect(miniWindowBounds({x:2360,y:1200,width:1000,height:700},{x:0,y:0,width:2560,height:1400}))
      .toEqual({x:2080,y:1130,width:480,height:270});
  });
  it('uses secondary-display origin and taskbar work area, including negative coordinates',()=>{
    const bounds=miniWindowBounds({x:-1300,y:100,width:1600,height:1000},{x:-1920,y:40,width:1920,height:1040});
    expect(bounds).toEqual({x:-480,y:810,width:480,height:270});
  });
  it('restores bounds to a remaining monitor if the previous monitor disconnected',()=>{
    expect(visibleBounds({x:3000,y:200,width:1440,height:960},{x:0,y:0,width:1920,height:1040}))
      .toEqual({x:480,y:80,width:1440,height:960});
  });
});
