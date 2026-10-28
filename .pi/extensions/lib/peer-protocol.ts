/**
 * Woodchipper Claude Code Peer (`peerProtocol: 1`) & A2A Protocol Library
 *
 * Implements:
 * 1. File-based session discovery in `~/.claude/sessions/<pid>.json` and
 *    per-socket key file `~/.claude/sessions/<pid>.<sha256(socketPath)>.key`.
 * 2. Unix Domain Socket (UDS) server at `/tmp/cc-socks/<pid>.sock` speaking:
 *    - Claude Code `peerProtocol: 1` (`auth` frame, `type: "user"` SendMessage frame,
 *      `type: "control"` `notify_when_idle` / `peer_idle_notice` / `peer_message_status` / `rename`).
 *    - Direct Woodchipper A2A JSON-RPC frames (`type: "a2a"`, `action: "prompt" | "steer" | "status" | "ledger" | "ping"`).
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/** Maximum inbound UDS buffer size before dropping connection (1 MiB). */
export const MAX_UDS_FRAME_BYTES = 1024 * 1024;
/** Maximum queued subscribers / requesters / pending A2A clients to prevent unbounded memory DoS. */
export const MAX_QUEUED_PEERS = 64;

export interface ClaudePeerSessionRecord {
	pid: number;
	sessionId: string;
	cwd: string;
	startedAt: number;
	procStart: string;
	version: string;
	peerProtocol: number;
	peerFeatures: string[];
	kind: "interactive" | "background" | "daemon";
	entrypoint: string;
	pidDomain: string;
	messagingSocketPath: string;
	name: string;
	nameSource: "user" | "derived" | "peer";
	nameSince: number;
	status: "idle" | "busy";
	updatedAt: number;
	statusUpdatedAt: number;
}

export interface ClaudePeerKeyRecord {
	peerToken: string;
	procStart: string;
	pidDomain: string;
}

export interface InboundPeerPrompt {
	msgId: string;
	text: string;
	rawContent: string;
	priority: "next" | "later" | "now";
	isReply?: boolean;
	replyToMsgId?: string;
	senderSocketPath?: string;
	senderLabel?: string;
	senderPid?: number;
	senderSessionId?: string;
}

export interface A2ARequest {
	type: "a2a";
	id?: string;
	action: "prompt" | "steer" | "status" | "ledger" | "ping" | "flow_status" | "flow_halt";
	message?: string;
}

export interface PeerServerCallbacks {
	onPrompt: (prompt: InboundPeerPrompt) => void | Promise<void>;
	onRename?: (newName: string) => void;
	getStatus?: () => Record<string, unknown>;
	getLedgerSummary?: () => Record<string, unknown>;
	getFlowStatus?: () => Record<string, unknown> | null;
	onFlowHalt?: (summary?: string) => Record<string, unknown> | null;
}

export function getClaudeSessionsDir(overrideDir?: string): string {
	return overrideDir || process.env.WOODCHIPPER_CLAUDE_SESSIONS_DIR || path.join(os.homedir(), ".claude", "sessions");
}

export function getSocketDir(overrideDir?: string): string {
	return overrideDir || process.env.WOODCHIPPER_CC_SOCKS_DIR || "/tmp/cc-socks";
}

export function sha256Hex(input: string): string {
	return crypto.createHash("sha256").update(input).digest("hex");
}

export function getKeyFilePath(sessionsDir: string, pid: number, socketPath: string): string {
	return path.join(sessionsDir, `${pid}.${sha256Hex(socketPath)}.key`);
}

export function getSessionFilePath(sessionsDir: string, pid: number): string {
	return path.join(sessionsDir, `${pid}.json`);
}

export function getProcessStartString(pid: number = process.pid): string {
	try {
		return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 2000,
		}).trim();
	} catch {
		return new Date().toUTCString();
	}
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Sanitize an XML attribute value so quotes, angle brackets, ampersands, and control characters
 * cannot break out of `<cross-session-message ...>` attributes.
 */
export function escapeXmlAttr(value: string): string {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/[\r\n]/g, " ");
}

/**
 * Sanitize message body text inside `<cross-session-message>...</cross-session-message>` so
 * a payload containing `</cross-session-message>` cannot break out of the envelope.
 */
export function sanitizeCrossSessionBody(body: string): string {
	return String(body).replace(/<\/?cross-session-message\b/gi, (match) =>
		match.startsWith("</") ? "<\\/cross-session-message" : "<\\cross-session-message",
	);
}

/**
 * Validate a peer name so it cannot inject XML attributes or control characters.
 */
export function sanitizePeerName(name: string): string {
	const cleaned = String(name)
		.trim()
		.replace(/[^a-zA-Z0-9._:@/-]/g, "-")
		.slice(0, 64);
	return cleaned || "woodchipper";
}

/**
 * Verify that a socket or session directory is owned by the current UID, is not a symlink,
 * and has mode 0700 (no group or world permissions).
 */
export function ensureSecureDirectory(dirPath: string): void {
	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
	}
	const lstat = fs.lstatSync(dirPath);
	if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
		throw new Error(`Refusing insecure socket/session directory (symlink or non-directory): ${dirPath}`);
	}
	if (typeof process.getuid === "function" && lstat.uid !== process.getuid()) {
		throw new Error(`Refusing socket/session directory owned by uid ${lstat.uid} (expected ${process.getuid()}): ${dirPath}`);
	}
	if ((lstat.mode & 0o077) !== 0) {
		fs.chmodSync(dirPath, 0o700);
		const recheck = fs.lstatSync(dirPath);
		if ((recheck.mode & 0o077) !== 0) {
			throw new Error(`Refusing socket/session directory with group/world permissions: ${dirPath}`);
		}
	}
}

/**
 * Verify that a candidate peer reply socket path resides strictly inside the trusted `socketDir`,
 * matches `<pid>.sock`, is a live Unix Domain Socket, and (when `sessionsDir` is provided)
 * corresponds to a registered live peer session whose `messagingSocketPath` matches.
 */
export function isTrustedPeerSocketPath(
	candidatePath: string,
	socketDir: string,
	options?: { sessionsDir?: string; expectedPid?: number; selfSocketPath?: string },
): boolean {
	if (!candidatePath || typeof candidatePath !== "string") return false;
	try {
		const resolvedDir = fs.existsSync(socketDir) ? fs.realpathSync(socketDir) : path.resolve(socketDir);
		const parentDir = path.dirname(candidatePath);
		if (!fs.existsSync(parentDir)) return false;
		const resolvedParent = fs.realpathSync(parentDir);
		if (resolvedParent !== resolvedDir) return false;
		const base = path.basename(candidatePath);
		const pidMatch = base.match(/^(\d+)\.sock$/);
		if (!pidMatch) return false;
		const socketPid = Number.parseInt(pidMatch[1], 10);
		if (options?.expectedPid !== undefined && options.expectedPid !== socketPid) {
			return false;
		}
		const fullCandidate = path.join(resolvedParent, base);
		if (options?.selfSocketPath) {
			const resolvedSelf = fs.existsSync(options.selfSocketPath)
				? fs.realpathSync(options.selfSocketPath)
				: path.resolve(options.selfSocketPath);
			if (fullCandidate === resolvedSelf || candidatePath === options.selfSocketPath) {
				return false;
			}
		}
		if (!fs.existsSync(fullCandidate)) return false;
		const lstat = fs.lstatSync(fullCandidate);
		if (!lstat.isSocket()) return false;
		if (typeof process.getuid === "function" && lstat.uid !== process.getuid()) {
			return false;
		}
		if (options?.sessionsDir) {
			const sessionFile = getSessionFilePath(options.sessionsDir, socketPid);
			if (!fs.existsSync(sessionFile)) return false;
			const record = JSON.parse(fs.readFileSync(sessionFile, "utf8")) as ClaudePeerSessionRecord;
			if (!record || record.pid !== socketPid || !isProcessAlive(socketPid)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Parse a `<cross-session-message ...>...</cross-session-message>` envelope if present,
 * extracting sender metadata, reply markers, and inner text.
 */
export function parseCrossSessionEnvelope(rawContent: string): {
	text: string;
	isReply?: boolean;
	replyToId?: string;
	replyToMsgId?: string;
	senderSocketPath?: string;
	senderLabel?: string;
	senderPid?: number;
	senderSessionId?: string;
} {
	const openTagMatch = rawContent.match(/^<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>\s*$/);
	if (!openTagMatch) {
		return { text: rawContent.trim(), isReply: false };
	}
	const attrs = openTagMatch[1] || "";
	const body = (openTagMatch[2] || "").trim();
	const fromMatch = attrs.match(/\bfrom="([^"]+)"/);
	const labelMatch = attrs.match(/\blabel="([^"]+)"/);
	const pidMatch = attrs.match(/\bsender-pid="(\d+)"/);
	const sessionMatch = attrs.match(/\bsender-session="([^"]+)"/);
	const replyToMatch = attrs.match(/\breply-to="([^"]+)"/);
	const isReplyAttr = /\bis-reply="true"/.test(attrs);

	let senderSocketPath: string | undefined;
	if (fromMatch?.[1] && fromMatch[1].startsWith("uds:")) {
		senderSocketPath = fromMatch[1].slice(4);
	}

	const replyToId = replyToMatch?.[1];
	return {
		text: body,
		isReply: isReplyAttr || Boolean(replyToId),
		replyToId,
		replyToMsgId: replyToId,
		senderSocketPath,
		senderLabel: labelMatch?.[1],
		senderPid: pidMatch?.[1] ? Number.parseInt(pidMatch[1], 10) : undefined,
		senderSessionId: sessionMatch?.[1],
	};
}

/**
 * Discover all live local Claude Code and Woodchipper peers registered in `~/.claude/sessions`.
 */
export function listLiveClaudePeers(options?: { sessionsDir?: string }): ClaudePeerSessionRecord[] {
	const sessionsDir = getClaudeSessionsDir(options?.sessionsDir);
	if (!fs.existsSync(sessionsDir)) {
		return [];
	}
	const peers: ClaudePeerSessionRecord[] = [];
	const entries = fs.readdirSync(sessionsDir);
	for (const entry of entries) {
		if (!/^\d+\.json$/.test(entry)) continue;
		const fullPath = path.join(sessionsDir, entry);
		try {
			const record = JSON.parse(fs.readFileSync(fullPath, "utf8")) as ClaudePeerSessionRecord;
			if (!record || typeof record.pid !== "number" || !isProcessAlive(record.pid)) {
				continue;
			}
			if (record.messagingSocketPath && fs.existsSync(record.messagingSocketPath)) {
				const st = fs.lstatSync(record.messagingSocketPath);
				if (st.isSocket()) {
					peers.push(record);
				}
			}
		} catch {
			// Ignore malformed or concurrently removed session files
		}
	}
	return peers.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Send a raw frame to a peer's Unix Domain Socket, authenticating with its `.key` file if available.
 */
export async function sendFrameToPeerSocket(
	targetSocketPath: string,
	payload: Record<string, unknown>,
	options?: { sessionsDir?: string; targetPid?: number; timeoutMs?: number; tokenOverride?: string | null },
): Promise<string> {
	const sessionsDir = getClaudeSessionsDir(options?.sessionsDir);
	const timeoutMs = options?.timeoutMs ?? 5000;

	let peerToken: string | undefined;
	if (options?.tokenOverride !== undefined) {
		peerToken = options.tokenOverride ?? undefined;
	} else {
		const pidGuess =
			options?.targetPid ??
			(() => {
				const base = path.basename(targetSocketPath, ".sock");
				const n = Number.parseInt(base, 10);
				return Number.isFinite(n) ? n : undefined;
			})();

		if (pidGuess !== undefined) {
			const keyFile = getKeyFilePath(sessionsDir, pidGuess, targetSocketPath);
			if (fs.existsSync(keyFile)) {
				try {
					const keyData = JSON.parse(fs.readFileSync(keyFile, "utf8")) as ClaudePeerKeyRecord;
					peerToken = keyData.peerToken;
				} catch {
					// Proceed without token if unreadable
				}
			}
		}
	}

	return new Promise<string>((resolve, reject) => {
		const socket = net.createConnection(targetSocketPath);
		let responseBuffer = "";
		let settled = false;

		const finish = (err?: Error, value?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (err) reject(err);
			else resolve(value ?? "");
		};

		const timer = setTimeout(() => {
			socket.destroy();
			finish(new Error(`Timed out connecting to peer socket ${targetSocketPath}`));
		}, timeoutMs);
		timer.unref?.();

		socket.on("connect", () => {
			if (peerToken) {
				socket.write(`${JSON.stringify({ type: "auth", token: peerToken })}\n`);
			}
			socket.write(`${JSON.stringify(payload)}\n`);
			if (payload.type !== "a2a") {
				socket.end();
			}
		});

		socket.on("data", (chunk) => {
			responseBuffer += chunk.toString("utf8");
			if (responseBuffer.includes("\n")) {
				const trimmed = responseBuffer.trim();
				try {
					const parsed = JSON.parse(trimmed.split("\n")[0]);
					if (parsed.type === "error") {
						socket.destroy();
						finish(new Error(parsed.error || "Peer socket rejected frame"));
						return;
					}
				} catch {
					// Continue
				}
				if (payload.type === "a2a") {
					socket.end();
					finish(undefined, trimmed);
				}
			}
		});

		socket.on("end", () => {
			finish(undefined, responseBuffer.trim());
		});

		socket.on("close", () => {
			finish(undefined, responseBuffer.trim());
		});

		socket.on("error", (err) => {
			finish(err);
		});
	});
}

/**
 * Send a Claude Code `peerProtocol: 1` user message to a target peer.
 */
export async function sendClaudePeerMessage(options: {
	target: ClaudePeerSessionRecord;
	message: string;
	senderPid?: number;
	senderName?: string;
	senderSessionId?: string;
	senderSocketPath?: string;
	senderCwd?: string;
	priority?: "next" | "later" | "now";
	isReply?: boolean;
	replyToMsgId?: string;
	sessionsDir?: string;
	tokenOverride?: string | null;
}): Promise<string> {
	const msgId = crypto.randomUUID();
	const fromAttr = options.senderSocketPath ? `uds:${escapeXmlAttr(options.senderSocketPath)}` : `pid:${options.senderPid ?? process.pid}`;
	const labelAttr = escapeXmlAttr(options.senderName || "woodchipper");
	const pidAttr = String(options.senderPid ?? process.pid);
	const sessionAttr = escapeXmlAttr(options.senderSessionId || "woodchipper-session");
	const cwdAttr = escapeXmlAttr(options.senderCwd || process.cwd());
	const replyAttrs =
		options.isReply || options.replyToMsgId
			? ` is-reply="true"${options.replyToMsgId ? ` reply-to="${escapeXmlAttr(options.replyToMsgId)}"` : ""}`
			: "";
	const safeBody = sanitizeCrossSessionBody(options.message);

	const wrappedContent = `<cross-session-message from="${fromAttr}" label="${labelAttr}" sender-pid="${pidAttr}" sender-session="${sessionAttr}" sender-cwd="${cwdAttr}" sender-permission-mode="default" msg-id="${msgId}"${replyAttrs}>\n${safeBody}\n</cross-session-message>`;

	return sendFrameToPeerSocket(
		options.target.messagingSocketPath,
		{
			type: "user",
			message: {
				role: "user",
				content: wrappedContent,
			},
			priority: options.priority || "next",
			msg_id: msgId,
		},
		{
			sessionsDir: options.sessionsDir,
			targetPid: options.target.pid,
			tokenOverride: options.tokenOverride,
		},
	);
}

/**
 * Woodchipper Peer Server: registers the current Pi process in `~/.claude/sessions/<pid>.json`
 * and listens on `/tmp/cc-socks/<pid>.sock` for both Claude Code `peerProtocol: 1` messages
 * and Woodchipper A2A requests.
 */
export class WoodchipperPeerServer {
	readonly pid: number;
	readonly sessionId: string;
	readonly cwd: string;
	readonly sessionsDir: string;
	readonly socketDir: string;
	readonly socketPath: string;
	readonly sessionFilePath: string;
	readonly keyFilePath: string;
	readonly peerToken: string;
	readonly procStart: string;
	private name: string;
	private status: "idle" | "busy" = "idle";
	private startedAt: number;
	private server: net.Server | null = null;
	private callbacks: PeerServerCallbacks;
	private idleSubscribers: Array<{ replyTo: string; subscriberLabel?: string }> = [];
	private activeRequesters: Array<{ socketPath: string; pid?: number; label?: string; msgId?: string }> = [];
	private pendingA2AClients: Array<{ socket: net.Socket; id?: string }> = [];
	private activeClients = new Set<net.Socket>();
	private lastAssistantText = "";

	constructor(options: {
		name?: string;
		cwd: string;
		pid?: number;
		sessionId?: string;
		sessionsDir?: string;
		socketDir?: string;
		callbacks: PeerServerCallbacks;
	}) {
		this.pid = options.pid ?? process.pid;
		this.sessionId = options.sessionId ?? crypto.randomUUID();
		this.cwd = options.cwd;
		this.name = sanitizePeerName(options.name || process.env.WOODCHIPPER_PEER_NAME || "woodchipper");
		this.sessionsDir = getClaudeSessionsDir(options.sessionsDir);
		this.socketDir = getSocketDir(options.socketDir);
		this.socketPath = path.join(this.socketDir, `${this.pid}.sock`);
		this.sessionFilePath = getSessionFilePath(this.sessionsDir, this.pid);
		this.keyFilePath = getKeyFilePath(this.sessionsDir, this.pid, this.socketPath);
		this.peerToken = crypto.randomBytes(16).toString("hex");
		this.procStart = getProcessStartString(this.pid);
		this.startedAt = Date.now();
		this.callbacks = options.callbacks;
	}

	getName(): string {
		return this.name;
	}

	getStatus(): "idle" | "busy" {
		return this.status;
	}

	async start(): Promise<void> {
		if (this.server) return;

		ensureSecureDirectory(this.sessionsDir);
		ensureSecureDirectory(this.socketDir);

		fs.rmSync(this.socketPath, { force: true });

		this.server = net.createServer((client) => this.handleConnection(client));
		this.server.on("error", () => {
			// Prevent unhandled server socket errors from crashing Pi
		});

		const prevUmask = process.umask(0o077);
		try {
			await new Promise<void>((resolve, reject) => {
				this.server!.once("error", reject);
				this.server!.listen(this.socketPath, () => {
					try {
						fs.chmodSync(this.socketPath, 0o600);
					} catch {
						// Ignore
					}
					resolve();
				});
			});
		} finally {
			process.umask(prevUmask);
		}

		this.writeKeyFile();
		this.writeSessionFile();

		// Create convenience symlink in .woodchipper/peer.sock (using rmSync force to clean dangling symlinks)
		try {
			const localDir = path.join(this.cwd, ".woodchipper");
			fs.mkdirSync(localDir, { recursive: true, mode: 0o700 });
			const symlinkPath = path.join(localDir, "peer.sock");
			fs.rmSync(symlinkPath, { force: true });
			fs.symlinkSync(this.socketPath, symlinkPath);
		} catch {
			// Best-effort symlink
		}
	}

	private writeKeyFile(): void {
		const keyPayload: ClaudePeerKeyRecord = {
			peerToken: this.peerToken,
			procStart: this.procStart,
			pidDomain: process.platform === "darwin" ? "darwin" : "linux",
		};
		const tmpKey = `${this.keyFilePath}.${this.pid}.tmp`;
		fs.writeFileSync(tmpKey, JSON.stringify(keyPayload), { mode: 0o600 });
		fs.chmodSync(tmpKey, 0o600);
		fs.renameSync(tmpKey, this.keyFilePath);
	}

	private writeSessionFile(): void {
		const now = Date.now();
		const sessionPayload: ClaudePeerSessionRecord = {
			pid: this.pid,
			sessionId: this.sessionId,
			cwd: this.cwd,
			startedAt: this.startedAt,
			procStart: this.procStart,
			version: "2.1.308",
			peerProtocol: 1,
			peerFeatures: ["notify_idle", "reply_across_default_dirs", "artifact_yield"],
			kind: "interactive",
			entrypoint: "cli",
			pidDomain: process.platform === "darwin" ? "darwin" : "linux",
			messagingSocketPath: this.socketPath,
			name: this.name,
			nameSource: "user",
			nameSince: this.startedAt,
			status: this.status,
			updatedAt: now,
			statusUpdatedAt: now,
		};
		const tmpSession = `${this.sessionFilePath}.${this.pid}.tmp`;
		fs.writeFileSync(tmpSession, JSON.stringify(sessionPayload), { mode: 0o600 });
		fs.chmodSync(tmpSession, 0o600);
		fs.renameSync(tmpSession, this.sessionFilePath);
	}

	setBusy(): void {
		if (this.status !== "busy") {
			this.lastAssistantText = "";
		}
		this.status = "busy";
		try {
			this.writeSessionFile();
		} catch {
			// Ignore
		}
	}

	recordAssistantText(text: string): void {
		if (text && text.trim().length > 0) {
			this.lastAssistantText = text;
		}
	}

	async setIdleAndNotify(finalAssistantText?: string, options?: { aborted?: boolean }): Promise<void> {
		if (finalAssistantText && finalAssistantText.trim().length > 0) {
			this.lastAssistantText = finalAssistantText;
		}
		const wasAborted = Boolean(options?.aborted);
		const replyText = this.lastAssistantText || (wasAborted ? "[Turn aborted]" : "");
		this.status = "idle";
		try {
			this.writeSessionFile();
		} catch {
			// Ignore
		}

		// 1. Reply to any waiting synchronous A2A clients
		const a2aClients = this.pendingA2AClients.splice(0, this.pendingA2AClients.length);
		for (const item of a2aClients) {
			try {
				if (!item.socket.destroyed && item.socket.writable) {
					item.socket.write(
						`${JSON.stringify({
							type: "a2a_response",
							id: item.id,
							ok: !wasAborted,
							aborted: wasAborted || undefined,
							status: "idle",
							reply: replyText,
						})}\n`,
					);
					item.socket.end();
				}
			} catch {
				// Ignore closed socket
			}
		}

		// 2. Dispatch replies & idle notifications concurrently with bounded timeout so agent_settled never blocks
		const outboundTasks: Array<Promise<unknown>> = [];

		const requesters = this.activeRequesters.splice(0, this.activeRequesters.length);
		for (const req of requesters) {
			if (
				!wasAborted &&
				replyText &&
				isTrustedPeerSocketPath(req.socketPath, this.socketDir, {
					sessionsDir: this.sessionsDir,
					expectedPid: req.pid,
					selfSocketPath: this.socketPath,
				})
			) {
				const safeFrom = escapeXmlAttr(this.socketPath);
				const safeName = escapeXmlAttr(this.name);
				const safeCwd = escapeXmlAttr(this.cwd);
				const replyAttr = req.msgId ? ` reply-to="${escapeXmlAttr(req.msgId)}"` : "";
				const safeBody = sanitizeCrossSessionBody(replyText);
				outboundTasks.push(
					sendFrameToPeerSocket(
						req.socketPath,
						{
							type: "user",
							message: {
								role: "user",
								content: `<cross-session-message from="uds:${safeFrom}" label="${safeName}" sender-pid="${this.pid}" sender-session="${this.sessionId}" sender-cwd="${safeCwd}" sender-permission-mode="default" msg-id="${crypto.randomUUID()}" is-reply="true"${replyAttr}>\n${safeBody}\n</cross-session-message>`,
							},
							priority: "next",
							msg_id: crypto.randomUUID(),
						},
						{
							sessionsDir: this.sessionsDir,
							targetPid: req.pid,
							timeoutMs: 1500,
						},
					).catch(() => {}),
				);
			}
		}

		const subscribers = this.idleSubscribers.splice(0, this.idleSubscribers.length);
		for (const sub of subscribers) {
			if (
				isTrustedPeerSocketPath(sub.replyTo, this.socketDir, {
					sessionsDir: this.sessionsDir,
					selfSocketPath: this.socketPath,
				})
			) {
				outboundTasks.push(
					sendFrameToPeerSocket(
						sub.replyTo,
						{
							type: "control",
							request: {
								subtype: "peer_idle_notice",
								from_label: this.name,
								from_session: this.sessionId,
								from_socket: this.socketPath,
								reason: "idle",
							},
						},
						{ sessionsDir: this.sessionsDir, timeoutMs: 1500 },
					).catch(() => {}),
				);
			}
		}

		if (outboundTasks.length > 0) {
			await Promise.allSettled(outboundTasks);
		}
	}

	private verifyToken(candidate: unknown): boolean {
		if (typeof candidate !== "string") return false;
		const provided = Buffer.from(candidate, "utf8");
		const expected = Buffer.from(this.peerToken, "utf8");
		if (provided.length !== expected.length) return false;
		return crypto.timingSafeEqual(provided, expected);
	}

	private handleConnection(client: net.Socket): void {
		this.activeClients.add(client);
		let buffer = "";
		let authenticated = false;

		client.setTimeout(30_000, () => {
			const isPendingA2A = this.pendingA2AClients.some((c) => c.socket === client);
			if (!isPendingA2A) {
				client.destroy();
			}
		});

		client.on("close", () => {
			this.activeClients.delete(client);
			this.pendingA2AClients = this.pendingA2AClients.filter((c) => c.socket !== client);
		});

		client.on("error", () => {
			this.activeClients.delete(client);
			this.pendingA2AClients = this.pendingA2AClients.filter((c) => c.socket !== client);
		});

		client.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			if (buffer.length > MAX_UDS_FRAME_BYTES) {
				client.destroy();
				return;
			}
			let newlineIdx = buffer.indexOf("\n");
			while (newlineIdx !== -1) {
				const line = buffer.slice(0, newlineIdx).trim();
				buffer = buffer.slice(newlineIdx + 1);
				if (line.length > 0) {
					const keepAlive = this.processLine(client, line, {
						isAuthenticated: () => authenticated,
						setAuthenticated: (v: boolean) => {
							authenticated = v;
						},
					});
					if (!keepAlive) {
						return;
					}
				}
				newlineIdx = buffer.indexOf("\n");
			}
		});
	}

	private processLine(
		client: net.Socket,
		line: string,
		authState: { isAuthenticated: () => boolean; setAuthenticated: (v: boolean) => void },
	): boolean {
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(line) as Record<string, unknown>;
		} catch {
			client.destroy();
			return false;
		}

		if (frame.type === "auth") {
			if (this.verifyToken(frame.token)) {
				authState.setAuthenticated(true);
				return true;
			}
			try {
				if (client.writable) {
					client.write(`${JSON.stringify({ type: "error", ok: false, error: "invalid_peer_token" })}\n`);
				}
			} catch {
				// Ignore
			}
			client.destroy();
			return false;
		}

		if (!authState.isAuthenticated()) {
			try {
				if (client.writable) {
					client.write(`${JSON.stringify({ type: "error", ok: false, error: "unauthenticated" })}\n`);
				}
			} catch {
				// Ignore
			}
			client.destroy();
			return false;
		}

		if (frame.type === "user") {
			const msgObj = (frame.message || {}) as Record<string, unknown>;
			const rawContent = typeof msgObj.content === "string" ? msgObj.content : JSON.stringify(msgObj.content ?? "");
			const parsed = parseCrossSessionEnvelope(rawContent);
			const msgId = typeof frame.msg_id === "string" ? frame.msg_id : crypto.randomUUID();
			const priority =
				frame.priority === "now" || frame.priority === "later" || frame.priority === "next" ? frame.priority : "next";

			// Only queue auto-reply requester if this is NOT already a reply (prevents A<->B infinite ping-pong)
			// and only if the sender socket is a verified live peer inside socketDir (prevents confused-deputy SSRF).
			if (
				!parsed.isReply &&
				parsed.senderSocketPath &&
				isTrustedPeerSocketPath(parsed.senderSocketPath, this.socketDir, {
					sessionsDir: this.sessionsDir,
					expectedPid: parsed.senderPid,
					selfSocketPath: this.socketPath,
				})
			) {
				if (
					this.activeRequesters.length < MAX_QUEUED_PEERS &&
					!this.activeRequesters.some((r) => r.socketPath === parsed.senderSocketPath)
				) {
					this.activeRequesters.push({
						socketPath: parsed.senderSocketPath,
						pid: parsed.senderPid,
						label: parsed.senderLabel,
						msgId,
					});
				}
				sendFrameToPeerSocket(
					parsed.senderSocketPath,
					{
						type: "control",
						request: {
							subtype: "peer_message_status",
							msg_id: msgId,
							status: "approved",
						},
					},
					{
						sessionsDir: this.sessionsDir,
						targetPid: parsed.senderPid,
						timeoutMs: 1500,
					},
				).catch(() => {});
			}

			this.setBusy();
			Promise.resolve(
				this.callbacks.onPrompt({
					msgId,
					text: parsed.text,
					rawContent,
					priority,
					isReply: parsed.isReply,
					replyToMsgId: parsed.replyToMsgId,
					senderSocketPath: parsed.senderSocketPath,
					senderLabel: parsed.senderLabel,
					senderPid: parsed.senderPid,
					senderSessionId: parsed.senderSessionId,
				}),
			).catch(() => {});
			return true;
		}

		if (frame.type === "control") {
			const req = (frame.request || {}) as Record<string, unknown>;
			if (
				req.subtype === "notify_when_idle" &&
				typeof req.reply_to === "string" &&
				isTrustedPeerSocketPath(req.reply_to, this.socketDir, {
					sessionsDir: this.sessionsDir,
					selfSocketPath: this.socketPath,
				})
			) {
				if (this.status === "idle") {
					// Already idle: notify immediately so subscriber does not hang waiting for a future turn
					sendFrameToPeerSocket(
						req.reply_to,
						{
							type: "control",
							request: {
								subtype: "peer_idle_notice",
								from_label: this.name,
								from_session: this.sessionId,
								from_socket: this.socketPath,
								reason: "idle",
							},
						},
						{ sessionsDir: this.sessionsDir, timeoutMs: 1500 },
					).catch(() => {});
				} else if (
					this.idleSubscribers.length < MAX_QUEUED_PEERS &&
					!this.idleSubscribers.some((s) => s.replyTo === req.reply_to)
				) {
					this.idleSubscribers.push({
						replyTo: req.reply_to,
						subscriberLabel: typeof req.subscriber_label === "string" ? req.subscriber_label : undefined,
					});
				}
			} else if (req.subtype === "rename" && typeof req.name === "string" && req.name.trim()) {
				this.name = sanitizePeerName(req.name);
				try {
					this.writeSessionFile();
				} catch {
					// Ignore
				}
				this.callbacks.onRename?.(this.name);
			}
			return true;
		}

		if (frame.type === "a2a") {
			const req = frame as unknown as A2ARequest;
			if (req.action === "ping" || req.action === "status") {
				const extra = this.callbacks.getStatus ? this.callbacks.getStatus() : {};
				try {
					if (client.writable) {
						client.write(
							`${JSON.stringify({
								type: "a2a_response",
								id: req.id,
								ok: true,
								name: this.name,
								pid: this.pid,
								sessionId: this.sessionId,
								socketPath: this.socketPath,
								status: this.status,
								...extra,
							})}\n`,
						);
						client.end();
					}
				} catch {
					// Ignore
				}
				return false;
			}
			if (req.action === "ledger") {
				const ledger = this.callbacks.getLedgerSummary ? this.callbacks.getLedgerSummary() : {};
				try {
					if (client.writable) {
						client.write(
							`${JSON.stringify({
								type: "a2a_response",
								id: req.id,
								ok: true,
								ledger,
							})}\n`,
						);
						client.end();
					}
				} catch {
					// Ignore
				}
				return false;
			}
			if (req.action === "flow_status") {
				const flow = this.callbacks.getFlowStatus ? this.callbacks.getFlowStatus() : null;
				try {
					if (client.writable) {
						client.write(
							`${JSON.stringify({
								type: "a2a_response",
								id: req.id,
								ok: true,
								flow,
							})}\n`,
						);
						client.end();
					}
				} catch {
					// Ignore
				}
				return false;
			}
			if (req.action === "flow_halt") {
				const flow = this.callbacks.onFlowHalt ? this.callbacks.onFlowHalt(req.message) : null;
				try {
					if (client.writable) {
						client.write(
							`${JSON.stringify({
								type: "a2a_response",
								id: req.id,
								ok: true,
								flow,
							})}\n`,
						);
						client.end();
					}
				} catch {
					// Ignore
				}
				return false;
			}
			if ((req.action === "prompt" || req.action === "steer") && typeof req.message === "string") {
				if (this.pendingA2AClients.length >= MAX_QUEUED_PEERS) {
					try {
						if (client.writable) {
							client.write(
								`${JSON.stringify({
									type: "a2a_response",
									id: req.id,
									ok: false,
									error: "too_many_pending_a2a_requests",
								})}\n`,
							);
							client.end();
						}
					} catch {
						// Ignore
					}
					return false;
				}
				client.setTimeout(0);
				this.pendingA2AClients.push({ socket: client, id: req.id });
				this.setBusy();
				Promise.resolve(
					this.callbacks.onPrompt({
						msgId: req.id || crypto.randomUUID(),
						text: req.message,
						rawContent: req.message,
						priority: req.action === "steer" ? "now" : "next",
						senderLabel: "a2a-client",
					}),
				).catch((err) => {
					this.pendingA2AClients = this.pendingA2AClients.filter((c) => c.socket !== client);
					try {
						if (!client.destroyed && client.writable) {
							client.write(
								`${JSON.stringify({
									type: "a2a_response",
									id: req.id,
									ok: false,
									error: String(err),
								})}\n`,
							);
							client.end();
						}
					} catch {
						// Ignore
					}
				});
				return true;
			}
		}

		return true;
	}

	stop(): void {
		for (const client of this.activeClients) {
			try {
				client.destroy();
			} catch {
				// Ignore
			}
		}
		this.activeClients.clear();
		this.pendingA2AClients = [];
		if (this.server) {
			try {
				this.server.close();
			} catch {
				// Ignore
			}
			this.server = null;
		}
		// Only remove .woodchipper/peer.sock if it points to this instance's socketPath
		try {
			const symlinkPath = path.join(this.cwd, ".woodchipper", "peer.sock");
			const lstat = fs.lstatSync(symlinkPath);
			if (lstat.isSymbolicLink() && fs.readlinkSync(symlinkPath) === this.socketPath) {
				fs.rmSync(symlinkPath, { force: true });
			}
		} catch {
			// Ignore if symlink doesn't exist
		}
		for (const file of [this.socketPath, this.sessionFilePath, this.keyFilePath]) {
			try {
				fs.rmSync(file, { force: true });
			} catch {
				// Ignore
			}
		}
	}
}
