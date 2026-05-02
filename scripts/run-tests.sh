#!/usr/bin/env bash
#
# Run the integration test scripts under tests/test-*.ts sequentially.
#
# pi-workbench has no test framework — each script under tests/ boots
# the server (or imports the registry directly), drives it, and prints
# PASS/FAIL per assertion. This script is what `npm run test` and
# `npm run test:ci` invoke; it loops the scripts in lexical order,
# stops on the first failure, and prints a summary.
#
# Why a shell script (not pure npm scripts):
#   - npm's `&&` chain across N scripts produces awful output (no
#     summary, no per-test wall time, all stdout interleaved).
#   - We want to skip specific tests in CI (notably test-docker, which
#     builds an image and adds 2–5 minutes for no per-PR signal).
#   - Pre-test build + dist/ presence check belongs in one place.
#
# Flags:
#   --ci      Apply the CI skip list (currently: test-docker).
#             Has no effect on which env vars influence the tests —
#             those are inherited as-is from the caller.
#   --skip <name>[,<name>...]
#             Comma-separated list of test names to skip. Names match
#             the `test-` prefix and `.ts` suffix off the filename
#             (e.g. `--skip docker,session`). Repeatable.
#   --only <name>[,<name>...]
#             Mirror of --skip; if set, ONLY these tests run.
#
# Env vars worth knowing about:
#   PI_TEST_LIVE_PROMPT=1  Several scripts (test-session, test-sse,
#                          test-api) gate optional assertions on this.
#                          Local-only — needs a configured pi provider.
#                          Never set this in CI.
#
# Build state:
#   The tests import compiled output from `packages/server/dist/`.
#   We run `npm run build` first if the dist dir is missing or older
#   than any source file under packages/server/src — npm's CI install
#   doesn't run build automatically.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

CI_MODE=0
declare -a SKIP_LIST=()
declare -a ONLY_LIST=()

# CI skip list: tests we don't want running on every PR. Document the
# WHY in the comment next to each entry so the next maintainer doesn't
# re-add it expecting CI signal.
declare -a CI_SKIP=(
  # Builds the production Docker image (2-5 min cold) and runs an end-
  # to-end smoke against it. Useful before cutting a release; brutal as
  # a per-PR gate. Run locally: `npx tsx tests/test-docker.ts`.
  "docker"
)

while [ $# -gt 0 ]; do
  case "$1" in
    --ci)
      CI_MODE=1
      shift
      ;;
    --skip)
      [ $# -ge 2 ] || { echo "error: --skip requires an argument" >&2; exit 2; }
      IFS=',' read -r -a tokens <<< "$2"
      SKIP_LIST+=("${tokens[@]}")
      shift 2
      ;;
    --only)
      [ $# -ge 2 ] || { echo "error: --only requires an argument" >&2; exit 2; }
      IFS=',' read -r -a tokens <<< "$2"
      ONLY_LIST+=("${tokens[@]}")
      shift 2
      ;;
    -h|--help)
      sed -n '3,40p' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ "$CI_MODE" -eq 1 ]; then
  SKIP_LIST+=("${CI_SKIP[@]}")
fi

# Ensure the compiled server is fresh enough. The tests do
# `await import('packages/server/dist/...')`, so a missing or stale
# dist/ produces opaque "Cannot find module" failures. Building when
# the dir is missing OR when any src file is newer than the build
# manifest covers both `npm ci` (no dist) and "I edited src and forgot
# to rebuild" (stale dist).
DIST_DIR="packages/server/dist"
needs_build=0
if [ ! -d "$DIST_DIR" ]; then
  needs_build=1
elif [ -n "$(find packages/server/src -type f -newer "$DIST_DIR/index.js" 2>/dev/null | head -n1)" ]; then
  needs_build=1
fi
if [ "$needs_build" -eq 1 ]; then
  echo "[test-runner] building (dist missing or stale)…"
  npm run build >/dev/null
fi

# Discover tests in lexical order. `find` over `ls` because `ls`
# breaks on filenames with spaces / specials (no such files today,
# but no reason to inherit that footgun).
declare -a ALL_TESTS=()
while IFS= read -r f; do
  ALL_TESTS+=("$f")
done < <(find tests -maxdepth 1 -name 'test-*.ts' -type f | sort)

# Resolve each test against --only / --skip / CI skip. Names are
# extracted from the basename: tests/test-session.ts -> "session".
declare -a SELECTED=()
for f in "${ALL_TESTS[@]}"; do
  name=$(basename "$f" .ts)
  name=${name#test-}

  if [ "${#ONLY_LIST[@]}" -gt 0 ]; then
    keep=0
    for o in "${ONLY_LIST[@]}"; do
      [ "$o" = "$name" ] && { keep=1; break; }
    done
    [ "$keep" -eq 1 ] || continue
  fi

  skip=0
  for s in "${SKIP_LIST[@]}"; do
    [ "$s" = "$name" ] && { skip=1; break; }
  done
  [ "$skip" -eq 0 ] || { echo "[test-runner] skip: $name"; continue; }

  SELECTED+=("$f")
done

if [ "${#SELECTED[@]}" -eq 0 ]; then
  echo "error: no tests selected" >&2
  exit 2
fi

echo "[test-runner] running ${#SELECTED[@]} test(s):"
for f in "${SELECTED[@]}"; do
  echo "  - $f"
done
echo

declare -a PASSED=()
declare -a FAILED=()
total_start=$(date +%s)

for f in "${SELECTED[@]}"; do
  echo "═══════════════════════════════════════════════════════════════════"
  echo "▶ $f"
  echo "═══════════════════════════════════════════════════════════════════"
  test_start=$(date +%s)
  if npx tsx "$f"; then
    test_end=$(date +%s)
    elapsed=$((test_end - test_start))
    PASSED+=("$f (${elapsed}s)")
  else
    test_end=$(date +%s)
    elapsed=$((test_end - test_start))
    FAILED+=("$f (${elapsed}s)")
    # Stop on first failure — a downstream test that depends on
    # global state (file descriptors, ports, leftover sessions) just
    # produces noise once the upstream broke.
    break
  fi
  echo
done

total_end=$(date +%s)
total_elapsed=$((total_end - total_start))

echo
echo "═══════════════════════════════════════════════════════════════════"
echo "Summary (${total_elapsed}s total)"
echo "═══════════════════════════════════════════════════════════════════"
# `${ARR[@]+"${ARR[@]}"}` is the "expand only if defined" idiom —
# bash with `set -u` errors on `${EMPTY_ARR[@]}` otherwise.
for p in ${PASSED[@]+"${PASSED[@]}"}; do
  echo "  PASS  $p"
done
for f in ${FAILED[@]+"${FAILED[@]}"}; do
  echo "  FAIL  $f"
done

if [ "${#FAILED[@]}" -gt 0 ]; then
  exit 1
fi
echo "All ${#PASSED[@]} test(s) passed."
