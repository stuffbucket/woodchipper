#!/usr/bin/env node
/**
 * Woodchipper End-to-End Harness Smoke Verification (`scripts/smoke-test.mjs`)
 *
 * Exercises the complete Woodchipper reverse-engineering pipeline against the bundled
 * fixture application (`tests/fixtures/sample-electron-app`):
 * 1. Target-Free Static Reconnaissance (`runStaticTriage`)
 * 2. Plain-English Intent Routing & Adaptive Operator/Expert Calibration (`gliner-classifier.ts`)
 * 3. Real REA 6.7.0 `analyze-javascript-application` (`detail: "summary"`) on the fixture app
 * 4. Three-Bucket Evidence Ledger extraction (`ev_*` IDs, Observations, Inferences, Unknowns)
 * 5. Maximal Provider & Refusal Failover verification
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { EvidenceLedger } from "../.pi/extensions/lib/evidence-ledger.ts";
import {
	assessExpertiseAndMethodologyFeedback,
	classifyBinarySignals,
	classifyReverseEngineeringIntent,
} from "../.pi/extensions/lib/gliner-classifier.ts";
import {
	isCyberPolicyRefusalOrBlock,
	probeMaximalProvider,
	selectNextFallbackModel,
} from "../.pi/extensions/lib/maximal-provider.ts";
import { formatStaticTriageMarkdown, resolveReaEntryScript, runStaticTriage } from "../.pi/extensions/lib/triage.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIXTURE_DIR = path.join(ROOT, "tests", "fixtures", "sample-electron-app");

async function main() {
	console.log("=== Woodchipper End-to-End Smoke Verification ===\n");

	// 1. Static Triage on fixture Electron app
	const triage = runStaticTriage(FIXTURE_DIR, ROOT);
	assert.equal(triage.exists, true);
	assert.equal(triage.recommendedSubSkill, "woodchipper-js-web");
	console.log("1. Static Triage (tests/fixtures/sample-electron-app):");
	console.log(`   - Recommended Sub-Skill: ${triage.recommendedSubSkill}`);
	console.log(`   - Recommended Playbook:  ${triage.recommendedPlaybook}`);
	console.log(`   - First REA Tool:        ${triage.targetFreeToolsFirst[0]}\n`);

	// 2. Appliance-Operator vs. Expert Intent & Methodology Feedback
	const applianceIntent = await classifyReverseEngineeringIntent(
		"What does this Electron app do, how does license verification work, and is export-diagnostics safe?",
		{ projectRoot: ROOT },
	);
	const applianceFeedback = assessExpertiseAndMethodologyFeedback(
		"Does this app phone home to telemetry.acme-internal.example?",
	);
	const expertFeedback = assessExpertiseAndMethodologyFeedback(
		"Attach Frida to ipcMain at 0x100004a20 and decompile all functions in main.js",
	);
	assert.equal(applianceFeedback.expertiseLevel, "appliance-operator");
	assert.equal(expertFeedback.expertiseLevel, "expert");
	assert.ok(expertFeedback.methodologyAdvisories.length >= 2);
	console.log(`2. Intent & Persona Calibration (${applianceIntent.source}):`);
	console.log(`   - Routed Playbook:       ${applianceIntent.recommendedPlaybook}`);
	console.log(`   - Appliance Mode Check:  ${applianceFeedback.expertiseLevel} (${applianceFeedback.methodologyAdvisories.length} advisory)`);
	console.log(`   - Expert Pushback Check: ${expertFeedback.expertiseLevel} (${expertFeedback.methodologyAdvisories.length} advisories)\n`);

	// 3. Binary Signal Capability Classification
	const signals = await classifyBinarySignals(
		[
			"https://telemetry.acme-internal.example/v2/events",
			"ipcMain.handle('acme:export-diagnostics')",
			"exec(`tar -czf \"${outPath}.tar.gz\"`)",
			"computeLicenseChecksum(serialKey)",
		],
		{ projectRoot: ROOT },
	);
	console.log("3. Capability Signal Classification:");
	for (const item of signals.items) {
		console.log(`   - ${item.signal} -> [${item.capabilities.join(", ")}]`);
	}
	console.log();

	// 4. Real REA 6.7.0 JavaScript Application Analysis + 3-Bucket Ledger
	const reaScript = resolveReaEntryScript(ROOT);
	const reaOut = execFileSync(
		process.execPath,
		[reaScript, "analyze-javascript-application", FIXTURE_DIR, "--json"],
		{
			cwd: ROOT,
			encoding: "utf8",
			timeout: 30_000,
		},
	);
	const parsedRea = JSON.parse(reaOut);
	const ledger = new EvidenceLedger(ROOT);
	const ws = ledger.setTargetWorkspace(FIXTURE_DIR);
	ledger.clear();
	ledger.writeTriageMap(formatStaticTriageMarkdown(triage));
	const tracked = ledger.extractFromToolResult("analyze_javascript_application", [reaOut], parsedRea);
	assert.ok(tracked.length > 0, "Expected REA analyze-javascript-application to produce ev_* Evidence IDs");

	const primaryEvId = tracked[0].id;
	ledger.addObservation({
		evidenceId: primaryEvId,
		location: "main.js:ipcMain.handle('acme:export-diagnostics')",
		summary: "Registers IPC handler 'acme:export-diagnostics' which interpolates payload.reportName into outPath and passes it to child_process.exec('tar -czf ...')",
		toolName: "analyze_javascript_application",
	});
	ledger.addObservation({
		evidenceId: primaryEvId,
		location: "main.js:computeLicenseChecksum",
		summary: "Implements 32-bit FNV-1a style hash (seed 0x811c9dc5, prime 0x01000193) compared against constant 0x4b9d102a",
		toolName: "analyze_javascript_application",
	});
	ledger.addInference({
		statement: "Renderer callers invoking window.acmeDesktop.exportDiagnostics({ reportName, compressWithTar: true }) can trigger shell command injection via unescaped double quotes in reportName",
		confidence: "high",
		supportingEvidenceIds: [primaryEvId],
		competingExplanations: ["Upstream caller may sanitize reportName before IPC invocation"],
	});
	ledger.addUnknown({
		description: "Whether index.html or additional renderer bundles constrain #report-name input characters",
		reason: "index.html DOM attributes not yet inspected",
		nextProbe: "inspect_analysis_view on remaining module nodes",
	});

	console.log(`4. REA 6.7.0 Analysis & Isolated Target Workspace (${tracked.length} ev_* IDs captured):`);
	console.log(`   - Workspace Directory:   ${ws.workspaceDir}`);
	console.log(`   - Visible Triage Map:    ${ws.triageMapPath}`);
	console.log(`   - Visible Report File:   ${ws.reportPath}`);
	console.log(`   - Visible Ledger JSON:   ${ws.ledgerPath}`);
	console.log(`   - Primary Evidence ID:   ${primaryEvId}`);
	console.log(`   - Ledger Counts:         ${JSON.stringify(ledger.getCounts())}\n`);
	assert.equal(fs.existsSync(ws.reportPath), true, "Expected visible workspaces/<target>/REPORT.md to be written");
	assert.equal(fs.existsSync(ws.triageMapPath), true, "Expected visible workspaces/<target>/TRIAGE_MAP.md to be written");

	// 5. Maximal Provider & Refusal Failover Readiness
	const maximalProbe = await probeMaximalProvider();
	const refusalCheck = isCyberPolicyRefusalOrBlock({
		role: "assistant",
		stopReason: "error",
		errorMessage: "400 invalid_request_error: Blocked by upstream cyber safety policy",
	});
	const nextModel = selectNextFallbackModel("claude-opus-5-5-20260301", new Set(["claude-opus-5-5-20260301"]), maximalProbe.models);
	assert.equal(refusalCheck.refused, true);
	assert.equal(nextModel?.id, "claude-sonnet-5-5-20260301");
	console.log("5. Maximal Provider & Failover Check:");
	console.log(`   - Maximal Endpoint:      ${maximalProbe.baseUrl} (${maximalProbe.reachable ? "ONLINE" : "FALLBACK"})`);
	console.log(`   - Models Available:      ${maximalProbe.models.length}`);
	console.log(`   - Refusal Failover Target: maximal/${nextModel?.id}\n`);

	console.log("Smoke verification passed.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
