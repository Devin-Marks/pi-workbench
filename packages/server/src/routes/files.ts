import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  DirectoryNotEmptyError,
  FileTooLargeError,
  InvalidNameError,
  NotAFileError,
  NotFoundError,
  PathOutsideRootError,
  TargetExistsError,
  deleteEntry,
  getTree,
  makeDirectory,
  moveEntry,
  readFile,
  renameEntry,
  writeFile,
} from "../file-manager.js";
import { getProject } from "../project-manager.js";
import { errorSchema } from "./_schemas.js";

/* ----------------------------- schemas ----------------------------- */

// `additionalProperties: true` on the recursive `children` so Fastify's
// serializer doesn't drop fields if we add new ones in a future SDK
// release.
const treeNodeSchema = {
  type: "object",
  required: ["name", "path", "type"],
  additionalProperties: true,
  properties: {
    name: { type: "string" },
    path: { type: "string" },
    type: { type: "string", enum: ["file", "directory"] },
    children: { type: "array", items: { type: "object", additionalProperties: true } },
    truncated: { type: "boolean" },
  },
} as const;

const readResponseSchema = {
  type: "object",
  required: ["path", "content", "size", "language", "binary"],
  properties: {
    path: { type: "string" },
    content: { type: "string" },
    size: { type: "integer", minimum: 0 },
    language: { type: "string" },
    binary: { type: "boolean" },
  },
} as const;

/* ----------------------------- error mapping ----------------------------- */

/**
 * Translate file-manager errors into wire-shape responses. Routes funnel
 * everything through this so the mapping is centralised — a future error
 * type lands in one place.
 */
function mapError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof PathOutsideRootError) {
    return reply.code(403).send({ error: "path_not_allowed" });
  }
  if (err instanceof InvalidNameError) {
    return reply.code(400).send({ error: "invalid_name", message: err.message });
  }
  if (err instanceof NotFoundError) {
    return reply.code(404).send({ error: "not_found" });
  }
  if (err instanceof NotAFileError) {
    return reply.code(400).send({ error: "not_a_file" });
  }
  if (err instanceof FileTooLargeError) {
    return reply.code(413).send({ error: "file_too_large", message: `${err.size} > ${err.limit}` });
  }
  if (err instanceof DirectoryNotEmptyError) {
    return reply.code(409).send({
      error: "directory_not_empty",
      message: "delete the contents first; recursive delete is not supported",
    });
  }
  if (err instanceof TargetExistsError) {
    return reply.code(409).send({ error: "target_exists" });
  }
  reply.log.error({ err }, "unmapped file-manager error");
  return reply.code(500).send({ error: "internal_error" });
}

/**
 * Resolve the project for a request and short-circuit with 404 when it
 * doesn't exist. Returns the project on success; the route handler should
 * return immediately if `undefined` comes back.
 */
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

export const fileRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { projectId: string; maxDepth?: string } }>(
    "/files/tree",
    {
      schema: {
        description:
          "Recursive directory tree for the project. Skips noisy folders " +
          "(node_modules, .git, dist, build, __pycache__, .next, .nuxt, " +
          "coverage, .vite, .turbo, .cache). Default max depth 6 — deeper " +
          "directories are returned with `truncated: true` so the UI can " +
          "lazy-fetch them on demand.",
        tags: ["files"],
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: {
            projectId: { type: "string", minLength: 1 },
            maxDepth: { type: "string", pattern: "^[0-9]+$" },
          },
        },
        response: { 200: treeNodeSchema, 404: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.query.projectId, reply);
      if (project === undefined) return;
      try {
        // Clamp client-supplied maxDepth to a sane window. The schema
        // already gates on `^[0-9]+$`, so parseInt is safe; we cap at
        // 32 because anything past that is either a misconfiguration
        // or someone trying to force a deep recursion DoS.
        let maxDepth: number | undefined;
        if (req.query.maxDepth !== undefined) {
          const n = Number.parseInt(req.query.maxDepth, 10);
          maxDepth = Math.min(Math.max(n, 1), 32);
        }
        const tree = await getTree(project.path, maxDepth !== undefined ? { maxDepth } : {});
        return tree;
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.get<{ Querystring: { projectId: string; path: string } }>(
    "/files/read",
    {
      schema: {
        description:
          "Read a UTF-8 file from the project. 5 MB cap (returns 413). " +
          "Binary files return `{ binary: true, content: '' }` rather than a " +
          "garbled UTF-8 decode — clients should not pass binary content " +
          "to the editor.",
        tags: ["files"],
        querystring: {
          type: "object",
          required: ["projectId", "path"],
          properties: {
            projectId: { type: "string", minLength: 1 },
            path: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: readResponseSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          413: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.query.projectId, reply);
      if (project === undefined) return;
      try {
        const result = await readFile(req.query.path, project.path);
        return result;
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.put<{ Body: { projectId: string; path: string; content: string } }>(
    "/files/write",
    {
      schema: {
        description:
          "Atomic write (tmp + rename). Creates parent directories as " +
          "needed. The body's `path` is required to be inside the project " +
          "root — 403 otherwise.",
        tags: ["files"],
        body: {
          type: "object",
          required: ["projectId", "path", "content"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            path: { type: "string", minLength: 1 },
            content: { type: "string" },
          },
        },
        response: {
          200: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.body.projectId, reply);
      if (project === undefined) return;
      try {
        await writeFile(req.body.path, project.path, req.body.content);
        return { path: req.body.path };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.post<{ Body: { projectId: string; parentPath: string; name: string } }>(
    "/files/mkdir",
    {
      schema: {
        description: "Create a single directory under `parentPath`.",
        tags: ["files"],
        body: {
          type: "object",
          required: ["projectId", "parentPath", "name"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            parentPath: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.body.projectId, reply);
      if (project === undefined) return;
      try {
        const created = await makeDirectory(req.body.parentPath, project.path, req.body.name);
        return { path: created };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.post<{ Body: { projectId: string; path: string; name: string } }>(
    "/files/rename",
    {
      schema: {
        description:
          "Rename a file or directory in place — `name` is the new basename. " +
          "Use /files/move to relocate across directories.",
        tags: ["files"],
        body: {
          type: "object",
          required: ["projectId", "path", "name"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            path: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.body.projectId, reply);
      if (project === undefined) return;
      try {
        const renamed = await renameEntry(req.body.path, project.path, req.body.name);
        return { path: renamed };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.post<{ Body: { projectId: string; src: string; dest: string } }>(
    "/files/move",
    {
      schema: {
        description:
          "Move a file or directory to `dest` (a full destination path). " +
          "Refuses to move a directory under itself; refuses if `dest` " +
          "already exists.",
        tags: ["files"],
        body: {
          type: "object",
          required: ["projectId", "src", "dest"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            src: { type: "string", minLength: 1 },
            dest: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.body.projectId, reply);
      if (project === undefined) return;
      try {
        const moved = await moveEntry(req.body.src, req.body.dest, project.path);
        return { path: moved };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.delete<{ Querystring: { projectId: string; path: string } }>(
    "/files/delete",
    {
      schema: {
        description:
          "Delete a file or empty directory. Non-empty directories return " +
          "409 — recursive delete is intentionally NOT supported (single-user " +
          "single-tenant: an accidental rm -rf is a worse failure mode than " +
          "a mildly inconvenient extra step).",
        tags: ["files"],
        querystring: {
          type: "object",
          required: ["projectId", "path"],
          properties: {
            projectId: { type: "string", minLength: 1 },
            path: { type: "string", minLength: 1 },
          },
        },
        response: {
          204: { type: "null" },
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.query.projectId, reply);
      if (project === undefined) return;
      try {
        await deleteEntry(req.query.path, project.path);
        return reply.code(204).send();
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );
};
