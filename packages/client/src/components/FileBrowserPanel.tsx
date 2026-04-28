import { useEffect, useState, type DragEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useFileStore } from "../store/file-store";
import { useActiveProject } from "../store/project-store";
import type { FileTreeNode } from "../lib/api-client";

/**
 * Phase 10 file browser. A recursive tree of the active project's source
 * tree (with `node_modules` / `.git` / `dist` etc filtered server-side).
 *
 * Click a file → opens in EditorPanel. Click a folder → expands.
 * Toolbar at the top: refresh, new file, new folder. Hover a row for
 * rename / delete buttons. We deliberately skip a context menu in v1 —
 * inline icon buttons are good enough and avoid the right-click /
 * permissions dance for PWA installs.
 */
export function FileBrowserPanel() {
  const project = useActiveProject();
  const tree = useFileStore((s) =>
    project !== undefined ? s.treeByProject[project.id] : undefined,
  );
  const loading = useFileStore((s) =>
    project !== undefined ? (s.treeLoading[project.id] ?? false) : false,
  );
  const error = useFileStore((s) => s.error);
  const loadTree = useFileStore((s) => s.loadTree);
  const openFile = useFileStore((s) => s.openFile);
  const createFile = useFileStore((s) => s.createFile);
  const createFolder = useFileStore((s) => s.createFolder);
  const renameEntry = useFileStore((s) => s.renameEntry);
  const moveEntry = useFileStore((s) => s.moveEntry);
  const deleteEntry = useFileStore((s) => s.deleteEntry);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({ "": true });
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [renameDraft, setRenameDraft] = useState("");
  // Path of the directory currently being hovered as a drop target,
  // used to highlight the row. Cleared on dragleave/drop.
  const [dropTarget, setDropTarget] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (project !== undefined) void loadTree(project.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, loadTree]);

  if (project === undefined) {
    return (
      <div className="p-4 text-xs italic text-neutral-500">
        Select a project to browse its files.
      </div>
    );
  }

  const promptCreate = async (kind: "file" | "folder"): Promise<void> => {
    const name = window.prompt(`New ${kind} name (relative to project root):`);
    if (name === null || name.trim().length === 0) return;
    try {
      if (kind === "file") {
        const path = await createFile(project.id, project.path, name.trim());
        // Open the new file immediately so the user can start editing.
        await openFile(project.id, path);
      } else {
        await createFolder(project.id, project.path, name.trim());
      }
    } catch {
      // Error already in store; banner renders below.
    }
  };

  const startRename = (absPath: string, currentName: string): void => {
    setRenaming(absPath);
    setRenameDraft(currentName);
  };
  const commitRename = async (absPath: string): Promise<void> => {
    const name = renameDraft.trim();
    setRenaming(undefined);
    setRenameDraft("");
    if (name.length === 0) return;
    try {
      await renameEntry(project.id, absPath, name);
    } catch {
      // store.error renders
    }
  };

  const handleDelete = async (absPath: string, name: string, isDir: boolean): Promise<void> => {
    const what = isDir ? "directory" : "file";
    if (!window.confirm(`Delete ${what} "${name}"? This cannot be undone.`)) return;
    try {
      await deleteEntry(project.id, absPath);
    } catch {
      // store.error renders
    }
  };

  const onClickEntry = async (node: FileTreeNode): Promise<void> => {
    if (node.type === "directory") {
      setExpanded((e) => ({ ...e, [node.path]: !e[node.path] }));
      return;
    }
    await openFile(project.id, joinPath(project.path, node.path));
  };

  /**
   * Drop handler — `targetDirAbsPath` is the directory the user dropped
   * onto (or the project root when the drop hit the empty area). The
   * source path comes from `dataTransfer` set on dragstart. Same-dir
   * drops are no-ops; descendant drops surface the server's 400 via
   * the store's `error` slot.
   */
  const handleDrop = async (e: DragEvent<HTMLElement>, targetDirAbsPath: string): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(undefined);
    const src = e.dataTransfer.getData("application/x-pi-path");
    if (src.length === 0) return;
    // basename of src
    const name = src.split("/").pop() ?? "";
    if (name.length === 0) return;
    const dest = `${targetDirAbsPath}/${name}`;
    if (dest === src) return;
    // Refuse moving a directory into itself or a descendant — server
    // catches this too, but the client check skips a round trip.
    if (targetDirAbsPath === src || targetDirAbsPath.startsWith(`${src}/`)) return;
    try {
      await moveEntry(project.id, src, dest);
    } catch {
      // store.error renders banner
    }
  };

  return (
    <div className="flex h-full flex-col text-xs text-neutral-300">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <span className="truncate font-medium text-neutral-200" title={project.path}>
          {project.name}
        </span>
        <div className="flex gap-1">
          <button
            onClick={() => void promptCreate("file")}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            title="New file"
          >
            <FilePlus2 size={14} />
          </button>
          <button
            onClick={() => void promptCreate("folder")}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            title="New folder"
          >
            <FolderPlus size={14} />
          </button>
          <button
            onClick={() => void loadTree(project.id)}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>
      {error !== undefined && (
        <div className="border-b border-red-700/40 bg-red-900/20 px-3 py-1.5 text-[11px] text-red-300">
          {error}
        </div>
      )}
      <div
        className="flex-1 overflow-y-auto py-1"
        // Empty-area drop = move to the project root. dragover MUST
        // preventDefault to enable the drop; the dragleave clear runs
        // when the cursor leaves THIS container, not its children.
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("application/x-pi-path")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(e) => void handleDrop(e, project.path)}
      >
        {tree === undefined && !loading && (
          <p className="px-3 py-2 italic text-neutral-500">Tree not loaded.</p>
        )}
        {tree !== undefined && (
          <Tree
            node={tree}
            depth={0}
            projectPath={project.path}
            expanded={expanded}
            onToggle={(path) => setExpanded((e) => ({ ...e, [path]: !e[path] }))}
            onOpen={(node) => void onClickEntry(node)}
            renaming={renaming}
            renameDraft={renameDraft}
            onRenameDraftChange={setRenameDraft}
            onRenameCommit={(absPath) => void commitRename(absPath)}
            onRenameStart={startRename}
            onDelete={(absPath, name, isDir) => void handleDelete(absPath, name, isDir)}
            dropTarget={dropTarget}
            onDropTargetChange={setDropTarget}
            onDrop={(e, dir) => void handleDrop(e, dir)}
          />
        )}
      </div>
    </div>
  );
}

interface TreeProps {
  node: FileTreeNode;
  depth: number;
  projectPath: string;
  expanded: Record<string, boolean>;
  onToggle: (path: string) => void;
  onOpen: (node: FileTreeNode) => void;
  renaming: string | undefined;
  renameDraft: string;
  onRenameDraftChange: (v: string) => void;
  onRenameCommit: (absPath: string) => void;
  onRenameStart: (absPath: string, name: string) => void;
  onDelete: (absPath: string, name: string, isDir: boolean) => void;
  /** Path of the directory currently being hovered as a drop target. */
  dropTarget: string | undefined;
  onDropTargetChange: (path: string | undefined) => void;
  onDrop: (e: DragEvent<HTMLElement>, targetDirAbsPath: string) => void;
}

function Tree(props: TreeProps) {
  const { node, depth, projectPath } = props;
  // Root: render only its children, no row for the root itself (the
  // panel header already shows the project name).
  if (depth === 0 && node.type === "directory") {
    return (
      <ul>
        {node.children?.map((child) => (
          <Tree key={child.path} {...props} node={child} depth={1} />
        ))}
      </ul>
    );
  }
  const absPath = joinPath(projectPath, node.path);
  const isDir = node.type === "directory";
  const open = isDir && (props.expanded[node.path] ?? false);
  const isRenaming = props.renaming === absPath;
  const isDropTarget = isDir && props.dropTarget === absPath;
  return (
    <li>
      <div
        className={`group flex items-center gap-1 px-2 py-0.5 hover:bg-neutral-900 ${
          isDropTarget ? "bg-emerald-900/30 ring-1 ring-emerald-700/50" : ""
        }`}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        // Drag source: every row is draggable except while inline
        // renaming (the input owns pointer events then).
        draggable={!isRenaming}
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-pi-path", absPath);
          e.dataTransfer.effectAllowed = "move";
        }}
        // Drop target: only directories accept drops. dragover MUST
        // preventDefault to enable the drop; we also stopPropagation
        // so the project-root drop area doesn't fire when dropping on
        // a nested folder.
        onDragOver={
          isDir
            ? (e) => {
                if (!e.dataTransfer.types.includes("application/x-pi-path")) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                if (props.dropTarget !== absPath) props.onDropTargetChange(absPath);
              }
            : undefined
        }
        onDragLeave={
          isDir
            ? () => {
                if (props.dropTarget === absPath) props.onDropTargetChange(undefined);
              }
            : undefined
        }
        onDrop={
          isDir
            ? (e) => {
                e.stopPropagation();
                props.onDrop(e, absPath);
              }
            : undefined
        }
      >
        <button
          onClick={() => props.onOpen(node)}
          className="flex flex-1 items-center gap-1 truncate text-left"
          title={absPath}
        >
          {isDir ? (
            open ? (
              <ChevronDown size={12} className="text-neutral-500" />
            ) : (
              <ChevronRight size={12} className="text-neutral-500" />
            )
          ) : (
            <span className="inline-block w-3" />
          )}
          {isRenaming ? (
            <input
              autoFocus
              value={props.renameDraft}
              onChange={(e) => props.onRenameDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  props.onRenameCommit(absPath);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  props.onRenameCommit(absPath); // commit-or-empty cancels via empty draft
                }
              }}
              onBlur={() => props.onRenameCommit(absPath)}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-1 text-[11px] text-neutral-100 outline-none focus:border-neutral-500"
            />
          ) : (
            <span className={`truncate ${isDir ? "text-neutral-200" : "text-neutral-300"}`}>
              {node.name}
            </span>
          )}
          {node.truncated === true && <span className="ml-1 text-[10px] text-neutral-600">…</span>}
        </button>
        {!isRenaming && (
          <div className="hidden items-center gap-0.5 group-hover:flex">
            <button
              onClick={(e) => {
                e.stopPropagation();
                props.onRenameStart(absPath, node.name);
              }}
              className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
              title="Rename"
            >
              <Pencil size={11} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                props.onDelete(absPath, node.name, isDir);
              }}
              className="rounded p-0.5 text-neutral-500 hover:bg-red-900/30 hover:text-red-300"
              title="Delete"
            >
              <Trash2 size={11} />
            </button>
          </div>
        )}
      </div>
      {isDir && open && node.children !== undefined && (
        <ul>
          {node.children.map((child) => (
            <Tree key={child.path} {...props} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Build an absolute path from the project root + a relative tree path.
 * The server uses the local OS separator on disk; the tree returns
 * paths in that same separator. We deliberately don't normalise — the
 * server treats the path as opaque + validates it's inside the project
 * root, so consistency with what the server returned is what matters.
 */
function joinPath(root: string, rel: string): string {
  if (rel === "") return root;
  return `${root}/${rel.replaceAll("\\", "/")}`;
}
