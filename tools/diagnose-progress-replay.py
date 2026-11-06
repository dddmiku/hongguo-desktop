"""Read real cloud progress and stop before every write; never fabricate cloud progress."""
import json
import os
from pathlib import Path
import sys
import threading
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'service'))
from gateway import OwnedSigner
from provider import Provider, ProviderError, SessionVault

DATA=Path(os.environ['APPDATA'])/'红果桌面'
WORK=ROOT/'_work'/'progress-replay'
WORK.mkdir(parents=True,exist_ok=True)
RUNTIME=ROOT/'runtime'
source=DATA/'desktop-device.json'
if source.is_file():
    device=json.loads(source.read_text(encoding='utf-8'))
    allowed={'device_id','iid','cdid','device_type','device_brand','os_version','os_api','registered','source','version_code','version_name','channel','device_platform','app_name','aid'}
    (WORK/'desktop-device.json').write_text(json.dumps({key:value for key,value in device.items() if key in allowed}),encoding='utf-8')
state=json.loads((DATA/'library.json').read_text(encoding='utf-8'))
pending=list((state.get('outbox') or {}).values())
if not pending:
    print(json.dumps({'pending':0}))
    raise SystemExit(0)
item=pending[0]
stop=threading.Event()
signer=OwnedSigner(RUNTIME)
provider=None
events=[]
start=time.monotonic()
try:
    endpoint=signer.start(stop)
    provider=Provider.from_runtime(WORK,RUNTIME,endpoint)
    credentials=SessionVault(DATA/'account-session.dpapi').load()
    provider.account.load_session=lambda:credentials
    original=provider.account._call
    def guarded_call(method,path,*args,**kwargs):
        if method!='GET':
            events.append({'stage':'write_intercepted','method':method,'path':path,'at':round(time.monotonic()-start,3)})
            raise RuntimeError('Write intentionally blocked by read-only diagnosis')
        before=time.monotonic()
        result=original(method,path,*args,**kwargs)
        data=provider.account._json(result)
        events.append({'stage':'read','path':path,'offset':(kwargs.get('extra')or{}).get('offset'),'status':result.status_code,'code':data.get('code'),'elapsed':round(time.monotonic()-before,3)})
        print(json.dumps(events[-1]),flush=True)
        return result
    provider.account._call=guarded_call
    expected=provider.session()['uid']
    print(json.dumps({'pending':len(pending),'identityMatches':expected==item['uid'],'episode':item['episode'],'position':item['position'],'duration':item['duration'],'watchedAt':item['watchedAt']}),flush=True)
    payload={'series':item['series'],'episode':item['episode'],'position':item['position'],'duration':item['duration'],'watchedAt':item['watchedAt'],'expectedUid':item['uid'],'intent':'replay'}
    try:
        result=provider.progress(payload)
        cloud=provider.account.remote_progress(item['series']['id'])
        from progress_contract import epoch_seconds,mobile_position_seconds
        events.append({'stage':'result','synced':result.get('synced'),'skipped':result.get('skipped'),'cloudEpisode':cloud.get('episode'),'cloudPosition':mobile_position_seconds(cloud.get('position') or 0),'cloudUpdatedAt':epoch_seconds(cloud.get('updatedAt') or 0),'cloudHasNewerTimestamp':epoch_seconds(cloud.get('updatedAt') or 0)>item['watchedAt'],'at':round(time.monotonic()-start,3)})
    except ProviderError as error:
        events.append({'stage':'error','code':error.code,'status':error.status,'at':round(time.monotonic()-start,3)})
    except Exception as error:
        events.append({'stage':'error','type':type(error).__name__,'at':round(time.monotonic()-start,3)})
    print(json.dumps(events[-1]),flush=True)
finally:
    stop.set()
    if provider:provider.close()
    signer.close()
    (WORK/'result.json').write_text(json.dumps(events,indent=2),encoding='utf-8')
