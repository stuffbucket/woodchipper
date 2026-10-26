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
import { Type } from "./lib/schema.ts";
import {
	formatReaDoctorMarkdown,
	formatStaticTriageMarkdown,
	loadPlaybookContent,
	PLAYBOOK_CATALOG,
	type PlaybookId,
	resolveReaProviderEnv,
	runReaDoctorSummary,
	runStaticTriage,
} from "./lib/triage.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, "../..");

export function resolveProjectRoot(): string {
	return process.env.WOODCHIPPER_PROJECT_ROOT || DEFAULT_PROJECT_ROOT;
}

/**
 * High-volume REA tools that must default to `detail: "summary"` when `detail` is omitted
 * so the model never blows out context on a first call.
 */
export const HIGH_VOLUME_REA_TOOLS: ReadonlySet<string> = new Set([
	"analyze_javascript_application",
	"inspect_binary_layout",
	"inspect_macho",
	"inspect_artifact",
	"inspect_managed_artifact",
	"inspect_wasm_artifact",
	"inspect_web_network_capture",
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
	"woodchipper_ledger",
	"woodchipper_triage",
	"woodchipper_playbook",
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

export default function woodchipperReaExtension(pi: ExtensionAPI) {
	const projectRoot = resolveProjectRoot();
	const ledger = new EvidenceLedger(projectRoot);

	// =========================================================================
	// 1. REA MCP Server Registration
	// =========================================================================
	try {
		pi.registerMcpServer("rea", {
			command: "pnpm",
			args: ["exec", "rea", "mcp"],
			cwd: projectRoot,
			env: resolveReaProviderEnv(),
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

		// Guardrail B: Default detail = "summary" on high-volume REA tools when omitted
		if (isHighVolumeReaTool(event.toolName) && event.input && typeof event.input === "object") {
			const inputRecord = event.input as Record<string, unknown>;
			if (inputRecord.detail === undefined) {
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
			const markdown = formatStaticTriageMarkdown(result);
			return {
				content: [{ type: "text", text: markdown }],
				details: result,
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
			const prompt = [
				`Perform a Woodchipper Summary-First Static Triage on \`${targetPath}\`.`,
				"",
				triageMarkdown,
				"",
				"### Execution Instructions",
				`1. Load \`skills/${triage.recommendedSubSkill}/SKILL.md\` and follow \`playbooks/${triage.recommendedPlaybook}.md\`.`,
				'2. Run the recommended target-free REA tools first with `detail: "summary"`, retain `parent_evidence_id`, and page via `inspect_analysis_view` before calling `open_binary`.',
				"3. Record verified findings in `woodchipper_ledger` and deliver a Three-Bucket Triage Map (Observations with `ev_*` & addresses, Inferences with confidence & competing explanations, and Unknowns).",
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

			const prompt = [
				`Trace the feature "${feature}" end-to-end in target \`${triage.resolvedPath}\`.`,
				"",
				formatStaticTriageMarkdown(triage),
				"",
				"### Feature Trace Sequence (`triage-and-feature-trace` Playbook)",
				`1. Locate static entry seeds for "${feature}" (strings, exports, UI labels, CLI flags, IPC handlers) using target-free tools or \`search_strings\` / \`search_procedures\` with \`detail: "summary"\`.`,
				'2. Walk the call & data chain hop-by-hop (`xrefs` -> `resolve_containing_procedure` -> `analyze_function`, or `trace_application_feature` for JS/Electron).',
				"3. Record each hop in `woodchipper_ledger` and output a Step-by-Step Hop Table (`Hop # | Layer | Function/Module | Address/Node ID | Evidence ID | Transformation/Side Effect`) followed by separated Observations, Inferences, and Unknowns.",
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
			const prompt = [
				`Produce a clean-room behavioral specification (\`CLONE_SPEC.md\`) for \`${triage.resolvedPath}\`.`,
				"",
				formatStaticTriageMarkdown(triage),
				"",
				"### Clean-Room Specification Rules (`clean-room-and-porting` Playbook)",
				"1. Extract ONLY behavioral contracts, state machines, mathematical formulas, persistence schemas (`inspect_sqlite_database` / `inspect_plist`), and wire/IPC protocols—never copy proprietary code, branding, or assets.",
				'2. Use `build_reconstruction_obligation_ledger` (where supported) and target-free `detail: "summary"` views first.',
				"3. Cite every behavioral requirement with `[Evidence: <evidence_id> @ <address/node_id>]` and mark any unverified branch with `[UNKNOWN: <reason & next probe>]` in `woodchipper_ledger`.",
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
			const prompt = [
				`Conduct a defensive trust-boundary and source-to-sink security audit on authorized target \`${triage.resolvedPath}\`.`,
				"",
				formatStaticTriageMarkdown(triage),
				"",
				"### Defensive Security Audit Sequence (`security-and-vr` Playbook)",
				"1. Load `skills/woodchipper-audit/SKILL.md` and `playbooks/security-and-vr.md`.",
				'2. Enumerate untrusted entry surfaces (IPC handlers, network parsers, exported Android components, IOCTLs, Electron fuses via `inspect_electron_fuses`) with `detail: "summary"`.',
				"3. Trace paths from untrusted sources to privileged sinks (`execve`/`system`/`child_process`, `shell.openExternal`, memory copies, file/SQLite writes) and verify all guards/bounds checks along the path.",
				"4. Never report an unverified static hypothesis as a confirmed vulnerability—log each candidate in `woodchipper_ledger` with Source (`evidence_id` + address), Sink (`evidence_id` + address), Observed Guards, Status (`Observation` vs `Inference`), and Minimal Controlled Validation Step.",
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
				ctx.ui.notify("Cleared Woodchipper Evidence Ledger (.woodchipper/evidence-ledger.json).", "info");
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
					details: { counts, ledgerPath: ledger.getLedgerPath() },
				},
				{ triggerTurn: false },
			);
			ctx.ui.notify(
				`Ledger: ${counts.evidenceIds} ev_* IDs, ${counts.observations} obs, ${counts.inferences} inf, ${counts.unresolvedUnknowns} open unknowns`,
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

	// =========================================================================
	// 5. System Prompt Enrichment (pi.on("before_agent_start"))
	// =========================================================================
	pi.on("before_agent_start", (event) => {
		const disciplineSection = [
			"Woodchipper 5.5-Series Reverse-Engineering Operating Discipline:",
			"1. Three-Bucket Epistemology: Strictly separate every finding into Observations (direct tool output + `evidence_id` `ev_...` + address/node ID), Inferences (hypotheses with confidence and competing explanations), and Unknowns (unexamined paths or truncated pages logged via `woodchipper_ledger` or `record_unknown`).",
			'2. Summary-First Context Protection: Always pass `detail: "summary"` first on high-volume REA tools (`analyze_javascript_application`, `inspect_binary_layout`, `inspect_macho`, `inspect_artifact`, `inspect_managed_artifact`, `inspect_wasm_artifact`, `inspect_web_network_capture`), retain `parent_evidence_id`, and page slices via `inspect_analysis_view`.',
			"3. Target-Free Before `open_binary`: Run `woodchipper_triage` and target-free path-based REA tools (`analyze_javascript_application`, `inspect_go_binary`, `inspect_rust_binary`, `inspect_elf_notes`, `inspect_pe_resources`, `inspect_sqlite_database`, `inspect_android_package`, `inspect_managed_artifact`, `inspect_wasm_artifact`, `inspect_evm_interface`, `inspect_model_artifact`, `inspect_il2cpp_metadata`) before paying the cost of `open_binary`.",
			"4. Git & Worktree Safety: Never run `git reset --hard`, `git clean -fd`, `git checkout -- <path>`, or working-tree `git restore`.",
			"5. Evidence Ledger Persistence: All captured `ev_*` IDs and 3-bucket entries are persisted in `.woodchipper/evidence-ledger.json` (query or export via `woodchipper_ledger`).",
		].join("\n");

		if (event.systemPromptOptions?.sections) {
			event.systemPromptOptions.sections.woodchipper_discipline = disciplineSection;
			return undefined;
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n<woodchipper_discipline>\n${disciplineSection}\n</woodchipper_discipline>`,
		};
	});
}
