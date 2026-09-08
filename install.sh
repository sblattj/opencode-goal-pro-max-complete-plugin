#!/bin/sh
# Bootstrap installer for opencode-goal-pro-max-complete-plugin.
#
#   curl -fsSL https://raw.githubusercontent.com/sblattj/opencode-goal-pro-max-complete-plugin/main/install.sh | sh
#   sh install.sh --dry-run
#
# This script exists only for people who do not have (or do not want) npx. It
# runs the same installer either way — scripts/cli.mjs — and passes every
# argument straight through, so `--dry-run`, `status` and `uninstall` all work:
#
#   sh install.sh status
#
# Set GOAL_PLUGIN_REF to install a specific tag or branch (default: main).
#
# Exit codes are the CLI's own (0 ok, 1 failed, 2 usage, 3 refused), except 2
# from this script when neither npx nor git+node is available.
set -eu

OWNER_REPO="sblattj/opencode-goal-pro-max-complete-plugin"
REPO_URL="https://github.com/${OWNER_REPO}.git"
REF="${GOAL_PLUGIN_REF:-}"

if command -v npx >/dev/null 2>&1; then
  if [ -n "$REF" ]; then
    exec npx -y "github:${OWNER_REPO}#${REF}" install "$@"
  fi
  exec npx -y "github:${OWNER_REPO}" install "$@"
fi

if command -v git >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  workdir=$(mktemp -d)
  # shellcheck disable=SC2064  # workdir is expanded now on purpose.
  trap "rm -rf '$workdir'" EXIT HUP INT TERM
  if [ -n "$REF" ]; then
    git clone --quiet --depth 1 --branch "$REF" "$REPO_URL" "$workdir/package"
  else
    git clone --quiet --depth 1 "$REPO_URL" "$workdir/package"
  fi
  node "$workdir/package/scripts/cli.mjs" install "$@"
  exit $?
fi

echo "opencode-goal-pro-max-complete-plugin: no way to install from here." >&2
echo "Install Node.js 18 or newer (which brings npx), then re-run:" >&2
echo "  npx -y github:${OWNER_REPO} install" >&2
echo "Or clone the repository and run: node scripts/cli.mjs install" >&2
exit 2
