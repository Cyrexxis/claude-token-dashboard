import { Component, type ReactNode } from "react";

/** Shows a render error in place of the subtree instead of unmounting the whole page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <section className="card">
        <h2>Something went wrong</h2>
        <p className="error">{error.message}</p>
        <button type="button" onClick={() => location.reload()}>
          Reload
        </button>
      </section>
    );
  }
}
