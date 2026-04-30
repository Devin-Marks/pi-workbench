import type { FastifyPluginAsync } from "fastify";
import { config, authEnabled } from "../config.js";
import {
  extractBearer,
  generateToken,
  passwordConfigured,
  persistPassword,
  verifyPasswordWithSource,
  verifyToken,
} from "../auth.js";
import { errorSchema } from "./_schemas.js";

interface LoginBody {
  password: string;
}

interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;

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
          "or 503 if browser password auth is not configured (no UI_PASSWORD set and no " +
          "stored password hash). When the password matched the env-supplied " +
          "UI_PASSWORD AND no stored hash exists yet, `mustChangePassword` is true on " +
          "the response and the issued token may only call POST /auth/change-password.",
        tags: ["auth"],
        security: [],
        body: {
          type: "object",
          required: ["password"],
          additionalProperties: false,
          properties: {
            password: { type: "string", minLength: 1, maxLength: MAX_PASSWORD_LENGTH },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["token", "expiresAt", "mustChangePassword"],
            properties: {
              token: { type: "string" },
              expiresAt: { type: "string", format: "date-time" },
              mustChangePassword: { type: "boolean" },
            },
          },
          401: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!passwordConfigured()) {
        return reply.code(503).send({
          error: "ui_password_not_configured",
          message: "browser login is disabled (no UI_PASSWORD set and no stored password hash)",
        });
      }
      const { password } = req.body;
      const result = await verifyPasswordWithSource(password);
      if (!result.ok) {
        return reply.code(401).send({
          error: "invalid_password",
          message: "the password did not match",
        });
      }
      const mustChangePassword = result.source === "env" && config.auth.requirePasswordChange;
      const issued = generateToken({ mustChangePassword });
      return { ...issued, mustChangePassword };
    },
  );

  // Change-password is `public: true` at the route-config level so the
  // global `must_change_password` gate (in index.ts) doesn't refuse a
  // token that was issued specifically to call THIS endpoint. We
  // enforce auth manually inside the handler.
  fastify.post<{ Body: ChangePasswordBody }>(
    "/auth/change-password",
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
          "Verify the current password, persist a new scrypt hash to " +
          "${WORKBENCH_DATA_DIR}/password-hash, and issue a fresh JWT " +
          "(mustChangePassword=false). Once a stored hash exists the env " +
          "UI_PASSWORD is ignored on subsequent logins. Requires a valid " +
          "JWT (initial-login `mustChangePassword:true` tokens are accepted).",
        tags: ["auth"],
        body: {
          type: "object",
          required: ["currentPassword", "newPassword"],
          additionalProperties: false,
          properties: {
            currentPassword: {
              type: "string",
              minLength: 1,
              maxLength: MAX_PASSWORD_LENGTH,
            },
            newPassword: {
              type: "string",
              minLength: MIN_PASSWORD_LENGTH,
              maxLength: MAX_PASSWORD_LENGTH,
            },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["token", "expiresAt", "mustChangePassword"],
            properties: {
              token: { type: "string" },
              expiresAt: { type: "string", format: "date-time" },
              mustChangePassword: { type: "boolean" },
            },
          },
          400: errorSchema,
          401: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (req, reply) => {
      // Manual auth check — the route is `public: true` so the global
      // hook doesn't run, but we still require a valid JWT here.
      const presented = extractBearer(req.headers.authorization);
      if (presented === undefined || verifyToken(presented) === undefined) {
        return reply.code(401).send({ error: "auth_required" });
      }
      if (!passwordConfigured()) {
        return reply.code(503).send({
          error: "ui_password_not_configured",
          message: "password auth is not configured on this server",
        });
      }
      const { currentPassword, newPassword } = req.body;
      const verify = await verifyPasswordWithSource(currentPassword);
      if (!verify.ok) {
        return reply.code(401).send({
          error: "invalid_password",
          message: "the current password did not match",
        });
      }
      if (currentPassword === newPassword) {
        return reply.code(400).send({
          error: "password_unchanged",
          message: "new password must differ from the current one",
        });
      }
      await persistPassword(newPassword);
      const issued = generateToken({ mustChangePassword: false });
      return { ...issued, mustChangePassword: false };
    },
  );
};
