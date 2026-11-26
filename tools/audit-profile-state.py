"""Read-only production data check; persist only hashes and counts in the audit workspace."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
PROFILE = Path(os.environ['APPDATA']) / '红果桌面'
OUT = ROOT / '_work' / 'pc-audit'

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

def snapshot():
    library = json.loads((PROFILE / 'library.json').read_text(encoding='utf-8-sig'))
    with sqlite3.connect((PROFILE / 'history.sqlite3').as_uri() + '?mode=ro', uri=True) as db:
        db.execute('PRAGMA query_only=ON')
        keys = sorted(digest(row) for row in db.execute('SELECT uid,sid FROM history'))
    favorites = sorted(digest([uid, item['id']]) for uid, bucket in library['libraries'].items() for item in bucket['favorites'])
    protected = {name: hashlib.sha256((PROFILE / name).read_bytes()).hexdigest()
                 for name in ['account-session.dpapi', 'account-mfa.dpapi', 'web-session.dpapi', 'desktop-device.json']
                 if (PROFILE / name).is_file()}
    return {'historyKeys': keys, 'favoriteKeys': favorites, 'settingsHash': digest(library['settings']), 'protected': protected}

OUT.mkdir(parents=True, exist_ok=True)
current = snapshot()
if sys.argv[1] == 'before':
    (OUT / 'profile-before.json').write_text(json.dumps(current), encoding='utf-8')
    print(json.dumps({'readOnly': True, 'history': len(current['historyKeys']), 'favorites': len(current['favoriteKeys'])}))
else:
    before = json.loads((OUT / 'profile-before.json').read_text(encoding='utf-8'))
    checks = {'allHistoryKeysRetained': set(before['historyKeys']) <= set(current['historyKeys']),
              'allFavoritesRetained': set(before['favoriteKeys']) <= set(current['favoriteKeys']),
              'settingsUnchanged': before['settingsHash'] == current['settingsHash'],
              'protectedFilesUnchanged': before['protected'] == current['protected']}
    report = {'readOnly': True, 'checks': checks, 'historyBefore': len(before['historyKeys']),
              'historyAfter': len(current['historyKeys']), 'favoritesAfter': len(current['favoriteKeys'])}
    (OUT / 'profile-after.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))
    if not all(checks.values()):
        sys.exit(1)
