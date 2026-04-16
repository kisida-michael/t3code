# Lessons

- Under Bun, desktop runtime dependencies with required lifecycle downloads must be listed in root `trustedDependencies`; otherwise packages like `electron` install without their binary payload and dev startup fails at launch time.
- On Node 23+ with direct TypeScript execution, CLI scripts should not rely on `import.meta.main`; use an explicit `process.argv[1]` vs `fileURLToPath(import.meta.url)` check or release/build scripts can exit successfully without doing any work.
- When fixing behavior on a side branch for local testing, verify the user is actually running that branch before claiming the UI should reflect the change; otherwise the code can be correct in the PR but absent from the active checkout.
