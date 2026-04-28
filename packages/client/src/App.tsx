import { useEffect, useState } from "react";
import { useAuthStore } from "./store/auth-store";
import { useActiveProject, useProjectStore } from "./store/project-store";
import { useSessionStore } from "./store/session-store";
import { LoginScreen } from "./components/LoginScreen";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { ProjectPicker } from "./components/ProjectPicker";
import { ChatView } from "./components/ChatView";
import { ChatInput } from "./components/ChatInput";
import { SettingsPanel } from "./components/SettingsPanel";

const noop = (): void => undefined;

export function App() {
  const ready = useAuthStore((s) => s.ready);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const logout = useAuthStore((s) => s.logout);

  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projectsLoaded = useProjectStore((s) => !s.loading);
  const loadProjects = useProjectStore((s) => s.load);
  const setActive = useProjectStore((s) => s.setActive);
  const active = useActiveProject();

  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (isAuthenticated) void loadProjects();
  }, [isAuthenticated, loadProjects]);

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-neutral-400">
        Loading…
      </main>
    );
  }

  if (!isAuthenticated) return <LoginScreen />;

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold tracking-tight">pi web ui</span>
          {projects.length > 0 && (
            <select
              value={activeProjectId ?? ""}
              onChange={(e) => setActive(e.target.value || undefined)}
              className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500"
            title="Settings (providers, agent defaults, skills)"
          >
            Settings
          </button>
          <button
            onClick={logout}
            className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500"
          >
            Sign out
          </button>
        </div>
      </header>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}

      <div className="flex flex-1 overflow-hidden">
        <ProjectSidebar />
        <main className="flex flex-1 flex-col">
          {projectsLoaded && projects.length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              <ProjectPicker required onClose={noop} />
            </div>
          ) : activeSessionId !== undefined ? (
            <>
              <ChatView sessionId={activeSessionId} />
              <ChatInput sessionId={activeSessionId} />
            </>
          ) : active ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center">
              <div className="space-y-2 text-sm text-neutral-400">
                <h2 className="text-xl font-semibold text-neutral-100">{active.name}</h2>
                <p className="font-mono text-xs">{active.path}</p>
                <p>Pick a session from the sidebar — or click "+ New session" to start one.</p>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-sm text-neutral-400">Select a project from the sidebar.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
