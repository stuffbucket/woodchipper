/**
 * Cross-Platform Ancestor PID Tree, Harness Detector, & Process-Tree Termination
 * (`.pi/extensions/lib/pi-flow/process-tree.ts`)
 *
 * Works across macOS (`darwin`), Linux (`linux`), and Windows (`win32`) with:
 * - O(1) fast-path check for `PI_FLOW_DEPTH`
 * - Per-process memoization keyed by `(pid, ppid, PI_FLOW_DEPTH)`
 * - Linux `/proc/<pid>/stat` + `/proc/<pid>/cmdline` fast-path (no subprocess spawn)
 * - POSIX `ps -A -o pid=,ppid=,comm=,args=` fallback
 * - Windows `powershell.exe Get-CimInstance Win32_Process` JSON parser
 * - Cross-platform process-tree termination (`taskkill.exe /F /T /PID` on Windows, `-pid` on POSIX)
 */

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type DetectedHarness =
	| "claude-code"
	| "claude-desktop"
	| "codex"
	| "copilot-cli"
	| "pi"
	| "woodchipper"
	| "cursor"
	| "windsurf";

export interface RawProcessRow {
	pid: number;
	ppid: number;
	command: string;
	args: string;
}

export interface AncestorProcessInfo extends RawProcessRow {
	detectedHarness?: DetectedHarness;
}

export interface ProcessLineage {
	selfPid: number;
	ppid: number;
	flowDepth: number;
	ancestors: AncestorProcessInfo[];
	ancestorPids: ReadonlySet<number>;
	invokingHarness: AncestorProcessInfo | null;
}

/**
 * Identify a known AI coding harness from a process command name and command line.
 */
export function detectHarnessFromCommand(command: string, args = ""): DetectedHarness | undefined {
	const combined = `${command} ${args}`.trim();
	const lower = combined.toLowerCase();
	const base = path.basename(command.replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "");

	if (/\bwoodchipper(?:\.mjs|\b)/.test(lower)) {
		return "woodchipper";
	}
	if (base === "codex" || /\bcodex(?:\.exe|\b)/.test(lower)) {
		return "codex";
	}
	if (base === "copilot" || /\bgh\s+copilot\b/.test(lower) || /\bcopilot-agent\b/.test(lower)) {
		return "copilot-cli";
	}
	if (/\bclaude\.app\b/.test(lower) || /\bclaude desktop\b/.test(lower)) {
		return "claude-desktop";
	}
	if (base === "claude" || /\b@anthropic-ai\/claude-code\b/.test(lower) || /\/claude(?:\s|$)/.test(lower)) {
		return "claude-code";
	}
	if (base === "cursor" || /\bcursor\.app\b/.test(lower)) {
		return "cursor";
	}
	if (base === "windsurf" || /\bwindsurf\.app\b/.test(lower)) {
		return "windsurf";
	}
	if (
		base === "pi" ||
		/\bpi-coding-agent\b/.test(lower) ||
		/\/coding-agent\/dist\/bundle\/cli\.js\b/.test(lower) ||
		/\/\.woodchipper\/pi\b/.test(lower)
	) {
		return "pi";
	}
	return undefined;
}

/**
 * Parse POSIX `ps -A -o pid=,ppid=,comm=,args=` output into a PID -> RawProcessRow map.
 */
export function parsePosixPsOutput(psText: string): Map<number, RawProcessRow> {
	const map = new Map<number, RawProcessRow>();
	for (const rawLine of String(psText || "").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
		if (!match) continue;
		const pid = Number.parseInt(match[1], 10);
		const ppid = Number.parseInt(match[2], 10);
		if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
		const command = match[3] || "";
		const args = (match[4] || command).trim();
		map.set(pid, { pid, ppid, command, args });
	}
	return map;
}

/**
 * Parse Windows `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json` output.
 */
export function parseWindowsCimJson(jsonText: string): Map<number, RawProcessRow> {
	const map = new Map<number, RawProcessRow>();
	const trimmed = String(jsonText || "").trim();
	if (!trimmed) return map;
	try {
		const parsed = JSON.parse(trimmed);
		const rows = Array.isArray(parsed) ? parsed : [parsed];
		for (const row of rows) {
			if (!row || typeof row !== "object") continue;
			const pid = Number((row as Record<string, unknown>).ProcessId);
			const ppid = Number((row as Record<string, unknown>).ParentProcessId ?? 0);
			if (!Number.isFinite(pid) || pid <= 0) continue;
			const command = String((row as Record<string, unknown>).Name || "");
			const args = String((row as Record<string, unknown>).CommandLine || command).trim();
			map.set(pid, { pid, ppid: Number.isFinite(ppid) ? ppid : 0, command, args });
		}
	} catch {
		// Ignore malformed JSON
	}
	return map;
}

/**
 * Walk upward from `startPid` through `table` with a visited-PID cycle guard.
 * Returns `[self, parent, grandparent, ...]`.
 */
export function walkAncestorChain(startPid: number, table: ReadonlyMap<number, RawProcessRow>): AncestorProcessInfo[] {
	const chain: AncestorProcessInfo[] = [];
	const visited = new Set<number>();
	let currentPid = startPid;

	while (currentPid > 0 && !visited.has(currentPid) && chain.length < 64) {
		visited.add(currentPid);
		const row = table.get(currentPid);
		if (!row) break;
		const detectedHarness = detectHarnessFromCommand(row.command, row.args);
		chain.push({
			...row,
			...(detectedHarness ? { detectedHarness } : {}),
		});
		if (row.ppid <= 0 || row.ppid === currentPid) break;
		currentPid = row.ppid;
	}
	return chain;
}

/**
 * Fast-path Linux `/proc/<pid>/stat` + `/proc/<pid>/cmdline` walker that reads only the
 * ancestor chain (~3-6 processes) without spawning a subprocess.
 */
function walkLinuxProcAncestors(startPid: number): AncestorProcessInfo[] | null {
	if (process.platform !== "linux" || !fs.existsSync("/proc")) {
		return null;
	}
	const chain: AncestorProcessInfo[] = [];
	const visited = new Set<number>();
	let currentPid = startPid;

	try {
		while (currentPid > 0 && !visited.has(currentPid) && chain.length < 64) {
			visited.add(currentPid);
			const statPath = `/proc/${currentPid}/stat`;
			if (!fs.existsSync(statPath)) break;
			const statRaw = fs.readFileSync(statPath, "utf8");
			const openParen = statRaw.indexOf("(");
			const closeParen = statRaw.lastIndexOf(")");
			if (openParen === -1 || closeParen === -1 || closeParen <= openParen) break;
			const command = statRaw.slice(openParen + 1, closeParen);
			const afterParen = statRaw.slice(closeParen + 1).trim().split(/\s+/);
			const ppid = Number.parseInt(afterParen[1] || "0", 10);
			let args = command;
			try {
				const cmdline = fs.readFileSync(`/proc/${currentPid}/cmdline`, "utf8").replace(/\0+/g, " ").trim();
				if (cmdline) args = cmdline;
			} catch {
				// Ignore unreadable cmdline
			}
			const detectedHarness = detectHarnessFromCommand(command, args);
			chain.push({
				pid: currentPid,
				ppid: Number.isFinite(ppid) ? ppid : 0,
				command,
				args,
				...(detectedHarness ? { detectedHarness } : {}),
			});
			if (!Number.isFinite(ppid) || ppid <= 0 || ppid === currentPid) break;
			currentPid = ppid;
		}
		return chain.length > 0 ? chain : null;
	} catch {
		return null;
	}
}

let cachedLineageKey = "";
let cachedLineage: ProcessLineage | null = null;

/**
 * Compute and memoize the current process's ancestor chain and harness lineage.
 */
export function getProcessLineage(options?: { env?: NodeJS.ProcessEnv; forceRefresh?: boolean }): ProcessLineage {
	const env = options?.env ?? process.env;
	const envDepthRaw = Number.parseInt(String(env.PI_FLOW_DEPTH || "0"), 10);
	const envDepth = Number.isFinite(envDepthRaw) && envDepthRaw > 0 ? envDepthRaw : 0;
	const cacheKey = `${process.pid}:${process.ppid}:${envDepth}:${env.PI_FLOW_PARENT_PID || ""}`;

	if (!options?.forceRefresh && cachedLineage && cachedLineageKey === cacheKey) {
		return cachedLineage;
	}

	let ancestors: AncestorProcessInfo[] | null = walkLinuxProcAncestors(process.pid);
	if (!ancestors) {
		if (process.platform === "win32") {
			try {
				const rawJson = execFileSync(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
					],
					{ encoding: "utf8", timeout: 2500, windowsHide: true },
				);
				ancestors = walkAncestorChain(process.pid, parseWindowsCimJson(rawJson));
			} catch {
				ancestors = [];
			}
		} else {
			try {
				const rawPs = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm=,args="], {
					encoding: "utf8",
					timeout: 2000,
				});
				ancestors = walkAncestorChain(process.pid, parsePosixPsOutput(rawPs));
			} catch {
				ancestors = [];
			}
		}
	}

	if (ancestors.length === 0) {
		const selfCommand = path.basename(process.execPath);
		const selfArgs = process.argv.join(" ");
		ancestors = [
			{
				pid: process.pid,
				ppid: process.ppid,
				command: selfCommand,
				args: selfArgs,
				detectedHarness: detectHarnessFromCommand(selfCommand, selfArgs),
			},
		];
	}

	const ancestorPids = new Set<number>([process.pid]);
	if (process.ppid > 0) ancestorPids.add(process.ppid);
	const parentEnvPid = Number.parseInt(String(env.PI_FLOW_PARENT_PID || ""), 10);
	if (Number.isFinite(parentEnvPid) && parentEnvPid > 0) {
		ancestorPids.add(parentEnvPid);
	}
	for (const a of ancestors) {
		ancestorPids.add(a.pid);
		if (a.ppid > 0) ancestorPids.add(a.ppid);
	}

	const externalAncestors = ancestors.slice(1);
	const invokingHarness = externalAncestors.find((a) => a.detectedHarness !== undefined) ?? null;
	const piOrWoodchipperAncestors = externalAncestors.filter(
		(a) => a.detectedHarness === "pi" || a.detectedHarness === "woodchipper",
	).length;
	const flowDepth = Math.max(envDepth, piOrWoodchipperAncestors > 0 && envDepth > 0 ? envDepth : envDepth);

	const lineage: ProcessLineage = {
		selfPid: process.pid,
		ppid: process.ppid,
		flowDepth,
		ancestors,
		ancestorPids,
		invokingHarness,
	};

	cachedLineageKey = cacheKey;
	cachedLineage = lineage;
	return lineage;
}

/**
 * Guard against cyclic A2A / peer deadlocks: never allow synchronous delegation to self or any PID in `ancestorPids`.
 */
export function checkTargetPidAllowed(
	targetPid: number,
	lineage: ProcessLineage = getProcessLineage(),
): { allowed: boolean; errorCode?: "ERR_ANCESTOR_TARGET_FORBIDDEN"; reason?: string } {
	if (lineage.ancestorPids.has(targetPid)) {
		return {
			allowed: false,
			errorCode: "ERR_ANCESTOR_TARGET_FORBIDDEN",
			reason: `Target PID ${targetPid} is in the current process ancestor chain (${[...lineage.ancestorPids].join(" -> ")}); synchronous delegation to an ancestor is forbidden to prevent cyclic deadlock.`,
		};
	}
	return { allowed: true };
}

/**
 * Check if a process is alive via signal 0 (`process.kill(pid, 0)` works across macOS, Linux, and Windows in Node.js).
 */
export function isProcessAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

let cachedSelfStartString: string | null = null;

/**
 * Return a stable process start-time string for `pid` across macOS, Linux, and Windows.
 */
export function getProcessStartString(pid: number = process.pid): string {
	if (pid === process.pid && cachedSelfStartString) {
		return cachedSelfStartString;
	}
	if (process.platform === "win32") {
		if (pid === process.pid) {
			const approxStartSec = Math.floor(Date.now() / 1000 - process.uptime());
			cachedSelfStartString = `win32:${pid}:${approxStartSec}`;
			return cachedSelfStartString;
		}
		try {
			const out = execFileSync(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CreationDate.ToUniversalTime().ToString("o")`,
				],
				{ encoding: "utf8", timeout: 2000, windowsHide: true },
			).trim();
			if (out) return out;
		} catch {
			// Fallback below
		}
		return `win32:${pid}`;
	}

	try {
		const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 2000,
		}).trim();
		if (pid === process.pid && out) {
			cachedSelfStartString = out;
		}
		return out || new Date().toUTCString();
	} catch {
		return new Date().toUTCString();
	}
}

/**
 * Cross-platform process-tree termination:
 * - Windows (`win32`): `System32\taskkill.exe /F /T /PID <pid>` with `windowsHide: true`
 * - macOS / Linux: `process.kill(-pid, signal)` (process group) with `process.kill(pid, signal)` fallback
 */
export function killProcessTreeCrossPlatform(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
	if (!Number.isFinite(pid) || pid <= 0) return;
	if (process.platform === "win32") {
		try {
			const taskkillPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
			const child = spawn(taskkillPath, ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
			child.once("error", () => {});
			child.unref();
		} catch {
			try {
				process.kill(pid);
			} catch {
				// Ignore already-dead process
			}
		}
		return;
	}

	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Ignore already-dead process
		}
	}
}
