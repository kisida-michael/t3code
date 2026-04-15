# TODO

## Plan

- [x] Inspect the repo git remote/config state and confirm the local-only integration update strategy can be applied safely.
- [x] Configure repo-local git conflict memory and an `upstream` remote alias for the canonical source repo.
- [x] Add a repeatable local update helper for rebasing or rebuilding the local Copilot overlay onto upstream changes.
- [x] Document the workflow and verify formatting, lint, and typecheck still pass.

## Notes

- User wants the local-only GitHub Copilot overlay to stay maintainable across upstream repo updates and merge conflicts.

## Plan

- [x] Back up the production state database before modifying persisted pending approvals.
- [x] Clear all currently pending approval rows from the production state database and synchronize thread pending-approval counters.
- [x] Verify the pending approval counts drop to zero and record the result.

## Notes

- User requested clearing all currently existing `Pending Approval` entries from the production installation state.

## Plan

- [x] Repair the Electron dependency install so the desktop binary is present under Bun-managed `node_modules`.
- [x] Validate the desktop dev stack by running `bun dev:desktop` until the Electron shell launches successfully.
- [x] Document the runtime fix and verification results in the review section.

## Notes

- Current blocker: Bun installed the `electron` package metadata, but did not run Electron's postinstall download step, so `node_modules/.bun/electron@40.6.0/node_modules/electron/dist` is missing and desktop launch fails.

## Plan

- [x] Introduce a small provider catalog/extension seam so provider lists, defaults, display metadata, and settings ordering stop being duplicated across the codebase.
- [x] Add a local-only `githubCopilot` provider implementation using GitHub Copilot CLI ACP over stdio, with isolated provider files and minimal edits to shared routing points.
- [x] Thread `githubCopilot` through contracts, server settings, provider status refresh, session persistence, and web provider/model selection UI without regressing Codex or Claude.
- [x] Add focused tests for provider settings, provider registry/refresh, model selection, and the Copilot provider probe/adapter surface.
- [x] Validate with `bun fmt`, `bun lint`, and `bun typecheck`.

## Notes

- Goal: keep the Copilot-specific implementation as isolated as possible so upstream merges primarily touch shared provider catalog seams instead of provider internals.
- External dependency: local `copilot` CLI is installed at `/opt/homebrew/bin/copilot` and supports `--acp`, but the installed version is `1.0.5` while `1.0.26` is available.

## Review

- Added repo-local conflict memory with `rerere.enabled=true` and `rerere.autoupdate=true`, and added an `upstream` remote alias pointing at `https://github.com/pingdotgg/t3code.git`.
- Added [update-local-copilot.sh](/Users/michaelkisida/t3code/scripts/update-local-copilot.sh:1) plus a root script alias `bun update:local-copilot` for the two supported maintenance flows: `rebase` and `refresh` (fresh upstream branch plus cherry-picks).
- Documented the workflow in [local-copilot-overlay.md](/Users/michaelkisida/t3code/docs/local-copilot-overlay.md:1), including branch model, conflict handling, and validation steps.
- Created the dedicated overlay branch `local/github-copilot` with a small local commit stack:
  `111b6f2b feat(local): add github copilot provider overlay`
  `bb1ac8f6 chore(local): add update workflow and desktop runtime fixes`
- Verified with `bun fmt`, `bun lint`, and `bun typecheck`; lint still reports the same unrelated web warnings, and typecheck still reports the same non-failing Copilot adapter Effect advisories.

- Cleared stale production pending-request state directly in `~/.t3/userdata/state.sqlite` after creating a consistent SQLite backup at `/Users/michaelkisida/.t3/userdata/state.sqlite.pending-approvals-backup-20260414-231451`.
- Updated all 45 rows in `projection_pending_approvals` from `pending` to `resolved` and recomputed `projection_threads.pending_approval_count` for all threads.
- Verified the cleanup: `projection_pending_approvals where status='pending'` is now `0`, and `projection_threads where pending_approval_count > 0` is now `0`.

- Desktop dev startup was failing because Bun had installed the `electron` package without running its postinstall download step, leaving `node_modules/.bun/electron@40.6.0/node_modules/electron/dist` missing.
- Added `electron` to root `trustedDependencies` and re-ran `bun install`, which restored the Electron binary bundle and `path.txt`.
- Verified `bun dev:desktop` now starts successfully: Vite serves `http://127.0.0.1:5733`, the Electron-managed server listens on `http://127.0.0.1:13773`, and the `T3 Code (Dev)` Electron processes remain running.

- Added `githubCopilot` as a first-class provider kind behind a shared provider catalog seam so local Copilot support stays isolated and future upstream merges mostly converge on the shared catalog/registry touchpoints.
- Implemented a local ACP-backed GitHub Copilot adapter/provider using the installed `copilot` CLI, with lightweight install/version probing and session startup over `copilot --acp --stdio`.
- Threaded the provider through contracts, server registries, provider status caching, settings, model normalization, composer state, provider pickers, and settings UI. Git text-generation settings intentionally remain limited to Codex and Claude so existing commit/PR/title generation routing is not destabilized.
- Validation:
  `bun fmt`
  `bun lint`
  `bun typecheck`
  `cd apps/server && bun run test src/provider/Layers/ProviderAdapterRegistry.test.ts`
