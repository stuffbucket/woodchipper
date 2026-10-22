# Playbook 1: Target Triage & Single-Feature Tracing

Derived from `REA-Prompts` (Sections 1, 2, 3, 11, and Wildcard) and `morluto/rea`'s
`investigate_feature` MCP guided prompt, upgraded for 5.5-series execution.

---

## 1. Unfamiliar Application / Binary Triage Map

**When to use:** First look at an unfamiliar executable, installation directory, `.app` bundle, or
`app.asar`.

### Agent Execution Sequence

1. **Identify Container & Fast Metadata (No Disassembler Wait):**
   - Directory: `inspect_desktop_application` (`detail: "summary"`)
   - Electron / JS: `analyze_javascript_application` (`detail: "summary"`)
   - Go / Rust / ELF / PE / Mach-O: `inspect_go_binary`, `inspect_rust_binary`, `inspect_elf_notes`, `inspect_binary_layout`, `inspect_pe_resources`, `inspect_macho` (`detail: "summary"`), `inspect_byte_entropy`
   - Apple `.app` / Archive: `open_bundle_resources` + `inspect_plist`, or `open_binary` + `inspect_artifact` (`detail: "summary"`)
2. **Group Capabilities by Evidence:**
   - Group imports, strings, and modules by capability: **Network**, **Filesystem/DB**, **IPC/RPC**, **Crypto/Auth**, **UI/Entrypoints**.
   - Flag high-entropy sections, packing indicators, or disabled Electron fuses (`inspect_electron_fuses`).
3. **Deliverable Format (`TRIAGE_MAP.md` or inline summary):**
   - **Target Identity:** Path, SHA-256 digest, format, architecture, runtime/compiler, active REA provider and limitations.
   - **Architecture & Subsystem Map:** Main components and entry points with `evidence_id` and address/node citations.
   - **Top 3 High-Value Investigation Seeds:** Specific procedures, IPC channels, or modules to trace next.
   - **Residual Unknowns:** What remains unexamined or packed/dynamic.

---

## 2. Single-Feature End-to-End Trace (Any Program)

**When to use:** Tracing one user-visible action (e.g., clicking a button, running a CLI flag, or
triggering an export) from entry point to final side effect.

### Agent Execution Sequence

1. **Locate the Seed (Static First):**
   - Native: `search_strings` for UI labels, log keys, or command flags → `xrefs` → `resolve_containing_procedure`.
   - Electron / JS: `analyze_javascript_application` (`detail: "summary"`) → `inspect_analysis_view` module pages → `trace_application_feature` (`direction: "outgoing"`).
   - Android: `inspect_android_package` → `search_android_classes` → `trace_android_references`.
2. **Walk the Call & Data Chain:**
   - Call `analyze_function` on each hop along the path (or `inspect_analysis_view` item view for JS modules).
   - Across process boundaries (e.g., Electron Renderer → `contextBridge` → `ipcRenderer.invoke` → `ipcMain.handle` → Native `.node` addon), cite both sides of the boundary and confirm whether the channel is an exact literal match.
3. **Deliverable Format:**
   - **Step-by-Step Hop Table:** `Hop # | Layer | Function / Module | Address / Node ID | Evidence ID | Transformation / Side Effect`
   - **Observations vs. Inferences vs. Unknowns:** Explicitly separated.

---

## 3. Recover a Business Rule or Formula & Rebuild It

**When to use:** Understanding why a calculation, scoring rule, rate limit, or state transition
behaves a certain way, and proving recovery with a runnable micro-implementation.

### Agent Execution Sequence

1. **Isolate the Calculation:**
   - Decompile the target function (`analyze_function` / `procedure_pseudo_code`) and cross-check critical branches or fixed-point math against `procedure_assembly`.
   - Read any referenced lookup tables via `read_bytes` and verify file-backed bytes via `address_to_file_offset`.
2. **State & Verify:**
   - Write the exact mathematical or logical rule in plain prose, citing every constant's address.
   - Build a minimal standalone script/module implementing the recovered rule.
   - Construct at least one deterministic test input from the binary's constants that proves behavioral equivalence.
