# Adapted protocol leaf SDK; provenance: service/vendor/README.md.
"""红果 spade_a -> content key 纯离线 unwrap (§9 终极: 无 app/无播放/无 frida)。

逆向自 libttmplayer.so FUN_001c4550 (ver1 路径, flag=opt0x97)。
算法 = 纯字节变换(XOR + POPCOUNT + 位置相关), 无 KEK、无 AES。
已用 5 组运行时真值 100% 验证 (见 __main__ 自测)。

链路: API video_model.encryptInfo.spadeA(base64)
      -> base64_decode -> unwrap_v1 -> content key(16B, 32 hex)
      -> 配合密文 senc 首样本 base_iv -> AES-128-CTR 解密。

注: ver2(spade type "app_v2"/"web_v2") 走 libttmplayer FUN_00271a50
    (base64 + MD5(KEK) + AES-GCM-256), 当前红果视频未见使用, 见 §16.10。
"""
import base64

def _popcount(x):
    return bin(x & 4294967295).count('1')

def _s8(v):
    v &= 255
    return v - 256 if v >= 128 else v

def _strncmp0(a, b, n):
    for k in range(n):
        ca = a[k] if k < len(a) else 0
        cb = b[k] if k < len(b) else 0
        if ca != cb:
            return False
        if ca == 0:
            return True
    return True

def unwrap_v1(spade, flag=0):
    """spade(37B bytes 或 hex 字符串) -> content key(32 hex 字符串) 或 None。
    flag = 播放器 option 0x97 的值(实测为 0); flag!=0 时变换方向相反。"""
    if isinstance(spade, str):
        spade = bytes.fromhex(spade)
    L = len(spade)
    if L < 3:
        return None
    bVar5 = spade[0] ^ spade[1] ^ spade[2]
    iVar9 = bVar5 - 48
    if iVar9 < 1:
        return None
    uVar1 = L - bVar5 + 47
    if uVar1 < 1 or 1 + uVar1 > L:
        return None
    dest = bytearray(spade[1:1 + uVar1])
    s1 = bytearray(iVar9)
    b16 = spade[L - iVar9 - 2]
    b14 = spade[L - iVar9 - 1]
    for i in range(iVar9):
        s1[i] = b14 ^ b16 ^ spade[i + (L - iVar9)]
    if _strncmp0(s1, b'app_v2', iVar9) or _strncmp0(s1, b'web_v2', iVar9):
        return None
    b14, b16 = (85, 250)
    for i in range(uVar1):
        b6 = dest[i]
        u18 = _popcount(i)
        b3, b7 = (b6, b14)
        if i & 1:
            b3, b7, b16 = (b16, b6, b14)
        cVar4 = u18 + 21 if flag else _s8(-21 - u18)
        dest[i] = cVar4 + (b16 ^ b6) & 255
        b14, b16 = (b7, b3)
    b0 = dest[0]
    if 48 <= b0 <= 57:
        u11 = b0 - 48
    elif 97 <= b0 <= 122:
        u11 = b0 - 87
    else:
        return None
    iv9 = uVar1 - (u11 & 255)
    if iv9 < 2:
        return None
    return bytes(dest[1:iv9]).decode('latin1', 'replace')

def spade_to_key(spade_a_b64, flag=0):
    """video_model 的 spadeA(base64) -> content key(32 hex)。一步到位。"""
    return unwrap_v1(base64.b64decode(spade_a_b64), flag)
