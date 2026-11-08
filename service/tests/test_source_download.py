"""Byte-for-byte source assembly, CDN fallback and cancellation; no account or external network."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'service'))
from source_download import SourceDownloader,SourceDownloadError

DATA=bytes(range(256))*(5*1024*1024//256)


class Reply:
    def __init__(self,data,status,headers,source):self.data,self.status_code,self.headers,self.source=data,status,headers,source
    def __enter__(self):
        with self.source.guard:self.source.active+=1;self.source.peak=max(self.source.peak,self.source.active)
        return self
    def __exit__(self,*args):
        with self.source.guard:self.source.active-=1
    def raise_for_status(self):pass
    def iter_content(self,size):
        for offset in range(0,len(self.data),size):
            time.sleep(self.source.delay)
            yield self.data[offset:offset+size]


class CDN:
    def __init__(self,mode='ranges',delay=.09):self.mode=mode;self.delay=delay;self.active=0;self.peak=0;self.guard=threading.Lock();self.calls=[]
    def request(self,method,url,**options):
        headers=options.get('headers',{});value=headers.get('Range');self.calls.append(value)
        if not value or self.mode=='serial' or self.mode=='prefix-only' and not value.startswith('bytes=0-'):
            return Reply(DATA,200,{'content-length':str(len(DATA)),'accept-ranges':'bytes' if self.mode!='serial' else 'none','etag':'"fixture"'},self)
        start,end=map(int,value.removeprefix('bytes=').split('-'));end=min(end,len(DATA)-1)
        body=DATA[start:end+1]
        declared=len(DATA)+1 if self.mode=='changed' and start>0 else len(DATA)
        if self.mode=='truncated' and start>0:body=body[:-1]
        return Reply(body,206,{'content-length':str(len(body)),'content-range':f'bytes {start}-{end}/{declared}','etag':'"fixture"'},self)


class SourceTests(unittest.TestCase):
    def setUp(self):
        work=ROOT/'_work/source-download-tests';work.mkdir(parents=True,exist_ok=True)
        self.temporary=tempfile.TemporaryDirectory(dir=work);self.root=Path(self.temporary.name)
    def tearDown(self):self.temporary.cleanup()
    def test_large_source_uses_two_ranges_and_matches_all_original_bytes(self):
        cdn=CDN();output=self.root/'source.partial';downloader=SourceDownloader(cdn.request)
        self.assertEqual(downloader.download('https://fixture.test/video',output,lambda:None),len(DATA))
        self.assertEqual(output.read_bytes(),DATA);self.assertEqual(cdn.peak,2);self.assertEqual(len(cdn.calls),3)
    def test_fast_range_capable_source_keeps_the_original_connection(self):
        cdn=CDN(delay=.001);output=self.root/'fast.partial'
        SourceDownloader(cdn.request).download('https://fixture.test/video',output,lambda:None)
        self.assertEqual(output.read_bytes(),DATA);self.assertEqual(cdn.calls,[None]);self.assertEqual(cdn.peak,1)
    def test_two_simultaneous_sources_never_exceed_two_network_readers(self):
        cdn=CDN();downloader=SourceDownloader(cdn.request)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures=[pool.submit(downloader.download,'https://fixture.test/video',self.root/str(n),lambda:None) for n in range(2)]
            for future in futures:self.assertEqual(future.result(),len(DATA))
        self.assertLessEqual(cdn.peak,2)
    def test_servers_ignoring_range_fall_back_to_one_complete_response(self):
        cdn=CDN('serial',delay=.001);output=self.root/'source.partial'
        SourceDownloader(cdn.request).download('https://fixture.test/video',output,lambda:None)
        self.assertEqual(output.read_bytes(),DATA);self.assertEqual(len(cdn.calls),1)
    def test_prefix_only_range_support_restarts_full_download_without_mixing_bytes(self):
        cdn=CDN('prefix-only');output=self.root/'source.partial'
        SourceDownloader(cdn.request).download('https://fixture.test/video',output,lambda:None)
        self.assertEqual(output.read_bytes(),DATA);self.assertIn(None,cdn.calls)
    def test_incomplete_or_changed_ranges_are_never_reported_as_a_valid_source(self):
        for mode in ('changed','truncated'):
            cdn=CDN(mode)
            with self.assertRaises(SourceDownloadError):SourceDownloader(cdn.request).download('https://fixture.test/video',self.root/mode,lambda:None)
            self.assertEqual(cdn.active,0)
    def test_cancellation_stops_pending_reads_and_releases_slots(self):
        cdn=CDN();downloader=SourceDownloader(cdn.request);calls=0
        def cancel():
            nonlocal calls
            calls+=1
            if calls>2:raise RuntimeError('cancelled')
        with self.assertRaisesRegex(RuntimeError,'cancelled'):downloader.download('https://fixture.test/video',self.root/'cancelled',cancel)
        self.assertEqual(cdn.active,0)
        output=self.root/'next';downloader.download('https://fixture.test/video',output,lambda:None)
        self.assertEqual(output.read_bytes(),DATA)


if __name__=='__main__':unittest.main()
