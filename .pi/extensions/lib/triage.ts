import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Maximum file size read into memory for SHA-256 fallback (64 MiB). */
export const MAX_INLINE_HASH_BYTES = 64 * 1024 * 1024;

export type WoodchipperSubSkill =
	| "woodchipper-native"
	| "woodchipper-js-web"
	| "woodchipper-mobile-managed"
	| "woodchipper-firmware-signals"
	| "woodchipper-runtime"
	| "woodchipper-reconstruction"
	| "woodchipper-audit";

export type PlaybookId =
	| "triage-and-feature-trace"
	| "clean-room-and-porting"
	| "security-and-vr"
	| "firmware-and-protocols";

export interface PlaybookDescriptor {
	id: PlaybookId;
	title: string;
	relativePath: string;
	summary: string;
}

export const PLAYBOOK_CATALOG: readonly PlaybookDescriptor[] = [
	{
		id: "triage-and-feature-trace",
		title: "Playbook 1: Target Triage & Single-Feature Tracing",
		relativePath: "playbooks/triage-and-feature-trace.md",
		summary:
			"Unfamiliar binary/app mapping, single-feature end-to-end call-chain tracing, and business rule/formula recovery.",
	},
	{
		id: "clean-room-and-porting",
		title: "Playbook 2: Clean-Room Reconstruction, Cloning & WASM Porting",
		relativePath: "playbooks/clean-room-and-porting.md",
		summary:
			"Behavioral CLONE_SPEC.md generation, single-feature clean-room verification, and native-to-WASM porting plans.",
	},
	{
		id: "security-and-vr",
		title: "Playbook 3: Defensive Security, Vulnerability Research, Kernel & Crash Triage",
		relativePath: "playbooks/security-and-vr.md",
		summary:
			"Trust-boundary & source-to-sink audits, kernel IOCTL enumeration, patch diffing, and crash root-cause analysis.",
	},
	{
		id: "firmware-and-protocols",
		title: "Playbook 4: Firmware, Protocols, File Formats & Defensive Protection Research",
		relativePath: "playbooks/firmware-and-protocols.md",
		summary:
			"Firmware image/entropy triage, headerless MCU mapping, wire-protocol/file-format recovery, and protection analysis.",
	},
];

export interface StaticTriageResult {
	targetPath: string;
	resolvedPath: string;
	exists: boolean;
	isDirectory: boolean;
	sizeBytes: number;
	sizeHuman: string;
	sha256: string | null;
	fileDescription: string;
	recommendedSubSkill: WoodchipperSubSkill;
	secondarySubSkills: WoodchipperSubSkill[];
	recommendedPlaybook: PlaybookId;
	targetFreeToolsFirst: string[];
	initialReaToolSequence: string[];
	notes: string[];
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(1)} KiB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb.toFixed(2)} MiB`;
	const gb = mb / 1024;
	return `${gb.toFixed(2)} GiB`;
}

function runFileCommand(resolvedPath: string): string {
	try {
		const output = execFileSync("file", ["-b", "--", resolvedPath], {
			encoding: "utf8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output.trim();
	} catch {
		return "unknown (file command unavailable)";
	}
}

export function computeSha256(resolvedPath: string, stat: fs.Stats): string | null {
	if (!stat.isFile()) return null;
	try {
		const output = execFileSync("shasum", ["-a", "256", "--", resolvedPath], {
			encoding: "utf8",
			timeout: 15000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const digest = output.trim().split(/\s+/)[0];
		if (digest && /^[a-fA-F0-9]{64}$/.test(digest)) {
			return digest.toLowerCase();
		}
	} catch {
		// Fallback to sha256sum or bounded chunked read below
	}

	try {
		const output = execFileSync("sha256sum", ["--", resolvedPath], {
			encoding: "utf8",
			timeout: 15000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const digest = output.trim().split(/\s+/)[0];
		if (digest && /^[a-fA-F0-9]{64}$/.test(digest)) {
			return digest.toLowerCase();
		}
	} catch {
		// Fallback to bounded chunked read below
	}

	if (stat.size > MAX_INLINE_HASH_BYTES) {
		return null;
	}

	let fd: number | null = null;
	try {
		fd = fs.openSync(resolvedPath, "r");
		const hash = crypto.createHash("sha256");
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let bytesRead = 0;
		let total = 0;
		do {
			bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
			if (bytesRead > 0) {
				hash.update(chunk.subarray(0, bytesRead));
				total += bytesRead;
				if (total > MAX_INLINE_HASH_BYTES) {
					return null;
				}
			}
		} while (bytesRead > 0);
		return hash.digest("hex");
	} catch {
		return null;
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {
				// Ignore
			}
		}
	}
}

export function runStaticTriage(targetPath: string, baseDir: string): StaticTriageResult {
	const resolvedPath = path.resolve(baseDir, targetPath);
	if (!fs.existsSync(resolvedPath)) {
		return {
			targetPath,
			resolvedPath,
			exists: false,
			isDirectory: false,
			sizeBytes: 0,
			sizeHuman: "0 B",
			sha256: null,
			fileDescription: "Target does not exist on disk",
			recommendedSubSkill: "woodchipper-native",
			secondarySubSkills: ["woodchipper-reconstruction", "woodchipper-audit"],
			recommendedPlaybook: "triage-and-feature-trace",
			targetFreeToolsFirst: [],
			initialReaToolSequence: ["Verify target path exists before invoking REA tools"],
			notes: [`File not found at ${resolvedPath}`],
		};
	}

	const stat = fs.statSync(resolvedPath);
	const isDirectory = stat.isDirectory();
	const isRegularFile = stat.isFile();
	const sizeBytes = stat.size;
	const sizeHuman = formatBytes(sizeBytes);
	const fileDescription = isDirectory || isRegularFile ? runFileCommand(resolvedPath) : "special file (FIFO/socket/device)";
	const sha256 = computeSha256(resolvedPath, stat);

	const ext = path.extname(resolvedPath).toLowerCase();
	const lowerDesc = fileDescription.toLowerCase();
	const baseName = path.basename(resolvedPath).toLowerCase();

	let recommendedSubSkill: WoodchipperSubSkill = "woodchipper-native";
	const secondarySubSkills: WoodchipperSubSkill[] = ["woodchipper-reconstruction", "woodchipper-audit"];
	let recommendedPlaybook: PlaybookId = "triage-and-feature-trace";
	const targetFreeToolsFirst: string[] = [];
	const initialReaToolSequence: string[] = [];
	const notes: string[] = [];

	if (!isDirectory && !isRegularFile) {
		notes.push("Target is a special file (FIFO, socket, or device node); skipped SHA-256 hashing to prevent blocking.");
	}

	if (isDirectory && ext === ".app") {
		recommendedSubSkill = "woodchipper-mobile-managed";
		secondarySubSkills.unshift("woodchipper-native", "woodchipper-js-web");
		targetFreeToolsFirst.push(
			'open_bundle_resources({ path: "<target>" })',
			'inspect_plist({ path: "<target>/Contents/Info.plist" })',
			'inspect_desktop_application({ path: "<target>", detail: "summary" })',
		);
		initialReaToolSequence.push(
			"1. open_bundle_resources & inspect_plist to identify bundle ID, main executable, and Electron/Flutter/native frameworks",
			'2. inspect_desktop_application({ path, detail: "summary" }) -> inspect_analysis_view for bundle layout',
			'3. If Electron (Contents/Resources/app.asar present), switch to woodchipper-js-web and run analyze_javascript_application({ detail: "summary" })',
			'4. If native Mach-O executable, run inspect_macho({ detail: "summary" }) before open_binary',
		);
		notes.push("macOS/iOS .app bundle detected; inspect bundle resources and Info.plist before opening the main binary.");
	} else if (isDirectory) {
		const entries = fs.readdirSync(resolvedPath);
		const hasAsar = entries.some((e) => e.endsWith(".asar") || e === "resources");
		const hasJs = entries.some((e) => e.endsWith(".js") || e.endsWith(".mjs") || e === "package.json");
		if (hasAsar || hasJs) {
			recommendedSubSkill = "woodchipper-js-web";
			targetFreeToolsFirst.push(
				'analyze_javascript_application({ path: "<target>", detail: "summary" })',
				'inspect_desktop_application({ path: "<target>", detail: "summary" })',
			);
			initialReaToolSequence.push(
				'1. analyze_javascript_application({ path, detail: "summary" }) -> save parent_evidence_id',
				'2. inspect_analysis_view({ parent_evidence_id, view: { kind: "modules" } })',
				'3. trace_application_feature({ path, direction: "outgoing" })',
			);
			notes.push("Directory appears to contain JavaScript/Electron application artifacts.");
		} else {
			recommendedSubSkill = "woodchipper-native";
			targetFreeToolsFirst.push('inspect_desktop_application({ path: "<target>", detail: "summary" })');
			initialReaToolSequence.push(
				'1. inspect_desktop_application({ path, detail: "summary" }) to inventory binaries and resources',
				"2. Run woodchipper_triage on the primary executable inside the directory",
			);
			notes.push(`Directory with ${entries.length} top-level entries.`);
		}
	} else if (
		ext === ".js" ||
		ext === ".mjs" ||
		ext === ".cjs" ||
		ext === ".asar" ||
		ext === ".har" ||
		ext === ".saz" ||
		lowerDesc.includes("javascript") ||
		baseName.includes("app.asar")
	) {
		recommendedSubSkill = "woodchipper-js-web";
		if (ext === ".har" || ext === ".saz") {
			targetFreeToolsFirst.push('inspect_web_network_capture({ path: "<target>", detail: "summary" })');
			initialReaToolSequence.push(
				'1. inspect_web_network_capture({ path, detail: "summary" }) -> save parent_evidence_id',
				"2. inspect_analysis_view to page endpoints, auth headers, and payload schemas",
			);
		} else {
			targetFreeToolsFirst.push('analyze_javascript_application({ path: "<target>", detail: "summary" })');
			if (ext === ".asar") {
				targetFreeToolsFirst.push('inspect_electron_fuses({ path: "<target>" })');
			}
			initialReaToolSequence.push(
				'1. analyze_javascript_application({ path, detail: "summary" }) (target-free; do NOT call open_binary)',
				'2. inspect_analysis_view({ parent_evidence_id, view: { kind: "modules" } }) or view: { kind: "api-surface" }',
				'3. trace_application_feature({ path, direction: "outgoing" }) on target entry module/IPC channel',
			);
		}
	} else if (
		ext === ".apk" ||
		ext === ".aab" ||
		ext === ".dex" ||
		ext === ".ipa" ||
		ext === ".plist" ||
		ext === ".nib" ||
		ext === ".car" ||
		lowerDesc.includes("android") ||
		lowerDesc.includes("dalvik") ||
		lowerDesc.includes("apple binary property list") ||
		lowerDesc.includes(".net") ||
		lowerDesc.includes("mono/") ||
		lowerDesc.includes("pe32 executable (console) intel 80386 mono/.net") ||
		baseName === "global-metadata.dat"
	) {
		recommendedSubSkill = "woodchipper-mobile-managed";
		if (ext === ".apk" || ext === ".aab" || ext === ".dex" || lowerDesc.includes("dalvik")) {
			targetFreeToolsFirst.push(
				'inspect_android_package({ path: "<target>" })',
				'decode_android_resources({ path: "<target>" })',
				'identify_flutter_build({ path: "<target>" })',
			);
			initialReaToolSequence.push(
				"1. inspect_android_package({ path }) to enumerate manifest, permissions, and exported components (target-free)",
				"2. search_android_classes / trace_android_references via JADX provider if available",
				"3. Check lib/ for native JNI or Flutter/Unity IL2CPP artifacts (identify_flutter_build / inspect_il2cpp_metadata)",
			);
		} else if (baseName === "global-metadata.dat") {
			targetFreeToolsFirst.push('inspect_il2cpp_metadata({ path: "<target>" })');
			initialReaToolSequence.push(
				"1. inspect_il2cpp_metadata({ path }) to recover IL2CPP string literals, types, and method descriptors",
				"2. Correlate recovered metadata with GameAssembly.dll / libil2cpp.so via woodchipper-native",
			);
		} else if (lowerDesc.includes(".net") || lowerDesc.includes("mono/")) {
			targetFreeToolsFirst.push(
				'inspect_managed_artifact({ path: "<target>", detail: "summary" })',
				'inspect_managed_members({ path: "<target>" })',
			);
			initialReaToolSequence.push(
				'1. inspect_managed_artifact({ path, detail: "summary" }) (target-free; do NOT call open_binary)',
				"2. inspect_managed_members to inspect namespaces, types, and CIL methods",
			);
		} else {
			targetFreeToolsFirst.push('inspect_plist({ path: "<target>" })', 'open_bundle_resources({ path: "<target>" })');
			initialReaToolSequence.push(
				"1. inspect_plist / decode_interface_builder / inspect_asset_catalog on Apple resource artifact",
			);
		}
	} else if (
		ext === ".wasm" ||
		ext === ".wat" ||
		ext === ".bin" ||
		ext === ".img" ||
		ext === ".fw" ||
		ext === ".hex" ||
		ext === ".uf2" ||
		ext === ".pcap" ||
		ext === ".pcapng" ||
		ext === ".sqlite" ||
		ext === ".sqlite3" ||
		ext === ".db" ||
		ext === ".sr" ||
		ext === ".sal" ||
		ext === ".evm" ||
		lowerDesc.includes("webassembly") ||
		lowerDesc.includes("sqlite") ||
		lowerDesc.includes("pcap") ||
		lowerDesc.includes("squashfs") ||
		lowerDesc.includes("u-boot") ||
		lowerDesc.includes("firmware")
	) {
		recommendedSubSkill = "woodchipper-firmware-signals";
		recommendedPlaybook = "firmware-and-protocols";
		if (ext === ".wasm" || lowerDesc.includes("webassembly")) {
			targetFreeToolsFirst.push('inspect_wasm_artifact({ path: "<target>", detail: "summary" })');
			initialReaToolSequence.push(
				'1. inspect_wasm_artifact({ path, detail: "summary" }) (target-free)',
				"2. inspect_analysis_view to page imports, exports, linear memory initializers, and functions",
			);
		} else if (ext === ".sqlite" || ext === ".sqlite3" || ext === ".db" || lowerDesc.includes("sqlite")) {
			targetFreeToolsFirst.push('inspect_sqlite_database({ path: "<target>" })');
			initialReaToolSequence.push(
				"1. inspect_sqlite_database({ path }) (target-free) to recover tables, indices, triggers, and schema",
			);
		} else if (ext === ".pcap" || ext === ".pcapng" || lowerDesc.includes("pcap")) {
			targetFreeToolsFirst.push('inspect_pcap_capture({ path: "<target>" })');
			initialReaToolSequence.push(
				"1. inspect_pcap_capture({ path }) / inspect_packet_capture to summarize conversations and protocols",
			);
		} else if (ext === ".sr" || ext === ".sal") {
			targetFreeToolsFirst.push('decode_signal_recording({ path: "<target>" })');
			initialReaToolSequence.push("1. decode_signal_recording({ path }) to inspect logic analyzer protocol frames");
		} else {
			targetFreeToolsFirst.push(
				'inspect_byte_entropy({ path: "<target>" })',
				'inspect_firmware_regions({ path: "<target>" })',
			);
			initialReaToolSequence.push(
				"1. inspect_byte_entropy({ path }) & inspect_firmware_regions({ path }) to locate partitions, bootloaders, and compressed filesystems",
				"2. extract_firmware into a dedicated empty directory if embedded filesystems are found",
				'3. For headerless MCU blobs, call open_binary with format: "raw-binary" and explicit architecture/entry_point',
			);
		}
	} else if (
		ext === ".gguf" ||
		ext === ".safetensors" ||
		ext === ".onnx" ||
		ext === ".pt" ||
		ext === ".cubin" ||
		ext === ".fatbin"
	) {
		recommendedSubSkill = "woodchipper-native";
		targetFreeToolsFirst.push(
			'inspect_model_artifact({ path: "<target>" })',
			'inspect_gpu_code_objects({ path: "<target>" })',
		);
		initialReaToolSequence.push("1. inspect_model_artifact({ path }) or inspect_gpu_code_objects({ path }) (target-free)");
	} else if (lowerDesc.includes("core file") || ext === ".core" || ext === ".dmp") {
		recommendedSubSkill = "woodchipper-audit";
		recommendedPlaybook = "security-and-vr";
		targetFreeToolsFirst.push('inspect_recorded_crash({ path: "<target>", include_debugger_context: true })');
		initialReaToolSequence.push(
			"1. inspect_recorded_crash({ path, include_debugger_context: true }) to extract faulting IP, registers, and signal",
			"2. Correlate faulting instruction address with the target binary via resolve_containing_procedure & analyze_function",
		);
	} else {
		// Default native binary (Mach-O, ELF, PE, Go, Rust, COFF, archive)
		recommendedSubSkill = "woodchipper-native";
		if (lowerDesc.includes("mach-o")) {
			targetFreeToolsFirst.push(
				'inspect_macho({ path: "<target>", detail: "summary" })',
				'inspect_binary_layout({ path: "<target>", detail: "summary" })',
				'inspect_go_binary({ path: "<target>" })',
				'inspect_rust_binary({ path: "<target>" })',
			);
		} else if (lowerDesc.includes("elf")) {
			targetFreeToolsFirst.push(
				'inspect_elf_notes({ path: "<target>" })',
				'inspect_binary_layout({ path: "<target>", detail: "summary" })',
				'inspect_go_binary({ path: "<target>" })',
				'inspect_rust_binary({ path: "<target>" })',
			);
		} else if (lowerDesc.includes("pe32") || lowerDesc.includes("ms-dos") || ext === ".exe" || ext === ".dll" || ext === ".sys") {
			if (ext === ".sys") {
				recommendedSubSkill = "woodchipper-audit";
				recommendedPlaybook = "security-and-vr";
			}
			targetFreeToolsFirst.push(
				'inspect_pe_resources({ path: "<target>" })',
				'inspect_binary_layout({ path: "<target>", detail: "summary" })',
				'inspect_go_binary({ path: "<target>" })',
				'inspect_rust_binary({ path: "<target>" })',
			);
		} else {
			targetFreeToolsFirst.push(
				'inspect_binary_layout({ path: "<target>", detail: "summary" })',
				'inspect_byte_entropy({ path: "<target>" })',
			);
		}

		initialReaToolSequence.push(
			'1. Run target-free metadata tools FIRST (inspect_binary_layout with detail: "summary", inspect_macho / inspect_elf_notes / inspect_pe_resources, inspect_go_binary, inspect_rust_binary)',
			"2. Save parent_evidence_id and page sections/symbols via inspect_analysis_view",
			"3. Only when procedure decompilation or xrefs are needed: call open_binary -> search_strings / search_procedures -> analyze_function",
		);
	}

	if (sizeBytes > 10 * 1024 * 1024) {
		notes.push(
			`Large artifact (${sizeHuman}): strictly enforce detail: "summary" and page via inspect_analysis_view before requesting full procedure or module views.`,
		);
	}

	return {
		targetPath,
		resolvedPath,
		exists: true,
		isDirectory,
		sizeBytes,
		sizeHuman,
		sha256,
		fileDescription,
		recommendedSubSkill,
		secondarySubSkills,
		recommendedPlaybook,
		targetFreeToolsFirst,
		initialReaToolSequence,
		notes,
	};
}

export function formatStaticTriageMarkdown(result: StaticTriageResult): string {
	if (!result.exists) {
		return `### Woodchipper Static Triage: Target Not Found\n\n- **Requested Path:** \`${result.targetPath}\`\n- **Resolved Path:** \`${result.resolvedPath}\`\n- **Status:** Missing on disk.`;
	}

	const lines: string[] = [
		"### Woodchipper Target-Free Static Reconnaissance",
		"",
		`- **Target Path:** \`${result.resolvedPath}\``,
		`- **Type / Magic (\`file -b\`):** ${result.fileDescription}`,
		`- **Size:** ${result.sizeHuman} (${result.sizeBytes.toLocaleString()} bytes)`,
		`- **SHA-256:** \`${result.sha256 ?? "N/A (directory or special file)"}\``,
		`- **Primary Woodchipper Sub-Skill:** \`${result.recommendedSubSkill}\` ( load \`skills/${result.recommendedSubSkill}/SKILL.md\` )`,
		`- **Secondary Sub-Skills:** ${result.secondarySubSkills.map((s) => `\`${s}\``).join(", ")}`,
		`- **Recommended Playbook:** \`${result.recommendedPlaybook}\``,
		"",
		"#### Target-Free REA Tools (Run Before `open_binary`)",
		...result.targetFreeToolsFirst.map((t) => `- \`${t}\``),
		"",
		"#### Recommended REA Execution Sequence",
		...result.initialReaToolSequence.map((s) => `- ${s}`),
	];

	if (result.notes.length > 0) {
		lines.push("", "#### Triage Notes", ...result.notes.map((n) => `- ${n}`));
	}

	return lines.join("\n");
}

export function loadPlaybookContent(
	projectRoot: string,
	playbookId: PlaybookId,
): {
	descriptor: PlaybookDescriptor;
	content: string;
} | null {
	const descriptor = PLAYBOOK_CATALOG.find((p) => p.id === playbookId);
	if (!descriptor) return null;
	const fullPath = path.join(projectRoot, descriptor.relativePath);
	if (!fs.existsSync(fullPath)) return null;
	return {
		descriptor,
		content: fs.readFileSync(fullPath, "utf8"),
	};
}

export interface BackendCheckStatus {
	name: string;
	available: boolean;
	detail: string;
	remediation?: string;
}

export interface ReaDoctorSummary {
	reaVersion: string;
	mcpToolCount: number | null;
	cliCommandCount: number | null;
	overallHealthy: boolean;
	backends: BackendCheckStatus[];
	rawJson?: Record<string, unknown>;
}

function checkBinaryInPath(binName: string, versionArg = "--version"): { available: boolean; detail: string } {
	try {
		const binPath = execFileSync("which", [binName], {
			encoding: "utf8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (!binPath) return { available: false, detail: `${binName} not found in PATH` };
		try {
			const verOut = execFileSync(binPath, [versionArg], {
				encoding: "utf8",
				timeout: 3000,
				stdio: ["ignore", "pipe", "pipe"],
			})
				.trim()
				.split("\n")[0];
			return { available: true, detail: `${binPath}${verOut ? ` (${verOut})` : ""}` };
		} catch {
			return { available: true, detail: binPath };
		}
	} catch {
		return { available: false, detail: `${binName} not found in PATH` };
	}
}

export function runReaDoctorSummary(projectRoot: string): ReaDoctorSummary {
	let parsed: Record<string, unknown> = {};
	try {
		const out = execFileSync("pnpm", ["exec", "rea", "doctor", "--json"], {
			cwd: projectRoot,
			encoding: "utf8",
			timeout: 30000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		parsed = JSON.parse(out.trim()) as Record<string, unknown>;
	} catch (err: unknown) {
		// rea doctor exits non-zero when some backends are unconfigured but still prints JSON to stdout
		if (err && typeof err === "object" && "stdout" in err && typeof (err as { stdout: unknown }).stdout === "string") {
			const stdout = ((err as { stdout: string }).stdout || "").trim();
			if (stdout.startsWith("{")) {
				try {
					parsed = JSON.parse(stdout) as Record<string, unknown>;
				} catch {
					// ignore
				}
			}
		}
	}

	const identity = (parsed.identity as Record<string, unknown> | undefined) ?? {};
	const catalog = (identity.catalog as Record<string, unknown> | undefined) ?? {};
	const counts = (catalog.counts as Record<string, number> | undefined) ?? {};
	const checks = Array.isArray(parsed.checks) ? (parsed.checks as Array<Record<string, unknown>>) : [];

	const findCheck = (namePrefix: string): Record<string, unknown> | undefined =>
		checks.find((c) => typeof c.name === "string" && (c.name === namePrefix || c.name.startsWith(namePrefix)));

	const ghidraCheck = findCheck("ghidra");
	const hopperCheck = findCheck("hopper");
	const idaCheck = findCheck("ida");
	const jadxCheck = findCheck("jadx");

	const wabtProbe = checkBinaryInPath("wasm2wat", "--version");
	const tsharkProbe = checkBinaryInPath("tshark", "--version");
	const sigrokProbe = checkBinaryInPath("sigrok-cli", "--version");

	const backends: BackendCheckStatus[] = [
		{
			name: "Ghidra",
			available: Boolean(ghidraCheck?.ok),
			detail:
				typeof ghidraCheck?.detail === "string"
					? ghidraCheck.detail
					: ghidraCheck?.ok
						? "Configured"
						: "Not configured",
			remediation: typeof ghidraCheck?.remediation === "string" ? ghidraCheck.remediation : undefined,
		},
		{
			name: "Hopper",
			available: Boolean(hopperCheck?.ok),
			detail:
				typeof hopperCheck?.detail === "string"
					? hopperCheck.detail
					: hopperCheck?.ok
						? "Installed"
						: "Not installed",
			remediation: typeof hopperCheck?.remediation === "string" ? hopperCheck.remediation : undefined,
		},
		{
			name: "IDA",
			available: Boolean(idaCheck?.ok),
			detail:
				typeof idaCheck?.detail === "string" ? idaCheck.detail : idaCheck?.ok ? "Configured" : "Not configured",
			remediation: typeof idaCheck?.remediation === "string" ? idaCheck.remediation : undefined,
		},
		{
			name: "JADX",
			available: Boolean(jadxCheck?.ok),
			detail:
				typeof jadxCheck?.detail === "string" ? jadxCheck.detail : jadxCheck?.ok ? "Configured" : "Not configured",
			remediation: typeof jadxCheck?.remediation === "string" ? jadxCheck.remediation : undefined,
		},
		{
			name: "WABT (wasm2wat)",
			available: wabtProbe.available,
			detail: wabtProbe.detail,
			remediation: wabtProbe.available ? undefined : "Install via `brew install wabt` for extended WASM disassembly",
		},
		{
			name: "tshark (Wireshark CLI)",
			available: tsharkProbe.available,
			detail: tsharkProbe.detail,
			remediation: tsharkProbe.available
				? undefined
				: "Install via `brew install wireshark` for deep packet dissection",
		},
		{
			name: "sigrok (sigrok-cli)",
			available: sigrokProbe.available,
			detail: sigrokProbe.detail,
			remediation: sigrokProbe.available
				? undefined
				: "Install via `brew install sigrok-cli` for logic-analyzer protocol decoding",
		},
	];

	return {
		reaVersion: typeof identity.cli_package_version === "string" ? identity.cli_package_version : "unknown",
		mcpToolCount: typeof counts.mcp_tools === "number" ? counts.mcp_tools : null,
		cliCommandCount: typeof counts.cli_commands === "number" ? counts.cli_commands : null,
		overallHealthy: Boolean(parsed.healthy),
		backends,
		rawJson: parsed,
	};
}

export function formatReaDoctorMarkdown(summary: ReaDoctorSummary): string {
	const lines: string[] = [
		"# Woodchipper / REA Environment & Backend Readiness (`rea doctor`)",
		"",
		`- **REA Package Version:** \`${summary.reaVersion}\``,
		`- **Catalog:** ${summary.mcpToolCount ?? "?"} MCP tools, ${summary.cliCommandCount ?? "?"} CLI commands`,
		"- **Built-in Target-Free Analyzers:** Ready (JS/Electron AST, Mach-O/ELF/PE layout, SQLite, WASM, EVM, GGUF/Safetensors, IL2CPP, byte entropy)",
		"",
		"## Backend Availability (Ghidra, Hopper, IDA, JADX, WABT, tshark, sigrok)",
		"",
		"| Backend | Status | Detail | Remediation |",
		"| :--- | :--- | :--- | :--- |",
	];

	for (const b of summary.backends) {
		const statusText = b.available ? "READY" : "MISSING";
		const rem = b.remediation ?? "-";
		lines.push(`| **${b.name}** | \`${statusText}\` | ${b.detail} | ${rem} |`);
	}

	return lines.join("\n");
}
