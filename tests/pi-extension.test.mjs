import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import woodchipperReaExtension, {
	HIGH_VOLUME_REA_TOOLS,
	MAX_REA_TOOL_RESULT_CHARS,
	capOversizedReaToolText,
	checkDestructiveGitCommand,
	isHighVolumeReaTool,
	isReaTool,
	normalizeReaToolInput,
} from "../.pi/extensions/woodchipper-rea.ts";
import {
	EvidenceLedger,
	ensureWorkspacesRootGitignored,
	listExistingWorkspaces,
} from "../.pi/extensions/lib/evidence-ledger.ts";
import {
	assessExpertiseAndMethodologyFeedback,
	classifyBinarySignals,
	classifyReverseEngineeringIntent,
	defaultGlinerModelsDir,
	ensureGlinerModelInstalled,
	formatWoodchipperOrientationBanner,
	renderWoodchipperHeaderLines,
	stripAnsi,
} from "../.pi/extensions/lib/gliner-classifier.ts";
import {
	PLAYBOOK_CATALOG,
	resolveReaProviderEnv,
	runReaDoctorSummary,
	runStaticTriage,
} from "../.pi/extensions/lib/triage.ts";
import {
	buildWoodchipperPiArgs,
	extractWorkspaceCliFlag,
	initializeActiveWorkspace,
} from "../bin/woodchipper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function createMockPiApi() {
	const state = {
		mcpServers: new Map(),
		tools: new Map(),
		commands: new Map(),
		handlers: new Map(),
		sentUserMessages: [],
		sentMessages: [],
	};

	const pi = {
		registerMcpServer(name, config) {
			state.mcpServers.set(name, config);
		},
		unregisterMcpServer(name) {
			state.mcpServers.delete(name);
		},
		getMcpServers() {
			return [...state.mcpServers.entries()].map(([name, config]) => ({ name, config }));
		},
		registerTool(tool) {
			state.tools.set(tool.name, tool);
		},
		registerCommand(name, options) {
			state.commands.set(name, { name, ...options });
		},
		on(event, handler) {
			const list = state.handlers.get(event) ?? [];
			list.push(handler);
			state.handlers.set(event, list);
			return () => {};
		},
		sendUserMessage(content, options) {
			state.sentUserMessages.push({ content, options });
		},
		sendMessage(message, options) {
			state.sentMessages.push({ message, options });
		},
	};

	return { pi, state };
}

test("registers REA MCP server, 3 custom tools, 6 slash commands, and lifecycle hooks using isolated WOODCHIPPER_PROJECT_ROOT", () => {
	const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "wc-rea-proj-"));
	const prevEnv = process.env.WOODCHIPPER_PROJECT_ROOT;
	process.env.WOODCHIPPER_PROJECT_ROOT = tmpProject;
	try {
		const { pi, state } = createMockPiApi();
		woodchipperReaExtension(pi);

		// 1. REA MCP server registration (spawns node directly on rea.mjs, bypassing pnpm exec)
		assert.ok(state.mcpServers.has("rea"), "Expected 'rea' MCP server to be registered");
		const reaConfig = state.mcpServers.get("rea");
		assert.equal(reaConfig.command, process.execPath);
		assert.equal(reaConfig.args.length, 2);
		assert.match(reaConfig.args[0], /rea\.mjs$/);
		assert.equal(reaConfig.args[1], "mcp");
		assert.equal(reaConfig.cwd, tmpProject);

		// 2. Custom model-callable tools
		for (const toolName of ["woodchipper_ledger", "woodchipper_triage", "woodchipper_playbook"]) {
			assert.ok(state.tools.has(toolName), `Expected custom tool '${toolName}' to be registered`);
		}

		// 3. Slash commands
		for (const cmdName of ["start", "status", "exit", "gliner", "triage", "trace", "clone-spec", "audit", "ledger", "doctor"]) {
			assert.ok(state.commands.has(cmdName), `Expected slash command '/${cmdName}' to be registered`);
		}

		// 4. Lifecycle hooks
		for (const hook of ["tool_call", "user_bash", "tool_result", "before_agent_start"]) {
			assert.ok(state.handlers.has(hook), `Expected event handler '${hook}' to be registered`);
		}
	} finally {
		if (prevEnv === undefined) {
			delete process.env.WOODCHIPPER_PROJECT_ROOT;
		} else {
			process.env.WOODCHIPPER_PROJECT_ROOT = prevEnv;
		}
		fs.rmSync(tmpProject, { recursive: true, force: true });
	}
});

test("tool_call & user_bash hooks default detail='summary' on high-volume REA tools and block destructive git bypasses", async () => {
	const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "wc-rea-git-"));
	const prevEnv = process.env.WOODCHIPPER_PROJECT_ROOT;
	process.env.WOODCHIPPER_PROJECT_ROOT = tmpProject;
	try {
		const { pi, state } = createMockPiApi();
		woodchipperReaExtension(pi);
		const toolCallHandler = state.handlers.get("tool_call")[0];
		const userBashHandler = state.handlers.get("user_bash")[0];
		const ctx = { hasUI: false, ui: { notify() {} } };

		for (const baseName of HIGH_VOLUME_REA_TOOLS) {
			for (const prefix of ["", "mcp__rea__", "rea_"]) {
				const fullName = `${prefix}${baseName}`;
				assert.equal(isHighVolumeReaTool(fullName), true, `Expected ${fullName} to be recognized as high-volume`);

				const eventOmitted = { type: "tool_call", toolCallId: "tc_1", toolName: fullName, input: { path: "/tmp/app.asar" } };
				const res1 = await toolCallHandler(eventOmitted, ctx);
				assert.equal(res1, undefined);
				assert.equal(eventOmitted.input.detail, "summary", `Expected ${fullName} to default detail='summary'`);

				const eventExplicit = {
					type: "tool_call",
					toolCallId: "tc_2",
					toolName: fullName,
					input: { path: "/tmp/app.asar", detail: "full" },
				};
				await toolCallHandler(eventExplicit, ctx);
				assert.equal(eventExplicit.input.detail, "full", "Explicit detail level should not be overwritten");
			}
		}

		// REA 6.7.0 parameter alias normalization (path -> input_path / capture_path, parent_evidence_id -> source)
		const jsCall = {
			type: "tool_call",
			toolCallId: "tc_norm_js",
			toolName: "mcp__rea__analyze_javascript_application",
			input: { path: "/tmp/app.asar" },
		};
		await toolCallHandler(jsCall, ctx);
		assert.equal(jsCall.input.input_path, "/tmp/app.asar");
		assert.equal(jsCall.input.path, undefined);
		assert.equal(jsCall.input.detail, "summary");

		const captureCall = {
			type: "tool_call",
			toolCallId: "tc_norm_cap",
			toolName: "inspect_web_network_capture",
			input: { path: "/tmp/session.har" },
		};
		await toolCallHandler(captureCall, ctx);
		assert.equal(captureCall.input.capture_path, "/tmp/session.har");
		assert.equal(captureCall.input.path, undefined);
		assert.equal(captureCall.input.detail, "summary");

		const viewCall = {
			type: "tool_call",
			toolCallId: "tc_norm_view",
			toolName: "mcp__rea__inspect_analysis_view",
			input: { parent_evidence_id: "ev_parent_123", view: { kind: "page", collection: "modules" } },
		};
		await toolCallHandler(viewCall, ctx);
		assert.deepEqual(viewCall.input.source, { kind: "retained-evidence", evidence_id: "ev_parent_123" });
		assert.equal(viewCall.input.parent_evidence_id, undefined);
		assert.ok(typeof normalizeReaToolInput === "function");

		// Destructive git command blocking including bypass patterns (-C, quotes, line continuations, restore, checkout -f, switch -f, stash drop)
		const badCmds = [
			["git", "reset", "--" + "hard", "HEAD~1"].join(" "),
			["git", "-C", "/tmp/repo", "reset", "--" + "hard"].join(" "),
			["git", "reset", '"--' + 'hard"'].join(" "),
			["git", "reset", "\\\n--" + "hard"].join(" "),
			["git", "clean", "-fd"].join(" "),
			["git", "clean", "--force"].join(" "),
			["git", "checkout", "--", "README.md"].join(" "),
			["git", "checkout", "HEAD", "--", "src/index.ts"].join(" "),
			["git", "checkout", "-f", "main"].join(" "),
			["git", "checkout", "."].join(" "),
			["git", "restore", "src/index.ts"].join(" "),
			["git", "restore", "."].join(" "),
			["git", "restore", "-S", "-W", "src/index.ts"].join(" "),
			["git", "switch", "-f", "main"].join(" "),
			["git", "switch", "--discard-changes", "main"].join(" "),
			["git", "stash", "drop"].join(" "),
			["git", "stash", "clear"].join(" "),
		];
		for (const cmd of badCmds) {
			assert.ok(checkDestructiveGitCommand(cmd), `Expected '${cmd}' to be flagged as destructive`);
			const res = await toolCallHandler(
				{ type: "tool_call", toolCallId: "tc_git", toolName: "bash", input: { command: cmd } },
				ctx,
			);
			assert.equal(res?.block, true, `Expected bash tool_call for '${cmd}' to be blocked`);

			const bashRes = await userBashHandler({ type: "user_bash", command: cmd }, ctx);
			assert.equal(bashRes?.result?.exitCode, 1, `Expected user_bash for '${cmd}' to return exitCode 1`);
		}

		// Safe git commands allowed (including git restore --staged)
		const safeCmds = [
			"git status",
			"git diff",
			"git restore --staged README.md",
			"git restore -S README.md",
			"git switch main",
			"git reset --keep HEAD~1",
			"git reset --soft HEAD~1",
		];
		for (const safeCmd of safeCmds) {
			assert.equal(checkDestructiveGitCommand(safeCmd), null, `Expected '${safeCmd}' to be allowed`);
			const safeRes = await toolCallHandler(
				{ type: "tool_call", toolCallId: "tc_safe", toolName: "bash", input: { command: safeCmd } },
				ctx,
			);
			assert.equal(safeRes, undefined);
		}
	} finally {
		if (prevEnv === undefined) {
			delete process.env.WOODCHIPPER_PROJECT_ROOT;
		} else {
			process.env.WOODCHIPPER_PROJECT_ROOT = prevEnv;
		}
		fs.rmSync(tmpProject, { recursive: true, force: true });
	}
	// REA 6.7.0 parameter alias normalization (path -> input_path / capture_path, parent_evidence_id -> source)
	const jsInput = { path: "/tmp/app.asar" };
	normalizeReaToolInput("mcp__rea__analyze_javascript_application", jsInput);
	assert.equal(jsInput.input_path, "/tmp/app.asar");
	assert.equal(jsInput.path, undefined);

	const capInput = { path: "/tmp/session.har" };
	normalizeReaToolInput("inspect_web_network_capture", capInput);
	assert.equal(capInput.capture_path, "/tmp/session.har");
	assert.equal(capInput.path, undefined);

	const viewInput = { parent_evidence_id: "ev_parent_123", view: { kind: "page", collection: "modules" } };
	normalizeReaToolInput("mcp__rea__inspect_analysis_view", viewInput);
	assert.deepEqual(viewInput.source, { kind: "retained-evidence", evidence_id: "ev_parent_123" });
	assert.equal(viewInput.parent_evidence_id, undefined);
});

test("tool_result hook only scrapes ev_* IDs from REA tools and ignores built-in read/bash/grep tools", async () => {
	const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "wc-rea-scrape-"));
	const prevEnv = process.env.WOODCHIPPER_PROJECT_ROOT;
	process.env.WOODCHIPPER_PROJECT_ROOT = tmpProject;
	try {
		const { pi, state } = createMockPiApi();
		woodchipperReaExtension(pi);
		const toolResultHandler = state.handlers.get("tool_result")[0];

		assert.equal(isReaTool("read"), false);
		assert.equal(isReaTool("bash"), false);
		assert.equal(isReaTool("grep"), false);
		assert.equal(isReaTool("woodchipper_ledger"), false);
		assert.equal(isReaTool("mcp__rea__inspect_macho"), true);
		assert.equal(isReaTool("analyze_javascript_application"), true);

		// Non-REA tool output containing ev_fake_doc_token must NOT be recorded
		await toolResultHandler({
			type: "tool_result",
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "Documentation example: ev_fake_doc_token_123" }],
			details: {},
		});

		const ledger = new EvidenceLedger(tmpProject);
		assert.equal(ledger.getCounts().evidenceIds, 0, "Built-in read tool must not pollute Evidence Ledger");

		// REA tool output MUST be recorded
		await toolResultHandler({
			type: "tool_result",
			toolName: "mcp__rea__inspect_macho",
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ evidence_id: "ev_macho_header_001" }) }],
			details: {},
		});

		ledger.reload();
		assert.equal(ledger.getCounts().evidenceIds, 1);
		assert.ok(ledger.getData().trackedEvidenceIds.ev_macho_header_001);

		// Oversized REA tool result is capped to MAX_REA_TOOL_RESULT_CHARS while preserving ev_* IDs
		const hugePayload = `{"evidence_id":"ev_huge_999","data":"${"A".repeat(MAX_REA_TOOL_RESULT_CHARS + 5000)}"}`;
		const cappedRes = await toolResultHandler({
			type: "tool_result",
			toolName: "mcp__rea__search_strings",
			isError: false,
			content: [{ type: "text", text: hugePayload }],
			details: {},
		});
		assert.equal(cappedRes?.details?.woodchipperTruncatedForContextBudget, true);
		assert.ok(cappedRes?.content?.[0]?.text.includes("Woodchipper Context Guardrail"));
		assert.ok(cappedRes?.content?.[0]?.text.includes("ev_huge_999"));
		assert.ok(cappedRes?.content?.[0]?.text.length < hugePayload.length);
		assert.ok(typeof capOversizedReaToolText === "function");
	} finally {
		if (prevEnv === undefined) {
			delete process.env.WOODCHIPPER_PROJECT_ROOT;
		} else {
			process.env.WOODCHIPPER_PROJECT_ROOT = prevEnv;
		}
		fs.rmSync(tmpProject, { recursive: true, force: true });
	}
});

test("EvidenceLedger extracts ev_* IDs, generates monotonic IDs, backs up corrupt JSON, and persists atomically", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "woodchipper-ledger-test-"));
	try {
		const ledger = new EvidenceLedger(tmpDir);
		const extracted = ledger.extractFromToolResult(
			"analyze_javascript_application",
			[
				JSON.stringify({
					evidence_id: "ev_js_bundle_001",
					parent_evidence_id: "ev_js_root_000",
					modules: [{ node_id: "mod_1", evidence_id: "ev_js_mod_002" }],
				}),
			],
		);
		assert.equal(extracted.length, 3);
		assert.equal(ledger.getCounts().evidenceIds, 3);

		const obs1 = ledger.addObservation({
			evidenceId: "ev_js_bundle_001",
			location: "mod_main:0x10",
			summary: "Electron ipcMain.handle('run-task') registered",
			toolName: "analyze_javascript_application",
		});
		assert.equal(obs1.id, "obs_1");

		// Simulate out-of-order/deleted IDs to verify monotonic ID generation
		ledger.getData().observations = [{ ...obs1, id: "obs_5" }];
		const obsNext = ledger.addObservation({
			evidenceId: "ev_js_mod_002",
			location: "mod_1:0x20",
			summary: "Second observation after gap",
		});
		assert.equal(obsNext.id, "obs_6", "Expected monotonic ID obs_6 after obs_5");

		ledger.addInference({
			statement: "Renderer can invoke privileged shell execution via run-task",
			confidence: "high",
			supportingEvidenceIds: ["ev_js_bundle_001"],
			competingExplanations: ["Preload script may filter channel arguments"],
		});
		const unk = ledger.addUnknown({
			description: "Preload argument sanitizer in preload.bundle.js",
			reason: "Module page 2 not yet inspected",
			nextProbe: "inspect_analysis_view on preload.bundle.js",
		});

		const md = ledger.formatMarkdownReport();
		assert.match(md, /ev_js_bundle_001/);
		assert.match(md, /obs_6/);
		assert.match(md, /inf_1/);
		assert.match(md, /unk_1/);

		ledger.resolveUnknown(unk.id);
		assert.equal(ledger.getCounts().unresolvedUnknowns, 0);

		// Reload from disk to verify persistence
		const reloaded = new EvidenceLedger(tmpDir);
		assert.equal(reloaded.getCounts().evidenceIds, 3);
		assert.equal(reloaded.getCounts().observations, 2);
		assert.equal(reloaded.getCounts().inferences, 1);
		assert.equal(reloaded.getCounts().unknowns, 1);

		// Corrupt ledger file and verify backup is created on load
		fs.writeFileSync(ledger.getLedgerPath(), "{broken json", "utf8");
		const recovered = new EvidenceLedger(tmpDir);
		assert.equal(recovered.getCounts().observations, 0);
		const files = fs.readdirSync(path.dirname(ledger.getLedgerPath()));
		assert.ok(files.some((f) => f.includes(".corrupt.")), "Expected corrupt ledger backup file to be created");
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("runStaticTriage handles option-like filenames (--help) safely and skips hashing non-regular files", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-triage-edge-"));
	try {
		// Create a file starting with a dash to verify `--` separator prevents option injection
		const dashFile = path.join(tmpDir, "-n-weird.js");
		fs.writeFileSync(dashFile, "console.log('hello');\n", "utf8");
		const res = runStaticTriage(dashFile, tmpDir);
		assert.equal(res.exists, true);
		assert.equal(res.isDirectory, false);
		assert.match(res.sha256, /^[a-f0-9]{64}$/);
		assert.equal(res.recommendedSubSkill, "woodchipper-js-web");

		// Directory triage does not attempt to SHA-256 hash directory
		const dirRes = runStaticTriage(tmpDir, tmpDir);
		assert.equal(dirRes.exists, true);
		assert.equal(dirRes.isDirectory, true);
		assert.equal(dirRes.sha256, null);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("woodchipper_triage, woodchipper_playbook, slash commands, and before_agent_start enrichment work end-to-end", async () => {
	const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "wc-e2e-proj-"));
	const prevEnv = process.env.WOODCHIPPER_PROJECT_ROOT;
	process.env.WOODCHIPPER_PROJECT_ROOT = ROOT;
	try {
		const { pi, state } = createMockPiApi();
		woodchipperReaExtension(pi);

		// Triage on package.json / JS file
		const triageTool = state.tools.get("woodchipper_triage");
		const triageResult = await triageTool.execute("call_1", { path: "scripts/validate.mjs" }, undefined, undefined, {
			cwd: ROOT,
		});
		assert.equal(triageResult.details.exists, true);
		assert.equal(triageResult.details.recommendedSubSkill, "woodchipper-js-web");
		assert.match(triageResult.details.sha256, /^[a-f0-9]{64}$/);

		// Playbook tool list & load
		const playbookTool = state.tools.get("woodchipper_playbook");
		const listRes = await playbookTool.execute("call_2", { action: "list" });
		assert.equal(listRes.details.playbooks.length, 4);

		for (const pb of PLAYBOOK_CATALOG) {
			const loadRes = await playbookTool.execute("call_3", { action: "load", playbook: pb.id });
			assert.equal(loadRes.details.found, true);
			assert.ok(loadRes.content[0].text.length > 500);
		}

		// Slash command /triage injects prompt
		const triageCmd = state.commands.get("triage");
		await triageCmd.handler("scripts/validate.mjs", {
			cwd: ROOT,
			hasUI: false,
			ui: { notify() {} },
		});
		assert.equal(state.sentUserMessages.length, 1);
		assert.match(state.sentUserMessages[0].content, /woodchipper-js-web/);

		// System prompt enrichment via before_agent_start
		const beforeStartHandler = state.handlers.get("before_agent_start")[0];
		const fakeEvent = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "Analyze target",
			systemPrompt: "Base prompt",
			systemPromptOptions: {
				cwd: ROOT,
				selectedTools: ["read", "bash"],
				hiddenTools: [],
				toolSnippets: {},
				toolGuidelines: {},
				promptGuidelines: [],
				appendSystemPrompt: "",
				sections: {},
				contextFiles: [],
				skills: [],
			},
		};
		await beforeStartHandler(fakeEvent, {});
		assert.ok(fakeEvent.systemPromptOptions.sections.woodchipper_discipline);
		assert.match(fakeEvent.systemPromptOptions.sections.woodchipper_discipline, /Three-Bucket Epistemology/);
		assert.match(fakeEvent.systemPromptOptions.sections.woodchipper_discipline, /Summary-First Context Protection/);

		// Doctor summary check
		const doc = runReaDoctorSummary(ROOT);
		assert.equal(doc.reaVersion, "6.7.0");
		assert.ok(doc.backends.length >= 7);

		// /status command emits comprehensive operational dashboard
		const statusCmd = state.commands.get("status");
		await statusCmd.handler("", {
			cwd: ROOT,
			mode: "tui",
			hasUI: false,
			model: { provider: "maximal", id: "claude-sonnet-5-5-20260301", contextWindow: 200000 },
			thinkingLevel: "high",
			getContextUsage() {
				return { tokens: 12400, contextWindow: 200000, percent: 6.2 };
			},
			ui: { notify() {} },
		});
		const statusMsg = state.sentMessages.find((m) => m.message.customType === "woodchipper-status");
		assert.ok(statusMsg, "Expected /status to emit woodchipper-status message");
		assert.match(statusMsg.message.content, /SESSION & RUNTIME/);
		assert.match(statusMsg.message.content, /ACTIVE MODEL & PROVIDER/);
		assert.match(statusMsg.message.content, /Working Dir/);
		assert.match(statusMsg.message.content, /Output Dir/);
		assert.match(statusMsg.message.content, /12,400 \/ 200,000 tokens/);

		// /exit command invokes ctx.shutdown()
		let shutdownCalled = false;
		const exitCmd = state.commands.get("exit");
		await exitCmd.handler("", {
			shutdown() {
				shutdownCalled = true;
			},
		});
		assert.equal(shutdownCalled, true, "Expected /exit to call ctx.shutdown()");
	} finally {
		if (prevEnv === undefined) {
			delete process.env.WOODCHIPPER_PROJECT_ROOT;
		} else {
			process.env.WOODCHIPPER_PROJECT_ROOT = prevEnv;
		}
		fs.rmSync(tmpProject, { recursive: true, force: true });
	}
});

test("gliner-classifier auto-pulls decide-340m when missing and classifies plain-English intent & binary signals", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-gliner-test-"));
	try {
		const fakeBin = path.join(tmpDir, "fake-gliner-runner");
		fs.writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n", "utf8");
		fs.chmodSync(fakeBin, 0o755);

		const modelsDir = path.join(tmpDir, "models");
		const invokedCommands = [];

		const mockExecSync = (_cmd, args) => {
			invokedCommands.push(args);
			if (args[0] === "models" && args[1] === "list") {
				return JSON.stringify({ models: [{ model_id: "decide-340m", installed: false }] });
			}
			if (args[0] === "models" && args[1] === "install") {
				return JSON.stringify({ model_id: "decide-340m", installed: true });
			}
			if (args[0] === "classify") {
				const labelsIdx = args.indexOf("--labels");
				const labelsStr = labelsIdx >= 0 ? args[labelsIdx + 1] : "";
				if (labelsStr.includes("security-and-vr")) {
					return JSON.stringify({
						category: {
							value: "security-and-vr",
							confidence: 0.94,
							probabilities: { "security-and-vr": 0.94, "triage-and-feature-trace": 0.06 },
						},
					});
				}
				return JSON.stringify({
					category: {
						value: "woodchipper-audit",
						confidence: 0.91,
						probabilities: { "woodchipper-audit": 0.91, "woodchipper-native": 0.09 },
					},
				});
			}
			return "{}";
		};

		// 1. Verify ensureGlinerModelInstalled detects missing decide-340m and auto-pulls with --yes
		const status = await ensureGlinerModelInstalled({
			projectRoot: ROOT,
			modelsDir,
			autoPull: true,
			env: { WOODCHIPPER_GLINER_BIN: fakeBin },
			fetchImpl: async () => {
				throw new Error("offline server");
			},
			execSyncImpl: mockExecSync,
		});
		assert.equal(status.installed, true, "Expected decide-340m to be marked installed after auto-pull");
		assert.equal(status.autoPulled, true, "Expected decide-340m to be auto-pulled when missing");
		assert.ok(
			invokedCommands.some((a) => a[0] === "models" && a[1] === "install" && a.includes("decide-340m") && a.includes("--yes")),
			"Expected `gliner-runner models install decide-340m --yes` to be invoked",
		);

		// 2. Verify classifyReverseEngineeringIntent via CLI
		const intentRes = await classifyReverseEngineeringIntent("Is this Windows kernel driver safe or does it have an IOCTL overflow?", {
			projectRoot: ROOT,
			modelsDir,
			env: { WOODCHIPPER_GLINER_BIN: fakeBin },
			fetchImpl: async () => {
				throw new Error("offline server");
			},
			execSyncImpl: mockExecSync,
		});
		assert.equal(intentRes.source, "gliner-cli");
		assert.equal(intentRes.recommendedPlaybook, "security-and-vr");
		assert.equal(intentRes.recommendedSubSkill, "woodchipper-audit");

		// 3. Verify classifyBinarySignals heuristic fallback when offline
		const sigRes = await classifyBinarySignals(
			["https://telemetry.example.com/v1/collect", "ipcMain.handle('run-command')", "child_process.exec", "sqlite3_prepare_v2"],
			{
				projectRoot: ROOT,
				env: { PI_OFFLINE: "1" },
			},
		);
		assert.equal(sigRes.items.length, 4);
		assert.ok(sigRes.items[0].capabilities.includes("network_telemetry"));
		assert.ok(sigRes.items[1].capabilities.includes("ipc_rpc"));
		assert.ok(sigRes.items[2].capabilities.includes("command_execution_sink"));
		assert.ok(sigRes.items[3].capabilities.includes("filesystem_database"));

		// 4. Verify adaptive operator-to-expert calibration & proactive methodology pushback
		const operatorAssess = assessExpertiseAndMethodologyFeedback("What is /tmp/mystery-app and does it phone home to a server?");
		assert.equal(operatorAssess.expertiseLevel, "appliance-operator");
		assert.ok(operatorAssess.methodologyAdvisories.some((a) => a.includes("Static String vs. Reachable Execution")));

		const expertAssess = assessExpertiseAndMethodologyFeedback(
			"Attach Frida to 0x100004a20 and decompile all functions in this Electron app.asar using Ghidra",
		);
		assert.equal(expertAssess.expertiseLevel, "expert");
		assert.ok(expertAssess.methodologyAdvisories.some((a) => a.includes("Static-Before-Dynamic")));
		assert.ok(expertAssess.methodologyAdvisories.some((a) => a.includes("Summary-First vs. Whole-Binary Dump")));
		assert.ok(expertAssess.methodologyAdvisories.some((a) => a.includes("Target-Free Specialized Analyzer")));

		const banner = formatWoodchipperOrientationBanner({ activeModel: "maximal/claude-sonnet-5-5-20260301", glinerReady: true });
		assert.match(banner, /Autonomous Reverse-Engineering Appliance/);
		assert.match(banner, /\/start/);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("workspaces isolate findings per target and never leak into global XDG or ~/.pi/agent/sessions", () => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wc-workspace-iso-"));
	try {
		const ledger = new EvidenceLedger(tmpRoot);

		// 1. Switch to Project A and record an observation
		const wsA = ledger.setTargetWorkspace("/opt/targets/project-alpha/app.asar");
		assert.match(wsA.workspaceSlug, /^app\.asar-[a-f0-9]{8}$/);
		assert.equal(wsA.reportPath, path.join(tmpRoot, "workspaces", wsA.workspaceSlug, "REPORT.md"));
		assert.equal(wsA.ledgerPath, path.join(tmpRoot, "workspaces", wsA.workspaceSlug, "evidence-ledger.json"));
		ledger.addObservation({
			evidenceId: "ev_alpha_001",
			location: "main.js:10",
			summary: "Project Alpha IPC handler",
		});
		assert.equal(ledger.getCounts().observations, 1);
		assert.equal(fs.existsSync(wsA.reportPath), true);

		// 2. Switch to Project B and verify zero commingling with Project A
		const wsB = ledger.setTargetWorkspace("/opt/targets/project-beta/firmware.bin");
		assert.match(wsB.workspaceSlug, /^firmware\.bin-[a-f0-9]{8}$/);
		assert.notEqual(wsA.workspaceDir, wsB.workspaceDir);
		assert.equal(ledger.getCounts().observations, 0, "Project Beta workspace must not commingle Project Alpha observations");
		ledger.addObservation({
			evidenceId: "ev_beta_999",
			location: "0x08000100",
			summary: "Project Beta reset vector",
		});
		assert.equal(ledger.getCounts().observations, 1);

		// 3. Switch back to Project A and verify its state was preserved intact
		ledger.setTargetWorkspace("/opt/targets/project-alpha/app.asar");
		assert.equal(ledger.getCounts().observations, 1);
		assert.equal(ledger.getData().observations[0].evidenceId, "ev_alpha_001");

		// 4. Verify GLiNER models dir defaults inside projectRoot, not ~/Library/Caches or ~/.cache
		const modelsDir = defaultGlinerModelsDir({}, tmpRoot);
		assert.equal(modelsDir, path.join(tmpRoot, "vendor", "gliner-runner", "models"));

		// 5. Verify REA XDG dirs, PI_CODING_AGENT_DIR, and PI_SKIP_VERSION_CHECK are isolated
		const reaEnv = resolveReaProviderEnv({}, tmpRoot);
		assert.equal(reaEnv.XDG_CACHE_HOME, path.join(tmpRoot, "workspaces", ".rea-runtime", "cache"));
		assert.equal(reaEnv.XDG_DATA_HOME, path.join(tmpRoot, "workspaces", ".rea-runtime", "data"));
		assert.equal(reaEnv.XDG_STATE_HOME, path.join(tmpRoot, "workspaces", ".rea-runtime", "state"));
		assert.equal(reaEnv.PI_CODING_AGENT_DIR, path.join(tmpRoot, "workspaces", ".pi-agent"));
		assert.equal(reaEnv.PI_SKIP_VERSION_CHECK, "1");

		// 6. Verify Pi CLI args explicitly pass --no-skills, --no-prompt-templates, and --session-dir
		const piArgs = buildWoodchipperPiArgs([], "tui");
		assert.ok(piArgs.includes("--no-skills"), "Expected --no-skills to block global ~/.agents/skills");
		assert.ok(piArgs.includes("--no-prompt-templates"), "Expected --no-prompt-templates to block global prompts");
		const sessionDirIdx = piArgs.indexOf("--session-dir");
		assert.ok(sessionDirIdx !== -1, "Expected --session-dir to be passed to Pi");
		assert.match(piArgs[sessionDirIdx + 1], /workspaces\/.*\/sessions$/);

		// 7. Verify custom TUI header box renders within terminal width
		const headerLines = renderWoodchipperHeaderLines(90, {
			getActiveModel: () => "maximal/claude-sonnet-5-5-20260301",
			getWorkspaceSlug: () => "default",
			getReportPath: () => path.join(tmpRoot, "workspaces", "default", "REPORT.md"),
		});
		assert.ok(headerLines.length >= 6);
		assert.ok(headerLines.some((l) => stripAnsi(l).includes("WOODCHIPPER")));
		for (const line of headerLines) {
			const visLen = stripAnsi(line).length;
			assert.ok(visLen <= 90, `Header line exceeded visible width 90: ${visLen}`);
		}

		// 8. Verify up-front workspace initialization and workspaces/.gitignore guard
		const wsRoot = ensureWorkspacesRootGitignored(tmpRoot);
		const innerGitignore = fs.readFileSync(path.join(wsRoot, ".gitignore"), "utf8");
		assert.match(innerGitignore, /^\*$/m, "Expected workspaces/.gitignore to ignore all files (*)");

		const parsedFlags = extractWorkspaceCliFlag(["-w", "router-audit", "--no-peer"]);
		assert.equal(parsedFlags.workspaceArg, "router-audit");
		assert.deepEqual(parsedFlags.remainingArgs, ["--no-peer"]);

		const initWs = initializeActiveWorkspace("router-audit", tmpRoot);
		assert.equal(initWs.slug, "router-audit");
		assert.ok(fs.existsSync(initWs.sessionDir));
		assert.ok(listExistingWorkspaces(tmpRoot).includes("router-audit"));
	} finally {
		delete process.env.WOODCHIPPER_WORKSPACE;
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
});
