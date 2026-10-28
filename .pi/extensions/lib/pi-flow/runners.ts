/**
 * Pi Flow-Control Predicate Evaluator, Unified Polling Runner (`/loop`, `/monitor`, `/watch`),
 * and Single-Child MapReduce Runner (`.pi/extensions/lib/pi-flow/runners.ts`)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProcessLineage, killProcessTreeCrossPlatform } from "./process-tree.ts";

export const ALLOWED_MAPREDUCE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);
export const DEFAULT_MAPREDUCE_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
export const MAX_MAPREDUCE_ITEMS = 16;
export const MAX_MAPREDUCE_ITEM_BYTES = 32 * 1024;
export const MAX_FILE_CONTAINS_BYTES = 1024 * 1024;

export type FlowPredicate =
	| { kind: "always" }
	| { kind: "file_exists"; path: string }
	| { kind: "file_contains"; path: string; pattern: string }
	| { kind: "register_equals"; key: string; value: string }
	| { kind: "command"; command: string };

/**
 * Normalize a shell command string before checking for destructive git subcommands:
 * joins backslash line continuations, strips quotes around tokens, and removes global
 * git flags (`-C <dir>`, `-c <k=v>`, `--git-dir=...`, `--work-tree=...`).
 */
export function normalizeGitShellCommand(rawCommand: string): string {
	return rawCommand
		.replace(/\\\r?\n/g, " ")
		.replace(/["']/g, "")
		.replace(
			/\bgit\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace)(?:=\S+|\s+\S+)\s+|--(?:no-pager|bare|literal-pathspecs)\s+)*/gi,
			"git ",
		);
}

export const DESTRUCTIVE_GIT_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
	{
		pattern: /\bgit\s+reset\s+[^\n;|&]*--hard\b/i,
		reason: "`git reset --hard` is strictly prohibited (#1 rule). Use `git status` and non-destructive git operations.",
	},
	{
		pattern: /\bgit\s+clean\s+[^\n;|&]*-(?:[a-zA-Z]*f|--force)/i,
		reason: "`git clean -f` discards untracked files permanently and is blocked by safety rules.",
	},
	{
		pattern: /\bgit\s+checkout\s+(?:--\s+|\.\s*$)/i,
		reason: "`git checkout -- <path>` discards uncommitted work and is blocked by safety rules.",
	},
	{
		pattern: /\bgit\s+switch\s+[^\n;|&]*(?:-f\b|--force\b|--discard-changes\b)/i,
		reason: "`git switch --force / --discard-changes` discards uncommitted work and is blocked by safety rules.",
	},
	{
		pattern: /\bgit\s+stash\s+(?:drop|clear)\b/i,
		reason: "`git stash drop/clear` permanently destroys stashed work and is blocked by safety rules.",
	},
	{
		pattern: /\bgit\s+restore\s+(?![^\n;|&]*--staged\b)(?![^\n;|&]*-S\b)\S+/i,
		reason: "`git restore` without `--staged` overwrites working tree changes and is blocked by safety rules.",
	},
];

export function checkDestructiveGitCommand(command: string): { blocked: boolean; reason?: string } {
	const normalized = normalizeGitShellCommand(command);
	for (const rule of DESTRUCTIVE_GIT_PATTERNS) {
		if (rule.pattern.test(command) || rule.pattern.test(normalized)) {
			return { blocked: true, reason: rule.reason };
		}
	}
	return { blocked: false };
}

const READONLY_SAFE_COMMAND_PREFIXES: readonly RegExp[] = [
	/^\s*(?:ls|stat|file|wc|head|tail|cat|grep|rg|find|pwd|whoami|date|uname|ps|which|type)\b/,
	/^\s*git\s+(?:status|diff|log|show|branch\s+(?:--show-current|-a|-r|--list)|rev-parse)\b/,
	/^\s*test\s+-[efdrsz]\s+/,
];

/**
 * In read-only / Plan Mode (where `write` and `edit` tools are disabled), only allow simple
 * read-only inspection commands without shell chaining, redirection, or subshell expansion.
 */
export function isReadOnlySafeShellCommand(command: string): boolean {
	const trimmed = String(command || "").trim();
	if (!trimmed) return false;
	// Block shell chaining, pipes, redirections, command substitution, and backticks in read-only mode
	if (/[;&|`$><\r\n]/.test(trimmed)) {
		return false;
	}
	return READONLY_SAFE_COMMAND_PREFIXES.some((re) => re.test(trimmed));
}

/**
 * Parse a slash-command shorthand condition into a typed `FlowPredicate`:
 * - `file:<path>` -> `file_exists`
 * - `contains:<path>:<pattern>` -> `file_contains`
 * - `reg:<key>=<value>` -> `register_equals`
 * - otherwise -> `command`
 */
export function parseShorthandPredicate(expr: string): FlowPredicate {
	const trimmed = String(expr || "").trim();
	if (!trimmed || trimmed === "true" || trimmed === "always") {
		return { kind: "always" };
	}
	if (trimmed.startsWith("file:")) {
		return { kind: "file_exists", path: trimmed.slice("file:".length).trim() };
	}
	if (trimmed.startsWith("contains:")) {
		const rest = trimmed.slice("contains:".length);
		const colonIdx = rest.indexOf(":");
		if (colonIdx > 0) {
			return {
				kind: "file_contains",
				path: rest.slice(0, colonIdx).trim(),
				pattern: rest.slice(colonIdx + 1),
			};
		}
	}
	if (trimmed.startsWith("reg:")) {
		const rest = trimmed.slice("reg:".length);
		const eqIdx = rest.indexOf("=");
		if (eqIdx > 0) {
			return {
				kind: "register_equals",
				key: rest.slice(0, eqIdx).trim(),
				value: rest.slice(eqIdx + 1).trim(),
			};
		}
	}
	return { kind: "command", command: trimmed };
}

/**
 * O(1) UTF-8 byte truncation without quadratic string slicing.
 */
export function truncateUtf8Bytes(
	text: string,
	maxBytes: number = MAX_MAPREDUCE_ITEM_BYTES,
): { text: string; truncated: boolean } {
	const buf = Buffer.from(String(text || ""), "utf8");
	if (buf.byteLength <= maxBytes) {
		return { text: String(text || ""), truncated: false };
	}
	const sliced = buf.subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
	const omitted = buf.byteLength - Buffer.byteLength(sliced, "utf8");
	return {
		text: `${sliced}\n\n[pi-flow: truncated ${omitted} bytes]`,
		truncated: true,
	};
}

/**
 * Run a shell command with a timeout and cross-platform process-tree cleanup on timeout.
 */
export async function runBoundedShellCommand(
	command: string,
	options: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<{ exitCode: number; output: string }> {
	const timeoutMs = Math.max(500, Math.min(30_000, options.timeoutMs ?? 10_000));
	const isWin = process.platform === "win32";
	const shell = isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
	const shellArgs = isWin ? ["/d", "/s", "/c", command] : ["-c", command];

	return new Promise((resolve) => {
		const child = spawn(shell, shellArgs, {
			cwd: options.cwd,
			detached: !isWin,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let output = "";
		let settled = false;

		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (options.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}
			resolve({ exitCode, output: truncateUtf8Bytes(output.trim(), 4096).text });
		};

		const onAbort = () => {
			if (child.pid) {
				killProcessTreeCrossPlatform(child.pid, "SIGKILL");
			}
			finish(130);
		};

		if (options.signal) {
			if (options.signal.aborted) {
				onAbort();
				return;
			}
			options.signal.addEventListener("abort", onAbort, { once: true });
		}

		const timer = setTimeout(() => {
			if (child.pid) {
				killProcessTreeCrossPlatform(child.pid, "SIGKILL");
			}
			finish(124);
		}, timeoutMs);
		timer.unref?.();

		const appendChunk = (chunk: Buffer) => {
			if (output.length < 8192) {
				output += chunk.toString("utf8");
			}
		};

		child.stdout?.on("data", appendChunk);
		child.stderr?.on("data", appendChunk);
		child.once("error", (err) => {
			output += `\n${String(err)}`;
			finish(1);
		});
		child.once("close", (code) => {
			finish(code ?? 1);
		});
	});
}

/**
 * Evaluate a deterministic `FlowPredicate` for `/branch` or `/monitor` (`/watch`).
 */
export async function evaluatePredicate(
	predicate: FlowPredicate,
	ctx: {
		cwd: string;
		registers: Readonly<Record<string, string>>;
		activeTools: readonly string[];
		flowDepth?: number;
		statCache?: Map<string, { mtimeMs: number; size: number; matched: boolean }>;
		runCommand?: (cmd: string, timeoutMs: number) => Promise<{ exitCode: number; output: string }>;
	},
): Promise<{
	matched: boolean;
	output: string;
	errorCode?: "ERR_BASH_DISABLED" | "ERR_DESTRUCTIVE_COMMAND" | "ERR_UNSAFE_COMMAND_IN_READONLY";
	errorReason?: string;
}> {
	switch (predicate.kind) {
		case "always":
			return { matched: true, output: "always" };

		case "register_equals": {
			const actual = ctx.registers[predicate.key] ?? "";
			const matched = actual === predicate.value;
			return {
				matched,
				output: `register[${predicate.key}]=${JSON.stringify(actual)} (expected ${JSON.stringify(predicate.value)})`,
			};
		}

		case "file_exists": {
			const resolved = path.resolve(ctx.cwd, predicate.path);
			const exists = fs.existsSync(resolved);
			return {
				matched: exists,
				output: `${resolved}: ${exists ? "exists" : "missing"}`,
			};
		}

		case "file_contains": {
			const resolved = path.resolve(ctx.cwd, predicate.path);
			if (!fs.existsSync(resolved)) {
				return { matched: false, output: `${resolved}: missing` };
			}
			try {
				const lstat = fs.lstatSync(resolved);
				if (!lstat.isFile()) {
					return { matched: false, output: `${resolved}: not a regular file` };
				}
				const cacheKey = `${resolved}::${predicate.pattern}`;
				const cached = ctx.statCache?.get(cacheKey);
				if (cached && cached.mtimeMs === lstat.mtimeMs && cached.size === lstat.size) {
					return { matched: cached.matched, output: `${resolved}: cached (${cached.matched})` };
				}
				const bytesToRead = Math.min(lstat.size, MAX_FILE_CONTAINS_BYTES);
				const fd = fs.openSync(resolved, "r");
				let content = "";
				try {
					const buf = Buffer.alloc(bytesToRead);
					const readBytes = fs.readSync(fd, buf, 0, bytesToRead, 0);
					content = buf.subarray(0, readBytes).toString("utf8");
				} finally {
					fs.closeSync(fd);
				}
				const matched = content.includes(predicate.pattern);
				ctx.statCache?.set(cacheKey, { mtimeMs: lstat.mtimeMs, size: lstat.size, matched });
				return {
					matched,
					output: matched
						? `Found pattern ${JSON.stringify(predicate.pattern)} in ${resolved}`
						: `Pattern ${JSON.stringify(predicate.pattern)} not found in ${resolved}`,
				};
			} catch (err) {
				return { matched: false, output: `Error reading ${resolved}: ${String(err)}` };
			}
		}

		case "command": {
			const depth = ctx.flowDepth ?? Number.parseInt(String(process.env.PI_FLOW_DEPTH || "0"), 10);
			if (!ctx.activeTools.includes("bash") || depth > 0) {
				return {
					matched: false,
					output: "",
					errorCode: "ERR_BASH_DISABLED",
					errorReason:
						"Cannot evaluate 'command' predicate when the 'bash' tool is disabled or inside a depth >= 1 child session.",
				};
			}
			const gitCheck = checkDestructiveGitCommand(predicate.command);
			if (gitCheck.blocked) {
				return {
					matched: false,
					output: "",
					errorCode: "ERR_DESTRUCTIVE_COMMAND",
					errorReason: gitCheck.reason,
				};
			}
			const isReadOnlyMode = !ctx.activeTools.includes("write") && !ctx.activeTools.includes("edit");
			if (isReadOnlyMode && !isReadOnlySafeShellCommand(predicate.command)) {
				return {
					matched: false,
					output: "",
					errorCode: "ERR_UNSAFE_COMMAND_IN_READONLY",
					errorReason:
						"Session has write/edit tools disabled (read-only / Plan Mode); command predicates are restricted to simple read-only commands without shell chaining or redirection.",
				};
			}
			const runner =
				ctx.runCommand ?? ((cmd: string, timeoutMs: number) => runBoundedShellCommand(cmd, { cwd: ctx.cwd, timeoutMs }));
			const res = await runner(predicate.command, 10_000);
			return {
				matched: res.exitCode === 0,
				output: res.output || `exitCode=${res.exitCode}`,
			};
		}
	}
}

/**
 * Resolve the `pi` CLI command to spawn for a headless MapReduce child.
 */
export function resolvePiBinaryForChild(cwd: string = process.cwd()): { command: string; prefixArgs: string[] } {
	if (process.env.WOODCHIPPER_PI_BIN && fs.existsSync(process.env.WOODCHIPPER_PI_BIN)) {
		return { command: process.env.WOODCHIPPER_PI_BIN, prefixArgs: [] };
	}
	const auditedCli = path.join(cwd, ".woodchipper", "pi", "packages", "coding-agent", "dist", "bundle", "cli.js");
	if (fs.existsSync(auditedCli)) {
		return { command: process.execPath, prefixArgs: [auditedCli] };
	}
	const vendorCli = path.join(cwd, "vendor", "pi", "packages", "coding-agent", "dist", "bundle", "cli.js");
	if (fs.existsSync(vendorCli)) {
		return { command: process.execPath, prefixArgs: [vendorCli] };
	}
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript) && /cli\.js$/.test(currentScript)) {
		return { command: process.execPath, prefixArgs: [currentScript] };
	}
	const managedPi = path.join(os.homedir(), ".pi", "agent", "bin", process.platform === "win32" ? "pi.exe" : "pi");
	if (fs.existsSync(managedPi)) {
		return { command: managedPi, prefixArgs: [] };
	}
	return { command: "pi", prefixArgs: [] };
}

/**
 * Construct safe CLI arguments for a single headless MapReduce child:
 * - Intersects `requestedTools` against `ALLOWED_MAPREDUCE_TOOLS` (`read`, `grep`, `find`, `ls`)
 * - Adds `--mode json -p --no-session --no-mcp`
 * - Places `--` before the prompt argument AND prefixes the prompt with `"[pi-flow mapreduce item i/N]"`
 *   so `vendor/pi`'s `parseArgs` can never treat an untrusted item starting with `-` or `@` as a flag or `@file`.
 */
export function buildMapReduceChildArgs(params: {
	item: string;
	task: string;
	index: number;
	total: number;
	requestedTools?: readonly string[];
	model?: string;
}): { args: string[]; sanitizedTools: string[]; promptText: string } {
	const rawTools =
		params.requestedTools && params.requestedTools.length > 0 ? params.requestedTools : DEFAULT_MAPREDUCE_TOOLS;
	const filtered = rawTools.filter((t) => ALLOWED_MAPREDUCE_TOOLS.has(t));
	const sanitizedTools = filtered.length > 0 ? [...new Set(filtered)] : [...DEFAULT_MAPREDUCE_TOOLS];

	const promptText = [
		`[pi-flow mapreduce item ${params.index + 1}/${params.total}]`,
		"You are running inside an isolated read-only pi-flow MapReduce child worker (depth=1).",
		`Task: ${params.task.trim()}`,
		`Target Item: ${params.item}`,
		"Provide a concise, high-signal result for this item only.",
	].join("\n");

	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-mcp",
		"--tools",
		sanitizedTools.join(","),
	];
	if (params.model) {
		args.push("--model", params.model);
	}
	args.push("--", promptText);

	return { args, sanitizedTools, promptText };
}

/**
 * Default child spawner for `runMapReduceSequential` using `pi --mode json -p --no-session --no-mcp`.
 */
async function defaultSpawnMapReduceChild(
	cwd: string,
	env: NodeJS.ProcessEnv,
	built: ReturnType<typeof buildMapReduceChildArgs>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ exitCode: number; output: string; stderr: string; durationMs: number }> {
	const startMs = Date.now();
	const piBin = resolvePiBinaryForChild(cwd);
	const isWin = process.platform === "win32";

	return new Promise((resolve) => {
		const child = spawn(piBin.command, [...piBin.prefixArgs, ...built.args], {
			cwd,
			detached: !isWin,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...env,
				PI_FLOW_DEPTH: "1",
				PI_FLOW_PARENT_PID: String(process.pid),
				WOODCHIPPER_NO_PEER: "1",
			},
		});

		let stdoutLineBuf = "";
		let latestAssistantText = "";
		let stderrTail = "";
		let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
		let settled = false;

		const cleanupAndResolve = (exitCode: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			if (sigkillTimer) {
				clearTimeout(sigkillTimer);
				sigkillTimer = null;
			}
			if (signal) {
				signal.removeEventListener("abort", killChild);
			}
			const finalOut = latestAssistantText.trim() || stderrTail.trim() || `(exit code ${exitCode})`;
			resolve({
				exitCode,
				output: truncateUtf8Bytes(finalOut, MAX_MAPREDUCE_ITEM_BYTES).text,
				stderr: stderrTail.trim(),
				durationMs: Date.now() - startMs,
			});
		};

		const killChild = () => {
			if (!child.pid) return;
			killProcessTreeCrossPlatform(child.pid, isWin ? "SIGKILL" : "SIGTERM");
			if (!isWin) {
				sigkillTimer = setTimeout(() => {
					if (child.pid) {
						killProcessTreeCrossPlatform(child.pid, "SIGKILL");
					}
				}, 2000);
				sigkillTimer.unref?.();
			}
		};

		if (signal) {
			if (signal.aborted) {
				killChild();
				cleanupAndResolve(130);
				return;
			}
			signal.addEventListener("abort", killChild, { once: true });
		}

		const timeoutTimer = setTimeout(() => {
			killChild();
			cleanupAndResolve(124);
		}, timeoutMs);
		timeoutTimer.unref?.();

		const processJsonLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			try {
				const evt = JSON.parse(trimmed) as {
					type?: string;
					message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
				};
				if ((evt.type === "message_end" || evt.type === "turn_end") && evt.message?.role === "assistant") {
					const parts = Array.isArray(evt.message.content) ? evt.message.content : [];
					for (const part of parts) {
						if (part.type === "text" && part.text) {
							latestAssistantText = truncateUtf8Bytes(part.text, MAX_MAPREDUCE_ITEM_BYTES).text;
						}
					}
				}
			} catch {
				// Non-JSON line fallback
				if (latestAssistantText.length < MAX_MAPREDUCE_ITEM_BYTES) {
					latestAssistantText += `${trimmed}\n`;
				}
			}
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutLineBuf += chunk.toString("utf8");
			let nl = stdoutLineBuf.indexOf("\n");
			while (nl !== -1) {
				const line = stdoutLineBuf.slice(0, nl);
				stdoutLineBuf = stdoutLineBuf.slice(nl + 1);
				processJsonLine(line);
				nl = stdoutLineBuf.indexOf("\n");
			}
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			stderrTail += chunk.toString("utf8");
			if (stderrTail.length > 8192) {
				stderrTail = stderrTail.slice(-8192);
			}
		});

		child.once("error", (err) => {
			stderrTail += `\n${String(err)}`;
			cleanupAndResolve(1);
		});

		child.once("close", (code) => {
			if (stdoutLineBuf.trim()) {
				processJsonLine(stdoutLineBuf);
			}
			cleanupAndResolve(code ?? 0);
		});
	});
}

/**
 * Execute MapReduce sequentially across at most `MAX_CONCURRENCY = 1` headless child at a time,
 * enforcing `PI_FLOW_DEPTH === 0` (`ERR_MAX_DEPTH_EXCEEDED`).
 */
export async function runMapReduceSequential(params: {
	items: readonly string[];
	task: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	requestedTools?: readonly string[];
	model?: string;
	itemTimeoutMs?: number;
	signal?: AbortSignal;
	spawnChild?: (
		item: string,
		index: number,
		built: ReturnType<typeof buildMapReduceChildArgs>,
		signal: AbortSignal,
	) => Promise<{ exitCode: number; output: string; stderr: string; durationMs: number }>;
	onProgress?: (progress: { index: number; total: number; item: string; exitCode: number; durationMs: number }) => void;
}): Promise<{
	ok: boolean;
	errorCode?: "ERR_MAX_DEPTH_EXCEEDED" | "ERR_EMPTY_ITEMS";
	reason?: string;
	results: Array<{
		index: number;
		item: string;
		exitCode: number;
		output: string;
		truncated: boolean;
		durationMs: number;
	}>;
}> {
	const env = params.env ?? process.env;
	const lineage = getProcessLineage({ env });
	if (lineage.flowDepth >= 1) {
		return {
			ok: false,
			errorCode: "ERR_MAX_DEPTH_EXCEEDED",
			reason: "flow_mapreduce cannot spawn nested children at PI_FLOW_DEPTH >= 1; execute the task directly in this worker.",
			results: [],
		};
	}

	const boundedItems = params.items.map((x) => String(x).trim()).filter(Boolean).slice(0, MAX_MAPREDUCE_ITEMS);
	if (boundedItems.length === 0) {
		return {
			ok: false,
			errorCode: "ERR_EMPTY_ITEMS",
			reason: "flow_mapreduce requires at least 1 non-empty item.",
			results: [],
		};
	}

	const itemTimeoutMs = Math.max(2000, Math.min(300_000, params.itemTimeoutMs ?? 120_000));
	const results: Array<{
		index: number;
		item: string;
		exitCode: number;
		output: string;
		truncated: boolean;
		durationMs: number;
	}> = [];

	for (let i = 0; i < boundedItems.length; i++) {
		if (params.signal?.aborted) {
			break;
		}
		const item = boundedItems[i];
		const built = buildMapReduceChildArgs({
			item,
			task: params.task,
			index: i,
			total: boundedItems.length,
			requestedTools: params.requestedTools,
			model: params.model,
		});

		const itemAbort = new AbortController();
		const forwardAbort = () => itemAbort.abort();
		params.signal?.addEventListener("abort", forwardAbort, { once: true });

		let childRes: { exitCode: number; output: string; stderr: string; durationMs: number };
		try {
			childRes = params.spawnChild
				? await params.spawnChild(item, i, built, itemAbort.signal)
				: await defaultSpawnMapReduceChild(params.cwd, env, built, itemTimeoutMs, itemAbort.signal);
		} finally {
			params.signal?.removeEventListener("abort", forwardAbort);
		}

		const capped = truncateUtf8Bytes(childRes.output, MAX_MAPREDUCE_ITEM_BYTES);
		results.push({
			index: i,
			item,
			exitCode: childRes.exitCode,
			output: capped.text,
			truncated: capped.truncated,
			durationMs: childRes.durationMs,
		});
		params.onProgress?.({
			index: i,
			total: boundedItems.length,
			item,
			exitCode: childRes.exitCode,
			durationMs: childRes.durationMs,
		});
	}

	return { ok: true, results };
}

/**
 * Unified background polling controller for `/loop` (`predicate: { kind: "always" }`)
 * and `/monitor` / `/watch` (condition polling).
 */
export class PollingController {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private abortController: AbortController | null = null;
	private readonly statCache = new Map<string, { mtimeMs: number; size: number; matched: boolean }>();

	isActive(): boolean {
		return this.timer !== null || this.abortController !== null;
	}

	getAbortSignal(): AbortSignal | undefined {
		return this.abortController?.signal;
	}

	stop(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
		this.statCache.clear();
	}

	start(params: {
		intervalMs: number;
		predicate: FlowPredicate;
		stopOnMatch: boolean;
		getContext: () => {
			cwd: string;
			registers: Readonly<Record<string, string>>;
			activeTools: readonly string[];
		};
		onTick: (evalResult: { matched: boolean; output: string }) => Promise<{ continuePolling: boolean }> | { continuePolling: boolean };
		onError?: (errorCode: string, reason: string) => void;
	}): void {
		this.stop();
		const controller = new AbortController();
		this.abortController = controller;
		const intervalMs = Math.max(250, Math.min(3_600_000, Math.floor(params.intervalMs || 5000)));

		const scheduleNext = () => {
			if (controller.signal.aborted) return;
			this.timer = setTimeout(async () => {
				if (controller.signal.aborted) return;
				const ctx = params.getContext();
				const evalRes = await evaluatePredicate(params.predicate, {
					...ctx,
					statCache: this.statCache,
				});
				if (controller.signal.aborted) return;

				if (evalRes.errorCode) {
					this.stop();
					params.onError?.(evalRes.errorCode, evalRes.errorReason || evalRes.errorCode);
					return;
				}

				const decision = await params.onTick({
					matched: evalRes.matched,
					output: evalRes.output,
				});
				if (controller.signal.aborted || !decision.continuePolling || (params.stopOnMatch && evalRes.matched)) {
					this.stop();
					return;
				}
				scheduleNext();
			}, intervalMs);
			this.timer.unref?.();
		};

		scheduleNext();
	}
}
