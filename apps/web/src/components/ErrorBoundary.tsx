import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertOctagon } from 'lucide-react';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('NAV UI error', error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="mx-auto my-16 max-w-lg rounded-lg border border-danger/30 bg-danger-soft p-6 text-center">
        <AlertOctagon className="mx-auto mb-3 size-6 text-danger" />
        <h2 className="text-[15px] font-semibold text-fg">This view crashed</h2>
        <p className="mt-1 text-[13px] text-fg-muted">NAV hit an unexpected error rendering this page.</p>
        <pre className="mt-4 overflow-x-auto rounded-md bg-bg p-3 text-left font-mono text-xs text-fg-muted">{this.state.error.message}</pre>
        <div className="mt-4 flex justify-center gap-2">
          <button className="h-8 rounded-lg border border-border bg-surface-2 px-3 text-[13px]" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button className="h-8 rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg" onClick={() => window.location.assign('/app')}>
            Back to dashboard
          </button>
        </div>
      </div>
    );
  }
}
