"""Comments use the shared body-aware, authenticated request transport."""
from pathlib import Path
import sys
import types
import unittest
import secrets
from unittest.mock import Mock
from fastapi.testclient import TestClient

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from provider import Provider, ProviderError
from gateway import create_app

SID,VID='12345678','23456789'

def response(rows=None,cursor=20,more=True,total=44):
    if rows is None:
        rows=[{'comment':{'comment_id':'34567890','common':{
            'content':{'text':'测试评论正文'},'create_timestamp':1730000000,
            'user_info':{'base_info':{'user_name':'测试观众','user_avatar':''}}},
            'stat':{'digg_count':3}}}]
    return {'code':0,'data':{'common_list_info':{'total':total,'cursor':str(cursor),'has_more':more},'data_list':rows}}

class CommentTests(unittest.TestCase):
    def setUp(self):
        self.session={'uid':'synthetic-user'}
        self.sdk=types.SimpleNamespace(get_episodes=Mock(return_value=(
            {'series_id':SID,'title':'测试剧','episode_cnt':1},
            [{'index':1,'vid':VID,'duration':40,'title':'第一集'}])))
        self.sdk.CFG={'session_headers':{}}
        self.sdk.build_url=lambda path:'https://example.invalid'+path
        self.sdk.sign=lambda url,headers,body=None:{'_test_body_signed':bool(body)}
        self.sdk.SG=types.SimpleNamespace(throttle=types.SimpleNamespace(wait=lambda:None))
        self.sdk.http_request=lambda method,url,**options:types.SimpleNamespace(raise_for_status=lambda:None,
            json=lambda:response() if options['headers'].get('_test_body_signed') else {'message':'signature rejected'})
        self.account=types.SimpleNamespace(load_session=Mock(return_value=self.session),
            _session_identity=Mock(return_value='test-session'),_account_changed=Mock(return_value=False),
            _call=Mock(return_value=response()),_json=lambda value:value)
        self.provider=Provider(Path(__file__).parent/'.work/comments',self.sdk,self.account)
        self.addCleanup(self.provider.close)

    def test_requests_body_and_current_session_through_shared_signed_transport(self):
        page=self.provider.comments(SID,1)
        self.account._call.assert_called_once_with('POST',f'/novel/commentapi/comment/list/{VID}/v1/',
            body={'comment_source':4,'server_channel':18,'group_type':30,'comment_type':4,
                'sort':1,'count':20,'cursor':'0','business_param':{
                    'book_id':SID,'item_id':VID,'need_count':True,'req_type':0}},session=self.session)
        self.assertEqual(page['items'][0]['text'],'测试评论正文')
        self.assertEqual(page['items'][0]['likes'],3)
        self.assertEqual((page['total'],page['cursor'],page['hasMore']),(44,'20',True))

    def test_caches_each_page_and_session_separately(self):
        self.provider.comments(SID,1)
        self.provider.comments(SID,1)
        self.assertEqual(self.account._call.call_count,1)
        self.account._call.return_value=response(cursor=40)
        self.provider.comments(SID,1,20)
        self.assertEqual(self.account._call.call_args.kwargs['body']['cursor'],'20')
        self.account._session_identity.return_value='changed-session'
        self.provider.comments(SID,1)
        self.assertEqual(self.account._call.call_count,3)

    def test_account_switch_during_read_discards_old_page(self):
        self.account._account_changed.return_value=True
        with self.assertRaises(ProviderError) as error:self.provider.comments(SID,1)
        self.assertEqual(error.exception.code,'ACCOUNT_CHANGED')
        self.account._account_changed.return_value=False
        self.provider.comments(SID,1)
        self.assertEqual(self.account._call.call_count,2)

    def test_upstream_rejections_are_retryable_errors_not_empty_comments(self):
        for value in ({'code':1},{'message':'request rejected'}, {'code':0,'data':None}, {'code':0,'data':{}}):
            self.account._call.return_value=value
            with self.assertRaises(ProviderError) as error:self.provider.comments(SID,1)
            self.assertEqual(error.exception.code,'COMMENTS_UNAVAILABLE')
        self.account._call.return_value=response()
        self.assertEqual(len(self.provider.comments(SID,1)['items']),1)

    def test_genuine_empty_page_preserves_empty_state(self):
        self.account._call.return_value=response([],cursor=0,more=False,total=0)
        self.assertEqual(self.provider.comments(SID,1),{'items':[],'total':0,'cursor':'0','hasMore':False})

    def test_opaque_pagination_cursor_is_preserved_in_both_directions(self):
        cursor='{"offset":20,"session_id":"fixture+/="}'
        self.account._call.return_value=response(cursor=cursor)
        self.assertEqual(self.provider.comments(SID,1)['cursor'],cursor)
        self.account._call.return_value=response(cursor='{"offset":40,"session_id":"fixture+/="}')
        self.provider.comments(SID,1,cursor)
        self.assertEqual(self.account._call.call_args.kwargs['body']['cursor'],cursor)

    def test_invalid_cursor_never_calls_upstream(self):
        for value in (-1,1000001,True,{},'','a'*4097,'line\nline'):
            with self.assertRaises(ProviderError) as error:self.provider.comments(SID,1,value)
            self.assertEqual(error.exception.code,'INPUT_INVALID')
        self.account._call.assert_not_called()

    def test_malformed_continuation_is_an_error_not_a_first_page_loop(self):
        for value in (None,False,{},[],0,'0',''):
            reply=response()
            reply['data']['common_list_info']['cursor']=value
            self.account._call.return_value=reply
            with self.assertRaises(ProviderError) as error:self.provider.comments(SID,1)
            self.assertEqual(error.exception.code,'COMMENTS_UNAVAILABLE')
        self.account._call.return_value=response(cursor=20)
        with self.assertRaises(ProviderError) as error:self.provider.comments(SID,1,20)
        self.assertEqual(error.exception.code,'COMMENTS_UNAVAILABLE')

    def test_gateway_accepts_url_encoded_opaque_cursor(self):
        cursor='{"offset":20,"session_id":"fixture+/="}'
        capability=secrets.token_hex(32)
        with TestClient(create_app(self.provider,capability)) as client:
            reply=client.get('/catalog/comments',params={'seriesId':SID,'episode':1,'cursor':cursor},
                headers={'authorization':'Bearer '+capability})
        self.assertEqual(reply.status_code,200)
        self.assertEqual(self.account._call.call_args.kwargs['body']['cursor'],cursor)

    def test_missing_episode_never_calls_comments(self):
        with self.assertRaises(ProviderError) as error:self.provider.comments(SID,2)
        self.assertEqual(error.exception.code,'EPISODE_NOT_FOUND')
        self.account._call.assert_not_called()
