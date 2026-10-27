# AGENTS.md

Agent routing and architecture index for `woodchipper`.

## Architecture Overview

| Layer | Location | Role |
|---|---|---|
| **Pi Agent Harness** | `bin/woodchipper.mjs`, `.pi/` | Custom Pi harness loading `woodchipper-maximal.ts` (preferred `maximal` provider on `localhost:4141`), `woodchipper-rea.ts` (REA MCP + GLiNER `decide-340m` classifier + 3-bucket ledger + summary guardrails), and `woodchipper-peer.ts` (Claude Code `peerProtocol: 1` UDS A2A bridge) |
| **Root Skill Router** | `skills/woodchipper/SKILL.md` | Classifies target artifact + user goal, enforces 5.5-series discipline, and routes to domain sub-skills |
| **Domain Sub-Skills** | `skills/woodchipper-*/SKILL.md` | 8 focused `<500`-line skills mapping exact REA MCP tools & CLI commands to target families |
| **Harness Workflows** | `.claude/workflows/*.js` | 5 deterministic multi-agent orchestration scripts (`triage-target`, `trace-feature`, `clean-room-spec`, `security-audit`, `version-diff`) |
| **Playbooks** | `playbooks/*.md` | End-to-end human + agent playbooks combining REAP prompt intent with exact REA tool execution |
| **Vendored Upstreams** | `vendor/pi/`, `vendor/gliner-runner/`, `vendor/rea/`, `vendor/rea-prompts/` | `earendil-works/pi` and `stuffbucket/gliner-runner` (`decide-340m`) git submodules + pinned REA docs, tool/prompt contracts (`toolContracts.ts`), bridges, and REAP catalog |

## Skill Routing Table

- `woodchipper` — Entry router and 5.5-series operating rules
- `woodchipper-setup` — `rea doctor`, MCP vs. CLI fallback, Ghidra/Hopper/IDA/JADX/WABT/tshark/sigrok setup, timeout recovery
- `woodchipper-native` — PE/ELF/Mach-O/DOS/raw binaries, Go/Rust metadata, GPU code objects, AI/ML models, active disassembler sessions
- `woodchipper-js-web` — Electron/ASAR/minified JS bundles, `analyze_javascript_application` summary paging, HAR/SAZ/mitmproxy/qlog projection
- `woodchipper-mobile-managed` — Android APK/JADX/Apktool/ADB, Flutter/Dart AOT, Unity IL2CPP, Godot, .NET PE/NativeAOT, Apple `.app`/IPA/DMG
- `woodchipper-firmware-signals` — Firmware entropy & extraction, WASM, EVM bytecode, SQLite forensics, PCAP/tshark, sigrok logic signals
- `woodchipper-runtime` — Browser/Electron CDP capture, POSIX PTY capture, LLDB native calls & macOS UI inspection, Frida, GDB, Rizin
- `woodchipper-reconstruction` — Clean-room behavioral specifications (`CLONE_SPEC.md`), native-to-WASM porting, `verify_reconstruction` obligation ledgers
- `woodchipper-audit` — Defensive source-to-sink trust boundary audits, IOCTL driver review, 1-day patch diffing, crash triage, unknown ledgers
