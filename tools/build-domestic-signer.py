"""Compile the tracked domestic JNI adapter against the verified runtime dependency jar."""
import os,shutil,subprocess,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/'_work/domestic-build';WORK.mkdir(parents=True,exist_ok=True)
javac=shutil.which('javac')
if not javac:raise RuntimeError('A JDK with javac is required to build the signer')
classes=WORK/'classes';classes.mkdir(exist_ok=True)
sources=sorted((ROOT/'native/sign/src').rglob('*.java'))
result=subprocess.run([javac,'-encoding','UTF-8','-source','8','-target','8','-cp',str(ROOT/'runtime/sign/unidbg-sign.jar'),'-d',str(classes)]+[str(p) for p in sources],capture_output=True)
if result.returncode:raise RuntimeError('Signer compilation failed: '+result.stderr.decode('utf-8','replace'))
target=ROOT/'runtime/sign/domestic-sign.jar'
with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(classes.rglob('*.class')):
        # Fixed timestamps keep the shipped signer byte-reproducible from source.
        entry=zipfile.ZipInfo(file.relative_to(classes).as_posix(),date_time=(1980,1,1,0,0,0))
        entry.compress_type=zipfile.ZIP_DEFLATED
        archive.writestr(entry,file.read_bytes())
print('Domestic signer compiled')
