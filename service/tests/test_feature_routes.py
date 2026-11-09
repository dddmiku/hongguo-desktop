"""PC gateway feature routes and atomic QR account commit, with synthetic local fixtures."""
import hashlib
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock
from fastapi.testclient import TestClient

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'service'))
from provider import Provider,ProviderError
from gateway import create_app
from qr_login import QrLoginError

class FeatureRoutesTests(unittest.TestCase):
    def setUp(self):
        work=ROOT/'_work/feature-route-tests';work.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=work);self.addCleanup(self.temp.cleanup)
        self.state={}
        identity=lambda value:hashlib.sha256(str(value.get('uid','')).encode()).hexdigest()
        self.account=types.SimpleNamespace(load_session=lambda:dict(self.state),save_session=Mock(side_effect=lambda value:self.state.update(value)),clear_mfa=Mock(),_session_identity=identity,
            public_session=lambda:{'loggedIn':bool(self.state.get('cookie')),'uid':self.state.get('uid',''),'userName':'测试账号','mobile':''})
        self.provider=Provider(Path(self.temp.name),object(),self.account);self.addCleanup(self.provider.close)
        self.headers={'Authorization':'Bearer '+'a'*64}

    def test_qr_commit_saves_only_after_origin_identity_is_rechecked(self):
        origin=self.account._session_identity({})
        session=self.provider._commit_qr_session({'uid':'synthetic-user','cookie':'synthetic-only'},origin)
        self.assertTrue(session['loggedIn']);self.assertEqual(session['uid'],'synthetic-user')
        self.account.save_session.assert_called_once();self.account.clear_mfa.assert_called_once()
        with self.assertRaises(ProviderError) as failure:
            self.provider._commit_qr_session({'uid':'replacement-user','cookie':'synthetic-only'},origin)
        self.assertEqual(failure.exception.code,'ACCOUNT_CHANGED');self.account.save_session.assert_called_once()

    def test_qr_commit_rejects_unverified_candidate_without_writes(self):
        for candidate in ({'uid':'synthetic-user'},{'cookie':'synthetic-only'}):
            with self.assertRaises(QrLoginError):self.provider._commit_qr_session(candidate,self.account._session_identity({}))
        self.account.save_session.assert_not_called()

    def test_season_routes_are_authenticated_and_reach_the_resolver(self):
        self.provider.next_season=Mock(return_value={'status':'found'})
        self.provider.season_overview=Mock(return_value={'status':'single'})
        client=TestClient(create_app(self.provider,'a'*64))
        for suffix in ('next-season','seasons'):
            route='/catalog/series/12345678/'+suffix
            self.assertEqual(client.get(route).status_code,401)
            self.assertEqual(client.get(route+'?refresh=true',headers=self.headers).status_code,200)
        self.provider.next_season.assert_called_once_with('12345678',refresh=True)
        self.provider.season_overview.assert_called_once_with('12345678',refresh=True)

    def test_qr_routes_require_bearer_and_errors_use_fixed_public_messages(self):
        identifier='b'*32
        self.provider.qr_login.create=Mock(return_value={'id':identifier,'status':'waiting'})
        self.provider.qr_login.status=Mock(side_effect=QrLoginError('QR_EXPIRED','二维码已过期',410))
        self.provider.qr_login.cancel=Mock(return_value={'id':identifier,'status':'cancelled'})
        client=TestClient(create_app(self.provider,'a'*64))
        self.assertEqual(client.post('/account/qr').status_code,401)
        self.assertEqual(client.get('/account/qr/'+identifier).status_code,401)
        self.assertEqual(client.delete('/account/qr/'+identifier).status_code,401)
        self.assertEqual(client.post('/account/qr',headers=self.headers).json()['status'],'waiting')
        result=client.get('/account/qr/'+identifier,headers=self.headers)
        self.assertEqual(result.status_code,410);self.assertEqual(result.json()['error']['code'],'QR_EXPIRED')
        self.assertEqual(client.delete('/account/qr/'+identifier,headers=self.headers).json()['status'],'cancelled')

if __name__=='__main__':unittest.main()
