# Pi Flow-Control Extension (`pi-flow`) — Design Specification

- **Date:** 2026-10-27
- **Status:** Reviewed & Simplified
- **Target Harness:** `@earendil-works/pi-coding-agent` (`vendor/pi`, v1.4.0+)
- **Location:** `.pi/extensions/pi-flow.ts` + `.pi/extensions/lib/pi-flow/` (standalone, zero Woodchipper/REA dependencies)

---

## 1. Intent & Why

Modern coding agents need a small, deterministic set of control-flow primitives—inspired by a minimal RISC/ARM control unit—that map onto everyday engineering and reverse-engineering workflows:
1. **Goal-directed stepping & conditional branching** (`/goal`, `/branch`)
2. **Bounded iteration & condition polling** (`/loop`, `/monitor`, `/watch`)
3. **Single-child isolated MapReduce delegation** (`/mapreduce`)
4. **Explicit termination & return** (`/halt`)

These primitives are invocable by **three callers** interchangeably:
- **A human** in the interactive Pi TUI via slash commands (`/goal`, `/branch`, `/loop`, `/monitor`, `/watch`, `/mapreduce`, `/halt`, `/flow`)
- **The agent itself** via LLM-callable tools (`flow_goal`, `flow_branch`, `flow_loop`, `flow_monitor`, `flow_mapreduce`, `flow_halt`, `flow_status`)
- **An external agent harness** (Claude Code, Claude Desktop, Codex CLI, Copilot CLI, or `woodchipper-ctl`) over A2A / `peerProtocol: 1` Unix Domain Sockets or RPC

Critically, **`pi-flow` is completely separable from Woodchipper**: it has zero imports from `woodchipper-*` or `rea`, relies only on Node built-ins and the standard Pi `ExtensionAPI`, and communicates with optional host extensions (such as `woodchipper-peer`) strictly through `pi.events` and configurable options (`PiFlowOptions`).

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Minimal RISC-inspired instruction set:** 6 user-facing operations backed by 5 orthogonal runtime instructions (`CMP/SET`, `B.<cond>`, `WAIT`, `BL`, `HLT`).
- **Strict 4-state Finite State Machine (FSM):** `IDLE`, `STEPPING`, `POLLING`, `SPAWNING`. At most one active flow mode per Pi session at any time.
- **Monotonic termination guarantees (Dijkstra invariant):** Every non-idle state carries a strictly decreasing integer fuel counter (`fuelRemaining`) and a monotonic wall-clock deadline (`deadlineAtMs`). No primitive can increase its own fuel without a fresh human command.
- **Deadlock-free MapReduce (Torvalds invariant):**
  - Maximum spawn depth of **1** (`PI_FLOW_DEPTH=1` O(1) fast-path check + memoized cross-platform ancestor PID tree verification).
  - Maximum concurrency of **1 headless child** at a time (`pi --mode json -p --no-session`).
  - Hard prohibition on targeting any PID in the current process's ancestor chain (`ERR_ANCESTOR_TARGET_FORBIDDEN`).
- **Never hide tools:** All `flow_*` tools remain declared to the model at all times (`exposure: "model-only"`, `executionMode: "sequential"`, with `promptSnippet`). When an operation is illegal in the current FSM state, the tool returns a structured `BUSY_LOCKED` or `INVALID_TRANSITION` response explaining **why**, **when to check back** (`retryAfterMs`), and **how to subscribe for completion notifications** (`waitHint`).
- **Session-fenced persistence:** State is recorded in Pi's branch-local session log (`pi.appendEntry("pi-flow:state", ...)`) so `/tree`, `/fork`, `/clear`, and `/reset` isolate state automatically, with a coalesced async `<stateDir>/flow-state.json` snapshot written only on coarse state transitions (`IDLE <-> STEPPING / POLLING / SPAWNING`) and fenced by `(sessionId, pid, procStart)`.

### Non-Goals
- Arbitrary multi-agent DAG orchestration (use `.claude/workflows/*.js` for large multi-agent fan-out when explicitly requested).
- Cross-machine distributed consensus or external database dependencies.

### Anti-Goals (Failure Modes Even If Technically Working)
- Coupled imports to Woodchipper's `EvidenceLedger`, `woodchipper-ctl`, or REA MCP tools inside `pi-flow`.
- Unbounded `setInterval` polling that continues running after `/clear`, `/halt`, or parent process exit.
- Recursive subagent fork-bombs (`mapreduce` calling `mapreduce` in a child process).
- Blocking the main Pi session when a headless child hangs or writes megabytes of stdout.

---

## 3. Instruction Set Architecture (ISA) & Friendly Aliases

All `flow_*` tools are registered with `exposure: "model-only"` (never callable recursively from codemode scripts), `executionMode: "sequential"` (preventing concurrent tool calls in one assistant batch from racing on the FSM mutex), and a concise `promptSnippet`.

| Friendly Slash Command | LLM Tool Name | RISC / CS Analogy | Underlying Mechanism |
| :--- | :--- | :--- | :--- |
| `/goal <objective>` | `flow_goal` | `MOV R_GOAL, #imm` + `CMP` | Sets the active goal register, success criteria, and fuel budget (`maxIterations`, `ttlMs`). Transitions `IDLE -> STEPPING`. |
| `/branch <cond> ? <then> : <else>` | `flow_branch` | `CMP` + `B.EQ` / `B.NE` | Evaluates a deterministic predicate (`file_exists`, `file_contains`, `register_equals`, or bounded `command` exit code `0` gated on `"bash"` being active and routed through the `bash` tool/hook pipeline) and dispatches the `then` or `else` custom wakeup message, decrementing `fuelRemaining`. |
| `/loop <interval> <prompt>` | `flow_loop` | `DEC R_FUEL` + `B.GT` | Recurring custom wakeup turn (`predicate: { kind: "always" }`, `stagnationCheck: true`) via `startPollingRunner()` until `/halt` is called or `fuelRemaining === 0`. Transitions `IDLE -> POLLING`. |
| `/monitor <check> [then]`<br>`/watch <check> [then]` | `flow_monitor` | `WFE` (Wait For Event) / Poll | Non-LLM background condition check (`file_exists`, `file_contains` with `mtimeMs`/`size` stat guard, `register_equals`, or shell command exit `0` gated on `"bash"` being active and read-only command allowlisting in plan/restricted modes) on a bounded backoff schedule via `startPollingRunner()`. Triggers a turn **only** when the condition trips or times out. `/monitor` and `/watch` are exact aliases. |
| `/mapreduce <items> -- <task>` | `flow_mapreduce` | `BL` (Branch with Link) | Maps work sequentially across **at most 1 spawned headless child at a time** (`PI_FLOW_DEPTH=1`, `--no-mcp`, `--no-peer` / `WOODCHIPPER_NO_PEER=1`, hardcoded read-only tools `read,grep,find,ls`, and fixed literal prompt prefix after `--` to prevent flag/`@file` injection), caps output in O(1) at 32 KiB per item via `truncateHead`, and reduces structured results in the parent context. Transitions `IDLE/STEPPING -> SPAWNING -> IDLE/STEPPING`. |
| `/halt [summary]` | `flow_halt` | `HLT` / `RET` | Immediately cancels all timers and child processes, records `{ outcome, summary, returnValue }`, blocks any remaining tools in the current batch, prunes undelivered wakeup messages, notifies `pi.events` (`flow:state`), and resets the FSM to `IDLE`. |
| `/flow [status\|reset]` | `flow_status` | `MRS` (Read Status Register) | Inspects the current FSM state, registers, fuel remaining, memoized ancestor harness chain, and active timers, or forces a state reset. |

---

## 4. Detailed `/halt` Semantics (`HLT` / `RET`)

`/halt` (and the `flow_halt` tool) is the universal circuit breaker and subroutine return instruction:

1. **Immediate Cancellation of Active Work:**
   - Aborts any active `/loop` or `/monitor` (`/watch`) timer (`clearTimeout`) and fires its `AbortController`.
   - If a `/mapreduce` headless child process (or background `command` predicate) is running, terminates its entire process tree cross-platform (`System32\taskkill.exe /F /T /PID <pid>` with `windowsHide: true` on Windows `win32`; `SIGTERM` to `-pid` followed by a `.unref()`-ed 2-second `SIGKILL` fallback timer on macOS/Linux).
2. **State Register Update & Session Entry:**
   - Records `{ outcome: "completed" | "halted" | "aborted" | "stagnation_detected" | "budget_exhausted", summary, returnValue, haltedAt, completedIterations }` in `lastHalt`, transitions the FSM from any state (`STEPPING`, `POLLING`, `SPAWNING`) to `IDLE`, appends `pi.appendEntry("pi-flow:state", state)`, and queues a coalesced async write to `flow-state.json`.
3. **Turn & Wakeup Queue Termination:**
   - Because `flow_*` tools run with `executionMode: "sequential"`, if `flow_halt` is called during an assistant tool batch, `pi-flow` sets a turn-scoped `haltedInCurrentTurn = true` flag; a `pi.on("tool_call")` handler blocks any subsequent tool calls in the same turn with `{ block: true, terminate: true, reason: "Flow halted via flow_halt" }`.
   - A `pi.on("context")` handler strips any undelivered `customType: "pi-flow:wakeup"` messages whose `leaseEpoch` predates the halt so queued timer ticks never fire an extra turn after `/halt`.
4. **Event Bus & A2A Notification:**
   - Emits `pi.events.emit("flow:state", { state: "IDLE", previousState, operation: "halt", ... })`.
   - Any attached peer/A2A bridge subscribed to `flow:state` immediately flushes the halt summary and `peer_idle_notice` to waiting callers.
5. **Interactive vs. Headless Child Behavior:**
   - In interactive TUI or persistent daemon mode, `/halt` leaves the Pi session alive in `IDLE` and updates the TUI status indicator to `⏹ halted`.
   - If `/halt --exit` is passed (or `exitWhenHalted: true` in a one-shot headless child), calls `ctx.shutdown()` after flushing output.

---

## 5. Finite State Machine, Mutual Exclusion, & Availability Contract

### 5.1 The 4 States

```text
          ┌────────────────── /goal, /branch ──────────────────┐
          ▼                                                    │
      ┌──────────┐                                       ┌───────────┐
      │ STEPPING │ ─────── /mapreduce (depth == 0) ────► │ SPAWNING  │
      └──────────┘ ◄────── child exits / reduced ─────── └───────────┘
          │                                                    ▲  │
      /halt or                                    /mapreduce   │  │ /halt or
     fuel === 0                                  (depth == 0)  │  │ child done
          ▼                                                    │  ▼
      ┌──────────┐ ◄────────── /halt or fuel === 0 ────── ┌───────────┐
      │   IDLE   │ ──────── /loop, /monitor, /watch ────► │  POLLING  │
      └──────────┘                                        └───────────┘
```

### 5.2 Legal Transitions & Concurrency Rules
- Only **one** flow mode (`STEPPING`, `POLLING`, or `SPAWNING`) may own the session lock at a time, except that `STEPPING` may invoke `SPAWNING` (`/mapreduce`) as a synchronous subroutine (`BL`) when `depth === 0`, returning to `STEPPING` when the child finishes.
- While in `POLLING` (`/loop`, `/monitor`, `/watch`), starting another `/loop`, `/monitor`, or `/mapreduce` is rejected until the active poll completes or `/halt` is called.
- While in `SPAWNING` (`/mapreduce`), all other state-mutating flow calls are rejected until the child finishes or `/halt` cancels it.

### 5.3 Never Hide Tools — Structured `BUSY_LOCKED` Responses
Tools are **never** hidden or removed via `setActiveTools()`. If the LLM, human, or A2A caller invokes a flow tool that is currently blocked by the FSM or depth guard, the tool returns `isError: true` with a deterministic, harness-agnostic payload:

```json
{
  "ok": false,
  "errorCode": "BUSY_LOCKED",
  "requestedOperation": "flow_mapreduce",
  "activeState": "POLLING",
  "activeOperation": "flow_monitor",
  "reason": "Cannot start flow_mapreduce while flow_monitor ('check build output') owns the flow lock.",
  "startedAt": "2026-10-27T14:00:00.000Z",
  "fuelRemaining": 6,
  "retryAfterMs": 15000,
  "waitHint": "Subscribe to pi.events 'flow:state' (state === 'IDLE') or A2A 'notify_when_idle', or retry after retryAfterMs; call /halt to cancel."
}
```

Host extensions can customize `waitHint` via `PiFlowOptions.waitHint`.

---

## 6. Termination, Loop Prevention, & Session-Fenced Persistence

### 6.1 Dual Monotonic Bounds (Fuel + Deadline)
Every non-idle flow operation initializes:
- `fuelRemaining`: integer in `[1, MAX_FUEL]` (default `10`, hard ceiling `50`). Decremented by `1` on every `/loop` tick, `/monitor` check, `/branch` jump, or `/mapreduce` item.
- `deadlineAtMs`: `Date.now() + ttlMs` (default `15 * 60_000`, hard ceiling `60 * 60_000`).
- When `fuelRemaining <= 0` or `Date.now() >= deadlineAtMs`, the runtime automatically executes `/halt` with `outcome: "budget_exhausted"`.

### 6.2 Bounded Stagnation Detection (4-Slot Ring Buffer)
To prevent an agent in `STEPPING` or `/loop` from repeating the exact same failing action until its fuel runs out without hashing multi-kilobyte payloads:
- On `pi.on("turn_end")` while in `STEPPING` or `/loop` (`stagnationCheck: true`), `pi-flow` computes a lightweight SHA-256 digest by feeding `(toolName, topLevelArgKeys, boundedArgPrefix(256), argByteLength, isError)` for each tool call in the turn (< 1 KiB hashed per turn) into a 4-slot ring buffer.
- If 3 consecutive turns produce identical digests (`stagnationCount >= 3`), the FSM auto-halts with `outcome: "stagnation_detected"`.
- Background `/monitor` / `/watch` checks set `stagnationCheck: false` since waiting for an external condition to change is expected to be no-op until it trips.

### 6.3 Session-Scoped Persistence & Stale Disk Fencing
1. **Primary In-Session Persistence (`pi.appendEntry`):**
   - Coarse state transitions and `STEPPING` register updates are appended via `pi.appendEntry("pi-flow:state", snapshot)`.
   - On `session_start` (`reason: "reload" | "resume"`), `pi-flow` scans the active branch (`ctx.sessionManager.getBranch()`) for the latest `"pi-flow:state"` entry. If its `state === "STEPPING"` and `Date.now() < deadlineAtMs`, it restores the goal/registers; `/tree`, `/fork`, `/clear`, and `/reset` start with a clean branch so stale state never leaks across sessions.
2. **Coalesced External Status File (`<stateDir>/flow-state.json`):**
   - For external CLI/status inspection, `pi-flow` writes `<stateDir>/flow-state.json` (default `<cwd>/.pi/flow/flow-state.json` or `PI_FLOW_STATE_DIR`) asynchronously via a single-flight write queue (`0o600` temp file + rename) **only on coarse state transitions** (`IDLE <-> STEPPING / POLLING / SPAWNING`) and `/halt`—never on per-tick fuel decrements.
   - Each snapshot is stamped with `{ schemaVersion: 1, sessionId, pid, procStart, cwd, updatedAt }`. On `session_start` (`"startup" | "new" | "fork"`), `/clear`, or `/reset`, any existing `flow-state.json` from a dead PID or different `(sessionId, procStart)` is overwritten directly with a clean `IDLE` snapshot.

---

## 7. Cross-Platform Process Tree, Harness Detection, & MapReduce Isolation

### 7.1 Memoized Cross-Platform Ancestor PID Discovery (`process-tree.ts`)
Because `pi-flow` may be invoked by Claude Code, Claude Desktop, Codex CLI, Copilot CLI, another Pi instance, or a human shell across **macOS, Linux, and Windows**, `process-tree.ts` provides a zero-dependency process-tree inspector with **O(1) fast-path and memoization**:

1. **O(1) Environment Fast-Path:**
   - `flow_mapreduce` checks `Number(process.env.PI_FLOW_DEPTH || 0) >= 1` **first** before touching the OS process table, rejecting nested calls in O(1) with zero syscalls.
2. **Per-Process Memoization:**
   - `getProcessLineage()` caches its result keyed by `(process.pid, process.ppid)` so `/flow status`, `flow_mapreduce`, and A2A status queries pay the OS lookup cost at most once per process lifetime.
3. **Platform Walkers:**
   - **Linux:** Walks `/proc/<pid>/stat` and `/proc/<pid>/cmdline` upward along `ppid` (~3–6 ancestors) via `fs.readFileSync` (< 0.2 ms, zero child processes spawned), falling back to `ps` only if `/proc` is unavailable.
   - **macOS / POSIX:** Runs `execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm=,args="], { timeout: 2000 })` once and walks upward from `process.pid` via `ppid` with a visited-PID cycle guard.
   - **Windows (`win32`):** Runs `execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"], { timeout: 3000 })` once (with fallback to `process.ppid`) and walks upward with a visited-PID cycle guard.
4. **Recognized Agent Harness Signatures:**
   - Matches command names/argv against `claude`, `Claude`, `codex`, `gh copilot`, `copilot`, `pi`, `woodchipper`, `cursor`, `windsurf`.
   - Also exports `isProcessAlive(pid)` and `getProcessStartString(pid)` so `.pi/extensions/lib/peer-protocol.ts` can reuse them without duplication.

### 7.2 MapReduce Constraints (`flow_mapreduce`)
1. **Depth Limit = 1:**
   - If `PI_FLOW_DEPTH >= 1` or an ancestor `pi-flow` worker is detected in `lineage.ancestors`, `flow_mapreduce` immediately refuses with `errorCode: "ERR_MAX_DEPTH_EXCEEDED"`.
2. **Single Headless Child (`MAX_CONCURRENCY = 1`) & Hardened CLI Invocation:**
   - For each item in `items` (bounded to `maxItems <= 16`), spawns **at most 1** headless Pi process at a time:
     ```bash
     pi --mode json -p --no-session --no-mcp --tools read,grep,find,ls -- "[pi-flow mapreduce item 1/N]\nTask: ...\nItem: ..."
     ```
   - **Flag & `@file` Injection Prevention:** The prompt argument is always placed after `--` **and** begins with the fixed constant prefix `"[pi-flow mapreduce item ...]"`, guaranteeing that `vendor/pi`'s `parseArgs` (`args.ts:83-90,177-183`) never interprets an untrusted `item` starting with `-` as a CLI flag or `@` as a local `@file` attachment.
   - **Strict Read-Only Tool Allowlist & Peer Isolation:** The child tool set is intersected against a hardcoded read-only allowlist (`read`, `grep`, `find`, `ls`); `--no-mcp` prevents spawning duplicate 207-tool `rea` MCP servers per item; and `PI_FLOW_DEPTH="1"`, `PI_FLOW_PARENT_PID=String(process.pid)`, and `WOODCHIPPER_NO_PEER="1"` (plus a `PI_FLOW_DEPTH > 0` guard in `woodchipper-peer.ts`) ensure ephemeral children never overwrite `.woodchipper/peer.sock` or hijack `"woodchipper"` in `~/.claude/sessions`.
   - Retains only the latest assistant text block (capped at 32 KiB on ingestion via `truncateHead` / `Buffer.subarray`) and a bounded 8 KiB `stderr` tail, and removes the `AbortSignal` listener + `SIGKILL` timer in the child `close` handler so no closures leak across items.
3. **Ancestor Deadlock Guard (`ERR_ANCESTOR_TARGET_FORBIDDEN`):**
   - Any PID in `lineage.ancestorPids` (including `selfPid` and `invokingHarness.pid`) is strictly forbidden as a synchronous delegation target (`checkTargetPidAllowed(targetPid, lineage)`), preventing cyclic wait deadlocks across A2A peers.

---

## 8. Eventing & Notification Architecture

1. **Two Typed Events on `pi.events`:**
   - `flow:state` — `{ state: FlowState, previousState: FlowState, operation: string, leaseEpoch: number, fuelRemaining: number, outcome?: string, summary?: string, returnValue?: unknown, timestamp: number }` (emitted on every transition, step, or halt; `state === "IDLE"` serves as both the halt and idle notification).
   - `flow:progress` — `{ operation: "flow_monitor" | "flow_mapreduce", index?: number, total?: number, detail: string, elapsedMs: number }`.
2. **Custom Wakeup Messages (`pi.sendMessage`):**
   - `/loop`, `/monitor` (`/watch`), and `/branch` dispatch turns via `pi.sendMessage({ customType: "pi-flow:wakeup", content, display: true, details: { leaseEpoch, operation } }, { triggerTurn: true, deliverAs: "followUp" })` so synthetic flow turns never masquerade as human `BeforeAgentStartUserEvent` inputs.
3. **Decoupled Host Peer Bridge (`woodchipper-peer.ts`):**
   - When `woodchipper-peer.ts` runs alongside `pi-flow.ts`, it listens to `pi.events.on("flow:state")`:
     - Keeps `peerServer` in `"busy"` while `flow:state` is `POLLING` or `SPAWNING` so `notify_when_idle` subscribers are notified when the flow actually finishes rather than after the initial setup turn.
     - Exposes the latest `flow:state` snapshot inside `woodchipper-ctl status`.
     - **Out-of-Band Control Plane vs. Data Plane (Claude Code Peer Model):** Inbound `type: "user"` peer messages (and auto-replies with `isReply: true`) **always** retain their `[Peer request from ...]` provenance envelope and `expandPromptTemplates: false` so untrusted peer replies can never trigger in-process slash commands. External harnesses cancel or inspect flows via explicit `type: "a2a"` control actions (`action: "flow_halt" | "flow_status"`), which emit `pi.events.emit("flow:cmd:halt", ...)` directly on the control plane without allowing `--exit`.

---

## 9. Hardened MIT Prior Art & Security Boundaries

1. **`@earendil-works/pi-coding-agent` Core SDK & Examples (`vendor/pi`, MIT):**
   - `truncateHead()` for UTF-8-safe O(1) output capping, `ctx.ui.setStatus()` / `ctx.ui.setWidget()` from `plan-mode/index.ts`, `getPiInvocation()` from `subagent/index.ts`, and `pi.events` from `event-bus.ts`.
2. **Claude Code / Codex Command & Provenance Security Model:**
   - **Active-Tool & Hook Enforcement on `command` Predicates:** In `flow_branch` and `flow_monitor`, `predicate.kind === "command"` requires `pi.getActiveTools().includes("bash")` and `PI_FLOW_DEPTH === 0` (returning `ERR_BASH_DISABLED` when `bash` is disabled, as in Plan Mode or read-only sessions). In `flow_branch`, command predicates execute via `ctx.executeTool("bash", ...)` so all registered `tool_call` security hooks run; in background `flow_monitor` ticks, commands are validated against both the destructive-git blocklist and read-only command allowlisting when write tools are disabled, and spawned in a detached process group (`-proc.pid` killed on timeout/halt).
   - **Evidence Ledger Provenance Isolation (`NON_REA_BUILTIN_TOOLS`):** `.pi/extensions/woodchipper-rea.ts` includes all `flow_*` tools in `NON_REA_BUILTIN_TOOLS` (and excludes `toolName.startsWith("flow_")` in `isReaTool()`) so unverified text from `flow_mapreduce` children can never be scraped as authoritative `ev_*` REA Evidence IDs.

---

## 10. File Layout & Separation Boundary

```text
.pi/
  extensions/
    pi-flow.ts                        # Standalone Pi extension entry point (tools, /goal /branch /loop /monitor /watch /mapreduce /halt /flow commands, TUI status widget, hooks)
    lib/
      schema.ts                       # Shared zero-dependency TypeBox resolver & fallback (String, Number, Boolean, Literal, Optional, Array, Union, Object)
      pi-flow/
        fsm.ts                        # 4-state FSM, fuel/TTL counters, 4-slot stagnation ring buffer, BUSY_LOCKED builder, session entry & coalesced flow-state.json persistence
        process-tree.ts               # Memoized cross-platform (Linux /proc, macOS ps, Windows PowerShell CIM) ancestor PID tree, harness detector, & ancestor deadlock guard
        runners.ts                    # Shared predicate evaluator (file_exists, file_contains with stat cache, register_equals, git-safe command), unified startPollingRunner (/loop & /monitor & /watch), and single-child MapReduce runner
tests/
  pi-flow.test.mjs                    # Unit & integration tests (FSM transitions, BUSY_LOCKED, session-fenced state, stagnation, cross-platform PID tree, MapReduce depth=1 & ancestor guard, /halt)
```
