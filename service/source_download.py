"""Adaptive source downloads: keep fast connections; split slow, range-capable sources into two bounded readers."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import re
import threading
import time

MAX_SIZE=512*1024*1024
PREFIX=1024*1024
PARALLEL_MIN=4*1024*1024
CONTENT_RANGE=re.compile(r"bytes ([0-9]+)-([0-9]+)/([0-9]+)")


class SourceDownloadError(RuntimeError):
    pass


class RangeUnsupported(SourceDownloadError):
    pass


class SourceDownloader:
    def __init__(self,request):
        self.request=request
        self.slots=threading.BoundedSemaphore(2)

    @contextmanager
    def _response(self,url,cancel,headers):
        while not self.slots.acquire(timeout=.05):cancel()
        try:
            cancel()
            with self.request("GET",url,stream=True,timeout=(10,15),headers={"Accept-Encoding":"identity",**headers}) as response:
                response.raise_for_status()
                yield response
        finally:self.slots.release()

    @staticmethod
    def _range(response,start,end,total):
        match=CONTENT_RANGE.fullmatch(response.headers.get("content-range", ""))
        if response.status_code!=206 or not match:raise RangeUnsupported("Source does not support verified ranges")
        first,last,length=map(int,match.groups())
        if first!=start or last!=end or length!=total or not 0<length<=MAX_SIZE or last>=length:
            raise SourceDownloadError("Source changed during download")

    @staticmethod
    def _write(response,handle,cancel,limit):
        count=0
        for chunk in response.iter_content(256*1024):
            cancel()
            if not chunk:continue
            count+=len(chunk)
            if count>limit or count>MAX_SIZE:raise SourceDownloadError("Source exceeds its declared size")
            handle.write(chunk)
        cancel()
        if count==0:raise SourceDownloadError("Empty source")
        return count

    def _serial(self,url,path,cancel):
        with self._response(url,cancel,{}) as response:
            if response.status_code!=200:raise SourceDownloadError("Invalid complete source response")
            size=int(response.headers.get("content-length") or 0)
            if size<0 or size>MAX_SIZE:raise SourceDownloadError("Source size exceeds limit")
            with path.open("wb") as handle:count=self._write(response,handle,cancel,size or MAX_SIZE)
            if size and count!=size:raise SourceDownloadError("Incomplete source")
            return count

    def download(self,url,path,cancel):
        try:
            with self._response(url,cancel,{}) as response:
                if response.status_code!=200:raise SourceDownloadError("Invalid complete source response")
                total=int(response.headers.get("content-length") or 0)
                if total<0 or total>MAX_SIZE:raise SourceDownloadError("Source size exceeds limit")
                supports_range=response.headers.get("accept-ranges", "").lower()=="bytes"
                validator=response.headers.get("etag") or response.headers.get("last-modified")
                count=0;started=time.monotonic();split=False
                with path.open("wb") as handle:
                    for chunk in response.iter_content(256*1024):
                        cancel()
                        if not chunk:continue
                        count+=len(chunk)
                        if count>(total or MAX_SIZE):raise SourceDownloadError("Source exceeds its declared size")
                        handle.write(chunk)
                        if count>=PREFIX and supports_range and total>=PARALLEL_MIN:
                            elapsed=time.monotonic()-started
                            remaining_seconds=elapsed*(total-count)/count
                            # Connection setup is deliberately excluded; creating readers cannot help a slow handshake.
                            if remaining_seconds>1.2 and count<total:
                                split=True;handle.truncate(total);break
                if not split:
                    cancel()
                    if not count or total and count!=total:raise SourceDownloadError("Incomplete source")
                    return count
            headers={"If-Range":validator} if validator and not validator.startswith("W/") else {}
            def remaining(first,final):
                with self._response(url,cancel,{**headers,"Range":f"bytes={first}-{final}"}) as reply:
                    self._range(reply,first,final,total)
                    if validator and (reply.headers.get("etag") or reply.headers.get("last-modified")) not in (None,validator):
                        raise SourceDownloadError("Source validator changed")
                    with path.open("r+b") as handle:
                        handle.seek(first)
                        if self._write(reply,handle,cancel,final-first+1)!=final-first+1:
                            raise SourceDownloadError("Incomplete source range")
            middle=count+(total-count)//2
            with ThreadPoolExecutor(max_workers=2,thread_name_prefix="hongguo-source") as pool:
                futures=[pool.submit(remaining,count,middle-1),pool.submit(remaining,middle,total-1)]
                for future in futures:future.result()
            cancel()
            return total
        except RangeUnsupported:
            # A CDN can advertise Range but ignore it. Reassemble through a single verified complete request.
            cancel()
            return self._serial(url,path,cancel)
