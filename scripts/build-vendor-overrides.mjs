#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OVERRIDES_ROOT = path.join(ROOT, "vendor", "overrides");
const MANIFEST_PATH = path.join(OVERRIDES_ROOT, "manifest.json");
const OUTPUT_ROOT = path.join(OVERRIDES_ROOT, "packages");

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: ROOT,
		encoding: "utf8",
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
		...options,
	});
}

function verifySources(manifest) {
	for (const [name, entry] of Object.entries(manifest.packages)) {
		const sourcePath = path.join(ROOT, entry.submodule);
		const packagePath = path.join(sourcePath, "package.json");
		if (!fs.existsSync(packagePath)) {
			throw new Error(`Missing ${name} submodule at ${entry.submodule}; run git submodule update --init --recursive`);
		}

		const sourcePackage = readJson(packagePath);
		if (sourcePackage.name !== name || sourcePackage.version !== entry.version) {
			throw new Error(
				`${entry.submodule}/package.json is ${sourcePackage.name}@${sourcePackage.version}, expected ${name}@${entry.version}`,
			);
		}

		const commit = run("git", ["-C", sourcePath, "rev-parse", "HEAD"], { capture: true }).trim();
		if (commit !== entry.commit) {
			throw new Error(`${entry.submodule} is at ${commit}, expected ${entry.commit}`);
		}

		const status = run("git", ["-C", sourcePath, "status", "--porcelain"], { capture: true }).trim();
		if (status) {
			throw new Error(`${entry.submodule} has local changes; refusing to build an unpinned source tree`);
		}
	}
}

function verifyOutputs(manifest, outputRoot = OUTPUT_ROOT) {
	const requiredFiles = {
		jose: ["package.json", "dist/webapi/index.js", "dist/types/index.d.ts"],
		"fast-uri": ["package.json", "index.js", "lib/utils.js", "types/index.d.ts"],
	};

	for (const [name, entry] of Object.entries(manifest.packages)) {
		const packageRoot = path.join(outputRoot, name);
		const packagePath = path.join(packageRoot, "package.json");
		if (!fs.existsSync(packagePath)) {
			throw new Error(`Missing generated override package: ${path.relative(ROOT, packagePath)}`);
		}

		const outputPackage = readJson(packagePath);
		if (outputPackage.name !== name || outputPackage.version !== entry.version) {
			throw new Error(`Generated ${name} package has unexpected identity ${outputPackage.name}@${outputPackage.version}`);
		}

		for (const relativePath of requiredFiles[name]) {
			if (!fs.existsSync(path.join(packageRoot, relativePath))) {
				throw new Error(`Generated ${name} package is missing ${relativePath}`);
			}
		}
	}
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

function build(manifest) {
	const registry = effectiveRegistry();
	const registryUrl = new URL(registry);
	if (!/^https?:$/.test(registryUrl.protocol)) {
		throw new Error(`Unsupported package registry protocol: ${registryUrl.protocol}`);
	}

	fs.mkdirSync(path.join(ROOT, ".woodchipper"), { recursive: true, mode: 0o700 });
	const stagingRoot = fs.mkdtempSync(path.join(ROOT, ".woodchipper", "override-packages-"));
	const dockerfile = path.join(ROOT, manifest.builder.dockerfile);
	const args = [
		"buildx",
		"build",
		"--file",
		dockerfile,
		"--target",
		"package-export",
		"--build-arg",
		`NODE_IMAGE=${manifest.builder.node_image}`,
		"--build-arg",
		`NPM_REGISTRY=${registry}`,
		"--output",
		`type=local,dest=${stagingRoot}`,
	];

	const npmrc = path.join(os.homedir(), ".npmrc");
	if (fs.existsSync(npmrc)) {
		args.push("--secret", `id=npmrc,src=${npmrc}`);
	}
	args.push(OVERRIDES_ROOT);

	try {
		console.log(`Building isolated dependency overrides through ${registryUrl.origin}...`);
		run("docker", args);
		verifyOutputs(manifest, stagingRoot);

		fs.rmSync(OUTPUT_ROOT, { recursive: true, force: true });
		fs.renameSync(stagingRoot, OUTPUT_ROOT);
		console.log(`Built jose@${manifest.packages.jose.version} and fast-uri@${manifest.packages["fast-uri"].version}`);
	} finally {
		fs.rmSync(stagingRoot, { recursive: true, force: true });
	}
}

const manifest = readJson(MANIFEST_PATH);
verifySources(manifest);

if (process.argv.includes("--check")) {
	verifyOutputs(manifest);
	console.log("Temporary dependency override sources and generated packages are valid.");
} else {
	build(manifest);
}
