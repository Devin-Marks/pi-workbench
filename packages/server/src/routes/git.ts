import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  GitCommandError,
  GitNotInstalledError,
  InvalidBranchNameError,
  checkoutBranch,
  commit,
  createBranch,
  deleteBranch,
  fetch,
  getBranches,
  getDiff,
  getFileDiff,
  getLog,
  getStagedDiff,
  getStatus,
  isGitRepo,
  pull,
  push,
  revertPaths,
  stagePaths,
  unstagePaths,
} from "../git-runner.js";
import { getProject } from "../project-manager.js";
import { errorSchema } from "./_schemas.js";

/* ----------------------------- schemas ----------------------------- */

const fileStatusEntrySchema = {
  type: "object",
  required: ["path", "staged", "unstaged", "kind", "code"],
  properties: {
    path: { type: "string" },
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    kind: {
      type: "string",
      enum: [
        "modified",
        "added",
        "deleted",
        "renamed",
        "copied",
        "untracked",
        "ignored",
        "conflicted",
        "unknown",
      ],
    },
    code: { type: "string" },
    originalPath: { type: "string" },
  },
} as const;

const statusSchema = {
  type: "object",
  required: ["isGitRepo", "files"],
  properties: {
    isGitRepo: { type: "boolean" },
    branch: { type: "string" },
    files: { type: "array", items: fileStatusEntrySchema },
  },
} as const;

const diffSchema = {
  type: "object",
  required: ["isGitRepo", "diff"],
  properties: {
    isGitRepo: { type: "boolean" },
    diff: { type: "string" },
  },
} as const;

const logSchema = {
  type: "object",
  required: ["isGitRepo", "commits"],
  properties: {
    isGitRepo: { type: "boolean" },
    commits: {
      type: "array",
      items: {
        type: "object",
        required: ["hash", "message", "author", "date"],
        properties: {
          hash: { type: "string" },
          message: { type: "string" },
          author: { type: "string" },
          date: { type: "string" },
        },
      },
    },
  },
} as const;

const branchesSchema = {
  type: "object",
  required: ["isGitRepo", "branches"],
  properties: {
    isGitRepo: { type: "boolean" },
    current: { type: "string" },
    branches: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "current", "remote"],
        properties: {
          name: { type: "string" },
          current: { type: "boolean" },
          remote: { type: "boolean" },
        },
      },
    },
  },
} as const;

/* ----------------------------- error mapping ----------------------------- */

function mapError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof GitNotInstalledError) {
    return reply.code(500).send({
      error: "git_not_installed",
      message: "git binary is not on PATH on the server",
    });
  }
  if (err instanceof InvalidBranchNameError) {
    return reply.code(400).send({ error: "invalid_branch_name", message: err.message });
  }
  if (err instanceof GitCommandError) {
    // Git "rejected" / "non-fast-forward" / commit hook failures /
    // missing upstream are user-actionable, not server bugs. 400
    // with a sanitized message lets the client surface the hint
    // verbatim. Network / auth failures during push are reported the
    // same way — we don't try to enumerate every git failure mode.
    return reply.code(400).send({ error: "git_failed", message: err.userMessage });
  }
  reply.log.error({ err }, "unmapped git-runner error");
  return reply.code(500).send({ error: "internal_error" });
}

async function resolveProject(
  projectId: string,
  reply: FastifyReply,
): Promise<{ id: string; path: string } | undefined> {
  const project = await getProject(projectId);
  if (project === undefined) {
    void reply.code(404).send({ error: "project_not_found" });
    return undefined;
  }
  return { id: project.id, path: project.path };
}

/* ----------------------------- routes ----------------------------- */

export const gitRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { projectId: string } }>(
    "/git/status",
    {
      schema: {
        description:
          "Parsed `git status --porcelain=v1 -uall` for the project. Files " +
          "include staged/unstaged flags, a coarse `kind` classification, and " +
          "the raw two-char porcelain code. Non-git directories return " +
          "`{ isGitRepo: false, files: [] }` (NOT 500) so the panel can sit " +
          "quiet on plain folders.",
        tags: ["git"],
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", minLength: 1 } },
        },
        response: { 200: statusSchema, 400: errorSchema, 404: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.query.projectId, reply);
      if (project === undefined) return;
      try {
        return await getStatus(project.path);
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.get<{ Querystring: { projectId: string } }>(
    "/git/diff",
    {
      schema: {
        description: "Unstaged unified diff for the project (working tree vs index).",
        tags: ["git"],
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", minLength: 1 } },
        },
        response: { 200: diffSchema, 400: errorSchema, 404: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.query.projectId, reply);
      if (project === undefined) return;
      try {
        const diff = await getDiff(project.path);
        return { isGitRepo: diff.length > 0 || (await isGitRepo(project.path)), diff };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.get<{ Querystring: { projectId: string } }>(
    "/git/diff/staged",
    {
      schema: {
        description: "Staged unified diff (index vs HEAD).",
        tags: ["git"],
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", minLength: 1 } },
        },
        response: { 200: diffSchema, 400: errorSchema, 404: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.query.projectId, reply);
      if (project === undefined) return;
      try {
        const diff = await getStagedDiff(project.path);
        return { isGitRepo: diff.length > 0 || (await isGitRepo(project.path)), diff };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.get<{ Querystring: { projectId: string; path: string; staged?: string } }>(
    "/git/diff/file",
    {
      schema: {
        description:
          "Unified diff for a single file. `?staged=1` for the index↔HEAD diff; " +
          "default is working-tree↔index.",
        tags: ["git"],
        querystring: {
          type: "object",
          required: ["projectId", "path"],
          properties: {
            projectId: { type: "string", minLength: 1 },
            path: { type: "string", minLength: 1 },
            staged: { type: "string", enum: ["0", "1", "true", "false"] },
          },
        },
        response: { 200: diffSchema, 400: errorSchema, 404: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.query.projectId, reply);
      if (project === undefined) return;
      try {
        const staged = req.query.staged === "1" || req.query.staged === "true";
        const diff = await getFileDiff(project.path, req.query.path, staged);
        return { isGitRepo: diff.length > 0 || (await isGitRepo(project.path)), diff };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.get<{ Querystring: { projectId: string; limit?: string } }>(
    "/git/log",
    {
      schema: {
        description:
          "Recent commits as `{ hash, message, author, date }[]`. Default " + "limit 30; max 1000.",
        tags: ["git"],
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: {
            projectId: { type: "string", minLength: 1 },
            limit: { type: "string", pattern: "^[0-9]+$" },
          },
        },
        response: { 200: logSchema, 400: errorSchema, 404: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.query.projectId, reply);
      if (project === undefined) return;
      try {
        const limit =
          req.query.limit !== undefined
            ? Math.min(1000, Math.max(1, Number.parseInt(req.query.limit, 10)))
            : 30;
        const commits = await getLog(project.path, limit);
        return { isGitRepo: commits.length > 0 || (await isGitRepo(project.path)), commits };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.get<{ Querystring: { projectId: string } }>(
    "/git/branches",
    {
      schema: {
        description: "Local + remote branch list with `current` flag.",
        tags: ["git"],
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", minLength: 1 } },
        },
        response: { 200: branchesSchema, 400: errorSchema, 404: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.query.projectId, reply);
      if (project === undefined) return;
      try {
        const result = await getBranches(project.path);
        const isGit = result.branches.length > 0 || (await isGitRepo(project.path));
        return { isGitRepo: isGit, current: result.current, branches: result.branches };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.post<{ Body: { projectId: string; branch: string } }>(
    "/git/checkout",
    {
      schema: {
        description:
          "Switch the working tree to `branch`. Refuses on a dirty tree (git's " +
          "default) — caller surfaces the resulting `git_failed` message so the " +
          "user can stash or revert first. Pass `origin/feature` to start a " +
          "tracking branch from the remote ref.",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId", "branch"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            branch: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.body.projectId, reply);
      if (project === undefined) return;
      try {
        await checkoutBranch(project.path, req.body.branch);
        return { ok: true };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.post<{
    Body: { projectId: string; name: string; startPoint?: string; checkout?: boolean };
  }>(
    "/git/branch/create",
    {
      schema: {
        description:
          "Create a local branch. `startPoint` (defaults to HEAD) accepts any ref " +
          "the user could pass to `git branch`. `checkout: true` creates and " +
          "switches in one step via `git checkout -b`.",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId", "name"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1 },
            startPoint: { type: "string", minLength: 1 },
            checkout: { type: "boolean" },
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.body.projectId, reply);
      if (project === undefined) return;
      try {
        const opts: { startPoint?: string; checkout?: boolean } = {};
        if (req.body.startPoint !== undefined) opts.startPoint = req.body.startPoint;
        if (req.body.checkout !== undefined) opts.checkout = req.body.checkout;
        await createBranch(project.path, req.body.name, opts);
        return { ok: true };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.delete<{ Querystring: { projectId: string; force?: string }; Params: { name: string } }>(
    "/git/branch/:name",
    {
      schema: {
        description:
          "Delete a local branch via `git branch -d <name>`. `?force=1` switches " +
          "to `-D` for branches that haven't been merged. Refuses to delete the " +
          "currently-checked-out branch (git surfaces a `git_failed`).",
        tags: ["git"],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 } },
        },
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: {
            projectId: { type: "string", minLength: 1 },
            force: { type: "string", enum: ["0", "1", "true", "false"] },
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.query.projectId, reply);
      if (project === undefined) return;
      try {
        const force = req.query.force === "1" || req.query.force === "true";
        await deleteBranch(project.path, req.params.name, { force });
        return { ok: true };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.post<{ Body: { projectId: string; paths: string[] } }>(
    "/git/stage",
    {
      schema: {
        description: "Stage one or more files (`git add -- <paths>`).",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId", "paths"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            paths: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.body.projectId, reply);
      if (project === undefined) return;
      try {
        await stagePaths(project.path, req.body.paths);
        return { ok: true };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.post<{ Body: { projectId: string; paths: string[] } }>(
    "/git/unstage",
    {
      schema: {
        description: "Unstage one or more files (`git restore --staged -- <paths>`).",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId", "paths"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            paths: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.body.projectId, reply);
      if (project === undefined) return;
      try {
        await unstagePaths(project.path, req.body.paths);
        return { ok: true };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.post<{ Body: { projectId: string; paths: string[] } }>(
    "/git/revert",
    {
      schema: {
        description:
          "Discard local changes for the given files via `git restore " +
          "--staged --worktree --source=HEAD`. Restores both the index " +
          "and the working tree to HEAD — destructive, the caller is " +
          "expected to gate behind a confirmation. Untracked files " +
          "produce a 400 with git's stderr ('pathspec did not match'); " +
          "delete those via /files/delete instead.",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId", "paths"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            paths: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.body.projectId, reply);
      if (project === undefined) return;
      try {
        await revertPaths(project.path, req.body.paths);
        return { ok: true };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.post<{ Body: { projectId: string; message: string } }>(
    "/git/commit",
    {
      schema: {
        description:
          "Commit the currently-staged changes. Pre-commit hooks fire as " +
          "normal — `--no-verify` is intentionally NOT used so browser " +
          "commits gate the same way terminal commits do.",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId", "message"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            message: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["hash"],
            properties: { hash: { type: "string" } },
          },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.body.projectId, reply);
      if (project === undefined) return;
      const message = req.body.message.trim();
      if (message.length === 0) {
        return reply.code(400).send({ error: "empty_message" });
      }
      try {
        return await commit(project.path, message);
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.post<{ Body: { projectId: string; remote?: string; prune?: boolean } }>(
    "/git/fetch",
    {
      schema: {
        description:
          "git fetch — never touches the working tree, safe regardless of " +
          "dirty state. `prune: true` adds --prune so deleted upstream " +
          "branches are removed locally. Returns the captured output.",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            remote: { type: "string", minLength: 1 },
            prune: { type: "boolean" },
          },
        },
        response: {
          200: { type: "object", required: ["output"], properties: { output: { type: "string" } } },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.body.projectId, reply);
      if (project === undefined) return;
      try {
        const opts: { remote?: string; prune?: boolean } = {};
        if (req.body.remote !== undefined) opts.remote = req.body.remote;
        if (req.body.prune !== undefined) opts.prune = req.body.prune;
        const { stdout } = await fetch(project.path, opts);
        return { output: stdout };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.post<{
    Body: { projectId: string; remote?: string; branch?: string; rebase?: boolean };
  }>(
    "/git/pull",
    {
      schema: {
        description:
          "git pull — fetches AND merges (or rebases with `rebase: true`). " +
          "Conflicts are surfaced verbatim in the 400 message; the user can " +
          "drop to the integrated terminal to resolve. No conflict-resolution " +
          "UI in v1.",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            remote: { type: "string", minLength: 1 },
            branch: { type: "string", minLength: 1 },
            rebase: { type: "boolean" },
          },
        },
        response: {
          200: { type: "object", required: ["output"], properties: { output: { type: "string" } } },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.body.projectId, reply);
      if (project === undefined) return;
      try {
        const opts: { remote?: string; branch?: string; rebase?: boolean } = {};
        if (req.body.remote !== undefined) opts.remote = req.body.remote;
        if (req.body.branch !== undefined) opts.branch = req.body.branch;
        if (req.body.rebase !== undefined) opts.rebase = req.body.rebase;
        const { stdout } = await pull(project.path, opts);
        return { output: stdout };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.post<{
    Body: { projectId: string; remote?: string; branch?: string; setUpstream?: boolean };
  }>(
    "/git/push",
    {
      schema: {
        description:
          "Push to a remote. With no `remote`/`branch` body fields, runs " +
          "plain `git push` against the configured upstream. `setUpstream: " +
          "true` adds `--set-upstream` so the remote/branch is recorded as " +
          "the tracking ref (required on first push of a new local branch). " +
          "Returns 400 with git's stderr message on failure (no upstream set, " +
          "auth refused, rejected non-fast-forward, etc.).",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            remote: { type: "string", minLength: 1 },
            branch: { type: "string", minLength: 1 },
            setUpstream: { type: "boolean" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["output"],
            properties: { output: { type: "string" } },
          },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.body.projectId, reply);
      if (project === undefined) return;
      try {
        const opts: { remote?: string; branch?: string; setUpstream?: boolean } = {};
        if (req.body.remote !== undefined) opts.remote = req.body.remote;
        if (req.body.branch !== undefined) opts.branch = req.body.branch;
        if (req.body.setUpstream !== undefined) opts.setUpstream = req.body.setUpstream;
        const { stdout } = await push(project.path, opts);
        return { output: stdout };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );
};
