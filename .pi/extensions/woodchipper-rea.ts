/**
 * Woodchipper Pi Reverse-Engineering Extension
 *
 * Integrates `morluto/rea` (`rea-agents@6.7.0`) MCP server, REAP playbooks,
 * Three-Bucket Evidence Ledger, Summary-First context guardrails, and destructive
 * git command blocking into the Pi coding agent harness.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ConfidenceLevel, EvidenceLedger } from "./lib/evidence-ledger.ts";
import {
	assessExpertiseAndMethodologyFeedback,
	classifyBinarySignals,
	classifyReverseEngineeringIntent,
	ensureGlinerModelInstalled,
	formatWoodchipperOrientationBanner,
	heuristicClassifyIntent,
	renderWoodchipperHeaderLines,
} from "./lib/gliner-classifier.ts";
import { Type } from "./lib/schema.ts";
import {
	extractExistingTargetPathFromPrompt,
	formatReaDoctorMarkdown,
	formatStaticTriageMarkdown,
	loadPlaybookContent,
	PLAYBOOK_CATALOG,
	type PlaybookId,
	resolveReaEntryScript,
	resolveReaMcpEnv,
	runReaDoctorSummary,
	runStaticTriage,
} from "./lib/triage.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, "../..");

export function resolveProjectRoot(): string {
	return process.env.WOODCHIPPER_PROJECT_ROOT || DEFAULT_PROJECT_ROOT;
}

/**
 * High-volume REA 6.7.0 tools that accept `detail: "summary" | "full"` and must default
 * to `detail: "summary"` when `detail` is omitted so the model never blows out context on a first call.
 */
export const HIGH_VOLUME_REA_TOOLS: ReadonlySet<string> = new Set([
	"analyze_javascript_application",
	"inspect_binary_layout",
	"inspect_macho",
	"inspect_artifact",
	"inspect_managed_artifact",
	"inspect_managed_members",
	"inspect_wasm_artifact",
	"inspect_web_network_capture",
	"decode_interface_builder",
	"inspect_evm_interface",
	"inspect_android_package",
	"inspect_pcap_capture",
	"inspect_dart_aot",
	"get_evidence_bundle",
]);

/**
 * Non-REA built-in tools whose output should NOT be scraped for `ev_*` IDs
 * (prevents false-positive `ev_*` capture when reading docs or running grep).
 */
export const NON_REA_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"find",
	"ls",
	"glob",
	"woodchipper_maximal",
	"woodchipper_ledger",
	"woodchipper_triage",
	"woodchipper_playbook",
	"woodchipper_classify",
	"claude_peers",
]);

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

/**
 * Destructive git command patterns blocked by Woodchipper & global safety rules.
 */
export const DESTRUCTIVE_GIT_PATTERNS: ReadonlyArray<{ pattern: RegExp; description: string }> = [
	{
		pattern: /\bgit\s+reset\s+[^;|&]*--hard\b/i,
		description: "git reset --hard (discards uncommitted work; use git reset --keep or --soft/--mixed)",
	},
	{
		pattern: /\bgit\s+clean\s+[^;|&]*(?:-[a-zA-Z]*f[a-zA-Z]*|--force)\b/i,
		description: "git clean -f / -fd / --force (permanently deletes untracked files)",
	},
	{
		pattern: /\bgit\s+checkout\s+(?:[^;|&]*\s)?(?:-[a-zA-Z]*f\b|--force\b|--\s+\S+|\.(?:\s|$|[;|&]))/i,
		description: "git checkout -- <path> / git checkout . / git checkout -f (discards uncommitted working tree modifications)",
	},
	{
		pattern: /\bgit\s+switch\s+[^;|&]*(?:-[a-zA-Z]*f\b|--force\b|--discard-changes\b)/i,
		description: "git switch -f / --discard-changes (discards local uncommitted modifications)",
	},
	{
		pattern: /\bgit\s+stash\s+(?:drop|clear)\b/i,
		description: "git stash drop / clear (permanently deletes stashed uncommitted work)",
	},
];

/**
 * Normalize an MCP or prefixed tool name to its bare REA tool name if applicable.
 */
export function normalizeReaToolName(toolName: string): string {
	if (toolName.startsWith("mcp__rea__")) {
		return toolName.slice("mcp__rea__".length);
	}
	if (toolName.startsWith("rea_")) {
		return toolName.slice("rea_".length);
	}
	return toolName;
}

export function isHighVolumeReaTool(toolName: string): boolean {
	return HIGH_VOLUME_REA_TOOLS.has(normalizeReaToolName(toolName));
}

/**
 * Normalize common parameter aliases on REA 6.7.0 tool calls so models that pass `path`
 * or `parent_evidence_id` still match the strict REA 6.7.0 schema.
 */
export function normalizeReaToolInput(toolName: string, input: Record<string, unknown>): void {
	const bareName = normalizeReaToolName(toolName);

	if (bareName === "analyze_javascript_application") {
		if (input.input_path === undefined && typeof input.path === "string") {
			input.input_path = input.path;
			delete input.path;
		}
	} else if (bareName === "inspect_web_network_capture" || bareName === "export_web_scripts") {
		if (input.capture_path === undefined && typeof input.path === "string") {
			input.capture_path = input.path;
			delete input.path;
		}
	} else if (bareName === "inspect_analysis_view") {
		const rawEvidenceId =
			typeof input.parent_evidence_id === "string"
				? input.parent_evidence_id
				: typeof input.evidence_id === "string"
					? input.evidence_id
					: undefined;
		if (input.source === undefined && rawEvidenceId) {
			input.source = {
				kind: "retained-evidence",
				evidence_id: rawEvidenceId,
			};
			delete input.parent_evidence_id;
			delete input.evidence_id;
		}
	}
}

export function isReaTool(toolName: string): boolean {
	if (toolName.startsWith("mcp__rea__") || toolName.startsWith("rea_")) {
		return true;
	}
	return !NON_REA_BUILTIN_TOOLS.has(toolName);
}

export function checkDestructiveGitCommand(command: string): string | null {
	const normalized = normalizeGitShellCommand(command);
	for (const { pattern, description } of DESTRUCTIVE_GIT_PATTERNS) {
		if (pattern.test(normalized)) {
			return `Blocked destructive git command (${description}). Check 'git status' and preserve uncommitted work.`;
		}
	}

	// Check `git restore`: block working-tree restores (allow `git restore --staged` / `-S` only when `--worktree` / `-W` is NOT also set)
	const restoreSegments = normalized.split(/[;|&]+/);
	for (const seg of restoreSegments) {
		if (/\bgit\s+restore\b/i.test(seg)) {
			const hasStaged = /\s(?:--staged|-S)\b/.test(seg);
			const hasWorktree = /\s(?:--worktree|-W)\b/.test(seg);
			if (!hasStaged || hasWorktree) {
				return "Blocked destructive git command (git restore on working tree discards uncommitted changes; only 'git restore --staged' is allowed).";
			}
		}
	}

	return null;
}

const LEDGER_TOOL_PARAMS = Type.Object({
	action: Type.Union(
		[
			Type.Literal("record_observation"),
			Type.Literal("record_inference"),
			Type.Literal("record_unknown"),
			Type.Literal("resolve_unknown"),
			Type.Literal("query"),
			Type.Literal("export_markdown"),
			Type.Literal("clear"),
		],
		{
			description:
				"Action to perform on the Woodchipper 3-bucket Evidence Ledger: record_observation, record_inference, record_unknown, resolve_unknown, query, export_markdown, or clear.",
		},
	),
	evidence_id: Type.Optional(
		Type.String({
			description: "REA evidence_id (e.g. ev_...) or SHA-256 digest backing an observation.",
		}),
	),
	location: Type.Optional(
		Type.String({
			description: "Function address, file offset, or AST/module node ID for an observation (e.g. 0x100004a20 or mod_main).",
		}),
	),
	summary: Type.Optional(
		Type.String({
			description: "Concise factual summary of the observation.",
		}),
	),
	tool_name: Type.Optional(
		Type.String({
			description: "Optional REA tool name that produced the observation.",
		}),
	),
	statement: Type.Optional(
		Type.String({
			description: "Hypothesis or deduction statement when recording an inference.",
		}),
	),
	confidence: Type.Optional(
		Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
			description: "Confidence level for an inference (high, medium, low).",
		}),
	),
	supporting_evidence_ids: Type.Optional(
		Type.Array(Type.String(), {
			description: "List of supporting evidence_ids (ev_...) or observation IDs (obs_...) for an inference.",
		}),
	),
	competing_explanations: Type.Optional(
		Type.Array(Type.String(), {
			description: "Alternative explanations that have not yet been ruled out.",
		}),
	),
	description: Type.Optional(
		Type.String({
			description: "Description of the unexamined code path, indirect call, or truncated page for record_unknown.",
		}),
	),
	reason: Type.Optional(
		Type.String({
			description: "Why this remains unknown (e.g. dynamic dispatch, stripped symbols, unpaged summary).",
		}),
	),
	next_probe: Type.Optional(
		Type.String({
			description: "Recommended next static or bounded dynamic REA tool call to resolve the unknown.",
		}),
	),
	unknown_id: Type.Optional(
		Type.String({
			description: "Unknown entry ID (e.g. unk_1) when action is resolve_unknown.",
		}),
	),
});

const TRIAGE_TOOL_PARAMS = Type.Object({
	path: Type.String({
		description: "Path to the target binary, bundle (.app, .apk, .asar), firmware image, capture, or directory.",
	}),
});

const PLAYBOOK_TOOL_PARAMS = Type.Object({
	action: Type.Optional(
		Type.Union([Type.Literal("list"), Type.Literal("load")], {
			description: "Either 'list' all 4 Woodchipper playbooks or 'load' a specific playbook by id.",
		}),
	),
	playbook: Type.Optional(
		Type.Union(
			[
				Type.Literal("triage-and-feature-trace"),
				Type.Literal("clean-room-and-porting"),
				Type.Literal("security-and-vr"),
				Type.Literal("firmware-and-protocols"),
			],
			{
				description: "Playbook identifier to load.",
			},
		),
	),
});

const CLASSIFY_TOOL_PARAMS = Type.Object({
	action: Type.Optional(
		Type.Union(
			[
				Type.Literal("classify_intent"),
				Type.Literal("classify_signals"),
				Type.Literal("ensure_model"),
			],
			{
				description:
					"Action for the GLiNER (decide-340m) classifier: 'classify_intent' (plain-English question -> Playbook & Sub-Skill), 'classify_signals' (strings/imports/symbols -> capability buckets), or 'ensure_model' (verify/auto-pull decide-340m).",
			},
		),
	),
	query: Type.Optional(
		Type.String({
			description: "Plain-English user question or reverse-engineering goal when action is 'classify_intent'.",
		}),
	),
	signals: Type.Optional(
		Type.Array(Type.String(), {
			description: "List of extracted binary strings, imports, or symbols to classify into capability buckets when action is 'classify_signals'.",
		}),
	),
});

/**
 * Core entry-point REA 6.7.0 tools exposed directly (`"direct"`) to the model on Turn 1
 * so Pi waits for the `rea` MCP server connection before running the first prompt, while
 * keeping the remaining ~180 specialized REA tools `"deferred"` via `tool_search`.
 */
export const DIRECT_REA_TOOL_EXPOSURE: Readonly<Record<string, "direct">> = {
	analyze_javascript_application: "direct",
	inspect_analysis_view: "direct",
	trace_application_feature: "direct",
	inspect_electron_fuses: "direct",
	inspect_web_network_capture: "direct",
	inspect_binary_layout: "direct",
	inspect_go_binary: "direct",
	inspect_rust_binary: "direct",
	inspect_pe_resources: "direct",
	inspect_with_objdump: "direct",
	inspect_sqlite_database: "direct",
	inspect_android_package: "direct",
	inspect_managed_artifact: "direct",
	inspect_wasm_artifact: "direct",
	inspect_evm_interface: "direct",
	inspect_firmware_regions: "direct",
	inspect_plist: "direct",
	open_binary: "direct",
	close_binary: "direct",
	inspect_macho: "direct",
	inspect_artifact: "direct",
	search_strings: "direct",
	search_procedures: "direct",
	analyze_function: "direct",
	xrefs: "direct",
	resolve_containing_procedure: "direct",
	compare_functions: "direct",
	record_unknown: "direct",
	list_unknowns: "direct",
};

export default function woodchipperReaExtension(pi: ExtensionAPI) {
	const projectRoot = resolveProjectRoot();
	const ledger = new EvidenceLedger(projectRoot);

	// =========================================================================
	// 1. REA MCP Server Registration
	// =========================================================================
	try {
		pi.registerMcpServer("rea", {
			command: process.execPath,
			args: [resolveReaEntryScript(projectRoot), "mcp"],
			cwd: projectRoot,
			env: resolveReaMcpEnv(process.env, projectRoot),
			exposure: "deferred",
			toolExposure: { ...DIRECT_REA_TOOL_EXPOSURE },
			timeout: 300,
			description:
				"Reverse Engineer Anything (REA) MCP server providing static, dynamic, firmware, JS/Electron, mobile, and reconstruction tools.",
		});
	} catch {
		// Ignore if another Pi extension already registered the project-local 'rea' server.
	}

	// =========================================================================
	// 2. Summary-First & Safety Guardrails (tool_call & tool_result)
	// =========================================================================
	pi.on("tool_call", (event, ctx) => {
		// Guardrail A: Block destructive git commands in bash
		if (event.toolName === "bash" && typeof event.input?.command === "string") {
			const blockReason = checkDestructiveGitCommand(event.input.command);
			if (blockReason) {
				if (ctx.hasUI) {
					ctx.ui.notify(blockReason, "error");
				}
				return {
					block: true,
					reason: blockReason,
				};
			}
		}

		// Guardrail B: Normalize REA 6.7.0 parameter aliases and default detail = "summary" on high-volume REA tools
		if (event.input && typeof event.input === "object") {
			const inputRecord = event.input as Record<string, unknown>;
			if (isReaTool(event.toolName)) {
				normalizeReaToolInput(event.toolName, inputRecord);
			}
			if (isHighVolumeReaTool(event.toolName) && inputRecord.detail === undefined) {
				inputRecord.detail = "summary";
			}
		}

		return undefined;
	});

	pi.on("user_bash", (event, ctx) => {
		const blockReason = checkDestructiveGitCommand(event.command);
		if (blockReason) {
			if (ctx.hasUI) {
				ctx.ui.notify(blockReason, "error");
			}
			return {
				result: {
					output: `Error: ${blockReason}\n`,
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		}
		return undefined;
	});

	pi.on("tool_result", (event) => {
		if (event.isError || !isReaTool(event.toolName)) return undefined;

		const textBlocks: string[] = [];
		if (Array.isArray(event.content)) {
			for (const part of event.content) {
				if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
					textBlocks.push(part.text);
				}
			}
		}

		const recorded = ledger.extractFromToolResult(
			normalizeReaToolName(event.toolName),
			textBlocks,
			event.structuredContent,
		);

		if (recorded.length > 0 && event.details && typeof event.details === "object") {
			return {
				details: {
					...(event.details as Record<string, unknown>),
					woodchipperTrackedEvidenceIds: recorded.map((r) => r.id),
				},
			};
		}
		return undefined;
	});

	// =========================================================================
	// 3. Custom Model-Callable Tools
	// =========================================================================

	pi.registerTool({
		name: "woodchipper_ledger",
		label: "Woodchipper Evidence Ledger",
		description:
			"Record or query Three-Bucket Epistemology items: Observations (with evidence_id and address/node), Inferences (with confidence & competing explanations), and Unknowns, or export a formatted 3-bucket markdown report.",
		promptSnippet:
			"Record or query Three-Bucket Evidence Ledger entries (Observations, Inferences, Unknowns) and tracked ev_* IDs",
		promptGuidelines: [
			"Record verified tool findings as Observations with their `evidence_id` (`ev_...`) and address/node in `woodchipper_ledger`.",
			"Separate hypotheses into Inferences with explicit confidence and competing explanations, and log unexamined paths as Unknowns.",
		],
		parameters: LEDGER_TOOL_PARAMS,
		async execute(_toolCallId, params) {
			ledger.reload();
			switch (params.action) {
				case "record_observation": {
					const obs = ledger.addObservation({
						evidenceId: params.evidence_id ?? "ev_unspecified",
						location: params.location ?? "unspecified",
						summary: params.summary ?? "",
						toolName: params.tool_name,
					});
					return {
						content: [
							{
								type: "text",
								text: `Recorded Observation [${obs.id}]: [Evidence: ${obs.evidenceId} @ ${obs.location}] ${obs.summary}`,
							},
						],
						details: { action: params.action, entry: obs, counts: ledger.getCounts() },
					};
				}
				case "record_inference": {
					const confidence: ConfidenceLevel = params.confidence ?? "medium";
					const inf = ledger.addInference({
						statement: params.statement ?? params.summary ?? "",
						confidence,
						supportingEvidenceIds: params.supporting_evidence_ids,
						competingExplanations: params.competing_explanations,
					});
					return {
						content: [
							{
								type: "text",
								text: `Recorded Inference [${inf.id}] (confidence: ${inf.confidence}): ${inf.statement}`,
							},
						],
						details: { action: params.action, entry: inf, counts: ledger.getCounts() },
					};
				}
				case "record_unknown": {
					const unk = ledger.addUnknown({
						description: params.description ?? params.summary ?? "",
						reason: params.reason ?? "unexamined path",
						nextProbe: params.next_probe,
					});
					return {
						content: [
							{
								type: "text",
								text: `Recorded Unknown [${unk.id}]: ${unk.description} (Reason: ${unk.reason})`,
							},
						],
						details: { action: params.action, entry: unk, counts: ledger.getCounts() },
					};
				}
				case "resolve_unknown": {
					const resolved = params.unknown_id ? ledger.resolveUnknown(params.unknown_id) : undefined;
					if (!resolved) {
						return {
							content: [
								{
									type: "text",
									text: `Unknown ID '${params.unknown_id ?? ""}' not found in ledger.`,
								},
							],
							details: { action: params.action, found: false },
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `Resolved Unknown [${resolved.id}]: ${resolved.description}`,
							},
						],
						details: { action: params.action, entry: resolved, counts: ledger.getCounts() },
					};
				}
				case "clear": {
					ledger.clear();
					return {
						content: [{ type: "text", text: "Cleared Woodchipper Evidence Ledger." }],
						details: { action: params.action, counts: ledger.getCounts() },
					};
				}
				case "query": {
					const data = ledger.getData();
					const counts = ledger.getCounts();
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ counts, ledgerPath: ledger.getLedgerPath(), ...data }, null, 2),
							},
						],
						details: { action: params.action, counts },
					};
				}
				case "export_markdown":
				default: {
					const report = ledger.formatMarkdownReport();
					return {
						content: [{ type: "text", text: report }],
						details: { action: "export_markdown", counts: ledger.getCounts() },
					};
				}
			}
		},
	});

	pi.registerTool({
		name: "woodchipper_triage",
		label: "Woodchipper Static Triage",
		description:
			"Fast target-free static reconnaissance helper that runs `file`, `shasum -a 256`, and size checks, and recommends the exact Woodchipper sub-skill (`woodchipper-native`, `woodchipper-js-web`, `woodchipper-mobile-managed`, `woodchipper-firmware-signals`, `woodchipper-runtime`, `woodchipper-reconstruction`, `woodchipper-audit`) and initial REA tool sequence.",
		promptSnippet:
			"Run fast target-free static reconnaissance (file, SHA-256, size) and get recommended Woodchipper sub-skill & REA tool sequence",
		promptGuidelines: [
			"Run `woodchipper_triage` first on any unfamiliar binary, bundle, firmware image, or capture before calling `open_binary`.",
		],
		parameters: TRIAGE_TOOL_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const baseDir = ctx?.cwd ?? projectRoot;
			const result = runStaticTriage(params.path, baseDir);
			let workspaceInfo: ReturnType<typeof ledger.setTargetWorkspace> | undefined;
			if (result.exists) {
				workspaceInfo = ledger.setTargetWorkspace(result.resolvedPath);
			}
			const markdown = formatStaticTriageMarkdown(result);
			if (workspaceInfo) {
				ledger.writeTriageMap(markdown);
			}
			const outputText = workspaceInfo
				? `${markdown}\n\n#### Isolated Target Workspace (No Cross-Project Commingling)\n- **Workspace Folder:** \`${workspaceInfo.workspaceDir}\`\n- **Triage Map File:** \`${workspaceInfo.triageMapPath}\`\n- **Report File:** \`${workspaceInfo.reportPath}\`\n- **Ledger JSON:** \`${workspaceInfo.ledgerPath}\``
				: markdown;
			return {
				content: [{ type: "text", text: outputText }],
				details: { ...result, workspace: workspaceInfo },
			};
		},
	});

	pi.registerTool({
		name: "woodchipper_playbook",
		label: "Woodchipper Playbook Loader",
		description:
			"List or load one of the 4 Woodchipper reverse-engineering playbooks (`triage-and-feature-trace`, `clean-room-and-porting`, `security-and-vr`, `firmware-and-protocols`).",
		promptSnippet:
			"Load or list structured Woodchipper reverse-engineering playbooks (triage, clean-room, security-vr, firmware-protocols)",
		parameters: PLAYBOOK_TOOL_PARAMS,
		async execute(_toolCallId, params) {
			const action = params.action ?? (params.playbook ? "load" : "list");
			if (action === "list" || !params.playbook) {
				const listText = [
					"# Woodchipper Reverse-Engineering Playbooks",
					"",
					...PLAYBOOK_CATALOG.map(
						(p) => `- **\`${p.id}\`** (${p.title})\n  - Path: \`${p.relativePath}\`\n  - Summary: ${p.summary}`,
					),
				].join("\n");
				return {
					content: [{ type: "text", text: listText }],
					details: { action: "list", playbooks: PLAYBOOK_CATALOG },
				};
			}

			const loaded = loadPlaybookContent(projectRoot, params.playbook as PlaybookId);
			if (!loaded) {
				return {
					content: [
						{
							type: "text",
							text: `Playbook '${params.playbook}' not found. Valid playbooks: ${PLAYBOOK_CATALOG.map((p) => p.id).join(", ")}`,
						},
					],
					details: { action: "load", found: false },
				};
			}

			return {
				content: [{ type: "text", text: loaded.content }],
				details: { action: "load", found: true, playbook: loaded.descriptor },
			};
		},
	});

	pi.registerTool({
		name: "woodchipper_classify",
		label: "Woodchipper GLiNER Expert Classifier",
		description:
			"Run the 340M/380M GLiNER (`decide-340m`, `stuffbucket/gliner-runner`) classifier to map plain-English user questions to the exact Woodchipper Playbook & Sub-Skill, classify binary strings/imports/symbols into capability buckets, or verify/auto-pull the `decide-340m` model.",
		promptSnippet:
			"Classify plain-English user intent or binary strings/imports into Playbooks, Sub-Skills, and Capability Buckets via gliner-runner (decide-340m)",
		parameters: CLASSIFY_TOOL_PARAMS,
		async execute(_toolCallId, params) {
			const action = params.action ?? (params.signals?.length ? "classify_signals" : "classify_intent");
			if (action === "ensure_model") {
				const status = await ensureGlinerModelInstalled({ projectRoot });
				return {
					content: [
						{
							type: "text",
							text: [
								`# Woodchipper GLiNER Model Status (\`${status.modelId}\`)`,
								`- **Revision:** \`${status.revision}\``,
								`- **Installed:** \`${status.installed}\`${status.autoPulled ? " (auto-pulled)" : ""}`,
								`- **Runner Available:** \`${status.runnerAvailable}\` (${status.runnerSource})`,
								`- **Server Reachable:** \`${status.serverReachable}\` (\`${status.serverUrl}\`)`,
								`- **Models Dir:** \`${status.modelsDir}\``,
							].join("\n"),
						},
					],
					details: status,
				};
			}

			if (action === "classify_signals") {
				const res = await classifyBinarySignals(params.signals ?? [], { projectRoot });
				const lines = [
					`# Woodchipper Binary Signal Classification (\`${res.modelId}\` via \`${res.source}\`)`,
					"",
					...res.items.map(
						(item) =>
							`- \`${item.signal}\` -> ${item.capabilities.length ? item.capabilities.map((c) => `**${c}**`).join(", ") : "_unclassified_"}`,
					),
				];
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: res,
				};
			}

			const res = await classifyReverseEngineeringIntent(params.query ?? "", { projectRoot });
			const lines = [
				`# Woodchipper Expert Intent Classification (\`${res.modelId}\` via \`${res.source}\`)`,
				"",
				`- **Query:** ${res.query}`,
				`- **Recommended Playbook:** \`${res.recommendedPlaybook}\` (confidence: ${(res.playbookConfidence * 100).toFixed(1)}%)`,
				`- **Recommended Sub-Skill:** \`${res.recommendedSubSkill}\` (confidence: ${(res.subSkillConfidence * 100).toFixed(1)}%)`,
				"",
				"## Recommended Initial REA 6.7.0 Tool Sequence",
				...res.initialReaTools.map((t) => `- \`${t}\``),
			];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: res,
			};
		},
	});

	// =========================================================================
	// 4. Slash Commands (pi.registerCommand)
	// =========================================================================

	pi.registerCommand("triage", {
		description: "Run Woodchipper static reconnaissance and inject a structured triage prompt: /triage <path>",
		handler: async (args, ctx) => {
			const targetPath = args.trim();
			if (!targetPath) {
				ctx.ui.notify("Usage: /triage <path>", "warning");
				return;
			}
			const triage = runStaticTriage(targetPath, ctx.cwd || projectRoot);
			const triageMarkdown = formatStaticTriageMarkdown(triage);
			if (triage.exists) {
				ledger.setTargetWorkspace(triage.resolvedPath);
				ledger.writeTriageMap(triageMarkdown);
			}
			const prompt = [
				`Perform a Woodchipper Summary-First Static Triage on \`${targetPath}\` (isolated workspace: \`${ledger.getWorkspaceDir()}\`).`,
				"",
				triageMarkdown,
				"",
				"### Execution Instructions",
				`1. Load \`skills/${triage.recommendedSubSkill}/SKILL.md\` and follow \`playbooks/${triage.recommendedPlaybook}.md\`.`,
				'2. Run the recommended target-free REA tools first with `detail: "summary"`, retain `parent_evidence_id`, and page via `inspect_analysis_view` before calling `open_binary`.',
				`3. Record verified findings in \`woodchipper_ledger\` (which automatically writes \`${ledger.getReportPath()}\`) and deliver a Three-Bucket Triage Map (Observations with \`ev_*\` & addresses, Inferences with confidence & competing explanations, and Unknowns).`,
			].join("\n");

			pi.sendUserMessage(prompt);
		},
	});

	pi.registerCommand("trace", {
		description: "Inject a structured end-to-end feature trace prompt: /trace <path> <feature>",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const firstSpace = trimmed.indexOf(" ");
			if (!trimmed || firstSpace === -1) {
				ctx.ui.notify("Usage: /trace <path> <feature>", "warning");
				return;
			}
			const targetPath = trimmed.slice(0, firstSpace).trim();
			const feature = trimmed.slice(firstSpace + 1).trim();
			const triage = runStaticTriage(targetPath, ctx.cwd || projectRoot);
			const triageMarkdown = formatStaticTriageMarkdown(triage);
			if (triage.exists) {
				ledger.setTargetWorkspace(triage.resolvedPath);
				ledger.writeTriageMap(triageMarkdown);
			}

			const prompt = [
				`Trace the feature "${feature}" end-to-end in target \`${triage.resolvedPath}\` (isolated workspace: \`${ledger.getWorkspaceDir()}\`).`,
				"",
				triageMarkdown,
				"",
				"### Feature Trace Sequence (`triage-and-feature-trace` Playbook)",
				`1. Locate static entry seeds for "${feature}" (strings, exports, UI labels, CLI flags, IPC handlers) using target-free tools or \`search_strings\` / \`search_procedures\` with \`detail: "summary"\`.`,
				'2. Walk the call & data chain hop-by-hop (`xrefs` -> `resolve_containing_procedure` -> `analyze_function`, or `trace_application_feature` for JS/Electron).',
				`3. Record each hop in \`woodchipper_ledger\` (saved to \`${ledger.getReportPath()}\`) and output a Step-by-Step Hop Table (\`Hop # | Layer | Function/Module | Address/Node ID | Evidence ID | Transformation/Side Effect\`) followed by separated Observations, Inferences, and Unknowns.`,
			].join("\n");

			pi.sendUserMessage(prompt);
		},
	});

	pi.registerCommand("clone-spec", {
		description: "Inject a clean-room CLONE_SPEC.md behavioral specification prompt: /clone-spec <path>",
		handler: async (args, ctx) => {
			const targetPath = args.trim();
			if (!targetPath) {
				ctx.ui.notify("Usage: /clone-spec <path>", "warning");
				return;
			}
			const triage = runStaticTriage(targetPath, ctx.cwd || projectRoot);
			const triageMarkdown = formatStaticTriageMarkdown(triage);
			if (triage.exists) {
				ledger.setTargetWorkspace(triage.resolvedPath);
				ledger.writeTriageMap(triageMarkdown);
			}
			const prompt = [
				`Produce a clean-room behavioral specification (\`CLONE_SPEC.md\`) for \`${triage.resolvedPath}\` (isolated workspace: \`${ledger.getWorkspaceDir()}\`).`,
				"",
				triageMarkdown,
				"",
				"### Clean-Room Specification Rules (`clean-room-and-porting` Playbook)",
				"1. Extract ONLY behavioral contracts, state machines, mathematical formulas, persistence schemas (`inspect_sqlite_database` / `inspect_plist`), and wire/IPC protocols—never copy proprietary code, branding, or assets.",
				'2. Use `build_reconstruction_obligation_ledger` (where supported) and target-free `detail: "summary"` views first.',
				`3. Cite every behavioral requirement with \`[Evidence: <evidence_id> @ <address/node_id>]\` and mark any unverified branch with \`[UNKNOWN: <reason & next probe>]\` in \`woodchipper_ledger\` (\`${ledger.getReportPath()}\`).`,
			].join("\n");

			pi.sendUserMessage(prompt);
		},
	});

	pi.registerCommand("audit", {
		description: "Inject a defensive trust-boundary & source-to-sink security audit prompt: /audit <path>",
		handler: async (args, ctx) => {
			const targetPath = args.trim();
			if (!targetPath) {
				ctx.ui.notify("Usage: /audit <path>", "warning");
				return;
			}
			const triage = runStaticTriage(targetPath, ctx.cwd || projectRoot);
			const triageMarkdown = formatStaticTriageMarkdown(triage);
			if (triage.exists) {
				ledger.setTargetWorkspace(triage.resolvedPath);
				ledger.writeTriageMap(triageMarkdown);
			}
			const prompt = [
				`Conduct a defensive trust-boundary and source-to-sink security audit on authorized target \`${triage.resolvedPath}\` (isolated workspace: \`${ledger.getWorkspaceDir()}\`).`,
				"",
				triageMarkdown,
				"",
				"### Defensive Security Audit Sequence (`security-and-vr` Playbook)",
				"1. Load `skills/woodchipper-audit/SKILL.md` and `playbooks/security-and-vr.md`.",
				'2. Enumerate untrusted entry surfaces (IPC handlers, network parsers, exported Android components, IOCTLs, Electron fuses via `inspect_electron_fuses`) with `detail: "summary"`.',
				"3. Trace paths from untrusted sources to privileged sinks (`execve`/`system`/`child_process`, `shell.openExternal`, memory copies, file/SQLite writes) and verify all guards/bounds checks along the path.",
				`4. Never report an unverified static hypothesis as a confirmed vulnerability—log each candidate in \`woodchipper_ledger\` (\`${ledger.getReportPath()}\`) with Source (\`evidence_id\` + address), Sink (\`evidence_id\` + address), Observed Guards, Status (\`Observation\` vs \`Inference\`), and Minimal Controlled Validation Step.`,
			].join("\n");

			pi.sendUserMessage(prompt);
		},
	});

	pi.registerCommand("ledger", {
		description: "Display or export the current 3-bucket Woodchipper Evidence Ledger: /ledger [clear|json]",
		handler: async (args, ctx) => {
			ledger.reload();
			const subcmd = args.trim().toLowerCase();
			if (subcmd === "clear") {
				ledger.clear();
				ctx.ui.notify(`Cleared Woodchipper Evidence Ledger (${ledger.getLedgerPath()}).`, "info");
				return;
			}

			const counts = ledger.getCounts();
			const report =
				subcmd === "json"
					? `\`\`\`json\n${JSON.stringify(ledger.getData(), null, 2)}\n\`\`\``
					: ledger.formatMarkdownReport();

			pi.sendMessage(
				{
					customType: "woodchipper-ledger",
					content: report,
					display: true,
					details: { counts, ledgerPath: ledger.getLedgerPath(), reportPath: ledger.getReportPath() },
				},
				{ triggerTurn: false },
			);
			ctx.ui.notify(
				`Ledger (${ledger.getWorkspaceSlug()}): ${counts.evidenceIds} ev_* IDs, ${counts.observations} obs, ${counts.inferences} inf, ${counts.unresolvedUnknowns} open unknowns -> ${ledger.getReportPath()}`,
				"info",
			);
		},
	});

	pi.registerCommand("doctor", {
		description: "Run `pnpm exec rea doctor --json` and summarize backend availability: /doctor",
		handler: async (_args, ctx) => {
			const summary = runReaDoctorSummary(projectRoot);
			const markdown = formatReaDoctorMarkdown(summary);
			pi.sendMessage(
				{
					customType: "woodchipper-doctor",
					content: markdown,
					display: true,
					details: summary,
				},
				{ triggerTurn: false },
			);
			const readyCount = summary.backends.filter((b) => b.available).length;
			ctx.ui.notify(
				`REA v${summary.reaVersion}: ${readyCount}/${summary.backends.length} optional backends ready (${summary.mcpToolCount ?? 207} MCP tools available)`,
				"info",
			);
		},
	});

	pi.registerCommand("start", {
		description:
			"Show the Woodchipper appliance orientation guide or start a guided plain-English intake: /start [path-or-question]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				const banner = formatWoodchipperOrientationBanner({
					activeModel: ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				});
				pi.sendMessage(
					{
						customType: "woodchipper-welcome",
						content: banner,
						display: true,
					},
					{ triggerTurn: false },
				);
				return;
			}

			const triage = runStaticTriage(trimmed, ctx.cwd || projectRoot);
			if (triage.exists) {
				const triageMarkdown = formatStaticTriageMarkdown(triage);
				ledger.setTargetWorkspace(triage.resolvedPath);
				ledger.writeTriageMap(triageMarkdown);
				const prompt = [
					`Guided Appliance Intake for \`${triage.resolvedPath}\` (isolated workspace: \`${ledger.getWorkspaceDir()}\`):`,
					"",
					triageMarkdown,
					"",
					"### Appliance Operator Instructions",
					`1. Load \`skills/${triage.recommendedSubSkill}/SKILL.md\` and run the target-free REA tools above with \`detail: "summary"\`.`,
					`2. Explain what this artifact is, how it is built, and its main capabilities in clear, accessible English (citing \`ev_*\` IDs and addresses, saved to \`${ledger.getReportPath()}\`).`,
					"3. Propose **3 concrete next-step options** the user can pick from (e.g., (A) Trace a specific feature/button, (B) Check network/telemetry/IPC behavior, (C) Run a security audit or clean-room spec).",
				].join("\n");
				pi.sendUserMessage(prompt);
				return;
			}

			pi.sendUserMessage(trimmed);
		},
	});

	pi.registerCommand("gliner", {
		description:
			"Inspect or run the Woodchipper GLiNER (decide-340m) classifier: /gliner [status|ensure-model|classify <text>]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed.toLowerCase().startsWith("classify ")) {
				const query = trimmed.slice("classify ".length).trim();
				const res = await classifyReverseEngineeringIntent(query, { projectRoot });
				pi.sendMessage(
					{
						customType: "woodchipper-gliner",
						content: `${res.plainEnglishSummary}\n\nInitial REA Tools:\n${res.initialReaTools.map((t) => `- \`${t}\``).join("\n")}`,
						display: true,
						details: res,
					},
					{ triggerTurn: false },
				);
				return;
			}
			const status = await ensureGlinerModelInstalled({ projectRoot });
			const content = [
				`# Woodchipper GLiNER Classifier (\`${status.modelId}\`)`,
				`- **Model Revision:** \`${status.revision}\``,
				`- **Model Installed:** \`${status.installed}\`${status.autoPulled ? " (auto-pulled)" : ""}`,
				`- **Runner Available:** \`${status.runnerAvailable}\` (${status.runnerSource})`,
				`- **HTTP Server:** \`${status.serverReachable ? "ONLINE" : "OFFLINE"}\` (\`${status.serverUrl}\`)`,
				`- **Cache Directory:** \`${status.modelsDir}\``,
			].join("\n");
			pi.sendMessage(
				{
					customType: "woodchipper-gliner",
					content,
					display: true,
					details: status,
				},
				{ triggerTurn: false },
			);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`GLiNER (${status.modelId}): model=${status.installed ? "ready" : "missing"}, runner=${status.runnerAvailable ? "ready" : "fallback"}`,
					"info",
				);
			}
		},
	});

	// =========================================================================
	// 5. Startup Orientation Header & System Prompt Enrichment
	// =========================================================================
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx?.hasUI) return;

		if (typeof ctx.ui?.setTitle === "function") {
			ctx.ui.setTitle("Woodchipper — Reverse-Engineering Appliance");
		}
		if (typeof ctx.ui?.setHeader === "function") {
			ctx.ui.setHeader((_tui, theme) => ({
				render(width: number): string[] {
					return renderWoodchipperHeaderLines(
						width,
						{
							getActiveModel: () =>
								ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : "maximal/claude-sonnet-5-5-20260301",
							getWorkspaceSlug: () => ledger.getWorkspaceSlug(),
							getReportPath: () => ledger.getReportPath(),
						},
						theme,
					);
				},
				invalidate() {},
			}));
		}
	});

	pi.on("before_agent_start", (event) => {
		const userPrompt = "prompt" in event && typeof event.prompt === "string" ? event.prompt.trim() : "";
		const baseDir = event.systemPromptOptions?.cwd || projectRoot;
		const detectedPath = userPrompt ? extractExistingTargetPathFromPrompt(userPrompt, baseDir) : null;
		let autoTriagedMarkdown = "";
		if (detectedPath) {
			const autoTriage = runStaticTriage(detectedPath, baseDir);
			if (autoTriage.exists) {
				ledger.setTargetWorkspace(autoTriage.resolvedPath);
				autoTriagedMarkdown = formatStaticTriageMarkdown(autoTriage);
				ledger.writeTriageMap(autoTriagedMarkdown);
			}
		}

		const intentHint = userPrompt ? heuristicClassifyIntent(userPrompt) : null;
		const assessment = userPrompt ? assessExpertiseAndMethodologyFeedback(userPrompt) : null;

		const disciplineLines = [
			"Woodchipper 5.5-Series Reverse-Engineering Operating Discipline:",
			"1. Three-Bucket Epistemology: Strictly separate every finding into Observations (direct tool output + `evidence_id` `ev_...` + address/node ID), Inferences (hypotheses with confidence and competing explanations), and Unknowns (unexamined paths or truncated pages logged via `woodchipper_ledger` or `record_unknown`).",
			'2. Summary-First Context Protection: Always pass `detail: "summary"` first on high-volume REA tools (`analyze_javascript_application`, `inspect_binary_layout`, `inspect_macho`, `inspect_artifact`, `inspect_managed_artifact`, `inspect_managed_members`, `inspect_wasm_artifact`, `inspect_web_network_capture`, `decode_interface_builder`, `inspect_evm_interface`, `inspect_android_package`, `inspect_pcap_capture`, `inspect_dart_aot`, `get_evidence_bundle`), retain `parent_evidence_id`, and page slices via `inspect_analysis_view`.',
			"3. Target-Free Before `open_binary`: Run `woodchipper_triage` and target-free path-based REA tools (`analyze_javascript_application`, `inspect_binary_layout`, `inspect_go_binary`, `inspect_rust_binary`, `inspect_pe_resources`, `inspect_sqlite_database`, `inspect_android_package`, `inspect_managed_artifact`, `inspect_wasm_artifact`, `inspect_evm_interface`, `inspect_firmware_regions`, `inspect_plist`) before paying the cost of `open_binary`.",
			"4. Git & Worktree Safety: Never run `git reset --hard`, `git clean -fd`, `git checkout -- <path>`, or working-tree `git restore`.",
			`5. Isolated Per-Target Workspaces: All deliverables for the active target are written to \`${ledger.getWorkspaceDir()}\` (\`REPORT.md\`, \`TRIAGE_MAP.md\`, \`evidence-ledger.json\`) — never hidden in dot-directories or global XDG folders, and never commingled across unrelated projects.`,
			"6. Adaptive Operator-to-Expert Calibration & Proactive Pushback: Default to Appliance Operator mode (plain-English synthesis + 2-3 clear next steps) unless the user demonstrates reverse-engineering fluency, in which case shift to Expert Collaborator mode. In BOTH modes, never act as a passive yes-man: proactively advise the user when a requested action is premature, noisy, or uses the wrong engine (e.g., running dynamic hooks before static triage, decompiling a whole binary instead of summary paging, or conflating a static string with runtime execution).",
		];

		if (intentHint) {
			disciplineLines.push(
				`7. Active Turn Routing Hint: Recommended Playbook=\`${intentHint.recommendedPlaybook}\`, Sub-Skill=\`${intentHint.recommendedSubSkill}\` (call \`woodchipper_classify\` for GLiNER \`decide-340m\` intent or binary capability classification).`,
			);
		}
		if (assessment) {
			disciplineLines.push(`8. Calibrated Persona (${assessment.expertiseLevel}): ${assessment.personaGuidance}`);
			for (const adv of assessment.methodologyAdvisories) {
				disciplineLines.push(`   - ${adv}`);
			}
		}
		if (autoTriagedMarkdown) {
			disciplineLines.push("", "9. Auto-Detected Target Reconnaissance (`TRIAGE_MAP.md` written to workspace):", autoTriagedMarkdown);
		}

		const disciplineSection = disciplineLines.join("\n");

		if (event.systemPromptOptions?.sections) {
			event.systemPromptOptions.sections.woodchipper_discipline = disciplineSection;
			return undefined;
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n<woodchipper_discipline>\n${disciplineSection}\n</woodchipper_discipline>`,
		};
	});
}
