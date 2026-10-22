import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import woodchipperReaExtension, {
	HIGH_VOLUME_REA_TOOLS,
	checkDestructiveGitCommand,
	isHighVolumeReaTool,
	isReaTool,
} from "../.pi/extensions/woodchipper-rea.ts";
import { EvidenceLedger } from "../.pi/extensions/lib/evidence-ledger.ts";
import {
	PLAYBOOK_CATALOG,
	runReaDoctorSummary,
	runStaticTriage,
} from "../.pi/extensions/lib/triage.ts";

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

		// 1. REA MCP server registration
		assert.ok(state.mcpServers.has("rea"), "Expected 'rea' MCP server to be registered");
		const reaConfig = state.mcpServers.get("rea");
		assert.equal(reaConfig.command, "pnpm");
		assert.deepEqual(reaConfig.args, ["exec", "rea", "mcp"]);
		assert.equal(reaConfig.cwd, tmpProject);

		// 2. Custom model-callable tools
		for (const toolName of ["woodchipper_ledger", "woodchipper_triage", "woodchipper_playbook"]) {
			assert.ok(state.tools.has(toolName), `Expected custom tool '${toolName}' to be registered`);
		}

		// 3. Slash commands
		for (const cmdName of ["triage", "trace", "clone-spec", "audit", "ledger", "doctor"]) {
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
	} finally {
		if (prevEnv === undefined) {
			delete process.env.WOODCHIPPER_PROJECT_ROOT;
		} else {
			process.env.WOODCHIPPER_PROJECT_ROOT = prevEnv;
		}
		fs.rmSync(tmpProject, { recursive: true, force: true });
	}
});
