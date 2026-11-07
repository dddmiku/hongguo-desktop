"""核对新发布与旧更新器的真实迁移契约；不执行安装或写账号。"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import requests
spec=importlib.util.spec_from_file_location('publisher',Path(__file__).with_name('publish.py'))
pub=importlib.util.module_from_spec(spec);spec.loader.exec_module(pub)
installer=pub.ROOT/'release'/('hongguo-%s-setup.exe'%pub.VERSION)
secret=pub.token();expected=hashlib.sha256(installer.read_bytes()).hexdigest()
for repo,version,name in ((pub.REPO,pub.VERSION,installer.name),(pub.LEGACY,pub.LEGACY_BRIDGE_VERSION,'hongguo-%s-setup.exe'%pub.LEGACY_BRIDGE_VERSION)):
    # TV can own the legacy repository's latest pointer; verify the immutable PC bridge by tag.
    status,release=pub.request('GET','https://api.github.com/repos/'+repo+'/releases/tags/v'+version,secret)
    assert status==200 and release['tag_name']=='v'+version
    asset=next(a for a in release['assets']if a['name']==name)
    assert asset['size']==installer.stat().st_size
    if asset.get('digest'):assert asset['digest']=='sha256:'+expected
    meta=next(a for a in release['assets']if a['name']=='latest.json')
    status,feed=pub.request('GET',meta['browser_download_url'])
    assert status==200
    if isinstance(feed,bytes):feed=json.loads(feed)
    assert feed['version']==version and feed['sha256']==expected
    tv_version=feed['platforms']['android-tv']['version']
    assert tv_version
    if repo==pub.LEGACY:assert feed['migration']['targetVersion']==pub.VERSION
    print(json.dumps({'repo':repo,'tag':release['tag_name'],'sha256':expected,'tvVersion':tv_version,'assetSize':asset['size']}))
status,current=pub.request('GET','https://api.github.com/repos/'+pub.LEGACY+'/releases/latest',secret)
assert status==200
latest=next(a for a in current['assets']if a['name']=='latest.json')
status,active_feed=pub.request('GET',latest['browser_download_url'])
assert status==200
if isinstance(active_feed,bytes):active_feed=json.loads(active_feed)
assert active_feed['version']==pub.LEGACY_BRIDGE_VERSION
assert active_feed['platforms']['windows-x86_64']['sha256']==expected
assert active_feed['migration']['targetVersion']==pub.VERSION
print(json.dumps({'activeLegacyFeed':current['tag_name'],'pcBridge':active_feed['version'],'tvVersion':active_feed['platforms']['android-tv']['version']}))
old=Path(os.environ['LOCALAPPDATA'])/'Programs/红果免费短剧/backend/desktop_update.py'
if not old.is_file():old=pub.ROOT.parent/'hongguo-desktop-maintain/src/backend/desktop_update.py'
fake=types.ModuleType('hongguo');route=pub.proxy()
fake.http_request=lambda method,url,**kwargs:requests.request(method,url,proxies={'http':route,'https':route}if route else None,**kwargs)
sys.modules['hongguo']=fake
spec=importlib.util.spec_from_file_location('legacy_update',old)
legacy=importlib.util.module_from_spec(spec);spec.loader.exec_module(legacy)
result=legacy.check(local='1.9.9')
assert result.get('ok')and result.get('latestVersion')==pub.LEGACY_BRIDGE_VERSION, '旧更新器尚未读到迁移版本：'+str(result.get('latestVersion'))
assert result.get('sha256')==expected and result.get('assetName')=='hongguo-%s-setup.exe'%pub.LEGACY_BRIDGE_VERSION
print(json.dumps({'legacyClientParsed':True,'from':'1.9.9','bridge':result['latestVersion'],'clientVersion':pub.VERSION}))
