# Adapted protocol leaf SDK; provenance: service/vendor/README.md.
"""Content protocol leaf SDK for the managed desktop gateway. Signing is supplied only by its owned loopback signer; no emulator or captured user session fallback."""
import sys, os, json, time, hashlib, re, subprocess, threading, gzip, base64
import urllib3
import requests
from . import safeguards as SG
from .safeguards import RiskControlError, AuthExpiredError
from search_protocol import select_search_tab
IMPERSONATE = os.environ.get('IMPERSONATE', 'chrome')
HONGGUO_PROXY = os.environ.get('HONGGUO_PROXY', '').strip()
try:
    from curl_cffi import requests as _cffi
    _HAS_CFFI = True
except Exception:
    _cffi = None
    _HAS_CFFI = False

def _ext_proxies():
    return {'http': HONGGUO_PROXY, 'https': HONGGUO_PROXY} if HONGGUO_PROXY else None
import threading as _th
_tls = _th.local()

def _ext_session():
    s = getattr(_tls, 'ext', None)
    if s is None:
        if _HAS_CFFI and IMPERSONATE:
            s = _cffi.Session()
        else:
            s = requests.Session()
            ad = requests.adapters.HTTPAdapter(pool_connections=16, pool_maxsize=32, max_retries=0)
            s.mount('https://', ad)
            s.mount('http://', ad)
        _tls.ext = s
    return s

def http_request(method, url, **kw):
    """对外部(红果/CDN)发请求: 线程本地 Session 复用连接 + TLS 证书校验 + 代理。
    curl_cffi 未安装或 IMPERSONATE 为空 → 透明退回原生 requests(行为不变)。"""
    if kw.get('verify') is False:
        raise ValueError('TLS certificate verification cannot be disabled')
    kw.setdefault('verify', True)
    if HONGGUO_PROXY:
        kw.setdefault('proxies', _ext_proxies())
    s = _ext_session()
    if _HAS_CFFI and IMPERSONATE:
        kw.setdefault('impersonate', IMPERSONATE)
    return s.request(method, url, **kw)
urllib3.disable_warnings()
HERE = os.path.dirname(os.path.abspath(__file__))
CFG_PATH = os.environ.get('HONGGUO_CONTENT_CONFIG') or os.path.join(HERE, 'config.json')
CFG = json.load(open(CFG_PATH, encoding='utf-8-sig'))
HOST = CFG['api_host']
_pool = None
session_loader = None
IMAGE_SHRINK = 'W3siaW1hZ2VfdHlwZSI6MywiaW1hZ2Vfd2lkdGgiOjkwMCwic2hyaW5rX3R5cGUiOjN9LHsiaW1h\nZ2VfdHlwZSI6NCwiaW1hZ2Vfd2lkdGgiOjU0LCJzaHJpbmtfdHlwZSI6NH1d\n'
SIGN_SERVERS = [s.strip() for s in (os.environ.get('SIGN_SERVER') or '').split(',') if s.strip()]
SIGN_LIST = (os.environ.get('HG_SIGN_LIST') or '').strip().lower() in ('1', 'true', 'yes', 'on')
_sign_rr = [0]
_sign_rr_lock = threading.Lock()

def _next_sign_server():
    with _sign_rr_lock:
        i = _sign_rr[0] % len(SIGN_SERVERS)
        _sign_rr[0] = (_sign_rr[0] + 1) % max(1, len(SIGN_SERVERS))
        return SIGN_SERVERS[i]

def _sign_session():
    """对本机签名服务的线程本地 Session(keep-alive, 省每签名一次握手/TIME_WAIT)。"""
    s = getattr(_tls, 'sign', None)
    if s is None:
        s = requests.Session()
        s.mount('http://', requests.adapters.HTTPAdapter(pool_connections=8, pool_maxsize=16, max_retries=0))
        _tls.sign = s
    return s

def sign(url, headers, body=None):
    if not SIGN_SERVERS:
        raise RuntimeError('Owned signing service is not configured')
    session = _sign_session()
    payload = {'url': url, 'headers': headers}
    if body is not None:
        payload['body_base64'] = base64.b64encode(body).decode('ascii')
    for _ in range(len(SIGN_SERVERS)):
        base = _next_sign_server()
        try:
            response = session.post(base.rstrip('/') + '/sign', json=payload, timeout=40)
            response.raise_for_status()
            result = response.json()
            if isinstance(result, dict) and 'error' not in result and {'x-argus', 'x-gorgon', 'x-khronos'} <= {str(key).lower() for key in result}:
                return result
        except Exception:
            continue
    raise RuntimeError('Owned signing service is unavailable')

_HQ_DEVICE_TYPE = os.environ.get('HG_DEVICE_TYPE') or 'PGT-AN10'
_HQ_USER_AGENT = os.environ.get('HG_USER_AGENT') or 'com.phoenix.read/73932 (Linux; U; Android 12; zh_CN_#Hans; PGT-AN10; Build/V417IR;tt-ok/3.12.13.20)'
try:
    if str(CFG['base_query'].get('device_type') or '').startswith('audit'):
        CFG['base_query']['device_type'] = _HQ_DEVICE_TYPE
    _ua = str(CFG['session_headers'].get('user-agent') or '')
    if not _ua or 'audit' in _ua.lower():
        CFG['session_headers']['user-agent'] = _HQ_USER_AGENT
except Exception:
    pass
_API_HOSTS = [h.strip() for h in os.environ.get('HG_API_HOSTS', '').split(',') if h.strip()] or ['api5-normal-sinfonlinea.fqnovel.com', 'reading.snssdk.com', 'api5-normal-sinfonlineb.fqnovel.com', 'api5-normal-sinfonlinec.fqnovel.com', 'api3-normal-sinfonlinea.fqnovel.com', 'api3-normal-sinfonlineb.fqnovel.com', 'api5-normal.fqnovel.com', 'api.fqnovel.com']
_api_host_pref = None

def _api_hosts_ordered():
    """主机尝试顺序: 上次成功的最前, 其次配置的主机, 再其它镜像。"""
    out = []
    if _api_host_pref:
        out.append(_api_host_pref)
    if HOST not in out:
        out.append(HOST)
    for _h in _API_HOSTS:
        if _h not in out:
            out.append(_h)
    return out

def _hq_apply_device_identity():
    path = os.path.join(os.environ['HG_DATA_DIR'], 'desktop-device.json')
    try:
        with open(path, encoding='utf-8') as handle:
            device = json.load(handle)
        if device.get('device_id'):
            CFG['base_query']['device_id'] = str(device['device_id'])
        if device.get('iid'):
            CFG['base_query']['iid'] = str(device['iid'])
        if device.get('cdid'):
            CFG['base_query']['cdid'] = str(device['cdid'])
        return bool(device.get('iid'))
    except (OSError, ValueError):
        return False
_HQ_IID_NEXT_TRY = [0.0]

def _hq_ensure_iid():
    """iid 缺了就补一次。首次启动时设备身份可能还没落盘（登录模块稍后才写），
    所以不能只在 import 时读一次；带 30s 退避，避免每个请求都碰磁盘。"""
    if CFG['base_query'].get('iid'):
        return
    if time.time() < _HQ_IID_NEXT_TRY[0]:
        return
    if not _hq_apply_device_identity():
        _HQ_IID_NEXT_TRY[0] = time.time() + 30
try:
    _hq_apply_device_identity()
except Exception:
    pass

def build_url(path, extra=None, host=None):
    _hq_ensure_iid()
    q = dict(CFG['base_query'])
    if _pool:
        q.update(_pool.current()['query'])
    if extra:
        q.update(extra)
    q['_rticket'] = str(int(time.time() * 1000))
    qs = '&'.join((f"{k}={requests.utils.quote(str(v), safe='')}" for k, v in q.items()))
    return f'https://{host or HOST}{path}?{qs}'

def _api_once(method, path, body, extra_query, signed=True, host=None):
    url = build_url(path, extra_query, host)
    headers = dict(CFG['session_headers'])
    if callable(session_loader):
        current = dict(session_loader() or {})
        for source, target in (('cookie', 'cookie'), ('token', 'x-tt-token')):
            value = current.get(source)
            if isinstance(value, str) and value:
                headers[target] = value
        current.clear()
    if _pool:
        _ua = _pool.current().get('user_agent')
        if _ua:
            headers['user-agent'] = _ua
        headers.pop('x-tt-token', None)
        headers.pop('cookie', None)
    headers['content-type'] = 'application/json; charset=utf-8'
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if path.startswith('/novel/player/'):
            data = gzip.compress(data, mtime=0)
            headers['content-encoding'] = 'gzip'
        headers['x-ss-stub'] = hashlib.md5(data).hexdigest().upper()
    if signed:
        headers.update(sign(url, headers, data))
    headers.pop('accept-encoding', None)
    SG.throttle.wait()
    r = http_request(method, url, data=data, headers=headers, timeout=30)
    try:
        j = r.json()
    except ValueError:
        raise UpstreamResponseError(r) from None
    try:
        SG.check_response(j)
    except (RiskControlError, AuthExpiredError) as error:
        code = j.get('code') if isinstance(j, dict) else None
        if code is None and isinstance(j, dict):
            code = j.get('Code')
        message = str(j.get('message') or j.get('Message') or '').lower() if isinstance(j, dict) else ''
        error.safe_response = {'http_status': r.status_code, 'code': code if isinstance(code, int) else None, 'known_risk_code': code in SG.RISK_CODES, 'known_auth_code': code in SG.AUTH_CODES, 'risk_keyword': any((word in message for word in SG.RISK_KEYWORDS)), 'auth_keyword': any((word in message for word in SG.AUTH_KEYWORDS))}
        if re.fullmatch('[\\u4e00-\\u9fffA-Za-z _.,:()\\-]{1,120}', message) and (not re.search('token|cookie|secret|authorization|password', message)):
            error.safe_response['message'] = message
        raise
    _api_once_code_upper = True
    return j

class UpstreamResponseError(RuntimeError):

    def __init__(self, response):
        self.diagnostic = {'http_status': int(response.status_code), 'body_bytes': len(response.content)}
        super().__init__('Upstream did not return JSON')
_HQ_TRANSIENT_CODES = {110001, 100001, 100002}
_HQ_TRANSIENT_TRIES = 2

def api(method, path, body=None, extra_query=None, max_retries=3, signed=True):
    """带签名的 API 调用,含重试退避 + 登录态自动刷新 + 多主机故障转移。
    signed=False: 免签(列表/榜单/筛选类接口红果不校验签名, 不占用签名后端)。

    本地维护: 上游 API 主机有多个等价镜像, 但签名与 host 绑定(签名覆盖完整 URL),
    所以每个主机各自现签。网络层失败(连接重置/空响应非 JSON)自动换下一个主机;
    风控与登录态错误跟主机无关 —— 换主机不会变好, 只会多打请求, 故不换。"""
    global _api_host_pref
    desktop = True
    last = None
    for host in _api_hosts_ordered():
        for attempt in range(max_retries):
            try:
                j = _api_once(method, path, body, extra_query, signed=signed, host=host)
                if _api_host_pref != host:
                    _api_host_pref = host
                    pass
                return j
            except AuthExpiredError as e:
                if desktop:
                    raise
                last = e
                pass
                refresh_session()
                time.sleep(1)
            except RiskControlError as e:
                last = e
                _code = None
                try:
                    _code = (getattr(e, 'safe_response', None) or {}).get('code')
                except Exception:
                    pass
                if _code in _HQ_TRANSIENT_CODES and attempt + 1 < _HQ_TRANSIENT_TRIES:
                    wait = 0.5 * (attempt + 1)
                    pass
                    time.sleep(wait)
                    continue
                if desktop:
                    raise
                wait = 2 ** attempt + 1
                pass
                time.sleep(wait)
            except (requests.RequestException, ValueError, UpstreamResponseError) as e:
                last = e
                pass
                if not desktop:
                    time.sleep(1.5 * (attempt + 1))
                break
    raise last if last else RuntimeError('api 失败')

def _cover_tags(d):
    """提取封面角标(爆剧/新剧/独播…)。cover_tag_info_list 结构不定, 容错取文本。"""
    out = []
    for t in d.get('cover_tag_info_list') or []:
        if isinstance(t, dict):
            v = t.get('text') or t.get('content') or t.get('name') or t.get('tag_text') or t.get('title')
            if v:
                out.append(re.sub('<[^>]+>', '', str(v)))
        elif isinstance(t, str) and t:
            out.append(t)
    return out

def _parse_search_cell(cell):
    """从搜索的一个cell解析剧集条目; 非剧集(无集数)或无id返回 None。"""
    sid = cell.get('book_id') or cell.get('search_result_id')
    if not sid:
        return None
    vd = cell.get('video_detail') or {}
    vdata = cell.get('video_data')
    if isinstance(vdata, list) and vdata:
        vdata = vdata[0]
    elif not isinstance(vdata, dict):
        vdata = {}
    inner = vdata.get('video_detail') or {}
    ep = vd.get('episode_cnt') or vdata.get('episode_cnt') or inner.get('episode_cnt') or 0
    if not ep:
        return None
    hl = cell.get('search_high_light', {}).get('title', {}).get('text')
    title = re.sub('<[^>]+>', '', hl or vd.get('series_title') or vdata.get('title') or inner.get('series_title') or '')
    return {'series_id': sid, 'title': title, 'episode_cnt': ep, 'score': vdata.get('score') or inner.get('score') or '', 'play_cnt': vdata.get('play_cnt') or inner.get('series_play_cnt') or 0, 'hot': vdata.get('rec_text') or '', 'copyright': vdata.get('copyright') or '', 'cover': vdata.get('cover') or inner.get('series_cover') or '', 'intro': (inner.get('series_intro') or vd.get('series_intro') or '')[:60], 'vid': vdata.get('vid') or '', 'duration': vdata.get('duration') or 0, 'horiz_cover': vdata.get('horiz_cover') or '', 'cover_tags': _cover_tags(vdata)}

def search_page(query, *, offset=0, passback='', search_id=''):
    """One official mobile drama page; only parsed public rows and native cursors survive."""
    params = {'query': query, 'tab_name': 'feed', 'tab_type': '29', 'search_source': '1',
              'offset': str(offset), 'count': '0', 'use_correct': 'false'}
    if passback:
        params['passback'] = passback
    if search_id:
        params['search_id'] = search_id
    tab = select_search_tab(api('GET', '/reading/bookapi/search/tab/v', extra_query=params))
    items, seen, complete = [], set(), True
    for cell in tab['data']:
        if not isinstance(cell, dict):
            complete = False
            continue
        try:
            item = _parse_search_cell(cell)
        except (AttributeError, TypeError, ValueError):
            complete = False
            continue
        if not item:
            continue
        sid = str(item.get('series_id') or '')
        if not re.fullmatch(r'[0-9]{8,24}', sid):
            complete = False
            continue
        if sid in seen:
            continue
        seen.add(sid)
        item['series_id'] = sid
        items.append(item)
    has_more = bool(tab.get('has_more'))
    next_offset = tab.get('next_offset')
    next_passback = str(tab.get('passback') or passback)
    next_search_id = str(tab.get('search_id') or search_id)
    if has_more and (next_offset is None or not tab['data'] or
                    (str(next_offset), next_passback, next_search_id) ==
                    (str(offset), str(passback), str(search_id))):
        has_more, complete = False, False
    return {'items': items, 'offset': next_offset if next_offset is not None else offset,
            'passback': next_passback, 'search_id': next_search_id,
            'hasMore': has_more, 'complete': complete}


def suggestions(query, max_items=8):
    """Public suggestions use one drama tab page and do not start pagination."""
    from search import SearchRows
    limit = max(1, min(int(max_items), 12))
    page = search_page(query)
    return SearchRows(page['items'][:limit], complete=page['complete'])


def search(query, max_items=None):
    """搜索剧集。原生剧集tab按 next_offset+passback+search_id 分页,
    这里循环翻页累计短剧结果, 直到 has_more=False 或达 max_items / 翻页上限。
    max_items 越小翻页越少越快(单 IP 顺序翻页是单次延迟主因); 默认走 HG_SEARCH_MAX_ITEMS(20)。
    """
    # Provider search owns the public result contract; importing lazily avoids
    # coupling module startup to its season-title parser.
    from search import SearchRows
    if max_items is None:
        max_items = int(os.environ.get('HG_SEARCH_MAX_ITEMS', '20'))
    max_items = max(1, min(max_items, 40))
    ck = SG.cache_key('search-drama-29', query, max_items)
    cached = SG.cache_get(ck)
    if cached is not None:
        return SearchRows(cached, complete=getattr(cached, 'complete', True))
    results, seen = ([], set())
    offset, passback, search_id = (0, '', '')
    cursors = {('0', '', '')}
    complete = True
    for _ in range(12):
        try:
            page = search_page(query, offset=offset, passback=passback, search_id=search_id)
        except Exception:
            # A later read failure must not erase the matches already obtained.
            # Keep the first-page failure visible to Provider's fixed error boundary.
            if not results:
                raise
            complete = False
            break
        complete = complete and page['complete']
        for item in page['items']:
            if item['series_id'] in seen:
                continue
            seen.add(item['series_id'])
            results.append(item)
        if not results and not complete:
            raise RuntimeError('Search response is unavailable')
        if len(results) >= max_items or not page['hasMore']:
            break
        next_offset = page['offset']
        next_passback = page['passback']
        next_search_id = page['search_id']
        cursor = (str(next_offset), str(next_passback), str(next_search_id))
        if cursor in cursors:
            complete = False
            break
        cursors.add(cursor)
        offset, passback, search_id = next_offset, next_passback, next_search_id
    else:
        complete = False
    result = SearchRows(results[:max_items], complete=complete)
    if result.complete:
        SG.cache_set(ck, result, ttl=600)
    return result

def _episodes_body(series_id):
    return {'biz_param': {'detail_page_version': 0, 'disable_digg_stat': False, 'disable_video_relate_book': False, 'image_shrink_datas_str': IMAGE_SHRINK, 'need_all_video_definition': False, 'need_mp4_align': False, 'screen_width_px': '900', 'source': 7, 'use_os_player': False, 'use_server_dns': False}, 'series_id': series_id}

def _parse_episode_detail(sid, vd):
    eps = []
    for e in (vd or {}).get('video_list', []):
        eps.append({'index': e.get('vid_index'), 'vid': e.get('vid'), 'title': e.get('title', '')[:30], 'duration': e.get('duration'), 'cover': e.get('episode_cover') or e.get('cover') or '', 'comment_count': e.get('comment_count', 0), 'digged_count': e.get('digged_count', 0)})
    eps.sort(key=lambda x: x['index'] or 0)
    first_ep_cover = next((e.get('cover') for e in eps if e.get('cover')), '')
    celebs = [{'演员': c.get('nickname'), '角色': c.get('role_name'), '头像': c.get('avatar'), '简介': (c.get('intro') or '')[:80]} for c in (vd or {}).get('celebrities', [])]
    meta = {'series_id': sid, 'title': (vd or {}).get('series_title', sid), 'intro': (vd or {}).get('series_intro', ''), 'episode_cnt': (vd or {}).get('episode_cnt', len(eps)), 'status': '完结' if (vd or {}).get('series_status') == 1 else '连载中', 'play_cnt': (vd or {}).get('series_play_cnt', 0), 'followed_cnt': (vd or {}).get('followed_cnt', 0), 'create_time': (vd or {}).get('create_time', 0), 'cover': (vd or {}).get('series_cover') or first_ep_cover, 'category': re.findall('"name":"([^"]+)"', (vd or {}).get('category_schema', '')), 'celebrities': celebs}
    return (meta, eps)

def get_episodes(series_id):
    sid = str(series_id)
    ck = SG.cache_key('episodes', sid)
    cached = SG.cache_get(ck)
    if cached is not None:
        return cached
    j = api('POST', '/novel/player/multi_video_detail/v1/', body=_episodes_body(sid))
    data = j.get('data', {})
    meta, eps = _parse_episode_detail(sid, data.get(sid, {}).get('video_data', {}))
    SG.cache_set(ck, (meta, eps), ttl=21600)
    return (meta, eps)

def get_episodes_batch(series_ids, batch_size=20):
    """批量取剧集元数据。multi_video_detail 支持 series_id 用逗号拼接；实测 20 个/批稳定，30 个会参数错误。"""
    ids, seen = ([], set())
    for sid in series_ids or []:
        sid = str(sid).strip()
        if sid and sid not in seen:
            seen.add(sid)
            ids.append(sid)
    batch_size = max(1, min(int(batch_size or 20), 20))
    out, failed = ({}, [])
    todo = []
    for sid in ids:
        cached = SG.cache_get(SG.cache_key('episodes', sid))
        if cached is not None:
            out[sid] = cached[0]
        else:
            todo.append(sid)
    for i in range(0, len(todo), batch_size):
        batch = todo[i:i + batch_size]
        try:
            j = api('POST', '/novel/player/multi_video_detail/v1/', body=_episodes_body(','.join(batch)))
            data = j.get('data', {}) or {}
            for sid in batch:
                vd = (data.get(sid) or {}).get('video_data') or {}
                if not vd:
                    failed.append({'series_id': sid, 'error': 'empty detail'})
                    continue
                meta, eps = _parse_episode_detail(sid, vd)
                SG.cache_set(SG.cache_key('episodes', sid), (meta, eps), ttl=21600)
                out[sid] = meta
        except Exception as e:
            failed.extend(({'series_id': sid, 'error': str(e)} for sid in batch))
    return (out, failed)

def video_model_tracks(model):
    """Accept both upstream model shapes; reject malformed tracks locally."""
    import base64
    from urllib.parse import urlsplit
    tracks = model.get('video_list', []) if isinstance(model, dict) else model
    if isinstance(tracks, dict):
        tracks = list(tracks.values())
    if not isinstance(tracks, list) or any((not isinstance(t, dict) for t in tracks)):
        error = ValueError('Unsupported video model shape')
        error.model_shape = {'model_type': type(model).__name__, 'tracks_type': type(tracks).__name__, 'element_types': sorted({type(t).__name__ for t in tracks}) if isinstance(tracks, list) else []}
        raise error
    normalized = []
    for source in tracks:
        track = dict(source)
        for field in ('main_url', 'backup_url', 'backup_url_1', 'backup_url_2', 'backup_url_3'):
            value = track.get(field)
            if not value:
                continue
            if not isinstance(value, str):
                raise ValueError('Invalid media URL type')
            if not value.startswith(('http://', 'https://')):
                try:
                    value = base64.b64decode(value, validate=True).decode('utf-8')
                except (ValueError, UnicodeError):
                    raise ValueError('Invalid encoded media URL') from None
            parsed = urlsplit(value)
            if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError('Invalid media URL')
            track[field] = value
        for container, fields in (('video_meta', ('size', 'definition', 'codec_type', 'vwidth', 'vheight')), ('encrypt_info', ('encrypt', 'spade_a'))):
            nested = track.get(container)
            if nested is not None and (not isinstance(nested, dict)):
                raise ValueError('Invalid track metadata')
            track[container] = {**{key: source[key] for key in fields if key in source}, **(nested or {})}
        normalized.append(track)
    return normalized

def get_video_urls(vids, force=False):
    """批量取视频直链。返回 {vid: {"url":, "size":, "definition":}}
    每个vid的直链缓存5小时(url_expire约6h),命中则不重复调video_model,大幅降低风控。
    force=True 跳过缓存强制重取(续传时直链过期用)。"""
    out = {}
    todo = []
    for v in vids:
        c = None if force else SG.cache_get(SG.cache_key('vmodel', str(v)))
        if c is not None:
            out[str(v)] = c
        else:
            todo.append(v)
    for i in range(0, len(todo), 5):
        batch = [str(v) for v in todo[i:i + 5]]
        body = {'biz_param': {'detail_page_version': 0, 'device_level': 3, 'disable_digg_stat': False, 'disable_video_relate_book': False, 'need_all_video_definition': True, 'need_mp4_align': False, 'use_os_player': False, 'use_server_dns': False, 'video_platform': 1024}, 'mixed_video_id_map': {'1': batch}}
        _hq_got = {}
        for _hq_v in batch:
            try:
                _hq_j = api('GET', '/reading/bookapi/video_tab/video_model/v1/', extra_query={'video_id': str(_hq_v), 'need_all_video_definition': '1'})
                _hq_vm = (_hq_j.get('data') or {}).get('video_model')
                if _hq_vm:
                    _hq_got[str(_hq_v)] = {'video_model': _hq_vm}
            except Exception:
                continue
        if not _hq_got:
            try:
                j = api('POST', '/novel/player/multi_video_model/v1/', body=body)
                _hq_got = j.get('data') or {}
            except (RiskControlError, UpstreamResponseError):
                _hq_got = {}
            except Exception:
                _hq_got = {}
        if not _hq_got and batch:
            raise UpstreamResponseError(_HQEmptyResponse())
        for vid, v in _hq_got.items():
            vm = v.get('video_model')
            if not vm:
                continue
            vmj = json.loads(vm)
            best = None
            for item in video_model_tracks(vmj):
                meta = item.get('video_meta', {})
                size = meta.get('size', 0)
                if best is None or size > best['size']:
                    best = {'url': item.get('main_url'), 'backup': item.get('backup_url'), 'size': size, 'definition': meta.get('definition', '?'), 'shape': {key: type(item[key]).__name__ for key in ('video_meta', 'encrypt_info', 'main_url', 'size', 'definition', 'codec_type', 'vwidth', 'vheight', 'encrypt', 'spade_a', 'file_hash') if key in item}, 'url_is_http': str(item.get('main_url', '')).startswith(('https://', 'http://'))}
            if best:
                out[vid] = best
                SG.cache_set(SG.cache_key('vmodel', vid), best, ttl=18000)
    return out

def get_video_tracks(vids, force=False, batch_size=5):
    """批量取每个vid的完整 video_list 轨道(含 main_url/backup_url/video_meta/encrypt_info.spade_a)。
    与 get_video_urls 不同: 保留 spade_a(离线解密必需) 和全部清晰度轨道(供选清晰度)。
    一次 5 个 vid(app 真实批量大小)→ 5 集只签 1 次, 大幅降签名/节流/风控压力。
    按 vid 缓存 5h(main_url url_expire 约6h); force=True 跳过缓存(URL过期续传用)。
    返回 {vid(str): [track,...]}; 未返回的 vid 不在结果里(调用方自行回退)。"""
    out, todo, seen = ({}, [], set())
    for v in vids:
        v = str(v)
        if v in seen:
            continue
        seen.add(v)
        c = None if force else SG.cache_get(SG.cache_key('vmtracks', v))
        if c is not None:
            out[v] = c
        else:
            todo.append(v)
    bs = max(1, min(int(batch_size or 5), 5))
    for i in range(0, len(todo), bs):
        batch = todo[i:i + bs]
        body = {'biz_param': {'detail_page_version': 0, 'device_level': 3, 'disable_digg_stat': False, 'disable_video_relate_book': False, 'need_all_video_definition': True, 'need_mp4_align': False, 'use_os_player': False, 'use_server_dns': False, 'video_platform': 1024}, 'mixed_video_id_map': {'1': batch}}
        _hq_got = {}
        modern = {**body, 'dr_scene': 'player', 'mixed_video_id_map': {'1004': batch}}
        try:
            response = api('POST', '/novel/player/multi_video_model/player/v1', body=modern)
            def collect(value):
                if not isinstance(value, dict):
                    return
                for key, entry in value.items():
                    if not isinstance(entry, dict):
                        continue
                    if str(key) in batch and entry.get('video_model'):
                        _hq_got[str(key)] = entry
                    else:
                        collect(entry)
            collect(response.get('data') or {})
        except (RiskControlError, AuthExpiredError):
            raise
        except UpstreamResponseError:
            pass
        for _hq_v in batch:
            if str(_hq_v) in _hq_got:
                continue
            try:
                _hq_j = api('GET', '/reading/bookapi/video_tab/video_model/v1/', extra_query={'video_id': str(_hq_v), 'need_all_video_definition': '1'})
                _hq_vm = (_hq_j.get('data') or {}).get('video_model')
                if _hq_vm:
                    _hq_got[str(_hq_v)] = {'video_model': _hq_vm}
            except Exception:
                continue
        if not _hq_got:
            try:
                j = api('POST', '/novel/player/multi_video_model/v1/', body=body)
                _hq_got = j.get('data') or {}
            except (RiskControlError, UpstreamResponseError):
                _hq_got = {}
            except Exception:
                _hq_got = {}
        if not _hq_got and batch:
            raise UpstreamResponseError(_HQEmptyResponse())
        for vid, v in _hq_got.items():
            vm = v.get('video_model')
            if not vm:
                continue
            _hq_vmj = json.loads(vm)
            tracks = video_model_tracks(_hq_vmj)
            _hq_fb = _hq_vmj.get('fallback_api')
            if _hq_fb:
                for _hqt in tracks:
                    _hqt['_hq_fallback_api'] = _hq_fb
            if tracks:
                out[str(vid)] = tracks
                SG.cache_set(SG.cache_key('vmtracks', str(vid)), tracks, ttl=18000)
    return out
import uuid, datetime

def _is_today_ts(ts):
    """unix秒是否为今天(中国时区UTC+8)"""
    if not ts:
        return False
    d = (datetime.datetime.utcfromtimestamp(ts) + datetime.timedelta(hours=8)).date()
    now = (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).date()
    return d == now
COMIC_RANK_CELL = '7470092475068071998'
RANK_BOARDS = {'recommend': 'comic_series_hot_rank', 'hot': 'comic_series_hot_play', 'new': 'comic_series_new_rank'}
RANK_NAMES = {'recommend': '漫剧推荐榜', 'hot': '漫剧热播榜', 'new': '漫剧新剧榜'}
FEED_TAB_TYPE = '26'
FEED_STREAM = 20
FEED_MAX_PAGES = 12

def _feed_page(session, offset):
    """拉一页（6 条），返回 (session, next_offset, has_more, items)。"""
    q = {'tab_type': FEED_TAB_TYPE, 'tab_index': '0', 'offset': str(max(0, int(offset or 0))), 'stream_count': str(FEED_STREAM), 'client_req_type': '2', 'client_template': '2', 'screen_width_px': '1350'}
    if session:
        q['session_id'] = str(session)
    j = api('GET', '/reading/bookapi/bookmall/tab/v', extra_query=q, signed=SIGN_LIST)
    tabs = (j.get('data') or {}).get('tab_item') or []
    tab = tabs[0] if tabs else {}
    cells = tab.get('cell_data') or []
    inner = cells[0].get('cell_data') or [] if cells else []
    out = []
    for c in inner:
        for v in c.get('video_data') or []:
            sid = v.get('series_id') or v.get('book_id')
            if not sid:
                continue
            out.append({'seriesId': str(sid), 'title': str(v.get('title') or v.get('book_name') or ''), 'cover': v.get('cover') or v.get('thumb_url') or '', 'intro': str(v.get('video_desc') or v.get('intro') or '')[:80], 'actors': v.get('actors') if isinstance(v.get('actors'), list) else [], 'tags': v.get('tags') if isinstance(v.get('tags'), list) else [], 'episodeCount': int(v.get('episode_cnt') or 0), 'webAccessibleEpisodes': int(v.get('accessible_episode_cnt') or 0), 'hotText': str(v.get('rec_text') or '')})
    nxt = tab.get('next_offset')
    nxt = int(nxt) if nxt is not None else int(offset or 0) + 1
    return (str(tab.get('session_id') or session or ''), nxt, bool(tab.get('has_more')), out)

def feed(session='', offset=0, limit=30):
    """个性化推荐流（App 首页「推荐」）。

    首次 session=""、offset=0；之后把上次返回的 session/offset 带回即可续翻。
    上游一页固定 6 条，这里按需连续翻页凑够 limit 条（去重后）。
    返回 {"session","offset","has_more","items"}；session/offset 是**下一次**的游标。
    """
    want = max(1, int(limit or 30))
    items, seen = ([], set())
    cur_sess, cur_off = (str(session or ''), max(0, int(offset or 0)))
    has_more = True
    for _ in range(FEED_MAX_PAGES):
        sess, nxt, more, page = _feed_page(cur_sess, cur_off)
        cur_sess = sess or cur_sess
        if nxt <= cur_off:
            has_more = False
            break
        cur_off = nxt
        for it in page:
            if it['seriesId'] in seen:
                continue
            seen.add(it['seriesId'])
            items.append(it)
        has_more = more
        if len(items) >= want:
            break
        if not more:
            continue
    return {'session': cur_sess, 'offset': cur_off, 'has_more': has_more, 'items': items[:want]}

def rank(board='recommend', limit=30):
    """获取漫剧榜单。board: recommend/hot/new。返回排名列表。"""
    ck = SG.cache_key('rank', board, limit)
    cached = SG.cache_get(ck)
    if cached is not None:
        return cached
    sub = RANK_BOARDS.get(board, board)
    results, offset, sess = ([], 0, str(uuid.uuid4()))
    while len(results) < limit:
        q = {'cell_id': COMIC_RANK_CELL, 'tab_type': '26', 'client_req_type': '2', 'client_template': '2', 'screen_width_px': '1350', 'selected_items': 'comic_series_rank', 'sub_selected_items': sub, 'session_uuid': sess}
        if offset:
            q['offset'] = str(offset)
        j = api('GET', '/reading/bookapi/bookmall/cell/change/v', extra_query=q, signed=SIGN_LIST)
        cv = j.get('data', {}).get('cell_view', {})
        cells = cv.get('cell_data', [])
        if not cells:
            break
        for item in cells:
            v = item.get('video_data')
            if isinstance(v, list):
                v = v[0] if v else {}
            sid = v.get('series_id') or v.get('book_id')
            if not sid:
                continue
            results.append({'rank': len(results) + 1, 'series_id': str(sid), 'title': v.get('title', ''), 'episode_cnt': v.get('episode_cnt', 0), 'score': v.get('score', ''), 'play_cnt': v.get('play_cnt', 0), 'hot': v.get('rec_text') or '', 'copyright': v.get('copyright', ''), 'cover': v.get('cover', ''), 'intro': (v.get('video_desc') or '')[:50]})
        if not cv.get('has_more'):
            break
        offset = cv.get('next_offset', offset + len(cells))
    results = results[:limit]
    SG.cache_set(ck, results, ttl=1800)
    return results
GENRES = {'short_play': ('default', 'short_play'), 'comic_series': ('comic_series', 'comic_series'), 'ai_series': ('ai_series', 'ai_series')}
GENRE_NAMES = {'short_play': '短剧', 'comic_series': '漫剧', 'ai_series': 'AI短剧'}

def latest(genre='short_play', only_today=True, max_items=120, stop_ids=None, refresh=False):
    """最新上架。
    - 短剧(short_play): 官方有'今日上新'标签。only_today=True 精确返回今日上新(扫描多页,
      整页无今日才停,处理交错); False 返回最新上架全部。
    - 漫剧/AI(comic_series/ai_series): 官方无'今日'粒度(最细7天)且不暴露上线时间,
      统一返回'7天内上新·最新上架'(days_7筛选+上线时间降序,顶部最新)。only_today 不影响结果,
      item.today 字段对这两类恒为 False(无法判定)。
    """
    if genre not in GENRES:
        raise ValueError(f'genre必须是 {list(GENRES)}')
    scene, g = GENRES[genre]
    tag_today = genre == 'short_play'
    online_time = [] if tag_today else ['days_7']
    want_today = tag_today and only_today
    out, shown, offset, pages, done = ([], [], 0, 0, False)
    while len(out) < max_items and pages < 20:
        body = {'filter_ids': ','.join(shown), 'req_scene': scene, 'offset': offset, 'need_selector_panel': False, 'limit': 18, 'select_items': {'category_dim_epoch': [], 'online_time': online_time, 'gender': [], 'category_dim_role': [], 'genre': [g], 'sort': ['online_time'], 'category_dim_theme': []}, 'session_id': '', 'req_type': 'only_content', 'client_req_type': 3}
        j = api('POST', '/reading/distribution/category/landpage/v', body=body, signed=SIGN_LIST)
        items = j.get('data', {}).get('video_data', [])
        if not items:
            break
        page_today = 0
        for it in items:
            sid = str(it.get('series_id'))
            if stop_ids and sid in stop_ids:
                done = True
                break
            shown.append(sid)
            subs = [s.get('content') for s in it.get('sub_title_list') or []]
            is_today = '今日上新' in subs
            if is_today:
                page_today += 1
            cats = []
            for nm in re.findall('"name":"([^"]+)"', it.get('category_schema', '')):
                if nm and nm not in cats:
                    cats.append(nm)
            if not cats:
                for s in subs:
                    if not s or s == '今日上新' or re.match('^[\\d.]+万', s) or ('播放' in s) or re.match('^\\d+集$', s):
                        continue
                    if s not in cats:
                        cats.append(s)
            if want_today and (not is_today):
                continue
            out.append({'series_id': sid, 'title': it.get('title', ''), 'episode_cnt': it.get('episode_cnt', 0), 'score': it.get('score', ''), 'play_cnt': it.get('play_cnt', 0), 'cover': it.get('cover', ''), 'category': ' / '.join(cats), 'today': is_today, 'copyright': it.get('copyright', ''), 'premiere': (it.get('tag_info') or {}).get('text', ''), 'intro': (it.get('video_desc') or '')[:50]})
            if len(out) >= max_items:
                break
        pages += 1
        if done:
            break
        if want_today and page_today == 0:
            break
        if not j.get('data', {}).get('has_more', True):
            break
        offset += len(items)
    return out
FILTER_CATE = {'脑洞': 'cate_755', '奇幻': 'cate_6', '剧情': 'cate_316', '玄幻': 'cate_7', '末世': 'cate_68', '豪门': 'cate_936', '科幻': 'cate_1092', '冒险': 'cate_1182', '重生': 'cate_36', '穿越': 'cate_37', '逆袭': 'cate_739', '异能': 'cate_598', '系统': 'cate_19', '反转': 'cate_756', '娱乐圈': 'cate_43', '总裁': 'cate_29', '架空': 'cate_452', '都市': 'cate_1', '古代': 'cate_758', '异界': 'cate_599', '校园': 'cate_4', '职场': 'cate_127', '年代': 'cate_79', '乡村': 'cate_11', '民国': 'cate_390'}
FILTER_SORT = {'最新上架': 'online_time', '最新': 'online_time', '最高热度': 'hot_score', '热度': 'hot_score', 'hot': 'hot_score', '最高收藏': 'hot_collect', '收藏': 'hot_collect'}
FILTER_GENDER = {'男频': '1', '男': '1', '女频': '0', '女': '0'}
FILTER_DAYS = {'7': 'days_7', '14': 'days_14', '30': 'days_30', '90': 'days_90', '7天内上新': 'days_7', '14天内上新': 'days_14', '30天内上新': 'days_30', '90天内上新': 'days_90'}
FILTER_STATUS = {'已完结': 'creation_status_0', '完结': 'creation_status_0', '连载中': 'creation_status_1', '连载': 'creation_status_1'}

def _ids(val, mapping):
    """单值或列表 -> id 列表; 名称按 mapping 映射, 已是 id/未知则原样透传。"""
    if val is None or val == '':
        return []
    vals = val if isinstance(val, (list, tuple)) else [val]
    out = []
    for v in vals:
        v = str(v).strip()
        if v:
            out.append(mapping.get(v, v))
    return out

def filters(genre='short_play'):
    """取某体裁的实时筛选面板。返回 [{type,row_name,selection_type,items:[{id,name}]}]。
    type 即 select_items 的键(genre/category_dim_theme/category_dim_role/category_dim_epoch/sort/gender/online_time)。"""
    scene, g = GENRES.get(genre, ('default', 'short_play'))
    body = {'filter_ids': '', 'req_scene': scene, 'offset': 0, 'limit': 1, 'need_selector_panel': True, 'req_type': 'default', 'client_req_type': 3, 'select_items': {'category_dim_epoch': [], 'online_time': [], 'gender': [], 'category_dim_role': [], 'genre': [g], 'sort': [], 'category_dim_theme': []}, 'session_id': ''}
    rows = api('POST', '/reading/distribution/category/landpage/v', body=body, signed=SIGN_LIST).get('data', {}).get('selector_rows', [])
    return [{'type': r.get('type'), 'row_name': r.get('row_name'), 'selection_type': r.get('selection_type'), 'items': [{'id': it.get('selector_item_id'), 'name': it.get('show_name')} for it in r.get('items', [])]} for r in rows]

def browse(genre='short_play', theme=None, setting=None, background=None, sort='online_time', gender=None, days=None, status=None, max_items=120):
    """按筛选条件浏览短剧/漫剧/AI短剧。各维度可传中文名或 id(cate_xxx)，单值或列表(多选)。
    - genre   体裁: short_play/comic_series/ai_series
    - theme   主题: 脑洞/奇幻/剧情/玄幻/末世/豪门/科幻/冒险 ...
    - setting 设定: 重生/穿越/逆袭/异能/系统/反转/娱乐圈/总裁 ...
    - background 背景: 架空/都市/古代/异界/校园/职场/年代/乡村/民国 ...
    - sort    排序: 最新上架(online_time)/最高热度(hot_score)/最高收藏(hot_collect)
    - gender  受众: 男频(1)/女频(0)
    - days    时间: 7/14/30/90 (天内上新)
    - status  状态(仅漫剧): 已完结/连载中
    全部可选项见 filters(genre)。返回 [{series_id,title,episode_cnt,score,play_cnt,cover,category,intro}]。"""
    if genre not in GENRES:
        raise ValueError(f'genre 必须是 {list(GENRES)}')
    scene, g = GENRES[genre]
    sel = {'genre': [g], 'category_dim_theme': _ids(theme, FILTER_CATE), 'category_dim_role': _ids(setting, FILTER_CATE), 'category_dim_epoch': _ids(background, FILTER_CATE), 'sort': _ids(sort, FILTER_SORT) or ['online_time'], 'gender': _ids(gender, FILTER_GENDER), 'creation_status': _ids(status, FILTER_STATUS), 'online_time': _ids(days, FILTER_DAYS)}
    out, shown, offset, pages = ([], [], 0, 0)
    while len(out) < max_items and pages < 20:
        body = {'filter_ids': ','.join(shown), 'req_scene': scene, 'offset': offset, 'need_selector_panel': False, 'limit': 18, 'select_items': sel, 'session_id': '', 'req_type': 'only_content', 'client_req_type': 3}
        j = api('POST', '/reading/distribution/category/landpage/v', body=body, signed=SIGN_LIST)
        items = j.get('data', {}).get('video_data', [])
        if not items:
            break
        for it in items:
            sid = str(it.get('series_id'))
            shown.append(sid)
            cats = []
            for nm in re.findall('"name":"([^"]+)"', it.get('category_schema', '')):
                if nm and nm not in cats:
                    cats.append(nm)
            out.append({'series_id': sid, 'title': it.get('title', ''), 'episode_cnt': it.get('episode_cnt', 0), 'score': it.get('score', ''), 'play_cnt': it.get('play_cnt', 0), 'cover': it.get('cover', ''), 'copyright': it.get('copyright', ''), 'category': ' / '.join(cats), 'intro': (it.get('video_desc') or '')[:50], 'vid': it.get('vid') or '', 'comment_count': it.get('comment_count', 0), 'duration': it.get('duration') or 0, 'horiz_cover': it.get('horiz_cover') or '', 'cover_tags': _cover_tags(it)})
            if len(out) >= max_items:
                break
        pages += 1
        if not j.get('data', {}).get('has_more', True):
            break
        offset += len(items)
    return out

def browse_page(genre='short_play', theme=None, setting=None, background=None,
                sort='hot_score', offset=0, shown=None):
    """One real category page with the vendor's offset and exclusion list."""
    if genre not in GENRES:
        raise ValueError('Unknown genre')
    scene, g = GENRES[genre]
    selected = {'genre': [g], 'category_dim_theme': _ids(theme, FILTER_CATE),
                'category_dim_role': _ids(setting, FILTER_CATE),
                'category_dim_epoch': _ids(background, FILTER_CATE),
                'sort': [sort], 'gender': [], 'creation_status': [], 'online_time': []}
    seen = list(shown or [])
    body = {'filter_ids': ','.join(seen), 'req_scene': scene, 'offset': offset,
            'need_selector_panel': False, 'limit': 18, 'select_items': selected,
            'session_id': '', 'req_type': 'only_content', 'client_req_type': 3}
    data = api('POST', '/reading/distribution/category/landpage/v', body=body,
               signed=SIGN_LIST).get('data', {})
    videos = data.get('video_data') or []
    items = []
    for video in videos:
        categories = list(dict.fromkeys(re.findall(r'"name"\s*:\s*"([^"]+)"',
                                                    video.get('category_schema') or '')))
        items.append({'series_id': str(video.get('series_id') or ''),
                      'title': video.get('title') or '', 'episode_cnt': video.get('episode_cnt') or 0,
                      'score': video.get('score') or '', 'cover': video.get('cover') or '',
                      'category': categories, 'intro': (video.get('video_desc') or '')[:2000]})
    return {'items': items, 'offset': offset + len(videos),
            'shown': list(dict.fromkeys(seen + [row['series_id'] for row in items]))[-500:],
            'hasMore': bool(videos) and bool(data.get('has_more', True))}

class _HQEmptyResponse:
    status_code = 200
    content = b''
