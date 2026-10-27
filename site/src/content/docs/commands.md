---
title: Commands
description: Woodchipper setup, operation, validation, and TUI commands.
---

## Setup and checks

| Command | Purpose |
| --- | --- |
| `./woodchipper` (or `mise run start`) | Single-command launcher: auto-trusts `mise.toml`, runs first-time setup if needed, prompts for workspace up front, and opens the TUI |
| `mise run setup` | Initialize submodules, build dependency overrides, install packages, and build the local Pi runtime |
| `mise run smoke` (or `./woodchipper smoke`) | Run end-to-end smoke verification against `tests/fixtures/sample-electron-app` |
| `mise run doctor` | Check REA `6.7.0`, Ghidra `12.1.4`, Java `21`, and skill readiness |
| `mise run validate` | Validate skills, workflows, harness files, REA `6.7.0` contracts, configuration boundaries, and source pins |
| `mise run test` | Run the 27-test Node validation suite |
| `mise run test:mutate` | Run the 25-mutant security and logic mutation suite |

## Run Woodchipper

| Command | Purpose |
| --- | --- |
| `./woodchipper [-w <workspace>]` | Open the interactive TUI with up-front workspace selection |
| `mise run tui` | Open the interactive TUI and local peer socket |
| `mise run daemon` | Start the headless local peer daemon |
| `mise run ctl -- peers` | List local peers |
| `mise run ctl -- status woodchipper` | Check the daemon |
| `mise run ctl -- ledger woodchipper` | Export the active workspace's evidence ledger |
| `mise run ctl -- send woodchipper "..." --wait` | Submit a task and wait for the result |
| `mise run rea -- <command>` | Call the pinned REA CLI directly |

## TUI commands

| Command | Purpose |
| --- | --- |
| `/start [path-or-question]` | Show the appliance orientation guide or start a guided plain-English intake on `<path>` |
| `/status [json]` | Display the two-column status card (session/runtime location, active `maximal` model, context usage bar, failover chain, and active target) |
| `/workspace [name-or-path\|list]` | Show, list, or switch the active git-ignored workspace (`workspaces/<slug>/`) |
| `/triage <path>` | Identify and map an unfamiliar target (`workspaces/<slug>/TRIAGE_MAP.md`) |
| `/trace <path> <feature>` | Trace one feature from entry point to side effect |
| `/clone-spec <path>` | Build a clean-room behavioral specification (`CLONE_SPEC.md`) |
| `/audit <path>` | Run a defensive trust-boundary audit |
| `/ledger [clear\|json]` | Show, export, or clear the current workspace's Three-Bucket Evidence Ledger (`workspaces/<slug>/REPORT.md`) |
| `/maximal [status\|models\|refresh\|use <id>]` | Inspect, refresh, or switch models on the local `maximal` (`localhost:4141`) provider |
| `/gliner [status\|ensure-model\|classify <text>]` | Check, auto-pull (`decide-340m`), or run the GLiNER zero-shot intent/capability classifier |
| `/doctor` | Show REA `6.7.0` and external backend readiness |
| `/clear [all\|<workspace>]` | Start a fresh conversation session (`/clear`), wipe both session and ledger (`/clear all` or `/reset`), or start fresh in a new workspace |
| `/exit` (or `/quit`) | Gracefully exit the Woodchipper TUI |

## One-shot and RPC modes

The launcher also supports:

```sh
pnpm run woodchipper -- ask "Triage /path/to/target"
pnpm run woodchipper -- rpc
```

Use the TUI or daemon unless a caller specifically needs print or JSONL RPC mode.
