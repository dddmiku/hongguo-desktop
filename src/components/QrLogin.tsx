import { CheckCircle2, Clock3, LoaderCircle, QrCode, RefreshCw, Smartphone, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Session } from '../../shared/contracts';
import { QrLoginController, type QrLoginView } from '../account/QrLoginController';
import './QrLogin.css';

const initial: QrLoginView = { id: '', status: 'idle', expiresAt: 0, pollAfter: 1.5, message: '正在准备扫码登录' };
const ended = new Set(['confirmed', 'expired', 'cancelled', 'failed']);

export default function QrLogin({ onConfirmed }: { onConfirmed: (session: Session) => void }) {
  const [view, setView] = useState<QrLoginView>(initial), [now, setNow] = useState(Date.now());
  const controller = useRef<QrLoginController | null>(null), confirmed = useRef(onConfirmed);
  confirmed.current = onConfirmed;

  useEffect(() => {
    let active = true;
    const flow = new QrLoginController({
      request: (path, options) => window.hongguo.request(path, options),
      onState: value => { if (active) { setView(value); setNow(Date.now()); } },
      onConfirmed: session => { if (active) confirmed.current(session); },
    });
    controller.current = flow;
    const visibility = () => flow.setVisible(!document.hidden);
    const offVisibility=window.hongguo.onVisibility?.(value=>flow.setVisible(value&&!document.hidden));
    visibility();
    document.addEventListener('visibilitychange', visibility);
    void flow.start();
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', visibility);
      offVisibility?.();
      controller.current = null;
      flow.close();
    };
  }, []);

  useEffect(() => {
    if (!view.expiresAt || ended.has(view.status)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [view.expiresAt, view.status]);

  const source = view.imageDataUrl && view.imageDataUrl.length <= 1024 * 1024
    && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(view.imageDataUrl) ? view.imageDataUrl : undefined;
  const seconds = Math.max(0, Math.ceil(view.expiresAt - now / 1000));
  const pending = view.status === 'loading' || view.status === 'verifying';
  const covered = view.status === 'scanned' || view.status === 'verifying';
  const placeholder = view.status === 'loading' ? '正在生成二维码' : view.status === 'expired' ? '二维码已过期'
    : view.status === 'cancelled' ? '扫码已取消' : view.status === 'failed' ? '暂时无法扫码' : '准备扫码登录';

  return <section className={`qr-login qr-login-${view.status}`} id="account-qr-panel" role="tabpanel" aria-labelledby="account-login-qr">
    <div className="qr-login-code">
      {source ? <img src={source} alt="登录二维码，请用手机红果短剧 App 扫描" draggable={false} /> : <div className="qr-login-placeholder">
        {view.status === 'loading' ? <LoaderCircle className="qr-login-spinner" size={32} aria-hidden /> : view.status === 'expired' ? <Clock3 size={32} aria-hidden /> : <QrCode size={34} aria-hidden />}
        <span>{placeholder}</span>
      </div>}
      {covered && <div className="qr-login-cover">
        {view.status === 'scanned' ? <CheckCircle2 size={32} aria-hidden /> : <LoaderCircle className="qr-login-spinner" size={32} aria-hidden />}
        <strong>{view.status === 'scanned' ? '扫码成功' : '正在连接手机记录'}</strong>
        {view.status === 'scanned' && <span>请在手机上确认登录</span>}
      </div>}
    </div>
    <p className={`qr-login-status${view.error ? ' has-error' : ''}`} role={view.error ? 'alert' : 'status'} aria-live="polite">
      <span className="qr-login-dot" aria-hidden />{view.message || '使用红果短剧 App 扫码登录'}
    </p>
    <p className="qr-login-expiry">{view.expiresAt > 0 && !ended.has(view.status) ? seconds ? `${seconds} 秒后失效` : '二维码已到期，请刷新' : '二维码仅用于本次登录'}</p>
    <div className="qr-login-actions">
      <button className="btn primary" type="button" disabled={pending} onClick={() => void controller.current?.start()}><RefreshCw size={15} />{view.status === 'loading' ? '生成中…' : view.status === 'verifying' ? '连接中…' : view.status === 'cancelled' || view.status === 'idle' ? '生成二维码' : '刷新二维码'}</button>
      <button className="btn secondary" type="button" disabled={view.status === 'idle' || ended.has(view.status)} onClick={() => controller.current?.cancel()}><X size={15} />取消扫码</button>
    </div>
    <div className="qr-login-guide"><Smartphone size={18} aria-hidden /><div><strong>使用手机红果短剧 App</strong><p>「我的」→ 右上角菜单 →「扫一扫」</p><p>扫描上方二维码，并在手机确认登录。</p></div></div>
  </section>;
}
