---
name: woodchipper-audit
description: Conduct defensive security reviews, trust-boundary audits, source-to-sink vulnerability hunting, kernel driver IOCTL analysis, 1-day patch diffing, version comparison, crash root-cause triage, and long-running residual-unknown management using REA. Use when auditing authorized binaries/apps for security flaws, comparing versions, analyzing core dumps/crashes, or resuming multi-session investigations.
license: MIT
metadata:
  author: stuffbucket
  version: "1.0.0"
---

# Woodchipper Security Auditing, Crash Triage, Version Diffing & Unknown Ledgers

**Scope & Authorization:** Use this skill for authorized defensive security research, bug bounties,
CTFs, interoperability, patch verification, and hardening software you own or are permitted to test.
Never classify a static hypothesis as a confirmed vulnerability without complete evidence.

## 1. Trust-Boundary & Source-to-Sink Vulnerability Hunting

1. **Enumerate Untrusted Input Sources:**
   - Native: network sockets (`recv`, `recvfrom`, `WSARecv`), file reads, IPC/RPC handlers, command-line/env parsers, custom URI handlers.
   - Electron: `ipcMain.handle`/`on`, `contextBridge` exports, deep-link handlers, `will-navigate` / `setWindowOpenHandler`.
   - Android: exported `Activity` / `Service` / `BroadcastReceiver` / `ContentProvider` intents and deep links.
   - Kernel drivers (`.sys` / `.ko`): `DriverEntry`, `MajorFunction[IRP_MJ_DEVICE_CONTROL]` dispatch tables, IOCTL control codes, `copy_from_user` / `ProbeForRead` / `Buffered` vs `METHOD_NEITHER` buffers.
2. **Trace to Dangerous Sinks:**
   - Follow callers/callees (`procedure_callees`, `xrefs`, `build_call_path`, `trace_application_feature`) to memory copy sinks (`memcpy`, `strcpy`, `sprintf`), command execution (`system`, `execve`, `CreateProcess`, `child_process.exec`, `shell.openExternal`), deserialization, or arbitrary file/memory writes.
3. **Structured Finding Requirements:**
   - For every candidate finding, report:
     1. **Input origin & sensitive sink** (with exact addresses / module node IDs and `evidence_id`s).
     2. **Intermediate bounds/validation checks** observed on the path.
     3. **Preconditions & impact.**
     4. **Epistemic status:** `Observation` vs `Hypothesis` + smallest controlled experiment to validate.

## 2. Version Comparison & Patch Diffing (1-Day / Incomplete-Fix Hunting)

1. **Artifact & Application Graph Diffing:**
   - Open and `inspect_artifact` on both versions (`left` and `right`), then run `compare_artifacts` (requires matching `coverage.scope` and `complete` status).
   - For JS/Electron apps, run `analyze_javascript_application` on each and call `compare_application_versions` or `compare_javascript_export_shapes`.
2. **Native Function Matching & Diffing:**
   - Collect `list_procedures` (and optional `list_names`, `procedure_info`, `read_bytes`) on both versions; export bundles before closing if switching targets.
   - Call `analyze_function` on candidate procedures across both versions and run `compare_functions` and `find_changed_behavior`.
   - Check whether a security fix added in `v2` is missing on sibling callers (`procedure_callers`) or parallel handlers (`search_procedures`).

## 3. Crash Triage & Core Dump Root-Cause Analysis

- **Recorded Linux ELF Core Dumps (`inspect_recorded_crash`):**
  - Target-free tool: reads thread registers, signals, and ELF notes from an x86-64 core file without attaching to a live process. Pass `include_debugger_context: true` when GDB/pwndbg core mapping candidates help.
- **Correlating Crash Traces with Static Code (`trace_crash` guided prompt):**
  - Resolve crash addresses or panic strings via `resolve_containing_procedure`, `search_strings`, and `analyze_function`.
  - Trace backward through callers (`procedure_callers`, `build_call_path`) and correlate with bounded process captures via `correlate_static_and_runtime`.

## 4. Long-Running Investigations & Residual Unknown Ledgers

- Track open questions across turns and sessions using REA's session registry:
  - `record_unknown`: Register an unanswered material question with supporting/contradicting `evidence_id`s and required authority.
  - `list_unknowns`: Inspect active unknown heads and their current `revision`.
  - `update_unknown`: Update status using `expected_revision` to prevent race conditions.
  - `verify_unknown_resolution`: Verify that cited Evidence actually resolves the unknown.
  - Export portable session state with `export_evidence_bundle` and maintain `INVESTIGATION.md` sorted by uncertainty-reduction priority.

## Deep References

- Playbook templates: `playbooks/security-and-vr.md`
- Evidence & comparison reference: `vendor/rea/skills/reverse-engineer-anything/references/evidence-workflows.md`
- Guides: `vendor/rea/docs/recorded-crashes.md`, `vendor/rea/docs/native-function-matching.md`
