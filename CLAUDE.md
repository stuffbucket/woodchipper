# CLAUDE.md

This file provides guidance to Claude Code (`claude.ai/code`) and 5.5-series Claude models when working in `woodchipper`.

## Project Purpose

`woodchipper` combines:
1. **`morluto/rea` (`rea-agents@6.7.0`)** — the Reverse Engineer Anything MCP server (`207` MCP tools, `153` CLI commands, `6` guided prompts), contracts, bridges, and reference documentation (`vendor/rea/`).
2. **`JoasASantos/REA-Prompts` (REAP)** — the human-to-agent reverse-engineering prompt catalog (`vendor/rea-prompts/README.md`).
3. **`earendil-works/pi` (`@earendil-works/pi-coding-agent@1.4.0`)** — vendored as a Git submodule at `vendor/pi` and customized via `.pi/extensions/` (`woodchipper-maximal.ts`, `woodchipper-rea.ts`, `woodchipper-peer.ts`), `.pi/SYSTEM.md`, `.pi/settings.json`, `bin/woodchipper.mjs`, and `scripts/woodchipper-ctl.mjs`.
4. **`stuffbucket/gliner-runner` (`@gliner-runner/onnx-runner@0.4.0`, `decide-340m`)** — vendored as a Git submodule at `vendor/gliner-runner` and wired via `.pi/extensions/lib/gliner-classifier.ts` (`woodchipper_classify` tool & `/gliner` command) to auto-pull `decide-340m` when missing and classify plain-English user questions and binary strings/imports without requiring reverse-engineering domain knowledge.

And reorganizes them into a **dual-surface Pi reverse-engineering harness** (interactive human TUI + native Claude Code `peerProtocol: 1` A2A socket), a **progressive-disclosure skill pack (`skills/woodchipper*`)**, **deterministic multi-agent workflows (`.claude/workflows/*.js`)**, and **structured playbooks (`playbooks/*.md`)** tailored for Claude 5.5-series models.

## Operating Discipline for 5.5-Series Models

1. **Progressive Disclosure First:** Start with `skills/woodchipper/SKILL.md` and load only the domain sub-skill matching the target artifact (`woodchipper-native`, `woodchipper-js-web`, `woodchipper-mobile-managed`, `woodchipper-firmware-signals`, `woodchipper-runtime`, `woodchipper-reconstruction`, `woodchipper-audit`, or `woodchipper-setup`). Read `vendor/rea/docs/` only when you need exact provider edge cases.
2. **Summary-First Context Protection:** Never dump full JS bundles, symbol tables, or decompilations into context. Always pass `detail: "summary"` first on large targets (`analyze_javascript_application`, `inspect_binary_layout`, `inspect_macho`, `inspect_artifact`, `inspect_managed_artifact`, `inspect_managed_members`, `inspect_wasm_artifact`, `inspect_web_network_capture`, `decode_interface_builder`, `inspect_evm_interface`, `inspect_android_package`, `inspect_pcap_capture`, `inspect_dart_aot`, `get_evidence_bundle`), save `parent_evidence_id`, and page slices via `inspect_analysis_view`.
3. **Target-Free vs. Active-Session Tools:** Run target-free path-based tools (`analyze_javascript_application`, `inspect_binary_layout`, `inspect_go_binary`, `inspect_rust_binary`, `inspect_pe_resources`, `inspect_sqlite_database`, `inspect_android_package`, `inspect_managed_artifact`, `inspect_wasm_artifact`, `inspect_evm_interface`, `inspect_firmware_regions`, `inspect_plist`) directly on disk paths before paying the cost of `open_binary`.
4. **Three-Bucket Epistemology:** Separate every finding into **Observations** (tool output + `evidence_id` + address/file location), **Inferences** (hypotheses with confidence and competing explanations), and **Unknowns** (tracked via `woodchipper_ledger` or `record_unknown`).
5. **Defensive & Clean-Room Scope:** Assist with authorized security testing, defensive vulnerability auditing, interoperability, clean-room behavioral specifications, crash triage, and CTF/educational analysis.

## Toolchain, Headless Ghidra, & Commands (`mise` + `pnpm`)

This repository uses **`mise`** (`mise.toml`) and **`pnpm`** (`pnpm@12.11.2`, Node `24.22.1`, Python `3.12.15`, Temurin JDK `21.0.12+101.0.LTS`), with `rea-agents@6.7.0` installed locally via `pnpm` and headless Ghidra `12.1.4` configured at `~/.local/share/ghidra/ghidra_12.1.4_PUBLIC` (including the native macOS `arm64` Mach-O `decompile` binary). Submodules are exact SHA pins with adjacent semver comments in `.gitmodules`. Until the configured package proxy mirrors `jose@6.2.13` and `fast-uri@3.1.9`, setup builds their isolated `vendor/overrides/*` submodules in the purpose-built Docker container. It then copies immutable `vendor/pi` into `.woodchipper/pi`, excludes two unused example-only dependency roots with no proxy fix, applies the exact proxy-available audit fixes from `vendor/overrides/pi-audit.json`, builds offline, and requires a zero-finding npm audit; see `vendor/overrides/README.md`.

```bash
# Build temporary dependency overrides in Docker, install dependencies, and build/verify the Pi harness
mise run setup        # or: pnpm run setup (requires Docker with Buildx)

# Launch interactive Woodchipper Pi TUI (also registers live Claude Code peerProtocol:1 socket)
mise run tui          # or: pnpm run woodchipper -- tui

# Launch headless Woodchipper Pi peer daemon (controllable via Claude Code SendMessage or woodchipper-ctl)
mise run daemon       # or: pnpm run daemon

# Control or message Woodchipper / Claude Code peers over UDS
mise run ctl -- peers
mise run ctl -- send woodchipper "Triage /path/to/binary" --wait

# Run REA environment & backend readiness check (Ghidra 12.1.4 + Skill Identity)
mise run doctor       # or: pnpm run doctor

# Validate skills, workflows, Pi harness extensions, and vendor manifest
mise run validate     # or: pnpm run validate

# Run test suite and 13-mutant security/logic mutation suite
mise run test         # or: pnpm test
mise run test:mutate  # or: pnpm run test:mutate

# Sync woodchipper skills into ../skills/plugins/stuffbucket/skills
mise run sync:skills  # or: pnpm run sync:skills

# Refresh vendored upstream snapshots from morluto/rea and JoasASantos/REA-Prompts
mise run update:vendor # or: pnpm run update:vendor
```
