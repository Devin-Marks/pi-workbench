import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  browseDirectory,
  createDirectory,
  createProject,
  deleteProject,
  DuplicatePathError,
  getProject,
  InvalidDirectoryNameError,
  InvalidNameError,
  NotADirectoryError,
  PathOutsideWorkspaceError,
  ProjectNotFoundError,
  readProjects,
  renameProject,
} from "../project-manager.js";

const projectSchema = {
  type: "object",
  required: ["id", "name", "path", "createdAt"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    path: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

function handleError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof PathOutsideWorkspaceError) {
    return reply.code(403).send({ error: "path_not_allowed" });
  }
  if (err instanceof NotADirectoryError) {
    return reply.code(400).send({ error: "not_a_directory" });
  }
  if (err instanceof ProjectNotFoundError) {
    return reply.code(404).send({ error: "project_not_found" });
  }
  if (err instanceof InvalidNameError) {
    return reply.code(400).send({ error: "invalid_name" });
  }
  if (err instanceof InvalidDirectoryNameError) {
    return reply.code(400).send({ error: "invalid_directory_name" });
  }
  if (err instanceof DuplicatePathError) {
    return reply.code(409).send({ error: "duplicate_path" });
  }
  if ((err as NodeJS.ErrnoException).code === "EEXIST") {
    return reply.code(409).send({ error: "already_exists" });
  }
  reply.log.error({ err }, "projects route error");
  return reply.code(500).send({ error: "internal_error" });
}

export const projectRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/projects",
    {
      schema: {
        description: "List all projects.",
        tags: ["projects"],
        response: {
          200: {
            type: "object",
            required: ["projects"],
            properties: {
              projects: { type: "array", items: projectSchema },
            },
          },
        },
      },
    },
    async () => ({ projects: await readProjects() }),
  );

  fastify.post<{ Body: { name: string; path: string } }>(
    "/projects",
    {
      schema: {
        description:
          "Create a project pointing at an existing folder inside WORKSPACE_PATH. " +
          "Returns 403 for paths outside the workspace, 400 if the path is not a directory.",
        tags: ["projects"],
        body: {
          type: "object",
          required: ["name", "path"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            path: { type: "string", minLength: 1 },
          },
        },
        response: {
          201: projectSchema,
          400: { type: "object", properties: { error: { type: "string" } } },
          403: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      try {
        const project = await createProject(req.body.name, req.body.path);
        return reply.code(201).send(project);
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  fastify.patch<{ Params: { id: string }; Body: { name: string } }>(
    "/projects/:id",
    {
      schema: {
        description: "Rename a project. Does not move or rename the underlying directory.",
        tags: ["projects"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: { name: { type: "string", minLength: 1, maxLength: 200 } },
        },
        response: {
          200: projectSchema,
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      try {
        return await renameProject(req.params.id, req.body.name);
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/projects/:id",
    {
      schema: {
        description: "Delete the project record. Never touches the filesystem.",
        tags: ["projects"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          204: { type: "null" },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      try {
        await deleteProject(req.params.id);
        return reply.code(204).send();
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/projects/:id",
    {
      schema: {
        description: "Get a single project by id.",
        tags: ["projects"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: projectSchema,
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "project_not_found" });
      return project;
    },
  );

  fastify.get<{ Querystring: { path?: string } }>(
    "/projects/browse",
    {
      schema: {
        description:
          "List subdirectories of `path` (defaults to WORKSPACE_PATH). " +
          "Each entry includes whether it contains a .git directory. " +
          "Rejects paths outside WORKSPACE_PATH with 403.",
        tags: ["projects"],
        querystring: {
          type: "object",
          properties: { path: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["path", "entries"],
            properties: {
              path: { type: "string" },
              parentPath: { type: ["string", "null"] },
              entries: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "path", "isGitRepo"],
                  properties: {
                    name: { type: "string" },
                    path: { type: "string" },
                    isGitRepo: { type: "boolean" },
                  },
                },
              },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
          403: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await browseDirectory(req.query.path);
        return {
          path: result.path,
          parentPath: result.parentPath ?? null,
          entries: result.entries,
        };
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  fastify.post<{ Body: { parentPath: string; name: string } }>(
    "/projects/browse/mkdir",
    {
      schema: {
        description:
          "Create a directory inside WORKSPACE_PATH. Used by the folder picker's " +
          "'New folder' button. Rejects paths outside WORKSPACE_PATH with 403.",
        tags: ["projects"],
        body: {
          type: "object",
          required: ["parentPath", "name"],
          additionalProperties: false,
          properties: {
            parentPath: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
        response: {
          201: {
            type: "object",
            required: ["path"],
            properties: { path: { type: "string" } },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
          403: { type: "object", properties: { error: { type: "string" } } },
          409: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (req, reply) => {
      try {
        const path = await createDirectory(req.body.parentPath, req.body.name);
        return reply.code(201).send({ path });
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );
};
