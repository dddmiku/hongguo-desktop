# Adapted protocol leaf SDK; provenance: service/vendor/README.md.
"""本地维护: 红果账号（验证码登录）+ 观看进度 / 收藏 双向同步。

纯协议实现，不需要模拟器常驻；登录态保存在本机应用数据目录。
签名走 backend 自带的脱机签名服务（SIGN_SERVER）。

协议要点（均以真机抓包核对）：
  * 验证码登录
      POST /passport/mobile/send_code/v1/   mobile/type/unbind_exist = XOR(0x05) 后 hex
      POST /passport/mobile/sms_login/      mobile/code          = XOR(0x05) 后 hex
      mix_mode=1；表单编码；返回 Set-Cookie 即登录态
  * 观看进度（手机“历史”页读的就是这个）
      POST /reading/bookapi/read_history/update/v   body gzip + x-ss-stub
      GET  /reading/bookapi/read_history/list/v?book_type=2
  * 收藏（短剧书架）
      POST /reading/bookapi/bookshelf/video/update/v   video_shelf_operate_type 0=加 1=删
      GET  /reading/bookapi/bookshelf/video/list/v

请求体统一 gzip 压缩，X-SS-STUB = 压缩后字节的 MD5(大写)，Content-Encoding: gzip。
"""
import gzip
import hashlib
import io
import json
import os
import re
import threading
import time
import requests
from . import hongguo as H
_DATA_DIR = os.environ['HG_DATA_DIR']
SESSION_PATH = os.path.join(_DATA_DIR, 'account-session.json')
PASSPORT_HOST = os.environ.get('HONGGUO_PASSPORT_HOST', 'security.snssdk.com')
PASSPORT_UA = os.environ.get('HONGGUO_PASSPORT_UA', 'com.phoenix.read/73932 (Linux; U; Android 12; zh_CN_#Hans; PGT-AN10; Build/V417IR;tt-ok/3.12.13.20)')
DEVICE_PATH = os.path.join(_DATA_DIR, 'desktop-device.json')
PASSPORT_DEVICE_DEFAULTS = {'device_brand': 'HONOR', 'device_type': 'PGT-AN10', 'resolution': '1080*1920', 'dpi': '480', 'os': 'android', 'os_version': '12', 'os_api': '32', 'rom_version': 'V417IR release-keys', 'host_abi': 'arm64-v8a', 'channel': 'vivo_8662_64', 'ac': 'wifi', 'ssmix': 'a', 'language': 'zh', 'dragon_device_type': 'phone', 'manifest_version_code': '73932', 'update_version_code': '73932', 'version_code': '73932', 'version_name': '7.3.9.32', 'pv_player': '73932', 'compliance_status': '0', 'need_personal_recommend': '1', 'player_so_load': '1', 'is_android_pad_screen': '0', 'okhttp_version': '4.2.243.31-douyin', 'use_store_region_cookie': '1', 'use_new_token_expire_rule': 'true', 'passport-sdk-version': '5051452', 'aid': '8662', 'app_name': 'novelread', 'device_platform': 'android', 'gender': '2', 'har_status': '0', 'charging': '0', 'network_type': '4', 'down_speed': '60000', 'font_scale': '100', 'battery_pct': '93', 'screen_brightness': '102', 'current_volume': '0', 'app_dark_mode': '0', 'sys_dark_mode': '0', 'sys_mini_window': '0', 'app_mini_window': '0', 'is_power_save_mode': '0', 'normal_session_cnt_in_day': '1', 'normal_session_cnt_in_life': '1', 'cold_start_session_cnt_in_day': '1', 'cold_start_session_cnt_in_life': '1'}
PASSPORT_BODY_FIELDS = set(PASSPORT_DEVICE_DEFAULTS) | {'device_id', 'iid', 'cdid', 'normal_session_id', 'cold_start_session_id'}

def _digits(n):
    import random
    return ''.join((random.choice('0123456789') for _ in range(n)))

def _write_device(data):
    """原子写设备身份文件（tmp + os.replace），调用方需持有 _device_lock。

    为什么不直接 io.open(...,"w").write(...)：覆盖写期间文件是「已截断但
    内容不全」的状态，任何并发读者（或本进程被强杀）都会拿到半截 JSON，
    进而被当成「没有合法设备身份」——那等于永久丢失设备身份（见
    _device_lock 处的说明）。os.replace 在同一卷上是原子的：
    读者要么看到旧内容、要么看到新内容，不存在中间态。
    """
    try:
        os.makedirs(os.path.dirname(DEVICE_PATH), exist_ok=True)
        tmp = DEVICE_PATH + '.tmp'
        with io.open(tmp, 'w', encoding='utf-8') as f:
            f.write(json.dumps(data, ensure_ascii=False, indent=1))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, DEVICE_PATH)
        return True
    except OSError:
        return False
DEVICE_ENV = ('HONGGUO_DEVICE_ID', 'HONGGUO_DEVICE_IID', 'HONGGUO_DEVICE_CDID')
_device_lock = threading.RLock()

def _session_ids():
    """真机会带会话 id（形如 <uuid>#<序号>）。缺失时补上并固定。

    2026-10-09 修两处：
      1) 落盘原先被 `and data.get("registered")` 挡住。设备身份来自环境变量
         或随机兜底时 registered 为假，于是**每次护照请求都会生成一个新的
         normal_session_id**，与「缺失时补上并固定」的承诺相反。真机每次
         会话 id 稳定，服务端按 normal_session_cnt_in_day 之类做会话计数，
         指纹不一致本身就是异常客户端的判据。
      2) 读改写没有锁、写入非原子（见 _device_lock / _write_device）。
    """
    with _device_lock:
        data = load_device()
        try:
            saved = json.loads(io.open(DEVICE_PATH, encoding='utf-8').read())
        except Exception:
            saved = {}
        changed = False
        for key, suffix in (('normal_session_id', '#1'), ('cold_start_session_id', '')):
            if not data.get(key):
                if isinstance(saved, dict) and saved.get(key):
                    data[key] = saved[key]
                    continue
                import uuid
                data[key] = str(uuid.uuid4()) + suffix
                changed = True
        if changed:
            _write_device(data)
        return data

def _from_bundled():
    """随安装包携带的设备身份。

    为什么必须这么做（2026-10-08 实测 + 上游调查结论）：
      红果的护照接口对 device_id / iid **两个字段一起**校验，未注册的随机值
      直接 403 + 空 body（前端只看到「非 JSON 响应」）。而**离线注册一台新设备
      是研究级难题**：
        * 设备注册接口的签名校验 aid（红果 8662 vs 内置签名器 1967）对不上，
          实测跨 app 签名被接受（HTTP 200）但返回 device_id=0；
        * 红果新版 metasec 用 .msp_<sha1> 设备态存储，内容按设备上下文加密，
          搬过来也解不开；fresh 注册要复现 metasec 的引导握手（网络+VM 保护 crypto）。
      上游自己的做法也是「让真 app 注册一台，再 grab 它的设备参数入池」。
      所以分发包直接带一台已注册的设备身份，装完即可用，用户什么都不用做。
    设备身份不是账号凭据（不带 token/cookie），同一台设备多人登录互不影响；
    文件缺失或校验失败时自动退回下面的流程。
    """
    try:
        path = os.path.join(os.path.dirname(__file__), 'device-bundled.json')
        data = json.loads(io.open(path, encoding='utf-8').read())
    except Exception:
        return None
    if not (isinstance(data, dict) and data.get('device_id') and data.get('iid')):
        return None
    data.setdefault('registered', True)
    data.setdefault('source', 'bundled')
    return data

def load_device():
    with _device_lock:
        try:
            with open(DEVICE_PATH, encoding='utf-8') as handle:
                device = json.load(handle)
            if device.get('device_id') and device.get('iid'):
                return device
        except (OSError, ValueError, AttributeError):
            pass
        device = _from_bundled()
        if device:
            _write_device(device)
            return device
        return {'registered': False, 'source': 'missing'}

def passport_query():
    """护照请求要带的完整设备参数（内容接口那套精简 query 不够用）。"""
    query = dict(PASSPORT_DEVICE_DEFAULTS)
    query.update(_session_ids())
    return query
SMS_TYPE = os.environ.get('HONGGUO_SMS_TYPE', '24')
MFA_CODES = (2046, 2139, 2148, 4023)
MFA_PATH = os.path.join(_DATA_DIR, 'account-mfa.json')
_mfa_lock = threading.RLock()

def save_mfa(ctx):
    with _mfa_lock:
        try:
            os.makedirs(os.path.dirname(MFA_PATH), exist_ok=True)
            io.open(MFA_PATH, 'w', encoding='utf-8').write(json.dumps(ctx, ensure_ascii=False, indent=1))
        except OSError:
            pass

def load_mfa():
    with _mfa_lock:
        try:
            d = json.loads(io.open(MFA_PATH, encoding='utf-8').read())
            return d if isinstance(d, dict) else {}
        except Exception:
            return {}

def clear_mfa():
    with _mfa_lock:
        try:
            os.remove(MFA_PATH)
        except OSError:
            pass

def _mfa_cookie(response):
    """从 2046 响应里取出安全验证用的 cookie（passport_mfa_token 等）。

    这些 cookie 是「这次挑战」的凭据，validate_code 必须原样带回。
    """
    raw = ''
    try:
        jar = getattr(response, 'cookies', None)
        if jar is not None and len(jar):
            raw = '; '.join(('%s=%s' % (c.name, c.value) for c in jar))
    except Exception:
        raw = ''
    if not raw:
        raw = response.headers.get('set-cookie') or ''
    keep = []
    for part in raw.split(','):
        kv = part.split(';')[0].strip()
        if '=' in kv and any((kv.startswith(n) for n in ('passport_mfa_token', 'd_ticket', 'sid_guard', 'passport_csrf_token'))):
            keep.append(kv)
    return '; '.join(keep)

def _mfa_context(data, cookie=''):
    """从 2046 响应里抽出验证所需上下文（前端要展示验证方式）。"""
    ways = []
    for w in data.get('verify_ways') or []:
        if not isinstance(w, dict):
            continue
        ways.append({'way': str(w.get('verify_way') or ''), 'mobile': str(w.get('mobile') or ''), 'channelMobile': str(w.get('channel_mobile') or ''), 'smsContent': str(w.get('sms_content') or ''), 'name': str(w.get('platform_screen_name') or '')})
    ev = data.get('event_params') if isinstance(data.get('event_params'), dict) else {}
    cp = data.get('common_params') if isinstance(data.get('common_params'), dict) else {}
    biz = data.get('biz_params')
    biz = biz if isinstance(biz, dict) else {}
    sms_key = str(data.get('sms_code_key') or biz.get('sms_code_key') or '')
    return {'mobile': str(data.get('mobile') or ''), 'smsCodeKey': sms_key, 'encryptUid': str(data.get('encrypt_uid') or ''), 'verifyScene': str(ev.get('verify_scene') or data.get('passport_scene') or ''), 'verifyReason': str(ev.get('verify_reason') or ''), 'verifyWays': ways, 'bizParams': biz, 'schema': str(data.get('schema') or ''), 'url': str(data.get('url') or ''), 'desc': str(cp.get('copywriting') or '')[:600], 'cookie': cookie, 'at': int(time.time())}
_lock = threading.RLock()
_cache = None
_cache_mtime = 0.0
LOG_PATH = os.path.join(_DATA_DIR, 'account-events.jsonl')
LOG_MAX_BYTES = 512 * 1024

def mask_mobile(value):
    text = re.sub('\\D', '', str(value or ''))
    if len(text) < 7:
        return '***'
    return text[:3] + '****' + text[-4:]

def log_event(event, **fields):
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        try:
            if os.path.getsize(LOG_PATH) > LOG_MAX_BYTES:
                os.replace(LOG_PATH, LOG_PATH + '.1')
        except OSError:
            pass
        record = {'t': int(time.time() * 1000), 'event': event}
        record.update(fields)
        with io.open(LOG_PATH, 'a', encoding='utf-8') as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + '\n')
    except OSError:
        pass

def read_log(limit=50):
    items = []
    try:
        for line in io.open(LOG_PATH, encoding='utf-8'):
            line = line.strip()
            if not line:
                continue
            try:
                items.append(json.loads(line))
            except ValueError:
                continue
    except OSError:
        return []
    return items[-int(limit):]

def xor_hex(text):
    """红果 passport 的字段编码：UTF-8 字节逐字节异或 0x05，再转小写 hex。"""
    return bytes((b ^ 5 for b in str(text).encode('utf-8'))).hex()

def normalize_mobile(mobile):
    """国内手机号规范化为带区号与分段空格的请求格式；示例：+86138 0000 0000。"""
    digits = re.sub('\\D', '', str(mobile or ''))
    if len(digits) == 13 and digits.startswith('86'):
        digits = digits[2:]
    if len(digits) == 11 and digits.startswith('1'):
        return '+86' + digits[:3] + ' ' + digits[3:7] + ' ' + digits[7:11]
    return '+86' + digits if digits else ''

def xor_unhex(value):
    try:
        return bytes((b ^ 5 for b in bytes.fromhex(value))).decode('utf-8')
    except Exception:
        return ''

def _gzip_body(payload):
    raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode='wb', compresslevel=6, mtime=0) as gz:
        gz.write(raw)
    return buf.getvalue()

def _session_mtime():
    try:
        return os.path.getmtime(SESSION_PATH)
    except OSError:
        return 0.0

def load_session():
    """读登录态。

    带 mtime 失效检查：会话文件同时也被开发脚本/其它工具改写
    （安装目录里就有直接 copy 覆盖它的脚本），
    而 _cache 是模块级全局且原先只看一次文件 ——
    外部改写后运行中的后端仍返回旧值，两边会互相覆盖。
    这里只要文件比缓存新就重读。
    """
    global _cache, _cache_mtime
    with _lock:
        stamp = _session_mtime()
        if _cache is not None and stamp == _cache_mtime:
            return _cache
        data = {}
        try:
            if os.path.isfile(SESSION_PATH):
                data = json.loads(io.open(SESSION_PATH, encoding='utf-8').read())
        except Exception:
            data = {}
        if not isinstance(data, dict):
            data = {}
        _cache = data
        _cache_mtime = stamp
        return _cache

def save_session(data):
    global _cache, _cache_mtime
    with _lock:
        _cache = data or {}
        try:
            os.makedirs(os.path.dirname(SESSION_PATH), exist_ok=True)
            tmp = SESSION_PATH + '.tmp'
            io.open(tmp, 'w', encoding='utf-8').write(json.dumps(_cache, ensure_ascii=False, indent=2))
            os.replace(tmp, SESSION_PATH)
        except OSError:
            pass
        _cache_mtime = _session_mtime()
    return _cache
BACKUP_TTL = 7 * 24 * 3600

def clear_session():
    clear_mfa()
    return save_session({})

def is_logged_in():
    s = load_session()
    return bool(s.get('cookie') or s.get('token'))

def _session_identity(session):
    """缓存和在途请求按登录态隔离；同一账号重新登录也会使旧请求失效。"""
    data = [str((session or {}).get(key) or '') for key in ('uid', 'token', 'cookie')]
    return hashlib.sha256(json.dumps(data).encode('utf-8')).hexdigest()

def _account_changed(session):
    return _session_identity(session) != _session_identity(load_session())

def _headers(session=None, extra=None):
    headers = dict(H.CFG.get('session_headers') or {})
    session = session if session is not None else load_session()
    token = (session or {}).get('token')
    cookie = (session or {}).get('cookie')
    if token:
        headers['x-tt-token'] = token
    if cookie:
        headers['cookie'] = cookie
    headers['content-type'] = 'application/json; charset=utf-8'
    if extra:
        headers.update(extra)
    return headers

def _call(method, path, body=None, extra=None, session=None, host=None, form=None, passport=False, cookie_extra=''):
    """发一个带签名的红果请求。body/form 二选一。

    passport=True 时用完整设备参数（登录接口校验设备指纹，精简 query 会被风控）。

    cookie_extra：额外并入 Cookie 头的键值（形如 "a=1; b=2"）。
    安全验证必须用它 —— 2046 下发的 passport_mfa_token 要靠它带回给
    validate_code；而 _headers() 在「本机已有登录账号」时会用账号 cookie
    覆盖整个 Cookie 头，把挑战 cookie 冲掉，导致 validate_code 报
    1203/1204（看着像验证码错了，其实是凭据断了）。
    """
    if passport:
        merged = dict(passport_query())
        if extra:
            merged.update(extra)
        url = H.build_url(path, merged)
    else:
        url = H.build_url(path, extra)
    if host:
        url = re.sub('^https://[^/]+', 'https://' + host, url)
    headers = _headers(session)
    data = None
    if form is not None:
        data = form.encode('utf-8')
        headers['content-type'] = 'application/x-www-form-urlencoded'
    elif body is not None:
        data = _gzip_body(body)
        headers['content-encoding'] = 'gzip'
        headers['x-ss-stub'] = hashlib.md5(data).hexdigest().upper()
    if passport:
        for stale in ('x-tt-store-region', 'x-tt-store-region-src'):
            headers.pop(stale, None)
        headers['user-agent'] = PASSPORT_UA
        headers['lc'] = '101'
        headers['x-vc-bdturing-sdk-version'] = '4.0.3.cn'
        headers['x-ss-req-ticket'] = str(int(time.time() * 1000))
        headers['x-ss-stub'] = hashlib.md5(data or b'').hexdigest().upper()
        csrf = ''
        cookie_text = headers.get('cookie') or ''
        m = re.search('passport_csrf_token=([^;]+)', cookie_text)
        if m:
            csrf = m.group(1)
        if csrf:
            headers['x-tt-passport-csrf-token'] = csrf
    if cookie_extra:
        base = headers.get('cookie') or ''
        headers['cookie'] = (base + '; ' + cookie_extra).strip('; ') if base else cookie_extra
    _t_sign0 = time.perf_counter()
    headers.update(H.sign(url, headers, data))
    _t_sign = time.perf_counter()
    headers.pop('accept-encoding', None)
    if passport:
        for stale in ('x-neptune', 'x-soter', 'X-Neptune', 'X-Soter'):
            headers.pop(stale, None)
    r = H.http_request(method, url, data=data, headers=headers, timeout=30)
    if os.environ.get('HONGGUO_ACCOUNT_TIMING'):
        _t_end = time.perf_counter()
        log_event('timing', path=re.sub('\\?.*$', '', path), sign_ms=round((_t_sign - _t_sign0) * 1000, 1), http_ms=round((_t_end - _t_sign) * 1000, 1), total_ms=round((_t_end - _t_sign0) * 1000, 1), status=getattr(r, 'status_code', 0))
    return r

def _json(response):
    try:
        return response.json()
    except ValueError:
        return {'code': -1, 'message': '非 JSON 响应', 'raw': response.text[:300]}
DEVICE_HINT = '本机缺少随包携带的设备身份文件（device-bundled.json），服务端因此拒绝了这次请求。请重新安装一次安装包（安装程序会把它放回 %s 目录）；若仍不行，请把这个问题反馈给提供安装包的人。'

def device_issue():
    """返回 (是否有问题, 提示)。设备身份没拿到时给出可操作的说明。"""
    try:
        dev = load_device()
    except Exception:
        return (True, DEVICE_HINT % _DATA_DIR)
    if not dev.get('device_id') or not dev.get('iid'):
        return (True, DEVICE_HINT % _DATA_DIR)
    if not dev.get('registered'):
        return (True, DEVICE_HINT % _DATA_DIR)
    return (False, '')

def _passport_form_params(mobile=None, code=None, with_device=False):
    """构造护照表单，返回**有序 dict**（键值未编码）。

    与 _passport_form 的唯一区别：不在这里做 URL 编码、也不拼成字符串。
    重放 sms_login 时需要「把 biz_params 合并进来、biz 覆盖同名键」，
    直接拼两段编码串会产生重复键（wire 上同一个 key 出现两次），
    所以先出 dict，合并后再统一编码一次。
    """
    params = {}
    if mobile:
        params['mobile'] = xor_hex(mobile)
    if code:
        params['code'] = xor_hex(code)
    params['account_sdk_source'] = 'app'
    params['passport_support_flow'] = 'captcha,verify'
    params['mix_mode'] = '1'
    if with_device:
        for key, value in passport_query().items():
            if key in PASSPORT_BODY_FIELDS:
                params[key] = str(value)
    return params

def _passport_form(mobile=None, code=None, with_device=False):
    """构造护照表单（URL 编码后的字符串）。

    with_device=True 时把设备参数也编进请求体 —— 真机就是这么发的
    （sms_login 请求体 55 个字段，设备字段和业务字段在同一个表单里）。
    只放 URL query 不生效：服务端校验的是请求体。
    """
    from urllib.parse import quote
    params = _passport_form_params(mobile=mobile, code=code, with_device=with_device)
    return '&'.join(('%s=%s' % (k, quote(str(v), safe='')) for k, v in params.items()))

def _passport_result(body):
    """passport 的响应形状与内容接口不同：
    成功是 {"message":"success","data":{...}}；
    失败是 {"message":"error","data":{"error_code":N,"description":"..."}}。
    """
    if not isinstance(body, dict):
        return (False, '响应格式异常', None)
    data = body.get('data')
    if isinstance(data, dict) and data.get('error_code'):
        return (False, str(data.get('description') or '请求被拒绝'), data.get('error_code'))
    message = str(body.get('message') or '').lower()
    if message == 'success' or body.get('code') in (0, '0'):
        return (True, '', None)
    return (False, str(body.get('message') or '请求失败'), None)

def send_code(mobile):
    mobile = re.sub('\\D', '', str(mobile or ''))
    if not re.fullmatch('1\\d{10}', mobile):
        return {'ok': False, 'error': '手机号格式不正确'}
    bad, hint = device_issue()
    if bad:
        log_event('send_code', ok=False, reason='device_unregistered', mobile=mask_mobile(mobile))
        return {'ok': False, 'error': hint, 'error_code': 'device'}
    form = _passport_form(mobile=normalize_mobile(mobile), with_device=True) + '&type=' + xor_hex(SMS_TYPE) + '&unbind_exist=' + xor_hex('1') + '&auto_read=0'
    r = _call('POST', '/passport/mobile/send_code/v1/', form=form, host=PASSPORT_HOST, passport=True)
    j = _json(r)
    ok, why, err_code = _passport_result(j)
    data = j.get('data') if isinstance(j.get('data'), dict) else {}
    if not ok and r.status_code in (401, 403) and (not r.text.strip()):
        why, err_code = (hint, 'device')
    log_event('send_code', host=PASSPORT_HOST, http=r.status_code, ok=ok, mobile=mask_mobile(mobile), type=SMS_TYPE, error_code=err_code, message=str(j.get('message'))[:80], description=str(data.get('description') or why)[:120], has_ticket=bool(data.get('mobile_ticket')), retry_time=data.get('retry_time'))
    return {'ok': ok, 'code': j.get('code'), 'message': j.get('message'), 'error': '' if ok else why, 'error_code': err_code, 'hasTicket': bool(data.get('mobile_ticket')), 'retryTime': data.get('retry_time'), 'data': j.get('data'), 'http': r.status_code}

def _extract_session(response, session):
    """从登录响应里取出 token / cookie。"""
    cookie = ''
    try:
        jar = getattr(response, 'cookies', None)
        if jar is not None and len(jar):
            cookie = '; '.join(('%s=%s' % (c.name, c.value) for c in jar))
    except Exception:
        cookie = ''
    if not cookie:
        raw = response.headers.get('set-cookie') or ''
        if raw:
            cookie = re.sub(';\\s*(Path|Domain|Expires|Max-Age|Secure|HttpOnly|SameSite)[^;]*', '', raw, flags=re.I)
    if not cookie:
        cookie = (session or {}).get('cookie') or ''
    try:
        body = response.json()
    except ValueError:
        body = {}
    data = body.get('data') if isinstance(body, dict) else None
    token = ''
    if isinstance(data, dict):
        for key in ('token', 'session_key', 'x_tt_token', 'x-tt-token'):
            if data.get(key):
                token = str(data[key])
                break
    if not token:
        token = (session or {}).get('token') or ''
    user = ''
    uid = ''
    if isinstance(data, dict):
        user = str(data.get('user_name') or data.get('name') or '')
        uid = str(data.get('user_id') or data.get('uid') or data.get('user_id_str') or '')
    return {'token': token, 'cookie': cookie, 'user_name': user, 'uid': uid}

def _finish_login(r, mobile):
    """登录响应有效时的收尾：存会话 + 拉账号信息。"""
    session = _extract_session(r, {})
    session['saved_at'] = int(time.time())
    session['mobile'] = mobile
    save_session(session)
    log_event('sms_login_ok', host=PASSPORT_HOST, http=r.status_code, mobile=mask_mobile(mobile), has_cookie=bool(session.get('cookie')))
    info = _json(_call('GET', '/reading/user/info/v', session=session))
    if isinstance(info.get('data'), dict):
        session['user_name'] = info['data'].get('user_name') or session.get('user_name') or ''
        session['uid'] = str(info['data'].get('user_id') or session.get('uid') or '')
        save_session(session)
    clear_mfa()
    return {'ok': True, 'code': 0, 'session': public_session(session)}

def verify_mfa(mobile, code=''):
    """完成安全验证（2046 之后那一步）。

    2026-10-08 反编译 com.bytedance.sdk.account 得到**完整**机制（不再是猜的）：

      H5 验证页 → bridge `account.setVerifyStatus{status:0, verifyWay, verifyTicket}`
        → bi1/b.java：hashMap = 2046 响应的 data.biz_params
        → ai1/c.java：原请求 mix_mode==1 时，把 sms_code_key 用
                      StringUtils.encryptWithXor 再编码一次（XOR 0x05 → 小写 hex）
        → com/bytedance/sdk/account/impl/w.java：
              把 hashMap **合并进原始 sms_login 的请求参数**，然后 x.k()
              —— 即**原样重发那个 sms_login 请求**
        → 这次服务端放行，登录成功

    关键结论：**完成验证靠的是「重发 sms_login + biz_params」，不是把
    verify_ticket 传给登录接口**。verifyTicket 虽然进了 ai1/c.a() 的参数表，
    但方法体里**根本没用到**；真正起作用的是 biz_params 里的 sms_code_key。

    而 /passport/upsms/verify/ 只负责「服务端收到你的上行短信了吗」这一件事
    （轮询），它的 ticket 我们不依赖。

    参数 code：重发 sms_login 必须带**同一条**短信验证码，所以要传。
    """
    mobile = re.sub('\\D', '', str(mobile or ''))
    if not re.fullmatch('1\\d{10}', mobile):
        return {'ok': False, 'error': '手机号格式不正确'}
    code = re.sub('\\D', '', str(code or ''))
    if not re.fullmatch('\\d{4,8}', code):
        return {'ok': False, 'error': '验证码格式不正确'}
    if not _mfa_lock.acquire(blocking=False):
        log_event('verify_mfa_busy', mobile=mask_mobile(mobile))
        return {'ok': False, 'pending': True, 'error_code': 'busy', 'error': '上一次验证还在进行中，请稍候'}
    try:
        return _verify_mfa_run(mobile, code)
    finally:
        _mfa_lock.release()

def _verify_mfa_run(mobile, code):
    ctx = load_mfa()
    if not ctx:
        return {'ok': False, 'error': '没有待完成的验证，请先点「发送验证码」'}
    ways = [w.get('way') for w in ctx.get('verifyWays') or []]
    if ways and 'mobile_up_sms_verify' not in ways:
        return {'ok': False, 'error': '该账号要求的是「%s」验证，暂不支持' % '、'.join(ways)}
    from urllib.parse import quote
    parts = [('mobile', normalize_mobile(mobile))]
    for key, src in (('sms_code_key', 'smsCodeKey'), ('encrypt_uid', 'encryptUid'), ('verify_scene', 'verifyScene'), ('verify_reason', 'verifyReason')):
        val = ctx.get(src)
        if val:
            parts.append((key, val))
    body = '&'.join(('%s=%s' % (k, quote(str(v), safe='')) for k, v in parts))
    form = _passport_form(mobile=normalize_mobile(mobile), with_device=True) + '&' + body
    r = _call('POST', '/passport/upsms/verify/', form=form, host=PASSPORT_HOST, passport=True, cookie_extra=str(ctx.get('cookie') or ''))
    j = _json(r)
    data = j.get('data') if isinstance(j.get('data'), dict) else {}
    up_ok = bool(data.get('ticket') or data.get('verify_ticket'))
    if not up_ok:
        _ok, why, err_code = _passport_result(j)
        log_event('verify_mfa_pending', host=PASSPORT_HOST, http=r.status_code, mobile=mask_mobile(mobile), error_code=err_code, description=str(data.get('description') or why)[:120])
        return {'ok': False, 'error': str(data.get('description') or why or '还没收到你的上行短信'), 'error_code': err_code, 'http': r.status_code, 'pending': True}
    log_event('verify_mfa_upsms_ok', host=PASSPORT_HOST, http=r.status_code, mobile=mask_mobile(mobile))
    biz = ctx.get('bizParams') if isinstance(ctx.get('bizParams'), dict) else {}
    if not biz:
        log_event('verify_mfa_no_biz', mobile=mask_mobile(mobile))
        return {'ok': False, 'pending': True, 'error_code': 'no_biz', 'error': '验证上下文已过期，请返回重新发送验证码'}
    merged = _passport_form_params(mobile=normalize_mobile(mobile), code=code, with_device=True)
    for k, v in biz.items():
        merged[str(k)] = xor_hex(v) if k == 'sms_code_key' else str(v)
    form2 = '&'.join(('%s=%s' % (k, quote(str(v), safe='')) for k, v in merged.items()))
    r2 = _call('POST', '/passport/mobile/sms_login/', form=form2, host=PASSPORT_HOST, passport=True, cookie_extra=str(ctx.get('cookie') or ''))
    j2 = _json(r2)
    ok2, why2, err2 = _passport_result(j2)
    d2 = j2.get('data') if isinstance(j2.get('data'), dict) else {}
    if not ok2:
        log_event('verify_mfa_replay_failed', host=PASSPORT_HOST, http=r2.status_code, mobile=mask_mobile(mobile), error_code=err2, description=str(d2.get('description') or why2)[:120])
        if err2 in MFA_CODES:
            ctx2 = _mfa_context(d2, _mfa_cookie(r2))
            if ctx2.get('schema') or ctx2.get('verifyWays') or ctx2.get('bizParams'):
                save_mfa(ctx2)
                log_event('verify_mfa_rechallenge', mobile=mask_mobile(mobile), error_code=err2)
        return {'ok': False, 'error': str(d2.get('description') or why2 or '验证后登录未通过'), 'error_code': err2, 'http': r2.status_code, 'pending': err2 in MFA_CODES}
    log_event('verify_mfa_ok', host=PASSPORT_HOST, http=r2.status_code, mobile=mask_mobile(mobile), replayed=True)
    out = _finish_login(r2, mobile)
    out['replayed'] = True
    return out

def sms_login(mobile, code, ticket=''):
    """验证码登录。

    ticket 参数保留只为兼容旧调用方，**实际不再使用**：
    2026-10-08 反编译确认，完成 MFA 靠的是「重发 sms_login + biz_params」，
    verify_ticket 进了 ai1/c.a() 的参数表但方法体从未引用它 ——
    把它塞进登录请求是无效的（实测一直是 1203）。
    """
    mobile = re.sub('\\D', '', str(mobile or ''))
    code = re.sub('\\D', '', str(code or ''))
    if not re.fullmatch('1\\d{10}', mobile):
        return {'ok': False, 'error': '手机号格式不正确'}
    if not re.fullmatch('\\d{4,8}', code):
        return {'ok': False, 'error': '验证码格式不正确'}
    bad, hint = device_issue()
    if bad:
        log_event('sms_login_failed', ok=False, reason='device_unregistered', mobile=mask_mobile(mobile))
        return {'ok': False, 'error': hint, 'error_code': 'device'}
    form = _passport_form(mobile=normalize_mobile(mobile), code=code, with_device=True)
    if ticket:
        log_event('sms_login_ticket_ignored', mobile=mask_mobile(mobile))
    r = _call('POST', '/passport/mobile/sms_login/', form=form, host=PASSPORT_HOST, passport=True)
    j = _json(r)
    ok, why, err_code = _passport_result(j)
    data = j.get('data') if isinstance(j.get('data'), dict) else {}
    if not ok and r.status_code in (401, 403) and (not r.text.strip()):
        why, err_code = (hint, 'device')
    if not ok and err_code in MFA_CODES:
        ctx = _mfa_context(data, _mfa_cookie(r))
        if ctx.get('verifyWays') or ctx.get('smsCodeKey') or (ctx.get('schema') and ctx.get('url')) or ctx.get('bizParams'):
            save_mfa(ctx)
            log_event('sms_login_mfa', host=PASSPORT_HOST, http=r.status_code, mobile=mask_mobile(mobile), ways=len(ctx['verifyWays']), has_key=bool(ctx['smsCodeKey']))
            return {'ok': False, 'mfaRequired': True, 'mfa': ctx, 'error': '该账号需要先完成身份验证', 'error_code': err_code}
    if not ok:
        log_event('sms_login_failed', host=PASSPORT_HOST, http=r.status_code, mobile=mask_mobile(mobile), code_len=len(code), error_code=err_code, message=str(j.get('message'))[:80], description=str(data.get('description') or why)[:120])
        return {'ok': False, 'code': err_code if err_code is not None else j.get('code'), 'error': why or '登录失败', 'error_code': err_code, 'http': r.status_code}
    return _finish_login(r, mobile)

def _mask_uid(value):
    """将完整账号 UID 转为稳定的短哈希，用于换号隔离；不向界面返回原始账号 UID。"""
    text = str(value or '')
    if not text:
        return ''
    return 'u' + hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]

def public_session(session=None):
    s = session if session is not None else load_session()
    bad, hint = device_issue()
    return {'loggedIn': bool(s.get('cookie') or s.get('token')), 'userName': s.get('user_name') or '', 'uid': _mask_uid(s.get('uid')), 'mobile': (s.get('mobile') or '')[:3] + '****' + (s.get('mobile') or '')[-4:] if s.get('mobile') else '', 'savedAt': s.get('saved_at') or 0, 'deviceReady': not bad, 'deviceHint': hint}
_REPORT_COOLDOWN_UNTIL = 0.0
_REPORT_COOLDOWN_LOCK = threading.Lock()

def _set_report_cooldown(message, default=90):
    """按服务端返回的封禁时长设置冷却。"""
    global _REPORT_COOLDOWN_UNTIL
    secs = default
    try:
        m = re.search('"min_ban_time"\\s*:\\s*(\\d+)', str(message or ''))
        if m:
            secs = max(30, min(int(m.group(1)), 600))
    except Exception:
        pass
    with _REPORT_COOLDOWN_LOCK:
        _REPORT_COOLDOWN_UNTIL = max(_REPORT_COOLDOWN_UNTIL, time.time() + secs)
    log_event('progress_cooldown', seconds=secs)

def _report_cooling():
    with _REPORT_COOLDOWN_LOCK:
        return time.time() < _REPORT_COOLDOWN_UNTIL

def sync_progress(series_id, episode, total=0, position=0, duration=0, series=None, explicit=False, session=None):
    """把桌面端的观看进度上报到账号（手机“历史”页立即可见）。

    合并规则：同一剧集「取更靠前的进度」，不允许把云端进度改小。
    否则会出现：手机看到 520 集，PC 本地停在 500 集，PC 一上报就把 520 覆盖成 500。
    所以上报前先读云端，只有本地确实更靠前时才写。

    explicit=True 表示「这是用户此刻正在看的那一集」（播放时的实时上报）。
    2026-10-09 修：用户回看更早的集数（看到 605 再回去看 604）时，
    上面的「取更靠前」保护会把 604 判成 cloud_ahead 直接跳过，
    于是本地记录永远停在 605 —— 用户明确点开哪一集，意图就该优先。
    后台批量补齐（push_local_history）**不带** explicit，继续受保护。
    """
    session = dict(load_session() if session is None else session)
    if _account_changed(session):
        return {'ok': False, 'skipped': True, 'error_code': 'account_changed', 'error': '账号已切换，已取消旧账号的进度同步'}
    if not (session.get('cookie') or session.get('token')):
        return {'ok': False, 'error': '未登录红果账号'}
    if _report_cooling():
        return {'ok': False, 'skipped': True, 'error_code': 'report_cooling', 'error': '上报过于频繁，正在冷却，稍后自动恢复'}
    series_id = str(series_id)
    if not re.fullmatch('[0-9]{8,24}', series_id):
        return {'ok': False, 'error': '剧集标识不合法'}
    episode = int(episode)
    if not 1 <= episode <= 100000:
        return {'ok': False, 'error': '集号不合法'}
    try:
        cloud = remote_progress(series_id)
    except Exception as e:
        log_event('progress_read_failed', series_id=series_id, error=type(e).__name__)
        return {'ok': False, 'skipped': True, 'error_code': 'cloud_read_failed', 'error': '暂时读不到云端进度，已跳过本次上报（避免把进度改小）'}
    if _account_changed(session):
        return {'ok': False, 'skipped': True, 'error_code': 'account_changed', 'error': '账号已切换，已取消旧账号的进度同步'}
    if cloud.get('ok'):
        cloud_ep = int(cloud.get('episode') or 0)
        cloud_pos = int(cloud.get('position') or 0)
        if explicit:
            log_event('progress_explicit', series_id=series_id, cloud_episode=cloud_ep, local_episode=episode, direction='down' if cloud_ep > episode else 'up')
        elif cloud_ep > episode:
            log_event('progress_skipped', reason='cloud_ahead', cloud_episode=cloud_ep, local_episode=episode)
            return {'ok': True, 'skipped': True, 'episode': cloud_ep, 'reason': '云端进度更靠前，保持不变'}
        elif cloud_ep == episode and cloud_pos > int(max(0, position)):
            log_event('progress_skipped', reason='cloud_position_ahead', cloud_episode=cloud_ep, local_position=int(max(0, position)))
            return {'ok': True, 'skipped': True, 'episode': cloud_ep, 'reason': '云端播放位置更靠前，保持不变'}
    elif cloud.get('reason') != 'absent':
        log_event('progress_skipped', reason='cloud_unreadable', series_id=series_id, detail=str(cloud.get('error') or '')[:120])
        return {'ok': False, 'skipped': True, 'error_code': 'cloud_read_failed', 'error': '暂时读不到云端进度，已跳过本次上报（避免把进度改小）'}
    vid = ''
    try:
        _, episodes = H.get_episodes(series_id)
        target = next((it for it in episodes if int(it.get('index') or 0) == episode), None)
        if target:
            vid = str(target.get('vid') or '')
    except Exception:
        vid = ''
    now = int(time.time() * 1000)
    item = {'book_id': int(series_id), 'book_id_str': series_id, 'book_type': 2, 'vid_index': episode, 'chapter_index': episode, 'read_timestamp_ms': now, 'update_timestamp_ms': 0, 'current_play_position': int(max(0, position)), 'player_accumulate_total_time': int(max(0, position)), 'duration': int(max(0, duration)), 'episode_cnt': int(max(0, total)), 'is_delete': False, 'use_soft_delete': False, 'genre_type': 2150}
    if vid and re.fullmatch('\\d{8,24}', vid):
        item['vid'] = int(vid)
    if series and isinstance(series, dict):
        if series.get('title'):
            item['book_name'] = str(series['title'])[:120]
        if series.get('cover'):
            item['thumb_url'] = str(series['cover'])[:400]
    if _account_changed(session):
        return {'ok': False, 'skipped': True, 'error_code': 'account_changed', 'error': '账号已切换，已取消旧账号的进度同步'}
    r = _call('POST', '/reading/bookapi/read_history/update/v', body={'update_datas': [item]}, session=session)
    j = _json(r)
    if j.get('code') not in (0, '0'):
        code = j.get('code')
        log_event('progress_failed', series_id=series_id, episode=episode, code=code, message=str(j.get('message'))[:80])
        if code in (100, '100'):
            _set_report_cooldown(j.get('message'))
        return {'ok': False, 'code': code, 'error': j.get('message') or '上报失败'}
    fails = (j.get('data') or {}).get('update_fail_datas') or [] if isinstance(j.get('data'), dict) else []
    log_event('progress_ok', series_id=series_id, episode=episode, position=int(max(0, position)), total=int(max(0, total)), has_vid=bool(vid), failed=len(fails))
    return {'ok': not fails, 'code': 0, 'episode': episode, 'failed': len(fails)}

def _history_raw(limit=30):
    """读一次云端历史原始列表（内部用）。"""
    r = _call('GET', '/reading/bookapi/read_history/list/v', extra={'book_type': '2', 'offset': '0', 'limit': str(int(limit)), 'query_soft_deleted': 'false', 'is_first_load': 'false', 'last_min_read_timestamp_ms': '0', 'full_field': 'false'})
    return _json(r)
_HISTORY_PAGE = 200
_HISTORY_PAGE_MAX = 20

def _history_all(max_items=4000, session=None):
    """翻页取云端历史，返回 (items, total, ok, error)。

    只在**需要看全量**的场合用（例如查某部剧的云端进度 —— 只读第一页的话，
    排在后面的剧会被当成「云端没有」，progress 判成 0，
    合并逻辑随后可能用本地较低的进度把它覆盖掉。实测 574 条里有 77 条
    落在第一页之外）。

    注意：翻页 = 多一次往返（实测单次 3.4 秒），
    给界面用的列表**不要**走这里，用 _history_page()。

    2026-10-09 修：默认 max_items 从 2000 提到 4000，与 _HISTORY_PAGE_MAX
    声明的上限（20 页 × 200 条）对齐。原先默认 2000 让「取全量」实际只取
    到一半，而调用方 remote_progress 依赖「翻遍全量」来判断某剧是否存在——
    历史超过 2000 条的账号上，排在第 2001 位之后的剧会被误判成
    「云端没有」，合并逻辑随即用本地较低进度覆盖云端。取到 total 后会
    在下面回传 truncated 标记，让调用方能区分「确实没有」和「没翻完」。
    """
    session = dict(load_session() if session is None else session)
    items = []
    seen = set()
    total = 0
    hit_cap = False
    last = {'ok': False, 'error': ''}
    for page in range(_HISTORY_PAGE_MAX):
        offset = page * _HISTORY_PAGE
        try:
            r = _call('GET', '/reading/bookapi/read_history/list/v', extra={'book_type': '2', 'offset': str(offset), 'limit': str(_HISTORY_PAGE), 'query_soft_deleted': 'false', 'is_first_load': 'false', 'last_min_read_timestamp_ms': '0', 'full_field': 'false'}, session=session)
            j = _json(r)
        except Exception as exc:
            last = {'ok': False, 'error': '%s' % type(exc).__name__}
            break
        if j.get('code') not in (0, '0'):
            last = {'ok': False, 'code': j.get('code'), 'error': j.get('message') or '读取失败'}
            break
        data = j.get('data') or {}
        total = int(data.get('total') or 0) or total
        chunk = data.get('data_list') or []
        if not chunk:
            last = {'ok': True, 'error': ''}
            break
        fresh = 0
        for it in chunk:
            key = str(it.get('book_id_str') or it.get('book_id') or '')
            if key and key in seen:
                continue
            if key:
                seen.add(key)
            items.append(it)
            fresh += 1
            if len(items) >= max_items:
                hit_cap = True
                break
        last = {'ok': True, 'error': ''}
        if fresh == 0 or len(items) >= max_items:
            break
    last['truncated'] = bool(hit_cap and total and (len(items) < total))
    if last['truncated']:
        log_event('history_truncated', got=len(items), total=total)
    return (items, total, last['ok'], last.get('error', ''), last['truncated'])
_HIST_CACHE_TTL = 60
_HIST_FAILURE_CACHE_TTL = 3
_hist_cache = {'at': 0.0, 'uid': '', 'identity': '', 'value': None}
_hist_cache_lock = threading.Lock()

def _history_all_cached(force=False):
    """带 TTL 的 _history_all（返回同样的 5 元组）。

    只在「读云端判进度」这类高频路径上用；用户显式点刷新时传 force=True
    绕过缓存，保证刷新看到的是实时数据。
    """
    started = time.time()
    with _hist_cache_lock:
        session = dict(load_session() or {})
        uid = session.get('uid') or ''
        identity = _session_identity(session)
        now = time.time()
        c = _hist_cache
        ttl = _HIST_CACHE_TTL if c['value'] and c['value'][2] else _HIST_FAILURE_CACHE_TTL
        if c['value'] is not None and c.get('identity') == identity and (now - c['at'] < ttl) and (not force or c['at'] > started):
            return c['value']
        value = _history_all(session=session)
        if _account_changed(session):
            return ([], 0, False, '账号已切换，请重新同步', False)
        c.update(at=time.time(), uid=uid, identity=identity, value=value)
        return value

def _history_page(limit=200):
    """只取第一页（服务端已按「最近观看」降序返回）。

    给界面列表用：一次往返即可，且最新的条目一定在第一页。
    翻页留给 remote_progress 那种「必须确认某条在不在」的场合。
    """
    try:
        r = _call('GET', '/reading/bookapi/read_history/list/v', extra={'book_type': '2', 'offset': '0', 'limit': str(int(limit)), 'query_soft_deleted': 'false', 'is_first_load': 'false', 'last_min_read_timestamp_ms': '0', 'full_field': 'false'})
        j = _json(r)
    except Exception as exc:
        return ([], 0, False, '%s' % type(exc).__name__)
    if j.get('code') not in (0, '0'):
        return ([], 0, False, j.get('message') or '读取失败')
    data = j.get('data') or {}
    return (data.get('data_list') or [], int(data.get('total') or 0), True, '')

def remote_progress(series_id, force=False):
    """查单部剧在云端的进度（用于「取最新」合并，避免把进度改小）。

    必须翻页找：只读第一页的话，排在后面的剧会被误判成「云端 0 集」，
    合并逻辑随后就可能用本地较低的进度把它覆盖掉。

    force=True 时绕过 _history_all 的短期缓存（用户显式点刷新走这条）。
    """
    if not is_logged_in():
        return {'ok': False, 'error': '未登录红果账号'}
    series_id = str(series_id)
    if not re.fullmatch('[0-9]{8,24}', series_id):
        return {'ok': False, 'error': '剧集标识不合法'}
    items, _total, ok, error, truncated = _history_all_cached(force=force)
    if not ok:
        return {'ok': False, 'error': error or '读取失败', 'reason': 'read_failed'}
    for it in items:
        if str(it.get('book_id_str') or it.get('book_id') or '') == series_id:
            return {'ok': True, 'episode': int(it.get('vid_index') or it.get('chapter_index') or 0), 'position': int(it.get('current_play_position') or 0), 'updatedAt': int(it.get('read_timestamp_ms') or 0)}
    if truncated:
        return {'ok': False, 'reason': 'read_failed', 'error': '云端历史过多，未能完整翻页'}
    return {'ok': True, 'episode': 0, 'position': 0, 'updatedAt': 0, 'reason': 'absent'}

def remote_history(limit=30):
    if not is_logged_in():
        return {'ok': False, 'error': '未登录红果账号'}
    raw, total, ok, error = _history_page(limit=max(1, int(limit)))
    if not ok:
        return {'ok': False, 'error': error or '读取失败'}
    want = max(1, int(limit))
    if len(raw) > want:
        raw = raw[:want]
    items = []
    for it in raw:
        items.append({'seriesId': str(it.get('book_id_str') or it.get('book_id') or ''), 'title': it.get('book_name') or '', 'cover': it.get('thumb_url') or '', 'episode': int(it.get('vid_index') or it.get('chapter_index') or 1), 'position': int(it.get('current_play_position') or 0), 'total': int(it.get('episode_cnt') or 0), 'updatedAt': int(it.get('read_timestamp_ms') or 0)})
    return {'ok': True, 'total': total or len(items), 'returned': len(items), 'items': items}


def remote_history_page(offset=0, limit=100, session=None):
    """One real upstream page; limit is a request hint, never a retained-record cap."""
    session = dict(load_session() if session is None else session)
    if not (session.get('cookie') or session.get('token')):
        return {'ok': False, 'error': '未登录红果账号'}
    if (isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset <= 1000000
            or isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 500):
        return {'ok': False, 'error': '历史页码不正确'}
    try:
        response = _call('GET', '/reading/bookapi/read_history/list/v', extra={
            'book_type': '2', 'offset': str(offset), 'limit': str(limit),
            'query_soft_deleted': 'false', 'is_first_load': 'false',
            'last_min_read_timestamp_ms': '0', 'full_field': 'false'}, session=session)
        value = _json(response)
    except Exception:
        return {'ok': False, 'error': '云端历史暂时无法读取'}
    if _account_changed(session):
        return {'ok': False, 'accountChanged': True, 'error': '账号已切换'}
    if value.get('code') not in (0, '0') or not isinstance(value.get('data'), dict):
        return {'ok': False, 'error': '云端历史暂时无法读取'}
    data = value['data']
    raw = data.get('data_list') or []
    if not isinstance(raw, list):
        return {'ok': False, 'error': '云端历史格式不正确'}
    try:
        total = max(0, int(data.get('total') or 0))
    except (TypeError, ValueError, OverflowError):
        total = 0
    # Some server versions ignore limit and return ~500 rows. Return all of them
    # and advance by all consumed raw rows; slicing here would silently lose history.
    next_offset = offset + len(raw)
    more = bool(raw) and (next_offset < total if total else len(raw) >= limit)
    if 'has_more' in data:
        more = bool(raw) and data['has_more'] in (True, 1, '1', 'true')
    fingerprint = hashlib.sha256('\n'.join(str(row.get('book_id_str') or row.get('book_id') or '')
        if isinstance(row, dict) else '' for row in raw).encode('utf-8')).hexdigest()
    return {'ok': True, 'items': raw, 'total': total, 'returned': len(raw),
            'nextOffset': next_offset, 'hasMore': more, 'fingerprint': fingerprint}

def push_local_history(items, limit=100):
    """把**本机**历史推到云端，让手机端也能看到（PC -> 手机 方向）。

    为什么需要它：PC 播放时进度会自动上报（sync_progress），但那只覆盖
    「在 PC 上看过并产生进度」的剧。如果本机有云端没有的条目
    （导入的片单、更早看过的），手机端永远看不到。这里做一次批量补齐。

    安全约束（很重要）：
      * 复用 sync_progress —— 它自带「云端更靠前就不动」的保护，
        绝不会把手机端更新的进度改小；
      * 只推 items 里明确给出的条目，不猜、不全量覆盖；
      * 上限 limit 条，避免一次打太多请求。
    """
    if not is_logged_in():
        return {'ok': False, 'error': '未登录红果账号'}
    if not isinstance(items, list):
        return {'ok': False, 'error': '参数格式不正确'}
    session = dict(load_session() or {})
    pushed, skipped, failed = (0, 0, 0)
    for it in items[:max(1, int(limit))]:
        if _account_changed(session):
            return {'ok': False, 'pushed': pushed, 'skipped': skipped, 'failed': failed, 'error': '账号已切换，已取消旧账号的历史推送'}
        if not isinstance(it, dict):
            continue
        sid = str(it.get('seriesId') or '')
        if not re.fullmatch('[0-9]{8,24}', sid):
            continue
        ep = int(it.get('lastEpisode') or it.get('episode') or 1)
        if not 1 <= ep <= 100000:
            continue
        series = None
        if it.get('title') or it.get('cover'):
            series = {'title': str(it.get('title') or '')[:120], 'cover': str(it.get('cover') or '')[:400]}
        try:
            r = sync_progress(sid, ep, total=int(it.get('episodeCount') or 0), position=0, duration=0, series=series, explicit=False, session=session)
        except Exception:
            failed += 1
            continue
        if r.get('ok'):
            if r.get('skipped'):
                skipped += 1
            else:
                pushed += 1
        else:
            failed += 1
    log_event('push_local_history', pushed=pushed, skipped=skipped, failed=failed, total=len(items))
    return {'ok': True, 'pushed': pushed, 'skipped': skipped, 'failed': failed}

def set_favorite(series_id, favorite):
    if not is_logged_in():
        return {'ok': False, 'error': '未登录红果账号'}
    series_id = str(series_id)
    if not re.fullmatch('[0-9]{8,24}', series_id):
        return {'ok': False, 'error': '剧集标识不合法'}
    body = {'update_bookshelf_video_list': [{'book_id': series_id, 'book_type': 2, 'video_shelf_operate_type': 0 if favorite else 1, 'modify_time': int(time.time() * 1000), 'group_name': ''}]}
    r = _call('POST', '/reading/bookapi/bookshelf/video/update/v', body=body)
    j = _json(r)
    if j.get('code') not in (0, '0'):
        return {'ok': False, 'code': j.get('code'), 'error': j.get('message')}
    return {'ok': True, 'favorite': bool(favorite)}

def remote_favorites():
    if not is_logged_in():
        return {'ok': False, 'error': '未登录红果账号'}
    r = _call('GET', '/reading/bookapi/bookshelf/video/list/v')
    j = _json(r)
    if j.get('code') not in (0, '0'):
        return {'ok': False, 'code': j.get('code'), 'error': j.get('message')}
    info = (j.get('data') or {}).get('video_shelf_info') or []
    items = []
    for it in info:
        items.append({'seriesId': str(it.get('series_id') or it.get('book_id') or ''), 'contentType': int(it.get('content_type') or 0), 'addedAt': int(it.get('collect_time') or it.get('modify_time') or 0)})
    ids = [x['seriesId'] for x in items if x['seriesId']]
    if ids:
        meta = _series_meta(ids)
        for x in items:
            m = meta.get(x['seriesId']) or {}
            x['title'] = m.get('title') or ''
            x['cover'] = m.get('cover') or ''
            x['episodeCount'] = int(m.get('episodeCount') or 0)
    return {'ok': True, 'items': items}

def _series_meta(series_ids):
    """批量取剧集的标题/封面/集数（收藏补封面用）。取不到就返回空，不影响主流程。"""
    out = {}
    ids = [str(s) for s in series_ids if re.fullmatch('[0-9]{8,24}', str(s or ''))]
    if not ids:
        return out
    try:
        batch = H.get_episodes_batch(ids)
        series_map = batch[0] if isinstance(batch, (list, tuple)) and batch else batch
        for sid, meta in (series_map or {}).items():
            if not isinstance(meta, dict):
                continue
            out[str(sid)] = {'title': meta.get('title') or '', 'cover': meta.get('cover') or '', 'episodeCount': int(meta.get('episode_cnt') or meta.get('episodeCount') or 0)}
    except Exception:
        pass
    return out
