import type { FastifyPluginAsync } from "fastify";
import { sessionCount } from "../session-registry.js";
import { ptyCount } from "../pty-manager.js";
import { config } from "../config.js";

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/health",
    {
      config: { public: true },
      schema: {
        description: "Health check — no auth required.",
        tags: ["health"],
        security: [],
        response: {
          200: {
            type: "object",
            required: ["status", "activeSessions", "activePtys"],
            properties: {
              status: { type: "string", enum: ["ok"] },
              activeSessions: { type: "integer", minimum: 0 },
              activePtys: { type: "integer", minimum: 0 },
            },
          },
        },
      },
    },
    async () => ({
      status: "ok" as const,
      activeSessions: sessionCount(),
      activePtys: ptyCount(),
    }),
  );

  // Public, no-auth UI config — the browser fetches this at boot to
  // know which surfaces to render. Kept on the health-route plugin
  // because both share the "no-auth, fetched once at boot" profile.
  fastify.get(
    "/ui-config",
    {
      config: { public: true },
      schema: {
        description:
          "Frontend feature flags + a few server-derived constants the " +
          "client needs at boot. No auth — runs before the auth check so " +
          "the login screen can read the same flags.",
        tags: ["health"],
        security: [],
        response: {
          200: {
            type: "object",
            required: ["minimal", "workspaceRoot"],
            properties: {
              // True when MINIMAL_UI is set: hides terminal, git pane,
              // last-turn pane, and providers/agent settings sections;
              // replaces the folder picker with a name-only project
              // create form rooted at `workspaceRoot`.
              minimal: { type: "boolean" },
              // Absolute path of the workspace root. Minimal-mode
              // project creation builds `<workspaceRoot>/<name>`.
              workspaceRoot: { type: "string" },
            },
          },
        },
      },
    },
    async () => ({
      minimal: config.minimalUi,
      workspaceRoot: config.workspacePath,
    }),
  );
};
