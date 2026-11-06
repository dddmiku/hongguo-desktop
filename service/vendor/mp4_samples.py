# Adapted protocol leaf SDK; provenance: service/vendor/README.md.
import struct

def _ib(d, s, e):
    o = s
    while o + 8 <= e:
        sz = struct.unpack('>I', d[o:o + 4])[0]
        t = d[o + 4:o + 8]
        hs = 8
        if sz == 1:
            sz = struct.unpack('>Q', d[o + 8:o + 16])[0]
            hs = 16
        elif sz == 0:
            sz = e - o
        yield (t, o, sz, hs)
        o += sz

def _find(d, p, s=0, e=None):
    if e is None:
        e = len(d)
    for t, o, sz, hs in _ib(d, s, e):
        if t == p[0]:
            return (o + hs, o + sz) if len(p) == 1 else _find(d, p[1:], o + hs, o + sz)

def _u32(d, o):
    return struct.unpack('>I', d[o:o + 4])[0]

def parse_track_samples(d, handler=b'vide'):
    """解析指定 handler 轨(vide/soun)的样本 (sizes, offs)。无此轨返回 ([], [])。
    stsz/stco|co64/stsc → 文件内每样本字节偏移; 视频音频通用。"""
    mv = _find(d, [b'moov'])
    if not mv:
        return ([], [])
    traks = [(o + hs, o + sz) for t, o, sz, hs in _ib(d, *mv) if t == b'trak']

    def hdlr(tr):
        h = _find(d, [b'mdia', b'hdlr'], *tr)
        return d[h[0] + 8:h[0] + 12] if h else None
    want = [t for t in traks if hdlr(t) == handler]
    if not want:
        return ([], [])
    s, e = _find(d, [b'mdia', b'minf', b'stbl'], *want[0])
    stsz = _find(d, [b'stsz'], s, e)
    stco = _find(d, [b'stco'], s, e)
    co64 = _find(d, [b'co64'], s, e)
    stsc = _find(d, [b'stsc'], s, e)
    ss = _u32(d, stsz[0] + 4)
    cnt = _u32(d, stsz[0] + 8)
    sizes = [ss] * cnt if ss else [_u32(d, stsz[0] + 12 + 4 * i) for i in range(cnt)]
    if stco:
        n = _u32(d, stco[0] + 4)
        ch = [_u32(d, stco[0] + 8 + 4 * i) for i in range(n)]
    else:
        n = _u32(d, co64[0] + 4)
        ch = [struct.unpack('>Q', d[co64[0] + 8 + 8 * i:co64[0] + 16 + 8 * i])[0] for i in range(n)]
    ne = _u32(d, stsc[0] + 4)
    runs = [(_u32(d, stsc[0] + 8 + 12 * i), _u32(d, stsc[0] + 12 + 12 * i), _u32(d, stsc[0] + 16 + 12 * i)) for i in range(ne)]
    spc = [0] * len(ch)
    for i, (fc, sp, sd) in enumerate(runs):
        last = runs[i + 1][0] - 1 if i + 1 < len(runs) else len(ch)
        for c in range(fc, last + 1):
            if 1 <= c <= len(ch):
                spc[c - 1] = sp
    offs = []
    si = 0
    for c in range(len(ch)):
        off = ch[c]
        for _ in range(spc[c]):
            if si >= cnt:
                break
            offs.append(off)
            off += sizes[si]
            si += 1
    return (sizes, offs)

def parse_video_samples(path):
    d = open(path, 'rb').read()
    sizes, offs = parse_track_samples(d, b'vide')
    return (d, sizes, offs)

def _nal_ok(pt, sz):
    p = 0
    while p + 4 <= sz:
        ln = struct.unpack('>I', pt[p:p + 4])[0]
        if ln == 0 or p + 4 + ln > sz:
            return False
        p += 4 + ln
    return p == sz

def verify_key_iv(ct_path, keys, iv8s):
    """对密文逐 (key×base_iv) 试解, NAL自证选真值。
    先用首块(16B)的首NAL长度快筛, 再全样本校验。keys 应传"全部key候选"(让密文定真伪)。"""
    from Crypto.Cipher import AES
    from Crypto.Util import Counter
    d, sizes, offs = parse_video_samples(ct_path)
    if not sizes:
        return (None, None)
    co0, sz0 = (offs[0], sizes[0])
    blk0 = d[co0:co0 + 16]
    pass
    for kh in keys:
        K = bytes.fromhex(kh)
        if len(K) != 16:
            continue
        ec = {}
        for ivh in iv8s:
            biv = int(ivh, 16)
            pt0 = AES.new(K, AES.MODE_CTR, counter=Counter.new(128, initial_value=biv << 64)).decrypt(blk0)
            L = struct.unpack('>I', pt0[:4])[0]
            if not 0 < L < sz0:
                continue
            ok = 0
            for idx in range(min(2, len(sizes))):
                co, sz = (offs[idx], sizes[idx])
                iv = biv + idx << 64
                pt = AES.new(K, AES.MODE_CTR, counter=Counter.new(128, initial_value=iv)).decrypt(d[co:co + sz])
                if _nal_ok(pt, sz):
                    ok += 1
                else:
                    break
            if ok >= 2:
                return (kh, ivh)
    return (None, None)
