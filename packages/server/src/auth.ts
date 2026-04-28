import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import jwt, { type JwtPayload as JsonWebTokenPayload } from "jsonwebtoken";
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

/**
 * Constant-time string comparison. Pads the shorter buffer so timingSafeEqual
 * can run on equal-length inputs, then enforces the length check after-the-fact
 * so length isn't leaked through early-return timing.
 */
export function constantTimeStringEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  const len = Math.max(a.length, b.length);
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  a.copy(aPadded);
  b.copy(bPadded);
  return timingSafeEqual(aPadded, bPadded) && a.length === b.length;
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

/**
 * Verify a JWT and return the typed payload, or undefined on any failure
 * (bad signature, expired, missing JWT_SECRET, wrong subject).
 */
export function verifyToken(token: string): JwtPayload | undefined {
  if (config.auth.jwtSecret === undefined) return undefined;
  try {
    const decoded = jwt.verify(token, config.auth.jwtSecret, {
      algorithms: ["HS256"],
    }) as JsonWebTokenPayload | string;
    if (typeof decoded !== "object" || decoded === null) return undefined;
    if (decoded.sub !== "ui-user") return undefined;
    if (typeof decoded.iat !== "number" || typeof decoded.exp !== "number") return undefined;
    return { sub: "ui-user", iat: decoded.iat, exp: decoded.exp };
  } catch {
    return undefined;
  }
}

export function verifyApiKey(presented: string): boolean {
  const expected = config.auth.apiKey;
  if (expected === undefined) return false;
  return constantTimeStringEqual(presented, expected);
}

export function verifyPassword(presented: string): boolean {
  const expected = config.auth.uiPassword;
  if (expected === undefined) return false;
  return constantTimeStringEqual(presented, expected);
}

export function extractBearer(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(headerValue);
  return m?.[1];
}
