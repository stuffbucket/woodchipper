# Woodchipper

**Woodchipper** combines [`morluto/rea`](https://github.com/morluto/rea) (`rea-agents@6.7.0`, the Reverse Engineer Anything MCP server, CLI, contracts, and reference library) and [`JoasASantos/REA-Prompts`](https://github.com/JoasASantos/REA-Prompts) (the REAP prompt collection) into a progressive-disclosure skill pack, playbook collection, and multi-agent workflow library optimized for **Claude 5.5-series models** (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`) and the Claude Code harness.

---

## Human vs. Agent Division of Labor: How the Two Upstream Repos Fit Together

A common point of confusion when looking at `JoasASantos/REA-Prompts` and `morluto/rea` side by side is **what is meant for a human to type vs. what is meant for the agent to execute**:

| Upstream Repository | Human-Driven % | Agent-Driven % | What It Actually Is |
|---|---:|---:|---|
| **`JoasASantos/REA-Prompts` (REAP)** | **100% Human** | **0% Agent** | A catalog of **human-to-agent prompt templates** across 16 sections with `<TARGET>` / `<FEATURE>` placeholders and 6 prompt-writing rules. It tells a human *how to phrase a request*, *how to bound scope*, and *what output structure to demand* (`Observations` vs. `Inferences` vs. `Unknowns`), but it **does not know REA's actual MCP tool names, schemas, or paging mechanics**. |
| **`morluto/rea` (`rea-agents`)** | **~5% Human** | **~95% Agent** | **Human 5%:** One-time `npx rea-agents@latest setup`, installing external analysis backends (Ghidra, Hopper, IDA, JADX, Apktool, WABT, tshark, sigrok), and launching target processes/browsers when interactive login is required.<br>**Agent 95%:** Over 100 MCP tools and CLI commands (`rea <cmd> --json`), 6 MCP guided prompts (`investigate_feature`, `compare_application_versions`, `verify_reconstruction`, `trace_crash`, `audit_residual_unknowns`, `prepare_bounded_process_capture`), evidence ledgers, and 80+ reference docs. |
| **`woodchipper` (This Repo)** | **Bridges Both** | **5.5-Optimized** | Translates REAP's high-level human investigative intents directly into REA's exact tool pipelines, wrapped in **progressive-disclosure skills (`skills/woodchipper*`)** and **deterministic multi-agent workflows (`.claude/workflows/*.js`)** so neither the human nor the 5.5-series model has to guess tool sequences or blow out the context window. |

---

## Why This Structure Is Optimal for 5.5-Series Models

1. **Progressive Disclosure Instead of Context Monoliths (`skills/woodchipper*`)**
   - Upstream `morluto/rea` ships 80+ documentation files and a 100+ tool contract file (`toolContracts.ts`). Loading all of that upfront wastes cache tokens and dilutes tool selection accuracy.
   - Woodchipper splits the domain into **1 root router skill (`woodchipper`)** + **8 specialized sub-skills (`<200` lines each)** that load on demand based on the target artifact.
2. **Summary-First Context Protection (`detail: "summary"` → `inspect_analysis_view`)**
   - 5.5-series models reason best when their context holds structured indices rather than megabytes of raw decompiled C or minified JS. Every skill enforces REA's two-step paging contract: call `detail: "summary"` first, retain `parent_evidence_id`, and page only relevant modules/functions via `inspect_analysis_view`.
3. **Target-Free Static Sweep Before Heavy Disassembler Sessions**
   - Opening a large native binary in Ghidra/IDA (`open_binary`) can take minutes. Woodchipper separates **target-free path tools** (`inspect_go_binary`, `inspect_rust_binary`, `inspect_elf_notes`, `inspect_pe_resources`, `inspect_binary_layout`, `inspect_macho`, `analyze_javascript_application`, `inspect_android_package`, `inspect_managed_artifact`, `inspect_wasm_artifact`) from **active-session tools**, running the fast path-based tools in parallel first.
4. **Deterministic Multi-Agent Workflows (`.claude/workflows/*.js`)**
   - When the user opts into multi-agent orchestration (`"use a workflow"`), Woodchipper provides 5 ready-to-run workflow scripts using `pipeline()`, `parallel()`, `agent()`, and adversarial verification stages:
     - `.claude/workflows/triage-target.js` — 3-facet parallel static triage (`container-and-metadata`, `structure-and-layout`, `capabilities-and-strings`) + synthesis.
     - `.claude/workflows/trace-feature.js` — Seed discovery → pipelined call-chain tracing → skeptic verification.
     - `.claude/workflows/clean-room-spec.js` — 4-domain parallel behavioral extraction → Completeness Critic → copyright-clean `CLONE_SPEC.md`.
     - `.claude/workflows/security-audit.js` — 3 parallel trust-boundary hunters → deduplication barrier → 3-lens adversarial skeptic verification (`reachability`, `guards`, `impact`).
     - `.claude/workflows/version-diff.js` — Parallel artifact/metadata and function diff tracks → behavioral delta vs. compiler noise synthesis.

---

## Repository Layout

```text
woodchipper/
├── .claude-plugin/
│   ├── marketplace.json               # Stuffbucket local plugin marketplace manifest
│   └── plugin.json                    # Claude Code plugin definition
├── .claude/
│   └── workflows/                     # Deterministic multi-agent workflows
│       ├── triage-target.js
│       ├── trace-feature.js
│       ├── clean-room-spec.js
│       ├── security-audit.js
│       └── version-diff.js
├── .mcp.json                          # REA MCP server config (pnpm exec rea mcp)
├── mise.toml                          # Pinned toolchain (Node, pnpm, Python) & mise tasks
├── skills/                            # Progressive-disclosure skill pack (<500 lines each)
│   ├── woodchipper/                   # Root router skill & 5.5 operating discipline
│   ├── woodchipper-setup/             # Doctor, timeouts, CLI fallback, provider setup
│   ├── woodchipper-native/            # PE/ELF/Mach-O, Go, Rust, GPU, ML models, Ghidra/IDA/Hopper
│   ├── woodchipper-js-web/            # Electron/ASAR, JS summary paging, HAR/SAZ/mitmproxy/qlog
│   ├── woodchipper-mobile-managed/    # Android APK/JADX, Flutter, Unity IL2CPP, Godot, .NET, Apple
│   ├── woodchipper-firmware-signals/  # Firmware entropy/extraction, WASM, EVM, SQLite, PCAP, sigrok
│   ├── woodchipper-runtime/           # Browser CDP, POSIX PTY, LLDB, Frida, GDB, Rizin
│   ├── woodchipper-reconstruction/    # Clean-room CLONE_SPEC.md, WASM porting, verify_reconstruction
│   └── woodchipper-audit/             # Defensive vuln audit, IOCTLs, patch diffing, crashes, unknowns
├── playbooks/                         # Human + agent operational playbooks (REAP + REA unified)
│   ├── triage-and-feature-trace.md
│   ├── clean-room-and-porting.md
│   ├── security-and-vr.md
│   └── firmware-and-protocols.md
├── vendor/                            # Pinned upstream files (tracked via vendor/MANIFEST.json)
│   ├── MANIFEST.json
│   ├── rea/                           # morluto/rea@6.7.0 skills, docs, contracts, bridges
│   └── rea-prompts/                   # JoasASantos/REA-Prompts catalog
├── scripts/
│   ├── validate.mjs                   # Validates skills, workflows, and vendor manifest
│   ├── sync-to-stuffbucket-skills.mjs # Copies skills/woodchipper* into ../skills
│   └── update-vendor.mjs              # Updates vendor/ from upstream git repos
└── tests/
    └── validate-woodchipper.test.mjs  # Node test suite
```

## Quick Start (`mise` + `pnpm`)

```bash
# 1. Trust mise.toml and install pinned dependencies (including local rea-agents@6.7.0)
mise trust
mise run setup

# 2. Verify REA readiness on your machine
mise run doctor

# 3. Validate Woodchipper skills, workflows, and vendored upstreams
mise run validate
mise run test

# 4. Optional: Sync the 9 woodchipper skills into ~/github/stuffbucket/skills
mise run sync:skills
```
