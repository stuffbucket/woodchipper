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
