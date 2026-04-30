/**
 * Single-process concurrency helpers. The workbench is single-tenant and
 * single-process by design, so these are intentionally in-memory only —
 * cross-process coordination is out of scope.
 */

/**
 * Build a serialised-lock primitive. Each call to the returned function
 * waits for the previous to settle (success or failure) before running.
 * Failures don't propagate to subsequent waiters; the caller owns its own
 * error handling.
 *
 * Use when a read-modify-write sequence on a single shared resource must
 * be serialised — e.g. config files mutated by multiple routes.
 */
export function makeLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
}

/**
 * Build an in-flight Promise dedupe primitive keyed by some lookup key.
 * If a call for `key` is already in flight, subsequent callers receive the
 * SAME promise instead of starting a duplicate operation. The entry is
 * removed when the in-flight promise settles.
 *
 * Use when two routes can independently lazy-load the same resource and
 * both ending up with their own copy is harmful — e.g. resumeSession
 * creating two AgentSession instances backing the same JSONL file.
 */
export function makeDedupe<K, V>(): (key: K, fn: () => Promise<V>) => Promise<V> {
  const inflight = new Map<K, Promise<V>>();
  return (key: K, fn: () => Promise<V>): Promise<V> => {
    const existing = inflight.get(key);
    if (existing !== undefined) return existing;
    const promise = fn().finally(() => {
      // Only remove if WE are still the entry — defensive against
      // re-entrant code paths that might somehow overwrite it.
      if (inflight.get(key) === promise) inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  };
}
