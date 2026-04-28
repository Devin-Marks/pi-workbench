import { useEffect } from "react";
import { useAuthStore } from "./store/auth-store";
import { useProjectStore } from "./store/project-store";
import { LoginScreen } from "./components/LoginScreen";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { ProjectPicker } from "./components/ProjectPicker";

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

  const active = projects.find((p) => p.id === activeProjectId);

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
        <button
          onClick={logout}
          className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500"
        >
          Sign out
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <ProjectSidebar />
        <main className="flex flex-1 items-center justify-center px-6 text-center">
          {projectsLoaded && projects.length === 0 ? (
            <ProjectPicker required onClose={() => undefined} />
          ) : active ? (
            <div className="space-y-2 text-sm text-neutral-400">
              <h2 className="text-xl font-semibold text-neutral-100">{active.name}</h2>
              <p className="font-mono text-xs">{active.path}</p>
              <p>Sessions and chat land in Phase 4.</p>
            </div>
          ) : (
            <p className="text-sm text-neutral-400">Select a project from the sidebar.</p>
          )}
        </main>
      </div>
    </div>
  );
}
