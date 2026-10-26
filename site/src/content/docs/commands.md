---
title: Commands
description: Woodchipper setup, operation, validation, and TUI commands.
---

## Setup and checks

| Command | Purpose |
| --- | --- |
| `mise run setup` | Initialize submodules, build dependency overrides, install packages, and build the local Pi runtime |
| `mise run doctor` | Check REA, Ghidra, Java, and skill readiness |
| `mise run validate` | Validate skills, workflows, harness files, configuration boundaries, and source pins |
| `mise run test` | Run the Node test suite |
| `mise run test:mutate` | Run the security and logic mutation suite |

## Run Woodchipper

| Command | Purpose |
| --- | --- |
| `mise run tui` | Open the interactive TUI and local peer socket |
| `mise run daemon` | Start the headless local peer daemon |
| `mise run ctl -- peers` | List local peers |
| `mise run ctl -- status woodchipper` | Check the daemon |
| `mise run ctl -- ledger woodchipper` | Export the evidence ledger |
| `mise run ctl -- send woodchipper "..." --wait` | Submit a task and wait for the result |
| `mise run rea -- <command>` | Call the pinned REA CLI directly |

## TUI commands

| Command | Purpose |
| --- | --- |
| `/triage <path>` | Identify and map an unfamiliar target |
| `/trace <path> <feature>` | Trace one feature from entry point to side effect |
| `/clone-spec <path>` | Build a clean-room behavioral specification |
| `/audit <path>` | Run a defensive trust-boundary audit |
| `/ledger` | Show the current observations, inferences, and unknowns |
| `/ledger json` | Export the ledger as JSON |
| `/ledger clear` | Clear the current ledger |
| `/doctor` | Show REA and provider readiness |

## One-shot and RPC modes

The launcher also supports:

```sh
pnpm run woodchipper -- ask "Triage /path/to/target"
pnpm run woodchipper -- rpc
```

Use the TUI or daemon unless a caller specifically needs print or JSONL RPC mode.
