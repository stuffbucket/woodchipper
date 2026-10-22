---
name: woodchipper-reconstruction
description: Perform clean-room behavioral specification (CLONE_SPEC.md), single-feature cloning, wire-protocol/file-format recovery, native-to-WASM game porting, and formal reconstruction verification using REA obligation ledgers and comparison tools. Use when rebuilding a feature or application from a binary/bundle, porting native code to WebAssembly, or verifying that a reimplementation matches original behavior.
license: MIT
metadata:
  author: stuffbucket
  version: "1.0.0"
---

# Woodchipper Clean-Room Reconstruction, Porting & Verification

Use this skill when the goal is not merely understanding an artifact, but producing a **clean-room
specification (`CLONE_SPEC.md`)**, **standalone feature reimplementation**, **file-format/protocol
parser**, **native-to-WASM port**, or **verified equivalence proof**.

## 1. Clean-Room Methodology

Extract **behavior, state machines, mathematical rules, and wire/file schemas**—never copy
proprietary assets, branding, or verbatim code without license permission:

1. **Recover the Rule & Constants:**
   - Locate the governing functions (`analyze_function`, `procedure_pseudo_code`, `procedure_assembly`) or JS modules (`inspect_analysis_view`).
   - Extract exact constants, lookup tables (`read_bytes` + `address_to_file_offset`), state transitions, error branches, and boundary limits.
   - Cite every requirement with `evidence_id` and address/offset range. Mark any unconfirmed branch as `UNKNOWN`.
2. **Produce Concrete Deliverables:**
   - **Full behavioral clone:** Generate `CLONE_SPEC.md` covering screens/views, state machines, inputs/outputs, persistence schemas, wire protocols, and error behaviors.
   - **Single feature / algorithm:** State the rule in plain prose, implement a standalone module in the user's target language, and build a test vector derived from the binary's constants.
   - **File format / wire protocol:** Document every field (offset, byte width, endianness, encoding, framing/checksum), cite the parser/serializer function addresses, and provide a working reader/decoder script.

## 2. Native Game & Application Portability to WebAssembly (WASM)

When analyzing a native executable (C/C++/DOS/SDL/OpenGL/DirectX) as a WASM port target:

1. **Map Subsystem Boundaries & Classify Portability:**
   - **Main loop & frame pacing:** Blocking `while(1)` loops vs. callback-driven frame ticks (`emscripten_set_main_loop`).
   - **Rendering backend:** OpenGL / DirectX / SDL / software framebuffer → classify as *portable as-is*, *needs shim* (e.g., GL→WebGL2, SDL→SDL2-compat), or *must be rewritten*.
   - **Filesystem & saves:** POSIX/Win32 file I/O → Emscripten `MEMFS`/`IDBFS` (IndexedDB).
   - **Threading & audio:** `pthread` / Win32 threads (`SharedArrayBuffer` / COOP+COEP headers), audio callbacks.
   - **Platform APIs & inline ASM:** Identify x86/ARM assembly blocks or OS-specific calls with exact function addresses.
2. **Headless Logic Core First:**
   - Isolate pure simulation logic (physics, RNG, scoring, AI, collision) from rendering and OS calls.
   - Compile the logic core first with a deterministic test harness that replays recorded inputs and compares state or byte outputs against the original binary.

## 3. REA Reconstruction Obligation Ledgers & Formal Verification

Never claim equivalence just because a few manual examples passed:

1. **Build the Obligation Ledger:**
   - Call `build_reconstruction_obligation_ledger` and `evaluate_reconstruction_coverage` (or CLI `build-reconstruction-obligation-ledger` / `evaluate-reconstruction-coverage`) to inventory every obligation that must be satisfied.
   - For .NET assemblies, use `import_managed_reconstruction`, `compare_managed_members`, and `verify_managed_native_boundaries`.
   - For JS bundles vs. reconstructed source, use `compare_source_to_bundle` and `compare_javascript_export_shapes`.
2. **Generate Comparison Evidence:**
   - Pair functions across original and reconstructed binaries with `match_native_functions`, then compare dossiers with `compare_functions`.
   - Compare runtime executions with `compare_process_captures`.
3. **Run `verify_reconstruction`:**
   - Pass a finite typed specification and the retained comparison `evidence_id`s to `verify_reconstruction`.
   - Report per-claim `pass`, `fail`, and `unknown` results explicitly. A `pass` covers only the declared comparable dimension, never global equivalence.

## Deep References

- Playbook templates: `playbooks/clean-room-and-porting.md`
- REA guides: `vendor/rea/docs/reconstruction-obligation-ledgers.md`, `vendor/rea/docs/reconstruction-coverage.md`, `vendor/rea/docs/reconstruction-readiness.md`, `vendor/rea/docs/native-function-matching.md`
