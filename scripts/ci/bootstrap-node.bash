#!/usr/bin/env bash
# Sourced by CI entrypoints. Installs only into their private, external temp root.
work_hub_ci_bootstrap_node() {
  local tools="$1" expected current archive actual_source actual_tools command
  expected="$(<.node-version)"
  if [[ "$expected" != 24.22.1 ]]; then
    printf '%s\n' 'Update the reviewed CI Node archive digest when changing .node-version.' >&2
    return 2
  fi
  current="$(node -p process.versions.node 2>/dev/null || true)"
  if [[ "$current" == "$expected" ]]; then return 0; fi
  if [[ "$(uname -s):$(uname -m)" != Linux:x86_64 ]]; then
    printf '%s\n' 'CI Node bootstrap requires Linux x86-64.' >&2
    return 2
  fi
  for command in curl sha256sum tar xz realpath; do
    if ! command -v "$command" >/dev/null; then
      printf 'CI job image must supply %s for the pinned Node bootstrap.\n' "$command" >&2
      return 2
    fi
  done
  actual_source="$(pwd -P)"
  actual_tools="$(realpath -m -- "$tools")"
  case "$actual_tools/" in
    "${actual_source%/}/"*) printf '%s\n' 'CI tools must remain outside the authoritative source checkout.' >&2; return 2 ;;
  esac
  mkdir -p -- "$actual_tools"
  archive="$actual_tools/node.tar.xz"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --connect-timeout 15 --max-time 300 --retry 2 \
    --output "$archive" 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz' || return
  printf '%s  %s\n' '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6' "$archive" | sha256sum --check --status || return
  mkdir -- "$actual_tools/node"
  tar -xJf "$archive" --strip-components=1 -C "$actual_tools/node" || return
  rm -f -- "$archive"
  export PATH="$actual_tools/node/bin:$PATH"
  [[ "$(node -p process.versions.node)" == "$expected" ]] || {
    printf '%s\n' 'Bootstrapped Node version does not match the reviewed pin.' >&2
    return 2
  }
}
