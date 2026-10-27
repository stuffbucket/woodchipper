#!/usr/bin/env node
/**
 * Woodchipper Pi Harness Launcher (`bin/woodchipper.mjs`)
 *
 * Launches the customized Pi coding-agent harness configured for Reverse Engineer Anything (REA)
 * and REAP playbooks, with dual-surface support:
 * - `woodchipper` / `woodchipper tui`: Interactive human TUI + background Claude Code `peerProtocol: 1` A2A socket
 * - `woodchipper daemon` / `woodchipper peer`: Headless RPC daemon listening on `~/.claude/sessions/<pid>.json` + `/tmp/cc-socks/<pid>.sock` for Claude Code `SendMessage` or `woodchipper-ctl`
 * - `woodchipper rpc`: Standard `pi --mode rpc` with all Woodchipper extensions, skills, and REA MCP wired up
 * - `woodchipper ask <prompt>`: One-shot headless print mode (`-p`)
 * - `woodchipper build-pi`: Builds an audited runtime from the pinned `vendor/pi` source
 */

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveWorkspaceSlug } from "../.pi/extensions/lib/evidence-ledger.ts";
import { resolveReaProviderEnv } from "../.pi/extensions/lib/triage.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

export function resolvePiCommand() {
	if (process.env.WOODCHIPPER_PI_BIN && fs.existsSync(process.env.WOODCHIPPER_PI_BIN)) {
		return { command: process.env.WOODCHIPPER_PI_BIN, prefixArgs: [], source: "WOODCHIPPER_PI_BIN" };
	}

	const auditedCli = path.join(
		PROJECT_ROOT,
		".woodchipper",
		"pi",
		"packages",
		"coding-agent",
		"dist",
		"bundle",
		"cli.js",
	);
	if (fs.existsSync(auditedCli)) {
		return { command: process.execPath, prefixArgs: [auditedCli], source: "audited .woodchipper/pi build" };
	}

	const submoduleCli = path.join(PROJECT_ROOT, "vendor", "pi", "packages", "coding-agent", "dist", "bundle", "cli.js");
	if (fs.existsSync(submoduleCli)) {
		return { command: process.execPath, prefixArgs: [submoduleCli], source: "vendor/pi fallback build" };
	}

	const managedPi = path.join(os.homedir(), ".pi", "agent", "bin", "pi");
	if (fs.existsSync(managedPi)) {
		return { command: managedPi, prefixArgs: [], source: "~/.pi/agent/bin/pi" };
	}

	return { command: "pi", prefixArgs: [], source: "PATH" };
}

/**
 * Build CLI arguments for Pi.
 * Note: `.pi/SYSTEM.md` is automatically loaded by Pi from `<cwd>/.pi/SYSTEM.md`,
 * and `.pi/settings.json` already registers `.pi/extensions/woodchipper-rea.ts`,
 * `.pi/extensions/woodchipper-peer.ts`, and `skills/`. We still pass `--extension`
 * and `--skill` explicitly so `woodchipper` works even if launched from another cwd
 * (Pi deduplicates extension and skill paths via `path.resolve`).
 */
export function buildWoodchipperPiArgs(userArgs, modeOverride) {
	const workspaceSlug = deriveWorkspaceSlug(process.env.WOODCHIPPER_WORKSPACE || "default");
	const sessionDir = path.join(PROJECT_ROOT, "workspaces", workspaceSlug, "sessions");
	try {
		fs.mkdirSync(sessionDir, { recursive: true });
	} catch {
		// Ignore on read-only filesystems
	}

	const baseArgs = [
		"--approve",
		"--session-dir",
		sessionDir,
		"--extension",
		path.join(PROJECT_ROOT, ".pi", "extensions", "woodchipper-maximal.ts"),
		"--extension",
		path.join(PROJECT_ROOT, ".pi", "extensions", "woodchipper-rea.ts"),
		"--extension",
		path.join(PROJECT_ROOT, ".pi", "extensions", "woodchipper-peer.ts"),
		"--skill",
		path.join(PROJECT_ROOT, "skills"),
		"--append-system-prompt",
		path.join(PROJECT_ROOT, ".pi", "SYSTEM.md"),
	];

	const hasNameFlag = userArgs.some(
		(a) =>
			a === "-n" ||
			a === "--name" ||
			a.startsWith("--name=") ||
			a === "--peer-name" ||
			a.startsWith("--peer-name="),
	);
	if (!hasNameFlag) {
		baseArgs.push("--name", process.env.WOODCHIPPER_PEER_NAME || "woodchipper");
	}

	if (modeOverride === "rpc") {
		baseArgs.push("--mode", "rpc");
	} else if (modeOverride === "print") {
		baseArgs.push("--print");
	}

	const normalizedUserArgs = userArgs.map((arg) =>
		arg === "--no-peer" || arg === "--no-maximal" ? `${arg}=true` : arg,
	);

	return [...baseArgs, ...normalizedUserArgs];
}

function attachChildErrorHandler(child, command) {
	child.on("error", (err) => {
		console.error(`[woodchipper] Failed to spawn Pi runtime ('${command}'): ${err.message}`);
		process.exit(1);
	});
}

function runDaemonMode(extraArgs) {
	const piCmd = resolvePiCommand();
	const piArgs = buildWoodchipperPiArgs(extraArgs, "rpc");

	console.error(`[woodchipper] Starting headless A2A / Claude-Code peer daemon using ${piCmd.source}...`);
	const child = spawn(piCmd.command, [...piCmd.prefixArgs, ...piArgs], {
		cwd: PROJECT_ROOT,
		stdio: ["pipe", "pipe", "inherit"],
		env: {
			...resolveReaProviderEnv(),
			WOODCHIPPER_PEER_NAME: process.env.WOODCHIPPER_PEER_NAME || "woodchipper",
		},
	});
	attachChildErrorHandler(child, piCmd.command);

	console.error(
		`[woodchipper] Daemon PID ${child.pid} registered in ~/.claude/sessions/${child.pid}.json (socket /tmp/cc-socks/${child.pid}.sock)`,
	);
	console.error(
		`[woodchipper] Drive from Claude Code via SendMessage({ to: "woodchipper", message: "..." }) or via: pnpm run ctl -- send woodchipper "..." --wait`,
	);

	let stdoutResidual = "";
	child.stdout.on("data", (chunk) => {
		stdoutResidual += chunk.toString("utf8");
		let newlineIdx = stdoutResidual.indexOf("\n");
		while (newlineIdx !== -1) {
			const line = stdoutResidual.slice(0, newlineIdx).trim();
			stdoutResidual = stdoutResidual.slice(newlineIdx + 1);
			if (line) {
				try {
					const evt = JSON.parse(line);
					if (evt.type === "agent_start") {
						console.error(`[woodchipper] Turn started...`);
					} else if (evt.type === "tool_execution_start") {
						console.error(`[woodchipper] Tool -> ${evt.toolName}`);
					} else if (evt.type === "agent_settled") {
						console.error(`[woodchipper] Turn settled (idle).`);
					}
				} catch {
					// Ignore non-JSON lines
				}
			}
			newlineIdx = stdoutResidual.indexOf("\n");
		}
	});

	const forwardSignal = (sig) => {
		child.kill(sig);
	};
	process.on("SIGINT", () => forwardSignal("SIGINT"));
	process.on("SIGTERM", () => forwardSignal("SIGTERM"));

	child.on("exit", (code) => {
		process.exit(code ?? 0);
	});
}

function main() {
	const argv = process.argv.slice(2);
	const sub = argv[0];

	if (sub === "--help" || sub === "-h" || sub === "help") {
		console.log(`Woodchipper Pi Reverse-Engineering Harness

Usage:
  woodchipper [tui] [pi-args...]      Launch interactive Pi TUI + background Claude Code peer socket
  woodchipper daemon [pi-args...]     Run headless A2A / Claude Code peer daemon (SendMessage / woodchipper-ctl)
  woodchipper rpc [pi-args...]        Run Pi JSONL RPC mode (--mode rpc) with Woodchipper extensions & skills
  woodchipper ask <prompt...>         Run one-shot headless prompt (-p) with Woodchipper extensions & skills
  woodchipper build-pi                Build audited Pi runtime from pinned vendor/pi source
`);
		return;
	}

	if (sub === "build-pi") {
		execFileSync(process.execPath, [path.join(PROJECT_ROOT, "scripts", "build-harness.mjs"), "--with-submodule-build"], {
			cwd: PROJECT_ROOT,
			stdio: "inherit",
		});
		return;
	}

	if (sub === "daemon" || sub === "peer") {
		runDaemonMode(argv.slice(1));
		return;
	}

	const piCmd = resolvePiCommand();
	let piArgs;

	if (sub === "rpc") {
		piArgs = buildWoodchipperPiArgs(argv.slice(1), "rpc");
	} else if (sub === "ask") {
		piArgs = buildWoodchipperPiArgs(argv.slice(1), "print");
	} else if (sub === "tui") {
		piArgs = buildWoodchipperPiArgs(argv.slice(1), "tui");
	} else {
		piArgs = buildWoodchipperPiArgs(argv);
	}

	const child = spawn(piCmd.command, [...piCmd.prefixArgs, ...piArgs], {
		cwd: PROJECT_ROOT,
		stdio: "inherit",
		env: resolveReaProviderEnv(),
	});
	attachChildErrorHandler(child, piCmd.command);

	child.on("exit", (code) => {
		process.exit(code ?? 0);
	});
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("woodchipper.mjs")) {
	main();
}
