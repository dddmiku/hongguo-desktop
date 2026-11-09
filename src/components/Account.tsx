import { CheckCircle2, ChevronRight, Clock3, Copy, LogOut, QrCode, ShieldCheck, Smartphone, UserRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Session } from '../../shared/contracts';
import { Failure, Loading, message } from './ui';
import QrLogin from './QrLogin';

interface MfaChallenge {
  mfaRequired: true; challengeId: string; mobile: string; requiresManualSms: boolean;
  directions: { recipient: string; text: string }[]; message: string; pending?: boolean;
}

export default function Account({ onLibrary, notify }: { onLibrary: () => Promise<void>; notify: (text: string) => void }) {
  const [session, setSession] = useState<Session | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [mobile, setMobile] = useState(''), [code, setCode] = useState(''), [mfa, setMfa] = useState<MfaChallenge | null>(null);
  const [sending, setSending] = useState(false), [logging, setLogging] = useState(false), [sent, setSent] = useState(false);
  const [loginMode, setLoginMode] = useState<'sms' | 'qr'>('sms');
  const [cooldown, setCooldown] = useState(() => { try { return Math.max(0, Math.ceil((Number(sessionStorage.getItem('hongguo:sms-cooldown')) - Date.now()) / 1000)); } catch { return 0; } });
  const generation = useRef(0), mounted = useRef(true);
  const load = async () => {
    const id = ++generation.current; setLoading(true); setError('');
    try { const data = await window.hongguo.request<Session>('/account/session'); if (id === generation.current && mounted.current) setSession(data); }
    catch (e) { if (id === generation.current && mounted.current) setError(message(e)); }
    finally { if (id === generation.current && mounted.current) setLoading(false); }
  };
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => { if (!cooldown) return; const timer = setTimeout(() => setCooldown(v => Math.max(0, v - 1)), 1000); return () => clearTimeout(timer); }, [cooldown]);
  const finishLogin = async (value: Session) => { setSession(value); setMfa(null); setCode(''); notify('登录成功，正在同步观看记录与收藏'); await onLibrary(); };
  const selectLoginMode = (mode: 'sms' | 'qr', focus = false) => {
    if (sending || logging) return;
    setLoginMode(mode); setError('');
    if (focus) requestAnimationFrame(() => document.getElementById(`account-login-${mode}`)?.focus());
  };
  const modeKey = (event: React.KeyboardEvent) => {
    if (sending || logging || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); selectLoginMode(event.key === 'ArrowLeft' || event.key === 'Home' ? 'sms' : 'qr', true);
  };

  const send = async () => {
    if (sending || logging || cooldown || !/^1[3-9]\d{9}$/.test(mobile)) return;
    setSending(true); setError('');
    try {
      const data = await window.hongguo.request<{ retryAfter?: number }>('/account/send-code', { method: 'POST', body: { mobile } });
      if (!mounted.current) return;
      const wait = Math.max(1, data.retryAfter || 60); setCooldown(wait); setSent(true);
      try { sessionStorage.setItem('hongguo:sms-cooldown', String(Date.now() + wait * 1000)); } catch { /* Optional display state. */ }
      notify('验证码已发送，请查看手机短信');
    } catch (e) { if (mounted.current) setError(message(e)); }
    finally { if (mounted.current) setSending(false); }
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault(); if (logging || sending) return; setLogging(true); setError('');
    try {
      const result = await window.hongguo.request<Session | MfaChallenge>('/account/login', { method: 'POST', body: { mobile, code } });
      if (!mounted.current) return;
      if ('mfaRequired' in result) { setMfa(result); notify('账号需要短信安全验证，请按页面指引完成'); }
      else await finishLogin(result);
    } catch (e) { if (mounted.current) setError(message(e)); }
    finally { if (mounted.current) setLogging(false); }
  };

  const showInstructions = async () => {
    if (!mfa || sending || logging) return; setSending(true); setError('');
    try {
      const result = await window.hongguo.request<MfaChallenge>('/account/mfa/send', { method: 'POST', body: { mobile, code, challengeId: mfa.challengeId } });
      if (mounted.current) { setMfa(result); notify('请使用手机自带短信应用，按指引发送验证短信'); }
    } catch (e) { if (mounted.current) setError(message(e)); }
    finally { if (mounted.current) setSending(false); }
  };

  const verify = async () => {
    if (!mfa || logging || sending || code.length < 4) return; setLogging(true); setError('');
    try {
      const result = await window.hongguo.request<Session | MfaChallenge>('/account/mfa/verify', { method: 'POST', body: { mobile, code, challengeId: mfa.challengeId } });
      if (!mounted.current) return;
      if ('mfaRequired' in result) { setMfa(result); setError(result.message); }
      else await finishLogin(result);
    } catch (e) { if (mounted.current) setError(message(e)); }
    finally { if (mounted.current) setLogging(false); }
  };

  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); notify('已复制'); } catch { notify('未能复制，请手动选择文字复制'); } };
  const logout = async () => {
    if (logging) return; setLogging(true); setError('');
    try { await window.hongguo.request('/account/logout', { method: 'POST' }); if (!mounted.current) return; await load(); await onLibrary(); notify('已退出账号'); }
    catch (e) { if (mounted.current) setError(message(e)); }
    finally { if (mounted.current) setLogging(false); }
  };

  return <div className="account-page"><div className="page-heading"><div><h1>我的账号</h1><p>让喜欢的故事，跟着你走。</p></div></div>
    {loading ? <Loading text="正在读取登录状态…" /> : !session && error ? <Failure text={error} retry={load} /> : <div className="account-layout"><section className="account-card">
      {session?.loggedIn ? <>
        <div className="account-avatar">{session.avatar ? <img src={session.avatar} alt="头像" /> : <UserRound size={36} />}</div>
        <span className="account-label"><CheckCircle2 size={14} />已登录红果账号</span><h2>{session.nickname || '红果用户'}</h2>
        <p className="account-phone">{session.mobile || (session.uid ? `UID ${session.uid}` : '')}</p><div className="account-divider" />
        <p className="account-description">观看历史和收藏会在电脑与手机间同步。你可以随时在本机继续观看。</p>
        <button className="btn secondary" onClick={logout} disabled={logging}><LogOut size={16} />{logging ? '正在退出…' : '退出登录'}</button>
      </> : mfa ? <>
        <div className="account-avatar"><ShieldCheck size={35} /></div><h2>短信安全验证</h2>
        <p className="account-description">使用 {mfa.mobile} 的系统短信应用发送下方文字，然后回到电脑完成验证。无需安装红果手机应用。</p>
        <div className="login-form" style={{ display: 'grid', gap: 12 }}>
          {mfa.directions.length ? mfa.directions.map((direction, index) => <section key={index} style={{ display: 'grid', gap: 10 }}>
            <label>发送到</label><div className="code-input"><input className="field" value={direction.recipient} readOnly aria-label="验证短信接收号码" /><button className="btn secondary" type="button" onClick={() => void copy(direction.recipient)} aria-label="复制接收号码"><Copy size={16} /></button></div>
            <label>短信内容</label><div className="code-input"><input className="field" value={direction.text} readOnly aria-label="验证短信内容" /><button className="btn secondary" type="button" onClick={() => void copy(direction.text)} aria-label="复制短信内容"><Copy size={16} /></button></div>
          </section>) : <p className="field-hint">服务端未提供可用的短信指引，请返回重新登录。</p>}
          <p className="field-hint">按手机运营商标准短信资费发送。请保留首次收到的登录验证码，不要重新获取。</p>
          <label htmlFor="mfa-code">首次收到的登录验证码</label><input id="mfa-code" className="field" inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={8} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} disabled={logging} />
          <button className="btn primary login-submit" type="button" disabled={logging || sending || code.length < 4 || !mfa.directions.length} onClick={verify}>{logging ? '正在确认验证…' : '我已发送，完成验证'}<ChevronRight size={18} /></button>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button className="btn secondary" type="button" onClick={showInstructions} disabled={logging || sending}>{sending ? '读取中…' : '重新查看发送指引'}</button>
            <button className="btn secondary" type="button" disabled={logging || sending} onClick={() => { setMfa(null); setCode(''); setError(''); }}>返回重新登录</button>
          </div>
        </div>
      </> : <>
        <div className="account-avatar">{loginMode === 'qr' ? <QrCode size={35} /> : <Smartphone size={35} />}</div><h2>登录红果账号</h2><p className="account-description">使用验证码或手机 App 扫码，同步你的追剧进度。</p>
        <div className="account-login-tabs" role="tablist" aria-label="选择登录方式" onKeyDown={modeKey}>
          <button id="account-login-sms" type="button" role="tab" aria-selected={loginMode === 'sms'} aria-controls="account-sms-panel" tabIndex={loginMode === 'sms' ? 0 : -1} disabled={sending || logging} onClick={() => selectLoginMode('sms')}><Smartphone size={15} />验证码登录</button>
          <button id="account-login-qr" type="button" role="tab" aria-selected={loginMode === 'qr'} aria-controls="account-qr-panel" tabIndex={loginMode === 'qr' ? 0 : -1} disabled={sending || logging} onClick={() => selectLoginMode('qr')}><QrCode size={15} />扫码登录</button>
        </div>
        {loginMode === 'qr' ? <QrLogin onConfirmed={value => { void finishLogin(value).catch(e => { if (mounted.current) setError(message(e)); }); }} /> : <form id="account-sms-panel" role="tabpanel" aria-labelledby="account-login-sms" onSubmit={login} className="login-form"><label htmlFor="mobile">手机号</label><div className="phone-input"><span>+86</span><input id="mobile" className="field" type="tel" inputMode="tel" autoComplete="tel-national" placeholder="请输入 11 位手机号" maxLength={11} value={mobile} onChange={event => { setMobile(event.target.value.replace(/\D/g, '')); setSent(false); }} disabled={logging || sending} required pattern="1[3-9][0-9]{9}" /></div>
          <label htmlFor="code">短信验证码</label><div className="code-input"><input id="code" className="field" inputMode="numeric" autoComplete="one-time-code" placeholder="验证码" value={code} maxLength={8} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} required minLength={4} disabled={logging} /><button className="btn secondary" type="button" disabled={sending || logging || !!cooldown || !/^1[3-9]\d{9}$/.test(mobile)} onClick={send}>{sending ? '发送中…' : cooldown ? `${cooldown}s 后重发` : sent ? '重新发送' : '获取验证码'}</button></div>
          {sent && <p className="field-hint"><Clock3 size={13} />验证码已发送，请在有效期内填写。</p>}
          <button className="btn primary login-submit" disabled={logging || sending || !/^1[3-9]\d{9}$/.test(mobile) || code.length < 4} type="submit">{logging ? '正在验证…' : '登录并同步'}<ChevronRight size={18} /></button>
        </form>}
      </>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </section><aside className="account-benefits"><span className="eyebrow">多端同步</span><h2>换个屏幕，<br />故事接着看。</h2><div><Clock3 size={24} /><section><h3>进度随行</h3><p>在电脑继续手机上未看完的那一集。</p></section></div><div><CheckCircle2 size={24} /><section><h3>喜欢的，都在一起</h3><p>登录后同步收藏，轻松找到正在追的剧。</p></section></div><div><ShieldCheck size={24} /><section><h3>本地记录随时可看</h3><p>没有网络时，也能查看本机保存的观看记录。</p></section></div></aside></div>}
  </div>;
}
