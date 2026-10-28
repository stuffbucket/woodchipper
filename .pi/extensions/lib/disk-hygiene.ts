/**
 * Woodchipper Cross-Platform Disk Hygiene, Threshold Config, & Resource Cleanup
 * (`.pi/extensions/lib/disk-hygiene.ts`)
 *
 * Works across macOS (`darwin`), Linux (`linux`), and Windows (`win32`):
 * 1. Normal config file location:
 *    - Windows (`win32`): `%APPDATA%\woodchipper\config.json` (or `~\.config\woodchipper\config.json`)
 *    - macOS / Linux: `${XDG_CONFIG_HOME || ~/.config}/woodchipper/config.json`
 * 2. Cross-platform free disk & directory size inspection (`fs.statfsSync`).
 * 3. Pre-operation disk & size warnings before large model downloads (`decide-340m`, ~700 MB)
 *    or Docker builds.
 * 4. Unified cleanup (`cache`, `docker`, `models`, `workspaces`, `all`) exposed via
 *    `/clean`, `woodchipper_clean`, `./woodchipper clean`, and `mise run clean`.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveWoodchipperStateRoot } from "./evidence-ledger.ts";
import { defaultGlinerModelsDir } from "./gliner-classifier.ts";

export interface WoodchipperDiskConfig {
	minFreeDiskGb: number;
	maxWorkspacesTotalMb: number;
	autoPullGlinerModel: boolean;
	confirmHeavyOperations: boolean;
}

export const DEFAULT_DISK_CONFIG: Readonly<WoodchipperDiskConfig> = {
	minFreeDiskGb: 20,
	maxWorkspacesTotalMb: 2048,
	autoPullGlinerModel: true,
	confirmHeavyOperations: true,
};

export type CleanScope = "status" | "cache" | "docker" | "models" | "workspaces" | "all";

export interface DiskAndResourceReport {
	stateRoot: string;
	workspacesRoot: string;
	modelsDir: string;
	configPath: string;
	config: WoodchipperDiskConfig;
	freeDiskBytes: number;
	totalDiskBytes: number;
	freeDiskHuman: string;
	totalDiskHuman: string;
	workspacesBytes: number;
	workspacesHuman: string;
	reaRuntimeCacheBytes: number;
	reaRuntimeCacheHuman: string;
	modelsBytes: number;
	modelsHuman: string;
	tempBytes: number;
	tempHuman: string;
	totalManagedBytes: number;
	totalManagedHuman: string;
	lowDiskWarning: boolean;
	workspacesQuotaWarning: boolean;
	warnings: string[];
}

export interface CleanResult {
	ok: boolean;
	scope: CleanScope;
	reclaimedBytes: number;
	reclaimedHuman: string;
	cleanedItems: string[];
	dockerPruneSummary?: string;
	reportAfter: DiskAndResourceReport;
}

export function formatBytesHuman(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let val = bytes;
	let idx = 0;
	while (val >= 1024 && idx < units.length - 1) {
		val /= 1024;
		idx++;
	}
	return `${val >= 100 || idx === 0 ? Math.round(val) : val.toFixed(1)} ${units[idx]}`;
}

/**
 * Resolve the standard cross-platform config file path for Woodchipper:
 * - `WOODCHIPPER_CONFIG_PATH` if set
 * - Windows (`win32`): `%APPDATA%\woodchipper\config.json`
 * - macOS / Linux: `${XDG_CONFIG_HOME || ~/.config}/woodchipper/config.json`
 */
export function resolveWoodchipperConfigPath(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	homeDir: string = os.homedir(),
): string {
	if (env.WOODCHIPPER_CONFIG_PATH?.trim()) {
		return path.resolve(env.WOODCHIPPER_CONFIG_PATH.trim());
	}
	if (platform === "win32") {
		const appData = env.APPDATA?.trim() || path.join(homeDir, "AppData", "Roaming");
		return path.win32.join(appData, "woodchipper", "config.json");
	}
	const xdgConfig = env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config");
	return path.join(xdgConfig, "woodchipper", "config.json");
}

export function loadWoodchipperConfig(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	homeDir: string = os.homedir(),
): WoodchipperDiskConfig {
	const cfgPath = resolveWoodchipperConfigPath(env, platform, homeDir);
	const merged: WoodchipperDiskConfig = { ...DEFAULT_DISK_CONFIG };
	try {
		if (fs.existsSync(cfgPath)) {
			const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Partial<WoodchipperDiskConfig>;
			if (typeof raw.minFreeDiskGb === "number" && Number.isFinite(raw.minFreeDiskGb) && raw.minFreeDiskGb >= 1) {
				merged.minFreeDiskGb = raw.minFreeDiskGb;
			}
			if (
				typeof raw.maxWorkspacesTotalMb === "number" &&
				Number.isFinite(raw.maxWorkspacesTotalMb) &&
				raw.maxWorkspacesTotalMb >= 64
			) {
				merged.maxWorkspacesTotalMb = raw.maxWorkspacesTotalMb;
			}
			if (typeof raw.autoPullGlinerModel === "boolean") {
				merged.autoPullGlinerModel = raw.autoPullGlinerModel;
			}
			if (typeof raw.confirmHeavyOperations === "boolean") {
				merged.confirmHeavyOperations = raw.confirmHeavyOperations;
			}
		}
	} catch {
		// Use defaults if config file is missing or malformed
	}
	return merged;
}

export function saveWoodchipperConfig(
	updates: Partial<WoodchipperDiskConfig>,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	homeDir: string = os.homedir(),
): WoodchipperDiskConfig {
	const current = loadWoodchipperConfig(env, platform, homeDir);
	const next: WoodchipperDiskConfig = {
		...current,
		...updates,
	};
	const cfgPath = resolveWoodchipperConfigPath(env, platform, homeDir);
	try {
		fs.mkdirSync(path.dirname(cfgPath), { recursive: true, mode: 0o700 });
		fs.writeFileSync(cfgPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	} catch {
		// Ignore on read-only filesystems
	}
	return next;
}

/**
 * Compute recursive directory byte size bounded by entry count so it never blocks the event loop.
 */
export function computeDirectorySizeBytes(dirPath: string, maxEntries = 10_000): number {
	if (!dirPath || !fs.existsSync(dirPath)) return 0;
	let total = 0;
	let seen = 0;
	const stack = [dirPath];

	while (stack.length > 0 && seen < maxEntries) {
		const current = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			seen++;
			if (seen > maxEntries) break;
			const full = path.join(current, entry.name);
			try {
				const st = fs.lstatSync(full);
				if (st.isSymbolicLink()) continue;
				if (st.isDirectory()) {
					stack.push(full);
				} else if (st.isFile()) {
					total += st.size;
				}
			} catch {
				// Ignore concurrently removed files
			}
		}
	}
	return total;
}

function listWoodchipperTempDirs(tmpRoot = os.tmpdir()): string[] {
	try {
		return fs
			.readdirSync(tmpRoot, { withFileTypes: true })
			.filter((d) => d.isDirectory() && /^(?:pi-subagent-|wc-|pi-flow-)/.test(d.name))
			.map((d) => path.join(tmpRoot, d.name));
	} catch {
		return [];
	}
}

/**
 * Inspect cross-platform free disk space (`fs.statfsSync`) and Woodchipper's managed directories.
 */
export function inspectDiskAndResourceUsage(
	projectRoot: string,
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
	homeDir: string = os.homedir(),
): DiskAndResourceReport {
	const stateRoot = resolveWoodchipperStateRoot(projectRoot, env, cwd, homeDir);
	const workspacesRoot = path.join(stateRoot, "workspaces");
	const reaRuntimeDir = path.join(workspacesRoot, ".rea-runtime");
	const modelsDir = defaultGlinerModelsDir(env, projectRoot, cwd, homeDir);
	const configPath = resolveWoodchipperConfigPath(env, process.platform, homeDir);
	const config = loadWoodchipperConfig(env, process.platform, homeDir);

	let freeDiskBytes = 0;
	let totalDiskBytes = 0;
	const probePath = fs.existsSync(stateRoot) ? stateRoot : fs.existsSync(projectRoot) ? projectRoot : homeDir;
	try {
		if (typeof fs.statfsSync === "function") {
			const st = fs.statfsSync(probePath);
			freeDiskBytes = Number(st.bavail) * Number(st.bsize);
			totalDiskBytes = Number(st.blocks) * Number(st.bsize);
		}
	} catch {
		// Ignore if statfsSync is unavailable
	}

	const reaRuntimeCacheBytes = computeDirectorySizeBytes(reaRuntimeDir);
	let workspacesBytes = 0;
	if (fs.existsSync(workspacesRoot)) {
		try {
			for (const entry of fs.readdirSync(workspacesRoot, { withFileTypes: true })) {
				if (entry.name === ".rea-runtime" || entry.name === ".pi-agent" || entry.name === ".gitignore") {
					continue;
				}
				const full = path.join(workspacesRoot, entry.name);
				if (entry.isDirectory()) {
					workspacesBytes += computeDirectorySizeBytes(full);
				} else if (entry.isFile()) {
					try {
						workspacesBytes += fs.statSync(full).size;
					} catch {
						// Ignore
					}
				}
			}
		} catch {
			// Ignore
		}
	}

	const modelsBytes = computeDirectorySizeBytes(modelsDir);
	let tempBytes = 0;
	for (const td of listWoodchipperTempDirs()) {
		tempBytes += computeDirectorySizeBytes(td, 500);
	}

	const totalManagedBytes = workspacesBytes + reaRuntimeCacheBytes + modelsBytes + tempBytes;
	const minFreeBytes = config.minFreeDiskGb * 1024 * 1024 * 1024;
	const maxWorkspacesBytes = config.maxWorkspacesTotalMb * 1024 * 1024;

	const lowDiskWarning = freeDiskBytes > 0 && freeDiskBytes < minFreeBytes;
	const workspacesQuotaWarning = workspacesBytes + reaRuntimeCacheBytes > maxWorkspacesBytes;

	const warnings: string[] = [];
	if (lowDiskWarning) {
		warnings.push(
			`Low disk space: ${formatBytesHuman(freeDiskBytes)} free (threshold: ${config.minFreeDiskGb} GB in ${configPath}). Run '/clean' or './woodchipper clean' to reclaim space.`,
		);
	}
	if (workspacesQuotaWarning) {
		warnings.push(
			`Workspace & REA cache size (${formatBytesHuman(workspacesBytes + reaRuntimeCacheBytes)}) exceeds ${config.maxWorkspacesTotalMb} MB threshold. Run '/clean cache' or '/clean workspaces'.`,
		);
	}

	return {
		stateRoot,
		workspacesRoot,
		modelsDir,
		configPath,
		config,
		freeDiskBytes,
		totalDiskBytes,
		freeDiskHuman: formatBytesHuman(freeDiskBytes),
		totalDiskHuman: formatBytesHuman(totalDiskBytes),
		workspacesBytes,
		workspacesHuman: formatBytesHuman(workspacesBytes),
		reaRuntimeCacheBytes,
		reaRuntimeCacheHuman: formatBytesHuman(reaRuntimeCacheBytes),
		modelsBytes,
		modelsHuman: formatBytesHuman(modelsBytes),
		tempBytes,
		tempHuman: formatBytesHuman(tempBytes),
		totalManagedBytes,
		totalManagedHuman: formatBytesHuman(totalManagedBytes),
		lowDiskWarning,
		workspacesQuotaWarning,
		warnings,
	};
}

/**
 * Clean Woodchipper caches, temp dirs, Docker build artifacts, GLiNER models, or inactive workspaces.
 */
export function runWoodchipperClean(options: {
	projectRoot: string;
	scope?: CleanScope;
	activeWorkspaceSlug?: string;
	includeActiveWorkspace?: boolean;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	homeDir?: string;
	execSyncImpl?: typeof execFileSync;
}): CleanResult {
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const homeDir = options.homeDir ?? os.homedir();
	const scope: CleanScope = options.scope ?? "cache";
	const execFn = options.execSyncImpl ?? execFileSync;

	const before = inspectDiskAndResourceUsage(options.projectRoot, env, cwd, homeDir);
	let reclaimedBytes = 0;
	const cleanedItems: string[] = [];
	let dockerPruneSummary: string | undefined;

	const cleanCache = () => {
		const reaRuntimeDir = path.join(before.workspacesRoot, ".rea-runtime");
		if (fs.existsSync(reaRuntimeDir)) {
			const sz = computeDirectorySizeBytes(reaRuntimeDir);
			fs.rmSync(reaRuntimeDir, { recursive: true, force: true });
			reclaimedBytes += sz;
			cleanedItems.push(`REA runtime cache (${formatBytesHuman(sz)}): ${reaRuntimeDir}`);
		}
		for (const td of listWoodchipperTempDirs()) {
			const sz = computeDirectorySizeBytes(td, 500);
			try {
				fs.rmSync(td, { recursive: true, force: true });
				reclaimedBytes += sz;
				cleanedItems.push(`Temp directory (${formatBytesHuman(sz)}): ${td}`);
			} catch {
				// Ignore
			}
		}
	};

	const cleanModels = () => {
		if (fs.existsSync(before.modelsDir)) {
			const sz = computeDirectorySizeBytes(before.modelsDir);
			fs.rmSync(before.modelsDir, { recursive: true, force: true });
			reclaimedBytes += sz;
			cleanedItems.push(`GLiNER model cache (${formatBytesHuman(sz)}): ${before.modelsDir}`);
		}
	};

	const cleanWorkspaces = () => {
		if (!fs.existsSync(before.workspacesRoot)) return;
		let activeSlug = options.activeWorkspaceSlug;
		if (!activeSlug) {
			try {
				const activeFile = path.join(before.workspacesRoot, "ACTIVE_WORKSPACE");
				if (fs.existsSync(activeFile)) {
					activeSlug = fs.readFileSync(activeFile, "utf8").trim();
				}
			} catch {
				// Ignore
			}
		}
		for (const entry of fs.readdirSync(before.workspacesRoot, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			if (!options.includeActiveWorkspace && activeSlug && entry.name === activeSlug) {
				continue;
			}
			const full = path.join(before.workspacesRoot, entry.name);
			const sz = computeDirectorySizeBytes(full);
			fs.rmSync(full, { recursive: true, force: true });
			reclaimedBytes += sz;
			cleanedItems.push(`Workspace '${entry.name}' (${formatBytesHuman(sz)}): ${full}`);
		}
	};

	const cleanDocker = () => {
		const summaries: string[] = [];
		for (const subcmd of [
			["container", "prune", "-f"],
			["image", "prune", "-f"],
			["builder", "prune", "-f"],
		]) {
			try {
				const out = execFn("docker", subcmd, {
					encoding: "utf8",
					timeout: 30_000,
					stdio: ["ignore", "pipe", "ignore"],
				});
				const m = out.match(/Total reclaimed space:\s*([^\r\n]+)/i);
				if (m) {
					summaries.push(`docker ${subcmd[0]} prune: ${m[1].trim()}`);
				}
			} catch {
				// Docker not installed or daemon not running
			}
		}
		if (summaries.length > 0) {
			dockerPruneSummary = summaries.join(" • ");
			cleanedItems.push(`Docker prune (${dockerPruneSummary})`);
		}
	};

	if (scope === "cache" || scope === "all") {
		cleanCache();
	}
	if (scope === "models" || scope === "all") {
		cleanModels();
	}
	if (scope === "workspaces" || scope === "all") {
		cleanWorkspaces();
	}
	if (scope === "docker" || scope === "all") {
		cleanDocker();
	}

	const reportAfter = inspectDiskAndResourceUsage(options.projectRoot, env, cwd, homeDir);
	return {
		ok: true,
		scope,
		reclaimedBytes,
		reclaimedHuman: formatBytesHuman(reclaimedBytes),
		cleanedItems,
		...(dockerPruneSummary ? { dockerPruneSummary } : {}),
		reportAfter,
	};
}

export function formatDiskHygieneMarkdown(report: DiskAndResourceReport, cleanResult?: CleanResult): string {
	const lines: string[] = [
		`## Woodchipper Disk & Resource Hygiene (${report.lowDiskWarning ? "LOW DISK WARNING" : "HEALTHY"})`,
		`- **Free Disk Space:** \`${report.freeDiskHuman}\` free of \`${report.totalDiskHuman}\` (min threshold: \`${report.config.minFreeDiskGb} GB\`)`,
		`- **Active Output Root:** \`${report.workspacesRoot}\``,
		`- **Workspaces Usage:** \`${report.workspacesHuman}\` (quota warning threshold: \`${report.config.maxWorkspacesTotalMb} MB\`)`,
		`- **REA / Ghidra Cache (\`.rea-runtime\`):** \`${report.reaRuntimeCacheHuman}\``,
		`- **GLiNER Model Cache (\`${report.modelsDir}\`):** \`${report.modelsHuman}\` (auto-pull: \`${report.config.autoPullGlinerModel}\`)`,
		`- **Temp Directories:** \`${report.tempHuman}\``,
		`- **Total Woodchipper Managed Disk:** \`${report.totalManagedHuman}\``,
		`- **Threshold Config File:** \`${report.configPath}\``,
	];

	if (report.warnings.length > 0) {
		lines.push("", "### Active Warnings", ...report.warnings.map((w) => `- **Warning:** ${w}`));
	}

	if (cleanResult && cleanResult.scope !== "status") {
		lines.push(
			"",
			`### Cleanup Summary (\`scope=${cleanResult.scope}\`)`,
			`- **Reclaimed Local Bytes:** \`${cleanResult.reclaimedHuman}\``,
			...(cleanResult.dockerPruneSummary ? [`- **Docker Prune:** ${cleanResult.dockerPruneSummary}`] : []),
			...(cleanResult.cleanedItems.length > 0
				? cleanResult.cleanedItems.map((item) => `- ${item}`)
				: ["- _Nothing needed cleanup._"]),
		);
	}

	lines.push(
		"",
		"_Commands: `/clean status` | `/clean cache` | `/clean docker` | `/clean models` | `/clean workspaces` | `/clean all` | `/clean config minFreeDiskGb=25`_",
	);
	return lines.join("\n");
}
