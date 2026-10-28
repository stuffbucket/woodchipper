/**
 * Pi Flow-Control Extension (`.pi/extensions/pi-flow.ts`)
 *
 * Standalone, zero-Woodchipper-coupled RISC-inspired flow-control extension for
 * `@earendil-works/pi-coding-agent`:
 * - `/goal` (`flow_goal`)           — MOV R_GOAL + bounded fuel/TTL budget (`IDLE -> STEPPING`)
 * - `/branch` (`flow_branch`)       — CMP + conditional branch (`B.EQ` / `B.NE`)
 * - `/loop` (`flow_loop`)           — Bounded recurring turn loop (`IDLE -> POLLING`)
 * - `/monitor` & `/watch` (`flow_monitor`) — Background non-LLM condition wait (`WFE` / poll)
 * - `/mapreduce` (`flow_mapreduce`) — Single-child (`MAX_CONCURRENCY=1`, `PI_FLOW_DEPTH=1`) MapReduce (`BL`)
 * - `/halt` (`flow_halt`)           — Universal circuit breaker & subroutine return (`HLT` / `RET`)
 * - `/flow` (`flow_status`)         — Read status register (`MRS`) or reset flow state
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	computeTurnDigest,
	DEFAULT_FUEL,
	DEFAULT_TTL_MS,
	FlowStateMachine,
	type FlowSnapshot,
	type HaltOutcome,
} from "./lib/pi-flow/fsm.ts";
import { getProcessLineage } from "./lib/pi-flow/process-tree.ts";
import {
	evaluatePredicate,
	type FlowPredicate,
	MAX_MAPREDUCE_ITEMS,
	PollingController,
	parseShorthandPredicate,
	runMapReduceSequential,
} from "./lib/pi-flow/runners.ts";
import { Type } from "./lib/schema.ts";

export interface PiFlowExtensionOptions {
	stateDir?: string;
	waitHint?: string;
	env?: NodeJS.ProcessEnv;
}

export const FLOW_TOOL_NAMES: readonly string[] = [
	"flow_goal",
	"flow_branch",
	"flow_loop",
	"flow_monitor",
	"flow_mapreduce",
	"flow_halt",
	"flow_status",
];

function parseIntervalMs(raw: string | number | undefined, fallbackMs = 15_000): number {
	if (typeof raw === "number" && Number.isFinite(raw)) {
		return Math.max(250, Math.min(3_600_000, Math.floor(raw)));
	}
	const str = String(raw || "").trim().toLowerCase();
	const match = str.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|m|min|h)?$/);
	if (!match) return fallbackMs;
	const val = Number.parseFloat(match[1]);
	const unit = match[2] || "s";
	if (!Number.isFinite(val) || val <= 0) return fallbackMs;
	const mult = unit === "ms" ? 1 : unit === "m" || unit === "min" ? 60_000 : unit === "h" ? 3_600_000 : 1000;
	return Math.max(250, Math.min(3_600_000, Math.floor(val * mult)));
}

export function formatFlowStatusMarkdown(snapshot: FlowSnapshot, env = process.env): string {
	const lineage = getProcessLineage({ env });
	const lines = [
		`## Pi Flow Status (\`${snapshot.state}\`)`,
		`- **State:** \`${snapshot.state}\`${snapshot.activeOperation ? ` (operation: \`${snapshot.activeOperation}\`)` : ""}`,
		`- **Lease Epoch:** \`${snapshot.leaseEpoch}\` • **Fuel Remaining:** \`${snapshot.fuelRemaining}/${snapshot.maxIterations}\``,
		`- **Goal Register:** ${snapshot.goal ? `\`${snapshot.goal}\`` : "_none_"}`,
		`- **Flow Depth:** \`${lineage.flowDepth}\` • **Self PID:** \`${lineage.selfPid}\` • **Invoking Harness:** \`${lineage.invokingHarness?.detectedHarness ?? "direct/shell"}\``,
		`- **Ancestor PID Chain:** \`${lineage.ancestors.map((a) => `${a.pid}(${a.detectedHarness || a.command})`).join(" <- ")}\``,
	];
	const regKeys = Object.keys(snapshot.registers);
	if (regKeys.length > 0) {
		lines.push(`- **Registers:** \`${JSON.stringify(snapshot.registers)}\``);
	}
	if (snapshot.lastHalt) {
		lines.push(
			`- **Last Halt:** \`${snapshot.lastHalt.outcome}\` at \`${snapshot.lastHalt.haltedAt}\` — ${snapshot.lastHalt.summary}`,
		);
	}
	return lines.join("\n");
}

export default function piFlowExtension(pi: ExtensionAPI, options: PiFlowExtensionOptions = {}): void {
	const env = options.env ?? process.env;
	let currentCtx: ExtensionContext | undefined;
	let haltedInCurrentTurn = false;
	let mapReduceAbortController: AbortController | null = null;
	const pollingController = new PollingController();

	const emitBusEvent = (eventName: string, payload: unknown) => {
		const bus = (pi as unknown as { events?: { emit?: (name: string, data: unknown) => void } }).events;
		bus?.emit?.(eventName, payload);
	};

	const onBusEvent = (eventName: string, handler: (data: any) => void) => {
		const bus = (pi as unknown as { events?: { on?: (name: string, fn: (data: any) => void) => void } }).events;
		bus?.on?.(eventName, handler);
	};

	const updateTuiStatus = (snap: FlowSnapshot, ctx = currentCtx) => {
		if (!ctx?.hasUI || typeof ctx.ui?.setStatus !== "function") return;
		if (snap.state === "IDLE") {
			ctx.ui.setStatus("pi-flow", undefined);
			return;
		}
		const badge =
			snap.state === "STEPPING"
				? `🎯 ${snap.goal || "stepping"} (${snap.fuelRemaining})`
				: snap.state === "POLLING"
					? `⟳ ${snap.activeOperation || "polling"} (${snap.fuelRemaining})`
					: `⑂ mapreduce (${snap.fuelRemaining})`;
		const styled = typeof ctx.ui?.theme?.fg === "function" ? ctx.ui.theme.fg("accent", badge) : badge;
		ctx.ui.setStatus("pi-flow", styled);
	};

	const fsm = new FlowStateMachine({
		cwd: process.cwd(),
		stateDir: options.stateDir || env.PI_FLOW_STATE_DIR || path.join(process.cwd(), ".pi", "flow"),
		waitHint: options.waitHint,
		onStateEvent: (evt) => {
			emitBusEvent("flow:state", {
				...evt,
				snapshot: fsm.getSnapshot(),
			});
			updateTuiStatus(fsm.getSnapshot());
		},
	});

	const persistSessionSnapshot = (snap: FlowSnapshot) => {
		if (typeof pi.appendEntry === "function") {
			pi.appendEntry("pi-flow:state", snap);
		}
	};

	const dispatchWakeupTurn = (content: string, operation: string, leaseEpoch: number) => {
		if (typeof pi.sendMessage === "function") {
			pi.sendMessage(
				{
					customType: "pi-flow:wakeup",
					content,
					display: true,
					details: { leaseEpoch, operation },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		}
	};

	const executeHalt = (params?: {
		outcome?: HaltOutcome;
		summary?: string;
		returnValue?: unknown;
		inToolTurn?: boolean;
		exitProcess?: boolean;
		ctx?: ExtensionContext;
	}): FlowSnapshot => {
		pollingController.stop();
		if (mapReduceAbortController) {
			mapReduceAbortController.abort();
			mapReduceAbortController = null;
		}
		if (params?.inToolTurn) {
			haltedInCurrentTurn = true;
		}
		const snap = fsm.halt({
			outcome: params?.outcome ?? "halted",
			summary: params?.summary ?? "Flow halted.",
			returnValue: params?.returnValue,
		});
		persistSessionSnapshot(snap);
		updateTuiStatus(snap, params?.ctx ?? currentCtx);
		if (params?.exitProcess && typeof (params.ctx ?? currentCtx)?.shutdown === "function") {
			(params.ctx ?? currentCtx)!.shutdown();
		}
		return snap;
	};

	// Out-of-band A2A / extension bus control listeners
	onBusEvent("flow:cmd:halt", (data: { summary?: string; outcome?: HaltOutcome } | undefined) => {
		executeHalt({
			outcome: data?.outcome ?? "halted",
			summary: data?.summary || "Halted via A2A control signal.",
		});
	});

	onBusEvent("flow:cmd:status", (data: { reply?: (snap: FlowSnapshot) => void } | undefined) => {
		data?.reply?.(fsm.getSnapshot());
	});

	// =========================================================================
	// Lifecycle Event Hooks
	// =========================================================================

	pi.on("session_start", async (event, ctx) => {
		currentCtx = ctx;
		haltedInCurrentTurn = false;
		pollingController.stop();
		if (mapReduceAbortController) {
			mapReduceAbortController.abort();
			mapReduceAbortController = null;
		}
		const sessionId = ctx?.sessionManager?.getSessionFile?.() || "default-session";
		if (event.reason === "reload" || event.reason === "resume") {
			const branch = (ctx?.sessionManager?.getBranch?.() || []) as Array<{
				customType?: string;
				data?: unknown;
			}>;
			const snap = fsm.restoreFromSessionEntries(branch, sessionId);
			updateTuiStatus(snap, ctx);
		} else {
			const snap = fsm.resetForNewSession(sessionId);
			updateTuiStatus(snap, ctx);
		}
	});

	pi.on("session_shutdown", async () => {
		pollingController.stop();
		if (mapReduceAbortController) {
			mapReduceAbortController.abort();
			mapReduceAbortController = null;
		}
	});

	pi.on("turn_start", async () => {
		haltedInCurrentTurn = false;
	});

	pi.on("tool_call", async () => {
		if (haltedInCurrentTurn) {
			return {
				block: true,
				terminate: true,
				reason: "Flow halted in current turn via flow_halt.",
			};
		}
		return undefined;
	});

	pi.on("turn_end", async (event) => {
		const snap = fsm.getSnapshot();
		if (snap.state !== "STEPPING" && !(snap.state === "POLLING" && snap.activeOperation === "flow_loop")) {
			return undefined;
		}
		const toolResults = Array.isArray(event.toolResults) ? event.toolResults : [];
		if (toolResults.length === 0) return undefined;
		const digest = computeTurnDigest(
			toolResults.map((tr) => ({
				toolName: (tr as unknown as { toolName?: string }).toolName || "tool",
				args: undefined,
				isError: Boolean(tr.isError),
			})),
		);
		const tick = fsm.consumeFuelTick(digest);
		if (!tick.alive) {
			pollingController.stop();
			persistSessionSnapshot(tick.snapshot);
		}
		return undefined;
	});

	pi.on("context", async (event) => {
		const currentEpoch = fsm.getSnapshot().leaseEpoch;
		const activeState = fsm.getSnapshot().state;
		const filtered = event.messages.filter((msg) => {
			const customMsg = msg as { role?: string; customType?: string; details?: { leaseEpoch?: number } };
			if (customMsg.customType === "pi-flow:wakeup") {
				const msgEpoch = customMsg.details?.leaseEpoch;
				if (activeState === "IDLE" || (typeof msgEpoch === "number" && msgEpoch < currentEpoch)) {
					return false;
				}
			}
			return true;
		});
		if (filtered.length !== event.messages.length) {
			return { messages: filtered };
		}
		return undefined;
	});

	// =========================================================================
	// LLM-Callable Tools (exposure: "model-only", executionMode: "sequential")
	// =========================================================================

	pi.registerTool({
		name: "flow_goal",
		label: "Flow Goal (MOV R_GOAL)",
		description:
			"Set an explicit workflow goal register and bounded fuel/TTL budget (transitions IDLE -> STEPPING). Returns BUSY_LOCKED if another flow mode owns the lock.",
		promptSnippet: "Set active workflow goal and bounded step/TTL budget (IDLE -> STEPPING)",
		exposure: "model-only",
		executionMode: "sequential",
		parameters: Type.Object({
			goal: Type.String({ description: "Clear objective to achieve before calling flow_halt" }),
			max_iterations: Type.Optional(
				Type.Number({ description: "Maximum step fuel budget (1..50, default 10)", minimum: 1, maximum: 50 }),
			),
			ttl_ms: Type.Optional(
				Type.Number({ description: "Wall-clock timeout in milliseconds (default 900000)" }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			currentCtx = ctx;
			const res = fsm.startGoal({
				goal: params.goal,
				maxIterations: params.max_iterations,
				ttlMs: params.ttl_ms,
			});
			if (!res.ok) {
				return {
					content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
					details: res,
					isError: true,
				};
			}
			persistSessionSnapshot(res.snapshot);
			return {
				content: [
					{
						type: "text",
						text: `Set active goal (${res.snapshot.fuelRemaining} fuel): ${res.snapshot.goal}`,
					},
				],
				details: res.snapshot,
			};
		},
	});

	pi.registerTool({
		name: "flow_branch",
		label: "Flow Conditional Branch (CMP + B.cond)",
		description:
			"Evaluate a deterministic condition (file_exists, file_contains, register_equals, or command exit code 0) and branch to then_prompt or else_prompt, decrementing fuel.",
		promptSnippet: "Evaluate a deterministic condition and branch to then_prompt or else_prompt",
		exposure: "model-only",
		executionMode: "sequential",
		parameters: Type.Object({
			kind: Type.Union([
				Type.Literal("file_exists"),
				Type.Literal("file_contains"),
				Type.Literal("register_equals"),
				Type.Literal("command"),
			]),
			target: Type.String({
				description: "File path (for file_exists/file_contains), register key (for register_equals), or command string (for command)",
			}),
			expected: Type.Optional(
				Type.String({ description: "Substring pattern (for file_contains) or register value (for register_equals)" }),
			),
			then_prompt: Type.String({ description: "Follow-up action when the condition matches" }),
			else_prompt: Type.String({ description: "Follow-up action when the condition does not match" }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			currentCtx = ctx;
			const stepRes = fsm.recordBranchStep();
			if (!stepRes.ok) {
				return {
					content: [{ type: "text", text: JSON.stringify(stepRes, null, 2) }],
					details: stepRes,
					isError: true,
				};
			}
			if (stepRes.halted) {
				return {
					content: [{ type: "text", text: `Flow budget exhausted during branch: ${stepRes.snapshot.lastHalt?.summary}` }],
					details: stepRes.snapshot,
					isError: true,
				};
			}

			const predicate: FlowPredicate =
				params.kind === "file_exists"
					? { kind: "file_exists", path: params.target }
					: params.kind === "file_contains"
						? { kind: "file_contains", path: params.target, pattern: params.expected || "" }
						: params.kind === "register_equals"
							? { kind: "register_equals", key: params.target, value: params.expected || "" }
							: { kind: "command", command: params.target };

			const activeTools = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : ["read", "grep", "find", "ls"];
			const evalRes = await evaluatePredicate(predicate, {
				cwd: ctx?.cwd || process.cwd(),
				registers: fsm.getSnapshot().registers,
				activeTools,
				runCommand:
					typeof (ctx as { executeTool?: unknown })?.executeTool === "function"
						? async (cmd, timeoutMs) => {
								const outcome = await ctx.executeTool("bash", { command: cmd, timeout: timeoutMs }, { signal });
								const text = Array.isArray(outcome.content)
									? outcome.content.map((c) => ("text" in c ? c.text : "")).join("\n")
									: "";
								return { exitCode: outcome.isError ? 1 : 0, output: text };
							}
						: undefined,
			});

			if (evalRes.errorCode) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ ok: false, errorCode: evalRes.errorCode, reason: evalRes.errorReason }, null, 2),
						},
					],
					details: evalRes,
					isError: true,
				};
			}

			const chosenBranch = evalRes.matched ? params.then_prompt : params.else_prompt;
			const snap = fsm.getSnapshot();
			dispatchWakeupTurn(
				`[pi-flow branch: ${evalRes.matched ? "THEN" : "ELSE"} (${evalRes.output})]\n${chosenBranch}`,
				"flow_branch",
				snap.leaseEpoch,
			);
			return {
				content: [
					{
						type: "text",
						text: `Branch evaluated to ${evalRes.matched ? "THEN" : "ELSE"} (${evalRes.output}). Fuel remaining: ${snap.fuelRemaining}. Next: ${chosenBranch}`,
					},
				],
				details: { matched: evalRes.matched, output: evalRes.output, chosenBranch, snapshot: snap },
			};
		},
	});

	const startPollHelper = (params: {
		operation: "flow_loop" | "flow_monitor";
		intervalMs: number;
		maxIterations?: number;
		ttlMs?: number;
		predicate: FlowPredicate;
		wakeupPrompt: string;
		stopOnMatch: boolean;
		ctx?: ExtensionContext;
	}) => {
		const startRes = fsm.startPolling({
			operation: params.operation,
			intervalMs: params.intervalMs,
			maxIterations: params.maxIterations,
			ttlMs: params.ttlMs,
			goal: params.wakeupPrompt,
		});
		if (!startRes.ok) {
			return startRes;
		}
		const leaseEpoch = startRes.snapshot.leaseEpoch;
		persistSessionSnapshot(startRes.snapshot);

		pollingController.start({
			intervalMs: params.intervalMs,
			predicate: params.predicate,
			stopOnMatch: params.stopOnMatch,
			getContext: () => ({
				cwd: params.ctx?.cwd || currentCtx?.cwd || process.cwd(),
				registers: fsm.getSnapshot().registers,
				activeTools: typeof pi.getActiveTools === "function" ? pi.getActiveTools() : ["read", "grep", "find", "ls"],
			}),
			onTick: ({ matched, output }) => {
				const tick = fsm.consumeFuelTick();
				emitBusEvent("flow:progress", {
					operation: params.operation,
					detail: output,
					matched,
					fuelRemaining: tick.snapshot.fuelRemaining,
				});
				if (matched) {
					if (params.stopOnMatch) {
						executeHalt({
							outcome: "completed",
							summary: `Monitor condition matched: ${output}`,
						});
					}
					dispatchWakeupTurn(
						`[pi-flow ${params.operation} triggered (${output})]\n${params.wakeupPrompt}`,
						params.operation,
						leaseEpoch,
					);
				}
				return { continuePolling: tick.alive && !(params.stopOnMatch && matched) };
			},
			onError: (errorCode, reason) => {
				executeHalt({
					outcome: "aborted",
					summary: `${params.operation} aborted (${errorCode}): ${reason}`,
				});
			},
		});

		return startRes;
	};

	pi.registerTool({
		name: "flow_loop",
		label: "Flow Loop (DEC R_FUEL + B.GT)",
		description:
			"Schedule a bounded recurring prompt loop until flow_halt is called or fuel/TTL expires (transitions IDLE -> POLLING).",
		promptSnippet: "Start a bounded recurring prompt loop until flow_halt or fuel exhaustion",
		exposure: "model-only",
		executionMode: "sequential",
		parameters: Type.Object({
			prompt: Type.String({ description: "Prompt to execute on each loop iteration" }),
			interval_ms: Type.Optional(Type.Number({ description: "Interval between ticks in ms (default 15000)" })),
			max_iterations: Type.Optional(
				Type.Number({ description: "Maximum iterations (1..50, default 10)", minimum: 1, maximum: 50 }),
			),
			ttl_ms: Type.Optional(Type.Number({ description: "Maximum wall-clock duration in ms (default 900000)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			currentCtx = ctx;
			const res = startPollHelper({
				operation: "flow_loop",
				intervalMs: params.interval_ms ?? 15_000,
				maxIterations: params.max_iterations,
				ttlMs: params.ttl_ms,
				predicate: { kind: "always" },
				wakeupPrompt: params.prompt,
				stopOnMatch: false,
				ctx,
			});
			if (!res.ok) {
				return {
					content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
					details: res,
					isError: true,
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `Started flow_loop (interval=${res.snapshot.retryAfterMs}ms, fuel=${res.snapshot.fuelRemaining}): ${params.prompt}`,
					},
				],
				details: res.snapshot,
			};
		},
	});

	pi.registerTool({
		name: "flow_monitor",
		label: "Flow Monitor / Watch (WFE)",
		description:
			"Poll a condition (file_exists, file_contains, register_equals, or command exit 0) in the background without burning LLM turns until the condition trips or fuel expires.",
		promptSnippet: "Wait for a background file, register, or command condition before waking the agent",
		exposure: "model-only",
		executionMode: "sequential",
		parameters: Type.Object({
			kind: Type.Union([
				Type.Literal("file_exists"),
				Type.Literal("file_contains"),
				Type.Literal("register_equals"),
				Type.Literal("command"),
			]),
			target: Type.String({ description: "File path, register key, or command string to monitor" }),
			expected: Type.Optional(Type.String({ description: "Pattern (for file_contains) or value (for register_equals)" })),
			then_prompt: Type.String({ description: "Prompt to trigger once the condition matches" }),
			interval_ms: Type.Optional(Type.Number({ description: "Poll interval in ms (default 5000)" })),
			max_iterations: Type.Optional(
				Type.Number({ description: "Maximum poll checks before timeout (1..50, default 10)", minimum: 1, maximum: 50 }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			currentCtx = ctx;
			const predicate: FlowPredicate =
				params.kind === "file_exists"
					? { kind: "file_exists", path: params.target }
					: params.kind === "file_contains"
						? { kind: "file_contains", path: params.target, pattern: params.expected || "" }
						: params.kind === "register_equals"
							? { kind: "register_equals", key: params.target, value: params.expected || "" }
							: { kind: "command", command: params.target };

			const activeTools = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : ["read", "grep", "find", "ls"];
			if (predicate.kind === "command") {
				const precheck = await evaluatePredicate(predicate, {
					cwd: ctx?.cwd || process.cwd(),
					registers: fsm.getSnapshot().registers,
					activeTools,
					runCommand: async () => ({ exitCode: 1, output: "precheck" }),
				});
				if (precheck.errorCode) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ ok: false, errorCode: precheck.errorCode, reason: precheck.errorReason }, null, 2),
							},
						],
						details: precheck,
						isError: true,
					};
				}
			}

			const res = startPollHelper({
				operation: "flow_monitor",
				intervalMs: params.interval_ms ?? 5000,
				maxIterations: params.max_iterations,
				predicate,
				wakeupPrompt: params.then_prompt,
				stopOnMatch: true,
				ctx,
			});
			if (!res.ok) {
				return {
					content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
					details: res,
					isError: true,
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `Started flow_monitor (${params.kind}: ${params.target}, interval=${res.snapshot.retryAfterMs}ms, checks=${res.snapshot.fuelRemaining}).`,
					},
				],
				details: res.snapshot,
			};
		},
	});

	pi.registerTool({
		name: "flow_mapreduce",
		label: "Flow MapReduce (BL single-child)",
		description:
			"Map a task sequentially across up to 16 items using at most 1 isolated read-only headless child at a time (PI_FLOW_DEPTH=1) and return the reduced results.",
		promptSnippet: "Run sequential single-child read-only MapReduce over a list of items (depth=1)",
		exposure: "model-only",
		executionMode: "sequential",
		parameters: Type.Object({
			items: Type.Array(Type.String(), {
				description: `Items to process sequentially (max ${MAX_MAPREDUCE_ITEMS})`,
			}),
			task: Type.String({ description: "Read-only analysis task to execute for each item" }),
			item_timeout_ms: Type.Optional(
				Type.Number({ description: "Timeout per item in ms (default 120000)" }),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			currentCtx = ctx;
			const itemTimeoutMs = params.item_timeout_ms ?? 120_000;
			const lockRes = fsm.startSpawning({
				itemCount: params.items.length,
				itemTimeoutMs,
			});
			if (!lockRes.ok) {
				return {
					content: [{ type: "text", text: JSON.stringify(lockRes, null, 2) }],
					details: lockRes,
					isError: true,
				};
			}

			const abortCtrl = new AbortController();
			mapReduceAbortController = abortCtrl;
			const forwardAbort = () => abortCtrl.abort();
			signal?.addEventListener("abort", forwardAbort, { once: true });

			try {
				const mrRes = await runMapReduceSequential({
					items: params.items,
					task: params.task,
					cwd: ctx?.cwd || process.cwd(),
					env,
					itemTimeoutMs,
					signal: abortCtrl.signal,
					onProgress: (prog) => {
						fsm.consumeFuelTick();
						emitBusEvent("flow:progress", {
							operation: "flow_mapreduce",
							...prog,
						});
					},
				});

				fsm.finishSpawning();
				persistSessionSnapshot(fsm.getSnapshot());

				if (!mrRes.ok) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ ok: false, errorCode: mrRes.errorCode, reason: mrRes.reason }, null, 2),
							},
						],
						details: mrRes,
						isError: true,
					};
				}

				const summaryLines = [
					`## MapReduce Completed (${mrRes.results.length} item${mrRes.results.length === 1 ? "" : "s"}, concurrency=1, depth=1)`,
					...mrRes.results.map(
						(r) =>
							`### [${r.index + 1}/${mrRes.results.length}] \`${r.item}\` (exit=${r.exitCode}, ${r.durationMs}ms)\n${r.output}`,
					),
				];
				return {
					content: [{ type: "text", text: summaryLines.join("\n\n") }],
					details: mrRes,
				};
			} finally {
				signal?.removeEventListener("abort", forwardAbort);
				if (mapReduceAbortController === abortCtrl) {
					mapReduceAbortController = null;
				}
			}
		},
	});

	pi.registerTool({
		name: "flow_halt",
		label: "Flow Halt (HLT / RET)",
		description:
			"Immediately cancel all active flow timers and child processes, record the completion/halt summary, block remaining tools in the current batch, and reset the FSM to IDLE.",
		promptSnippet: "Cancel active flow timers/children, record terminal summary, and return to IDLE",
		exposure: "model-only",
		executionMode: "sequential",
		parameters: Type.Object({
			summary: Type.String({ description: "Summary of what was accomplished or why the flow halted" }),
			outcome: Type.Optional(
				Type.Union([Type.Literal("completed"), Type.Literal("halted"), Type.Literal("aborted")]),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			currentCtx = ctx;
			const snap = executeHalt({
				outcome: params.outcome ?? "completed",
				summary: params.summary,
				inToolTurn: true,
				ctx,
			});
			return {
				content: [
					{
						type: "text",
						text: `Flow halted (${snap.lastHalt?.outcome}): ${snap.lastHalt?.summary}`,
					},
				],
				details: snap,
			};
		},
	});

	pi.registerTool({
		name: "flow_status",
		label: "Flow Status (MRS)",
		description:
			"Inspect the current pi-flow FSM state, active operation, fuel remaining, registers, and ancestor harness lineage.",
		promptSnippet: "Inspect current pi-flow FSM state, fuel budget, and ancestor process lineage",
		exposure: "model-only",
		executionMode: "sequential",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			currentCtx = ctx;
			const snap = fsm.getSnapshot();
			const lineage = getProcessLineage({ env });
			return {
				content: [{ type: "text", text: formatFlowStatusMarkdown(snap, env) }],
				details: { snapshot: snap, lineage },
			};
		},
	});

	// =========================================================================
	// Slash Commands (/goal, /branch, /loop, /monitor, /watch, /mapreduce, /halt, /flow)
	// =========================================================================

	pi.registerCommand("goal", {
		description: "Set an active workflow goal and fuel budget: /goal <objective>",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const goal = args.trim();
			if (!goal) {
				ctx.ui?.notify?.("Usage: /goal <objective>", "warning");
				return;
			}
			const res = fsm.startGoal({ goal, maxIterations: DEFAULT_FUEL, ttlMs: DEFAULT_TTL_MS });
			if (!res.ok) {
				ctx.ui?.notify?.(res.reason, "warning");
				return;
			}
			persistSessionSnapshot(res.snapshot);
			dispatchWakeupTurn(
				`[pi-flow goal set (fuel=${res.snapshot.fuelRemaining})]\nObjective: ${goal}\nCall flow_halt when complete.`,
				"flow_goal",
				res.snapshot.leaseEpoch,
			);
		},
	});

	pi.registerCommand("branch", {
		description: "Conditional branch: /branch <cond> ? <then-prompt> : <else-prompt>",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const match = args.match(/^(.+?)\s*\?\s*(.+?)\s*:\s*(.+)$/);
			if (!match) {
				ctx.ui?.notify?.("Usage: /branch <cond> ? <then-prompt> : <else-prompt>", "warning");
				return;
			}
			const stepRes = fsm.recordBranchStep();
			if (!stepRes.ok) {
				ctx.ui?.notify?.(stepRes.reason, "warning");
				return;
			}
			const predicate = parseShorthandPredicate(match[1]);
			const evalRes = await evaluatePredicate(predicate, {
				cwd: ctx?.cwd || process.cwd(),
				registers: fsm.getSnapshot().registers,
				activeTools: typeof pi.getActiveTools === "function" ? pi.getActiveTools() : ["read", "grep", "find", "ls"],
			});
			if (evalRes.errorCode) {
				ctx.ui?.notify?.(`Branch error (${evalRes.errorCode}): ${evalRes.errorReason}`, "error");
				return;
			}
			const chosen = evalRes.matched ? match[2].trim() : match[3].trim();
			dispatchWakeupTurn(
				`[pi-flow branch: ${evalRes.matched ? "THEN" : "ELSE"} (${evalRes.output})]\n${chosen}`,
				"flow_branch",
				fsm.getSnapshot().leaseEpoch,
			);
		},
	});

	pi.registerCommand("loop", {
		description: "Start a bounded recurring prompt loop: /loop [interval] <prompt>",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui?.notify?.("Usage: /loop [interval, e.g. 15s] <prompt>", "warning");
				return;
			}
			const parts = trimmed.split(/\s+/);
			const firstIsInterval = /^\d+(?:\.\d+)?(?:ms|s|sec|m|min|h)$/.test(parts[0]);
			const intervalMs = firstIsInterval ? parseIntervalMs(parts[0]) : 15_000;
			const promptText = firstIsInterval ? parts.slice(1).join(" ").trim() : trimmed;
			if (!promptText) {
				ctx.ui?.notify?.("Usage: /loop [interval] <prompt>", "warning");
				return;
			}
			const res = startPollHelper({
				operation: "flow_loop",
				intervalMs,
				predicate: { kind: "always" },
				wakeupPrompt: promptText,
				stopOnMatch: false,
				ctx,
			});
			if (!res.ok) {
				ctx.ui?.notify?.(res.reason, "warning");
				return;
			}
			ctx.ui?.notify?.(`Loop started (every ${intervalMs}ms, fuel=${res.snapshot.fuelRemaining}). Use /halt to stop.`, "info");
		},
	});

	const handleMonitorOrWatchCommand = async (args: string, ctx: ExtensionContext) => {
		currentCtx = ctx;
		const trimmed = args.trim();
		if (!trimmed) {
			ctx.ui?.notify?.("Usage: /monitor <file:path | reg:k=v | cmd> [-- <then-prompt>]", "warning");
			return;
		}
		const dashIdx = trimmed.indexOf(" -- ");
		const checkExpr = dashIdx !== -1 ? trimmed.slice(0, dashIdx).trim() : trimmed;
		const thenPrompt =
			dashIdx !== -1 ? trimmed.slice(dashIdx + 4).trim() : `Monitor condition matched: ${checkExpr}. Inspect and proceed.`;
		const predicate = parseShorthandPredicate(checkExpr);

		const res = startPollHelper({
			operation: "flow_monitor",
			intervalMs: 5000,
			predicate,
			wakeupPrompt: thenPrompt,
			stopOnMatch: true,
			ctx,
		});
		if (!res.ok) {
			ctx.ui?.notify?.(res.reason, "warning");
			return;
		}
		ctx.ui?.notify?.(`Monitor active (${checkExpr}, fuel=${res.snapshot.fuelRemaining}). Use /halt to cancel.`, "info");
	};

	pi.registerCommand("monitor", {
		description: "Monitor a file, register, or command in the background: /monitor <check> [-- <then-prompt>]",
		handler: handleMonitorOrWatchCommand,
	});

	pi.registerCommand("watch", {
		description: "Alias for /monitor (Claude Code convenience): /watch <check> [-- <then-prompt>]",
		handler: handleMonitorOrWatchCommand,
	});

	pi.registerCommand("mapreduce", {
		description: "Run single-child read-only MapReduce over comma/space-separated items: /mapreduce <item1,item2> -- <task>",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const dashIdx = args.indexOf("--");
			if (dashIdx === -1) {
				ctx.ui?.notify?.("Usage: /mapreduce <item1,item2,...> -- <task>", "warning");
				return;
			}
			const rawItems = args
				.slice(0, dashIdx)
				.split(/[,\s]+/)
				.map((s) => s.trim())
				.filter(Boolean);
			const task = args.slice(dashIdx + 2).trim();
			if (rawItems.length === 0 || !task) {
				ctx.ui?.notify?.("Usage: /mapreduce <item1,item2,...> -- <task>", "warning");
				return;
			}
			dispatchWakeupTurn(
				`Call flow_mapreduce with items=${JSON.stringify(rawItems)} and task=${JSON.stringify(task)}, then synthesize the results.`,
				"flow_mapreduce",
				fsm.getSnapshot().leaseEpoch,
			);
		},
	});

	pi.registerCommand("halt", {
		description: "Immediately cancel all active flow timers/children and reset to IDLE: /halt [--exit] [summary]",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const trimmed = args.trim();
			const exitProcess = trimmed === "--exit" || trimmed.startsWith("--exit ");
			const summary = exitProcess ? trimmed.replace(/^--exit\s*/, "").trim() || "Halted and exiting." : trimmed || "Halted by user.";
			const snap = executeHalt({
				outcome: "halted",
				summary,
				exitProcess,
				ctx,
			});
			ctx.ui?.notify?.(`Flow halted: ${snap.lastHalt?.summary}`, "info");
		},
	});

	pi.registerCommand("flow", {
		description: "Inspect or reset pi-flow FSM state: /flow [status|reset|json]",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const sub = args.trim().toLowerCase();
			if (sub === "reset") {
				const sessionId = ctx?.sessionManager?.getSessionFile?.() || "default-session";
				pollingController.stop();
				const snap = fsm.resetForNewSession(sessionId);
				ctx.ui?.notify?.(`Reset pi-flow state to ${snap.state}.`, "info");
				return;
			}
			const snap = fsm.getSnapshot();
			const content =
				sub === "json"
					? `\`\`\`json\n${JSON.stringify({ snapshot: snap, lineage: getProcessLineage({ env }) }, null, 2)}\n\`\`\``
					: formatFlowStatusMarkdown(snap, env);
			pi.sendMessage(
				{
					customType: "pi-flow:status",
					content,
					display: true,
					details: snap,
				},
				{ triggerTurn: false },
			);
		},
	});
}
