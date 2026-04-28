import { create } from "zustand";
import { api, ApiError, type FileTreeNode } from "../lib/api-client";

/**
 * Per-tab editor state. Tracks an in-memory `draft` separately from
 * `saved` so the dirty indicator and autosave logic don't fight: the
 * draft is what's in the textarea, `saved` is the last value we
 * successfully PUT to the server. `dirty = draft !== saved`.
 *
 * `loadingError` lets the editor render an error banner instead of an
 * empty textarea when a read fails (binary files surface here too —
 * the editor renders "Binary file" rather than letting the user paste
 * over zero bytes).
 */
export interface OpenFile {
  /** Absolute path on the server's filesystem. The single source of truth — paths are NOT normalised, so the same path string is used for read/write. */
  path: string;
  saved: string;
  draft: string;
  dirty: boolean;
  language: string;
  binary: boolean;
  saving: boolean;
  /** Last successful save timestamp (ms). Drives the "Saved at hh:mm:ss" hint. */
  savedAt: number | undefined;
  loadingError: string | undefined;
}

interface FileState {
  /** Most-recently-fetched tree, keyed by projectId. */
  treeByProject: Record<string, FileTreeNode | undefined>;
  /** Loading flag per project so the panel can spinner during refreshes. */
  treeLoading: Record<string, boolean>;
  /** Open editor tabs, in user-visible order. */
  openFiles: OpenFile[];
  /** Path of the currently-active tab. */
  activePath: string | undefined;
  /** Last error code surfaced by an API call (sticky until next op). */
  error: string | undefined;

  loadTree: (projectId: string) => Promise<void>;
  openFile: (projectId: string, absPath: string) => Promise<void>;
  closeFile: (path: string) => void;
  setActiveFile: (path: string | undefined) => void;
  updateDraft: (path: string, draft: string) => void;
  saveFile: (projectId: string, path: string) => Promise<void>;
  /**
   * Reload an open file from disk, discarding the in-memory draft. Used
   * after the agent edits a file the user has open. The route handler
   * should only call this when the tab is NOT dirty (i.e. agent edits
   * win silently). For dirty tabs, surface a banner via the
   * `externallyChanged` flag instead — see {@link markExternallyChanged}.
   */
  reloadFile: (projectId: string, path: string) => Promise<void>;
  /**
   * Mark a tab as having received an external change while dirty. The
   * editor renders a banner offering to discard or reload. Cleared by
   * the next successful saveFile or reloadFile, OR by an explicit
   * `dismissExternallyChanged` (the "Keep mine" affordance).
   */
  markExternallyChanged: (path: string) => void;
  /**
   * Dismiss the "external change" banner without reloading. The user's
   * draft stays in place and the next save will overwrite the
   * external change. Without this, the banner had no path back to
   * "the user knows and accepts" — clicking "Keep mine" was a no-op.
   */
  dismissExternallyChanged: (path: string) => void;
  externallyChanged: Record<string, boolean>;

  // Tree mutations — fire the route, then refresh the tree on success.
  createFile: (projectId: string, parentAbsPath: string, name: string) => Promise<string>;
  createFolder: (projectId: string, parentAbsPath: string, name: string) => Promise<void>;
  renameEntry: (projectId: string, absPath: string, newName: string) => Promise<string>;
  /**
   * Move `srcAbsPath` to `destAbsPath`. Caller is responsible for
   * computing the dest path (typically `<targetDir>/<basename(src)>`);
   * the server validates and rejects moves into the same dir, into a
   * descendant, or onto an existing target. Open tabs whose path
   * matches `srcAbsPath` get patched in place to the new path so the
   * editor stays open without a flash.
   */
  moveEntry: (projectId: string, srcAbsPath: string, destAbsPath: string) => Promise<string>;
  deleteEntry: (projectId: string, absPath: string) => Promise<void>;
}

export const EMPTY_OPEN_FILES: OpenFile[] = [];

export const useFileStore = create<FileState>((set, get) => ({
  treeByProject: {},
  treeLoading: {},
  openFiles: [],
  activePath: undefined,
  error: undefined,
  externallyChanged: {},

  loadTree: async (projectId) => {
    set((s) => ({ treeLoading: { ...s.treeLoading, [projectId]: true }, error: undefined }));
    try {
      const tree = await api.filesTree(projectId);
      set((s) => ({
        treeByProject: { ...s.treeByProject, [projectId]: tree },
        treeLoading: { ...s.treeLoading, [projectId]: false },
      }));
    } catch (err) {
      set((s) => ({
        treeLoading: { ...s.treeLoading, [projectId]: false },
        error: err instanceof ApiError ? err.code : (err as Error).message,
      }));
    }
  },

  openFile: async (projectId, absPath) => {
    // If already open, just activate.
    const existing = get().openFiles.find((f) => f.path === absPath);
    if (existing !== undefined) {
      set({ activePath: absPath });
      return;
    }
    set({ error: undefined });
    try {
      const r = await api.filesRead(projectId, absPath);
      const tab: OpenFile = {
        path: absPath,
        saved: r.content,
        draft: r.content,
        dirty: false,
        language: r.language,
        binary: r.binary,
        saving: false,
        savedAt: undefined,
        loadingError: r.binary ? "Binary file — open externally to edit." : undefined,
      };
      set((s) => ({
        openFiles: [...s.openFiles, tab],
        activePath: absPath,
      }));
    } catch (err) {
      set({ error: err instanceof ApiError ? err.code : (err as Error).message });
    }
  },

  closeFile: (path) => {
    set((s) => {
      const idx = s.openFiles.findIndex((f) => f.path === path);
      if (idx === -1) return {};
      const next = s.openFiles.slice(0, idx).concat(s.openFiles.slice(idx + 1));
      const activePath =
        s.activePath === path ? (next[idx] ?? next[idx - 1] ?? next[0])?.path : s.activePath;
      const ext = { ...s.externallyChanged };
      delete ext[path];
      return { openFiles: next, activePath, externallyChanged: ext };
    });
  },

  setActiveFile: (path) => set({ activePath: path }),

  updateDraft: (path, draft) => {
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.path === path ? { ...f, draft, dirty: draft !== f.saved } : f,
      ),
    }));
  },

  saveFile: async (projectId, path) => {
    const file = get().openFiles.find((f) => f.path === path);
    if (file === undefined || file.binary) return;
    set((s) => ({
      openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, saving: true } : f)),
      error: undefined,
    }));
    try {
      await api.filesWrite(projectId, path, file.draft);
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === path
            ? { ...f, saving: false, saved: f.draft, dirty: false, savedAt: Date.now() }
            : f,
        ),
        externallyChanged: omitKey(s.externallyChanged, path),
      }));
    } catch (err) {
      set((s) => ({
        openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, saving: false } : f)),
        error: err instanceof ApiError ? err.code : (err as Error).message,
      }));
      throw err;
    }
  },

  reloadFile: async (projectId, path) => {
    set({ error: undefined });
    try {
      const r = await api.filesRead(projectId, path);
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === path
            ? {
                ...f,
                saved: r.content,
                draft: r.content,
                dirty: false,
                language: r.language,
                binary: r.binary,
                loadingError: r.binary ? "Binary file — open externally to edit." : undefined,
              }
            : f,
        ),
        externallyChanged: omitKey(s.externallyChanged, path),
      }));
    } catch (err) {
      set({ error: err instanceof ApiError ? err.code : (err as Error).message });
    }
  },

  markExternallyChanged: (path) => {
    set((s) => ({ externallyChanged: { ...s.externallyChanged, [path]: true } }));
  },

  dismissExternallyChanged: (path) => {
    set((s) => ({ externallyChanged: omitKey(s.externallyChanged, path) }));
  },

  createFile: async (projectId, parentAbsPath, name) => {
    set({ error: undefined });
    try {
      const dest = `${parentAbsPath}/${name}`;
      await api.filesWrite(projectId, dest, "");
      await get().loadTree(projectId);
      return dest;
    } catch (err) {
      set({ error: err instanceof ApiError ? err.code : (err as Error).message });
      throw err;
    }
  },

  createFolder: async (projectId, parentAbsPath, name) => {
    set({ error: undefined });
    try {
      await api.filesMkdir(projectId, parentAbsPath, name);
      await get().loadTree(projectId);
    } catch (err) {
      set({ error: err instanceof ApiError ? err.code : (err as Error).message });
      throw err;
    }
  },

  renameEntry: async (projectId, absPath, newName) => {
    set({ error: undefined });
    try {
      const { path } = await api.filesRename(projectId, absPath, newName);
      // Update any open tab whose path matches: server returns the new
      // canonical path; we patch the in-memory tab in place.
      set((s) => ({
        openFiles: s.openFiles.map((f) => (f.path === absPath ? { ...f, path } : f)),
        activePath: s.activePath === absPath ? path : s.activePath,
      }));
      await get().loadTree(projectId);
      return path;
    } catch (err) {
      set({ error: err instanceof ApiError ? err.code : (err as Error).message });
      throw err;
    }
  },

  moveEntry: async (projectId, srcAbsPath, destAbsPath) => {
    set({ error: undefined });
    try {
      const { path } = await api.filesMove(projectId, srcAbsPath, destAbsPath);
      // Patch any open tab whose path matches the source — also patch
      // tabs whose path was UNDER the moved directory (e.g. moving
      // `src/` to `lib/src/` should retarget every open `src/foo.ts`
      // tab to `lib/src/foo.ts`).
      set((s) => ({
        openFiles: s.openFiles.map((f) => {
          if (f.path === srcAbsPath) return { ...f, path };
          const prefix = `${srcAbsPath}/`;
          if (f.path.startsWith(prefix)) {
            return { ...f, path: `${path}/${f.path.slice(prefix.length)}` };
          }
          return f;
        }),
        activePath:
          s.activePath === srcAbsPath
            ? path
            : s.activePath !== undefined && s.activePath.startsWith(`${srcAbsPath}/`)
              ? `${path}/${s.activePath.slice(srcAbsPath.length + 1)}`
              : s.activePath,
      }));
      await get().loadTree(projectId);
      return path;
    } catch (err) {
      set({ error: err instanceof ApiError ? err.code : (err as Error).message });
      throw err;
    }
  },

  deleteEntry: async (projectId, absPath) => {
    set({ error: undefined });
    try {
      await api.filesDelete(projectId, absPath);
      // Close any tab the user had open on this path.
      const open = get().openFiles.find((f) => f.path === absPath);
      if (open !== undefined) get().closeFile(absPath);
      await get().loadTree(projectId);
    } catch (err) {
      set({ error: err instanceof ApiError ? err.code : (err as Error).message });
      throw err;
    }
  },
}));

function omitKey<V>(record: Record<string, V>, key: string): Record<string, V> {
  if (record[key] === undefined) return record;
  const next = { ...record };
  delete next[key];
  return next;
}
