"""Read Windows native hit testing without moving the cursor or modifying a window."""
import ctypes
from ctypes import wintypes
import json
import sys

data = json.load(sys.stdin)
user32 = ctypes.WinDLL('user32', use_last_error=True)
user32.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, ctypes.c_size_t,
                                      ctypes.c_ssize_t, wintypes.UINT, wintypes.UINT,
                                      ctypes.POINTER(ctypes.c_size_t)]
user32.SendMessageTimeoutW.restype = ctypes.c_ssize_t
result = ctypes.c_size_t()
point = (int(data['x']) & 0xffff) | ((int(data['y']) & 0xffff) << 16)
if not user32.SendMessageTimeoutW(int(data['handle']), 0x0084, 0, point, 2, 2000, ctypes.byref(result)):
    raise RuntimeError('Native hit test failed')
print(json.dumps({'hit': ctypes.c_ssize_t(result.value).value}))
