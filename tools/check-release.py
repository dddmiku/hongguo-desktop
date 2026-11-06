"""核对发布状态；仅对本项目误发的 2.0.0 提供撤回动作。"""
import argparse
import importlib.util
import json
from pathlib import Path
spec=importlib.util.spec_from_file_location('publisher',Path(__file__).with_name('publish.py'))
pub=importlib.util.module_from_spec(spec);spec.loader.exec_module(pub)
parser=argparse.ArgumentParser();parser.add_argument('--withdraw-2',action='store_true');parser.add_argument('--discard-draft-1',action='store_true');parser.add_argument('--withdraw-unused-1',action='store_true');args=parser.parse_args()
secret=pub.token()
for repo in (pub.REPO,pub.LEGACY):
    code,items=pub.request('GET','https://api.github.com/repos/'+repo+'/releases?per_page=4',secret)
    print(json.dumps({'repo':repo,'status':code,'releases':[{'tag':x['tag_name'],'draft':x['draft'],'id':x['id'],'assets':[{'name':a['name'],'size':a['size'],'downloads':a['download_count']}for a in x['assets']]}for x in items] if isinstance(items,list)else []},ensure_ascii=False))
    if args.withdraw_2 and repo==pub.REPO and isinstance(items,list):
        for release in items:
            if release['tag_name']=='v2.0.0':
                code,_=pub.request('DELETE','https://api.github.com/repos/'+repo+'/releases/'+str(release['id']),secret)
                print(json.dumps({'withdrawn':'v2.0.0','status':code}))
                code,_=pub.request('DELETE','https://api.github.com/repos/'+repo+'/git/refs/tags/v2.0.0',secret)
                print(json.dumps({'removedTag':'v2.0.0','status':code}))
    if args.discard_draft_1 and repo==pub.REPO and isinstance(items,list):
        for release in items:
            if release['tag_name']=='v1.0.0' and release['draft']:
                code,_=pub.request('DELETE','https://api.github.com/repos/'+repo+'/releases/'+str(release['id']),secret)
                print(json.dumps({'discardedDraft':'v1.0.0','status':code}))
                code,_=pub.request('DELETE','https://api.github.com/repos/'+repo+'/git/refs/tags/v1.0.0',secret)
                print(json.dumps({'removedDraftTag':'v1.0.0','status':code}))
    if args.withdraw_unused_1 and repo==pub.REPO and isinstance(items,list):
        for release in items:
            if release['tag_name']=='v1.0.0' and all(asset['download_count']==0 for asset in release['assets']):
                code,_=pub.request('DELETE','https://api.github.com/repos/'+repo+'/releases/'+str(release['id']),secret)
                print(json.dumps({'withdrawnUnused':'v1.0.0','status':code}))
                code,_=pub.request('DELETE','https://api.github.com/repos/'+repo+'/git/refs/tags/v1.0.0',secret)
                print(json.dumps({'removedUnusedTag':'v1.0.0','status':code}))
code,runs=pub.request('GET','https://api.github.com/repos/'+pub.REPO+'/actions/runs?per_page=3',secret)
print(json.dumps({'actions':[{'id':r['id'],'status':r['status'],'conclusion':r['conclusion'],'url':r['html_url']}for r in runs.get('workflow_runs',[])]}))
