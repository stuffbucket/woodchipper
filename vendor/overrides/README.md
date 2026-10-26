# Temporary dependency overrides

This directory isolates source-built packages that the configured package proxy has not mirrored yet and the exact audit overlay applied to the Pi build. It remains separate from Woodchipper source and from every upstream checkout.

## Layout

- `jose/` and `fast-uri/` are git submodules pinned to the exact patched release commits.
- `Dockerfile` is the only supported build environment. It copies the submodule sources into a
  purpose-built Node 24 container, builds `jose`, packages the source-only `fast-uri`, and runs
  focused smoke tests without modifying either checkout.
- `packages/` is ignored generated output. pnpm overrides link to these installable package trees.
- `manifest.json` binds each package submodule commit, package version, generated output, and override value.
- `pi-audit.json` binds the Pi submodule SHA and semver, exact proxy-available dependency fixes, expected lock results, and the example-only dependencies excluded from the runtime build.
- `scripts/build-pi-overlay.mjs` copies the immutable Pi source into ignored `.woodchipper/pi`, applies the audit overlay, regenerates its lock only through the configured proxy, installs with scripts disabled, builds offline, and requires a zero-finding audit. The source submodule is never edited.

Run `pnpm run build:overrides` after initializing submodules. The builder reads the effective registry
from pnpm (normally inherited from `~/.npmrc`) and exposes `~/.npmrc` to the build only as an optional
BuildKit secret. Registry credentials are never copied into the build context or image layers. Then run `pnpm run build:pi` (or the full `pnpm run setup`) to build and audit the staged Pi runtime.

## Audit disposition

The proxy supplies patched Vitest, Vite, Undici, and Zod releases, and the local Docker package supplies patched `fast-uri@3.1.9`. Two remaining vulnerable roots have no compatible proxy fix, but neither participates in the Pi runtime build:

- Root devDependency `@anthropic-ai/sandbox-runtime@0.0.26` exists to support the sandbox example and requires vulnerable Zod 3.
- The Gondolin example workspace depends on a Gondolin release that uses vulnerable node-forge; the proxy stops before the upstream release that removes it.

The staged runtime therefore omits those two example workspaces/dependencies while leaving `vendor/pi` unchanged. The resulting full npm audit has zero findings, and `allowed_audit_findings` is intentionally empty so any new advisory fails the build.

## Removal

Once the proxy serves both source-pinned releases and a pinned Pi release audits clean without the overlay:

1. Remove the `jose` and `fast-uri` link entries from `pnpm-workspace.yaml` and the Docker override build step from `package.json`; retain the exact Zod pin until REA's graph is patched upstream.
2. Remove the `vendor/overrides/jose` and `vendor/overrides/fast-uri` submodules and their `.gitmodules` entries.
3. Remove `pi-audit.json` and `scripts/build-pi-overlay.mjs` only after a newly SHA-pinned Pi release passes a full audit directly from its immutable submodule.
4. Remove the remaining Docker override files and related validation checks, regenerate `pnpm-lock.yaml` through the proxy, and run the complete validation and test suites.

No Woodchipper source imports either override path directly, so removal is a dependency-resolution
change rather than an application-code migration.
