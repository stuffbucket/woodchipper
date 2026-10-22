# CLAUDE.md

This file provides guidance to Claude Code (`claude.ai/code`) and 5.5-series Claude models when working in `woodchipper`.

## Project Purpose

`woodchipper` combines:
1. **`morluto/rea` (`rea-agents@6.7.0`)** — the Reverse Engineer Anything MCP server, CLI, contracts, bridges, and reference documentation (`vendor/rea/`).
2. **`JoasASantos/REA-Prompts` (REAP)** — the human-to-agent reverse-engineering prompt catalog (`vendor/rea-prompts/README.md`).

And reorganizes them into a **progressive-disclosure skill pack (`skills/woodchipper*`)**, **deterministic multi-agent workflows (`.claude/workflows/*.js`)**, and **structured playbooks (`playbooks/*.md`)** tailored for Claude 5.5-series models and the Claude Code harness.

## Operating Discipline for 5.5-Series Models

1. **Progressive Disclosure First:** Start with `skills/woodchipper/SKILL.md` and load only the domain sub-skill matching the target artifact (`woodchipper-native`, `woodchipper-js-web`, `woodchipper-mobile-managed`, `woodchipper-firmware-signals`, `woodchipper-runtime`, `woodchipper-reconstruction`, `woodchipper-audit`, or `woodchipper-setup`). Read `vendor/rea/docs/` only when you need exact provider edge cases.
2. **Summary-First Context Protection:** Never dump full JS bundles, symbol tables, or decompilations into context. Always pass `detail: "summary"` first on large targets (`analyze_javascript_application`, `inspect_binary_layout`, `inspect_macho`, `inspect_artifact`, `inspect_managed_artifact`, `inspect_wasm_artifact`), save `parent_evidence_id`, and page slices via `inspect_analysis_view`.
3. **Target-Free vs. Active-Session Tools:** Run target-free path-based tools (`analyze_javascript_application`, `inspect_go_binary`, `inspect_rust_binary`, `inspect_elf_notes`, `inspect_pe_resources`, `inspect_sqlite_database`, `inspect_android_package`, `inspect_managed_artifact`, `inspect_wasm_artifact`, `inspect_evm_interface`, `inspect_model_artifact`, `inspect_il2cpp_metadata`) directly on disk paths before paying the cost of `open_binary`.
4. **Three-Bucket Epistemology:** Separate every finding into **Observations** (tool output + `evidence_id` + address/file location), **Inferences** (hypotheses with confidence and competing explanations), and **Unknowns** (tracked via `record_unknown`).
5. **Defensive & Clean-Room Scope:** Assist with authorized security testing, defensive vulnerability auditing, interoperability, clean-room behavioral specifications, crash triage, and CTF/educational analysis.

## Toolchain & Commands (`mise` + `pnpm`)

This repository uses **`mise`** (`mise.toml`) and **`pnpm`** (`pnpm@12.11.2`, Node `22.23.3`, Python `3.12.15`), with `rea-agents@6.7.0` installed locally via `pnpm` so the MCP server (`.mcp.json`) and CLI run via `pnpm exec rea` without network `npx` fetches.

```bash
# Install pinned dependencies
mise run setup        # or: pnpm install --frozen-lockfile

# Run REA environment & backend readiness check
mise run doctor       # or: pnpm run doctor

# Validate skills, workflows, and vendor manifest
mise run validate     # or: pnpm run validate

# Run test suite
mise run test         # or: pnpm test

# Sync woodchipper skills into ../skills/plugins/stuffbucket/skills
mise run sync:skills  # or: pnpm run sync:skills

# Refresh vendored upstream snapshots from morluto/rea and JoasASantos/REA-Prompts
mise run update:vendor # or: pnpm run update:vendor
```
