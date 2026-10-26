#!/usr/bin/env node
/**
 * Woodchipper Peer & A2A Control CLI (`scripts/woodchipper-ctl.mjs`)
 *
 * Inspects and drives local Woodchipper and Claude Code peer sessions over
 * `~/.claude/sessions/<pid>.json` and `/tmp/cc-socks/<pid>.sock`.
 *
 * Commands:
 *   woodchipper-ctl peers                           List all live Claude Code & Woodchipper peers
 *   woodchipper-ctl status [peer-name-or-pid]       Query a running Woodchipper peer's status & ledger counts
 *   woodchipper-ctl ledger [peer-name-or-pid]       Fetch the 3-bucket Evidence Ledger from a running Woodchipper peer
 *   woodchipper-ctl send <peer> <msg> [--wait]      Send a prompt to a Woodchipper or Claude Code peer
 */

import * as crypto from "node:crypto";
import {
	listLiveClaudePeers,
	sendClaudePeerMessage,
	sendFrameToPeerSocket,
} from "../.pi/extensions/lib/peer-protocol.ts";

export function findPeer(nameOrPid = "woodchipper", peers = listLiveClaudePeers()) {
	return peers.find((p) => p.name === nameOrPid || String(p.pid) === nameOrPid);
}

export function safeParseJsonFrame(raw) {
	if (!raw || typeof raw !== "string") return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

async function main() {
	const argv = process.argv.slice(2);
	const cmd = argv[0] || "peers";

	if (cmd === "peers" || cmd === "list") {
		const peers = listLiveClaudePeers();
		if (argv.includes("--json")) {
			console.log(JSON.stringify(peers, null, 2));
			return;
		}
		if (peers.length === 0) {
			console.log("No live Claude Code or Woodchipper peers found in ~/.claude/sessions.");
			return;
		}
		console.log("Live Local Peers (~/.claude/sessions):");
		for (const p of peers) {
			console.log(
				`  - ${p.name.padEnd(20)} pid=${String(p.pid).padEnd(7)} status=${p.status.padEnd(6)} socket=${p.messagingSocketPath} cwd=${p.cwd}`,
			);
		}
		return;
	}

	if (cmd === "status") {
		const targetName = argv[1] && !argv[1].startsWith("--") ? argv[1] : "woodchipper";
		const peer = findPeer(targetName);
		if (!peer) {
			console.error(`No live peer matching '${targetName}' found.`);
			process.exit(1);
		}
		const raw = await sendFrameToPeerSocket(
			peer.messagingSocketPath,
			{ type: "a2a", id: crypto.randomUUID(), action: "status" },
			{ targetPid: peer.pid, timeoutMs: 5000 },
		);
		const parsed = safeParseJsonFrame(raw);
		console.log(parsed ? JSON.stringify(parsed, null, 2) : JSON.stringify(peer, null, 2));
		return;
	}

	if (cmd === "ledger") {
		const targetName = argv[1] && !argv[1].startsWith("--") ? argv[1] : "woodchipper";
		const peer = findPeer(targetName);
		if (!peer) {
			console.error(`No live peer matching '${targetName}' found.`);
			process.exit(1);
		}
		const raw = await sendFrameToPeerSocket(
			peer.messagingSocketPath,
			{ type: "a2a", id: crypto.randomUUID(), action: "ledger" },
			{ targetPid: peer.pid, timeoutMs: 5000 },
		);
		const parsed = safeParseJsonFrame(raw);
		if (!parsed) {
			console.error(`Peer '${targetName}' did not return a valid ledger response.`);
			process.exit(1);
		}
		if (argv.includes("--json")) {
			console.log(JSON.stringify(parsed, null, 2));
		} else {
			console.log(parsed.ledger?.markdown || JSON.stringify(parsed, null, 2));
		}
		return;
	}

	if (cmd === "send" || cmd === "ask" || cmd === "steer") {
		const flags = new Set(argv.filter((a) => a.startsWith("--")));
		const positional = argv.slice(1).filter((a) => !a.startsWith("--"));
		const targetName = positional[0];
		const message = positional.slice(1).join(" ").trim();
		if (!targetName || !message) {
			console.error("Usage: woodchipper-ctl send <peer-name-or-pid> <message> [--wait] [--steer]");
			process.exit(1);
		}
		const peer = findPeer(targetName);
		if (!peer) {
			console.error(`No live peer matching '${targetName}' found.`);
			process.exit(1);
		}

		const waitForReply = flags.has("--wait") || cmd === "ask";
		const isSteer = flags.has("--steer") || cmd === "steer";

		if (waitForReply) {
			const raw = await sendFrameToPeerSocket(
				peer.messagingSocketPath,
				{
					type: "a2a",
					id: crypto.randomUUID(),
					action: isSteer ? "steer" : "prompt",
					message,
				},
				{ targetPid: peer.pid, timeoutMs: 300000 },
			);
			const parsed = safeParseJsonFrame(raw);
			if (parsed) {
				if (flags.has("--json")) {
					console.log(JSON.stringify(parsed, null, 2));
				} else {
					console.log(parsed.reply ?? raw);
				}
			} else {
				console.log(raw);
			}
			return;
		}

		await sendClaudePeerMessage({
			target: peer,
			message,
			senderName: "woodchipper-ctl",
			priority: isSteer ? "now" : "next",
		});
		console.log(`Sent message to ${peer.name} (pid ${peer.pid}) at ${peer.messagingSocketPath}`);
		return;
	}

	console.error(`Unknown command '${cmd}'. Supported commands: peers, status, ledger, send, ask, steer`);
	process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("woodchipper-ctl.mjs")) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
