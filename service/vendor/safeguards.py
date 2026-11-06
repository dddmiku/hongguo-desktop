# Adapted protocol leaf SDK; provenance: service/vendor/README.md.
"""风控防护层: 缓存 + 节流 + 风控识别。被 hongguo.py 使用。"""
import time, threading, hashlib, json, random
import os, pickle
_cache = {}
_cache_lock = threading.Lock()
_HQ_SAFEGUARDS_CACHE_MAX = 2048
_redis = None
_REDIS_URL = os.environ.get('REDIS_URL')
if _REDIS_URL:
    try:
        import redis as _redislib
        _redis = _redislib.from_url(_REDIS_URL)
        _redis.ping()
        pass
    except Exception as e:
        pass
        _redis = None

def cache_get(key):
    if _redis is not None:
        try:
            v = _redis.get('hg:' + key)
            return pickle.loads(v) if v else None
        except Exception:
            return None
    with _cache_lock:
        v = _cache.get(key)
        if v and v[0] > time.time():
            return v[1]
        if v:
            _cache.pop(key, None)
    return None

def cache_set(key, val, ttl):
    if _redis is not None:
        try:
            _redis.setex('hg:' + key, int(ttl), pickle.dumps(val))
        except Exception:
            pass
        return
    with _cache_lock:
        _cache[key] = (time.time() + ttl, val)
        if len(_cache) > _HQ_SAFEGUARDS_CACHE_MAX:
            for _k in sorted(_cache, key=lambda k: _cache[k][0])[:len(_cache) - _HQ_SAFEGUARDS_CACHE_MAX]:
                _cache.pop(_k, None)

def cache_key(*parts):
    return hashlib.md5(json.dumps(parts, ensure_ascii=False, sort_keys=True).encode()).hexdigest()

class Throttle:

    def __init__(self, min_interval=float(os.environ.get('HG_THROTTLE_MIN_INTERVAL', '0.6')), jitter=float(os.environ.get('HG_THROTTLE_JITTER', '0.4')), burst=float(os.environ.get('HG_THROTTLE_BURST', '3')), refill_per_sec=float(os.environ.get('HG_THROTTLE_REFILL', '1.5'))):
        self.min_interval = min_interval
        self.jitter = jitter
        self.lock = threading.Lock()
        self.last = 0.0
        self.tokens = burst
        self.burst = burst
        self.refill = refill_per_sec
        self.token_ts = time.time()

    def wait(self):
        with self.lock:
            now = time.time()
            self.tokens = min(self.burst, self.tokens + (now - self.token_ts) * self.refill)
            self.token_ts = now
            gap = now - self.last
            need = self.min_interval + random.uniform(0, self.jitter)
            sleep = 0.0
            if gap < need:
                sleep = need - gap
            if self.tokens < 1:
                sleep = max(sleep, (1 - self.tokens) / self.refill)
            if sleep > 0:
                time.sleep(sleep)
            self.tokens = max(0, self.tokens - 1)
            self.last = time.time()
throttle = Throttle()

class RiskControlError(Exception):
    pass

class AuthExpiredError(Exception):
    """登录态(token/cookie)过期"""
    pass
AUTH_CODES = {401, 403, 8, 1001}
AUTH_KEYWORDS = ('token', '登录', 'login', '未登录', 'not login', 'unauthor', '登陆', 'session', 'expire', '凭证', '重新登录')
RISK_CODES = {110001, 100001, 100002, 8}
RISK_KEYWORDS = ('verify', 'captcha', 'risk', '频繁', '稍后', '验证', 'rate limit', 'too many')

def check_response(j):
    """检查响应。正常返回; 登录过期抛 AuthExpiredError; 风控/异常抛 RiskControlError。"""
    if not isinstance(j, dict):
        return
    code = j.get('code')
    if code in (0, None) and 'Code' in j:
        code = j.get('Code')
    _HQ_CODE_UPPER = True
    msg = (j.get('message') or '') + (j.get('BaseResp', {}).get('StatusMessage', '') if isinstance(j.get('BaseResp'), dict) else '')
    ml = msg.lower()
    if code in (0, None):
        if any((k in ml for k in RISK_KEYWORDS)):
            raise RiskControlError(f'疑似风控: {msg}')
        return
    if code in AUTH_CODES or any((k in ml for k in AUTH_KEYWORDS)):
        raise AuthExpiredError(f'登录态失效 code={code} msg={msg}')
    if code in RISK_CODES or any((k in ml for k in RISK_KEYWORDS)):
        raise RiskControlError(f'风控触发 code={code} msg={msg}')
    raise RiskControlError(f'接口返回异常 code={code} msg={msg}')
