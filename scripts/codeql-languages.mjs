#!/usr/bin/env node
/**
 * Decide which CodeQL languages a change needs scanned (`scripts/codeql-languages.mjs`).
 *
 *   printf '%s\n' <changed paths...> | node scripts/codeql-languages.mjs
 *   echo ALL | node scripts/codeql-languages.mjs    # schedule, dispatch, unknown diff
 *
 * Prints a JSON array for the workflow matrix, e.g. `["javascript-typescript"]` or `[]`.
 * A file only counts if CodeQL would analyze it: anything under `.github/codeql/codeql-config.yml`'s
 * `paths-ignore` is skipped here too, so docs-only or test-only PRs finish in seconds.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ALL_LANGUAGES = ["actions", "javascript-typescript"];

const CONFIG_REL = ".github/codeql/codeql-config.yml";
const RESCAN_ALL = new Set([
	CONFIG_REL,
	".github/workflows/codeql.yml",
	"scripts/codeql-languages.mjs",
]);

const JS_SOURCE = /\.(?:[cm]?[jt]sx?|astro|html?)$/;
const JS_CONFIG = /(?:^|\/)(?:package\.json|tsconfig[\w.-]*\.json)$/;

/**
 * Parse `paths-ignore` list from `.github/codeql/codeql-config.yml` without external YAML deps.
 */
export function readPathsIgnore(yamlText) {
	const lines = String(yamlText || "").split(/\r?\n/);
	const out = [];
	let inPathsIgnore = false;
	for (const rawLine of lines) {
		const trimmed = rawLine.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (/^paths-ignore:\s*$/.test(trimmed)) {
			inPathsIgnore = true;
			continue;
		}
		if (inPathsIgnore) {
			const itemMatch = trimmed.match(/^-\s+["']?([^"']+?)["']?\s*$/);
			if (itemMatch) {
				out.push(itemMatch[1]);
			} else if (/^[a-zA-Z0-9_-]+:/.test(trimmed)) {
				inPathsIgnore = false;
			}
		}
	}
	return out;
}

function globToRegExp(glob) {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*\//g, "(?:.+/)?")
		.replace(/\*\*/g, ".*")
		.replace(/\*/g, "[^/]*");
	return new RegExp(`^${escaped}(?:$|/)`);
}

export function isIgnored(file, ignoreList) {
	const normalized = String(file || "").replace(/^\/+/, "");
	for (const entry of ignoreList) {
		if (entry.includes("*")) {
			if (globToRegExp(entry).test(normalized)) return true;
		} else if (normalized === entry || normalized.startsWith(`${entry}/`)) {
			return true;
		}
	}
	return false;
}

export function languageOf(file, ignoreList) {
	const normalized = String(file || "").replace(/^\/+/, "");
	if (normalized.startsWith(".github/workflows/") || normalized.startsWith(".github/actions/")) {
		return "actions";
	}
	if (isIgnored(normalized, ignoreList)) {
		return undefined;
	}
	if (JS_SOURCE.test(normalized) || JS_CONFIG.test(normalized)) {
		return "javascript-typescript";
	}
	return undefined;
}

export function languagesFor(changed, ignoreList) {
	if (changed === "all" || changed.some((f) => RESCAN_ALL.has(f))) {
		return [...ALL_LANGUAGES];
	}
	const touched = new Set();
	for (const file of changed) {
		const lang = languageOf(file, ignoreList);
		if (lang) touched.add(lang);
	}
	return ALL_LANGUAGES.filter((l) => touched.has(l));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const input = fs
		.readFileSync(0, "utf8")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	const yamlText = fs.existsSync(CONFIG_REL) ? fs.readFileSync(CONFIG_REL, "utf8") : "";
	const ignoreList = readPathsIgnore(yamlText);
	const changed = input.length === 0 || input.includes("ALL") ? "all" : input;
	process.stdout.write(`${JSON.stringify(languagesFor(changed, ignoreList))}\n`);
}
