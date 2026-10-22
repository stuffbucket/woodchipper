---
name: woodchipper
description: Root router for the woodchipper-* reverse-engineering family (powered by REA / rea-agents and REAP playbooks). Routes targets across native binaries, Electron/JavaScript/web, Android/Flutter/.NET/IL2CPP/Apple bundles, firmware/WASM/EVM/PCAP/signals, runtime observation, clean-room reconstruction, and vulnerability/trust-boundary auditing. Enforces 5.5-series summary-first Evidence discipline (Observations vs Inferences vs Unknowns). Use when reverse engineering any binary, package, app, protocol, firmware, or web bundle without source code.
license: MIT
metadata:
  author: stuffbucket
  version: "1.0.0"
  upstream_rea: "6.7.0"
---

# Woodchipper — Reverse Engineering Router & Discipline

Woodchipper organizes `morluto/rea` (`rea-agents`) and `JoasASantos/REA-Prompts` (REAP) into a
modular skill pack, playbook library, and multi-agent workflow suite tuned for 5.5-series models.

Skip Woodchipper for ordinary analysis of a complete source repository where normal repo tools
(`Read`, `Grep`, `Glob`) directly answer the question. Use Woodchipper whenever a claim depends on
a shipped binary, compiled bundle, package/archive, decompilation, network/signal capture, or
passive/controlled runtime evidence.

## Human vs. Agent Division of Labor

Understanding what is human-driven vs. agent-driven prevents wasted tokens and confabulation:

1. **Human-driven intent (`REA-Prompts` / `playbooks/`):** Humans supply authorization scope, target
   path, specific feature/behavior to trace, and the desired terminal deliverable (`CLONE_SPEC.md`,
   struct reader, WASM port plan, vulnerability report).
2. **Agent-driven execution (`morluto/rea` MCP & CLI + `skills/`):** The agent routes the target to
   the exact REA tool, pages through large inventories using `detail: "summary"` and
   `inspect_analysis_view`, maintains the Evidence ledger, and verifies claims.
3. **Orchestrator-driven parallelism (`.claude/workflows/`):** When the user opts into a workflow,
   the harness fans out subsystem tracers and runs adversarial skeptics to kill unsupported inferences.

## Core 5.5-Series Operating Discipline (Non-Negotiable)

1. **Three-Bucket Epistemology:** Every report and intermediate ledger MUST separate:
   - **Observations:** Directly returned by a tool, cited with `evidence_id`, file digest, address range, or module node ID.
   - **Inferences:** Logical deductions from observations, labeled with confidence and competing explanations.
   - **Unknowns:** Unexamined code paths, indirect calls, dynamic IPC channels, or truncated pages. Record material unknowns with `record_unknown`.
2. **Summary-First Context Protection:** Never pull multi-megabyte ASTs, Mach-O symbol tables, or
   decompiled whole binaries into context at once. Pass `detail: "summary"` first, retain the
   `parent_evidence_id`, and page or project via `inspect_analysis_view`.
3. **Static Before Dynamic:** Do not execute targets, launch browsers/Electron, or attach Frida/LLDB
   unless static evidence cannot answer the question and runtime execution is within scope.
4. **Target-Free vs. Active-Session Tools:** Only call `open_binary` for native disassemblers or
   archive inventories that operate on the active session target. Target-free tools
   (`analyze_javascript_application`, `inspect_go_binary`, `inspect_rust_binary`,
   `inspect_elf_notes`, `inspect_pe_resources`, `inspect_sqlite_database`, `inspect_android_package`,
   `inspect_managed_artifact`, `inspect_wasm_artifact`, `inspect_evm_interface`,
   `inspect_model_artifact`, `inspect_il2cpp_metadata`) take an explicit path directly—do NOT call
   `open_binary` for them.

## Target Routing Table

Pick the sub-skill that matches your target artifact or investigation goal:

| Target / Goal | Sub-Skill | First MCP Tool / CLI Command |
| :--- | :--- | :--- |
| **Missing tools / Timeouts / Setup** | `woodchipper-setup` | `pnpm exec rea doctor --client claude_code --json` |
| **Native ELF / PE / Mach-O / DOS / Raw** | `woodchipper-native` | `open_binary` → `search_strings`, `search_procedures`, `analyze_function` |
| **Go / Rust / ELF Notes / PE Resources** | `woodchipper-native` | `inspect_go_binary`, `inspect_rust_binary`, `inspect_elf_notes`, `inspect_pe_resources` |
| **GPU (CUDA/HIP) / GGUF & Safetensors** | `woodchipper-native` | `inspect_gpu_code_objects`, `inspect_model_artifact` |
| **Electron / ASAR / JS Bundles / HAR / SAZ** | `woodchipper-js-web` | `analyze_javascript_application` (`detail: "summary"`), `inspect_web_network_capture` |
| **Android APK / JADX / Apktool / ADB / JEB** | `woodchipper-mobile-managed` | `inspect_android_package`, `decode_android_resources`, `list_adb_devices` |
| **Flutter / Unity IL2CPP / Godot PCK** | `woodchipper-mobile-managed` | `identify_flutter_build`, `inspect_il2cpp_metadata`, `open_binary` + `inspect_artifact` |
| **.NET Managed PE/CLI & NativeAOT** | `woodchipper-mobile-managed` | `inspect_managed_artifact`, `inspect_managed_members` |
| **Apple `.app` / IPA / DMG / Plist / NIB / CAR** | `woodchipper-mobile-managed` | `open_bundle_resources` → `inspect_plist`, `decode_interface_builder`, `inspect_asset_catalog` |
| **Firmware / Binwalk / Unblob / Entropy** | `woodchipper-firmware-signals` | `inspect_byte_entropy`, `inspect_firmware_regions`, `extract_firmware` |
| **WASM / EVM Bytecode / SQLite / PCAP / Logic Signals** | `woodchipper-firmware-signals` | `inspect_wasm_artifact`, `inspect_evm_interface`, `inspect_sqlite_database`, `inspect_pcap_capture`, `decode_signal_recording` |
| **Live Browser / Electron / Frida / GDB / LLDB / Process** | `woodchipper-runtime` | `list_browser_targets`, `list_electron_targets`, `capture_process_scenario`, `start_frida_session` |
| **Clean-Room Spec / Feature Clone / WASM Port** | `woodchipper-reconstruction` | `build_reconstruction_obligation_ledger`, `verify_reconstruction`, `compare_functions` |
| **Vulnerability / Kernel IOCTL / Crash / Version Diff** | `woodchipper-audit` | `inspect_recorded_crash`, `compare_application_versions`, `compare_artifacts`, `audit_residual_unknowns` |

## Playbooks & Deterministic Workflows

- **Task Playbooks (`playbooks/`):** Ready-to-run structured specifications derived from `REA-Prompts`:
  - `playbooks/triage-and-feature-trace.md` — Unfamiliar binary/app mapping and single-feature call-chain tracing.
  - `playbooks/clean-room-and-porting.md` — Behavioral `CLONE_SPEC.md`, feature extraction, and native-to-WASM game porting.
  - `playbooks/security-and-vr.md` — Trust-boundary audits, source-to-sink hunts, patch diffing, kernel IOCTLs, and crash root-cause analysis.
  - `playbooks/firmware-and-protocols.md` — Firmware extraction, MCU memory maps, wire protocols, file formats, and defensive protection analysis.
- **Multi-Agent Workflows (`.claude/workflows/`):** When the user asks to run a workflow:
  - `triage-target.js` — Parallel multi-facet reconnaissance + synthesis.
  - `trace-feature.js` — Pipeline over entry seeds → trace → adversarial skeptic verification.
  - `clean-room-spec.js` — Subsystem fan-out → obligation ledger → completeness critic → `CLONE_SPEC.md`.
  - `security-audit.js` — Trust-boundary finder pool → deduplication → 3-lens adversarial verification (`reachability`, `guards`, `impact`).
  - `version-diff.js` — Parallel artifact/function/export diffing → behavioral vs. build-noise classification.
