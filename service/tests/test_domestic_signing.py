"""Catch request-body/signature divergence and loss of mobile playback identity."""
import ast,base64,gzip,hashlib,json,re,time,types,unittest
from pathlib import Path
from unittest.mock import Mock

ROOT=Path(__file__).resolve().parents[2]

def functions(file,names,namespace):
    tree=ast.parse(file.read_text(encoding='utf-8'))
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
