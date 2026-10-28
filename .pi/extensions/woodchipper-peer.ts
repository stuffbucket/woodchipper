/**
 * Woodchipper Claude Code Peer (`peerProtocol: 1`) & A2A Bridge Extension
 *
 * Registers the running Woodchipper Pi harness in `~/.claude/sessions/<pid>.json`
 * and listens on `/tmp/cc-socks/<pid>.sock` so that:
 * 1. Any local Claude Code instance sees `woodchipper` in `ListAgents` and can
 *    drive it via `SendMessage({ to: "woodchipper", message: "..." })`.
 * 2. A human can simultaneously watch and steer the same interactive Pi TUI session.
 * 3. `scripts/woodchipper-ctl.mjs` (or any A2A client) can query status, ledger,
 *    or send synchronous/asynchronous prompts over the Unix Domain Socket.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EvidenceLedger } from "./lib/evidence-ledger.ts";
import {
	listLiveClaudePeers,
	sanitizePeerName,
	sendClaudePeerMessage,
	WoodchipperPeerServer,
} from "./lib/peer-protocol.ts";
import { Type } from "./lib/schema.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, "../..");

export function resolveProjectRoot(): string {
	return process.env.WOODCHIPPER_PROJECT_ROOT || DEFAULT_PROJECT_ROOT;
}

export default function woodchipperPeerExtension(pi: ExtensionAPI): void {
	const projectRoot = resolveProjectRoot();
	const ledger = new EvidenceLedger(projectRoot);
	let peerServer: WoodchipperPeerServer | null = null;
	let latestFlowSnapshot: Record<string, unknown> | null = null;

	const bus = (pi as unknown as { events?: { on?: (ev: string, fn: (data: any) => void) => void; emit?: (ev: string, data: unknown) => void } }).events;
	bus?.on?.("flow:state", (evt: { state?: string; summary?: string; snapshot?: Record<string, unknown> } | undefined) => {
		if (evt?.snapshot) {
			latestFlowSnapshot = evt.snapshot;
		}
		if (evt?.state === "POLLING" || evt?.state === "SPAWNING") {
			peerServer?.setBusy();
		} else if (evt?.state === "IDLE" && evt?.summary) {
			void peerServer?.setIdleAndNotify(evt.summary);
		}
	});

	pi.registerFlag("peer-name", {
		description: "Custom peer name registered in ~/.claude/sessions for Claude Code ListAgents/SendMessage",
		type: "string",
	});

	pi.registerFlag("no-peer", {
		description: "Disable registering a Claude Code peer socket in ~/.claude/sessions",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (_event, ctx) => {
		const flowDepth = Number.parseInt(String(process.env.PI_FLOW_DEPTH || "0"), 10);
		const noPeer =
			Boolean(pi.getFlag("no-peer")) ||
			process.env.WOODCHIPPER_NO_PEER === "1" ||
			(Number.isFinite(flowDepth) && flowDepth > 0);
		if (noPeer) return;

		const flagName = typeof pi.getFlag("peer-name") === "string" ? (pi.getFlag("peer-name") as string).trim() : "";
		const configuredName = sanitizePeerName(
			flagName || pi.getSessionName() || process.env.WOODCHIPPER_PEER_NAME || "woodchipper",
		);

		pi.setSessionName(configuredName);

		peerServer = new WoodchipperPeerServer({
			name: configuredName,
			cwd: ctx?.cwd || projectRoot,
			callbacks: {
				onPrompt: async (inbound) => {
					const label = inbound.senderLabel || "peer";
					const pidPart = inbound.senderPid ? ` (pid ${inbound.senderPid})` : "";
					const replyPart = inbound.isReply ? " [reply]" : "";
					const prefix = `[Peer request from ${label}${pidPart}${replyPart}]\n`;
					pi.sendUserMessage(`${prefix}${inbound.text}`, {
						deliverAs: inbound.priority === "now" ? "steer" : "followUp",
						expandPromptTemplates: false,
					});
				},
				onRename: (newName) => {
					pi.setSessionName(newName);
				},
				getStatus: () => {
					ledger.reload();
					return {
						cwd: ctx?.cwd || projectRoot,
						ledgerCounts: ledger.getCounts(),
						...(latestFlowSnapshot ? { flow: latestFlowSnapshot } : {}),
					};
				},
				getLedgerSummary: () => {
					ledger.reload();
					return {
						counts: ledger.getCounts(),
						markdown: ledger.formatMarkdownReport(),
					};
				},
				getFlowStatus: () => {
					bus?.emit?.("flow:cmd:status", {
						reply: (snap: Record<string, unknown>) => {
							latestFlowSnapshot = snap;
						},
					});
					return latestFlowSnapshot;
				},
				onFlowHalt: (summary?: string) => {
					bus?.emit?.("flow:cmd:halt", { summary: summary || "Halted via A2A control signal." });
					return latestFlowSnapshot;
				},
			},
		});

		try {
			await peerServer.start();
		} catch (err) {
			if (ctx?.hasUI) {
				ctx.ui.notify(`Woodchipper peer socket disabled: ${String(err)}`, "warning");
			}
			peerServer = null;
		}
	});

	const cleanup = () => {
		if (peerServer) {
			peerServer.stop();
			peerServer = null;
		}
	};

	pi.on("session_shutdown", async () => {
		cleanup();
	});

	process.once("exit", cleanup);

	pi.on("agent_start", async () => {
		peerServer?.setBusy();
	});

	pi.on("turn_start", async () => {
		peerServer?.setBusy();
	});

	pi.on("message_end", async (event) => {
		const msg = (event as unknown as { message?: { role?: string; content?: unknown } }).message;
		if (msg && msg.role === "assistant") {
			if (typeof msg.content === "string") {
				peerServer?.recordAssistantText(msg.content);
			} else if (Array.isArray(msg.content)) {
				const textParts = msg.content
					.filter(
						(c): c is { type: string; text: string } =>
							Boolean(
								c &&
									typeof c === "object" &&
									(c as { type?: string }).type === "text" &&
									typeof (c as { text?: string }).text === "string",
							),
					)
					.map((c) => c.text)
					.join("\n");
				if (textParts) {
					peerServer?.recordAssistantText(textParts);
				}
			}
		}
	});

	pi.on("agent_settled", async (event) => {
		const aborted = Boolean((event as unknown as { aborted?: boolean })?.aborted);
		const flowState = (latestFlowSnapshot as { state?: string } | null)?.state;
		if (!aborted && (flowState === "POLLING" || flowState === "SPAWNING")) {
			return;
		}
		await peerServer?.setIdleAndNotify(undefined, { aborted });
	});

	// Register `claude_peers` tool so Woodchipper can discover and message other local Claude Code sessions
	const ClaudePeersParams = Type.Object({
		action: Type.Union(
			[
				Type.Literal("list", { description: "List all live local Claude Code and Woodchipper peer sessions" }),
				Type.Literal("send", { description: "Send a message to a live peer by name or PID" }),
			],
			{ description: "Peer action to perform" },
		),
		to: Type.Optional(Type.String({ description: "Target peer name (e.g. 'stuffbucket-ec') or PID when action='send'" })),
		message: Type.Optional(Type.String({ description: "Message text to send when action='send'" })),
		priority: Type.Optional(
			Type.Union([Type.Literal("next"), Type.Literal("later"), Type.Literal("now")], {
				description: "Delivery priority (default: 'next')",
			}),
		),
	});

	pi.registerTool({
		name: "claude_peers",
		label: "Claude Code & Woodchipper Peers (A2A)",
		description:
			"List or send cross-session messages to live local Claude Code or Woodchipper instances registered in ~/.claude/sessions via Unix Domain Sockets (peerProtocol: 1).",
		promptSnippet: "List or message live local Claude Code and Woodchipper peers over Unix Domain Sockets (peerProtocol: 1)",
		parameters: ClaudePeersParams,
		async execute(_toolCallId, rawParams) {
			const params = rawParams as {
				action: "list" | "send";
				to?: string;
				message?: string;
				priority?: "next" | "later" | "now";
			};

			const selfPid = peerServer?.pid ?? process.pid;
			const peers = listLiveClaudePeers();
			if (params.action === "list") {
				const lines = [
					"## Live Local Claude Code & Woodchipper Peers",
					"",
					...(peerServer
						? [
								`- **Self**: \`${peerServer.getName()}\` (pid \`${peerServer.pid}\`, socket \`${peerServer.socketPath}\`, status \`${peerServer.getStatus()}\`)`,
								"",
							]
						: []),
					...(peers.length === 0
						? ["_No live peer sessions found in ~/.claude/sessions._"]
						: peers.map(
								(p) =>
									`- **\`${p.name}\`** (pid \`${p.pid}\`, status \`${p.status}\`, cwd \`${p.cwd}\`, socket \`${p.messagingSocketPath}\`)${p.pid === selfPid ? " *(this instance)*" : ""}`,
							)),
				];
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { peers },
				};
			}

			if (!params.to || !params.message) {
				return {
					isError: true,
					content: [{ type: "text", text: "Both `to` and `message` are required when action='send'." }],
					details: { error: "missing_parameters" },
				};
			}

			const otherPeers = peers.filter((p) => p.pid !== selfPid);
			const target = otherPeers.find((p) => p.name === params.to || String(p.pid) === params.to);
			if (!target) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Peer '${params.to}' not found (excluding self pid ${selfPid}). Live other peers: ${otherPeers.map((p) => `${p.name} (${p.pid})`).join(", ") || "none"}`,
						},
					],
					details: { error: "peer_not_found", available: otherPeers.map((p) => ({ name: p.name, pid: p.pid })) },
				};
			}

			await sendClaudePeerMessage({
				target,
				message: params.message,
				senderPid: selfPid,
				senderName: peerServer?.getName() ?? "woodchipper",
				senderSessionId: peerServer?.sessionId ?? "woodchipper-session",
				senderSocketPath: peerServer?.socketPath,
				senderCwd: projectRoot,
				priority: params.priority || "next",
			});

			return {
				content: [
					{
						type: "text",
						text: `Delivered cross-session message to \`${target.name}\` (pid ${target.pid}) at ${target.messagingSocketPath}.`,
					},
				],
				details: { deliveredTo: { name: target.name, pid: target.pid, socket: target.messagingSocketPath } },
			};
		},
	});

	pi.registerCommand("peers", {
		description: "List live local Claude Code & Woodchipper peer sessions (or send: /peers send <name> <msg>)",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const selfPid = peerServer?.pid ?? process.pid;
			const peers = listLiveClaudePeers();
			const otherPeers = peers.filter((p) => p.pid !== selfPid);
			if (trimmed.startsWith("send ")) {
				const rest = trimmed.slice(5).trim();
				const firstSpace = rest.indexOf(" ");
				if (firstSpace > 0) {
					const to = rest.slice(0, firstSpace).trim();
					const message = rest.slice(firstSpace + 1).trim();
					const target = otherPeers.find((p) => p.name === to || String(p.pid) === to);
					if (target) {
						await sendClaudePeerMessage({
							target,
							message,
							senderPid: selfPid,
							senderName: peerServer?.getName() ?? "woodchipper",
							senderSessionId: peerServer?.sessionId ?? "woodchipper-session",
							senderSocketPath: peerServer?.socketPath,
							senderCwd: projectRoot,
						});
						ctx.ui.notify(`Sent message to ${target.name} (pid ${target.pid})`, "info");
						return;
					}
				}
			}
			const summary = peers.map((p) => `${p.name} (pid ${p.pid}, ${p.status})`).join(", ") || "none";
			ctx.ui.notify(`Live peers: ${summary}`, "info");
		},
	});
}
