#!/usr/bin/env bash
#
# Bump pi-workbench to a new version.
#
# What it does, in order:
#   1. Validates the new version is SemVer-shaped (x.y.z, optionally
#      followed by a pre-release like -rc.1).
#   2. Refuses to run on a dirty working tree — a release commit must
#      be reproducible from `main`, not contaminated with WIP.
#   3. Refuses to run if the new version is older than or equal to
#      the current root version (catches `1.0.0 -> 0.9.9` typos).
#   4. Refuses to run if `## [Unreleased]` in CHANGELOG.md is empty
#      (a bump with no changelog entry usually means "I forgot to
#      record what's in this release"). Override with --allow-empty.
#   5. Updates the `version` field in:
#        - package.json
#        - packages/server/package.json
#        - packages/client/package.json
#      All three must move in lockstep — the release workflow tags
#      against the root version and the Docker image is built from
#      the same commit, so a drifted workspace version would ship
#      mislabeled artifacts.
#   6. In CHANGELOG.md, renames `## [Unreleased]` to
#      `## [<new-version>] — YYYY-MM-DD` and inserts a fresh empty
#      `## [Unreleased]` heading above it for the next cycle.
#   7. Stages the changes and prints next-step instructions. Does
#      NOT commit, push, or tag — those are intentional, manual
#      checkpoints.
#
# Usage:
#   scripts/bump-version.sh 1.0.1
#   scripts/bump-version.sh 1.1.0-rc.1 --allow-empty
#
# Requires: bash 3.2+ (works with the macOS system bash), node (for
# the JSON edits — using `node -e` avoids a jq dependency since node
# is already required to build the project).

set -euo pipefail

ALLOW_EMPTY=0
NEW_VERSION=""
for arg in "$@"; do
  case "$arg" in
    --allow-empty) ALLOW_EMPTY=1 ;;
    -h|--help)
      sed -n '3,40p' "$0"
      exit 0
      ;;
    -*)
      echo "error: unknown flag: $arg" >&2
      exit 2
      ;;
    *)
      if [ -n "$NEW_VERSION" ]; then
        echo "error: multiple version args: $NEW_VERSION, $arg" >&2
        exit 2
      fi
      NEW_VERSION="$arg"
      ;;
  esac
done

if [ -z "$NEW_VERSION" ]; then
  echo "usage: scripts/bump-version.sh <new-version> [--allow-empty]" >&2
  exit 2
fi

# Strict SemVer 2.0.0 (numeric major.minor.patch + optional pre-release).
# Build-metadata (`+...`) is intentionally rejected: GitHub release tags
# can't contain `+`, and we tag from the version directly.
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "error: '$NEW_VERSION' is not a valid SemVer version (expected x.y.z or x.y.z-pre)" >&2
  exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if ! git diff-index --quiet HEAD --; then
  echo "error: working tree has uncommitted changes — release commits must be clean" >&2
  echo "       run 'git status' to inspect, stash or commit before bumping" >&2
  exit 1
fi

CURRENT_VERSION=$(node -p "require('./package.json').version")
if [ "$CURRENT_VERSION" = "$NEW_VERSION" ]; then
  echo "error: current version is already $NEW_VERSION" >&2
  exit 1
fi

# Numeric comparison via sort -V; refuses regressions like 1.0.0 -> 0.9.9.
# Pre-releases sort before their final (1.0.0-rc.1 < 1.0.0), which is correct.
LOWER=$(printf '%s\n%s\n' "$CURRENT_VERSION" "$NEW_VERSION" | sort -V | head -n1)
if [ "$LOWER" != "$CURRENT_VERSION" ]; then
  echo "error: new version $NEW_VERSION is not greater than current $CURRENT_VERSION" >&2
  exit 1
fi

# Verify the Unreleased section actually has content. Empty Unreleased
# usually means "I bumped before writing the changelog entry" — which
# produces a release with no notes. --allow-empty is the escape hatch
# for genuinely-no-user-facing-changes releases (rare, but happens for
# infra-only cuts).
UNRELEASED_BODY=$(awk '
  /^## \[Unreleased\]/ { in_section = 1; next }
  in_section && /^## \[/ { exit }
  in_section { print }
' CHANGELOG.md | sed '/^[[:space:]]*$/d')
if [ -z "$UNRELEASED_BODY" ] && [ "$ALLOW_EMPTY" -ne 1 ]; then
  echo "error: ## [Unreleased] in CHANGELOG.md is empty" >&2
  echo "       add entries describing this release, or pass --allow-empty for an infra-only cut" >&2
  exit 1
fi

TODAY=$(date +%Y-%m-%d)

echo "Bumping $CURRENT_VERSION -> $NEW_VERSION (release date $TODAY)"

# --- Update the three package.json files via node, preserving formatting.
#
# We deliberately don't use `npm version` because (a) it creates a git
# commit and tag automatically, which we want to do manually after
# review, and (b) it doesn't touch workspace package.json files.
update_package_json() {
  local file="$1"
  node -e "
    const fs = require('node:fs');
    const path = '$file';
    const content = fs.readFileSync(path, 'utf8');
    const indent = content.match(/^(\s+)\"/m)?.[1] ?? '  ';
    const data = JSON.parse(content);
    if (data.version === undefined) {
      console.error(\`error: \${path} has no version field\`);
      process.exit(1);
    }
    data.version = '$NEW_VERSION';
    const trailingNewline = content.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(path, JSON.stringify(data, null, indent) + trailingNewline);
  "
  echo "  updated $file"
}

update_package_json package.json
update_package_json packages/server/package.json
update_package_json packages/client/package.json

# Also bump the lockfile so `npm ci` in CI doesn't complain about a
# version mismatch between package.json and package-lock.json. Run
# `npm install` with --package-lock-only to refresh just the lockfile
# without touching node_modules — fast and side-effect free.
if [ -f package-lock.json ]; then
  echo "  refreshing package-lock.json"
  npm install --package-lock-only --silent
fi

# --- CHANGELOG: rename Unreleased and insert a fresh empty section above it.
#
# Done with awk to avoid sed's portability landmines (BSD vs GNU
# in-place differs, multiline replacements are awkward). The output
# is written to a temp file then mv'd over — atomic on the same
# filesystem.
TMP_CHANGELOG=$(mktemp)
awk -v ver="$NEW_VERSION" -v date="$TODAY" '
  /^## \[Unreleased\]/ && !done {
    print "## [Unreleased]"
    print ""
    print "## [" ver "] — " date
    done = 1
    next
  }
  { print }
' CHANGELOG.md > "$TMP_CHANGELOG"
mv "$TMP_CHANGELOG" CHANGELOG.md
echo "  updated CHANGELOG.md"

git add package.json packages/server/package.json packages/client/package.json CHANGELOG.md
[ -f package-lock.json ] && git add package-lock.json

cat <<EOF

Done. Review staged changes:
  git diff --cached

Then commit on a release branch:
  git checkout -b release/v$NEW_VERSION
  git commit -m "chore(release): v$NEW_VERSION"
  git push -u origin release/v$NEW_VERSION
  gh pr create --base main --title "chore(release): v$NEW_VERSION" --fill

After the PR merges into main, tag from main:
  git checkout main && git pull --ff-only
  git tag v$NEW_VERSION
  git push origin v$NEW_VERSION

The release workflow will build the multi-arch image and create the
GitHub Release automatically.
EOF
