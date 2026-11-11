import {useCallback,useEffect,useId,useRef,useState} from 'react';
import type {KeyboardEvent,Ref} from 'react';
import {ArrowRight,ChevronRight,LoaderCircle,RefreshCw,Search,X} from 'lucide-react';
import type {NativeBridge,Series} from '../../shared/contracts';
import {message,Poster} from './ui';
import './SearchBox.css';

type Result={query:string;phase:'loading'|'ready'|'error';items:Series[];error:string};
type Props={inputRef?:Ref<HTMLInputElement>;onSearch:(query:string)=>void;onSelect:(series:Series)=>void};
export const searchText=(value:string)=>value.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,80);
export const suggestionQuery=(value:string)=>{
  const query=searchText(value);
  return /[a-z0-9]/i.test(query)||[...query].filter(char=>/\p{L}/u.test(char)).length>=2?query:'';
};

/** The bridge cannot cancel IPC in flight; the local signal rejects late replies before presentation. */
export async function requestSearchSuggestions(bridge:Pick<NativeBridge,'request'>,query:string,signal:AbortSignal){
  if(signal.aborted)throw new DOMException('Search cancelled','AbortError');
  const result=await bridge.request<{items:Series[]}>(`/catalog/search/suggestions?query=${encodeURIComponent(query)}`,{timeout:15000});
  if(signal.aborted)throw new DOMException('Search cancelled','AbortError');
  if(!result||!Array.isArray(result.items))throw new Error('搜索结果暂时不可用，请重试。');
  const ids=new Set<string>();
  return result.items.filter(item=>item&&typeof item.id==='string'&&/^\d{8,24}$/.test(item.id)&&typeof item.title==='string'&&item.title.trim()&&!ids.has(item.id)&&!!ids.add(item.id)).slice(0,8);
}

function Match({title,query}:{title:string;query:string}){
  const at=title.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  return at<0?<>{title}</>:<>{title.slice(0,at)}<mark>{title.slice(at,at+query.length)}</mark>{title.slice(at+query.length)}</>;
}

export default function SearchBox({inputRef,onSearch,onSelect}:Props){
  const input=useRef<HTMLInputElement|null>(null),generation=useRef(0),pending=useRef<AbortController|null>(null),composingNow=useRef(false);
  const [value,setValue]=useState(''),[focused,setFocused]=useState(false),[dismissed,setDismissed]=useState(false),[composing,setComposing]=useState(false),[retry,setRetry]=useState(0);
  const [result,setResult]=useState<Result|null>(null),[selected,setSelected]=useState(-1);
  const listId=useId(),query=suggestionQuery(value);
  const expanded=focused&&!dismissed&&!composing&&!!query;
  const current=result?.query===query?result:null;
  const items=current?.phase==='ready'?current.items:[];
  const loading=expanded&&(!current||current.phase==='loading');
  const cancel=useCallback(()=>{generation.current++;pending.current?.abort();pending.current=null;},[]);
  const close=useCallback(()=>{cancel();setDismissed(true);setSelected(-1);},[cancel]);
  const ref=useCallback((node:HTMLInputElement|null)=>{input.current=node;if(typeof inputRef==='function')inputRef(node);else if(inputRef)inputRef.current=node;},[inputRef]);

  useEffect(()=>{
    cancel();setSelected(-1);
    if(!expanded)return;
    const request=++generation.current,abort=new AbortController();pending.current=abort;
    setResult({query,phase:'loading',items:[],error:''});
    const timer=setTimeout(()=>{
      void requestSearchSuggestions(window.hongguo,query,abort.signal).then(rows=>{
        if(generation.current===request&&!abort.signal.aborted)setResult({query,phase:'ready',items:rows,error:''});
      }).catch(error=>{
        if(generation.current===request&&!abort.signal.aborted)setResult({query,phase:'error',items:[],error:message(error)||'暂时没能加载搜索结果，请重试。'});
      });
    },300);
    return()=>{clearTimeout(timer);abort.abort();if(generation.current===request)generation.current++;};
  },[expanded,query,value,retry,cancel]);
  useEffect(()=>{window.addEventListener('blur',close);return()=>{window.removeEventListener('blur',close);cancel();};},[close,cancel]);
  useEffect(()=>{if(selected>=0)document.getElementById(`${listId}-${selected}`)?.scrollIntoView({block:'nearest'});},[listId,selected]);

  const submit=()=>{const text=searchText(value);if(!text||composingNow.current)return;close();input.current?.blur();onSearch(text);};
  const choose=(series:Series)=>{close();setValue(series.title);input.current?.blur();onSelect(series);};
  const key=(event:KeyboardEvent<HTMLInputElement>)=>{
    if(composingNow.current||event.nativeEvent.isComposing||event.keyCode===229)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
    if((event.key==='ArrowDown'||event.key==='ArrowUp')&&query){
      event.preventDefault();setDismissed(false);
      if(items.length)setSelected(index=>event.key==='ArrowDown'?(index+1)%items.length:index<=0?items.length-1:index-1);
      return;
    }
    if(event.key==='Enter'){
      event.preventDefault();
      if(expanded&&selected>=0&&items[selected])choose(items[selected]);else submit();
    }
  };
  return <form className="global-search live-search-box" role="search" onSubmit={event=>{event.preventDefault();submit();}}>
    <Search size={17}/><input ref={ref} type="text" role="combobox" aria-label="搜索剧名、演员或关键词" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={expanded} aria-controls={expanded?listId:undefined} aria-activedescendant={expanded&&selected>=0?`${listId}-${selected}`:undefined} placeholder="搜索剧名、演员或关键词" maxLength={80} autoComplete="off" spellCheck={false} value={value}
      onChange={event=>{cancel();setValue(event.target.value);setDismissed(false);setSelected(-1);}}
      onFocus={()=>{setFocused(true);setDismissed(false);}}
      onBlur={()=>{setFocused(false);close();}}
      onCompositionStart={()=>{composingNow.current=true;setComposing(true);cancel();}}
      onCompositionEnd={event=>{composingNow.current=false;setValue(event.currentTarget.value);setComposing(false);setDismissed(false);}}
      onKeyDown={key}/>
    {value?<button type="button" className="search-clear" aria-label="清除搜索关键词" onPointerDown={event=>event.preventDefault()} onClick={()=>{cancel();setValue('');setResult(null);setSelected(-1);setDismissed(false);input.current?.focus();}}><X size={14}/></button>:<kbd>Ctrl K</kbd>}
    <button className="search-submit" aria-label="搜索" type="submit"><ArrowRight size={16}/></button>
    {expanded&&<div className="search-suggestions" data-query={query}>
      <div className="search-suggestions-heading"><span>搜索结果</span><small>{loading?'正在搜索':items.length?`${items.length} 部作品`:''}</small></div>
      {loading?<div className="search-suggestions-status" role="status"><LoaderCircle size={18} className="spin"/><span>正在找相关故事…</span></div>:current?.phase==='error'?<div className="search-suggestions-status search-suggestions-error" role="status"><span>{current.error}</span><button type="button" className="btn subtle" onPointerDown={event=>event.preventDefault()} onClick={()=>setRetry(number=>number+1)}><RefreshCw size={14}/>重试</button></div>:!items.length?<div className="search-suggestions-status" role="status"><span>暂时没有匹配的作品，试试其他关键词。</span></div>:<div className="search-suggestions-list" id={listId} role="listbox" aria-label="搜索建议">
        {items.map((series,index)=><button type="button" role="option" id={`${listId}-${index}`} key={series.id} data-series-id={series.id} aria-selected={selected===index} aria-label={`查看 ${series.title}`} tabIndex={-1} className={`search-suggestion ${selected===index?'active':''}`} onPointerDown={event=>event.preventDefault()} onMouseMove={()=>setSelected(index)} onClick={()=>choose(series)}><Poster cover={series.cover} title={series.title}/><span className="search-suggestion-copy"><strong><Match title={series.title} query={query}/></strong><span><small>{series.totalEpisodes>0?`全 ${series.totalEpisodes} 集`:'剧集'}</small>{series.tags?.slice(0,2).map(tag=><small key={tag}>{tag}</small>)}</span></span><ChevronRight size={15}/></button>)}
      </div>}
      <button type="button" className="search-suggestions-all" onPointerDown={event=>event.preventDefault()} onClick={submit}><span>查看全部搜索结果</span><ArrowRight size={15}/></button>
    </div>}
  </form>;
}
