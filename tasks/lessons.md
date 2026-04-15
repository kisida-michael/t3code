# Lessons

- Under Bun, desktop runtime dependencies with required lifecycle downloads must be listed in root `trustedDependencies`; otherwise packages like `electron` install without their binary payload and dev startup fails at launch time.
