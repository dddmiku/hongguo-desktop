import { StrictMode, Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Renderer error', error, info.componentStack); }
  render() { return this.state.error ? <div className="app-failure"><h1>界面遇到了问题</h1><p>{this.state.error}</p><button className="btn primary" onClick={() => location.reload()}>重新打开界面</button></div> : this.props.children; }
}

createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>);
