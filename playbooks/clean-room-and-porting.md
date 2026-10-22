# Playbook 2: Clean-Room Reconstruction, Cloning & WASM Porting

Derived from `REA-Prompts` (Sections 4, 5, 6, and 11) and `morluto/rea`'s `verify_reconstruction`
MCP guided prompt.

> **Clean-Room Rule:** Extract **behavior, state machines, mathematical formulas, and wire/file
> schemas**—never copy proprietary source code, visual/audio assets, branding, or license keys.

---

## 1. Full Behavioral Specification (`CLONE_SPEC.md`)

**When to use:** Studying an application as a black/gray box to produce a complete specification
from which an independent clean-room implementation can be built.

### Agent Execution Sequence

1. **Inventory Subsystems:**
   - Run `build_reconstruction_obligation_ledger` (where supported) or inventory modules/procedures via `woodchipper-native` / `woodchipper-js-web`.
2. **Document Every Behavioral Contract:**
   - **Screens, Views & Interaction Model:** Layout logic, keyboard shortcuts, command dispatch, undo/redo stack semantics, clipboard formats.
   - **State Machines & Business Logic:** Inputs, outputs, state transitions, boundary conditions, and error states.
   - **Persistence & Configuration:** SQLite schemas (`inspect_sqlite_database`), plists/settings files, local storage keys.
   - **Network & IPC Protocols:** Endpoint templates (`view: {kind: "api-surface"}`), protobuf/JSON payloads, IPC channel contracts.
3. **Deliverable Format (`CLONE_SPEC.md`):**
   - Every requirement MUST carry `[Evidence: <evidence_id> @ <address/node_id>]`.
   - Any unverified behavior MUST be marked `[UNKNOWN: <reason & next probe>]`.

---

## 2. Single-Feature Clean-Room Clone & Verification

**When to use:** Extracting one standout feature from a reference application and implementing it
inside the user's own project with verified equivalence.

### Agent Execution Sequence

1. **Recover Trigger, Inputs, Steps, Outputs & Failure Modes:**
   - Trace the feature end-to-end and record all edge cases and error branches.
2. **Implement Clean-Room Version & Test Suite:**
   - Write the implementation in the target project's language and idiom.
   - Derive unit/property tests directly from the recovered branches and constants.
3. **Verify Against Original (`verify_reconstruction`):**
   - Use `compare_functions`, `compare_javascript_export_shapes`, or `compare_process_captures` to generate comparison Evidence.
   - Call `verify_reconstruction` with a finite typed specification and report passing claims, divergences, and untested unknowns.

---

## 3. Native Game / Engine Recovery & WASM Porting Plan

**When to use:** Recovering gameplay mechanics (physics, movement, scoring, spawn tables, RNG) or
porting a native C/C++/DOS/SDL/OpenGL executable to WebAssembly.

### Agent Execution Sequence

1. **Engine & Asset Pipeline Map:**
   - Identify engine/framework (Unity IL2CPP via `inspect_il2cpp_metadata`, Godot PCK via `inspect_artifact`, DOS MZ/COM via `inspect_native_load_image`, or custom native).
   - Map the main loop, frame tick order, asset archive format, and gameplay data tables (`read_bytes`).
2. **Portability Classification (Every Subsystem Cited by Function Address):**
   - **Portable as-is:** Pure math, state updates, AI, collision, level parsers.
   - **Needs shim:** OpenGL → WebGL2, SDL1/2 → Emscripten SDL2-compat, POSIX files → `IDBFS` (IndexedDB), pthreads → `SharedArrayBuffer` Web Workers.
   - **Must be rewritten:** Inline x86/ARM assembly, OS windowing/registry calls, hardware timers/interrupts.
3. **Headless Core First (`WASM_PORT_PLAN.md`):**
   - Isolate the pure simulation loop into a headless C/Rust module compiled to WASM, verified by replaying input frames and comparing state hashes against the original executable.
