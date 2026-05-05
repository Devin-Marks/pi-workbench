import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * One-shot migration of the v1.0.x → v1.1.0 data dir rename
 * (`~/.pi-workbench/` → `~/.pi-forge/`). Runs at server boot, BEFORE
 * any code reads from `config.forgeDataDir`. Idempotent: no-op when
 * either (a) the new dir already exists, or (b) the legacy dir does
 * not exist.
 *
 * Strategy: atomic `rename()` of the entire directory, which carries
 * `projects.json`, `mcp.json`, `skills-overrides.json`,
 * `tool-overrides.json`, `password-hash`, `jwt-secret`, and any other
 * state the operator had accumulated under the old name. On
 * cross-filesystem moves (`EXDEV`) — rare, only applies when the
 * legacy dir is on a different mount than `$HOME` — we fall back to
 * recursive copy + delete with a structured log line on entry and
 * exit so the operator can confirm what happened.
 *
 * Runs only when `FORGE_DATA_DIR` defaults to `~/.pi-forge/`. If the
 * operator pinned `FORGE_DATA_DIR` to a non-default path (helm chart,
 * docker-compose env), they're already in control of where their
 * data lives — no migration is performed and the operator is
 * responsible for moving their files if they want to switch.
 */
export async function migrateLegacyDataDir(log: {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}): Promise<void> {
  const home = homedir();
  if (home === "/" || home === "") return; // pathological env — nothing to do

  const legacy = join(home, ".pi-workbench");
  const target = join(home, ".pi-forge");

  // Only migrate when the operator hasn't pinned FORGE_DATA_DIR
  // somewhere else. Comparing against the resolved default catches
  // the docker / k8s case where the env var explicitly sets the
  // path even when it equals the default.
  if (config.forgeDataDir !== target) return;

  const [legacyStat, targetStat] = await Promise.all([
    stat(legacy).catch(() => undefined),
    stat(target).catch(() => undefined),
  ]);

  // Nothing to migrate (fresh install or already migrated).
  if (legacyStat === undefined) return;

  // Both dirs exist — operator has BOTH a populated legacy dir and a
  // populated new dir. Don't merge silently; log loudly and leave it
  // to the operator to resolve.
  if (targetStat !== undefined) {
    log.warn(
      { event: "data_dir_migration_skipped", from: legacy, to: target, reason: "both_exist" },
      "data dir migration skipped: both legacy and new dirs exist",
    );
    return;
  }

  log.info(
    { event: "data_dir_migration_starting", from: legacy, to: target },
    "migrating legacy data dir",
  );

  try {
    await rename(legacy, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    // Cross-filesystem move — fall back to recursive copy + delete.
    // Rare in practice (would require the operator to have mounted
    // ~/.pi-workbench as a separate filesystem), but the docker/k8s
    // bind-mount case can produce this if the legacy mount differs
    // from $HOME's filesystem.
    log.warn(
      { event: "data_dir_migration_exdev_fallback", from: legacy, to: target },
      "rename returned EXDEV; falling back to recursive copy",
    );
    await mkdir(target, { recursive: true });
    await cp(legacy, target, { recursive: true, preserveTimestamps: true });
    await rm(legacy, { recursive: true, force: true });
  }

  log.info(
    { event: "data_dir_migrated", from: legacy, to: target },
    "data dir migrated successfully",
  );
}
