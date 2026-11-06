"""将尚未完成安装验收的当前发布暂存为草稿，下载入口回退到上一稳定版本。"""
import importlib.util
from pathlib import Path
import json
spec=importlib.util.spec_from_file_location('publisher',Path(__file__).with_name('publish.py'))
pub=importlib.util.module_from_spec(spec);spec.loader.exec_module(pub)
secret=pub.token()
code,release=pub.request('GET','https://api.github.com/repos/'+pub.REPO+'/releases/tags/v'+pub.VERSION,secret)
if code!=200:raise SystemExit('Release not found')
code,held=pub.request('PATCH','https://api.github.com/repos/'+pub.REPO+'/releases/'+str(release['id']),secret,{'draft':True})
print(json.dumps({'tag':release['tag_name'],'held':code==200,'assets':[{'name':a['name'],'downloads':a['download_count']}for a in release['assets']]}))
