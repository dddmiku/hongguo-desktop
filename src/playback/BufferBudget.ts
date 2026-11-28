const rateLimit=(rate:number)=>Number.isFinite(rate)?Math.max(.75,Math.min(3,rate)):1;

export function playbackBufferConfig(rate:number,warming:boolean,paused=false){
  const speed=rateLimit(rate);
  return warming?{
    maxBufferLength:Math.max(6,speed*4),maxMaxBufferLength:Math.max(12,speed*6),maxBufferSize:8*1024*1024,backBufferLength:3,
  }:{
    // Pausing freezes the playhead, so give the foreground deck room to keep loading.
    // Bound this in media seconds: hls.js maxBufferSize is not a hard memory limit.
    maxBufferLength:paused?60:Math.max(18,speed*8),maxMaxBufferLength:paused?60:Math.max(30,speed*10),maxBufferSize:12*1024*1024,backBufferLength:8,
  };
}
