/**
 * Operator-visible error diagnostics. The pi SDK swallows provider
 * errors into terse messages ("Connection Error", "fetch failed",
 * "Provider returned an error stop reason") that omit the actual
 * cause — most commonly a TLS handshake failure, DNS error, or
 * connection refused. Without the cause chain, an operator gets a
 * useless one-liner and has to attach a debugger.
 *
 * This module:
 *  1. Installs `unhandledRejection` + `uncaughtException` handlers
 *     that print the full `cause` chain to stderr.
 *  2. Exports `formatErrorChain()` for any code path that has caught
 *     an Error and wants to log the full underlying detail.
 *  3. When `DEBUG_FETCH=1`, wraps `globalThis.fetch` to log any
 *     rejection with the full cause chain. This is the surface where
 *     TLS / DNS / connection errors actually originate; the SDK's
 *     stringification loses them, so we capture before the SDK does.
 *
 * All output goes to `process.stderr` as JSON lines so
 * `docker logs <container> | jq` works.
 */

interface ErrorLike {
  name?: string;
  message?: string;
  code?: string;
  stack?: string;
  cause?: unknown;
  errors?: unknown[];
}

function asErrorLike(v: unknown): ErrorLike | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== "object") return undefined;
  return v;
}

/**
 * Walk an error's `cause` chain and aggregate every layer's
 * `name`/`code`/`message` into a single flat array. Also captures
 * AggregateError's `errors` array. Caps depth at 10 so a circular
 * cause graph can't loop forever.
 */
export interface ErrorChainEntry {
  name?: string;
  code?: string;
  message?: string;
}

export interface FormattedErrorChain {
  message: string;
  chain: ErrorChainEntry[];
  stack?: string;
}

export function formatErrorChain(input: unknown): FormattedErrorChain {
  const chain: ErrorChainEntry[] = [];
  let stack: string | undefined;
  const seen = new Set<unknown>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 10) return;
    const e = asErrorLike(v);
    if (!e || seen.has(v)) return;
    seen.add(v);
    const entry: ErrorChainEntry = {};
    if (e.name !== undefined) entry.name = e.name;
    if (e.code !== undefined) entry.code = e.code;
    if (e.message !== undefined) entry.message = e.message;
    chain.push(entry);
    if (stack === undefined && typeof e.stack === "string") stack = e.stack;
    if (e.cause !== undefined) visit(e.cause, depth + 1);
    if (Array.isArray(e.errors)) {
      for (const inner of e.errors) visit(inner, depth + 1);
    }
  };
  visit(input, 0);
  if (chain.length === 0) {
    return { message: typeof input === "string" ? input : JSON.stringify(input), chain: [] };
  }
  const message = chain
    .map((c) => [c.name, c.code, c.message].filter(Boolean).join(": "))
    .filter(Boolean)
    .join(" → ");
  const result: FormattedErrorChain = { message, chain };
  if (stack !== undefined) result.stack = stack;
  return result;
}

function writeJson(level: "info" | "warn" | "error", payload: Record<string, unknown>): void {
  process.stderr.write(
    `${JSON.stringify({ level, time: new Date().toISOString(), ...payload })}\n`,
  );
}

/**
 * Install once at server startup. Idempotent — guards against double
 * registration (e.g. tests that spin up the server multiple times in
 * one process).
 */
let installed = false;
export function installDiagnostics(): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason) => {
    const f = formatErrorChain(reason);
    writeJson("error", {
      msg: "unhandledRejection",
      error: f.message,
      chain: f.chain,
      stack: f.stack,
    });
  });

  process.on("uncaughtException", (err) => {
    const f = formatErrorChain(err);
    writeJson("error", {
      msg: "uncaughtException",
      error: f.message,
      chain: f.chain,
      stack: f.stack,
    });
  });

  if (process.env.DEBUG_FETCH === "1") {
    const orig = globalThis.fetch;
    globalThis.fetch = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as { url?: string }).url;
      try {
        const res = await orig(input, init);
        if (!res.ok) {
          writeJson("warn", {
            msg: "fetch non-2xx",
            url,
            method: init?.method ?? "GET",
            status: res.status,
            statusText: res.statusText,
          });
        }
        return res;
      } catch (err) {
        const f = formatErrorChain(err);
        writeJson("error", {
          msg: "fetch threw",
          url,
          method: init?.method ?? "GET",
          error: f.message,
          chain: f.chain,
        });
        throw err;
      }
    };
    writeJson("info", { msg: "DEBUG_FETCH enabled — wrapping globalThis.fetch" });
  }
}
