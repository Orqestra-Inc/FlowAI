import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

/** Never fail to a blank page: show what broke and how to recover. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; where: string }> {
  state = { error: null as Error | null, where: '' };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('[orqestra] UI error:', error, info.componentStack);
    const where = [error.stack?.split('\n').slice(0, 4).join('\n'), info.componentStack?.trim().split('\n').slice(0, 4).join('\n')].filter(Boolean).join('\n---\n');
    this.setState({ where });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="boot">
        <p className="error">Something went wrong on this page: {this.state.error.message}</p>
        {this.state.where && <pre className="trace">{this.state.where}</pre>}
        <p className="hint">Browser: {navigator.userAgent}</p>
        <button className="primary" onClick={() => location.reload()}>Reload</button>
      </main>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
