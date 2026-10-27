#!/usr/bin/env node
/**
 * Woodchipper Mutation Test Runner (`scripts/mutation-test.mjs`)
 *
 * Verifies that the Woodchipper test suite kills targeted security and logic mutants
 * across `.pi/extensions/lib/peer-protocol.ts`, `.pi/extensions/woodchipper-rea.ts`,
 * `.pi/extensions/woodchipper-peer.ts`, `.pi/extensions/lib/evidence-ledger.ts`,
 * and `scripts/woodchipper-ctl.mjs`.
 *
 * Each mutant is applied in-place, the relevant test file is executed, and we assert
 * that the test suite FAILS (mutant killed). The original file content is always restored
 * in a `finally` block.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const MUTANTS = [
	{
		id: "M1_UDS_AUTH_BYPASS",
		description: "Disable UDS authentication check in WoodchipperPeerServer.processLine",
		file: ".pi/extensions/lib/peer-protocol.ts",
		target: "if (!authState.isAuthenticated()) {",
		replacement: "if (false && !authState.isAuthenticated()) {",
		testFile: "tests/peer-extension.test.mjs",
	},
	{
		id: "M2_TOKEN_VERIFY_ALWAYS_TRUE",
		description: "Force verifyToken() to accept any token",
		file: ".pi/extensions/lib/peer-protocol.ts",
		target: "return crypto.timingSafeEqual(provided, expected);",
		replacement: "return true;",
		testFile: "tests/peer-extension.test.mjs",
	},
	{
		id: "M3_CONFUSED_DEPUTY_SOCKET_TRUST",
		description: "Force isTrustedPeerSocketPath() to trust arbitrary socket paths",
		file: ".pi/extensions/lib/peer-protocol.ts",
		target: "if (resolvedParent !== resolvedDir) return false;",
		replacement: "if (false && resolvedParent !== resolvedDir) return false;",
		testFile: "tests/peer-extension.test.mjs",
	},
	{
		id: "M4_AUTO_REPLY_INFINITE_LOOP",
		description: "Remove !parsed.isReply guard so auto-replies trigger endless ping-pong replies",
		file: ".pi/extensions/lib/peer-protocol.ts",
		target: "!parsed.isReply &&",
		replacement: "true &&",
		testFile: "tests/peer-extension.test.mjs",
	},
	{
		id: "M5_XML_ENVELOPE_BREAKOUT",
		description: "Disable sanitizeCrossSessionBody() closing-tag neutralization",
		file: ".pi/extensions/lib/peer-protocol.ts",
		target: 'match.startsWith("</") ? "<\\\\/cross-session-message" : "<\\\\cross-session-message"',
		replacement: "match",
		testFile: "tests/peer-extension.test.mjs",
	},
	{
		id: "M6_STALE_ASSISTANT_TEXT_ON_BUSY",
		description: "Stop clearing lastAssistantText when entering busy state",
		file: ".pi/extensions/lib/peer-protocol.ts",
		target: 'this.lastAssistantText = "";',
		replacement: "// mutated: keep stale lastAssistantText",
		testFile: "tests/peer-extension.test.mjs",
	},
	{
		id: "M7_PEER_NAME_DEFAULT_OVERRIDE",
		description: "Reintroduce default: 'woodchipper' on peer-name flag",
		file: ".pi/extensions/woodchipper-peer.ts",
		target: 'description: "Custom peer name registered in ~/.claude/sessions for Claude Code ListAgents/SendMessage",\n\t\ttype: "string",',
		replacement:
			'description: "Custom peer name registered in ~/.claude/sessions for Claude Code ListAgents/SendMessage",\n\t\ttype: "string",\n\t\tdefault: "woodchipper",',
		testFile: "tests/peer-extension.test.mjs",
	},
	{
		id: "M8_SUMMARY_FIRST_GUARDRAIL",
		description: "Disable default detail='summary' injection on high-volume REA tools",
		file: ".pi/extensions/woodchipper-rea.ts",
		target: 'inputRecord.detail = "summary";',
		replacement: '// mutated: do not set detail = "summary"',
		testFile: "tests/pi-extension.test.mjs",
	},
	{
		id: "M9_GIT_BLOCKER_NORMALIZATION",
		description: "Disable git command normalization (-C, quotes, line continuations) in checkDestructiveGitCommand",
		file: ".pi/extensions/woodchipper-rea.ts",
		target: "const normalized = normalizeGitShellCommand(command);",
		replacement: "const normalized = command;",
		testFile: "tests/pi-extension.test.mjs",
	},
	{
		id: "M10_GIT_RESTORE_BLOCKER",
		description: "Disable working-tree git restore blocking",
		file: ".pi/extensions/woodchipper-rea.ts",
		target: "if (!hasStaged || hasWorktree) {",
		replacement: "if (false && (!hasStaged || hasWorktree)) {",
		testFile: "tests/pi-extension.test.mjs",
	},
	{
		id: "M11_NON_REA_EV_SCRAPING",
		description: "Allow non-REA built-in tools (read/bash/grep) to scrape ev_* IDs into ledger",
		file: ".pi/extensions/woodchipper-rea.ts",
		target: "return !NON_REA_BUILTIN_TOOLS.has(toolName);",
		replacement: "return true;",
		testFile: "tests/pi-extension.test.mjs",
	},
	{
		id: "M12_MONOTONIC_LEDGER_IDS",
		description: "Revert nextMonotonicId to array length + 1 (causing duplicate IDs after deletion/gaps)",
		file: ".pi/extensions/lib/evidence-ledger.ts",
		target: "return `${prefix}_${maxNum + 1}`;",
		replacement: "return `${prefix}_${existingIds.length + 1}`;",
		testFile: "tests/pi-extension.test.mjs",
	},
	{
		id: "M13_CTL_FUZZY_PEER_MATCH",
		description: "Reintroduce substring fuzzy matching in woodchipper-ctl findPeer()",
		file: "scripts/woodchipper-ctl.mjs",
		target: "return peers.find((p) => p.name === nameOrPid || String(p.pid) === nameOrPid);",
		replacement: "return peers.find((p) => p.name.includes(nameOrPid));",
		testFile: "tests/peer-extension.test.mjs",
	},
	{
		id: "M14_MAXIMAL_REMOTE_HTTP_GUARD",
		description: "Disable non-loopback HTTP rejection in normalizeMaximalBaseUrl()",
		file: ".pi/extensions/lib/maximal-provider.ts",
		target: "if (parsed.protocol === \"http:\" && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) && !allowRemoteHttp) {",
		replacement: "if (false && parsed.protocol === \"http:\") {",
		testFile: "tests/maximal-extension.test.mjs",
	},
	{
		id: "M15_MAXIMAL_DISABLED_API_KEY_FILTER",
		description: "Allow disabled apiKeyEntries in resolveMaximalApiKey()",
		file: ".pi/extensions/lib/maximal-provider.ts",
		target: "(e) => e && e.enabled !== false && typeof e.key === \"string\" && e.key.trim().length > 0,",
		replacement: "(e) => e && typeof e.key === \"string\" && e.key.trim().length > 0,",
		testFile: "tests/maximal-extension.test.mjs",
	},
	{
		id: "M16_MAXIMAL_EMBEDDING_FILTER",
		description: "Stop filtering out embedding models in buildPiModelsFromWireList()",
		file: ".pi/extensions/lib/maximal-provider.ts",
		target: "if (!id || seen.has(id) || isEmbeddingOrNonChatModel(id)) continue;",
		replacement: "if (!id || seen.has(id)) continue;",
		testFile: "tests/maximal-extension.test.mjs",
	},
	{
		id: "M17_REA_INPUT_NORMALIZER",
		description: "Disable REA 6.7.0 parameter alias normalization in woodchipper-rea tool_call hook",
		file: ".pi/extensions/woodchipper-rea.ts",
		target: "if (isReaTool(event.toolName)) {\n\t\t\t\tnormalizeReaToolInput(event.toolName, inputRecord);\n\t\t\t}",
		replacement: "if (false) {\n\t\t\t\tnormalizeReaToolInput(event.toolName, inputRecord);\n\t\t\t}",
		testFile: "tests/pi-extension.test.mjs",
	},
	{
		id: "M18_GLINER_AUTO_PULL",
		description: "Disable automatic decide-340m model installation in ensureGlinerModelInstalled()",
		file: ".pi/extensions/lib/gliner-classifier.ts",
		target: "// Auto-pull decide-340m via CLI when missing\n\t\tif (!installed && autoPull) {",
		replacement: "// Auto-pull decide-340m via CLI when missing\n\t\tif (false && !installed && autoPull) {",
		testFile: "tests/pi-extension.test.mjs",
	},
	{
		id: "M19_MAXIMAL_REFUSAL_FAILOVER",
		description: "Disable automatic model failover on upstream cyber-policy refusal in woodchipper-maximal",
		file: ".pi/extensions/woodchipper-maximal.ts",
		target: "const check = isCyberPolicyRefusalOrBlock(lastMsg);\n\t\tif (!check.refused) return;",
		replacement: "const check = isCyberPolicyRefusalOrBlock(lastMsg);\n\t\tif (true || !check.refused) return;",
		testFile: "tests/maximal-extension.test.mjs",
	},
	{
		id: "M20_EXPERTISE_PERSONA_ESCALATION",
		description: "Disable Appliance-to-Expert persona escalation when multiple domain signals are present",
		file: ".pi/extensions/lib/gliner-classifier.ts",
		target: "if (detectedDomainSignals.length >= 2) {\n\t\texpertiseLevel = \"expert\";",
		replacement: "if (false && detectedDomainSignals.length >= 2) {\n\t\texpertiseLevel = \"expert\";",
		testFile: "tests/pi-extension.test.mjs",
	},
	{
		id: "M21_METHODOLOGY_PUSHBACK_ADVISORY",
		description: "Disable proactive Static-Before-Dynamic methodology pushback advisory",
		file: ".pi/extensions/lib/gliner-classifier.ts",
		target: "if (\n\t\t/\\b(frida|gdb|lldb|run\\s+it|execute\\s+it|launch\\s+it|hook\\s+|attach\\s+to)\\b/i.test(lower) &&",
		replacement: "if (\n\t\tfalse && /\\b(frida|gdb|lldb|run\\s+it|execute\\s+it|launch\\s+it|hook\\s+|attach\\s+to)\\b/i.test(lower) &&",
		testFile: "tests/pi-extension.test.mjs",
	},
	{
		id: "M22_CROSS_PROJECT_WORKSPACE_ISOLATION",
		description: "Force deriveWorkspaceSlug() to return a shared 'default' folder, commingling unrelated target projects",
		file: ".pi/extensions/lib/evidence-ledger.ts",
		target: "if (!raw || raw === \"default\") {\n\t\treturn \"default\";\n\t}",
		replacement: "if (true || !raw || raw === \"default\") {\n\t\treturn \"default\";\n\t}",
		testFile: "tests/pi-extension.test.mjs",
	},
	{
		id: "M23_EXIT_COMMAND_SHUTDOWN",
		description: "Disable ctx.shutdown() invocation in /exit command handler",
		file: ".pi/extensions/woodchipper-rea.ts",
		target: "if (typeof ctx?.shutdown === \"function\") {\n\t\t\t\tctx.shutdown();\n\t\t\t}",
		replacement: "if (false && typeof ctx?.shutdown === \"function\") {\n\t\t\t\tctx.shutdown();\n\t\t\t}",
		testFile: "tests/pi-extension.test.mjs",
	},
	{
		id: "M24_OVERSIZED_TOOL_RESULT_CAP",
		description: "Disable oversized REA tool result truncation in capOversizedReaToolText()",
		file: ".pi/extensions/woodchipper-rea.ts",
		target: "if (text.length <= maxChars) {\n\t\treturn { text, truncated: false };\n\t}",
		replacement: "if (true || text.length <= maxChars) {\n\t\treturn { text, truncated: false };\n\t}",
		testFile: "tests/pi-extension.test.mjs",
	},
	{
		id: "M25_CLEAR_COMMAND_NEW_SESSION",
		description: "Disable ctx.newSession() invocation in /clear command handler",
		file: ".pi/extensions/woodchipper-rea.ts",
		target: "if (typeof ctx?.newSession === \"function\") {\n\t\t\tawait ctx.newSession();\n\t\t}",
		replacement: "if (false && typeof ctx?.newSession === \"function\") {\n\t\t\tawait ctx.newSession();\n\t\t}",
		testFile: "tests/pi-extension.test.mjs",
	},
];

function runTestFile(relTestFile) {
	const res = spawnSync(process.execPath, ["--experimental-strip-types", "--test", path.join(ROOT, relTestFile)], {
		cwd: ROOT,
		encoding: "utf8",
		timeout: 30_000,
	});
	return res.status === 0;
}

function main() {
	console.log(`=== Running Woodchipper Mutation Test Suite (${MUTANTS.length} mutants) ===\n`);

	let killed = 0;
	const survived = [];

	for (const mutant of MUTANTS) {
		const absPath = path.join(ROOT, mutant.file);
		const original = fs.readFileSync(absPath, "utf8");

		if (!original.includes(mutant.target)) {
			throw new Error(`Mutant ${mutant.id}: target snippet not found in ${mutant.file}`);
		}

		try {
			const mutated = original.replace(mutant.target, mutant.replacement);
			fs.writeFileSync(absPath, mutated, "utf8");

			const passed = runTestFile(mutant.testFile);
			if (!passed) {
				killed++;
				console.log(`KILLED   [${mutant.id}] ${mutant.description}`);
			} else {
				survived.push(mutant);
				console.error(`SURVIVED [${mutant.id}] ${mutant.description}`);
			}
		} finally {
			fs.writeFileSync(absPath, original, "utf8");
		}
	}

	console.log(`\nMutation Score: ${killed}/${MUTANTS.length} (${((killed / MUTANTS.length) * 100).toFixed(1)}%)`);
	if (survived.length > 0) {
		console.error(`Failed: ${survived.length} mutant(s) survived.`);
		process.exit(1);
	}
}

main();
