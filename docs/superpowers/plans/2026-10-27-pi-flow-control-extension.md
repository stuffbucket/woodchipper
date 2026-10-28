# Pi Flow-Control Extension (`pi-flow`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, cross-platform (`darwin`, `linux`, `win32`) RISC-inspired flow-control extension (`pi-flow`) for `@earendil-works/pi-coding-agent` providing `/goal`, `/branch`, `/loop`, `/monitor` (`/watch`), `/mapreduce`, `/halt`, and `/flow` across TUI commands, LLM tools, and A2A peer sockets.

**Architecture:** Three focused library modules in `.pi/extensions/lib/pi-flow/` (`process-tree.ts`, `fsm.ts`, `runners.ts`) backing a zero-Woodchipper-coupled extension entry point (`.pi/extensions/pi-flow.ts`). State is governed by a 4-state mutex FSM (`IDLE`, `STEPPING`, `POLLING`, `SPAWNING`) with monotonic fuel/deadline budgets, a 4-slot stagnation ring buffer, branch-local `pi.appendEntry` persistence, coalesced session-fenced `flow-state.json` snapshots, and decoupled `pi.events` (`flow:state`, `flow:progress`) bridged into `woodchipper-peer.ts` and `woodchipper-rea.ts`.

**Tech Stack:** Node.js `>=22.19.0` (`--experimental-strip-types`, `node:test`), TypeScript, `@earendil-works/pi-coding-agent` (`v1.4.0`), TypeBox (`1.3.27` + zero-dependency fallback in `.pi/extensions/lib/schema.ts`).

**Spec:** `docs/superpowers/specs/2026-10-27-pi-flow-control-extension-design.md`

## Global Constraints

- **Zero Woodchipper Coupling in `pi-flow`:** `.pi/extensions/pi-flow.ts` and `.pi/extensions/lib/pi-flow/*.ts` must never import from `woodchipper-*`, `evidence-ledger.ts`, or `rea`.
- **Never Hide Tools:** All 7 tools (`flow_goal`, `flow_branch`, `flow_loop`, `flow_monitor`, `flow_mapreduce`, `flow_halt`, `flow_status`) are registered with `exposure: "model-only"`, `executionMode: "sequential"`, and `promptSnippet`, and return structured `BUSY_LOCKED` JSON (`isError: true`) when blocked.
- **Monotonic Bounds:** Default `maxIterations = 10` (hard ceiling `50`), default `ttlMs = 900_000` (15m, hard ceiling `3_600_000` / 60m), stagnation threshold = `3` identical consecutive turn digests in `STEPPING` or `/loop`.
- **MapReduce Depth & Concurrency = 1:** Fast-path `Number(process.env.PI_FLOW_DEPTH || 0) >= 1` check + memoized ancestor PID tree check (`ERR_MAX_DEPTH_EXCEEDED`), max 1 headless child at a time (`MAX_CONCURRENCY = 1`), max 16 items (`maxItems = 16`), 32 KiB per-item output cap, `--no-mcp`, `WOODCHIPPER_NO_PEER="1"`, and fixed literal prefix after `--` (`"[pi-flow mapreduce item ...]"`).
- **Cross-Platform Process Management:** Must work on `darwin`, `linux`, and `win32` (`System32\taskkill.exe /F /T /PID` on Windows, `-pid` process-group `SIGTERM`/`SIGKILL` on POSIX).
- **Git Rules:** Never run `git reset --hard` or destructive git commands; do not put references to claude or emojis in git commit messages.

## Review Focus

1. **MapReduce item starting with `-` or `@` (e.g. `"--tools=bash,write"` or `"@~/.pi/agent/auth.json"`):** Must be prefixed after `--` with `"[pi-flow mapreduce item i/N]\n..."` so `vendor/pi`'s `parseArgs` never interprets an item as a CLI flag or `@file` attachment (tested in Task 3).
2. **`command` predicate called when `bash` tool is disabled (e.g. Plan Mode or `--exclude-tools bash`):** `flow_branch` and `flow_monitor` must check `pi.getActiveTools().includes("bash")` and reject with `ERR_BASH_DISABLED` before executing any command (tested in Task 3 & Task 4).
3. **A2A auto-reply (`isReply: true`) starting with `/monitor` or `/branch`:** `woodchipper-peer.ts` must keep `[Peer request from ...]` and `expandPromptTemplates: false` on all `type: "user"` prompts and expose `flow_halt` / `flow_status` only as explicit `type: "a2a"` control actions (tested in Task 5).
4. **Stale `flow-state.json` from a dead PID or previous `/clear` session:** On `session_start` (`"startup" | "new" | "fork"`), `/clear`, or `/reset`, stale disk state must be overwritten with `IDLE` rather than resumed (tested in Task 2).
5. **`flow_halt` invoked mid-batch or while a `/loop` wakeup is already queued:** Remaining tool calls in the same turn must be blocked (`{ block: true, terminate: true }`) and undelivered `pi-flow:wakeup` messages from an older `leaseEpoch` must be filtered out in `pi.on("context")` (tested in Task 4).

---

### Task 1: Schema Extensions & Cross-Platform Process Tree (`schema.ts` & `process-tree.ts`)

**Files:**
- Modify: `.pi/extensions/lib/schema.ts:11-90`
- Create: `.pi/extensions/lib/pi-flow/process-tree.ts`
- Test: `tests/pi-flow.test.mjs`

**Interfaces:**
- Produces in `.pi/extensions/lib/schema.ts`:
  - `Type.Number(options?: SchemaOptions & { minimum?: number; maximum?: number }): TSchema`
  - `Type.Boolean(options?: SchemaOptions): TSchema`
- Produces in `.pi/extensions/lib/pi-flow/process-tree.ts`:
  - `export type DetectedHarness = "claude-code" | "claude-desktop" | "codex" | "copilot-cli" | "pi" | "woodchipper" | "cursor" | "windsurf"`
  - `export interface AncestorProcessInfo { pid: number; ppid: number; command: string; args: string; detectedHarness?: DetectedHarness }`
  - `export interface ProcessLineage { selfPid: number; ppid: number; flowDepth: number; ancestors: AncestorProcessInfo[]; ancestorPids: ReadonlySet<number>; invokingHarness: AncestorProcessInfo | null }`
  - `export function detectHarnessFromCommand(command: string, args?: string): DetectedHarness | undefined`
  - `export function parsePosixPsOutput(psText: string): Map<number, { pid: number; ppid: number; command: string; args: string }>`
  - `export function parseWindowsCimJson(jsonText: string): Map<number, { pid: number; ppid: number; command: string; args: string }>`
  - `export function walkAncestorChain(startPid: number, table: ReadonlyMap<number, { pid: number; ppid: number; command: string; args: string }>): AncestorProcessInfo[]`
  - `export function getProcessLineage(options?: { env?: NodeJS.ProcessEnv; forceRefresh?: boolean }): ProcessLineage`
  - `export function checkTargetPidAllowed(targetPid: number, lineage?: ProcessLineage): { allowed: boolean; errorCode?: "ERR_ANCESTOR_TARGET_FORBIDDEN"; reason?: string }`
  - `export function isProcessAlive(pid: number): boolean`
  - `export function getProcessStartString(pid?: number): string`
  - `export function killProcessTreeCrossPlatform(pid: number, signal?: NodeJS.Signals): void`

- [ ] **Step 1: Write the failing tests for `Type.Number`/`Type.Boolean` and `process-tree.ts` in `tests/pi-flow.test.mjs`**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "../.pi/extensions/lib/schema.ts";
import {
	checkTargetPidAllowed,
	detectHarnessFromCommand,
	getProcessLineage,
	parsePosixPsOutput,
	parseWindowsCimJson,
	walkAncestorChain,
} from "../.pi/extensions/lib/pi-flow/process-tree.ts";

test("Type.Number and Type.Boolean produce valid JSON Schema", () => {
	const num = Type.Number({ description: "fuel", minimum: 1, maximum: 50 });
	const bool = Type.Boolean({ description: "flag" });
	assert.equal(num.type, "number");
	assert.equal(bool.type, "boolean");
});

test("parsePosixPsOutput, parseWindowsCimJson, and walkAncestorChain detect ancestor harnesses and break cycles", () => {
	const psTable = parsePosixPsOutput([
		"  100     1 /usr/local/bin/claude claude --dangerously-skip-permissions",
		"  200   100 node /repo/bin/woodchipper.mjs daemon",
		"  300   200 node /repo/.woodchipper/pi/cli.js",
	].join("\n"));
	const chain = walkAncestorChain(300, psTable);
	assert.equal(chain.length, 3);
	assert.equal(chain[1].detectedHarness, "woodchipper");
	assert.equal(chain[2].detectedHarness, "claude-code");

	const winTable = parseWindowsCimJson(JSON.stringify([
		{ ProcessId: 10, ParentProcessId: 10, Name: "codex.exe", CommandLine: "codex.exe" },
		{ ProcessId: 20, ParentProcessId: 10, Name: "node.exe", CommandLine: "node.exe pi" },
	]));
	const winChain = walkAncestorChain(20, winTable);
	assert.equal(winChain.length, 2);
	assert.equal(winChain[1].detectedHarness, "codex");
});

test("checkTargetPidAllowed blocks self and ancestor PIDs and getProcessLineage respects PI_FLOW_DEPTH", () => {
	const lineage = getProcessLineage({ env: { ...process.env, PI_FLOW_DEPTH: "1" }, forceRefresh: true });
	assert.equal(lineage.flowDepth >= 1, true);
	const selfCheck = checkTargetPidAllowed(process.pid, lineage);
	assert.equal(selfCheck.allowed, false);
	assert.equal(selfCheck.errorCode, "ERR_ANCESTOR_TARGET_FORBIDDEN");
	const otherCheck = checkTargetPidAllowed(999_999, lineage);
	assert.equal(otherCheck.allowed, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/pi-flow.test.mjs`
Expected: FAIL (`Cannot find module '../.pi/extensions/lib/pi-flow/process-tree.ts'`)

- [ ] **Step 3: Implement `Type.Number` / `Type.Boolean` in `.pi/extensions/lib/schema.ts` and `.pi/extensions/lib/pi-flow/process-tree.ts`**

In `.pi/extensions/lib/schema.ts`, add `Number` and `Boolean` to `TypeBuilder` and `fallbackType`. In `.pi/extensions/lib/pi-flow/process-tree.ts`, implement memoized lineage lookup keyed by `(process.pid, process.ppid, env.PI_FLOW_DEPTH)`, Linux `/proc/<pid>/stat` + `/proc/<pid>/cmdline` fast-path reader, POSIX `ps -A -o pid=,ppid=,comm=,args=` parser, Windows `Get-CimInstance Win32_Process` JSON parser (supporting both single-object and array outputs from `ConvertTo-Json`), cycle-safe `walkAncestorChain`, `getProcessStartString` (using `Math.floor(Date.now() / 1000 - process.uptime())` fast-path when `pid === process.pid`), and `killProcessTreeCrossPlatform` (`taskkill.exe /F /T /PID` on `win32`, `process.kill(-pid, signal)` with `process.kill(pid, signal)` fallback on POSIX).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/pi-flow.test.mjs`
Expected: PASS (3 tests passing)

---

### Task 2: Deterministic 4-State FSM, Fuel/TTL, Stagnation Ring Buffer, & Session-Fenced State (`fsm.ts`)

**Files:**
- Create: `.pi/extensions/lib/pi-flow/fsm.ts`
- Modify: `tests/pi-flow.test.mjs`

**Interfaces:**
- Consumes: `getProcessStartString`, `isProcessAlive` from `.pi/extensions/lib/pi-flow/process-tree.ts`
- Produces in `.pi/extensions/lib/pi-flow/fsm.ts`:
  - `export type FlowStateName = "IDLE" | "STEPPING" | "POLLING" | "SPAWNING"`
  - `export type FlowOperationName = "flow_goal" | "flow_branch" | "flow_loop" | "flow_monitor" | "flow_mapreduce" | "flow_halt" | "flow_status"`
  - `export type HaltOutcome = "completed" | "halted" | "aborted" | "stagnation_detected" | "budget_exhausted"`
  - `export const DEFAULT_FUEL = 10; export const MAX_FUEL = 50; export const DEFAULT_TTL_MS = 15 * 60_000; export const MAX_TTL_MS = 60 * 60_000; export const STAGNATION_THRESHOLD = 3;`
  - `export interface BusyLockedPayload { ok: false; errorCode: "BUSY_LOCKED"; requestedOperation: FlowOperationName; activeState: FlowStateName; activeOperation: FlowOperationName | null; reason: string; startedAt: string; fuelRemaining: number; retryAfterMs: number; waitHint: string }`
  - `export interface FlowSnapshot { schemaVersion: 1; state: FlowStateName; activeOperation: FlowOperationName | null; leaseEpoch: number; sessionId: string; pid: number; procStart: string; cwd: string; goal: string | null; registers: Record<string, string>; fuelRemaining: number; maxIterations: number; startedAt: string | null; deadlineAtMs: number | null; retryAfterMs: number; stagnationDigests: string[]; stagnationCount: number; lastHalt: { outcome: HaltOutcome; summary: string; returnValue?: unknown; haltedAt: string; completedIterations: number } | null; updatedAt: string }`
  - `export function computeTurnDigest(toolCalls: ReadonlyArray<{ toolName: string; args?: unknown; isError?: boolean }>): string`
  - `export class FlowStateMachine` with methods:
    - `constructor(options?: { cwd?: string; stateDir?: string; sessionId?: string; pid?: number; procStart?: string; waitHint?: string; now?: () => number; onStateEvent?: (event: Record<string, unknown>) => void })`
    - `getSnapshot(): FlowSnapshot`
    - `startGoal(params: { goal: string; maxIterations?: number; ttlMs?: number; registers?: Record<string, string> }): { ok: true; snapshot: FlowSnapshot } | BusyLockedPayload`
    - `recordBranchStep(params: { registerKey?: string; registerValue?: string }): { ok: true; snapshot: FlowSnapshot; halted?: boolean } | BusyLockedPayload`
    - `startPolling(params: { operation: "flow_loop" | "flow_monitor"; intervalMs: number; maxIterations?: number; ttlMs?: number; goal?: string }): { ok: true; snapshot: FlowSnapshot } | BusyLockedPayload`
    - `startSpawning(params: { itemCount: number; itemTimeoutMs: number }): { ok: true; snapshot: FlowSnapshot } | BusyLockedPayload`
    - `finishSpawning(): FlowSnapshot`
    - `consumeFuelTick(stagnationDigest?: string): { alive: boolean; haltedOutcome?: HaltOutcome; snapshot: FlowSnapshot }`
    - `halt(params?: { outcome?: HaltOutcome; summary?: string; returnValue?: unknown }): FlowSnapshot`
    - `resetForNewSession(sessionId: string): FlowSnapshot`
    - `restoreFromSessionEntries(entries: ReadonlyArray<{ customType?: string; data?: unknown }>, sessionId: string): FlowSnapshot`
    - `flushToDisk(): Promise<string>`
    - `loadFencedDiskSnapshot(): FlowSnapshot | null`

- [ ] **Step 1: Write the failing tests for `FlowStateMachine` in `tests/pi-flow.test.mjs`**

```js
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	computeTurnDigest,
	FlowStateMachine,
} from "../.pi/extensions/lib/pi-flow/fsm.ts";

test("FlowStateMachine enforces 4-state transitions, BUSY_LOCKED, and STEPPING -> SPAWNING -> STEPPING return", () => {
	let clock = 1_700_000_000_000;
	const fsm = new FlowStateMachine({ now: () => clock, sessionId: "sess-1" });
	assert.equal(fsm.getSnapshot().state, "IDLE");

	const poll = fsm.startPolling({ operation: "flow_monitor", intervalMs: 5000, maxIterations: 4 });
	assert.equal(poll.ok, true);
	assert.equal(fsm.getSnapshot().state, "POLLING");

	const blocked = fsm.startSpawning({ itemCount: 2, itemTimeoutMs: 10000 });
	assert.equal(blocked.ok, false);
	if (!blocked.ok) {
		assert.equal(blocked.errorCode, "BUSY_LOCKED");
		assert.equal(blocked.activeState, "POLLING");
		assert.equal(blocked.retryAfterMs, 5000);
	}

	fsm.halt({ outcome: "halted", summary: "cancelled poll" });
	assert.equal(fsm.getSnapshot().state, "IDLE");

	// STEPPING -> SPAWNING -> STEPPING subroutine return
	assert.equal(fsm.startGoal({ goal: "audit binary", maxIterations: 5 }).ok, true);
	assert.equal(fsm.startSpawning({ itemCount: 2, itemTimeoutMs: 5000 }).ok, true);
	assert.equal(fsm.getSnapshot().state, "SPAWNING");
	assert.equal(fsm.finishSpawning().state, "STEPPING");
});

test("FlowStateMachine auto-halts on fuel exhaustion, TTL expiry, and 3-turn stagnation", () => {
	let clock = 1_700_000_000_000;
	const fsm = new FlowStateMachine({ now: () => clock, sessionId: "sess-2" });
	fsm.startGoal({ goal: "loop test", maxIterations: 5, ttlMs: 10_000 });

	const d = computeTurnDigest([{ toolName: "grep", args: { pattern: "foo" }, isError: false }]);
	assert.equal(fsm.consumeFuelTick(d).alive, true);
	assert.equal(fsm.consumeFuelTick(d).alive, true);
	const third = fsm.consumeFuelTick(d);
	assert.equal(third.alive, false);
	assert.equal(third.haltedOutcome, "stagnation_detected");
	assert.equal(fsm.getSnapshot().state, "IDLE");

	// TTL expiry
	fsm.startPolling({ operation: "flow_loop", intervalMs: 1000, maxIterations: 10, ttlMs: 5000 });
	clock += 6000;
	const expired = fsm.consumeFuelTick();
	assert.equal(expired.alive, false);
	assert.equal(expired.haltedOutcome, "budget_exhausted");
});

test("FlowStateMachine fences stale disk state from dead PIDs or mismatched sessions", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flow-fsm-"));
	const staleFile = path.join(tmpDir, "flow-state.json");
	fs.writeFileSync(
		staleFile,
		JSON.stringify({
			schemaVersion: 1,
			state: "POLLING",
			sessionId: "old-session",
			pid: 999_998,
			procStart: "old",
		}),
		"utf8",
	);

	const fsm = new FlowStateMachine({ stateDir: tmpDir, sessionId: "new-session" });
	assert.equal(fsm.loadFencedDiskSnapshot(), null);
	await fsm.flushToDisk();
	const onDisk = JSON.parse(fs.readFileSync(staleFile, "utf8"));
	assert.equal(onDisk.state, "IDLE");
	assert.equal(onDisk.sessionId, "new-session");
	fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/pi-flow.test.mjs`
Expected: FAIL (`Cannot find module '../.pi/extensions/lib/pi-flow/fsm.ts'`)

- [ ] **Step 3: Implement `.pi/extensions/lib/pi-flow/fsm.ts`**

Implement `FlowStateMachine` with:
- Pure synchronous state transitions (`IDLE`, `STEPPING`, `POLLING`, `SPAWNING`, remembering `returnState: "IDLE" | "STEPPING"` when entering `SPAWNING`),
- Clamped `maxIterations` (`[1, 50]`, default `10`) and `ttlMs` (`[1000, 3_600_000]`, default `900_000`),
- Incremental SHA-256 `computeTurnDigest` hashing `(toolName, topLevelKeys, 256-char arg slice, argLength, isError)` and a 4-slot `stagnationDigests` ring buffer that auto-halts at `stagnationCount >= 3`,
- `ensureSecureFlowDir()` checking `!lstat.isSymbolicLink()` and UID ownership on POSIX before writing `<stateDir>/flow-state.json` via a single-flight async temp-file + `rename` (with Windows `EPERM`/`EACCES` unlink+rename fallback).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/pi-flow.test.mjs`
Expected: PASS (6 tests passing)

---

### Task 3: Predicate Evaluator, Unified Polling Runner (`/loop`, `/monitor`, `/watch`), & Single-Child MapReduce Runner (`runners.ts`)

**Files:**
- Create: `.pi/extensions/lib/pi-flow/runners.ts`
- Modify: `tests/pi-flow.test.mjs`

**Interfaces:**
- Consumes: `FlowStateMachine` from `./fsm.ts`; `getProcessLineage`, `killProcessTreeCrossPlatform` from `./process-tree.ts`
- Produces in `.pi/extensions/lib/pi-flow/runners.ts`:
  - `export const ALLOWED_MAPREDUCE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"])`
  - `export const MAX_MAPREDUCE_ITEMS = 16; export const MAX_MAPREDUCE_ITEM_BYTES = 32 * 1024;`
  - `export type FlowPredicate = { kind: "always" } | { kind: "file_exists"; path: string } | { kind: "file_contains"; path: string; pattern: string } | { kind: "register_equals"; key: string; value: string } | { kind: "command"; command: string }`
  - `export function normalizeGitShellCommand(rawCommand: string): string`
  - `export function checkDestructiveGitCommand(command: string): { blocked: boolean; reason?: string }`
  - `export function isReadOnlySafeShellCommand(command: string): boolean`
  - `export function parseShorthandPredicate(expr: string): FlowPredicate`
  - `export function evaluatePredicate(predicate: FlowPredicate, ctx: { cwd: string; registers: Readonly<Record<string, string>>; activeTools: readonly string[]; flowDepth?: number; statCache?: Map<string, { mtimeMs: number; size: number; matched: boolean }>; runCommand?: (cmd: string, timeoutMs: number) => Promise<{ exitCode: number; output: string }> }): Promise<{ matched: boolean; output: string; errorCode?: "ERR_BASH_DISABLED" | "ERR_DESTRUCTIVE_COMMAND" | "ERR_UNSAFE_COMMAND_IN_READONLY"; errorReason?: string }>`
  - `export function buildMapReduceChildArgs(params: { item: string; task: string; index: number; total: number; requestedTools?: readonly string[]; model?: string }): { args: string[]; sanitizedTools: string[]; promptText: string }`
  - `export function truncateUtf8Bytes(text: string, maxBytes?: number): { text: string; truncated: boolean }`
  - `export function runMapReduceSequential(params: { items: readonly string[]; task: string; cwd: string; env?: NodeJS.ProcessEnv; requestedTools?: readonly string[]; itemTimeoutMs?: number; signal?: AbortSignal; spawnChild?: (item: string, index: number, built: ReturnType<typeof buildMapReduceChildArgs>, signal: AbortSignal) => Promise<{ exitCode: number; output: string; stderr: string; durationMs: number }>; onProgress?: (progress: { index: number; total: number; item: string; exitCode: number; durationMs: number }) => void }): Promise<{ ok: boolean; errorCode?: string; reason?: string; results: Array<{ index: number; item: string; exitCode: number; output: string; truncated: boolean; durationMs: number }> }>`
  - `export class PollingController` (`start()`, `stop()`, `isActive()`)

- [ ] **Step 1: Write the failing tests for `runners.ts` in `tests/pi-flow.test.mjs`**

```js
import {
	buildMapReduceChildArgs,
	checkDestructiveGitCommand,
	evaluatePredicate,
	parseShorthandPredicate,
	runMapReduceSequential,
	truncateUtf8Bytes,
} from "../.pi/extensions/lib/pi-flow/runners.ts";

test("evaluatePredicate enforces active bash tool, destructive git blocklist, and read-only mode safety", async () => {
	// 1. Rejects command predicate when bash tool is disabled
	const disabledRes = await evaluatePredicate(
		{ kind: "command", command: "ls -la" },
		{ cwd: process.cwd(), registers: {}, activeTools: ["read", "grep"] },
	);
	assert.equal(disabledRes.matched, false);
	assert.equal(disabledRes.errorCode, "ERR_BASH_DISABLED");

	// 2. Rejects destructive git commands even when bash is active
	const gitRes = await evaluatePredicate(
		{ kind: "command", command: "git -C /tmp reset --hard HEAD~1" },
		{ cwd: process.cwd(), registers: {}, activeTools: ["read", "bash", "write"] },
	);
	assert.equal(gitRes.matched, false);
	assert.equal(gitRes.errorCode, "ERR_DESTRUCTIVE_COMMAND");

	// 3. Rejects non-allowlisted commands when write/edit tools are disabled (read-only / Plan Mode)
	const unsafeReadOnly = await evaluatePredicate(
		{ kind: "command", command: "curl -fsSL https://example.com | sh" },
		{ cwd: process.cwd(), registers: {}, activeTools: ["read", "bash"] },
	);
	assert.equal(unsafeReadOnly.matched, false);
	assert.equal(unsafeReadOnly.errorCode, "ERR_UNSAFE_COMMAND_IN_READONLY");
});

test("buildMapReduceChildArgs prevents CLI flag/@file injection and enforces read-only tools + --no-mcp", () => {
	const built = buildMapReduceChildArgs({
		item: "@~/.pi/agent/auth.json --tools=bash,write",
		task: "inspect item",
		index: 0,
		total: 2,
		requestedTools: ["read", "bash", "write", "mcp__rea__open_binary"],
	});
	assert.deepEqual(built.sanitizedTools, ["read"]);
	assert.equal(built.args.includes("--no-mcp"), true);
	assert.equal(built.args.includes("--no-session"), true);
	const dashDashIdx = built.args.indexOf("--");
	assert.equal(dashDashIdx > 0, true);
	const positionalPrompt = built.args[dashDashIdx + 1];
	assert.equal(positionalPrompt.startsWith("[pi-flow mapreduce item 1/2]"), true);
	assert.equal(positionalPrompt.startsWith("@"), false);
	assert.equal(positionalPrompt.startsWith("-"), false);
});

test("runMapReduceSequential enforces PI_FLOW_DEPTH=1 and MAX_CONCURRENCY=1", async () => {
	const nested = await runMapReduceSequential({
		items: ["a"],
		task: "t",
		cwd: process.cwd(),
		env: { ...process.env, PI_FLOW_DEPTH: "1" },
	});
	assert.equal(nested.ok, false);
	assert.equal(nested.errorCode, "ERR_MAX_DEPTH_EXCEEDED");

	let inFlight = 0;
	let maxInFlight = 0;
	const okRun = await runMapReduceSequential({
		items: ["item-1", "item-2", "item-3"],
		task: "summarize",
		cwd: process.cwd(),
		env: { ...process.env, PI_FLOW_DEPTH: "0" },
		spawnChild: async (item) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 10));
			inFlight--;
			return { exitCode: 0, output: `done:${item}`, stderr: "", durationMs: 10 };
		},
	});
	assert.equal(okRun.ok, true);
	assert.equal(maxInFlight, 1);
	assert.equal(okRun.results.length, 3);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/pi-flow.test.mjs`
Expected: FAIL (`Cannot find module '../.pi/extensions/lib/pi-flow/runners.ts'`)

- [ ] **Step 3: Implement `.pi/extensions/lib/pi-flow/runners.ts`**

Implement:
- `normalizeGitShellCommand` and `checkDestructiveGitCommand` (matching `.pi/extensions/woodchipper-rea.ts:138-172, 233-254`),
- `isReadOnlySafeShellCommand` (allowlisting safe read-only inspection commands when `"write"` and `"edit"` are absent from `activeTools`, blocking `;`, `|`, `&`, `` ` ``, `$(`, `>`, `<` command chaining to destructive binaries),
- `evaluatePredicate` with `statCache` (`mtimeMs`, `size`, `lstat.isFile()`, 1 MiB read cap) for `file_contains`,
- `truncateUtf8Bytes` in O(1) via `Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8")`,
- `buildMapReduceChildArgs` and `runMapReduceSequential` spawning `pi --mode json -p --no-session --no-mcp --tools <readOnlyTools> -- "[pi-flow mapreduce item ...]"` with `PI_FLOW_DEPTH="1"`, `WOODCHIPPER_NO_PEER="1"`, `windowsHide: true`, and `killProcessTreeCrossPlatform` + listener cleanup on close/abort,
- `PollingController` driving `/loop` and `/monitor` (`/watch`) with `AbortController` and `clearTimeout`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/pi-flow.test.mjs`
Expected: PASS (9 tests passing)

---

### Task 4: Standalone Pi Flow Extension Entry Point (`.pi/extensions/pi-flow.ts`)

**Files:**
- Create: `.pi/extensions/pi-flow.ts`
- Modify: `tests/pi-flow.test.mjs`

**Interfaces:**
- Consumes: `Type` from `./lib/schema.ts`; `FlowStateMachine`, `computeTurnDigest` from `./lib/pi-flow/fsm.ts`; `getProcessLineage`, `checkTargetPidAllowed` from `./lib/pi-flow/process-tree.ts`; `PollingController`, `evaluatePredicate`, `parseShorthandPredicate`, `runMapReduceSequential` from `./lib/pi-flow/runners.ts`
- Produces in `.pi/extensions/pi-flow.ts`:
  - `export interface PiFlowExtensionOptions { stateDir?: string; waitHint?: string; env?: NodeJS.ProcessEnv }`
  - `export const FLOW_TOOL_NAMES: readonly string[] = ["flow_goal", "flow_branch", "flow_loop", "flow_monitor", "flow_mapreduce", "flow_halt", "flow_status"]`
  - `export default function piFlowExtension(pi: ExtensionAPI, options?: PiFlowExtensionOptions): void`
  - Registers 7 tools (`flow_goal`, `flow_branch`, `flow_loop`, `flow_monitor`, `flow_mapreduce`, `flow_halt`, `flow_status`) with `exposure: "model-only"`, `executionMode: "sequential"`, and `promptSnippet`
  - Registers 8 slash commands (`/goal`, `/branch`, `/loop`, `/monitor`, `/watch`, `/mapreduce`, `/halt`, `/flow`)
  - Subscribes to `session_start`, `session_shutdown`, `turn_start`, `turn_end`, `tool_call`, `context`, and `pi.events.on("flow:cmd:halt")` / `pi.events.on("flow:cmd:status")`

- [ ] **Step 1: Write the failing integration tests for `piFlowExtension` in `tests/pi-flow.test.mjs`**

```js
import piFlowExtension, { FLOW_TOOL_NAMES } from "../.pi/extensions/pi-flow.ts";

test("piFlowExtension registers 7 sequential model-only tools, 8 commands (including /monitor and /watch alias), blocks remaining tools after flow_halt, and prunes stale wakeups", async () => {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const busListeners = new Map();
	const sentMessages = [];

	const mockPi = {
		registerTool(def) { tools.set(def.name, def); },
		registerCommand(name, def) { commands.set(name, def); },
		registerFlag() {},
		getFlag() { return undefined; },
		getActiveTools() { return ["read", "grep", "find", "ls", ...FLOW_TOOL_NAMES]; },
		setActiveTools() {},
		appendEntry() {},
		sendMessage(msg, opts) { sentMessages.push({ msg, opts }); },
		sendUserMessage() {},
		on(event, fn) {
			const list = handlers.get(event) || [];
			list.push(fn);
			handlers.set(event, list);
			return () => {};
		},
		events: {
			on(ev, fn) { busListeners.set(ev, fn); },
			emit(ev, payload) { busListeners.get(ev)?.(payload); },
		},
	};

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flow-ext-"));
	piFlowExtension(mockPi, { stateDir: tmpDir });

	for (const name of FLOW_TOOL_NAMES) {
		const t = tools.get(name);
		assert.ok(t, `missing tool ${name}`);
		assert.equal(t.exposure, "model-only");
		assert.equal(t.executionMode, "sequential");
		assert.ok(t.promptSnippet);
	}
	for (const cmd of ["goal", "branch", "loop", "monitor", "watch", "mapreduce", "halt", "flow"]) {
		assert.ok(commands.has(cmd), `missing command /${cmd}`);
	}

	// Start a goal, then call flow_halt and verify subsequent tool_call in same turn is blocked with terminate: true
	await tools.get("flow_goal").execute("tc-1", { goal: "test goal", max_iterations: 4 }, undefined, undefined, { cwd: tmpDir });
	await tools.get("flow_halt").execute("tc-2", { summary: "done" }, undefined, undefined, { cwd: tmpDir });

	const toolCallHandler = handlers.get("tool_call")[0];
	const postHaltCall = await toolCallHandler({ type: "tool_call", toolCallId: "tc-3", toolName: "read", input: {} }, { cwd: tmpDir });
	assert.deepEqual(postHaltCall, { block: true, terminate: true, reason: "Flow halted in current turn via flow_halt." });

	// Stale wakeup message from old leaseEpoch is pruned by context handler
	const contextHandler = handlers.get("context")[0];
	const ctxRes = await contextHandler({
		type: "context",
		messages: [
			{ role: "custom", customType: "pi-flow:wakeup", content: "old tick", details: { leaseEpoch: 0 } },
			{ role: "user", content: "keep me" },
		],
	});
	assert.equal(ctxRes.messages.length, 1);
	fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/pi-flow.test.mjs`
Expected: FAIL (`Cannot find module '../.pi/extensions/pi-flow.ts'`)

- [ ] **Step 3: Implement `.pi/extensions/pi-flow.ts`**

Wire `FlowStateMachine`, `PollingController`, `evaluatePredicate`, and `runMapReduceSequential` into `piFlowExtension(pi, options)`:
- Register all 7 `flow_*` tools with `exposure: "model-only"`, `executionMode: "sequential"`, and `promptSnippet`.
- Register `/goal`, `/branch`, `/loop`, `/monitor`, `/watch` (exact alias to `/monitor`'s handler), `/mapreduce`, `/halt`, and `/flow`.
- Emit `flow:state` and `flow:progress` on `pi.events`, and listen for `flow:cmd:halt` and `flow:cmd:status` on `pi.events` for out-of-band A2A control.
- Update TUI footer status (`ctx.ui.setStatus("pi-flow", ...)`) on state transitions.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/pi-flow.test.mjs`
Expected: PASS (10 tests passing)

---

### Task 5: Host Wiring (`.pi/settings.json`, `woodchipper-rea.ts`, `woodchipper-peer.ts`, `peer-protocol.ts`, `woodchipper-ctl.mjs`, & Validator)

**Files:**
- Modify: `.pi/settings.json:22-26`
- Modify: `.pi/extensions/woodchipper-rea.ts:116-148`
- Modify: `.pi/extensions/lib/peer-protocol.ts:65-77, 934-985`
- Modify: `.pi/extensions/woodchipper-peer.ts:48-155`
- Modify: `scripts/woodchipper-ctl.mjs:58-98`
- Modify: `scripts/validate.mjs` and `package.json:62`
- Test: `tests/pi-flow.test.mjs`, `tests/peer-extension.test.mjs`, `tests/pi-extension.test.mjs`

**Interfaces:**
- Consumes: `FLOW_TOOL_NAMES` from `.pi/extensions/pi-flow.ts`; `normalizeGitShellCommand` from `.pi/extensions/lib/pi-flow/runners.ts`
- Produces:
  - `.pi/settings.json` includes `"./extensions/pi-flow.ts"` in `extensions`
  - `.pi/extensions/woodchipper-rea.ts`: `NON_REA_BUILTIN_TOOLS` includes all 7 `flow_*` tool names (preserving mutant `M11_NON_REA_EV_SCRAPING`), and reuses `normalizeGitShellCommand`
  - `.pi/extensions/lib/peer-protocol.ts`: `A2ARequest.action` adds `"flow_status" | "flow_halt"`; `PeerServerCallbacks` adds `getFlowStatus?: () => Record<string, unknown> | null` and `onFlowHalt?: (summary?: string) => Record<string, unknown> | null`
  - `.pi/extensions/woodchipper-peer.ts`: skips starting `WoodchipperPeerServer` when `Number(process.env.PI_FLOW_DEPTH || 0) > 0`; tracks `flow:state` on `pi.events` so `setIdleAndNotify` waits while `POLLING` or `SPAWNING` is active; wires `getFlowStatus` and `onFlowHalt` callbacks while keeping `expandPromptTemplates: false` and `[Peer request from ...]` on `onPrompt`
  - `scripts/woodchipper-ctl.mjs`: supports `woodchipper-ctl halt [peer] [summary]` and includes `flow` in `woodchipper-ctl status`

- [ ] **Step 1: Write the failing test in `tests/pi-flow.test.mjs` for `NON_REA_BUILTIN_TOOLS`, child peer suppression (`PI_FLOW_DEPTH=1`), and A2A `flow_halt` / `flow_status`**

```js
import { isReaTool, NON_REA_BUILTIN_TOOLS } from "../.pi/extensions/woodchipper-rea.ts";
import { sendFrameToPeerSocket, WoodchipperPeerServer } from "../.pi/extensions/lib/peer-protocol.ts";

test("NON_REA_BUILTIN_TOOLS excludes all flow_* tools from REA ev_* scraping", () => {
	for (const toolName of FLOW_TOOL_NAMES) {
		assert.equal(NON_REA_BUILTIN_TOOLS.has(toolName), true);
		assert.equal(isReaTool(toolName), false);
	}
});

test("WoodchipperPeerServer handles out-of-band A2A flow_status and flow_halt actions", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flow-peer-"));
	let haltedSummary = null;
	const srv = new WoodchipperPeerServer({
		name: "woodchipper-flow-test",
		cwd: tmpDir,
		sessionsDir: path.join(tmpDir, "sessions"),
		socketDir: path.join(tmpDir, "socks"),
		callbacks: {
			onPrompt: () => {},
			getFlowStatus: () => ({ state: haltedSummary ? "IDLE" : "POLLING", summary: haltedSummary }),
			onFlowHalt: (summary) => {
				haltedSummary = summary || "halted via a2a";
				return { state: "IDLE", summary: haltedSummary };
			},
		},
	});
	await srv.start();
	try {
		const rawHalt = await sendFrameToPeerSocket(
			srv.socketPath,
			{ type: "a2a", id: "req-1", action: "flow_halt", message: "stop poll" },
			{ sessionsDir: srv.sessionsDir, targetPid: srv.pid },
		);
		const parsed = JSON.parse(rawHalt);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.flow.state, "IDLE");
		assert.equal(parsed.flow.summary, "stop poll");
	} finally {
		srv.stop();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/pi-flow.test.mjs`
Expected: FAIL (`assert.equal(NON_REA_BUILTIN_TOOLS.has(toolName), true)`)

- [ ] **Step 3: Update `.pi/settings.json`, `.pi/extensions/woodchipper-rea.ts`, `.pi/extensions/lib/peer-protocol.ts`, `.pi/extensions/woodchipper-peer.ts`, `scripts/woodchipper-ctl.mjs`, `scripts/validate.mjs`, and `package.json`**

Apply the host integration changes and add `tests/pi-flow.test.mjs` to the `test` script in `package.json`.

- [ ] **Step 4: Run full validation, test suite, and mutation suite**

Run: `pnpm run validate && pnpm test && pnpm run test:mutate`
Expected: All validation checks pass, all unit/integration tests pass, and all 13 security/logic mutants are killed.
