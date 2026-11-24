"""Catch request-body/signature divergence and loss of mobile playback identity."""
import ast,base64,ctypes,gzip,hashlib,json,re,socket,struct,time,types,unittest
from pathlib import Path
from unittest.mock import Mock

ROOT=Path(__file__).resolve().parents[2]

def functions(file,names,namespace):
    tree=ast.parse(file.read_text(encoding='utf-8'))
    names=set(names)
    if 'get_video_tracks' in names:
        # Preserve actual snapshot/order behavior; only transport and identity
        # are synthetic. Do not replace a new production helper with a no-op.
        names.update({'_api_hosts_ordered','_copy_playback_host_snapshot','playback_host_snapshot'})
        namespace.setdefault('HOST','model-0.example')
        namespace.setdefault('_API_HOSTS',('model-0.example','model-1.example'))
        namespace.setdefault('_api_host_pref',None)
    selected=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names]
    exec(compile(ast.Module(body=selected,type_ignores=[]),str(file),'exec'),namespace)
    return namespace

class SigningTests(unittest.TestCase):
    def setUp(self):
        self.response=Mock();self.response.json.return_value={'code':0,'data':{}}
        signature=Mock();signature.json.return_value={name:'synthetic-signature' for name in ('X-Argus','X-Gorgon','X-Khronos')}
        self.adapter=Mock();self.adapter.post.return_value=signature
        self.http=Mock(return_value=self.response)
        self.namespace=functions(ROOT/'service/vendor/hongguo.py',{'sign','_api_once'},{
            'base64':base64,'gzip':gzip,'hashlib':hashlib,'json':json,'time':time,
            'SIGN_SERVERS':['http://127.0.0.1:1'],'_next_sign_server':lambda:'http://127.0.0.1:1',
            '_sign_session':lambda:self.adapter,'build_url':lambda *args:'https://reading.snssdk.com/fixture',
            'CFG':{'session_headers':{}},'_pool':None,'session_loader':None,'http_request':self.http,
            'SG':types.SimpleNamespace(throttle=Mock(),check_response=Mock()),
            'RiskControlError':type('RiskControlError',(Exception,),{}),'AuthExpiredError':type('AuthExpiredError',(Exception,),{})})
    def test_signs_the_exact_compressed_bytes_sent_to_the_player_route(self):
        body={'dr_scene':'player','mixed_video_id_map':{'1004':['12345678']}}
        self.namespace['_api_once']('POST','/novel/player/multi_video_model/player/v1',body,None)
        sent=self.http.call_args.kwargs
        signed=self.adapter.post.call_args.kwargs['json']
        self.assertEqual(base64.b64decode(signed['body_base64']),sent['data'])
        self.assertEqual(json.loads(gzip.decompress(sent['data'])),body)
        self.assertEqual(sent['headers']['content-encoding'],'gzip')
        self.assertEqual(sent['headers']['x-ss-stub'],hashlib.md5(sent['data']).hexdigest().upper())
    def test_session_is_loaded_per_request_without_persisting_it_in_config(self):
        loader=Mock(side_effect=[{'cookie':'synthetic-session'},{}]);self.namespace['session_loader']=loader
        self.namespace['_api_once']('GET','/fixture',None,None)
        self.assertEqual(self.http.call_args.kwargs['headers']['cookie'],'synthetic-session')
        self.namespace['_api_once']('GET','/fixture',None,None)
        self.assertNotIn('cookie',self.http.call_args.kwargs['headers'])
        self.assertEqual(self.namespace['CFG']['session_headers'],{})
    def test_empty_signature_is_rejected(self):
        self.adapter.post.return_value.json.return_value={}
        with self.assertRaisesRegex(RuntimeError,'unavailable'):self.namespace['sign']('https://reading.snssdk.com/fixture',{})

class SignerPortDiscoveryTests(unittest.TestCase):
    """Windows 11 26H2 reports unreliable dwState for live listeners in
    GetExtendedTcpTable(TCP_TABLE_OWNER_PID_LISTENER); see issues #1/#3.
    Discovery must match by PID only and fall back to the signer stdout port."""

    def load_gateway_symbols(self):
        source=(ROOT/'service/gateway.py').read_text(encoding='utf-8')
        tree=ast.parse(source)
        wanted={'owned_listener'}
        body=[node for node in tree.body
              if (isinstance(node,ast.FunctionDef) and node.name in wanted)
              or (isinstance(node,ast.ClassDef) and node.name=='TcpRow')]
        namespace={'socket':socket,'struct':struct,'ctypes':ctypes}
        exec(compile(ast.Module(body=body,type_ignores=[]),str(ROOT/'service/gateway.py'),'exec'),namespace)
        return namespace

    def test_listener_rows_match_by_pid_without_state_filter(self):
        source=(ROOT/'service/gateway.py').read_text(encoding='utf-8')
        self.assertNotIn('row.state == 2', source)
        self.assertIn('if row.pid == pid:', source)

    def fake_table(self,row):
        """Emulate GetExtendedTcpTable: a size query then a full-table copy."""
        row_bytes=bytes(memoryview(row).cast('B'))
        payload=struct.pack('<I',1)+row_bytes
        def query(buffer,size_ref,send,af,class_id,flags):
            size_ptr=ctypes.cast(size_ref,ctypes.POINTER(ctypes.c_uint32))
            size_ptr.contents.value=len(payload)
            if buffer is None:
                return 0
            ctypes.memmove(buffer,payload,len(payload))
            return 0
        return query

    def with_fake_table(self,row,action):
        fake=types.SimpleNamespace(GetExtendedTcpTable=self.fake_table(row))
        original=ctypes.WinDLL
        ctypes.WinDLL=lambda *args, **kwargs: fake
        try:
            return action()
        finally:
            ctypes.WinDLL=original

    def test_owned_listener_accepts_state_zero_listener_rows(self):
        namespace=self.load_gateway_symbols()
        row=namespace['TcpRow']()
        row.state=0; row.address=struct.unpack('=I',socket.inet_aton('127.0.0.1'))[0]; row.port=socket.htons(45678)
        row.remote_address=0; row.remote_port=0; row.pid=4242
        result=self.with_fake_table(row,lambda: namespace['owned_listener'](4242))
        self.assertEqual(result,45678)

    def test_owned_listener_rejects_non_loopback_rows(self):
        namespace=self.load_gateway_symbols()
        row=namespace['TcpRow']()
        row.state=0; row.address=struct.unpack('=I',socket.inet_aton('192.168.1.5'))[0]; row.port=socket.htons(45678)
        row.remote_address=0; row.remote_port=0; row.pid=4242
        with self.assertRaisesRegex(RuntimeError,'loopback'):
            self.with_fake_table(row,lambda: namespace['owned_listener'](4242))

    def test_startup_uses_table_then_stdout_fallback_with_tcp_probe(self):
        source=(ROOT/'service/gateway.py').read_text(encoding='utf-8')
        self.assertIn('owned_listener(self.process.pid) or self.stdout_port', source)
        # The signer exposes only /sign, so readiness is a TCP connect, never an HTTP health route.
        self.assertIn('socket.create_connection(("127.0.0.1", port), timeout=2)', source)
        self.assertNotIn('urlopen(candidate', source)

    def test_parent_watch_reads_stdin_without_buffered_reader(self):
        source=(ROOT/'service/gateway.py').read_text(encoding='utf-8')
        self.assertNotIn('sys.stdin.buffer.read(1)', source)
        self.assertIn('while os.read(0, 1):', source)


class PlaybackQueryTests(unittest.TestCase):
    """A zero-byte HTTP 200 from player routes is caused by a missing
    nonempty manifest_version_code. Verified by same-identity A/B: absent or
    empty -> 0 bytes; any nonempty value -> real model. The value is not
    compared by upstream."""

    def build(self, base_query, path='/novel/player/video_model/v1'):
        namespace = functions(ROOT/'service/vendor/hongguo.py', {'build_url'}, {
            'CFG': {'base_query': dict(base_query)}, '_pool': None, 'HOST': 'model-0.example',
            'requests': types.SimpleNamespace(utils=types.SimpleNamespace(quote=__import__('urllib.parse', fromlist=['quote']).quote)),
            'time': time, '_hq_ensure_iid': lambda: None,
            '_PLAYBACK_QUERY_PATHS': ('/novel/player/',)})
        return namespace['build_url'](path)

    def test_player_route_gains_nonempty_manifest_version_code(self):
        url = self.build({'aid': '8662', 'version_code': '73932'})
        self.assertIn('manifest_version_code=73932', url)

    def test_existing_manifest_version_code_is_preserved(self):
        url = self.build({'aid': '8662', 'version_code': '73932', 'manifest_version_code': '111'})
        self.assertIn('manifest_version_code=111', url)
        self.assertNotIn('manifest_version_code=73932', url)

    def test_empty_manifest_version_code_is_replaced(self):
        url = self.build({'aid': '8662', 'version_code': '73932', 'manifest_version_code': ''})
        self.assertIn('manifest_version_code=73932', url)

    def test_non_player_route_query_is_unchanged(self):
        url = self.build({'aid': '8662', 'version_code': '73932'}, path='/reading/bookapi/book/v1')
        self.assertNotIn('manifest_version_code', url)


class ModelRouteTests(unittest.TestCase):
    def test_current_player_model_is_selected_for_the_requested_video_only(self):
        vid='12345678';model={'video_list':[{'main_url':'https://cdn.example/video.mp4'}]}
        api=Mock(return_value={'data':{'1004':{vid:{'video_model':json.dumps(model)},'87654321':{'video_model':json.dumps(model)}}}})
        namespace=functions(ROOT/'service/vendor/hongguo.py',{'get_video_tracks'},{'json':json,'api':api,
            'video_model_tracks':lambda value:value['video_list'],
            'SG':types.SimpleNamespace(cache_get=lambda key:None,cache_key=lambda *args:args,cache_set=Mock()),
            'RiskControlError':type('RiskControlError',(Exception,),{}),'AuthExpiredError':type('AuthExpiredError',(Exception,),{}),
            'UpstreamResponseError':type('UpstreamResponseError',(Exception,),{})})
        result=namespace['get_video_tracks']([vid],force=True)
        self.assertEqual(set(result),{vid});api.assert_called_once()
        self.assertEqual(api.call_args.args,('POST','/novel/player/multi_video_model/player/v1'))
        self.assertEqual(api.call_args.kwargs['body']['dr_scene'],'player')
        self.assertEqual(api.call_args.kwargs['body']['mixed_video_id_map'],{'1004':[vid]})

    def test_empty_current_player_response_falls_back_to_signed_video_tab_for_same_episode(self):
        vid='12345678';model={'video_list':[{'main_url':'https://cdn.example/video.mp4'}]}
        upstream=type('UpstreamResponseError',(Exception,),{});empty=upstream('empty')
        empty_response=type('EmptyResponse',(),{'status_code':200,'content':b''})
        api=Mock(side_effect=[empty,{'code':0,'data':{'video_model_data':{
            vid:{'video_model':json.dumps(model)}}}}])
        namespace=functions(ROOT/'service/vendor/hongguo.py',{'get_video_tracks'},{'json':json,'api':api,
            'video_model_tracks':lambda value:value.get('video_list',[]),
            'SG':types.SimpleNamespace(cache_get=lambda key:None,cache_key=lambda *args:args,cache_set=Mock()),
            'RiskControlError':type('RiskControlError',(Exception,),{}),'AuthExpiredError':type('AuthExpiredError',(Exception,),{}),
            'UpstreamResponseError':upstream,'_HQEmptyResponse':empty_response})
        result=namespace['get_video_tracks']([vid],force=True)
        self.assertEqual(result[vid][0]['main_url'],'https://cdn.example/video.mp4')
        self.assertEqual(api.call_count,2)
        self.assertEqual(api.call_args.args,('GET','/reading/bookapi/video_tab/multi_video_model/v1/'))
        self.assertTrue(api.call_args.kwargs.get('signed',True))
        self.assertEqual(api.call_args.kwargs['extra_query'],{
            'video_id':vid,'video_id_type':'0','device_level':'1','need_all_video_definition':'1',
            'need_mp4_align':'0','use_os_player':'0','video_platform':'1024','source':'0','from_video_id':''})

    def test_video_tab_fallback_accepts_legacy_episode_map_with_decoded_model(self):
        vid='12345678';model={'video_list':[{'main_url':'https://cdn.example/video.mp4'}]}
        upstream=type('UpstreamResponseError',(Exception,),{});empty=upstream('empty')
        empty_response=type('EmptyResponse',(),{'status_code':200,'content':b''})
        api=Mock(side_effect=[empty,{'code':0,'data':{vid:{'video_model':model}}}])
        namespace=functions(ROOT/'service/vendor/hongguo.py',{'get_video_tracks'},{'json':json,'api':api,
            'video_model_tracks':lambda value:value.get('video_list',[]),
            'SG':types.SimpleNamespace(cache_get=lambda key:None,cache_key=lambda *args:args,cache_set=Mock()),
            'RiskControlError':type('RiskControlError',(Exception,),{}),'AuthExpiredError':type('AuthExpiredError',(Exception,),{}),
            'UpstreamResponseError':upstream,'_HQEmptyResponse':empty_response})
        result=namespace['get_video_tracks']([vid],force=True)
        self.assertEqual(result[vid][0]['main_url'],'https://cdn.example/video.mp4')

    def test_video_tab_fallback_never_substitutes_another_episode(self):
        requested='12345678';other='87654321'
        model={'video_list':[{'main_url':'https://cdn.example/other-episode.mp4'}]}
        upstream=type('UpstreamResponseError',(Exception,),{});empty=upstream('empty')
        empty_response=type('EmptyResponse',(),{'status_code':200,'content':b''})
        api=Mock(side_effect=[empty,{'code':0,'data':{'video_model_data':{
            other:{'video_model':json.dumps(model)}}}},
            {'code':0,'data':{}},{'code':0,'data':{}}])
        namespace=functions(ROOT/'service/vendor/hongguo.py',{'get_video_tracks'},{'json':json,'api':api,
            'video_model_tracks':lambda value:value.get('video_list',[]),
            'SG':types.SimpleNamespace(cache_get=lambda key:None,cache_key=lambda *args:args,cache_set=Mock()),
            'RiskControlError':type('RiskControlError',(Exception,),{}),'AuthExpiredError':type('AuthExpiredError',(Exception,),{}),
            'UpstreamResponseError':upstream,'_HQEmptyResponse':empty_response})
        with self.assertRaises(upstream):namespace['get_video_tracks']([requested],force=True)

class PassportSigningTests(unittest.TestCase):
    def test_form_body_is_signed_with_its_actual_digest(self):
        signer=Mock(return_value={});http=Mock(return_value=object())
        namespace=functions(ROOT/'service/vendor/desktop_account.py',{'_call'},{
            'H':types.SimpleNamespace(build_url=lambda *args:'https://reading.snssdk.com/fixture',sign=signer,http_request=http),
            'passport_query':lambda:{},'_headers':lambda session:{},'PASSPORT_UA':'synthetic-user-agent',
            'hashlib':hashlib,'time':time,'re':re,'os':types.SimpleNamespace(environ={})})
        namespace['_call']('POST','/fixture',form='field=fixture',passport=True)
        sent=http.call_args.kwargs
        self.assertEqual(signer.call_args.args[2],sent['data'])
        self.assertEqual(sent['headers']['x-ss-stub'],hashlib.md5(sent['data']).hexdigest().upper())

if __name__=='__main__':unittest.main()
