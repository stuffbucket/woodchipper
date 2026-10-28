#!/usr/bin/env node
/**
 * Render the Homebrew formula (`packaging/homebrew/woodchipper.rb`) for a release (`scripts/render-homebrew-formula.mjs`).
 *
 * Usage:
 *   node scripts/render-homebrew-formula.mjs --version X.Y.Z --sums SHA256SUMS [--template FILE] [--output FILE]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export const archiveName = (version) => `woodchipper-v${version}.tar.gz`;

export function parseSums(text) {
	const digests = new Map();
	for (const line of String(text || "").split(/\r?\n/)) {
		const match = /^([0-9a-f]{64})\s+[ *]?(.+)$/.exec(line.trim());
		if (match) {
			digests.set(match[2].trim(), match[1]);
		}
	}
	return digests;
}

export function renderFormula({ template, version, digests }) {
	const cleanVersion = String(version || "").replace(/^v/, "");
	if (!SEMVER_RE.test(cleanVersion)) {
		throw new Error(`Invalid release version '${version}'; expected X.Y.Z`);
	}
	if (!/^class Woodchipper < Formula$/m.test(template)) {
		throw new Error("Template is not the Woodchipper formula (expected 'class Woodchipper < Formula')");
	}
	const expectedArchive = archiveName(cleanVersion);
	const digest = digests.get(expectedArchive);
	if (!digest) {
		throw new Error(`No sha256 digest found for ${expectedArchive}`);
	}

	const rendered = template
		.replaceAll("PLACEHOLDER_VERSION", cleanVersion)
		.replaceAll("PLACEHOLDER_SHA256", digest);

	const leftover = /PLACEHOLDER_[A-Z0-9_]+/.exec(rendered);
	if (leftover) {
		throw new Error(`Unreplaced placeholder ${leftover[0]}`);
	}
	return rendered;
}

function main() {
	const { values } = parseArgs({
		options: {
			version: { type: "string" },
			sums: { type: "string" },
			template: { type: "string" },
			output: { type: "string" },
		},
	});
	if (!values.version || !values.sums) {
		throw new Error(
			"Usage: node scripts/render-homebrew-formula.mjs --version X.Y.Z --sums SHA256SUMS [--template FILE] [--output FILE]",
		);
	}
	const templatePath = values.template ?? join(ROOT, "packaging", "homebrew", "woodchipper.rb");
	const digests = parseSums(readFileSync(values.sums, "utf8"));
	const formula = renderFormula({
		template: readFileSync(templatePath, "utf8"),
		version: values.version,
		digests,
	});
	if (!values.output) {
		process.stdout.write(formula);
	} else {
		writeFileSync(values.output, formula, "utf8");
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (err) {
		process.stderr.write(`render-homebrew-formula: ${err.message}\n`);
		process.exit(1);
	}
}
