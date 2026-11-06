import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { HistoryItem, HistoryPage, HistoryQuery } from '../shared/contracts';
export const epochSeconds=(value:number)=>Number.isFinite(value)&&value>0?(value>100000000000?value/1000:value):0;
const finished=(item:HistoryItem)=>item.series.totalEpisodes>0&&item.episode>=item.series.totalEpisodes&&item.duration>0&&item.position>=Math.max(0,item.duration-3);
export class HistoryStore {
  private db:DatabaseSync;
  constructor(file:string){
    this.db=new DatabaseSync(file);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS history(uid TEXT NOT NULL,sid TEXT NOT NULL,series_json TEXT NOT NULL,episode INTEGER NOT NULL,position REAL NOT NULL,duration REAL NOT NULL,watched_at REAL NOT NULL,finished INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(uid,sid));
      CREATE INDEX IF NOT EXISTS history_recent ON history(uid,watched_at DESC,sid DESC);
      CREATE TABLE IF NOT EXISTS hidden_history(uid TEXT NOT NULL,sid TEXT NOT NULL,hidden_at REAL NOT NULL,PRIMARY KEY(uid,sid));`);
  }
  merge(uid:string,items:HistoryItem[],local=false){
    const existing=this.db.prepare('SELECT * FROM history WHERE uid=? AND sid=?');
    const hidden=this.db.prepare('SELECT hidden_at FROM hidden_history WHERE uid=? AND sid=?');
    const write=this.db.prepare(`INSERT INTO history(uid,sid,series_json,episode,position,duration,watched_at,finished) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(uid,sid) DO UPDATE SET series_json=excluded.series_json,episode=excluded.episode,position=excluded.position,duration=excluded.duration,watched_at=excluded.watched_at,finished=excluded.finished`);
    this.db.exec('BEGIN IMMEDIATE');
    try{for(const original of items){
      if(original.uid!==uid||!/^\d+$/.test(original.series?.id)||!Number.isInteger(original.episode)||original.episode<1)continue;
      const item={...original,watchedAt:epochSeconds(original.watchedAt),position:Math.max(0,Number.isFinite(original.position)?original.position:0),duration:Math.max(0,Number.isFinite(original.duration)?original.duration:0)};
      const tombstone=hidden.get(uid,item.series.id) as {hidden_at:number}|undefined;
      if(tombstone&&!local&&item.watchedAt<=tombstone.hidden_at)continue;
      if(local)this.db.prepare('DELETE FROM hidden_history WHERE uid=? AND sid=?').run(uid,item.series.id);
      const old=existing.get(uid,item.series.id) as Record<string,unknown>|undefined;
      if(old){const metadata=JSON.parse(String(old.series_json));item.series={...metadata,...item.series,intro:item.series.intro||metadata.intro||'',tags:item.series.tags?.length?item.series.tags:metadata.tags||[],actors:item.series.actors?.length?item.series.actors:metadata.actors||[],totalEpisodes:item.series.totalEpisodes||metadata.totalEpisodes||0};}
      if(old&&Number(old.watched_at)>item.watchedAt)continue;
      if(old&&Number(old.watched_at)===item.watchedAt&&!local){
        if(Number(old.episode)===item.episode){item.position=Math.max(Number(old.position),item.position);item.duration=Math.max(Number(old.duration),item.duration);}
        else continue;
      }
      write.run(uid,item.series.id,JSON.stringify(item.series),item.episode,item.position,item.duration,item.watchedAt,finished(item)?1:0);
    }this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  count(uid:string){return Number((this.db.prepare('SELECT COUNT(*) AS n FROM history WHERE uid=?').get(uid) as {n:number}).n);}
  remove(uid:string,sid:string){this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('DELETE FROM history WHERE uid=? AND sid=?').run(uid,sid);this.db.prepare('INSERT INTO hidden_history VALUES(?,?,?) ON CONFLICT(uid,sid) DO UPDATE SET hidden_at=excluded.hidden_at').run(uid,sid,Date.now()/1000);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
  query(uid:string,query:HistoryQuery={}):HistoryPage{
    if(!query||typeof query!=='object'||(query.search!==undefined&&typeof query.search!=='string')||(query.cursor!==undefined&&typeof query.cursor!=='string')||(query.limit!==undefined&&!Number.isFinite(query.limit))||!['all','today','week','month',undefined].includes(query.period)||!['all','unfinished','finished',undefined].includes(query.status))throw new Error('历史筛选参数不正确');
    const limit=Math.max(1,Math.min(100,Math.floor(query.limit||50))),clauses=['uid=?'],values:(string|number)[]=[uid];
    const search=(query.search||'').trim().slice(0,100);
    if(search){clauses.push("json_extract(series_json,'$.title') LIKE ? ESCAPE '\\'");values.push('%'+search.replace(/[\\%_]/g,c=>'\\'+c)+'%');}
    if(query.period&&query.period!=='all'){const from=new Date();from.setHours(0,0,0,0);if(query.period==='week')from.setDate(from.getDate()-6);else if(query.period==='month')from.setDate(from.getDate()-29);clauses.push('watched_at>=?');values.push(from.getTime()/1000);}
    if(query.status==='finished')clauses.push('finished=1');else if(query.status==='unfinished')clauses.push('finished=0');
    const scope=createHash('sha256').update(JSON.stringify([uid,search,query.period||'all',query.status||'all'])).digest('hex').slice(0,16);
    const total=Number((this.db.prepare(`SELECT COUNT(*) AS n FROM history WHERE ${clauses.join(' AND ')}`).get(...values) as {n:number}).n);
    if(query.cursor){try{const cursor=JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8'));if(cursor.scope!==scope||!Number.isFinite(cursor.at)||!/^\d+$/.test(cursor.sid))throw new Error();clauses.push('(watched_at<? OR (watched_at=? AND sid<?))');values.push(cursor.at,cursor.at,cursor.sid);}catch{throw new Error('历史分页已失效，请重新加载');}}
    const rows=this.db.prepare(`SELECT * FROM history WHERE ${clauses.join(' AND ')} ORDER BY watched_at DESC,sid DESC LIMIT ?`).all(...values,limit+1) as Record<string,unknown>[];
    const items=rows.slice(0,limit).map(row=>({series:JSON.parse(String(row.series_json)),episode:Number(row.episode),position:Number(row.position),duration:Number(row.duration),watchedAt:Number(row.watched_at),uid}));
    const last=items.at(-1);return {items,total,nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({scope,at:last.watchedAt,sid:last.series.id})).toString('base64url'):null};
  }
  close(){this.db.close();}
}
