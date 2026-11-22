export type MediaRequestFailureKind='network'|'timeout'|'http'|'protocol'|'service';
export interface MediaRequestFailure {kind:MediaRequestFailureKind;code:string;message:string;status?:number;retryable:boolean;}
export type MediaRequestResult<T>={ok:true;data:T}|{ok:false;error:MediaRequestFailure};
export interface MediaRequestOptions {method?:string;body?:unknown;timeout?:number;}
export interface MediaRequestTransport {
  request:(path:string,options?:MediaRequestOptions)=>Promise<unknown>;
  mediaRequestResult?:(path:string,options?:MediaRequestOptions)=>Promise<unknown>;
}

const kinds=new Set<string>(['network','timeout','http','protocol','service']);
const retryStatuses=new Set([429,502,503,504]);
const networkMessage=/fetch failed|failed to fetch|network(?: request)? (?:failed|error|unavailable)|socket hang up|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ERR_CONNECTION_(?:RESET|CLOSED)|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/i;
const timeoutMessage=/request timed out|(?:operation|request|connection|connect).{0,40}(?:timed out|timeout)|ETIMEDOUT|ERR_CONNECTION_TIMED_OUT/i;
const object=(value:unknown):object|null=>typeof value==='object'&&value!==null&&!Array.isArray(value)?value:null;
function property(input:object,key:string):PropertyDescriptor|undefined {try{return Object.getOwnPropertyDescriptor(input,key);}catch{return undefined;}}
function own(input:object,key:string):unknown {const field=property(input,key);return field&&'value' in field?field.value:undefined;}
const safeKind=(value:unknown):MediaRequestFailureKind|null=>typeof value==='string'&&value.length<=12&&kinds.has(value)?value as MediaRequestFailureKind:null;
const safeStatus=(value:unknown):number|undefined=>typeof value==='number'&&Number.isInteger(value)&&value>=100&&value<=599?value:undefined;
const safeCode=(value:unknown):string|null=>typeof value==='string'&&value.length>=1&&value.length<=64&&/^[A-Z0-9_]+$/.test(value)?value:null;
function instance(value:unknown,type:unknown){try{return typeof type==='function'&&value instanceof type;}catch{return false;}}
function brandedError(value:unknown){return instance(value,Error)||(typeof DOMException==='function'&&instance(value,DOMException));}
function errorName(value:unknown,input:object|null){
  const name=input?own(input,'name'):undefined;if(typeof name==='string'&&name.length<=64)return name;
  // Invoke only the platform's branded DOMException getter, never an arbitrary input accessor.
  if(typeof DOMException==='function'&&instance(value,DOMException)){
    try {const getter=Object.getOwnPropertyDescriptor(DOMException.prototype,'name')?.get;const result=getter?.call(value);if(typeof result==='string')return result;}catch{}
  }
  return instance(value,TypeError)?'TypeError':'Error';
}
function rawMessage(value:unknown,input:object|null){
  const ownMessage=input?own(input,'message'):undefined;
  if(typeof ownMessage==='string')return ownMessage.slice(0,4000);
  if(typeof value==='string')return value.slice(0,4000);
  if(typeof DOMException==='function'&&instance(value,DOMException)){
    try {const getter=Object.getOwnPropertyDescriptor(DOMException.prototype,'message')?.get;const result=getter?.call(value);if(typeof result==='string')return result.slice(0,4000);}catch{}
  }
  return '';
}
function legacyKind(value:unknown,input:object|null,message:string):MediaRequestFailureKind {
  if(!brandedError(value))return 'service';
  const name=errorName(value,input);
  if(name==='TimeoutError'||timeoutMessage.test(message))return 'timeout';
  if(name==='NetworkError'||networkMessage.test(message))return 'network';
  return 'service';
}
function cleanMessage(message:string,fallback:string){
  const clean=message
    .replace(/\r/g,'')
    // Serialized diagnostic objects/arrays are never public playback messages.
    // Removing the whole section also covers unknown cookie-jar key spellings.
    .replace(/[\[{][\s\S]*/g,'[details-redacted]')
    .replace(/["']?\b(?:authorization|set[-_]cookies?|cookies?|headers?|body|stack)["']?\s*[:=][^\n]*/gi,'[redacted]')
    .replace(/(?:["']?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|passwd|secret|signature|session[_ -]?cookie|csrf|x[_ -]?api[_ -]?key)["']?)\s*[:=]\s*[^\n]*/gi,'[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;<>"']+/gi,'[redacted]')
    .replace(/\b(?:https?|wss?|file):\/\/[^\n]*/gi,'[url]')
    .replace(/\?[^\n]*/g,'[query]')
    .replace(/^\s*at\s+[^\n]*$/gm,'')
    .replace(/(?:Traceback \(most recent call last\):|Stack trace:)[\s\S]*/gi,'[redacted]')
    .trim().slice(0,400);
  return clean||fallback;
}
function defaults(kind:MediaRequestFailureKind,status?:number){
  if(kind==='network')return {code:'MEDIA_NETWORK_FAILURE',message:'媒体连接暂时不可用，请稍后重试'};
  if(kind==='timeout')return {code:'MEDIA_REQUEST_TIMEOUT',message:'媒体请求超时，请稍后重试'};
  if(kind==='http')return {code:status===undefined?'MEDIA_HTTP_FAILURE':'MEDIA_HTTP_'+status,message:'媒体服务请求失败，请重试当前集'};
  if(kind==='protocol')return {code:'MEDIA_RESPONSE_INVALID',message:'媒体服务返回异常，请重试当前集'};
  return {code:'MEDIA_SERVICE_FAILURE',message:'媒体处理失败，请重试当前集'};
}
export function normalizeMediaRequestFailure(error:unknown):MediaRequestFailure {
  const input=object(error),status=input?safeStatus(own(input,'status')):undefined,message=rawMessage(error,input);
  const observedKind=(input?safeKind(own(input,'kind')):null)??(status===undefined?legacyKind(error,input,message):'http');
  // A proxy's temporary HTTP failure may also have an unreadable body. The
  // HTTP status, not that parsing symptom, owns its retry semantics.
  const kind=observedKind==='protocol'&&status!==undefined&&retryStatuses.has(status)?'http':observedKind;
  const fallback=defaults(kind,status),code=(input?safeCode(own(input,'code')):null)??fallback.code;
  const retryable=kind!=='protocol'&&status!==401&&status!==403&&(status===undefined?(kind==='network'||kind==='timeout'):retryStatuses.has(status));
  return {kind,code,message:cleanMessage(message,fallback.message),...(status===undefined?{}:{status}),retryable};
}
export class MediaRequestError extends Error {
  readonly kind:MediaRequestFailureKind;readonly code:string;readonly status?:number;readonly retryable:boolean;
  constructor(failure:MediaRequestFailure){
    const safe=normalizeMediaRequestFailure(failure);super(safe.message);this.name='MediaRequestError';
    this.kind=safe.kind;this.code=safe.code;this.status=safe.status;
    // A local owner may further prohibit retries, but cannot enable one for a
    // denied/protocol failure. Preserve that stronger local rich-error decision.
    this.retryable=safe.retryable&&own(failure,'retryable')!==false;
  }
}
const malformed=()=>new MediaRequestError({kind:'protocol',code:'MEDIA_RESPONSE_INVALID',message:'媒体服务返回格式异常，请重试当前集',status:200,retryable:false});
export function unwrapMediaRequestResult<T>(result:unknown):T {
  const input=object(result);if(!input)throw malformed();
  const ok=own(input,'ok');
  if(ok===true){const data=property(input,'data');if(!data||!('value' in data))throw malformed();return data.value as T;}
  if(ok!==false)throw malformed();
  const failure=object(own(input,'error'));if(!failure)throw malformed();
  const kind=safeKind(own(failure,'kind')),code=safeCode(own(failure,'code')),message=own(failure,'message'),retryable=own(failure,'retryable'),status=own(failure,'status');
  if(!kind||!code||typeof message!=='string'||message.length>400||typeof retryable!=='boolean'||(status!==undefined&&safeStatus(status)===undefined))throw malformed();
  const safe=normalizeMediaRequestFailure(failure);safe.retryable=safe.retryable&&retryable;
  throw new MediaRequestError(safe);
}
export function isRetryableMediaRequestError(error:unknown):boolean {
  if(instance(error,MediaRequestError)){const flag=own(error as object,'retryable');return typeof flag==='boolean'?flag:false;}
  const input=object(error);
  if(input&&(safeKind(own(input,'kind'))||safeStatus(own(input,'status'))!==undefined))return normalizeMediaRequestFailure(error).retryable;
  const kind=legacyKind(error,input,rawMessage(error,input));return kind==='network'||kind==='timeout';
}
export async function requestMedia<T>(transport:MediaRequestTransport,path:string,options?:MediaRequestOptions):Promise<T> {
  if(typeof path!=='string'||!/^\/media\/session(?:\/[A-Za-z0-9_-]{1,128})?$/.test(path))throw new MediaRequestError({kind:'protocol',code:'MEDIA_ROUTE_INVALID',message:'无效媒体接口',retryable:false});
  if(typeof transport.mediaRequestResult==='function')return unwrapMediaRequestResult<T>(await transport.mediaRequestResult(path,options));
  // Legacy fixtures preserve their original Error identity/classification. Production uses the envelope method.
  return await (options===undefined?transport.request(path):transport.request(path,options)) as T;
}
