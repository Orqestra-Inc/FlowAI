import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

/** Never fail to a blank page: show what broke and how to recover. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error('[orqestra] UI error:', error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="boot">
        <p className="error">Something went wrong on this page: {this.state.error.message}</p>
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
