import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

// ErrorBoundary catches uncaught render/lifecycle errors anywhere in
// the tree and shows a recoverable fallback instead of white-screening
// the whole app. MapLibre style errors, stale protobuf decodes, and
// data-shape surprises have all produced render crashes in the past;
// this keeps the app recoverable without a page reload.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#111013",
          color: "#f2efe6",
          fontFamily: "'B612', system-ui, sans-serif",
          padding: "2rem",
          zIndex: 9999,
        }}
      >
        <div
          style={{
            maxWidth: 640,
            background: "#1b1a1e",
            border: "2px solid #eae6d9",
            boxShadow: "6px 6px 0 #0a0a0a",
            padding: "1.5rem",
          }}
        >
          <h1
            style={{
              marginTop: 0,
              fontSize: "1.4rem",
              fontFamily: "'Archivo Black', 'Arial Black', sans-serif",
              textTransform: "uppercase",
            }}
          >
            Something broke
          </h1>
          <p>The map ran into an unexpected error.</p>
          <pre
            style={{
              background: "#26242b",
              border: "2px solid #eae6d9",
              padding: "0.75rem",
              overflow: "auto",
              maxHeight: 240,
              fontSize: "0.85rem",
            }}
          >
            {error.message}
          </pre>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
            <button onClick={this.handleReset}>Dismiss</button>
            <button onClick={this.handleReload}>Reload page</button>
          </div>
        </div>
      </div>
    );
  }
}
