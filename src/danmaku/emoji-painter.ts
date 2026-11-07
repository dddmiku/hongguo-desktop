import { danmakuParts, emojiSize, type DanmakuPart } from './rich-text';

const resources = import.meta.glob<string>('./emoji-images/emoji_dr_*.png', { eager: true, query: '?url', import: 'default' });
const sprites = new Map<string, HTMLImageElement>();
let revision = 0;
for (const [path, source] of Object.entries(resources)) {
  const id = /emoji_dr_([0-9]+)\.png$/.exec(path)?.[1]; if (!id) continue;
  const image = new Image(); image.onload = () => { revision++; }; image.onerror = () => { revision++; };
  image.src = source; sprites.set(id, image);
}

/** Inline images participate in the same measured run as ordinary text and never create HTML. */
export class EmojiPainter {
  private runs=new Map<string,{part:DanmakuPart;width:number}[]>();
  private run(context:CanvasRenderingContext2D,text:string,size:number){
    const key=context.font+':'+size+':'+text;
    let parts=this.runs.get(key);
    if(!parts){parts=danmakuParts(text).map(part=>({part,width:part.kind==='text'?context.measureText(part.text).width:emojiSize(size)}));this.runs.set(key,parts);if(this.runs.size>256)this.runs.delete(this.runs.keys().next().value!);}
    return parts;
  }
  get revision() { return revision; }
  measure(context: CanvasRenderingContext2D, text: string, size: number) {
    return this.run(context,text,size).reduce((total,part)=>total+part.width,0);
  }
  paint(context: CanvasRenderingContext2D, text: string, x: number, baseline: number, fontSize: number): number {
    let pictures = 0;
    for (const entry of this.run(context,text,fontSize)) {
      const part=entry.part;
      if (part.kind === 'text') {
        context.strokeText(part.text, x, baseline); context.fillText(part.text, x, baseline);
        x += entry.width;
      } else {
        const size = emojiSize(fontSize), image = sprites.get(part.id);
        if (image?.complete && image.naturalWidth) {
          context.drawImage(image, x, baseline - size * .8, size, size); pictures++;
        }
        x += size;
      }
    }
    return pictures;
  }
}
