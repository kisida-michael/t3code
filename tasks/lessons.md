# Lessons

- Under Bun, desktop runtime dependencies with required lifecycle downloads must be listed in root `trustedDependencies`; otherwise packages like `electron` install without their binary payload and dev startup fails at launch time.
- On Node 23+ with direct TypeScript execution, CLI scripts should not rely on `import.meta.main`; use an explicit `process.argv[1]` vs `fileURLToPath(import.meta.url)` check or release/build scripts can exit successfully without doing any work.
