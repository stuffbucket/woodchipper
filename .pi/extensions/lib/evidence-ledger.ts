import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface TrackedEvidenceId {
	id: string;
	parentId?: string;
	toolName: string;
	recordedAt: string;
}

export interface ObservationEntry {
	id: string;
	evidenceId: string;
	location: string;
	summary: string;
	toolName?: string;
	recordedAt: string;
}

export type ConfidenceLevel = "high" | "medium" | "low";

export interface InferenceEntry {
	id: string;
	statement: string;
	confidence: ConfidenceLevel;
	supportingEvidenceIds: string[];
	competingExplanations: string[];
	recordedAt: string;
}

export interface UnknownEntry {
	id: string;
	description: string;
	reason: string;
	nextProbe?: string;
	resolved: boolean;
	recordedAt: string;
}

export interface EvidenceLedgerData {
	version: 1;
	workspaceSlug: string;
	targetPath?: string;
	updatedAt: string;
	trackedEvidenceIds: Record<string, TrackedEvidenceId>;
	observations: ObservationEntry[];
	inferences: InferenceEntry[];
	unknowns: UnknownEntry[];
}

/**
 * Derive a human-readable, collision-resistant workspace directory name for a target path
 * so separate reverse-engineering projects never commingle state or leak into global XDG directories.
 */
export function deriveWorkspaceSlug(targetPathOrName?: string): string {
	const raw = (targetPathOrName ?? "").trim();
	if (!raw || raw === "default") {
		return "default";
	}
	const resolved = path.resolve(raw);
	const base = path
		.basename(resolved)
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40) || "target";
	const shortHash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 8);
	return `${base}-${shortHash}`;
}

function createEmptyLedger(workspaceSlug: string, targetPath?: string): EvidenceLedgerData {
	return {
		version: 1,
		workspaceSlug,
		...(targetPath ? { targetPath } : {}),
		updatedAt: new Date().toISOString(),
		trackedEvidenceIds: {},
		observations: [],
		inferences: [],
		unknowns: [],
	};
}

function nextMonotonicId(prefix: string, existingIds: string[]): string {
	let maxNum = 0;
	const pattern = new RegExp(`^${prefix}_(\\d+)$`);
	for (const id of existingIds) {
		const m = id.match(pattern);
		if (m) {
			const n = Number.parseInt(m[1], 10);
			if (Number.isFinite(n) && n > maxNum) {
				maxNum = n;
			}
		}
	}
	return `${prefix}_${maxNum + 1}`;
}

export class EvidenceLedger {
	private projectRoot: string;
	private workspaceSlug: string;
	private targetPath?: string;
	private workspaceDir: string;
	private ledgerPath: string;
	private reportPath: string;
	private triageMapPath: string;
	private data: EvidenceLedgerData;

	constructor(projectRoot: string, initialTargetOrWorkspace?: string) {
		this.projectRoot = projectRoot;
		const envWorkspace = process.env.WOODCHIPPER_WORKSPACE?.trim();
		const initial = initialTargetOrWorkspace ?? envWorkspace ?? "default";
		this.workspaceSlug = initial === "default" ? "default" : deriveWorkspaceSlug(initial);
		this.targetPath = initial !== "default" ? path.resolve(projectRoot, initial) : undefined;
		this.workspaceDir = path.join(this.projectRoot, "workspaces", this.workspaceSlug);
		this.ledgerPath = path.join(this.workspaceDir, "evidence-ledger.json");
		this.reportPath = path.join(this.workspaceDir, "REPORT.md");
		this.triageMapPath = path.join(this.workspaceDir, "TRIAGE_MAP.md");
		this.data = this.loadFromDisk();
	}

	/**
	 * Switch this session's active ledger to an isolated per-target workspace directory
	 * (`workspaces/<target-slug>/`) so separate projects never commingle findings.
	 */
	public setTargetWorkspace(targetPath: string): {
		workspaceSlug: string;
		workspaceDir: string;
		reportPath: string;
		triageMapPath: string;
		ledgerPath: string;
	} {
		const resolved = path.resolve(this.projectRoot, targetPath);
		const nextSlug = deriveWorkspaceSlug(resolved);
		this.workspaceSlug = nextSlug;
		this.targetPath = resolved;
		this.workspaceDir = path.join(this.projectRoot, "workspaces", this.workspaceSlug);
		this.ledgerPath = path.join(this.workspaceDir, "evidence-ledger.json");
		this.reportPath = path.join(this.workspaceDir, "REPORT.md");
		this.triageMapPath = path.join(this.workspaceDir, "TRIAGE_MAP.md");
		this.data = this.loadFromDisk();
		this.data.targetPath = resolved;
		try {
			const workspacesRoot = path.join(this.projectRoot, "workspaces");
			fs.mkdirSync(workspacesRoot, { recursive: true });
			fs.writeFileSync(path.join(workspacesRoot, "ACTIVE_WORKSPACE"), `${this.workspaceSlug}\n`, "utf8");
		} catch {
			// Ignore on read-only filesystem
		}
		return {
			workspaceSlug: this.workspaceSlug,
			workspaceDir: this.workspaceDir,
			reportPath: this.reportPath,
			triageMapPath: this.triageMapPath,
			ledgerPath: this.ledgerPath,
		};
	}

	public getWorkspaceSlug(): string {
		return this.workspaceSlug;
	}

	public getWorkspaceDir(): string {
		return this.workspaceDir;
	}

	public getLedgerPath(): string {
		return this.ledgerPath;
	}

	public getReportPath(): string {
		return this.reportPath;
	}

	public getTriageMapPath(): string {
		return this.triageMapPath;
	}

	public writeTriageMap(markdownContent: string): string {
		try {
			fs.mkdirSync(this.workspaceDir, { recursive: true });
			fs.writeFileSync(this.triageMapPath, `${markdownContent.trimEnd()}\n`, "utf8");
		} catch {
			// Ignore on read-only filesystem
		}
		return this.triageMapPath;
	}

	private loadFromDisk(): EvidenceLedgerData {
		try {
			if (fs.existsSync(this.ledgerPath)) {
				const raw = fs.readFileSync(this.ledgerPath, "utf8");
				const parsed = JSON.parse(raw) as Partial<EvidenceLedgerData>;
				return {
					version: 1,
					workspaceSlug: this.workspaceSlug,
					targetPath: typeof parsed.targetPath === "string" ? parsed.targetPath : this.targetPath,
					updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
					trackedEvidenceIds:
						parsed.trackedEvidenceIds && typeof parsed.trackedEvidenceIds === "object"
							? parsed.trackedEvidenceIds
							: {},
					observations: Array.isArray(parsed.observations) ? parsed.observations : [],
					inferences: Array.isArray(parsed.inferences) ? parsed.inferences : [],
					unknowns: Array.isArray(parsed.unknowns) ? parsed.unknowns : [],
				};
			}
		} catch {
			// Back up corrupted ledger before falling back so data is never silently destroyed
			try {
				if (fs.existsSync(this.ledgerPath)) {
					fs.copyFileSync(this.ledgerPath, `${this.ledgerPath}.corrupt.${Date.now()}.bak`);
				}
			} catch {
				// Ignore
			}
		}
		return createEmptyLedger(this.workspaceSlug, this.targetPath);
	}

	public saveToDisk(): void {
		try {
			this.data.updatedAt = new Date().toISOString();
			this.data.workspaceSlug = this.workspaceSlug;
			if (this.targetPath) {
				this.data.targetPath = this.targetPath;
			}
			fs.mkdirSync(this.workspaceDir, { recursive: true });
			const tmpPath = `${this.ledgerPath}.${process.pid}.tmp`;
			fs.writeFileSync(tmpPath, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			fs.renameSync(tmpPath, this.ledgerPath);

			// Always write the visible human-readable Markdown report inside `workspaces/<target-slug>/REPORT.md`
			const tmpReport = `${this.reportPath}.${process.pid}.tmp`;
			fs.writeFileSync(tmpReport, `${this.formatMarkdownReport()}\n`, { encoding: "utf8" });
			fs.renameSync(tmpReport, this.reportPath);
		} catch {
			// Ignore write failures on read-only filesystems; keep in-memory copy intact
		}
	}

	public reload(): EvidenceLedgerData {
		if (this.workspaceSlug === "default") {
			try {
				const activePointer = path.join(this.projectRoot, "workspaces", "ACTIVE_WORKSPACE");
				if (fs.existsSync(activePointer)) {
					const pointedSlug = fs.readFileSync(activePointer, "utf8").trim();
					if (pointedSlug && pointedSlug !== "default" && /^[a-z0-9._-]+$/i.test(pointedSlug)) {
						this.workspaceSlug = pointedSlug;
						this.workspaceDir = path.join(this.projectRoot, "workspaces", this.workspaceSlug);
						this.ledgerPath = path.join(this.workspaceDir, "evidence-ledger.json");
						this.reportPath = path.join(this.workspaceDir, "REPORT.md");
						this.triageMapPath = path.join(this.workspaceDir, "TRIAGE_MAP.md");
					}
				}
			} catch {
				// Ignore
			}
		}
		this.data = this.loadFromDisk();
		return this.data;
	}

	public getData(): EvidenceLedgerData {
		return this.data;
	}

	public getCounts(): {
		evidenceIds: number;
		observations: number;
		inferences: number;
		unknowns: number;
		unresolvedUnknowns: number;
	} {
		return {
			evidenceIds: Object.keys(this.data.trackedEvidenceIds).length,
			observations: this.data.observations.length,
			inferences: this.data.inferences.length,
			unknowns: this.data.unknowns.length,
			unresolvedUnknowns: this.data.unknowns.filter((u) => !u.resolved).length,
		};
	}

	private upsertEvidenceIdInMemory(id: string, toolName: string, parentId?: string): TrackedEvidenceId {
		const existing = this.data.trackedEvidenceIds[id];
		const entry: TrackedEvidenceId = {
			id,
			parentId: parentId ?? existing?.parentId,
			toolName: existing?.toolName ?? toolName,
			recordedAt: existing?.recordedAt ?? new Date().toISOString(),
		};
		this.data.trackedEvidenceIds[id] = entry;
		return entry;
	}

	public recordEvidenceId(id: string, toolName: string, parentId?: string): TrackedEvidenceId {
		const entry = this.upsertEvidenceIdInMemory(id, toolName, parentId);
		this.saveToDisk();
		return entry;
	}

	public extractFromToolResult(
		toolName: string,
		textBlocks: string[],
		structuredContent?: unknown,
	): TrackedEvidenceId[] {
		const discovered = new Map<string, { id: string; parentId?: string }>();

		const inspectObject = (val: unknown, inheritedParent?: string): void => {
			if (!val || typeof val !== "object") return;
			if (Array.isArray(val)) {
				for (const item of val) {
					inspectObject(item, inheritedParent);
				}
				return;
			}
			const record = val as Record<string, unknown>;
			const parentCandidate =
				typeof record.parent_evidence_id === "string" && record.parent_evidence_id.startsWith("ev_")
					? record.parent_evidence_id
					: inheritedParent;
			const evidenceCandidate =
				typeof record.evidence_id === "string" && record.evidence_id.startsWith("ev_")
					? record.evidence_id
					: undefined;

			if (parentCandidate) {
				discovered.set(parentCandidate, {
					id: parentCandidate,
					parentId: discovered.get(parentCandidate)?.parentId,
				});
			}
			if (evidenceCandidate) {
				discovered.set(evidenceCandidate, {
					id: evidenceCandidate,
					parentId: parentCandidate ?? discovered.get(evidenceCandidate)?.parentId,
				});
			}

			for (const child of Object.values(record)) {
				if (child && typeof child === "object") {
					inspectObject(child, parentCandidate);
				} else if (typeof child === "string") {
					const matches = child.match(/\bev_[a-zA-Z0-9_-]{4,}\b/g);
					if (matches) {
						for (const m of matches) {
							if (!discovered.has(m)) {
								discovered.set(m, { id: m, parentId: parentCandidate });
							}
						}
					}
				}
			}
		};

		if (structuredContent) {
			inspectObject(structuredContent);
		}

		for (const block of textBlocks) {
			const trimmed = block.trim();
			if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
				try {
					const parsed = JSON.parse(trimmed);
					inspectObject(parsed);
				} catch {
					// Fallback to regex extraction below
				}
			}

			const parentMatch = block.match(/"parent_evidence_id"\s*:\s*"(ev_[a-zA-Z0-9_-]+)"/);
			const defaultParent = parentMatch ? parentMatch[1] : undefined;
			if (defaultParent && !discovered.has(defaultParent)) {
				discovered.set(defaultParent, { id: defaultParent });
			}

			const regex = /\bev_[a-zA-Z0-9_-]{4,}\b/g;
			let match = regex.exec(block);
			while (match !== null) {
				const id = match[0];
				if (id !== "ev_unspecified" && !discovered.has(id)) {
					discovered.set(id, {
						id,
						parentId: defaultParent && defaultParent !== id ? defaultParent : undefined,
					});
				}
				match = regex.exec(block);
			}
		}

		if (discovered.size === 0) {
			return [];
		}

		this.reload();
		const recorded: TrackedEvidenceId[] = [];
		for (const item of discovered.values()) {
			const entry = this.upsertEvidenceIdInMemory(item.id, toolName, item.parentId);
			recorded.push(entry);
		}

		this.saveToDisk();
		return recorded;
	}

	public addObservation(input: {
		evidenceId: string;
		location: string;
		summary: string;
		toolName?: string;
	}): ObservationEntry {
		const id = nextMonotonicId(
			"obs",
			this.data.observations.map((o) => o.id),
		);
		const recordedAt = new Date().toISOString();
		const entry: ObservationEntry = {
			id,
			evidenceId: input.evidenceId.trim(),
			location: input.location.trim(),
			summary: input.summary.trim(),
			toolName: input.toolName?.trim(),
			recordedAt,
		};
		this.data.observations.push(entry);
		if (entry.evidenceId.startsWith("ev_") && entry.evidenceId !== "ev_unspecified") {
			this.upsertEvidenceIdInMemory(entry.evidenceId, input.toolName ?? "woodchipper_ledger");
		}
		this.saveToDisk();
		return entry;
	}

	public addInference(input: {
		statement: string;
		confidence: ConfidenceLevel;
		supportingEvidenceIds?: string[];
		competingExplanations?: string[];
	}): InferenceEntry {
		const id = nextMonotonicId(
			"inf",
			this.data.inferences.map((i) => i.id),
		);
		const entry: InferenceEntry = {
			id,
			statement: input.statement.trim(),
			confidence: input.confidence,
			supportingEvidenceIds: (input.supportingEvidenceIds ?? []).map((s) => s.trim()).filter(Boolean),
			competingExplanations: (input.competingExplanations ?? []).map((s) => s.trim()).filter(Boolean),
			recordedAt: new Date().toISOString(),
		};
		this.data.inferences.push(entry);
		this.saveToDisk();
		return entry;
	}

	public addUnknown(input: {
		description: string;
		reason: string;
		nextProbe?: string;
	}): UnknownEntry {
		const id = nextMonotonicId(
			"unk",
			this.data.unknowns.map((u) => u.id),
		);
		const entry: UnknownEntry = {
			id,
			description: input.description.trim(),
			reason: input.reason.trim(),
			nextProbe: input.nextProbe?.trim(),
			resolved: false,
			recordedAt: new Date().toISOString(),
		};
		this.data.unknowns.push(entry);
		this.saveToDisk();
		return entry;
	}

	public resolveUnknown(unknownId: string): UnknownEntry | undefined {
		const found = this.data.unknowns.find((u) => u.id === unknownId);
		if (found) {
			found.resolved = true;
			this.saveToDisk();
		}
		return found;
	}

	public clear(): void {
		this.data = createEmptyLedger(this.workspaceSlug, this.targetPath);
		this.saveToDisk();
	}

	public formatMarkdownReport(): string {
		const counts = this.getCounts();
		const lines: string[] = [
			`# Woodchipper Investigation Report (\`${this.workspaceSlug}\`)`,
			"",
			...(this.data.targetPath ? [`- **Target Path:** \`${this.data.targetPath}\``] : []),
			`- **Workspace Directory:** \`${this.workspaceDir}\``,
			`- **Report File:** \`${this.reportPath}\``,
			`- **Ledger JSON:** \`${this.ledgerPath}\``,
			`- **Updated At:** \`${this.data.updatedAt}\``,
			`- **Tracked Evidence IDs:** ${counts.evidenceIds} | **Observations:** ${counts.observations} | **Inferences:** ${counts.inferences} | **Unknowns:** ${counts.unresolvedUnknowns} open (${counts.unknowns} total)`,
			"",
			"## 1. Observations (Direct Tool Output + Evidence Citations)",
			"",
		];

		if (this.data.observations.length === 0) {
			lines.push("_No observations recorded yet._", "");
		} else {
			for (const obs of this.data.observations) {
				const toolSuffix = obs.toolName ? ` via \`${obs.toolName}\`` : "";
				lines.push(
					`- **[${obs.id}]** \`[Evidence: ${obs.evidenceId} @ ${obs.location}]\`${toolSuffix}: ${obs.summary}`,
				);
			}
			lines.push("");
		}

		lines.push("## 2. Inferences (Hypotheses with Confidence & Competing Explanations)", "");
		if (this.data.inferences.length === 0) {
			lines.push("_No inferences recorded yet._", "");
		} else {
			for (const inf of this.data.inferences) {
				const cites =
					inf.supportingEvidenceIds.length > 0
						? ` (Supporting: ${inf.supportingEvidenceIds.map((e) => `\`${e}\``).join(", ")})`
						: "";
				lines.push(`- **[${inf.id}]** \`[Confidence: ${inf.confidence.toUpperCase()}]\` ${inf.statement}${cites}`);
				if (inf.competingExplanations.length > 0) {
					lines.push(`  - _Competing Explanations:_ ${inf.competingExplanations.join("; ")}`);
				}
			}
			lines.push("");
		}

		lines.push("## 3. Unknowns (Unexamined Paths, Truncated Pages & Next Probes)", "");
		if (this.data.unknowns.length === 0) {
			lines.push("_No unknowns recorded yet._", "");
		} else {
			for (const unk of this.data.unknowns) {
				const status = unk.resolved ? "[RESOLVED]" : "[OPEN]";
				const probe = unk.nextProbe ? ` -> _Next Probe:_ ${unk.nextProbe}` : "";
				lines.push(`- **[${unk.id}]** \`${status}\` ${unk.description} (_Reason:_ ${unk.reason})${probe}`);
			}
			lines.push("");
		}

		lines.push("## Tracked REA Evidence IDs (`ev_*`)", "");
		const trackedList = Object.values(this.data.trackedEvidenceIds);
		if (trackedList.length === 0) {
			lines.push("_No `ev_*` identifiers captured from REA tool results yet._");
		} else {
			for (const ev of trackedList) {
				const parent = ev.parentId ? ` (parent: \`${ev.parentId}\`)` : "";
				lines.push(`- \`${ev.id}\` — from \`${ev.toolName}\`${parent} at \`${ev.recordedAt}\``);
			}
		}

		return lines.join("\n");
	}
}
