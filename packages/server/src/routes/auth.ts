import type { FastifyPluginAsync } from "fastify";
import { config, authEnabled } from "../config.js";
import { generateToken, verifyPassword } from "../auth.js";
import { errorSchema } from "./_schemas.js";

interface LoginBody {
  password: string;
}

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/auth/status",
    {
      config: { public: true },
      schema: {
        description: "Returns whether auth is required to call protected routes.",
        tags: ["auth"],
        security: [],
        response: {
          200: {
            type: "object",
            required: ["authEnabled"],
            properties: {
              authEnabled: { type: "boolean" },
            },
          },
        },
      },
    },
    async () => ({ authEnabled: authEnabled() }),
  );

  fastify.post<{ Body: LoginBody }>(
    "/auth/login",
    {
      config: {
        public: true,
        rateLimit: {
          max: config.auth.loginRateLimitMax,
          timeWindow: config.auth.loginRateLimitWindowMs,
        },
      },
      schema: {
        description:
          "Exchange a password for a short-lived JWT. Returns 401 if the password is wrong, " +
          "or 503 if browser password auth is not configured (UI_PASSWORD unset).",
        tags: ["auth"],
        security: [],
        body: {
          type: "object",
          required: ["password"],
          additionalProperties: false,
          properties: {
            password: { type: "string", minLength: 1, maxLength: 1024 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["token", "expiresAt"],
            properties: {
              token: { type: "string" },
              expiresAt: { type: "string", format: "date-time" },
            },
          },
          401: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (req, reply) => {
      if (config.auth.uiPassword === undefined) {
        return reply.code(503).send({
          error: "ui_password_not_configured",
          message: "browser login is disabled (no UI_PASSWORD set)",
        });
      }
      const { password } = req.body;
      if (!verifyPassword(password)) {
        return reply.code(401).send({
          error: "invalid_password",
          message: "the password did not match",
        });
      }
      return generateToken();
    },
  );
};
