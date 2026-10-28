/**
 * Pi Flow-Control Deterministic 4-State FSM, Fuel/TTL Budget, Stagnation Guard,
 * and Session-Fenced Persistence (`.pi/extensions/lib/pi-flow/fsm.ts`)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProcessStartString, isProcessAlive } from "./process-tree.ts";

export type FlowStateName = "IDLE" | "STEPPING" | "POLLING" | "SPAWNING";

export type FlowOperationName =
	| "flow_goal"
	| "flow_branch"
	| "flow_loop"
	| "flow_monitor"
	| "flow_mapreduce"
	| "flow_halt"
	| "flow_status";

export type HaltOutcome = "completed" | "halted" | "aborted" | "stagnation_detected" | "budget_exhausted";

export const DEFAULT_FUEL = 10;
export const MAX_FUEL = 50;
export const DEFAULT_TTL_MS = 15 * 60_000;
export const MAX_TTL_MS = 60 * 60_000;
export const STAGNATION_THRESHOLD = 3;
export const STAGNATION_RING_SIZE = 4;

export const DEFAULT_WAIT_HINT =
	"Subscribe to pi.events 'flow:state' (state === 'IDLE') or A2A 'notify_when_idle', or retry after retryAfterMs; call /halt to cancel.";

export interface BusyLockedPayload {
	ok: false;
	errorCode: "BUSY_LOCKED";
	requestedOperation: FlowOperationName;
	activeState: FlowStateName;
	activeOperation: FlowOperationName | null;
	reason: string;
	startedAt: string;
	fuelRemaining: number;
	retryAfterMs: number;
	waitHint: string;
}

export interface HaltRecord {
	outcome: HaltOutcome;
	summary: string;
	returnValue?: unknown;
	haltedAt: string;
	completedIterations: number;
}

export interface FlowSnapshot {
	schemaVersion: 1;
	state: FlowStateName;
	activeOperation: FlowOperationName | null;
	leaseEpoch: number;
	sessionId: string;
	pid: number;
	procStart: string;
	cwd: string;
	goal: string | null;
	registers: Record<string, string>;
	fuelRemaining: number;
	maxIterations: number;
	startedAt: string | null;
	deadlineAtMs: number | null;
	retryAfterMs: number;
	stagnationDigests: string[];
	stagnationCount: number;
	lastHalt: HaltRecord | null;
	updatedAt: string;
}

export interface FlowStateEvent {
	state: FlowStateName;
	previousState: FlowStateName;
	operation: string;
	leaseEpoch: number;
	fuelRemaining: number;
	outcome?: HaltOutcome;
	summary?: string;
	returnValue?: unknown;
	timestamp: number;
}

/**
 * Clamp fuel to `[1, MAX_FUEL]` with `DEFAULT_FUEL` fallback.
 */
export function clampFuel(requested?: number): number {
	if (typeof requested !== "number" || !Number.isFinite(requested)) {
		return DEFAULT_FUEL;
	}
	return Math.max(1, Math.min(MAX_FUEL, Math.floor(requested)));
}

/**
 * Clamp TTL to `[1000, MAX_TTL_MS]` with `DEFAULT_TTL_MS` fallback.
 */
export function clampTtlMs(requested?: number): number {
	if (typeof requested !== "number" || !Number.isFinite(requested)) {
		return DEFAULT_TTL_MS;
	}
	return Math.max(1000, Math.min(MAX_TTL_MS, Math.floor(requested)));
}

/**
 * Compute a bounded SHA-256 turn digest (<1 KiB input per tool call) over
 * `(toolName, topLevelArgKeys, boundedArgPrefix(256), argByteLength, isError)`.
 */
export function computeTurnDigest(
	toolCalls: ReadonlyArray<{ toolName: string; args?: unknown; isError?: boolean }>,
): string {
	const hash = crypto.createHash("sha256");
	for (const call of toolCalls) {
		const name = String(call.toolName || "");
		let keys = "";
		let prefix = "";
		let byteLen = 0;
		if (call.args && typeof call.args === "object") {
			keys = Object.keys(call.args as Record<string, unknown>)
				.sort()
				.join(",");
			const raw = JSON.stringify(call.args);
			byteLen = raw.length;
			prefix = raw.slice(0, 256);
		} else if (call.args !== undefined) {
			const raw = String(call.args);
			byteLen = raw.length;
			prefix = raw.slice(0, 256);
		}
		hash.update(`${name}|${keys}|${byteLen}|${call.isError ? "1" : "0"}|${prefix}\n`);
	}
	return hash.digest("hex").slice(0, 16);
}

/**
 * Verify that `dirPath` is a non-symlink directory owned by the current UID (on POSIX).
 */
export function ensureSecureFlowDir(dirPath: string): void {
	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
	}
	const lstat = fs.lstatSync(dirPath);
	if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
		throw new Error(`Refusing insecure flow state directory (symlink or non-directory): ${dirPath}`);
	}
	if (typeof process.getuid === "function" && lstat.uid !== process.getuid()) {
		throw new Error(
			`Refusing flow state directory owned by uid ${lstat.uid} (expected ${process.getuid()}): ${dirPath}`,
		);
	}
}

export class FlowStateMachine {
	private readonly cwd: string;
	private readonly stateDir: string;
	private readonly pid: number;
	private readonly procStart: string;
	private readonly waitHint: string;
	private readonly now: () => number;
	private readonly onStateEvent?: (event: FlowStateEvent) => void;
	private sessionId: string;
	private state: FlowStateName = "IDLE";
	private returnStateAfterSpawn: "IDLE" | "STEPPING" = "IDLE";
	private activeOperation: FlowOperationName | null = null;
	private leaseEpoch = 0;
	private goal: string | null = null;
	private registers: Record<string, string> = {};
	private fuelRemaining = 0;
	private maxIterations = 0;
	private startedAt: string | null = null;
	private deadlineAtMs: number | null = null;
	private retryAfterMs = 0;
	private stagnationDigests: string[] = [];
	private stagnationCount = 0;
	private lastHalt: HaltRecord | null = null;
	private updatedAt: string;
	private pendingWritePromise: Promise<string> | null = null;

	constructor(options?: {
		cwd?: string;
		stateDir?: string;
		sessionId?: string;
		pid?: number;
		procStart?: string;
		waitHint?: string;
		now?: () => number;
		onStateEvent?: (event: FlowStateEvent) => void;
	}) {
		this.cwd = options?.cwd || process.cwd();
		this.stateDir =
			options?.stateDir || process.env.PI_FLOW_STATE_DIR || path.join(this.cwd, ".pi", "flow");
		this.sessionId = options?.sessionId || "default-session";
		this.pid = options?.pid ?? process.pid;
		this.procStart = options?.procStart ?? getProcessStartString(this.pid);
		this.waitHint = options?.waitHint || DEFAULT_WAIT_HINT;
		this.now = options?.now ?? (() => Date.now());
		this.onStateEvent = options?.onStateEvent;
		this.updatedAt = new Date(this.now()).toISOString();
	}

	getStateFilePath(): string {
		return path.join(this.stateDir, "flow-state.json");
	}

	getSnapshot(): FlowSnapshot {
		return {
			schemaVersion: 1,
			state: this.state,
			activeOperation: this.activeOperation,
			leaseEpoch: this.leaseEpoch,
			sessionId: this.sessionId,
			pid: this.pid,
			procStart: this.procStart,
			cwd: this.cwd,
			goal: this.goal,
			registers: { ...this.registers },
			fuelRemaining: this.fuelRemaining,
			maxIterations: this.maxIterations,
			startedAt: this.startedAt,
			deadlineAtMs: this.deadlineAtMs,
			retryAfterMs: this.retryAfterMs,
			stagnationDigests: [...this.stagnationDigests],
			stagnationCount: this.stagnationCount,
			lastHalt: this.lastHalt ? { ...this.lastHalt } : null,
			updatedAt: this.updatedAt,
		};
	}

	private buildBusyLocked(requestedOperation: FlowOperationName, reason: string): BusyLockedPayload {
		return {
			ok: false,
			errorCode: "BUSY_LOCKED",
			requestedOperation,
			activeState: this.state,
			activeOperation: this.activeOperation,
			reason,
			startedAt: this.startedAt || this.updatedAt,
			fuelRemaining: this.fuelRemaining,
			retryAfterMs: this.retryAfterMs > 0 ? this.retryAfterMs : 5000,
			waitHint: this.waitHint,
		};
	}

	private emitTransition(
		previousState: FlowStateName,
		operation: string,
		extra?: { outcome?: HaltOutcome; summary?: string; returnValue?: unknown },
	): void {
		this.updatedAt = new Date(this.now()).toISOString();
		this.onStateEvent?.({
			state: this.state,
			previousState,
			operation,
			leaseEpoch: this.leaseEpoch,
			fuelRemaining: this.fuelRemaining,
			...(extra?.outcome ? { outcome: extra.outcome } : {}),
			...(extra?.summary ? { summary: extra.summary } : {}),
			...(extra?.returnValue !== undefined ? { returnValue: extra.returnValue } : {}),
			timestamp: this.now(),
		});
		void this.flushToDisk().catch(() => {});
	}

	startGoal(params: {
		goal: string;
		maxIterations?: number;
		ttlMs?: number;
		registers?: Record<string, string>;
	}): { ok: true; snapshot: FlowSnapshot } | BusyLockedPayload {
		if (this.state === "POLLING" || this.state === "SPAWNING") {
			return this.buildBusyLocked(
				"flow_goal",
				`Cannot start flow_goal while ${this.activeOperation || this.state} owns the flow lock.`,
			);
		}
		const prev = this.state;
		const nowMs = this.now();
		const fuel = clampFuel(params.maxIterations);
		const ttl = clampTtlMs(params.ttlMs);

		this.leaseEpoch++;
		this.state = "STEPPING";
		this.activeOperation = "flow_goal";
		this.goal = params.goal.trim();
		if (params.registers) {
			this.registers = { ...this.registers, ...params.registers };
		}
		this.fuelRemaining = fuel;
		this.maxIterations = fuel;
		this.startedAt = new Date(nowMs).toISOString();
		this.deadlineAtMs = nowMs + ttl;
		this.retryAfterMs = 5000;
		this.stagnationDigests = [];
		this.stagnationCount = 0;

		this.emitTransition(prev, "flow_goal");
		return { ok: true, snapshot: this.getSnapshot() };
	}

	recordBranchStep(params?: {
		registerKey?: string;
		registerValue?: string;
	}): { ok: true; snapshot: FlowSnapshot; halted?: boolean } | BusyLockedPayload {
		if (this.state === "POLLING" || this.state === "SPAWNING") {
			return this.buildBusyLocked(
				"flow_branch",
				`Cannot execute flow_branch while ${this.activeOperation || this.state} owns the flow lock.`,
			);
		}
		const prev = this.state;
		const nowMs = this.now();
		if (this.state === "IDLE") {
			this.leaseEpoch++;
			this.state = "STEPPING";
			this.activeOperation = "flow_branch";
			this.fuelRemaining = DEFAULT_FUEL;
			this.maxIterations = DEFAULT_FUEL;
			this.startedAt = new Date(nowMs).toISOString();
			this.deadlineAtMs = nowMs + DEFAULT_TTL_MS;
			this.retryAfterMs = 5000;
		}
		if (params?.registerKey) {
			this.registers[params.registerKey] = params.registerValue ?? "";
		}
		const tick = this.consumeFuelTick();
		if (!tick.alive) {
			return { ok: true, snapshot: tick.snapshot, halted: true };
		}
		this.emitTransition(prev, "flow_branch");
		return { ok: true, snapshot: this.getSnapshot() };
	}

	startPolling(params: {
		operation: "flow_loop" | "flow_monitor";
		intervalMs: number;
		maxIterations?: number;
		ttlMs?: number;
		goal?: string;
	}): { ok: true; snapshot: FlowSnapshot } | BusyLockedPayload {
		if (this.state !== "IDLE") {
			return this.buildBusyLocked(
				params.operation,
				`Cannot start ${params.operation} while ${this.activeOperation || this.state} (${this.state}) owns the flow lock.`,
			);
		}
		const prev = this.state;
		const nowMs = this.now();
		const fuel = clampFuel(params.maxIterations);
		const ttl = clampTtlMs(params.ttlMs);
		const intervalMs = Math.max(250, Math.min(3_600_000, Math.floor(params.intervalMs || 5000)));

		this.leaseEpoch++;
		this.state = "POLLING";
		this.activeOperation = params.operation;
		if (params.goal) {
			this.goal = params.goal;
		}
		this.fuelRemaining = fuel;
		this.maxIterations = fuel;
		this.startedAt = new Date(nowMs).toISOString();
		this.deadlineAtMs = nowMs + ttl;
		this.retryAfterMs = intervalMs;
		this.stagnationDigests = [];
		this.stagnationCount = 0;

		this.emitTransition(prev, params.operation);
		return { ok: true, snapshot: this.getSnapshot() };
	}

	startSpawning(params: {
		itemCount: number;
		itemTimeoutMs: number;
	}): { ok: true; snapshot: FlowSnapshot } | BusyLockedPayload {
		if (this.state === "POLLING" || this.state === "SPAWNING") {
			return this.buildBusyLocked(
				"flow_mapreduce",
				`Cannot start flow_mapreduce while ${this.activeOperation || this.state} (${this.state}) owns the flow lock.`,
			);
		}
		const prev = this.state;
		this.returnStateAfterSpawn = this.state === "STEPPING" ? "STEPPING" : "IDLE";
		const nowMs = this.now();
		if (this.state === "IDLE") {
			this.leaseEpoch++;
			this.fuelRemaining = clampFuel(params.itemCount);
			this.maxIterations = this.fuelRemaining;
			this.startedAt = new Date(nowMs).toISOString();
			this.deadlineAtMs = nowMs + clampTtlMs(params.itemCount * params.itemTimeoutMs);
		}
		this.state = "SPAWNING";
		this.activeOperation = "flow_mapreduce";
		this.retryAfterMs = Math.max(1000, Math.min(60_000, Math.floor(params.itemTimeoutMs || 15_000)));

		this.emitTransition(prev, "flow_mapreduce");
		return { ok: true, snapshot: this.getSnapshot() };
	}

	finishSpawning(): FlowSnapshot {
		if (this.state !== "SPAWNING") {
			return this.getSnapshot();
		}
		const prev = this.state;
		this.state = this.returnStateAfterSpawn;
		this.activeOperation = this.state === "STEPPING" ? "flow_goal" : null;
		if (this.state === "IDLE") {
			this.retryAfterMs = 0;
		}
		this.emitTransition(prev, "flow_mapreduce");
		return this.getSnapshot();
	}

	consumeFuelTick(stagnationDigest?: string): {
		alive: boolean;
		haltedOutcome?: HaltOutcome;
		snapshot: FlowSnapshot;
	} {
		if (this.state === "IDLE") {
			return { alive: false, snapshot: this.getSnapshot() };
		}
		const nowMs = this.now();
		if (this.deadlineAtMs !== null && nowMs >= this.deadlineAtMs) {
			const snap = this.halt({
				outcome: "budget_exhausted",
				summary: "Flow TTL deadline expired.",
			});
			return { alive: false, haltedOutcome: "budget_exhausted", snapshot: snap };
		}

		if (stagnationDigest) {
			const prevDigest = this.stagnationDigests[this.stagnationDigests.length - 1];
			if (prevDigest === stagnationDigest) {
				this.stagnationCount++;
			} else {
				this.stagnationCount = 1;
			}
			this.stagnationDigests.push(stagnationDigest);
			if (this.stagnationDigests.length > STAGNATION_RING_SIZE) {
				this.stagnationDigests.shift();
			}
			if (this.stagnationCount >= STAGNATION_THRESHOLD) {
				const snap = this.halt({
					outcome: "stagnation_detected",
					summary: `Auto-halted after ${this.stagnationCount} identical consecutive turn digests (${stagnationDigest}).`,
				});
				return { alive: false, haltedOutcome: "stagnation_detected", snapshot: snap };
			}
		}

		this.fuelRemaining = Math.max(0, this.fuelRemaining - 1);
		this.updatedAt = new Date(nowMs).toISOString();

		if (this.fuelRemaining <= 0) {
			const snap = this.halt({
				outcome: "budget_exhausted",
				summary: `Exhausted fuel budget (${this.maxIterations} iterations).`,
			});
			return { alive: false, haltedOutcome: "budget_exhausted", snapshot: snap };
		}

		return { alive: true, snapshot: this.getSnapshot() };
	}

	halt(params?: { outcome?: HaltOutcome; summary?: string; returnValue?: unknown }): FlowSnapshot {
		const prev = this.state;
		const nowIso = new Date(this.now()).toISOString();
		const completedIterations = Math.max(0, this.maxIterations - this.fuelRemaining);
		const outcome: HaltOutcome = params?.outcome ?? "halted";
		const summary = (params?.summary ?? "Flow halted.").trim();

		this.lastHalt = {
			outcome,
			summary,
			...(params?.returnValue !== undefined ? { returnValue: params.returnValue } : {}),
			haltedAt: nowIso,
			completedIterations,
		};
		this.leaseEpoch++;
		this.state = "IDLE";
		this.returnStateAfterSpawn = "IDLE";
		this.activeOperation = null;
		this.fuelRemaining = 0;
		this.retryAfterMs = 0;
		this.deadlineAtMs = null;
		this.stagnationDigests = [];
		this.stagnationCount = 0;

		this.emitTransition(prev, "flow_halt", {
			outcome,
			summary,
			returnValue: params?.returnValue,
		});
		return this.getSnapshot();
	}

	resetForNewSession(sessionId: string): FlowSnapshot {
		const prev = this.state;
		this.sessionId = sessionId || "default-session";
		this.leaseEpoch++;
		this.state = "IDLE";
		this.returnStateAfterSpawn = "IDLE";
		this.activeOperation = null;
		this.goal = null;
		this.registers = {};
		this.fuelRemaining = 0;
		this.maxIterations = 0;
		this.startedAt = null;
		this.deadlineAtMs = null;
		this.retryAfterMs = 0;
		this.stagnationDigests = [];
		this.stagnationCount = 0;
		this.emitTransition(prev, "session_reset");
		return this.getSnapshot();
	}

	restoreFromSessionEntries(
		entries: ReadonlyArray<{ customType?: string; data?: unknown }>,
		sessionId: string,
	): FlowSnapshot {
		this.sessionId = sessionId || this.sessionId;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry?.customType !== "pi-flow:state" || !entry.data || typeof entry.data !== "object") {
				continue;
			}
			const saved = entry.data as Partial<FlowSnapshot>;
			if (
				saved.state === "STEPPING" &&
				typeof saved.deadlineAtMs === "number" &&
				saved.deadlineAtMs > this.now() &&
				typeof saved.fuelRemaining === "number" &&
				saved.fuelRemaining > 0
			) {
				this.state = "STEPPING";
				this.activeOperation = "flow_goal";
				this.goal = typeof saved.goal === "string" ? saved.goal : null;
				this.registers =
					saved.registers && typeof saved.registers === "object" ? { ...saved.registers } : {};
				this.fuelRemaining = saved.fuelRemaining;
				this.maxIterations = typeof saved.maxIterations === "number" ? saved.maxIterations : saved.fuelRemaining;
				this.startedAt = typeof saved.startedAt === "string" ? saved.startedAt : new Date(this.now()).toISOString();
				this.deadlineAtMs = saved.deadlineAtMs;
				return this.getSnapshot();
			}
			break;
		}
		return this.resetForNewSession(sessionId);
	}

	/**
	 * Read `flow-state.json` from disk ONLY if it belongs to the current live `(sessionId, pid, procStart)`.
	 * Stale snapshots from dead PIDs or different sessions return `null`.
	 */
	loadFencedDiskSnapshot(): FlowSnapshot | null {
		const filePath = this.getStateFilePath();
		if (!fs.existsSync(filePath)) return null;
		try {
			const lstat = fs.lstatSync(filePath);
			if (lstat.isSymbolicLink() || !lstat.isFile()) return null;
			const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<FlowSnapshot>;
			if (!parsed || parsed.schemaVersion !== 1) return null;
			if (typeof parsed.pid !== "number" || !isProcessAlive(parsed.pid)) return null;
			if (parsed.sessionId !== this.sessionId) return null;
			if (parsed.pid === this.pid && parsed.procStart !== this.procStart) return null;
			if (typeof parsed.deadlineAtMs === "number" && parsed.deadlineAtMs <= this.now()) return null;
			return parsed as FlowSnapshot;
		} catch {
			return null;
		}
	}

	/**
	 * Coalesced single-flight atomic disk write of `flow-state.json`.
	 */
	async flushToDisk(): Promise<string> {
		if (this.pendingWritePromise) {
			return this.pendingWritePromise;
		}
		const targetPath = this.getStateFilePath();
		const runWrite = async (): Promise<string> => {
			ensureSecureFlowDir(this.stateDir);
			const payload = `${JSON.stringify(this.getSnapshot(), null, 2)}\n`;
			const rand = crypto.randomBytes(6).toString("hex");
			const tmpPath = `${targetPath}.${this.pid}.${rand}.tmp`;
			await fs.promises.writeFile(tmpPath, payload, { encoding: "utf8", mode: 0o600 });
			try {
				await fs.promises.rename(tmpPath, targetPath);
			} catch {
				// Windows EPERM/EACCES fallback when replacing an existing file
				try {
					await fs.promises.unlink(targetPath);
				} catch {
					// Ignore
				}
				await fs.promises.rename(tmpPath, targetPath);
			}
			return targetPath;
		};

		this.pendingWritePromise = runWrite().finally(() => {
			this.pendingWritePromise = null;
		});
		return this.pendingWritePromise;
	}
}
