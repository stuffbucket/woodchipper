/**
 * Woodchipper GLiNER Classifier Bridge (`.pi/extensions/lib/gliner-classifier.ts`)
 *
 * Integrates `stuffbucket/gliner-runner` (`decide-340m`, Fastino GLiNER2.5-Decide
 * `9d1bfb848cd16d93ee56ccbc59cd92bf0f284d90`, ~340M/380M params) vendored at
 * `vendor/gliner-runner` to make Woodchipper act as a zero-domain-knowledge
 * reverse-engineering expert system:
 *
 * 1. Automatically detects `gliner-runner` (CLI or local `http://127.0.0.1:8090` server).
 * 2. Automatically checks whether `decide-340m` is installed and pulls it
 *    (`gliner-runner models install decide-340m --yes` or HTTP download API) if missing.
 * 3. Translates plain-English user questions ("Does this app phone home?",
 *    "How does the export button work?", "Can we rebuild this formula?",
 *    "Is this driver safe?") into the exact Woodchipper Playbook, Sub-Skill,
 *    and initial REA 6.7.0 tool sequence.
 * 4. Classifies extracted binary strings, imports, and symbols into reverse-engineering
 *    capability buckets (`network_telemetry`, `filesystem_database`, `ipc_rpc`,
 *    `crypto_auth`, `command_execution_sink`, `ui_entrypoint`, `protection_anti_debug`).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { PlaybookId, WoodchipperSubSkill } from "./triage.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, "../../..");

export const DEFAULT_GLINER_MODEL_ID = "decide-340m";
export const DEFAULT_GLINER_MODEL_REVISION = "9d1bfb848cd16d93ee56ccbc59cd92bf0f284d90";
export const DEFAULT_GLINER_BASE_URL = "http://127.0.0.1:8090";

export type CapabilityBucket =
	| "network_telemetry"
	| "filesystem_database"
	| "ipc_rpc"
	| "crypto_auth"
	| "command_execution_sink"
	| "ui_entrypoint"
	| "protection_anti_debug";

export const PLAYBOOK_LABEL_DESCRIPTIONS: Readonly<Record<PlaybookId, string>> = {
	"triage-and-feature-trace":
		"Understand what an unfamiliar binary, app, or bundle does, map its architecture and capabilities, or trace how a specific button, CLI flag, or feature works from entry to side effect",
	"clean-room-and-porting":
		"Recover a business rule, mathematical formula, state machine, file format, or behavioral specification to reimplement it cleanly or port a native program/game to WebAssembly",
	"security-and-vr":
		"Audit a binary, kernel driver, Electron app, or APK for security vulnerabilities, unsafe input handling, command injection, patch diffs between versions, or crash/segfault root causes",
	"firmware-and-protocols":
		"Inspect or extract embedded router/IoT firmware images, microcontroller dumps, network packet captures, SQLite databases, WebAssembly modules, smart contracts, or hardware logic signals",
};

export const SUBSKILL_LABEL_DESCRIPTIONS: Readonly<Record<WoodchipperSubSkill, string>> = {
	"woodchipper-native":
		"Native compiled executables, shared libraries, system binaries, ELF, PE, EXE, DLL, Mach-O, Go, Rust, C, C++, or assembly",
	"woodchipper-js-web":
		"Electron desktop applications, app.asar archives, bundled or minified JavaScript, web apps, or HAR/SAZ network captures",
	"woodchipper-mobile-managed":
		"Android APK packages, Flutter/Dart apps, Unity games, Godot archives, .NET C# assemblies, or macOS/iOS .app/IPA bundles and plists",
	"woodchipper-firmware-signals":
		"Embedded firmware images, microcontroller ROMs, WebAssembly WASM files, EVM smart contracts, SQLite databases, PCAP network captures, or logic analyzer traces",
	"woodchipper-runtime":
		"Live running processes, browser debugging, Electron inspector, Frida dynamic hooks, LLDB, or GDB live debugging",
	"woodchipper-reconstruction":
		"Clean-room specification writing, cloning a feature into a new language, recovering a struct/file reader, or porting code to WebAssembly",
	"woodchipper-audit":
		"Security vulnerability auditing, trust-boundary review, kernel IOCTL checking, version patch diffing, or crash core dump analysis",
};

export const CAPABILITY_LABEL_DESCRIPTIONS: Readonly<Record<CapabilityBucket, string>> = {
	network_telemetry:
		"Network sockets, HTTP/HTTPS requests, URLs, TLS/SSL, DNS lookups, WebSockets, MQTT, or telemetry/analytics endpoints",
	filesystem_database:
		"File reading and writing, directory traversal, SQLite queries, plist/config persistence, or archive extraction",
	ipc_rpc:
		"Inter-process communication, Electron ipcMain/ipcRenderer/contextBridge, macOS XPC, Android Binder/Intents, COM, or local sockets/pipes",
	crypto_auth:
		"Cryptographic hashing, AES/RSA/ChaCha encryption, signature verification, API keys, tokens, credentials, or license validation",
	command_execution_sink:
		"Spawning OS processes, shell command execution, system/execve/CreateProcess/child_process, eval, or unsafe memory copy sinks",
	ui_entrypoint:
		"User interface windows, menus, buttons, CLI flag parsers, route handlers, or exported public API entry points",
	protection_anti_debug:
		"Anti-debugging checks, ptrace/IsDebuggerPresent, VM detection, integrity/checksum guards, packing, or obfuscation",
};

export interface GlinerCommandResolution {
	available: boolean;
	command: string;
	prefixArgs: string[];
	source: string;
	submoduleRoot: string;
	submoduleCommitValid: boolean;
}

export interface GlinerModelStatus {
	modelId: string;
	revision: string;
	installed: boolean;
	autoPulled: boolean;
	modelsDir: string;
	runnerAvailable: boolean;
	runnerSource: string;
	serverReachable: boolean;
	serverUrl: string;
	error?: string;
}

export interface IntentClassificationResult {
	query: string;
	source: "gliner-http" | "gliner-cli" | "heuristic-fallback";
	modelId: string;
	recommendedPlaybook: PlaybookId;
	playbookConfidence: number;
	playbookProbabilities: Record<PlaybookId, number>;
	recommendedSubSkill: WoodchipperSubSkill;
	subSkillConfidence: number;
	subSkillProbabilities: Record<WoodchipperSubSkill, number>;
	initialReaTools: string[];
	plainEnglishSummary: string;
}

export interface SignalClassificationItem {
	signal: string;
	capabilities: CapabilityBucket[];
	probabilities: Partial<Record<CapabilityBucket, number>>;
}

export interface SignalClassificationResult {
	source: "gliner-http" | "gliner-cli" | "heuristic-fallback";
	modelId: string;
	items: SignalClassificationItem[];
}

export function defaultGlinerModelsDir(
	env: NodeJS.ProcessEnv = process.env,
	projectRoot = DEFAULT_PROJECT_ROOT,
): string {
	if (env.GLINER_RUNNER_MODELS_DIR?.trim()) {
		return env.GLINER_RUNNER_MODELS_DIR.trim();
	}
	return path.join(projectRoot, "vendor", "gliner-runner", "models");
}

export function expectedOnnxArtifactDir(
	modelsDir: string,
	modelId = DEFAULT_GLINER_MODEL_ID,
	revision = DEFAULT_GLINER_MODEL_REVISION,
): string {
	const repoSlug =
		modelId === "decide-multilingual"
			? "fastino--GLiNER2.5-multi-Decide"
			: modelId === "decide-1b"
				? "fastino--GLiNER2.5-Decide-1B"
				: "fastino--GLiNER2.5-Decide";
	return path.join(modelsDir, "onnx", repoSlug, revision);
}

export function isModelPresentOnDisk(
	modelsDir: string,
	modelId = DEFAULT_GLINER_MODEL_ID,
	revision = DEFAULT_GLINER_MODEL_REVISION,
): boolean {
	const dir = expectedOnnxArtifactDir(modelsDir, modelId, revision);
	return (
		fs.existsSync(path.join(dir, "manifest.json")) &&
		(fs.existsSync(path.join(dir, "model.onnx")) || fs.existsSync(path.join(dir, "encoder.onnx")))
	);
}

/**
 * Locate the `gliner-runner` executable across env overrides, built submodule,
 * `~/.local/bin`, Homebrew, or system `PATH`.
 */
export function resolveGlinerRunnerCommand(
	projectRoot = DEFAULT_PROJECT_ROOT,
	env: NodeJS.ProcessEnv = process.env,
): GlinerCommandResolution {
	const submoduleRoot = path.join(projectRoot, "vendor", "gliner-runner");
	const submoduleCommitValid = fs.existsSync(path.join(submoduleRoot, "packages", "onnx-runner", "package.json"));

	const envBin = env.WOODCHIPPER_GLINER_BIN?.trim() || env.GLINER_RUNNER_BIN?.trim();
	if (envBin && fs.existsSync(envBin)) {
		return {
			available: true,
			command: envBin,
			prefixArgs: [],
			source: "env:WOODCHIPPER_GLINER_BIN",
			submoduleRoot,
			submoduleCommitValid,
		};
	}

	const builtCliCandidates = [
		path.join(projectRoot, ".woodchipper", "gliner-runner", "packages", "onnx-runner", "dist", "src", "cli.js"),
		path.join(submoduleRoot, "packages", "onnx-runner", "dist", "src", "cli.js"),
	];
	for (const cliPath of builtCliCandidates) {
		if (fs.existsSync(cliPath)) {
			return {
				available: true,
				command: process.execPath,
				prefixArgs: [cliPath],
				source: path.relative(projectRoot, cliPath),
				submoduleRoot,
				submoduleCommitValid,
			};
		}
	}

	const standardBins = [
		path.join(os.homedir(), ".local", "bin", "gliner-runner"),
		path.join(os.homedir(), ".local", "bin", "gliner-runner-onnx"),
		"/opt/homebrew/bin/gliner-runner",
		"/opt/homebrew/bin/gliner-runner-onnx",
		"/usr/local/bin/gliner-runner",
	];
	for (const bin of standardBins) {
		if (fs.existsSync(bin)) {
			return {
				available: true,
				command: bin,
				prefixArgs: [],
				source: bin,
				submoduleRoot,
				submoduleCommitValid,
			};
		}
	}

	for (const binName of ["gliner-runner", "gliner-runner-onnx"]) {
		try {
			const found = execFileSync("which", [binName], {
				encoding: "utf8",
				timeout: 2000,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			if (found) {
				return {
					available: true,
					command: found,
					prefixArgs: [],
					source: `PATH:${found}`,
					submoduleRoot,
					submoduleCommitValid,
				};
			}
		} catch {
			// Continue
		}
	}

	return {
		available: false,
		command: "gliner-runner",
		prefixArgs: [],
		source: "not-installed (install via `brew tap stuffbucket/tap && brew install gliner-runner`)",
		submoduleRoot,
		submoduleCommitValid,
	};
}

/**
 * Check if `decide-340m` is installed and automatically pull/install it if missing
 * (unless `autoPull: false` or `PI_OFFLINE=1`).
 */
export async function ensureGlinerModelInstalled(options: {
	projectRoot?: string;
	modelId?: string;
	modelsDir?: string;
	baseUrl?: string;
	autoPull?: boolean;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof globalThis.fetch;
	execSyncImpl?: typeof execFileSync;
} = {}): Promise<GlinerModelStatus> {
	const env = options.env ?? process.env;
	const projectRoot = options.projectRoot ?? DEFAULT_PROJECT_ROOT;
	const modelId = options.modelId ?? env.WOODCHIPPER_GLINER_MODEL?.trim() ?? DEFAULT_GLINER_MODEL_ID;
	const modelsDir = options.modelsDir ?? defaultGlinerModelsDir(env, projectRoot);
	const baseUrl = (options.baseUrl ?? env.GLINER_RUNNER_URL?.trim() ?? DEFAULT_GLINER_BASE_URL).replace(/\/+$/, "");
	const isOffline = env.PI_OFFLINE === "1" || env.PI_OFFLINE === "true";
	const autoPull = (options.autoPull ?? env.WOODCHIPPER_GLINER_AUTO_PULL !== "0") && !isOffline;
	const fetchFn = options.fetchImpl ?? globalThis.fetch;
	const execFn = options.execSyncImpl ?? execFileSync;

	const runner = resolveGlinerRunnerCommand(projectRoot, env);
	let installed = isModelPresentOnDisk(modelsDir, modelId, DEFAULT_GLINER_MODEL_REVISION);
	let autoPulled = false;
	let serverReachable = false;
	let errorMsg: string | undefined;

	// 1. Probe local HTTP server if running
	if (!isOffline && typeof fetchFn === "function") {
		try {
			const res = await fetchFn(`${baseUrl}/v1/models`, {
				signal: AbortSignal.timeout(1200),
			});
			if (res.ok) {
				serverReachable = true;
				const body = (await res.json()) as {
					models?: Array<{ model_id?: string; id?: string; available?: boolean; installed?: boolean; default_destination?: string }>;
				};
				const list = Array.isArray(body?.models) ? body.models : [];
				const entry = list.find((m) => (m.model_id ?? m.id) === modelId);
				if (entry && (entry.available === true || entry.installed === true)) {
					installed = true;
				} else if (!installed && autoPull) {
					const dlRes = await fetchFn(`${baseUrl}/v1/models/${encodeURIComponent(modelId)}/downloads`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							approved: true,
							...(entry?.default_destination ? { destination: entry.default_destination } : {}),
						}),
						signal: AbortSignal.timeout(10_000),
					});
					if (dlRes.ok || dlRes.status === 202) {
						autoPulled = true;
						installed = true;
					}
				}
			}
		} catch {
			// Server not running on 8090; fall back to CLI
		}
	}

	// 2. Check via CLI `models list` and auto-install via `models install <modelId> --yes` if missing
	if (!installed && runner.available) {
		try {
			const listOut = execFn(
				runner.command,
				[...runner.prefixArgs, "models", "list", "--models-dir", modelsDir],
				{
					encoding: "utf8",
					timeout: 5000,
					env: { ...env, GLINER_RUNNER_MODELS_DIR: modelsDir },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			if (listOut.includes(`"${modelId}"`) && (listOut.includes('"installed":true') || listOut.includes('"available":true'))) {
				installed = true;
			}
		} catch {
			// Proceed to install check
		}

		// Auto-pull decide-340m via CLI when missing
		if (!installed && autoPull) {
			try {
				execFn(
					runner.command,
					[...runner.prefixArgs, "models", "install", modelId, "--models-dir", modelsDir, "--yes"],
					{
						encoding: "utf8",
						timeout: 300_000,
						env: { ...env, GLINER_RUNNER_MODELS_DIR: modelsDir },
						stdio: ["ignore", "pipe", "pipe"],
					},
				);
				installed = true;
				autoPulled = true;
			} catch (err) {
				errorMsg = err instanceof Error ? err.message : String(err);
			}
		}
	}

	return {
		modelId,
		revision: DEFAULT_GLINER_MODEL_REVISION,
		installed,
		autoPulled,
		modelsDir,
		runnerAvailable: runner.available,
		runnerSource: runner.source,
		serverReachable,
		serverUrl: baseUrl,
		...(errorMsg ? { error: errorMsg } : {}),
	};
}

function initialToolsForRouting(playbook: PlaybookId, subSkill: WoodchipperSubSkill): string[] {
	if (subSkill === "woodchipper-js-web") {
		return [
			'analyze_javascript_application({ input_path: "<target>", detail: "summary" })',
			'inspect_analysis_view({ source: { kind: "retained-evidence", evidence_id: "<parent_evidence_id>" }, view: { kind: "page", collection: "modules" } })',
			'trace_application_feature({ application: { kind: "retained-evidence", evidence_id: "<parent_evidence_id>" }, seed: { type: "module-id", value: "<node_id>" }, direction: "outgoing" })',
		];
	}
	if (subSkill === "woodchipper-mobile-managed") {
		return [
			'inspect_android_package({ path: "<target>", detail: "summary" })',
			'inspect_managed_artifact({ path: "<target>", detail: "summary" })',
			'inspect_plist({ path: "<target>" })',
		];
	}
	if (subSkill === "woodchipper-firmware-signals" || playbook === "firmware-and-protocols") {
		return [
			'inspect_firmware_regions({ path: "<target>" })',
			'inspect_wasm_artifact({ path: "<target>", detail: "summary" })',
			'inspect_sqlite_database({ path: "<target>" })',
			'inspect_pcap_capture({ path: "<target>", detail: "summary" })',
		];
	}
	if (subSkill === "woodchipper-runtime") {
		return [
			"list_browser_targets({})",
			"list_electron_targets({})",
			"capture_process_scenario({ command: ... })",
		];
	}
	if (subSkill === "woodchipper-reconstruction" || playbook === "clean-room-and-porting") {
		return [
			"build_reconstruction_obligation_ledger({})",
			"analyze_function({ procedure: ... })",
			"verify_reconstruction({ ... })",
		];
	}
	if (subSkill === "woodchipper-audit" || playbook === "security-and-vr") {
		return [
			'inspect_binary_layout({ path: "<target>", detail: "summary" })',
			"inspect_recorded_crash({ path: ... })",
			"compare_functions({ ... })",
			"list_unknowns({})",
		];
	}
	return [
		'inspect_binary_layout({ path: "<target>", detail: "summary" })',
		'inspect_go_binary({ path: "<target>" })',
		'inspect_rust_binary({ path: "<target>" })',
		"open_binary({ path: \"<target>\" }) -> search_strings / search_procedures -> analyze_function",
	];
}

/**
 * Deterministic fallback intent classifier when GLiNER binary/server is offline.
 */
export function heuristicClassifyIntent(query: string): IntentClassificationResult {
	const lower = query.toLowerCase();

	const playbookScores: Record<PlaybookId, number> = {
		"triage-and-feature-trace": 0.35,
		"clean-room-and-porting": 0.15,
		"security-and-vr": 0.15,
		"firmware-and-protocols": 0.15,
	};

	if (/\b(vuln|security|audit|safe|backdoor|exploit|overflow|inject|crash|segfault|core dump|patch|diff|ioctl|driver|cve|trust boundary|sink)\b/.test(lower)) {
		playbookScores["security-and-vr"] += 0.65;
	}
	if (/\b(clone|rebuild|reimplement|clean[- ]?room|spec|port|wasm|webassembly|formula|algorithm|business rule|equivalent)\b/.test(lower)) {
		playbookScores["clean-room-and-porting"] += 0.65;
	}
	if (/\b(firmware|rom|mcu|iot|router|squashfs|pcap|packet|wireshark|sqlite|database|wire protocol|file format|sigrok|uart|spi|i2c|evm|solidity)\b/.test(lower)) {
		playbookScores["firmware-and-protocols"] += 0.65;
	}
	if (/\b(what does|how does|trace|feature|button|flag|triage|map|understand|phone home|overview|entry point)\b/.test(lower)) {
		playbookScores["triage-and-feature-trace"] += 0.45;
	}

	const subSkillScores: Record<WoodchipperSubSkill, number> = {
		"woodchipper-native": 0.3,
		"woodchipper-js-web": 0.1,
		"woodchipper-mobile-managed": 0.1,
		"woodchipper-firmware-signals": 0.1,
		"woodchipper-runtime": 0.1,
		"woodchipper-reconstruction": 0.1,
		"woodchipper-audit": 0.1,
	};

	if (/\b(electron|asar|javascript|js|bundle|webpack|vite|har|saz|browser|ipcmain|contextbridge)\b/.test(lower)) {
		subSkillScores["woodchipper-js-web"] += 0.65;
	}
	if (/\b(android|apk|jadx|flutter|dart|unity|il2cpp|godot|\.net|csharp|c#|mono|plist|ipa|\.app|nib|storyboard)\b/.test(lower)) {
		subSkillScores["woodchipper-mobile-managed"] += 0.65;
	}
	if (/\b(firmware|binwalk|wasm|evm|sqlite|\.db|pcap|tshark|sigrok|mcu)\b/.test(lower)) {
		subSkillScores["woodchipper-firmware-signals"] += 0.65;
	}
	if (/\b(live|attach|frida|gdb|lldb|cdp|runtime|dynamic|spawn|pty)\b/.test(lower)) {
		subSkillScores["woodchipper-runtime"] += 0.65;
	}
	if (/\b(clone|clean[- ]?room|port|reconstruct|obligation|verify_reconstruction)\b/.test(lower)) {
		subSkillScores["woodchipper-reconstruction"] += 0.6;
	}
	if (/\b(vuln|security|audit|crash|segfault|core dump|ioctl|driver|patch|diff|backdoor)\b/.test(lower)) {
		subSkillScores["woodchipper-audit"] += 0.6;
	}

	const normMap = <K extends string>(raw: Record<K, number>): Record<K, number> => {
		const total = Object.values<number>(raw).reduce((a, b) => a + b, 0) || 1;
		const out = {} as Record<K, number>;
		for (const [k, v] of Object.entries<number>(raw)) {
			out[k as K] = Number((v / total).toFixed(3));
		}
		return out;
	};

	const playbookProbabilities = normMap(playbookScores);
	const subSkillProbabilities = normMap(subSkillScores);

	const recommendedPlaybook = (Object.entries<number>(playbookProbabilities).sort((a, b) => b[1] - a[1])[0][0] ??
		"triage-and-feature-trace") as PlaybookId;
	const recommendedSubSkill = (Object.entries<number>(subSkillProbabilities).sort((a, b) => b[1] - a[1])[0][0] ??
		"woodchipper-native") as WoodchipperSubSkill;

	return {
		query,
		source: "heuristic-fallback",
		modelId: DEFAULT_GLINER_MODEL_ID,
		recommendedPlaybook,
		playbookConfidence: playbookProbabilities[recommendedPlaybook],
		playbookProbabilities,
		recommendedSubSkill,
		subSkillConfidence: subSkillProbabilities[recommendedSubSkill],
		subSkillProbabilities,
		initialReaTools: initialToolsForRouting(recommendedPlaybook, recommendedSubSkill),
		plainEnglishSummary: `Routed request to playbook '${recommendedPlaybook}' and skill '${recommendedSubSkill}'.`,
	};
}

/**
 * Classify a plain-English user reverse-engineering question into the best
 * Woodchipper Playbook and Sub-Skill using `gliner-runner` (`decide-340m`),
 * auto-pulling the model if needed and falling back cleanly when offline.
 */
export async function classifyReverseEngineeringIntent(
	query: string,
	options: {
		projectRoot?: string;
		modelId?: string;
		modelsDir?: string;
		baseUrl?: string;
		autoPullModel?: boolean;
		env?: NodeJS.ProcessEnv;
		fetchImpl?: typeof globalThis.fetch;
		execSyncImpl?: typeof execFileSync;
	} = {},
): Promise<IntentClassificationResult> {
	const trimmed = query.trim();
	if (!trimmed) {
		return heuristicClassifyIntent("triage binary");
	}

	const env = options.env ?? process.env;
	const modelId = options.modelId ?? env.WOODCHIPPER_GLINER_MODEL?.trim() ?? DEFAULT_GLINER_MODEL_ID;
	const baseUrl = (options.baseUrl ?? env.GLINER_RUNNER_URL?.trim() ?? DEFAULT_GLINER_BASE_URL).replace(/\/+$/, "");
	const fetchFn = options.fetchImpl ?? globalThis.fetch;
	const execFn = options.execSyncImpl ?? execFileSync;
	const isOffline = env.PI_OFFLINE === "1" || env.PI_OFFLINE === "true";

	// Ensure model is available (auto-pulls if gliner-runner is installed and model is missing)
	const status = await ensureGlinerModelInstalled({
		projectRoot: options.projectRoot,
		modelId,
		modelsDir: options.modelsDir,
		baseUrl,
		autoPull: options.autoPullModel,
		env,
		fetchImpl: fetchFn,
		execSyncImpl: execFn,
	});

	// 1. Prefer multi-task HTTP `/v1/infer` if gliner-runner server is reachable
	if (!isOffline && status.serverReachable && typeof fetchFn === "function") {
		try {
			const inferRes = await fetchFn(`${baseUrl}/v1/infer`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: modelId,
					backend: "onnx",
					precision: "fp32",
					operation: "classify",
					text: trimmed.slice(0, 2000),
					schema: {
						kind: "classification",
						tasks: {
							playbook: {
								labels: Object.keys(PLAYBOOK_LABEL_DESCRIPTIONS),
								label_descriptions: PLAYBOOK_LABEL_DESCRIPTIONS,
							},
							sub_skill: {
								labels: Object.keys(SUBSKILL_LABEL_DESCRIPTIONS),
								label_descriptions: SUBSKILL_LABEL_DESCRIPTIONS,
							},
						},
					},
				}),
				signal: AbortSignal.timeout(8000),
			});
			if (inferRes.ok) {
				const payload = (await inferRes.json()) as {
					output?: {
						playbook?: { value?: PlaybookId; confidence?: number; probabilities?: Record<PlaybookId, number> };
						sub_skill?: {
							value?: WoodchipperSubSkill;
							confidence?: number;
							probabilities?: Record<WoodchipperSubSkill, number>;
						};
					};
				};
				const pb = payload.output?.playbook;
				const sk = payload.output?.sub_skill;
				if (pb?.value && sk?.value) {
					return {
						query: trimmed,
						source: "gliner-http",
						modelId,
						recommendedPlaybook: pb.value,
						playbookConfidence: pb.confidence ?? 0.8,
						playbookProbabilities: pb.probabilities ?? ({ [pb.value]: pb.confidence ?? 0.8 } as Record<PlaybookId, number>),
						recommendedSubSkill: sk.value,
						subSkillConfidence: sk.confidence ?? 0.8,
						subSkillProbabilities:
							sk.probabilities ?? ({ [sk.value]: sk.confidence ?? 0.8 } as Record<WoodchipperSubSkill, number>),
						initialReaTools: initialToolsForRouting(pb.value, sk.value),
						plainEnglishSummary: `GLiNER (${modelId}) classified intent -> Playbook '${pb.value}' (${((pb.confidence ?? 0) * 100).toFixed(1)}%), Sub-Skill '${sk.value}' (${((sk.confidence ?? 0) * 100).toFixed(1)}%).`,
					};
				}
			}
		} catch {
			// Fall back to CLI or heuristic
		}
	}

	// 2. CLI `gliner-runner classify --json` when runner + model are installed locally
	if (status.runnerAvailable && status.installed) {
		const runner = resolveGlinerRunnerCommand(options.projectRoot, env);
		try {
			const pbDescribeArgs = Object.entries(PLAYBOOK_LABEL_DESCRIPTIONS).flatMap(([k, desc]) => [
				"--describe",
				`${k}=${desc}`,
			]);
			const pbOut = execFn(
				runner.command,
				[
					...runner.prefixArgs,
					"classify",
					"--model",
					modelId,
					"--models-dir",
					status.modelsDir,
					"--labels",
					Object.keys(PLAYBOOK_LABEL_DESCRIPTIONS).join(","),
					...pbDescribeArgs,
					"--json",
					trimmed.slice(0, 2000),
				],
				{
					encoding: "utf8",
					timeout: 15_000,
					env: { ...env, GLINER_RUNNER_MODELS_DIR: status.modelsDir },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);

			const skDescribeArgs = Object.entries(SUBSKILL_LABEL_DESCRIPTIONS).flatMap(([k, desc]) => [
				"--describe",
				`${k}=${desc}`,
			]);
			const skOut = execFn(
				runner.command,
				[
					...runner.prefixArgs,
					"classify",
					"--model",
					modelId,
					"--models-dir",
					status.modelsDir,
					"--labels",
					Object.keys(SUBSKILL_LABEL_DESCRIPTIONS).join(","),
					...skDescribeArgs,
					"--json",
					trimmed.slice(0, 2000),
				],
				{
					encoding: "utf8",
					timeout: 15_000,
					env: { ...env, GLINER_RUNNER_MODELS_DIR: status.modelsDir },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);

			const pbJson = JSON.parse(pbOut.trim()) as {
				category?: { value?: PlaybookId; confidence?: number; probabilities?: Record<PlaybookId, number> };
			};
			const skJson = JSON.parse(skOut.trim()) as {
				category?: {
					value?: WoodchipperSubSkill;
					confidence?: number;
					probabilities?: Record<WoodchipperSubSkill, number>;
				};
			};

			const pbVal = pbJson.category?.value;
			const skVal = skJson.category?.value;
			if (pbVal && skVal) {
				return {
					query: trimmed,
					source: "gliner-cli",
					modelId,
					recommendedPlaybook: pbVal,
					playbookConfidence: pbJson.category?.confidence ?? 0.8,
					playbookProbabilities:
						pbJson.category?.probabilities ?? ({ [pbVal]: pbJson.category?.confidence ?? 0.8 } as Record<PlaybookId, number>),
					recommendedSubSkill: skVal,
					subSkillConfidence: skJson.category?.confidence ?? 0.8,
					subSkillProbabilities:
						skJson.category?.probabilities ??
						({ [skVal]: skJson.category?.confidence ?? 0.8 } as Record<WoodchipperSubSkill, number>),
					initialReaTools: initialToolsForRouting(pbVal, skVal),
					plainEnglishSummary: `GLiNER CLI (${modelId}) classified intent -> Playbook '${pbVal}' (${((pbJson.category?.confidence ?? 0) * 100).toFixed(1)}%), Sub-Skill '${skVal}' (${((skJson.category?.confidence ?? 0) * 100).toFixed(1)}%).`,
				};
			}
		} catch {
			// Fall back to deterministic heuristic
		}
	}

	return heuristicClassifyIntent(trimmed);
}

/**
 * Classify binary strings, symbol names, or code snippets into reverse-engineering
 * capability buckets (`network_telemetry`, `filesystem_database`, `ipc_rpc`,
 * `crypto_auth`, `command_execution_sink`, `ui_entrypoint`, `protection_anti_debug`).
 */
export async function classifyBinarySignals(
	signals: readonly string[],
	options: {
		projectRoot?: string;
		modelId?: string;
		modelsDir?: string;
		baseUrl?: string;
		threshold?: number;
		autoPullModel?: boolean;
		env?: NodeJS.ProcessEnv;
		fetchImpl?: typeof globalThis.fetch;
		execSyncImpl?: typeof execFileSync;
	} = {},
): Promise<SignalClassificationResult> {
	const env = options.env ?? process.env;
	const modelId = options.modelId ?? env.WOODCHIPPER_GLINER_MODEL?.trim() ?? DEFAULT_GLINER_MODEL_ID;
	const baseUrl = (options.baseUrl ?? env.GLINER_RUNNER_URL?.trim() ?? DEFAULT_GLINER_BASE_URL).replace(/\/+$/, "");
	const threshold = options.threshold ?? 0.45;
	const fetchFn = options.fetchImpl ?? globalThis.fetch;
	const execFn = options.execSyncImpl ?? execFileSync;
	const isOffline = env.PI_OFFLINE === "1" || env.PI_OFFLINE === "true";

	const boundedSignals = signals.map((s) => s.trim()).filter(Boolean).slice(0, 32);

	const status = await ensureGlinerModelInstalled({
		projectRoot: options.projectRoot,
		modelId,
		modelsDir: options.modelsDir,
		baseUrl,
		autoPull: options.autoPullModel,
		env,
		fetchImpl: fetchFn,
		execSyncImpl: execFn,
	});

	if (!isOffline && status.serverReachable && typeof fetchFn === "function" && boundedSignals.length > 0) {
		try {
			const items: SignalClassificationItem[] = [];
			for (const sig of boundedSignals) {
				const res = await fetchFn(`${baseUrl}/v1/infer`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						model: modelId,
						backend: "onnx",
						precision: "fp32",
						operation: "classify",
						text: sig.slice(0, 1000),
						schema: {
							kind: "classification",
							tasks: {
								capabilities: {
									labels: Object.keys(CAPABILITY_LABEL_DESCRIPTIONS),
									label_descriptions: CAPABILITY_LABEL_DESCRIPTIONS,
									min_labels: 0,
									max_labels: 3,
									threshold,
								},
							},
						},
						options: { threshold },
					}),
					signal: AbortSignal.timeout(5000),
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = (await res.json()) as {
					output?: {
						capabilities?: {
							value?: CapabilityBucket[] | CapabilityBucket | null;
							probabilities?: Partial<Record<CapabilityBucket, number>>;
						};
					};
				};
				const rawVal = data.output?.capabilities?.value;
				const caps = Array.isArray(rawVal) ? rawVal : rawVal ? [rawVal] : [];
				items.push({
					signal: sig,
					capabilities: caps,
					probabilities: data.output?.capabilities?.probabilities ?? {},
				});
			}
			return {
				source: "gliner-http",
				modelId,
				items,
			};
		} catch {
			// Fall back below
		}
	}

	const items: SignalClassificationItem[] = boundedSignals.map((sig) => {
		const lower = sig.toLowerCase();
		const probs: Partial<Record<CapabilityBucket, number>> = {};
		const caps: CapabilityBucket[] = [];

		const rules: Array<[CapabilityBucket, RegExp]> = [
			["network_telemetry", /(?:http|https|socket|recv|send|connect|curl|fetch|websocket|tls|ssl|dns|mqtt|grpc|endpoint|telemetry)/],
			["filesystem_database", /(?:fopen|open|read|write|unlink|mkdir|sqlite|select\s+|insert\s+|plist|nsuserdefaults|fs\.|file)/],
			["ipc_rpc", /(?:ipcmain|ipcrenderer|contextbridge|xpc|mach_msg|binder|intent|pipe|dbus|rpc|ioctl)/],
			["crypto_auth", /(?:aes|rsa|sha256|sha512|hmac|pbkdf2|ed25519|decrypt|encrypt|cipher|token|secret|password|license|verify|sign)/],
			["command_execution_sink", /(?:execve|exec\s*\(|system|popen|createprocess|shellexecute|child_process|spawn|shell\.openexternal|memcpy|strcpy|sprintf|eval)/],
			["ui_entrypoint", /(?:window|button|menu|dialog|onclick|command|flag|argv|getopt|main|viewcontroller|activity)/],
			["protection_anti_debug", /(?:ptrace|isdebuggerpresent|sysctl|antidebug|vmcheck|crc32|integrity|obfuscate|packed|upx)/],
		];

		for (const [bucket, regex] of rules) {
			if (regex.test(lower)) {
				caps.push(bucket);
				probs[bucket] = 0.85;
			}
		}

		return {
			signal: sig,
			capabilities: caps,
			probabilities: probs,
		};
	});

	return {
		source: "heuristic-fallback",
		modelId,
		items,
	};
}

export type UserExpertiseLevel = "appliance-operator" | "practitioner" | "expert";

export interface ExpertiseAndFeedbackAssessment {
	expertiseLevel: UserExpertiseLevel;
	detectedDomainSignals: string[];
	personaGuidance: string;
	methodologyAdvisories: string[];
}

/**
 * Calibrate how Woodchipper communicates and pushes back:
 * - Defaults to `"appliance-operator"` when the user asks a plain-English question or drops a path,
 *   guiding them step-by-step and offering 2-3 clear next options.
 * - Adapts to `"practitioner"` or `"expert"` as the user demonstrates reverse-engineering fluency.
 * - Generates proactive methodology advisories whenever a user request (even from an expert)
 *   proposes a risky, premature, or suboptimal reverse-engineering step.
 */
export function assessExpertiseAndMethodologyFeedback(userPrompt: string): ExpertiseAndFeedbackAssessment {
	const trimmed = userPrompt.trim();
	const lower = trimmed.toLowerCase();

	const expertSignalPatterns: Array<[string, RegExp]> = [
		["hex-virtual-address", /\b0x[0-9a-f]{4,16}\b/i],
		["xrefs-callgraph", /\b(xrefs?|call\s*graph|callees?|callers?|vtable|plt|got)\b/i],
		["disassembler-engine", /\b(ghidra|hopper|ida\s*pro|rizin|radare2|objdump|jadx|apktool|binwalk|unblob)\b/i],
		["binary-format-internals", /\b(mach-o|elf\s*header|pt_load|pe32\+|rpath|lc_load_dylib|asar|il2cpp|nativeaot)\b/i],
		["kernel-or-ipc-internals", /\b(ioctl|irp_mj_device_control|driverentry|contextbridge|ipcmain|ipcrenderer|xpc)\b/i],
		["dynamic-instrumentation", /\b(frida|lldb|gdb|ptrace|breakpoint|objc_msgsend)\b/i],
	];

	const detectedDomainSignals: string[] = [];
	for (const [label, regex] of expertSignalPatterns) {
		if (regex.test(trimmed)) {
			detectedDomainSignals.push(label);
		}
	}

	let expertiseLevel: UserExpertiseLevel = "appliance-operator";
	if (detectedDomainSignals.length >= 2) {
		expertiseLevel = "expert";
	} else if (detectedDomainSignals.length === 1) {
		expertiseLevel = "practitioner";
	}

	const personaGuidance =
		expertiseLevel === "appliance-operator"
			? "Appliance Operator Mode (Default): The user has not used domain jargon. Act as an autonomous reverse-engineering appliance: select and run the right target-free REA tools automatically, explain what the target does in clear plain English backed by Evidence (`ev_*`), and end your response with 2-3 concrete 'What we can do next' options."
			: expertiseLevel === "practitioner"
				? `Practitioner Collaborator Mode (signals: ${detectedDomainSignals.join(", ")}): Balance clear architectural explanations with exact technical telemetry (addresses, node IDs, \`ev_*\` citations) and explain trade-offs when recommending next probes.`
				: `Expert Collaborator Mode (signals: ${detectedDomainSignals.join(", ")}): Communicate peer-to-peer with dense technical precision (virtual addresses, file offsets, calling conventions, CFG/value-flow facets, \`ev_*\` IDs), while still challenging any unsupported assumptions or suboptimal tool choices.`;

	const methodologyAdvisories: string[] = [];

	// Advisory 1: Premature dynamic execution / hooking before static reconnaissance
	if (
		/\b(frida|gdb|lldb|run\s+it|execute\s+it|launch\s+it|hook\s+|attach\s+to)\b/i.test(lower) &&
		!/\b(after\s+static|already\s+triaged|static\s+first)\b/i.test(lower)
	) {
		methodologyAdvisories.push(
			"Proactive Feedback (Static-Before-Dynamic): The user asked for runtime execution or dynamic hooking. Push back constructively: run fast target-free static reconnaissance (`woodchipper_triage`, `inspect_binary_layout`, `inspect_electron_fuses`, `search_strings`) FIRST to map entry points and check anti-debug/fuse restrictions before executing or attaching to the target.",
		);
	}

	// Advisory 2: Asking to decompile/dump everything at once
	if (/\b(decompile\s+all|decompile\s+everything|dump\s+all|all\s+functions|entire\s+binary|whole\s+binary)\b/i.test(lower)) {
		methodologyAdvisories.push(
			"Proactive Feedback (Summary-First vs. Whole-Binary Dump): The user asked to decompile or dump the entire target at once. Advise against whole-binary decompilation (which stalls on cold imports and overflows context); instead run `detail: \"summary\"`, narrow to high-value seeds via `search_strings` / `search_procedures` / `inspect_analysis_view`, and decompile only the governing functions.",
		);
	}

	// Advisory 3: Opening non-native or target-free containers in Ghidra/open_binary
	if (
		/\b(open_binary|ghidra|ida)\b/i.test(lower) &&
		/\b(\.asar|electron|javascript|\.apk|\.sqlite|\.db|\.wasm|\.plist|\.har)\b/i.test(lower)
	) {
		methodologyAdvisories.push(
			"Proactive Feedback (Target-Free Specialized Analyzer): The user suggested opening a JS/Electron, APK, SQLite, WASM, or Plist target in a native disassembler (`open_binary`/Ghidra). Advise using REA's built-in target-free analyzer (`analyze_javascript_application`, `inspect_android_package`, `inspect_sqlite_database`, `inspect_wasm_artifact`, `inspect_plist`) which is orders of magnitude faster and higher fidelity.",
		);
	}

	// Advisory 4: Conflating static strings/URLs with confirmed runtime behavior
	if (/\b(phones?\s+home\s+to|connects?\s+to|sends?\s+data\s+to|calls?\s+this\s+url|proves?\s+it\s+executes)\b/i.test(lower)) {
		methodologyAdvisories.push(
			"Proactive Feedback (Static String vs. Reachable Execution): Remind the user that presence of a URL, domain, or command string in a binary is only a static Observation. Verify reachability via `xrefs` -> `resolve_containing_procedure` -> `analyze_function` (or `trace_application_feature`) before concluding it executes at runtime.",
		);
	}

	return {
		expertiseLevel,
		detectedDomainSignals,
		personaGuidance,
		methodologyAdvisories,
	};
}

/**
 * Format the interactive orientation banner shown on startup and via `/start`.
 */
export function formatWoodchipperOrientationBanner(params: {
	activeModel?: string;
	glinerReady?: boolean;
}): string {
	return [
		"## Welcome to Woodchipper — Autonomous Reverse-Engineering Appliance",
		"",
		"You do **not** need reverse-engineering experience to use Woodchipper. Drop any file path or ask in plain English, and Woodchipper will automatically select the right static/dynamic analyzers, protect context with summary-first paging, and separate confirmed **Observations** (`ev_*`) from **Inferences** and **Unknowns**.",
		"",
		"### Where to Start (Pick Any)",
		'- **Plain English (Appliance Mode):** Just ask, e.g. *"What is `/path/to/binary` and does it phone home?"*, *"How does the license check or export button work?"*, or *"Is this driver safe?"*',
		"- **Guided Intake (`/start <path>`):** Run `/start /path/to/target` and Woodchipper will fingerprint the file, explain what it is in plain English, and give you 3 tailored investigation choices.",
		"- **Expert Shortcuts:** `/triage <path>` | `/trace <path> <feature>` | `/audit <path>` | `/clone-spec <path>` | `/ledger` | `/doctor` | `/maximal` | `/gliner`",
		"",
		`_Active Model: \`${params.activeModel ?? "maximal/claude-sonnet-5-5-20260301"}\` (auto-failover enabled) • GLiNER \`decide-340m\` Intent Router: \`${params.glinerReady ? "ready" : "active (auto-pull on demand)"}\`_`,
	].join("\n");
}

/**
 * Render width-safe lines for the custom Woodchipper TUI Header (`ctx.ui.setHeader`).
 */
export function renderWoodchipperHeaderLines(
	width: number,
	params: {
		getActiveModel: () => string;
		getWorkspaceSlug: () => string;
		getReportPath: () => string;
	},
	theme?: {
		fg?: (color: string, text: string) => string;
		bold?: (text: string) => string;
	},
): string[] {
	const safeWidth = Math.max(40, width || 80);
	const innerWidth = Math.max(36, Math.min(safeWidth - 4, 96));

	const padOrClip = (plain: string): string => {
		const clipped = plain.length > innerWidth ? `${plain.slice(0, innerWidth - 1)}…` : plain;
		return `${clipped}${" ".repeat(Math.max(0, innerWidth - clipped.length))}`;
	};

	const fg = (color: string, text: string) => (theme?.fg ? theme.fg(color, text) : text);
	const bold = (text: string) => (theme?.bold ? theme.bold(text) : text);

	const topTitle = " WOODCHIPPER • Reverse-Engineering Appliance ";
	const topDashCount = Math.max(2, innerWidth + 2 - topTitle.length);
	const topBorder = fg("accent", `╭─${bold(topTitle)}${"─".repeat(topDashCount - 1)}╮`);
	const bottomBorder = fg("accent", `╰${"─".repeat(innerWidth + 2)}╯`);

	const boxRow = (plainText: string, tone?: "dim" | "accent" | "muted") => {
		const content = padOrClip(plainText);
		const styled = tone ? fg(tone, content) : content;
		return `${fg("accent", "│")} ${styled} ${fg("accent", "│")}`;
	};

	const modelLabel = params.getActiveModel();
	const wsSlug = params.getWorkspaceSlug();
	const reportRel = `workspaces/${wsSlug}/REPORT.md`;

	return [
		topBorder,
		boxRow(`Model: ${modelLabel} (auto-failover)  •  Engine: REA 6.7.0 (207 tools) + GLiNER decide-340m`),
		boxRow(`Output: ${reportRel}  (isolated per target • never commingled)`, "muted"),
		boxRow(""),
		boxRow("Drop any file path or ask in plain English — no reverse-engineering jargon required:"),
		boxRow('  • "What is /path/to/app and does it phone home?"', "dim"),
		boxRow('  • "How does the license check or export button work in /path/to/binary?"', "dim"),
		boxRow('  • "Audit /path/to/driver.sys for unsafe inputs or command execution sinks"', "dim"),
		boxRow(""),
		boxRow("Commands: /start <path> • /triage • /trace • /audit • /clone-spec • /ledger • /maximal • /doctor", "muted"),
		bottomBorder,
	];
}
