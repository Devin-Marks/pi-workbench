import { useState } from "react";
import { useProjectStore } from "../store/project-store";
import { useSessionStore } from "../store/session-store";
import { ProjectPicker } from "./ProjectPicker";
import { SessionList } from "./SessionList";

export function ProjectSidebar() {
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const collapsed = useProjectStore((s) => s.collapsed);
  const setActive = useProjectStore((s) => s.setActive);
  const toggleCollapsed = useProjectStore((s) => s.toggleCollapsed);
  const remove = useProjectStore((s) => s.remove);
  const rename = useProjectStore((s) => s.rename);
  const sessionsByProject = useSessionStore((s) => s.byProject);
  const [showPicker, setShowPicker] = useState(false);
  const [renamingId, setRenamingId] = useState<string | undefined>();
  const [renameValue, setRenameValue] = useState("");

  /**
   * Two-stage delete confirm: if the project has live sessions, demand the
   * user dispose them first (otherwise the on-disk JSONLs become orphaned
   * — see DEFERRED.md "known holes" entry for project-delete).
   */
  const handleDelete = (id: string, name: string): void => {
    const list = sessionsByProject[id] ?? [];
    const liveCount = list.filter((s) => s.isLive).length;
    if (liveCount > 0) {
      alert(
        `Cannot delete "${name}" — it has ${liveCount} live session${liveCount === 1 ? "" : "s"}. ` +
          `Dispose ${liveCount === 1 ? "it" : "them"} first (× next to each session in the sidebar), then try again.`,
      );
      return;
    }
    const ok = confirm(
      `Remove project "${name}" from the workbench?\n\nOn-disk session files (under the project's .pi/sessions/ dir) are NOT deleted — they become orphaned and can be recovered manually.`,
    );
    if (ok) void remove(id);
  };

  const submitRename = async (id: string): Promise<void> => {
    const v = renameValue.trim();
    if (v.length === 0) {
      setRenamingId(undefined);
      return;
    }
    try {
      await rename(id, v);
    } finally {
      setRenamingId(undefined);
      setRenameValue("");
    }
  };

  return (
    <aside className="flex h-full w-64 flex-col border-r border-neutral-800 bg-neutral-950">
      <header className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Projects
        </span>
        <button
          onClick={() => setShowPicker(true)}
          className="rounded-md border border-neutral-700 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-800"
        >
          + New
        </button>
      </header>

      <div className="flex-1 overflow-y-auto py-1">
        {projects.length === 0 && (
          <p className="px-3 py-4 text-sm text-neutral-500">No projects yet.</p>
        )}
        {projects.map((p) => {
          const isActive = p.id === activeProjectId;
          const isCollapsed = collapsed[p.id] ?? false;
          return (
            <div key={p.id} className="px-1">
              <div
                className={`group flex items-center gap-1 rounded-md px-2 py-1 text-sm ${
                  isActive
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-300 hover:bg-neutral-900"
                }`}
              >
                <button
                  onClick={() => toggleCollapsed(p.id)}
                  className="text-neutral-500"
                  title={isCollapsed ? "Expand" : "Collapse"}
                >
                  {isCollapsed ? "▸" : "▾"}
                </button>
                {renamingId === p.id ? (
                  <input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => void submitRename(p.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submitRename(p.id);
                      if (e.key === "Escape") setRenamingId(undefined);
                    }}
                    autoFocus
                    className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-sm"
                  />
                ) : (
                  <button
                    onClick={() => setActive(p.id)}
                    onDoubleClick={() => {
                      setRenamingId(p.id);
                      setRenameValue(p.name);
                    }}
                    className="flex-1 truncate text-left"
                    title={p.path}
                  >
                    {p.name}
                  </button>
                )}
                <button
                  onClick={() => handleDelete(p.id, p.name)}
                  className="hidden text-xs text-neutral-500 hover:text-red-400 group-hover:inline"
                  title="Delete project (blocked while live sessions exist)"
                >
                  ×
                </button>
              </div>
              {!isCollapsed && <SessionList projectId={p.id} />}
            </div>
          );
        })}
      </div>

      {showPicker && <ProjectPicker onClose={() => setShowPicker(false)} />}
    </aside>
  );
}
