import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import "./index.css";

// Auto-register the service worker (vite-plugin-pwa). `autoUpdate` mode
// silently swaps in new shells on the next reload — no banner needed.
registerSW({ immediate: true });

/**
 * Dev-time error boundary that renders the error visibly on the page when
 * a render throws. Without this, an uncaught React error in StrictMode
 * leaves the page blank — the very symptom we just hit. Production builds
 * keep this too: a visible error is better than a silent blank screen.
 */
class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Send to console AND POST to server so it lands in the dev-mode log.
    console.error("[pi-workbench] root render error", error, info);
    void fetch("/api/v1/health", { method: "GET" }).catch(() => undefined);
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <main
          style={{
            padding: "2rem",
            fontFamily: "monospace",
            color: "#fca5a5",
            background: "#0a0a0a",
            minHeight: "100vh",
            whiteSpace: "pre-wrap",
            overflow: "auto",
          }}
        >
          <h1 style={{ color: "#fff", marginBottom: "1rem" }}>pi-workbench: render crash</h1>
          <p style={{ color: "#d4d4d4", marginBottom: "1rem" }}>{this.state.error.message}</p>
          <pre style={{ fontSize: "11px", color: "#a3a3a3" }}>
            {this.state.error.stack ?? "(no stack)"}
          </pre>
          <p style={{ marginTop: "2rem", color: "#71717a", fontSize: "12px" }}>
            Tip: open the browser console for more detail. Try clearing localStorage (devtools →
            Application → Local Storage → Clear) and refreshing if the error mentions stale state.
          </p>
        </main>
      );
    }
    return this.props.children;
  }
}

window.addEventListener("error", (e) => {
  console.error("[pi-workbench] uncaught error", e.error);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[pi-workbench] unhandled rejection", e.reason);
});

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("#root element missing in index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
