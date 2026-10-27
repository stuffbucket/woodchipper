# Playbook 3: Defensive Security, Vulnerability Research, Kernel & Crash Triage

Derived from `REA-Prompts` (Sections 8, 9, 10, 11, 15, and 16) and `morluto/rea`'s
`compare_application_versions`, `trace_crash`, and `audit_residual_unknowns` MCP guided prompts.

> **Authorization Gate:** Use strictly on software you own or are explicitly authorized to test
> (defensive audits, bug bounties, CTFs, patch verification). Never report an unverified static
> hypothesis as a confirmed vulnerability.

---

## 1. Trust-Boundary & Source-to-Sink Security Audit

**When to use:** Auditing a native binary, Electron app, or Android APK for memory corruption,
command injection, privilege escalation, or missing IPC/intent validation.

### Agent Execution Sequence

1. **Map Untrusted Entry Points (Sources):**
   - **Native:** Socket reads (`recv`, `WSARecv`), file parsers, IPC/RPC handlers, CLI/env inputs.
   - **Electron:** `ipcMain.handle`/`on` registrations, `contextBridge` surfaces, `protocol.register*`, `setWindowOpenHandler`, `will-navigate`. Check fuses with `inspect_electron_fuses`.
   - **Android:** `inspect_android_package` exported `Activity`/`Service`/`BroadcastReceiver`/`ContentProvider` components and deep-link intent filters.
2. **Trace Paths to Privileged Sinks:**
   - Follow call chains (`procedure_callees`, `xrefs`, `build_call_path`, `trace_application_feature`) to `memcpy`/`strcpy`/`sprintf`, `system`/`execve`/`CreateProcess`/`child_process`, `shell.openExternal`, `fs.*`, or SQLite queries.
3. **Candidate Finding Table:**
   - For each candidate: **Source** (address/node + `evidence_id`), **Sink** (address/node + `evidence_id`), **Observed Guards/Bounds Checks**, **Preconditions & Impact**, **Status (`Observation` vs `Hypothesis`)**, and **Minimal Controlled Validation Step**.

---

## 2. Kernel Driver & IOCTL Surface Enumeration (`.sys` / `.ko`)

**When to use:** Static security inspection of a Windows kernel driver (`.sys`) or Linux kernel
module (`.ko`). Never load the driver onto the host during static analysis.

### Agent Execution Sequence

1. **Locate Entry & Dispatch Tables:**
   - Open binary in Ghidra/Hopper/IDA (`open_binary`). Find `DriverEntry` / `init_module`, device object creation (`IoCreateDevice` / `IoCreateSymbolicLink`), and `MajorFunction` dispatch routines (especially `IRP_MJ_DEVICE_CONTROL`).
2. **Enumerate Every IOCTL Control Code:**
   - Decode each control code (`Method`: `METHOD_BUFFERED`, `METHOD_IN_DIRECT`, `METHOD_OUT_DIRECT`, `METHOD_NEITHER`; `Access` flags).
   - Inspect input/output buffer length checks (`InputBufferLength`, `OutputBufferLength`), user-pointer probing (`ProbeForRead`/`ProbeForWrite` or `copy_from_user`/`copy_to_user`), and double-fetch or integer-overflow risks.
3. **Rank Handlers by Risk:** Cite exact handler addresses and `evidence_id`s for every claim.

---

## 3. Patch Diffing (1-Day / Incomplete-Fix Hunting) & Version Comparison

**When to use:** Comparing `<OLD VERSION>` and `<NEW VERSION>` to identify security fixes, variant
bugs, or behavioral regressions.

### Agent Execution Sequence

1. **Artifact & Module Diff:**
   - Run `open_binary` + `inspect_artifact` on both versions → `compare_artifacts`.
   - For JS/Electron: `analyze_javascript_application` on both → `compare_application_versions` and `compare_javascript_export_shapes`.
2. **Function Matching & Dossier Diff:**
   - Inventory procedures across both binaries (`list_procedures`, `search_procedures`).
   - Call `analyze_function` on modified functions and run `compare_functions` and `find_changed_behavior`.
3. **Variant & Caller Audit:**
   - Identify what bounds/validation check was added in the patched function, then check all callers (`procedure_callers`) and sibling functions (`search_procedures`) for unpatched variants.

---

## 4. Crash Triage & Core Dump Root-Cause Analysis

**When to use:** Diagnosing a stack trace, crash log, or Linux ELF core dump.

### Agent Execution Sequence

1. **Core Dump Inspection (If ELF Core Supplied):**
   - Call `inspect_recorded_crash` (with optional `include_debugger_context: true` for GDB/pwndbg mapping candidates) to extract thread registers, faulting instruction pointer, signal, and notes.
2. **Static Localization & Hypothesis Testing:**
   - Resolve crash addresses/strings to procedures (`resolve_containing_procedure`, `analyze_function`).
   - Walk backward through callers (`procedure_callers`, `build_call_path`) to identify how null/out-of-bounds values reach the faulting instruction.
   - Propose or run the smallest bounded `capture_process_scenario` experiment to distinguish competing root-cause hypotheses (`correlate_static_and_runtime`).
