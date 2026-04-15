# Local Copilot Overlay Workflow

This repo carries a local-only GitHub Copilot provider overlay that should stay separate from normal upstream updates.

## One-time setup

Configure conflict memory inside this repo:

```bash
git config --local rerere.enabled true
git config --local rerere.autoupdate true
```

Ensure the canonical upstream remote exists:

```bash
git remote add upstream https://github.com/pingdotgg/t3code.git
```

If `upstream` already exists, leave it alone.

## Recommended branch model

- Keep `main` tracking upstream.
- Keep local-only work on a separate branch such as `local/github-copilot`.
- Keep the overlay as a small stack of focused commits.

## Routine update flow

For normal upstream pulls, rebase the local overlay branch:

```bash
scripts/update-local-copilot.sh rebase local/github-copilot upstream/main
```

If you are already on the overlay branch, you can omit the branch name:

```bash
scripts/update-local-copilot.sh rebase
```

## Rebuild flow

If the branch drifts too far or conflict resolution becomes noisy, rebuild the overlay branch from a fresh upstream tip and replay only the local commits:

```bash
scripts/update-local-copilot.sh refresh local/github-copilot upstream/main -- <commit> [<commit>...]
```

Example:

```bash
scripts/update-local-copilot.sh refresh local/github-copilot upstream/main -- abc1234 def5678
```

## Conflict handling

When a rebase or cherry-pick stops on conflicts:

```bash
git add <resolved-files>
git rebase --continue
```

Or during refresh:

```bash
git add <resolved-files>
git cherry-pick --continue
```

Because `rerere` is enabled, repeated conflicts should auto-apply your prior resolutions.

## Validation

After any successful update, run:

```bash
bun fmt
bun lint
bun typecheck
```
