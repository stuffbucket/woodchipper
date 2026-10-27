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
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
	deriveWorkspaceSlug,
	ensureWorkspacesRootGitignored,
	listExistingWorkspaces,
} from "../.pi/extensions/lib/evidence-ledger.ts";
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

export function isHarnessInitialized(projectRoot = PROJECT_ROOT) {
	const hasSubmodules =
		fs.existsSync(path.join(projectRoot, "vendor", "pi", "package.json")) &&
		fs.existsSync(path.join(projectRoot, "vendor", "gliner-runner", "packages", "onnx-runner", "package.json"));
	const hasNodeModules = fs.existsSync(path.join(projectRoot, "node_modules", "rea-agents", "package.json"));
	const piCmd = resolvePiCommand();
	const hasPiRuntime = piCmd.source !== "PATH" || fs.existsSync(piCmd.command);
	return hasSubmodules && hasNodeModules && hasPiRuntime;
}

export function ensureHarnessBootstrapped(projectRoot = PROJECT_ROOT, env = process.env) {
	if (env.WOODCHIPPER_SKIP_AUTO_SETUP === "1" || isHarnessInitialized(projectRoot)) {
		return false;
	}
	if (
		!fs.existsSync(path.join(projectRoot, "vendor", "pi", "package.json")) ||
		!fs.existsSync(path.join(projectRoot, "vendor", "gliner-runner", "packages", "onnx-runner", "package.json"))
	) {
		console.error("[woodchipper] Initializing git submodules...");
		execFileSync("git", ["submodule", "update", "--init", "--recursive"], {
			cwd: projectRoot,
			stdio: "inherit",
			env,
		});
	}
	if (!fs.existsSync(path.join(projectRoot, "node_modules", "rea-agents", "package.json"))) {
		console.error("[woodchipper] First-run setup detected: running pnpm run setup...");
		execFileSync("pnpm", ["run", "setup"], {
			cwd: projectRoot,
			stdio: "inherit",
			env,
		});
		return true;
	}
	return false;
}

/**
 * Extract `-w <workspace>` or `--workspace <workspace>` / `--workspace=<workspace>` from CLI args.
 */
export function extractWorkspaceCliFlag(userArgs) {
	const remaining = [];
	let workspaceArg;
	for (let i = 0; i < userArgs.length; i++) {
		const arg = userArgs[i];
		if ((arg === "-w" || arg === "--workspace") && typeof userArgs[i + 1] === "string") {
			workspaceArg = userArgs[i + 1].trim();
			i++;
			continue;
		}
		if (arg.startsWith("--workspace=")) {
			workspaceArg = arg.slice("--workspace=".length).trim();
			continue;
		}
		remaining.push(arg);
	}
	return { workspaceArg, remainingArgs: remaining };
}

/**
 * Initialize and activate the isolated target workspace up front (`workspaces/<slug>/`),
 * ensuring `workspaces/.gitignore` (`*`) is present and `workspaces/ACTIVE_WORKSPACE` is set.
 */
export function initializeActiveWorkspace(workspaceInput, projectRoot = PROJECT_ROOT) {
	const workspacesRoot = ensureWorkspacesRootGitignored(projectRoot);
	const slug = deriveWorkspaceSlug(workspaceInput || "default");
	const workspaceDir = path.join(workspacesRoot, slug);
	const sessionDir = path.join(workspaceDir, "sessions");
	try {
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.writeFileSync(path.join(workspacesRoot, "ACTIVE_WORKSPACE"), `${slug}\n`, "utf8");
	} catch {
		// Ignore on read-only filesystems
	}
	process.env.WOODCHIPPER_WORKSPACE = slug;
	return { slug, workspaceDir, sessionDir };
}

/**
 * Prompt the operator up front for a workspace name or target path when launching the interactive TUI
 * without `--workspace` or `WOODCHIPPER_WORKSPACE`.
 */
async function promptWorkspaceUpFront(projectRoot = PROJECT_ROOT) {
	ensureWorkspacesRootGitignored(projectRoot);
	const existing = listExistingWorkspaces(projectRoot);
	const activeFile = path.join(projectRoot, "workspaces", "ACTIVE_WORKSPACE");
	let defaultSlug = existing[0] || `session-${new Date().toISOString().slice(0, 10)}`;
	try {
		if (fs.existsSync(activeFile)) {
			const prev = fs.readFileSync(activeFile, "utf8").trim();
			if (prev) defaultSlug = prev;
		}
	} catch {
		// Ignore
	}

	console.error("\x1b[1m\x1b[38;2;255;30;86m╭─ WOODCHIPPER WORKSPACE SETUP\x1b[0m \x1b[38;2;110;242;184m(git-ignored under workspaces/)\x1b[0m");
	if (existing.length > 0) {
		console.error(`\x1b[38;2;142;150;170m│  Existing workspaces: ${existing.slice(0, 5).join(", ")}\x1b[0m`);
	}
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (
			await rl.question(
				`\x1b[1m\x1b[38;2;0;210;255m╰─ Workspace name or target path\x1b[0m \x1b[38;2;142;150;170m[Enter for '${defaultSlug}']\x1b[0m: `,
			)
		).trim();
		const chosen = answer || defaultSlug;
		const initialized = initializeActiveWorkspace(chosen, projectRoot);
		console.error(
			`\x1b[38;2;110;242;184m   ✓ Active workspace -> workspaces/${initialized.slug}/ (REPORT.md • TRIAGE_MAP.md)\x1b[0m\n`,
		);
		return initialized;
	} finally {
		rl.close();
	}
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
	const { workspaceArg, remainingArgs } = extractWorkspaceCliFlag(userArgs);
	const workspaceSource = workspaceArg || process.env.WOODCHIPPER_WORKSPACE || "default";
	const { sessionDir } = initializeActiveWorkspace(workspaceSource, PROJECT_ROOT);

	const baseArgs = [
		"--approve",
		"--no-skills",
		"--no-prompt-templates",
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

	const hasNameFlag = remainingArgs.some(
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

	const normalizedUserArgs = remainingArgs.map((arg) =>
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
			...resolveReaProviderEnv(process.env, PROJECT_ROOT),
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

async function main() {
	const argv = process.argv.slice(2);
	const sub = argv[0];

	if (sub === "--help" || sub === "-h" || sub === "help") {
		console.log(`Woodchipper Pi Reverse-Engineering Harness

Usage:
  woodchipper [-w <workspace>] [tui] [pi-args...]  Launch interactive Pi TUI (prompts for workspace up front)
  woodchipper daemon [-w <workspace>] [pi-args...] Run headless A2A / Claude Code peer daemon
  woodchipper rpc [pi-args...]                     Run Pi JSONL RPC mode (--mode rpc)
  woodchipper ask <prompt...>                      Run one-shot headless prompt (-p)
  woodchipper smoke                                Run end-to-end smoke verification on sample Electron app
  woodchipper build-pi                             Build audited Pi runtime from pinned vendor/pi source
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

	if (sub === "smoke") {
		ensureHarnessBootstrapped(PROJECT_ROOT);
		execFileSync(process.execPath, ["--experimental-strip-types", path.join(PROJECT_ROOT, "scripts", "smoke-test.mjs")], {
			cwd: PROJECT_ROOT,
			stdio: "inherit",
		});
		return;
	}

	ensureHarnessBootstrapped(PROJECT_ROOT);

	if (sub === "daemon" || sub === "peer") {
		runDaemonMode(argv.slice(1));
		return;
	}

	const isTuiLaunch = sub !== "rpc" && sub !== "ask" && !argv.includes("--print") && !argv.includes("-p");
	const { workspaceArg } = extractWorkspaceCliFlag(argv);
	if (
		isTuiLaunch &&
		!workspaceArg &&
		!process.env.WOODCHIPPER_WORKSPACE &&
		process.stdin.isTTY &&
		process.stdout.isTTY
	) {
		await promptWorkspaceUpFront(PROJECT_ROOT);
	}

	const piCmd = resolvePiCommand();
	let piArgs;

	if (sub === "rpc") {
		piArgs = buildWoodchipperPiArgs(argv.slice(1), "rpc");
	} else if (sub === "ask") {
		piArgs = buildWoodchipperPiArgs(argv.slice(1), "print");
	} else if (sub === "tui" || sub === "start") {
		piArgs = buildWoodchipperPiArgs(argv.slice(1), "tui");
	} else {
		piArgs = buildWoodchipperPiArgs(argv);
	}

	const child = spawn(piCmd.command, [...piCmd.prefixArgs, ...piArgs], {
		cwd: PROJECT_ROOT,
		stdio: "inherit",
		env: resolveReaProviderEnv(process.env, PROJECT_ROOT),
	});
	attachChildErrorHandler(child, piCmd.command);

	child.on("exit", (code) => {
		process.exit(code ?? 0);
	});
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("woodchipper.mjs")) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
