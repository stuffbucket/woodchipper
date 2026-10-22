#!/usr/bin/env node
/**
 * Woodchipper Harness Builder & Verifier (`scripts/build-harness.mjs`)
 *
 * Prepares the custom Woodchipper Pi harness in the project directory:
 * 1. Verifies the `vendor/pi` git submodule (`earendil-works/pi`) is initialized.
 * 2. Ensures `.woodchipper/` runtime directory exists with restrictive permissions (`0700`).
 * 3. Verifies `.pi/settings.json`, `.pi/SYSTEM.md`, `.pi/extensions/woodchipper-rea.ts`,
 *    `.pi/extensions/woodchipper-peer.ts`, `bin/woodchipper.mjs`, and `scripts/woodchipper-ctl.mjs`.
 * 4. Optionally builds `vendor/pi` from source when `--with-submodule-build` is passed
 *    (using `npm ci --ignore-scripts`).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiCommand } from "../bin/woodchipper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

const REQUIRED_PATHS = [
	"vendor/pi/package.json",
	"vendor/pi/packages/coding-agent/package.json",
	".pi/settings.json",
	".pi/SYSTEM.md",
	".pi/extensions/woodchipper-rea.ts",
	".pi/extensions/woodchipper-peer.ts",
	".pi/extensions/lib/evidence-ledger.ts",
	".pi/extensions/lib/triage.ts",
	".pi/extensions/lib/peer-protocol.ts",
	".pi/extensions/lib/schema.ts",
	"bin/woodchipper.mjs",
	"scripts/woodchipper-ctl.mjs",
];

function main() {
	const withSubmoduleBuild = process.argv.includes("--with-submodule-build");

	console.log("=== Building & Verifying Woodchipper Pi Harness ===");

	// 1. Ensure .woodchipper state directory exists with 0700 permissions
	const stateDir = path.join(PROJECT_ROOT, ".woodchipper");
	fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(stateDir, 0o700);
	} catch {
		// Ignore on filesystems without POSIX chmod
	}

	// 2. Check required harness files and vendor/pi submodule
	for (const rel of REQUIRED_PATHS) {
		const abs = path.join(PROJECT_ROOT, rel);
		if (!fs.existsSync(abs)) {
			throw new Error(`Missing required harness file: ${rel}`);
		}
		console.log(`OK:   ${rel}`);
	}

	// Ensure executable permissions on CLI entrypoints
	for (const scriptRel of ["bin/woodchipper.mjs", "scripts/woodchipper-ctl.mjs", "scripts/build-harness.mjs"]) {
		fs.chmodSync(path.join(PROJECT_ROOT, scriptRel), 0o755);
	}

	// 3. Optional source build of vendor/pi submodule
	if (withSubmoduleBuild) {
		console.log("\nBuilding vendor/pi submodule from source (--ignore-scripts)...");
		const piDir = path.join(PROJECT_ROOT, "vendor", "pi");
		execFileSync("npm", ["ci", "--ignore-scripts"], { cwd: piDir, stdio: "inherit" });
		execFileSync("npm", ["run", "build"], { cwd: piDir, stdio: "inherit" });
	}

	const piResolved = resolvePiCommand();
	console.log(`\nOK:   Resolved Pi runtime -> ${piResolved.command} (${piResolved.source})`);
	console.log("Woodchipper Pi harness is ready.");
}

main();
