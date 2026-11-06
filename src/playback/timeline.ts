export const knownDuration=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=86400?value:0;
/** A growing EVENT manifest is produced extent, never the length of this episode. */
export function episodeDuration(source:unknown,metadata:unknown,media:unknown=0,complete=false){
  return knownDuration(source)||knownDuration(metadata)||(complete?knownDuration(media):0);
}
export function availablePosition(position:number,ranges:{length:number;start(index:number):number;end(index:number):number}){
  for(let i=0;i<ranges.length;i++)if(position>=ranges.start(i)-.2&&position<=ranges.end(i)-.1)return true;
  return false;
}
