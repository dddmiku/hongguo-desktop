"""独立访客网关的真实首页耗时，不读取账号或写云端数据。"""
from pathlib import Path
import argparse
import json
import os
import secrets
import subprocess
import threading
import time
import requests

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--label',default='baseline');parser.add_argument('--data',default='home-performance');args=parser.parse_args()
work=ROOT/'_work'/args.data;work.mkdir(parents=True,exist_ok=True)
results=[]
for run in range(2):
    token=secrets.token_hex(32);start=time.perf_counter()
    process=subprocess.Popen([str(ROOT/'runtime/python/python.exe'),'-I','-B',str(ROOT/'service/gateway.py')],
        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
        env={**os.environ,'HG_API_TOKEN':token,'HG_DATA_DIR':str(work),'HG_RUNTIME_DIR':str(ROOT/'runtime'),'HG_APP_VERSION':'1.0.0','PYTHONUNBUFFERED':'1'},
        creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    errors=[]
    threading.Thread(target=lambda:errors.extend(line.decode('utf-8','replace').strip() for line in process.stderr),daemon=True).start()
    try:
        ready=json.loads(process.stdout.readline());port=ready['port'];boot=time.perf_counter()-start
        headers={'Authorization':'Bearer '+token};requests_session=requests.Session();requests_session.trust_env=False
        row={'run':run+1,'ready_ms':round(boot*1000,1)}
        for name in ('home_first','home_repeat'):
            then=time.perf_counter();response=requests_session.get(f'http://127.0.0.1:{port}/catalog/home?genre=short_play',headers=headers,timeout=90)
            row[name+'_ms']=round((time.perf_counter()-then)*1000,1);row[name+'_status']=response.status_code
            if response.ok:
                data=response.json();row['items']=len(data.get('items',[]));row[name+'_cached']=data.get('cached',False);row[name+'_updating']=data.get('updating',False)
            else:row[name+'_error']=response.json().get('error',{}).get('code')
        results.append(row);print(json.dumps(row),flush=True)
    finally:
        process.stdin.close()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'],capture_output=True,timeout=10)
            process.wait(timeout=10)
        if results:
            results[-1]['exit_code']=process.returncode
(work/(args.label+'.json')).write_text(json.dumps(results,indent=2),encoding='utf-8')
