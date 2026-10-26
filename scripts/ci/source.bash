#!/usr/bin/env bash
set -euo pipefail

# DIM runs the verified script copy with the authoritative source tree as its cwd.
# Keep source verification independent of browser runtime installation.
if [[ ! -e .git && ! -L .git ]]; then
  snapshot_source_root="$(pwd -P)"
  snapshot_git="$(mktemp -d "${TMPDIR:-/tmp}/work-hub-source-git.XXXXXX")"
  trap 'rm -rf -- "$snapshot_git"' EXIT
  snapshot_git="$(cd "$snapshot_git" && pwd -P)"
  case "$snapshot_git/" in
    "${snapshot_source_root%/}/"*)
      printf '%s\n' 'Source snapshot Git metadata must be outside the authoritative source tree.' >&2
      exit 2
      ;;
  esac
  # Snapshot membership is authoritative: index ignored paths too, before npm
  # creates derived files. This index supplies no history, remote or CI authority.
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
  git init --quiet "$snapshot_git"
  export GIT_DIR="$snapshot_git/.git" GIT_WORK_TREE="$snapshot_source_root" GIT_INDEX_FILE="$snapshot_git/.git/index"
  git add --force --all -- .
fi
npm ci --no-audit --no-fund
npm run quality
