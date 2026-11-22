import {describe,expect,it,vi} from 'vitest';
import {MediaRequestError,isRetryableMediaRequestError,normalizeMediaRequestFailure,requestMedia,unwrapMediaRequestResult} from './media-request';

describe('closed media failure envelope',()=>{
  it('preserves structured kind/code/status/retryability after a plain JSON IPC clone',()=>{
    const error=new Error('upstream temporarily unavailable');Object.assign(error,{kind:'http',status:503,code:'MEDIA_TEMPORARILY_UNAVAILABLE',retryable:true});
    const wire=JSON.parse(JSON.stringify({ok:false,error:normalizeMediaRequestFailure(error)}));
    let captured:unknown;try{unwrapMediaRequestResult(wire);}catch(failure){captured=failure;}
    expect(captured).toBeInstanceOf(MediaRequestError);expect(captured).toMatchObject({kind:'http',status:503,code:'MEDIA_TEMPORARILY_UNAVAILABLE',retryable:true,message:'upstream temporarily unavailable'});
  });
  it.each([429,502,503,504])('HTTP %s is transport-retryable without being labelled a terminal source failure',status=>{
    const result=normalizeMediaRequestFailure({status,message:'temporarily unavailable'});
    expect(result).toMatchObject({kind:'http',status,retryable:true});expect(isRetryableMediaRequestError(new MediaRequestError(result))).toBe(true);
  });
  it.each([401,403])('HTTP %s remains denied even with a misleading retryable flag or fetch wording',status=>{
    const result=normalizeMediaRequestFailure({kind:'http',status,message:'failed to fetch protected source',retryable:true,code:'MEDIA_ACCESS_DENIED'});
    expect(result).toMatchObject({kind:'http',status,retryable:false,code:'MEDIA_ACCESS_DENIED'});expect(isRetryableMediaRequestError(new MediaRequestError(result))).toBe(false);
  });
  it('keeps protocol-200 and unknown service business failures non-retryable',()=>{
    expect(normalizeMediaRequestFailure({kind:'protocol',status:200,code:'MEDIA_RESPONSE_INVALID',message:'response shape invalid',retryable:true})).toMatchObject({kind:'protocol',status:200,retryable:false});
    const failure=normalizeMediaRequestFailure({kind:'service',code:'MEDIA_SOURCE_REJECTED',message:'source says failed to fetch this locked episode',retryable:false});
    expect(failure).toMatchObject({kind:'service',code:'MEDIA_SOURCE_REJECTED',retryable:false});expect(isRetryableMediaRequestError(new MediaRequestError(failure))).toBe(false);
  });
  it('does not hide a temporary HTTP failure behind an invalid-body protocol label',()=>{
    const failure=normalizeMediaRequestFailure({kind:'protocol',status:503,code:'MEDIA_BAD_RESPONSE',message:'proxy returned a non-JSON response',retryable:false});
    expect(failure).toMatchObject({kind:'http',status:503,retryable:true});
    expect(normalizeMediaRequestFailure({kind:'protocol',status:200,code:'MEDIA_BAD_RESPONSE',message:'invalid successful response'})).toMatchObject({kind:'protocol',status:200,retryable:false});
  });
  it('recognizes actual fetch/network/timeout errors but not an ordinary TypeError program bug',()=>{
    expect(normalizeMediaRequestFailure(new TypeError('Failed to fetch'))).toMatchObject({kind:'network',retryable:true});
    expect(normalizeMediaRequestFailure(new Error('socket hang up'))).toMatchObject({kind:'network',retryable:true});
    expect(normalizeMediaRequestFailure(new DOMException('request elapsed','TimeoutError'))).toMatchObject({kind:'timeout',retryable:true});
    expect(normalizeMediaRequestFailure(new TypeError('cannot read properties of undefined'))).toMatchObject({kind:'service',retryable:false});
    expect(isRetryableMediaRequestError(new TypeError('cannot read properties of undefined'))).toBe(false);
    expect(isRetryableMediaRequestError(new Error('Failed to fetch'))).toBe(true);
    expect(isRetryableMediaRequestError(new Error('operation was aborted due to timeout'))).toBe(true);
    expect(isRetryableMediaRequestError(new DOMException('cancelled by user','AbortError'))).toBe(false);
  });
  it('outputs only the closed fields and never invokes error or unknown getters',()=>{
    const input={kind:'http',status:503,message:'service busy',code:'MEDIA_BUSY',headers:{Authorization:'fixture-marker'},body:'fixture-marker',stack:'fixture-marker',unknown:'fixture-marker'};
    const getter=vi.fn(()=>{throw new Error('must not access');});Object.defineProperty(input,'token',{get:getter});
    expect(Object.keys(normalizeMediaRequestFailure(input)).sort()).toEqual(['code','kind','message','retryable','status']);expect(getter).not.toHaveBeenCalled();
    const accessor={kind:'service'};Object.defineProperty(accessor,'message',{get:getter});Object.defineProperty(accessor,'status',{get:getter});
    expect(normalizeMediaRequestFailure(accessor)).toMatchObject({kind:'service',retryable:false});expect(getter).not.toHaveBeenCalled();
  });
  it('honors a rich explicit retryability decision without invoking a replaced accessor',()=>{
    const failure=new MediaRequestError({kind:'http',status:503,code:'MEDIA_BUSY',message:'failed to fetch',retryable:true});
    Object.defineProperty(failure,'retryable',{value:false});expect(isRetryableMediaRequestError(failure)).toBe(false);
    const getter=vi.fn(()=>{throw new Error('must not execute');});Object.defineProperty(failure,'retryable',{get:getter});
    expect(()=>isRetryableMediaRequestError(failure)).not.toThrow();expect(isRetryableMediaRequestError(failure)).toBe(false);expect(getter).not.toHaveBeenCalled();
  });
  it('retains an explicit rich retryable=false decision without allowing it to escalate denied statuses',()=>{
    const failure=new MediaRequestError({kind:'http',status:503,code:'MEDIA_POLICY_STOPPED',message:'failed to fetch',retryable:false});
    expect(failure).toMatchObject({kind:'http',status:503,code:'MEDIA_POLICY_STOPPED',retryable:false});expect(isRetryableMediaRequestError(failure)).toBe(false);
    expect(new MediaRequestError({kind:'http',status:403,code:'MEDIA_DENIED',message:'denied',retryable:true}).retryable).toBe(false);
  });
  it('preserves an explicit stop policy across a plain wire envelope and JSON clone',()=>{
    const wire=JSON.parse(JSON.stringify({ok:false,error:{kind:'http',status:503,code:'MEDIA_POLICY_STOPPED',message:'service stopped retries',retryable:false}}));
    let captured:unknown;try{unwrapMediaRequestResult(wire);}catch(error){captured=error;}
    expect(captured).toMatchObject({kind:'http',status:503,retryable:false});
    expect(isRetryableMediaRequestError(captured)).toBe(false);
  });
  it('redacts quoted serialized Cookie and header keys rather than passing their values to the renderer',()=>{
    const marker='NO_REAL_CREDENTIAL_TEST_MARKER';
    for(const fields of [{Cookie:'sid='+marker},{cookies:{sid:marker}},{'Set-Cookie':'sid='+marker},{set_cookie:marker},{Authorization:'Bearer '+marker},{headers:{Cookie:'sid='+marker}},{body:marker},{stack:marker},{unknownDiagnostic:{opaque:marker}},[marker]]){
      for(const indentation of [undefined,2]){
        const result=normalizeMediaRequestFailure(new Error('media failed '+JSON.stringify(fields,null,indentation)));
        expect(result.message).toContain('media failed');expect(result.message).not.toContain(marker);
      }
    }
  });
  it('redacts URL queries, bearer/key/cookie fragments and embedded raw diagnostic sections',()=>{
    const marker='FIXTURE_SENSITIVE_MARKER';
    for(const message of [
      'media failed https://fixture.invalid/stream?signature='+marker+'&token='+marker,
      'media failed /media/session/job/index.m3u8?token='+marker,
      'media failed Bearer '+marker,
      'media failed Authorization: Bearer '+marker,
      'media failed token="'+marker+' with spaces"',
      'media failed Cookie: session='+marker+'; other='+marker,
      'media failed headers={"key":"'+marker+'"}',
      'media failed body='+marker,
      'media failed\nstack: '+marker,
    ]){const normalized=normalizeMediaRequestFailure(new Error(message));expect(normalized.message).toContain('media failed');expect(normalized.message).not.toContain(marker);expect(normalized.message.length).toBeLessThanOrEqual(400);}
  });
  it('bounds messages and accepts only safe uppercase code/status shapes',()=>{
    const result=normalizeMediaRequestFailure({kind:'service',code:'unsafe-code?token=x',status:Infinity,message:'x'.repeat(1000000)});
    expect(result.message).toHaveLength(400);expect(result.code).toMatch(/^[A-Z0-9_]{1,64}$/);expect(result).not.toHaveProperty('status');
    expect(normalizeMediaRequestFailure({kind:'http',code:'MEDIA_SESSION_EXPIRED',status:404,message:'session expired'})).toMatchObject({code:'MEDIA_SESSION_EXPIRED',status:404,retryable:false});
  });
  it('rejects malformed wire replies as local nonretryable protocol errors',()=>{
    for(const reply of [null,[],{}, {ok:true}, {ok:'true',data:{}}, {ok:false}, {ok:false,error:{kind:'evil',code:'MEDIA_ERROR',message:'bad',retryable:false}}, {ok:false,error:{kind:'service',code:'bad-code',message:'bad',retryable:false}}]){
      let captured:unknown;try{unwrapMediaRequestResult(reply);}catch(error){captured=error;}
      expect(captured).toBeInstanceOf(MediaRequestError);expect(captured).toMatchObject({kind:'protocol',retryable:false});
    }
  });
  it('returns only success data and strips unknown failure envelope fields',()=>{
    const data={phase:'ready'};expect(unwrapMediaRequestResult({ok:true,data,token:'fixture-marker'})).toBe(data);
    let captured:unknown;try{unwrapMediaRequestResult({ok:false,error:{kind:'http',code:'MEDIA_DENIED',message:'not allowed',status:403,retryable:false,token:'fixture-marker'},headers:'fixture-marker'});}catch(error){captured=error;}
    expect(captured).toMatchObject({kind:'http',status:403,retryable:false});expect(captured).not.toHaveProperty('token');expect(captured).not.toHaveProperty('headers');
  });
});

describe('media-only transport compatibility',()=>{
  it('prefers the plain envelope method and recreates a rich renderer error',async()=>{
    const request=vi.fn(async()=>({})),mediaRequestResult=vi.fn(async()=>({ok:false,error:{kind:'http',status:503,code:'MEDIA_BUSY',message:'service busy',retryable:true}}));
    await expect(requestMedia({request,mediaRequestResult},'/media/session',{method:'POST',body:{episode:126}})).rejects.toMatchObject({name:'MediaRequestError',kind:'http',status:503,retryable:true});
    expect(request).not.toHaveBeenCalled();expect(mediaRequestResult).toHaveBeenCalledOnce();
  });
  it('unwraps successful envelopes and keeps legacy request fixtures and errors unchanged',async()=>{
    const data={phase:'ready'};await expect(requestMedia({request:vi.fn(async()=>({})),mediaRequestResult:vi.fn(async()=>({ok:true,data}))},'/media/session/job')).resolves.toBe(data);
    const failure=new Error('播放会话已过期，请重新连接'),request=vi.fn(async(_path:string,_options?:unknown)=>{throw failure;});
    await expect(requestMedia({request},'/media/session/job')).rejects.toBe(failure);
    expect(request).toHaveBeenCalledOnce();expect(request.mock.calls[0][0]).toBe('/media/session/job');expect(request.mock.calls[0][1]).toBeUndefined();
  });
  it('blocks absolute/nonmedia/unsafe paths before either transport can be called',async()=>{
    const request=vi.fn(async()=>({})),mediaRequestResult=vi.fn(async()=>({ok:true,data:{}}));
    for(const target of ['https://fixture.invalid/media/session','/account/login','/media/session/../job','/media/session/job?token=fixture','/media/session/job\nother']){
      await expect(requestMedia({request,mediaRequestResult},target)).rejects.toMatchObject({kind:'protocol',retryable:false});
    }
    expect(request).not.toHaveBeenCalled();expect(mediaRequestResult).not.toHaveBeenCalled();
  });
});
