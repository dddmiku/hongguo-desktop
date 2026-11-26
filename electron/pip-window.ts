import type {BrowserWindow,Rectangle} from 'electron';

/** Coordinates are DIPs, including work-area offsets on secondary displays. */
export function visibleBounds(bounds:Rectangle,work:Rectangle):Rectangle {
  const width=Math.min(bounds.width,work.width),height=Math.min(bounds.height,work.height);
  return {width,height,x:Math.max(work.x,Math.min(bounds.x,work.x+work.width-width)),
    y:Math.max(work.y,Math.min(bounds.y,work.y+work.height-height))};
}
export function miniWindowBounds(bounds:Rectangle,work:Rectangle):Rectangle {
  const width=Math.floor(Math.min(480,work.width-24,(work.height-24)*16/9)),height=Math.round(width*9/16);
  return visibleBounds({x:bounds.x+bounds.width-width,y:bounds.y+bounds.height-height,width,height},work);
}

/** Owns the native window snapshot for one mini-window session. */
export class PipWindow {
  private saved:{bounds:Rectangle;maximized:boolean;topmost:boolean;minimum:number[];maximizable:boolean}|null=null;
  constructor(private window:BrowserWindow,private workArea:(bounds:Rectangle)=>Rectangle){}
  enter(){
    if(this.saved)return true;
    const w=this.window;
    this.saved={bounds:w.getNormalBounds(),maximized:w.isMaximized(),topmost:w.isAlwaysOnTop(),
      minimum:w.getMinimumSize(),maximizable:w.isMaximizable()};
    const bounds=miniWindowBounds(w.getBounds(),this.workArea(w.getBounds()));
    if(w.isMaximized())w.unmaximize();
    if(w.isFullScreen())w.setFullScreen(false);
    w.setMinimumSize(Math.min(280,bounds.width),Math.min(158,bounds.height));
    w.setMaximizable(false);w.setBounds(bounds);w.setAlwaysOnTop(true,'floating');
    return true;
  }
  exit(){
    const saved=this.saved;if(!saved)return false;
    this.saved=null;
    const w=this.window;
    const restored=visibleBounds(saved.bounds,this.workArea(saved.bounds));
    w.setAlwaysOnTop(saved.topmost);w.setMaximizable(saved.maximizable);
    w.setMinimumSize(Math.min(saved.minimum[0],restored.width),Math.min(saved.minimum[1],restored.height));
    w.setBounds(restored);
    if(saved.maximized)w.maximize();
    return true;
  }
}
