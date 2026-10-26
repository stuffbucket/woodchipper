#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "vendor", "overrides", "pi-audit.json");
const AUDIT_REPORT_PATH = path.join(ROOT, ".woodchipper", "pi-npm-audit.json");

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, "\t")}\n`);
}

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: ROOT,
		encoding: "utf8",
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
		...options,
	});
}

function effectiveRegistry() {
	if (process.env.WOODCHIPPER_NPM_REGISTRY) {
		return process.env.WOODCHIPPER_NPM_REGISTRY;
	}

	const configured = run("pnpm", ["config", "get", "registry"], { capture: true }).trim();
	if (!configured || configured === "undefined") {
		throw new Error("No package registry is configured; set WOODCHIPPER_NPM_REGISTRY or configure pnpm via ~/.npmrc");
	}
	return configured;
}

function verifySource(config) {
	const sourceRoot = path.join(ROOT, config.source.submodule);
	const packagePath = path.join(sourceRoot, "packages", "coding-agent", "package.json");
	if (!fs.existsSync(packagePath)) {
		throw new Error(`Missing Pi submodule at ${config.source.submodule}; run git submodule update --init --recursive`);
	}

	const packageJson = readJson(packagePath);
	if (packageJson.name !== config.source.package || packageJson.version !== config.source.version) {
		throw new Error(
			`${config.source.submodule} contains ${packageJson.name}@${packageJson.version}, expected ${config.source.package}@${config.source.version}`,
		);
	}

	const commit = run("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { capture: true }).trim();
	if (commit !== config.source.commit) {
		throw new Error(`${config.source.submodule} is at ${commit}, expected ${config.source.commit}`);
	}

	const status = run("git", ["-C", sourceRoot, "status", "--porcelain"], { capture: true }).trim();
	if (status) {
		throw new Error(`${config.source.submodule} has local changes; refusing to stage an unpinned source tree`);
	}

	return sourceRoot;
}

function copySource(sourceRoot, outputRoot) {
	fs.rmSync(outputRoot, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(outputRoot), { recursive: true, mode: 0o700 });
	fs.cpSync(sourceRoot, outputRoot, {
		recursive: true,
		filter(sourcePath) {
			const relative = path.relative(sourceRoot, sourcePath);
			return !relative.split(path.sep).some((part) => part === ".git" || part === "node_modules" || part === "dist");
		},
	});
}

function findPackageManifests(root) {
	const manifests = [];
	const visit = (directory) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(entryPath);
			} else if (entry.name === "package.json") {
				manifests.push(entryPath);
			}
		}
	};
	visit(root);
	return manifests;
}

function applyManifestOverlay(config, outputRoot) {
	const manifests = findPackageManifests(outputRoot);
	const packages = manifests.map((filePath) => ({ filePath, json: readJson(filePath), changed: false }));

	for (const replacement of config.manifest_replacements) {
		let matches = 0;
		for (const entry of packages) {
			if (replacement.package && entry.json.name !== replacement.package) {
				continue;
			}
			if (entry.json[replacement.section]?.[replacement.name] === replacement.from) {
				entry.json[replacement.section][replacement.name] = replacement.to;
				entry.changed = true;
				matches++;
			}
		}
		if (matches !== replacement.expected_matches) {
			throw new Error(
				`Pi overlay replacement ${replacement.name} ${replacement.from} -> ${replacement.to} matched ${matches} manifests; expected ${replacement.expected_matches}`,
			);
		}
	}

	for (const entry of packages) {
		if (entry.changed) {
			writeJson(entry.filePath, entry.json);
		}
	}

	const rootPackagePath = path.join(outputRoot, "package.json");
	const rootPackage = readJson(rootPackagePath);
	for (const dependency of config.exclude_from_runtime_build.devDependencies) {
		if (!Object.hasOwn(rootPackage.devDependencies ?? {}, dependency)) {
			throw new Error(`Pi runtime exclusion is missing expected devDependency ${dependency}`);
		}
		delete rootPackage.devDependencies[dependency];
	}
	for (const workspace of config.exclude_from_runtime_build.workspaces) {
		if (!rootPackage.workspaces.includes(workspace)) {
			throw new Error(`Pi runtime exclusion is missing expected workspace ${workspace}`);
		}
		rootPackage.workspaces = rootPackage.workspaces.filter((entry) => entry !== workspace);
	}

	const resolveFileSpecs = (value) => {
		if (typeof value === "string" && value.startsWith("file:")) {
			return `file:${path.join(ROOT, value.slice("file:".length))}`;
		}
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, resolveFileSpecs(nested)]));
		}
		return value;
	};
	rootPackage.overrides = {
		...rootPackage.overrides,
		...resolveFileSpecs(config.overrides),
	};
	writeJson(rootPackagePath, rootPackage);

	// Regenerate inside the ignored build tree. Keeping vendor/pi immutable is more important
	// than preserving its vulnerable lock graph; all remediated versions above are exact pins.
	fs.rmSync(path.join(outputRoot, "package-lock.json"), { force: true });
}

function verifyLock(config, outputRoot) {
	const lock = readJson(path.join(outputRoot, "package-lock.json"));
	for (const [packagePath, expectedVersion] of Object.entries(config.expected_lock_versions)) {
		const actualVersion = lock.packages?.[packagePath]?.version;
		if (actualVersion !== expectedVersion) {
			throw new Error(`Pi overlay lock has ${packagePath}@${actualVersion ?? "missing"}; expected ${expectedVersion}`);
		}
	}

	const fastUri = lock.packages?.["node_modules/fast-uri"];
	if (!fastUri?.link || !fastUri.resolved?.endsWith("vendor/overrides/packages/fast-uri")) {
		throw new Error("Pi overlay lock does not link the Docker-built fast-uri@3.1.9 package");
	}
}

function audit(config, outputRoot, npmEnvironment) {
	const result = spawnSync("npm", ["audit", "--json", "--package-lock-only"], {
		cwd: outputRoot,
		encoding: "utf8",
		env: npmEnvironment,
	});
	if (!result.stdout.trim()) {
		throw new Error(`npm audit produced no JSON output: ${result.stderr.trim()}`);
	}

	const report = JSON.parse(result.stdout);
	fs.writeFileSync(AUDIT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
	fs.chmodSync(AUDIT_REPORT_PATH, 0o600);
	if (report.error) {
		throw new Error(`npm audit failed: ${report.error.summary ?? report.error.code ?? "unknown error"}`);
	}

	const findings = Object.keys(report.vulnerabilities ?? {}).sort();
	const allowed = Object.keys(config.allowed_audit_findings).sort();
	const unexpected = findings.filter((name) => !allowed.includes(name));
	if (unexpected.length > 0) {
		throw new Error(`Pi overlay has unexpected audit findings: ${unexpected.join(", ")}`);
	}

	const counts = report.metadata?.vulnerabilities ?? {};
	if (findings.length === 0) {
		console.log("Pi audit: 0 findings.");
	} else {
		console.log(
			`Pi audit: ${counts.total ?? findings.length} explicitly allowed finding(s) remain (${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate).`,
		);
	}
}

export function buildPiOverlay() {
	const config = readJson(CONFIG_PATH);
	const sourceRoot = verifySource(config);
	const outputRoot = path.join(ROOT, config.output);
	const registry = effectiveRegistry();
	const registryUrl = new URL(registry);
	if (!/^https?:$/.test(registryUrl.protocol)) {
		throw new Error(`Unsupported package registry protocol: ${registryUrl.protocol}`);
	}

	console.log(`Staging pinned Pi ${config.source.version} source with proxy-available audit fixes...`);
	copySource(sourceRoot, outputRoot);
	applyManifestOverlay(config, outputRoot);

	const npmEnvironment = {
		...process.env,
		npm_config_registry: registry,
		npm_config_replace_registry_host: "always",
		npm_config_audit: "false",
		npm_config_fund: "false",
		npm_config_update_notifier: "false",
	};
	const npmOptions = { cwd: outputRoot, env: npmEnvironment };
	run(
		"npm",
		["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${registry}`],
		npmOptions,
	);
	verifyLock(config, outputRoot);
	run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${registry}`], npmOptions);
	run("npm", ["run", "build:offline"], npmOptions);
	audit(config, outputRoot, npmEnvironment);

	console.log(`Built audited Pi runtime in ${path.relative(ROOT, outputRoot)} through ${registryUrl.origin}`);
	return outputRoot;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	buildPiOverlay();
}
