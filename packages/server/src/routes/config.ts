import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  AuthProviderNotFoundError,
  liveProvidersListing,
  listSkills,
  readAuthSummary,
  readModelsJsonRedacted,
  readSettings,
  removeApiKey,
  setSkillEnabled,
  SkillNotFoundError,
  updateSettings,
  writeApiKey,
  writeModelsJson,
  type ModelsJson,
} from "../config-manager.js";
import { getProject } from "../project-manager.js";
import { errorSchema } from "./_schemas.js";

const modelsJsonSchema = {
  type: "object",
  required: ["providers"],
  additionalProperties: true,
  properties: {
    // Loose validation: route accepts any shape under `providers` and lets
    // the SDK reject malformed configs at load time. Tighter validation can
    // come once the dev plan freezes the provider config schema.
    providers: { type: "object", additionalProperties: true },
  },
} as const;

const settingsSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    // Each field accepts its real type OR null (which the handler interprets
    // as "delete this key"). Loose typing on purpose — strict enums break the
    // null-delete contract documented on the PUT route. The SDK validates
    // settings.json shape on next read.
    defaultProvider: { type: ["string", "null"] },
    defaultModel: { type: ["string", "null"] },
    defaultThinkingLevel: { type: ["string", "null"] },
    steeringMode: { type: ["string", "null"] },
    followUpMode: { type: ["string", "null"] },
    skills: { type: ["array", "null"], items: { type: "string" } },
    enableSkillCommands: { type: ["boolean", "null"] },
  },
} as const;

const authSummarySchema = {
  type: "object",
  required: ["providers"],
  properties: {
    providers: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["configured"],
        properties: {
          configured: { type: "boolean" },
          source: { type: "string" },
          label: { type: "string" },
        },
      },
    },
  },
} as const;

const providersListingSchema = {
  type: "object",
  required: ["providers"],
  properties: {
    providers: {
      type: "array",
      items: {
        type: "object",
        required: ["provider", "models"],
        properties: {
          provider: { type: "string" },
          models: {
            type: "array",
            items: {
              type: "object",
              required: [
                "id",
                "name",
                "contextWindow",
                "maxTokens",
                "reasoning",
                "input",
                "hasAuth",
              ],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                contextWindow: { type: "integer" },
                maxTokens: { type: "integer" },
                reasoning: { type: "boolean" },
                input: { type: "array", items: { type: "string" } },
                hasAuth: { type: "boolean" },
              },
            },
          },
        },
      },
    },
  },
} as const;

const skillSchema = {
  type: "object",
  required: ["name", "description", "source", "filePath", "enabled", "disableModelInvocation"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    source: { type: "string", enum: ["global", "project"] },
    filePath: { type: "string" },
    enabled: { type: "boolean" },
    disableModelInvocation: { type: "boolean" },
  },
} as const;

function internalError(reply: FastifyReply, err: unknown): FastifyReply {
  reply.log.error({ err }, "config route error");
  return reply.code(500).send({ error: "internal_error" });
}

export const configRoutes: FastifyPluginAsync = async (fastify) => {
  // ---------------------- models.json ----------------------
  fastify.get(
    "/config/models",
    {
      schema: {
        description:
          "Read `models.json` (custom provider configurations). Inline `apiKey` " +
          "and `apiKeyCommand` fields are returned as `***REDACTED***` so the " +
          "raw secret never leaves the server. The persisted file is unchanged " +
          "— PUT /config/models takes the actual values; the redaction is on " +
          "the read path only.",
        tags: ["config"],
        response: { 200: modelsJsonSchema, 500: errorSchema },
      },
    },
    async (_req, reply) => {
      try {
        return await readModelsJsonRedacted();
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.put<{ Body: ModelsJson }>(
    "/config/models",
    {
      schema: {
        description:
          "Replace `models.json` atomically. The SDK validates the structure " +
          "on the next session creation; malformed configs are rejected then.",
        tags: ["config"],
        body: modelsJsonSchema,
        response: { 200: modelsJsonSchema, 400: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      try {
        await writeModelsJson(req.body);
        return req.body;
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- live providers ----------------------
  fastify.get(
    "/config/providers",
    {
      schema: {
        description:
          "Live provider + model listing assembled from the SDK's ModelRegistry " +
          "(combines built-in models with anything in `models.json`). Each model " +
          "carries a `hasAuth` boolean so the UI can dim entries with no key.",
        tags: ["config"],
        response: { 200: providersListingSchema, 500: errorSchema },
      },
    },
    async (_req, reply) => {
      try {
        return await liveProvidersListing();
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- settings.json ----------------------
  fastify.get(
    "/config/settings",
    {
      schema: {
        description: "Read `settings.json` (default provider/model, modes, skills list, etc).",
        tags: ["config"],
        response: { 200: settingsSchema, 500: errorSchema },
      },
    },
    async (_req, reply) => {
      try {
        return await readSettings();
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.put<{ Body: Record<string, unknown> }>(
    "/config/settings",
    {
      schema: {
        description:
          "Partial-merge update for `settings.json`. Sending `null` for any key " +
          "deletes it; other values overwrite. Atomic write.",
        tags: ["config"],
        body: settingsSchema,
        response: { 200: settingsSchema, 400: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      try {
        return await updateSettings(req.body);
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- auth.json (presence only) ----------------------
  fastify.get(
    "/config/auth",
    {
      schema: {
        description:
          "Provider credential PRESENCE map. Never includes actual key values — " +
          "the response shape is presence + source + label only.",
        tags: ["config"],
        response: { 200: authSummarySchema, 500: errorSchema },
      },
    },
    async (_req, reply) => {
      try {
        return readAuthSummary();
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.put<{ Params: { provider: string }; Body: { apiKey: string } }>(
    "/config/auth/:provider",
    {
      schema: {
        description:
          "Store an API key for a provider. The key is written to `auth.json` " +
          "(file-locked via the SDK); existing keys for OTHER providers are " +
          "untouched. Body: `{ apiKey }`.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["provider"],
          properties: { provider: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          required: ["apiKey"],
          additionalProperties: false,
          properties: { apiKey: { type: "string", minLength: 1 } },
        },
        response: {
          200: {
            type: "object",
            required: ["provider", "configured"],
            properties: {
              provider: { type: "string" },
              configured: { type: "boolean", const: true },
            },
          },
          400: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        writeApiKey(req.params.provider, req.body.apiKey);
        return { provider: req.params.provider, configured: true };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.delete<{ Params: { provider: string } }>(
    "/config/auth/:provider",
    {
      schema: {
        description: "Remove credentials for a provider.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["provider"],
          properties: { provider: { type: "string", minLength: 1 } },
        },
        response: { 204: { type: "null" }, 404: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      try {
        removeApiKey(req.params.provider);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof AuthProviderNotFoundError) {
          return reply.code(404).send({ error: "auth_provider_not_found" });
        }
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- skills ----------------------
  fastify.get<{ Querystring: { projectId: string } }>(
    "/config/skills",
    {
      schema: {
        description:
          "List skills discovered for a project. Skills come from two sources: " +
          "the global `~/.pi/agent/skills/` and the project-local `.pi/skills/`. " +
          "Each skill carries `enabled` reflecting whether it's listed in " +
          "`settings.skills`. Required: `?projectId=`.",
        tags: ["config"],
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["skills"],
            properties: { skills: { type: "array", items: skillSchema } },
          },
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.query.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      try {
        const skills = await listSkills(project.path);
        return { skills };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.put<{
    Params: { name: string };
    Querystring: { projectId: string };
    Body: { enabled: boolean };
  }>(
    "/config/skills/:name/enabled",
    {
      schema: {
        description:
          "Toggle a skill's enabled state. Mutates `settings.skills` (the " +
          "canonical enable/disable list); other settings are untouched.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 } },
        },
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["enabled"],
          additionalProperties: false,
          properties: { enabled: { type: "boolean" } },
        },
        response: {
          200: {
            type: "object",
            required: ["skills"],
            properties: { skills: { type: "array", items: skillSchema } },
          },
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.query.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      try {
        const skills = await setSkillEnabled(req.params.name, req.body.enabled, project.path);
        return { skills };
      } catch (err) {
        if (err instanceof SkillNotFoundError) {
          return reply.code(404).send({ error: "skill_not_found" });
        }
        return internalError(reply, err);
      }
    },
  );
};
