# Changelog

All notable changes to `@stuffbucket/woodchipper` are documented in this file.

## [1.0.2](https://github.com/stuffbucket/woodchipper/compare/v1.0.1...v1.0.2) (2026-10-28)


### Bug Fixes

* **ci:** normalize Pi overlay tarball URLs and streamline release workflow ([c2eff3e](https://github.com/stuffbucket/woodchipper/commit/c2eff3ef6e59285a51aa67b0cfeb051157bc3a12))
* **ci:** normalize Pi overlay tarball URLs and streamline release workflow ([25fee44](https://github.com/stuffbucket/woodchipper/commit/25fee44caf40d29df27f0306c043028409e25728))

## [1.0.1](https://github.com/stuffbucket/woodchipper/compare/v1.0.0...v1.0.1) (2026-10-28)


### Bug Fixes

* **ci:** configure release-please tag format and drop raw submodule dependabot ([d81cd82](https://github.com/stuffbucket/woodchipper/commit/d81cd82b44693ce1c8d5d6ec7461e60645e13410))
* **ci:** configure release-please tag format and drop raw submodule dependabot ([f4f05ba](https://github.com/stuffbucket/woodchipper/commit/f4f05ba77014ac896ac88fc42027dbbc3203f9c0))
* **ci:** package compact release archive in release workflow ([5f452f9](https://github.com/stuffbucket/woodchipper/commit/5f452f9d717706cea6efbee5626ab0947c8d3ce4))

## [1.0.0](https://github.com/stuffbucket/woodchipper/releases/tag/v1.0.0) (2026-10-28)

### Features

- Dual-surface Pi reverse-engineering harness (`tui`, `daemon`, `rpc`, `ask`, `clean`) with `morluto/rea` (`rea-agents@6.7.0`), REAP playbooks, and GLiNER (`decide-340m`) zero-jargon routing
- Standalone cross-platform (`darwin`, `linux`, `win32`) `pi-flow` workflow extension (`/goal`, `/branch`, `/loop`, `/monitor`, `/watch`, `/mapreduce`, `/halt`, `/flow`)
- Cross-platform disk hygiene, threshold configuration (`~/.config/woodchipper/config.json` / `%APPDATA%\woodchipper\config.json`), and `/clean` / `./woodchipper clean` resource reclamation
- Homebrew tap formula template (`packaging/homebrew/woodchipper.rb`) and automated release sync
