#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/update-local-copilot.sh rebase [branch] [upstream-ref]
  scripts/update-local-copilot.sh refresh <target-branch> [upstream-ref] -- <commit> [<commit>...]
  scripts/update-local-copilot.sh push [remote] [branch]
  scripts/update-local-copilot.sh status

Commands:
  rebase
    Fetch upstream and rebase the selected branch on top of upstream/main.
    Defaults:
      branch       current branch
      upstream-ref upstream/main

  refresh
    Rebuild a local overlay branch from a fresh upstream ref and cherry-pick
    the listed local-only commits on top.
    Example:
      scripts/update-local-copilot.sh refresh local/github-copilot upstream/main -- abc123 def456

  push
    Push the rewritten overlay branch safely with force-with-lease.
    Defaults:
      remote fork
      branch current branch

  status
    Show the current branch, remotes, and rerere configuration.

Notes:
  - This script refuses to run update commands on a dirty worktree.
  - Resolve conflicts normally, then use:
      git add <files>
      git rebase --continue
    or, during cherry-pick:
      git add <files>
      git cherry-pick --continue

  After a successful rebase or refresh, update the fork branch with:
      scripts/update-local-copilot.sh push
EOF
}

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

require_clean_worktree() {
  if [[ -n "$(git status --short)" ]]; then
    echo "Working tree is dirty. Commit or stash changes before running update flows." >&2
    exit 1
  fi
}

require_upstream_remote() {
  if ! git remote get-url upstream >/dev/null 2>&1; then
    echo "Missing 'upstream' remote. Configure it first." >&2
    exit 1
  fi
}

print_status() {
  local branch
  branch="$(git branch --show-current)"

  echo "Branch: ${branch:-DETACHED}"
  echo "Remotes:"
  git remote -v
  echo
  echo "rerere.enabled=$(git config --local --get rerere.enabled || echo unset)"
  echo "rerere.autoupdate=$(git config --local --get rerere.autoupdate || echo unset)"
}

run_rebase() {
  local branch="${1:-$(git branch --show-current)}"
  local upstream_ref="${2:-upstream/main}"

  if [[ -z "$branch" ]]; then
    echo "No current branch detected. Pass the branch name explicitly." >&2
    exit 1
  fi

  require_clean_worktree
  require_upstream_remote

  git fetch upstream
  git checkout "$branch"
  git rebase "$upstream_ref"
}

run_refresh() {
  if [[ $# -lt 1 ]]; then
    echo "refresh requires a target branch." >&2
    usage
    exit 1
  fi

  local target_branch="$1"
  shift

  local upstream_ref="upstream/main"
  if [[ $# -gt 0 && "$1" != "--" ]]; then
    upstream_ref="$1"
    shift
  fi

  if [[ $# -eq 0 || "$1" != "--" ]]; then
    echo "refresh requires '--' followed by one or more commit SHAs." >&2
    usage
    exit 1
  fi
  shift

  if [[ $# -eq 0 ]]; then
    echo "refresh requires at least one commit SHA after '--'." >&2
    exit 1
  fi

  require_clean_worktree
  require_upstream_remote

  git fetch upstream
  git checkout -B "$target_branch" "$upstream_ref"
  git cherry-pick "$@"
}

run_push() {
  local remote="${1:-fork}"
  local branch="${2:-$(git branch --show-current)}"

  if [[ -z "$branch" ]]; then
    echo "No current branch detected. Pass the branch name explicitly." >&2
    exit 1
  fi

  git push --force-with-lease "$remote" "$branch"
}

command="${1:-}"
if [[ -z "$command" ]]; then
  usage
  exit 1
fi
shift || true

case "$command" in
  rebase)
    run_rebase "$@"
    ;;
  refresh)
    run_refresh "$@"
    ;;
  push)
    run_push "$@"
    ;;
  status)
    print_status
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "Unknown command: $command" >&2
    usage
    exit 1
    ;;
esac
