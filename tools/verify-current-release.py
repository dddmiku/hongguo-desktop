"""Verify the current independent PC release without modifying the retired bridge."""
import hashlib
import json
import subprocess
import publish

root = publish.ROOT
version = publish.VERSION
api = 'https://api.github.com/repos/' + publish.REPO
secret = publish.token()

def read(url, authenticated=False):
    status, value = publish.request('GET', url, secret if authenticated else None)
    if status != 200:
        raise RuntimeError('Current PC release verification failed: HTTP ' + str(status))
    return value

release = read(api + '/releases/latest', True)
assert release['tag_name'] == 'v' + version and not release['draft'] and not release['prerelease']
local = root / 'release' / ('hongguo-' + version + '-setup.exe')
digest = hashlib.sha256(local.read_bytes()).hexdigest()
asset = next(item for item in release['assets'] if item['name'] == local.name)
assert asset['size'] == local.stat().st_size and asset.get('digest') == 'sha256:' + digest
download = read(asset['browser_download_url'])
assert isinstance(download, bytes) and hashlib.sha256(download).hexdigest() == digest
feed = read(next(item for item in release['assets'] if item['name'] == 'latest.json')['browser_download_url'])
if isinstance(feed, bytes):
    feed = json.loads(feed)
assert feed['version'] == version and set(feed['platforms']) == {'windows-x86_64'}
platform = feed['platforms']['windows-x86_64']
assert platform['version'] == version and platform['sha256'] == digest
assert platform['url'] == asset['browser_download_url'] and platform['size'] == len(download)
assert feed['migration']['repository'] == 'https://github.com/' + publish.REPO
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
reference = read(api + '/git/ref/tags/v' + version, True)['object']
if reference['type'] == 'tag':
    reference = read(reference['url'], True)['object']
assert reference['type'] == 'commit' and reference['sha'] == head
print(json.dumps({'repository':publish.REPO,'version':version,'sourceCommit':head,
                  'bytes':len(download),'sha256':digest,'downloadAndFeedVerified':True}, ensure_ascii=False))
