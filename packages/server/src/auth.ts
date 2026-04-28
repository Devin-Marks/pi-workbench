import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "./config.js";

export interface JwtPayload {
  sub: "ui-user";
  iat: number;
  exp: number;
}

export interface IssuedToken {
  token: string;
  expiresAt: string;
}

export function generateToken(): IssuedToken {
  if (config.auth.jwtSecret === undefined) {
    throw new Error("auth: cannot generate token — JWT_SECRET not configured");
  }
  const expiresIn = config.auth.jwtExpiresInSeconds;
  const token = jwt.sign(
    { sub: "ui-user" } satisfies Pick<JwtPayload, "sub">,
    config.auth.jwtSecret,
    {
      algorithm: "HS256",
      expiresIn,
    },
  );
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  return { token, expiresAt };
}

export function verifyToken(token: string): boolean {
  if (config.auth.jwtSecret === undefined) return false;
  try {
    jwt.verify(token, config.auth.jwtSecret, { algorithms: ["HS256"] });
    return true;
  } catch {
    return false;
  }
}

export function verifyApiKey(presented: string): boolean {
  const expected = config.auth.apiKey;
  if (expected === undefined) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Constant-time comparison: pad the shorter buffer so timingSafeEqual can run,
  // then check the lengths matched after-the-fact. This avoids early returns that
  // would leak length information.
  const len = Math.max(a.length, b.length);
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  a.copy(aPadded);
  b.copy(bPadded);
  const equal = timingSafeEqual(aPadded, bPadded);
  return equal && a.length === b.length;
}

export function verifyPassword(presented: string): boolean {
  const expected = config.auth.uiPassword;
  if (expected === undefined) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  const len = Math.max(a.length, b.length);
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  a.copy(aPadded);
  b.copy(bPadded);
  return timingSafeEqual(aPadded, bPadded) && a.length === b.length;
}

export function extractBearer(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(headerValue);
  return m?.[1];
}
