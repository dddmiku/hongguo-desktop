"""仅用于本次新建仓库首发前，清除旧协议注释样例的提交历史。"""
import importlib.util
import os
from pathlib import Path
import subprocess
spec=importlib.util.spec_from_file_location('publisher',Path(__file__).with_name('publish.py'))
pub=importlib.util.module_from_spec(spec);spec.loader.exec_module(pub)
root=pub.ROOT
def git(*args,env=None):
    return subprocess.run(['git',*args],cwd=root,env=env,check=True,timeout=180,capture_output=True,text=True).stdout.strip()
if Path(git('rev-parse','--show-toplevel')).resolve()!=root.resolve():
    raise RuntimeError('必须在当前独立客户端仓库中执行')
if git('remote','get-url','origin')!='https://github.com/dddmiku/hongguo-desktop.git':
    raise RuntimeError('不允许修改其它仓库')
secret=pub.token()
code,head=pub.request('GET','https://api.github.com/repos/'+pub.REPO+'/git/ref/heads/main',secret)
if code!=200:
    raise RuntimeError('无法核对远端分支')
expected=head['object']['sha']
if git('rev-parse','HEAD')!=expected:
    raise RuntimeError('本机与远端提交不一致，不能重建首发历史')
old_heads=set(git('rev-list','HEAD').splitlines())
git('add','.')
git('checkout','--orphan','initial-public')
git('commit','-m','feat: initial 1.0.0 independent desktop client and safe legacy migration')
git('branch','-M','main')
env=dict(os.environ,HG_GITHUB_TOKEN=secret,GIT_ASKPASS=str(root/'tools/git-askpass.cmd'),GIT_TERMINAL_PROMPT='0')
args=['-c','credential.helper='];route=pub.proxy()
if route:args+=['-c','http.proxy='+route]
git(*args,'push','--force-with-lease=refs/heads/main:'+expected,'-u','origin','main',env=env)
# 本次首发前的 CI 页面也会链接旧样例提交，只清理本次仓库中这些已替换提交的运行。
code,runs=pub.request('GET','https://api.github.com/repos/'+pub.REPO+'/actions/runs?per_page=50',secret)
if code==200:
    for run in runs.get('workflow_runs',[]):
        if run.get('head_sha') in old_heads and run.get('status')=='completed':
            pub.request('DELETE','https://api.github.com/repos/'+pub.REPO+'/actions/runs/'+str(run['id']),secret)
print('已用经过脱敏检查的首发提交替换本次新建仓库历史：'+git('rev-parse','--short','HEAD'))
