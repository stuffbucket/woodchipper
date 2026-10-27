---
name: woodchipper-native
description: Reverse engineer native executables, libraries, drivers, and specialized compiled artifacts (ELF, PE, Mach-O, Go, Rust, CUDA/HIP GPU objects, GGUF/safetensors models, DOS MZ/COM, raw firmware binaries) using REA. Covers target-free metadata extractors and active-session deep providers (Ghidra, Hopper, IDA, Kuna, Rizin, objdump). Use when inspecting binaries, decompiling functions, mapping imports/strings, or recovering structs and wire formats.
license: MIT
metadata:
  author: stuffbucket
  version: "1.0.0"
---

# Woodchipper Native Binary & Specialized Artifact Analysis

Use this skill for native binaries (ELF, PE, Mach-O, DOS MZ/COM, raw images), kernel drivers
(`.sys`, `.ko`), and compiled artifacts with embedded metadata (Go, Rust, GPU fatbins, GGUF/safetensors).

## Phase 1: Target-Free Fast Triage (Run Before Opening a Deep Disassembler)

Do NOT call `open_binary` or wait for a cold Ghidra/Hopper import if a built-in target-free tool
answers the question in milliseconds:

| Artifact / Question | Tool (MCP) | CLI Equivalent | Key Semantics |
| :--- | :--- | :--- | :--- |
| **Desktop / app bundle container** | `open_binary` + `inspect_artifact` (`detail: "summary"`) | `inspect-artifact --detail summary` | Inventories packaged files, embedded archives, and runtime markers; for Electron/JS trees use `analyze_javascript_application`. |
| **Go compiler, modules, build flags** | `inspect_go_binary` | `inspect-go-binary <path>` | Target-free static ELF/PE/Mach-O parser; no Go or disassembler needed. |
| **Rust cargo-auditable crates (`.dep-v0`)** | `inspect_rust_binary` | `inspect-rust-binary <path>` | Target-free extractor for crate graph and versions (`include_dependencies: true`). |
| **ELF sections, symbols, relocs, mitigations** | `inspect_binary_layout` (`detail: "summary"`) | `inspect-binary-layout <path>` | Target-free offline layout & mitigation inspector (`detail: "summary"` → `inspect_analysis_view`). |
| **Disassembly / section headers (`objdump`)** | `inspect_with_objdump` | `inspect-with-objdump <path>` | Target-free `objdump` wrapper for quick section, symbol, and instruction inspection. |
| **PE32/PE32+ resource tree & icons** | `inspect_pe_resources` | `inspect-pe-resources <path>` | Target-free extractor for resource IDs, UTF-16 names, code pages, and SHA-256. |
| **Mach-O slices, load commands, exports** | `open_binary` + `inspect_macho` (`detail: "summary"`) | `inspect-macho` | Active-session Mach-O inspector; use `detail: "summary"` on frameworks, then page via `inspect_analysis_view` (`kind: "macho"`). |
| **Embedded regions / packed partitions** | `inspect_firmware_regions` | `inspect-firmware-regions <path>` | Target-free scanner for compressed/encrypted regions and embedded container headers. |

## Phase 2: Active-Session Deep Native Analysis (`open_binary`)

When you need pseudocode, assembly, CFG, cross-references, or call graphs:

1. **Open the Target:** Call `open_binary` with the local path (and optional `provider_id`: `"ghidra"`, `"hopper"`, `"ida"`, `"kuna"`).
   - **IDA rule:** Always pass the original binary path to `open_binary` with `provider_id: "ida"`, never `.idb`/`.i64`. Skip `binary_overview` on IDA (not supported) and go straight to `search_strings`, `search_procedures`, or `analyze_function`.
   - **Kuna rule:** `provider_id: "kuna"` caches a whole-program C/ASM export. Check `raw_result.source` for the cached `.c`/`.asm` file path and byte span—you can search that file directly!
   - **DOS MZ / COM / Raw Images:**
     - DOS MZ: Run `inspect_native_load_image` first; `procedure_pseudo_code` accepts `procedure: "file-offset:0x..."`.
     - DOS COM: Open with `format: "dos-com"` (entry `0x10100` at file offset 0).
     - Headerless raw firmware: Open with `format: "raw-binary"`, `architecture` (`x86`, `x86_64`, `arm`, `arm64`, `6502`, `m68k`), and `entry_point` (`0x...`).
2. **Summary-First Discovery:**
   - Use `search_strings` and `search_procedures` with specific patterns first.
   - If listing all procedures/strings/names (`list_procedures`, `list_strings`, `list_names`), pass `detail: "summary"` and page via `inspect_analysis_view` (`view: {kind: "native-inventory", offset: 0, limit: 32}`).
3. **Function Dossiers & Paging:**
   - Call `analyze_function` on candidate procedures. Read `normalized_result` and check `facet_availability` (`pseudocode`, `assembly`, `callers`, `callees`, `references`, `cfg`).
   - If a dossier is huge, page individual facets via `inspect_analysis_view` (`view: {kind: "native", facet: "pseudocode" | "value_flow_operations", offset: 0, limit: 32}`).
4. **Static Memory vs. File Bytes:**
   - `read_bytes` reads initialized analysis memory (including loader fixups), NOT a live process. Always check `returned_bytes` and `complete`.
   - Use `address_to_file_offset` to anchor an address to original file bytes. Never assume `virtual_address - image_base == file_offset` across segments, and never assume a zero-initialized pointer table slot is empty at runtime without checking constructor `xrefs`.
5. **Session Annotations & Cleanup:**
   - Use `annotate_native_function` or `set_addresses_names` in Ghidra to record recovered function/global names during the session.
   - Always call `close_binary` when finished (exporting any needed bundle via `export_evidence_bundle` first).

## Deep References

- Full native/artifact edge cases: `vendor/rea/skills/reverse-engineer-anything/references/native-and-artifacts.md`
- Provider guides: `vendor/rea/docs/native-investigation.md`, `vendor/rea/docs/ghidra-provider.md`, `vendor/rea/docs/ida-provider.md`, `vendor/rea/docs/kuna-provider.md`
