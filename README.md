# Woodchipper

**Woodchipper** combines:
- [`earendil-works/pi`](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent@1.3.0`, vendored as a Git submodule at `vendor/pi`)
- [`morluto/rea`](https://github.com/morluto/rea) (`rea-agents@6.7.0`, the Reverse Engineer Anything MCP server, CLI, contracts, and reference library)
- [`JoasASantos/REA-Prompts`](https://github.com/JoasASantos/REA-Prompts) (the REAP prompt collection)

into a **custom Pi reverse-engineering harness**, progressive-disclosure skill pack, playbook collection, and multi-agent workflow library optimized for **Claude 5.5-series models** (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`) and cross-instance **Claude Code peer (`peerProtocol: 1`) / A2A control**.

---

## Custom Pi Harness + Claude Code Cross-Instance (`peerProtocol: 1` / A2A) Architecture

Woodchipper customizes Pi via `.pi/extensions/`, `.pi/SYSTEM.md`, `.pi/settings.json`, and `bin/woodchipper.mjs` so the harness can be driven **either directly by a human in the terminal TUI or across instances by Claude Code (`ListAgents` / `SendMessage`)**:

1. **Reverse-Engineering Extension (`.pi/extensions/woodchipper-rea.ts`)**
   - Automatically registers the local `rea` MCP server (`pnpm exec rea mcp`).
   - **Summary-First Context Guardrail (`tool_call` hook):** Intercepts high-volume REA tools (`analyze_javascript_application`, `inspect_binary_layout`, `inspect_macho`, `inspect_artifact`, `inspect_managed_artifact`, `inspect_wasm_artifact`, `inspect_web_network_capture`) and defaults `detail: "summary"` whenever omitted so the model never blows out context on an initial call.
   - **Automatic Evidence Ledger (`tool_result` hook + `woodchipper_ledger` tool):** Extracts every `evidence_id` and `parent_evidence_id` (`ev_...`) returned by REA into `.woodchipper/evidence-ledger.json` and maintains the 3-bucket epistemology (**Observations**, **Inferences**, **Unknowns**).
   - **Custom Tools & Slash Commands:** Registers `woodchipper_triage`, `woodchipper_ledger`, and `woodchipper_playbook`, plus `/triage`, `/trace`, `/clone-spec`, `/audit`, `/ledger`, and `/doctor`.
2. **Claude Code Peer & A2A Bridge Extension (`.pi/extensions/woodchipper-peer.ts`)**
   - Implements Claude Code's native local cross-session discovery and messaging protocol (`peerProtocol: 1`):
     - Writes `~/.claude/sessions/<pid>.json` (`name: "woodchipper"`) and `~/.claude/sessions/<pid>.<sha256(socketPath)>.key`.
     - Listens on Unix Domain Socket `/tmp/cc-socks/<pid>.sock` (symlinked at `.woodchipper/peer.sock`).
   - **Drive from Claude Code:** Any Claude Code session on the machine sees `woodchipper` in `ListAgents` and can message it directly with `SendMessage({ to: "woodchipper", message: "Triage /path/to/target" })`. Woodchipper injects the prompt into the live Pi session (visible in real time if a human is watching the TUI, or executed headlessly in `daemon` mode) and sends the structured response back to the calling Claude Code session's UDS socket when `agent_settled` fires.
   - **Drive from CLI (`scripts/woodchipper-ctl.mjs`):** Query peers, status, ledger, or send synchronous `--wait` A2A prompts from any shell.

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
├── bin/
│   └── woodchipper.mjs                # Unified Pi harness launcher (tui, daemon, rpc, ask, build-pi)
├── .pi/
│   ├── settings.json                  # Project-local Pi configuration (tools, skills, extensions)
│   ├── SYSTEM.md                      # Woodchipper 5.5-series system prompt addendum
│   └── extensions/
│       ├── woodchipper-rea.ts         # REA MCP wiring, summary-first guardrails, tools & commands
│       ├── woodchipper-peer.ts        # Claude Code peerProtocol:1 UDS server & claude_peers tool
│       └── lib/                       # Evidence ledger, static triage, peer protocol, schema helpers
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
├── vendor/                            # Pinned upstream files & submodules (vendor/MANIFEST.json)
│   ├── MANIFEST.json
│   ├── pi/                            # earendil-works/pi git submodule (@earendil-works/pi-coding-agent)
│   ├── rea/                           # morluto/rea@6.7.0 skills, docs, contracts, bridges
│   └── rea-prompts/                   # JoasASantos/REA-Prompts catalog
├── scripts/
│   ├── build-harness.mjs              # Verifies & prepares the Woodchipper Pi harness (+ optional submodule build)
│   ├── woodchipper-ctl.mjs            # CLI controller for Claude Code & Woodchipper UDS peers
│   ├── validate.mjs                   # Validates skills, workflows, Pi harness, and vendor manifest
│   ├── sync-to-stuffbucket-skills.mjs # Copies skills/woodchipper* into ../skills
│   └── update-vendor.mjs              # Updates vendor/ from upstream git repos
└── tests/
    ├── validate-woodchipper.test.mjs  # Skill, workflow, and vendor manifest tests
    ├── pi-extension.test.mjs          # Woodchipper REA Pi extension & Evidence Ledger tests
    └── peer-extension.test.mjs        # Claude Code peerProtocol:1 & A2A UDS socket tests
```

## Quick Start (`mise` + `pnpm`)

```bash
# 1. Trust mise.toml, install pinned dependencies, and verify the Pi harness
mise trust
mise run setup

# 2. Launch interactive Woodchipper Pi TUI (human-driven + live Claude Code peer socket)
mise run tui

# 3. Or run headless Woodchipper Pi peer daemon for Claude Code SendMessage / A2A control
mise run daemon

# 4. List live local Claude Code & Woodchipper peers or send an A2A prompt
mise run ctl -- peers
mise run ctl -- send woodchipper "Triage /abs/path/to/binary" --wait

# 5. Validate Woodchipper skills, workflows, Pi extensions, and vendored upstreams
mise run validate
mise run test
```
