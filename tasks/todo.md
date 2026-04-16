# TODO

## Plan

- [x] Extend GitHub Copilot settings with named account profiles while preserving the existing raw `configDir` field for backward compatibility.
- [x] Update server-side Copilot provider startup/status code to use the selected profile config dir when present, falling back to the raw config dir.
- [x] Add a compact settings UI for choosing and editing personal/work Copilot profiles.
- [x] Add focused tests for profile resolution and validate with `bun fmt`, `bun lint`, and `bun typecheck`.

## Notes

- User wants an easy in-T3 account switcher for GitHub Copilot, backed by separate Copilot config directories such as `~/.copilot-personal` and `~/.copilot-work`.

## Review

- Added named GitHub Copilot account profiles to server settings with default `Personal` and `Work` entries, while keeping the existing manual `configDir` fallback for older settings files.
- Added [githubCopilotSettings.ts](/Users/michaelkisida/t3code/apps/server/src/provider/githubCopilotSettings.ts:1) so provider refresh and thread sessions resolve the same effective config directory, including `~/` expansion.
- Updated [SettingsPanels.tsx](/Users/michaelkisida/t3code/apps/web/src/components/settings/SettingsPanels.tsx:1) with a Copilot account selector, editable profile rows, and an add/remove flow.
- Verified with `bun fmt`, `bun lint`, `bun typecheck`, and `cd apps/server && bun run test src/provider/Layers/ProviderRegistry.test.ts`; lint still reports the same pre-existing unrelated warnings.

## Plan

- [x] Inspect the GitHub Copilot model discovery path and replace the fragile CLI-help parsing that now misclassifies `text/json` as models.
- [x] Add focused regression coverage for current Copilot CLI help output so `--output-format` choices cannot leak into the provider model list.
- [x] Validate with `bun fmt`, `bun lint`, and `bun typecheck`.
- [x] Commit the fix, push a branch, and open a draft PR on the fork.

## Notes

- User has GitHub Copilot premium access, but T3 Code only exposes `text` and `json` as Copilot models because the local provider parses current CLI help incorrectly.

## Review

- Fixed [GitHubCopilotProvider.ts](/Users/michaelkisida/t3code/apps/server/src/provider/Layers/GitHubCopilotProvider.ts:1) so provider model discovery no longer scrapes `--output-format (choices: "text", "json")` as if those were model IDs.
- Provider status now prefers real Copilot ACP session `configOptions` for model discovery, and only falls back to safe built-in models when the session probe is unavailable.
- Added regression coverage in [ProviderRegistry.test.ts](/Users/michaelkisida/t3code/apps/server/src/provider/Layers/ProviderRegistry.test.ts:1) for both the current CLI help shape and ACP-derived model options.
- Verified with `bun fmt`, `bun lint`, `bun typecheck`, and `cd apps/server && bun run test src/provider/Layers/ProviderRegistry.test.ts`.
- Published commit `da59865e` on branch `codex/copilot-model-discovery-fix` and opened draft PR [#1](https://github.com/kisida-michael/t3code/pull/1) against `kisida-michael/t3code:local/github-copilot`.

## Plan

- [x] Inspect desktop update feed and release workflow assumptions to identify what blocks fork-based releases and updates.
- [x] Patch local builds and GitHub Actions so desktop artifacts built from this fork target fork-hosted GitHub releases for updates.
- [x] Enable the Release workflow on the fork and document the fork release process and remaining secret requirements.
- [x] Verify formatting, lint, and typecheck after the release/fork changes.

## Notes

- User wants packaged DMGs, update feeds, and release CI to work from the `kisida-michael/t3code` fork instead of upstream.

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

- Fork desktop release/update wiring now works without upstream-only assumptions:
  local packaged builds infer the GitHub update repository from git remotes in priority order `fork`, `origin`, `upstream`, and the release workflow skips npm publish plus stable finalize/version-bump jobs when running outside `pingdotgg/t3code`.
- Updated [release.md](/Users/michaelkisida/t3code/docs/release.md:1) with fork-release behavior, required setup, and the remaining optional signing secret requirements.
- Enabled the `Release` workflow on `kisida-michael/t3code`, so the fork can now run manual or tag-triggered desktop release CI without any extra GitHub-side setup beyond optional signing secrets.
- Verified local unsigned DMG packaging on macOS arm64 with `bun run dist:desktop:dmg:arm64 -- --build-version 0.0.17-fork.2 --output-dir /tmp/t3code-dmg-test --verbose`, which produced `/tmp/t3code-dmg-test/T3-Code-0.0.17-fork.2-arm64.dmg` plus the matching updater metadata files.
- Fixed the remaining Node 23 TypeScript entrypoint issue in `scripts/build-desktop-artifact.ts` and `scripts/resolve-nightly-release.ts` so local packaging and nightly-release metadata generation do not silently no-op under direct `node` execution.
- Verified with `bun fmt`, `bun lint`, and `bun typecheck`; lint still reports the same unrelated web warnings, and typecheck still reports the same non-failing Copilot adapter Effect advisories.

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
