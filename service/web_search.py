"""Anonymous official website search; titles are candidates, never season links."""
from __future__ import annotations

import re
import threading
import requests
from urllib.parse import urlsplit

ORIGIN='https://hongguoduanju.com'

class WebSearchError(RuntimeError):
    pass

class WebPlaybackError(RuntimeError):
    def __init__(self,code,message):
        self.code=code
        super().__init__(message)

class OfficialWebSearch:
    def __init__(self, transport=None):
        self.transport=transport
        self.local=threading.local()

    def _get(self,path,query):
        query=str(query or '').strip()
        if not 1<=len(query)<=80 or any(ord(char)<32 for char in query):
            raise ValueError('搜索关键词格式不正确')
        if self.transport:
            value=self.transport(path,{'aid':'8662','query':query})
        else:
            session=getattr(self.local,'session',None)
            if session is None:
                session=requests.Session();session.trust_env=False
                session.headers.update({'User-Agent':'Mozilla/5.0','Referer':ORIGIN+'/'})
                self.local.session=session
            try:
                response=session.get(ORIGIN+path,params={'aid':'8662','query':query},timeout=(4,6),allow_redirects=False)
                if response.status_code!=200 or len(response.content)>2*1024*1024:
                    raise WebSearchError('官网搜索暂时不可用')
                value=response.json()
            except (requests.RequestException,ValueError):
                raise WebSearchError('官网搜索暂时不可用') from None
        if not isinstance(value,dict) or value.get('code') not in (None,0):
            raise WebSearchError('官网搜索暂时不可用')
        return value

    @staticmethod
    def _rows(value,key):
        rows=value.get(key)
        if not isinstance(rows,list):raise WebSearchError('官网搜索结果格式异常')
        result=[];seen=set()
        for item in rows[:100]:
            if not isinstance(item,dict):continue
            video=item.get('video_data')
            if isinstance(video,list):video=video[0] if video else None
            if not isinstance(video,dict):continue
            sid=str(video.get('series_id') or '')
            title=str(video.get('series_title') or '')
            # Text-only keyword suggestions can mention an unreleased season.
            # Without a real series ID it must not appear as a playable result.
            if not re.fullmatch(r'\d{8,24}',sid) or not title.strip() or sid in seen:continue
            seen.add(sid)
            result.append({'series_id':sid,'title':title[:200],
                           'cover':str(video.get('series_cover') or '')[:3000],
                           'episode_cnt':video.get('episode_cnt',0),
                           'intro':str(video.get('series_intro') or '')[:2000],
                           'category':video.get('category') or [],'score':video.get('score') or ''})
        return result

    def suggestions(self,query,max_items=8):
        return self._rows(self._get('/api/search/suggestion',query),'suggestionList')[:max(1,min(8,int(max_items)))]

    def search(self,query,max_items=40):
        return self._rows(self._get('/api/search/result',query),'searchList')[:max(1,min(40,int(max_items)))]

    def candidates(self,query):
        return self.suggestions(query,8)

    def playback_tracks(self,vid,series_id,episode,quality,cancelled=None,*,session=None):
        """Use the official playback APIs; denied episodes never become preview substitutes."""
        if not re.fullmatch(r'\d{8,24}',str(vid)) or not re.fullmatch(r'\d{8,24}',str(series_id)):
            raise ValueError('播放参数不正确')
        def check():
            if cancelled and cancelled():raise WebPlaybackError('MEDIA_CANCELLED','已取消播放准备')
        credentials=session or {}
        headers={'User-Agent':'Mozilla/5.0','Referer':ORIGIN+'/player/'+str(series_id),'Origin':ORIGIN}
        if credentials.get('cookie'):headers['Cookie']=credentials['cookie']
        if credentials.get('token'):headers['x-tt-token']=credentials['token']
        for item in str(credentials.get('cookie') or '').split(';'):
            name,_,value=item.strip().partition('=')
            if name=='passport_csrf_token':headers['x-tt-passport-csrf-token']=value
        denied=False
        tracks=[];seen=set()
        for path in ('/api/video/protected/play-info','/api/video/protected/fallback-play-info'):
            check()
            body={'item_id':str(vid)}
            if path.endswith('/play-info'):body.update(series_id=str(series_id),definition=quality if quality!='auto' else '720p')
            try:
                client=requests.Session();client.trust_env=False
                with client:
                    response=client.post(ORIGIN+path,params={'aid':'8662'},json=body,headers=headers,timeout=(4,8),allow_redirects=False)
                if response.status_code in (401,403):denied=True;continue
                if response.status_code!=200 or len(response.content)>1024*1024:continue
                value=response.json();check()
                if not isinstance(value,dict) or value.get('base_resp',{}).get('StatusCode') not in (None,0):continue
                playable=value.get('legacy_play_info') or value
                if not isinstance(playable,dict):continue
                address=str(playable.get('main_url') or '')
                parsed=urlsplit(address)
                host=parsed.hostname or ''
                # Authorization stays within official search/playback and first-party VOD hosts.
                if parsed.scheme!='https' or parsed.username or parsed.password or not any(
                    host==domain or host.endswith('.'+domain) for domain in ('qznovelvod.com','snssdk.com','bytevod.com','bytedance.com','douyinvod.com','bytecdn.cn')):continue
                try:
                    dimensions=[int(playable.get(key) or 0) for key in ('width','height')]
                    dimensions=[value for value in dimensions if value>0]
                    short=min(dimensions) if dimensions else 0
                    actual=360 if short<=360 else 480 if short<=480 else 540 if short<=540 else 720 if short<=720 else 1080
                except (ValueError,TypeError):actual=720
                if address not in seen:
                    seen.add(address)
                    tracks.append({'video_meta':{'definition':str(actual)+'p','codec_type':'h264','size':0},
                         'main_url':address,'encrypt_info':{'encrypt':False},'_official_channel':'website'})
            except (requests.RequestException,ValueError,TypeError):continue
        check()
        if tracks:return tracks
        if denied:raise WebPlaybackError('WEB_PLAYBACK_RESTRICTED','官网暂未开放这集的播放权限，请使用已登录的手机来源')
        raise WebPlaybackError('WEB_PLAYBACK_UNAVAILABLE','官网播放线路暂时不可用，请重试当前集')
