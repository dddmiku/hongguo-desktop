"""只读请求文件删除权限，用于诊断 NSIS 原子移走文件的共享冲突。"""
import ctypes
from ctypes import wintypes
from pathlib import Path
import os,json
root=Path(os.environ['LOCALAPPDATA'])/'Programs/hongguo-desktop'
native=ctypes.WinDLL('kernel32',use_last_error=True)
native.CreateFileW.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,ctypes.c_void_p,wintypes.DWORD,wintypes.DWORD,wintypes.HANDLE]
native.CreateFileW.restype=wintypes.HANDLE
native.CloseHandle.argtypes=[wintypes.HANDLE]
errors=[];count=0
for file in root.rglob('*'):
    if not file.is_file():continue
    count+=1
    handle=native.CreateFileW('\\\\?\\'+str(file),0x10000,7,None,3,0,None)
    if handle==ctypes.c_void_p(-1).value:errors.append({'file':file.relative_to(root).as_posix(),'winerror':ctypes.get_last_error()})
    else:native.CloseHandle(handle)
print(json.dumps({'files':count,'locked':errors},ensure_ascii=False))
