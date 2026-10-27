/**
 * Woodchipper Maximal Preferred Model Provider Extension (`.pi/extensions/woodchipper-maximal.ts`)
 *
 * Registers the local `maximal` reverse-proxy (`http://127.0.0.1:4141`) as Woodchipper's
 * preferred model provider (`maximal`) using Maximal's native `/v1/messages` (`anthropic-messages`)
 * and `/v1/models` endpoints.
 *
 * Features:
 * 1. Automatic model discovery from `http://127.0.0.1:4141/v1/models` (`anthropic-version: 2023-06-01`)
 *    with token limits, image input capabilities, and adaptive thinking enabled (`forceAdaptiveThinking: true`).
 * 2. Automatic API key resolution from `MAXIMAL_API_KEY`, `~/.local/share/maximal/config.json`
 *    (`auth.apiKeyEntries` / `auth.apiKeys`), or fallback `"maximal-local"`.
 * 3. Offline/startup resilience via a complete static model catalog when Maximal is not yet reachable,
 *    plus dynamic refresh via `refreshModels` and `/maximal refresh`.
 * 4. `/maximal` slash command (`status`, `models`, `refresh`, `use <model-id>`) and `woodchipper_maximal`
 *    inspection tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAXIMAL_MODEL,
	fetchMaximalModels,
	isCyberPolicyRefusalOrBlock,
	MAXIMAL_FAILOVER_CHAIN,
	MAXIMAL_PROVIDER_NAME,
	normalizeMaximalBaseUrl,
	type PiProviderModelConfig,
	probeMaximalProvider,
	resolveMaximalApiKey,
	selectNextFallbackModel,
} from "./lib/maximal-provider.ts";
import { Type } from "./lib/schema.ts";

export interface WoodchipperMaximalOptions {
	baseUrl?: string;
	apiKey?: string;
	fetchImpl?: typeof fetch;
	env?: NodeJS.ProcessEnv;
}

export function formatMaximalStatusReport(params: {
	baseUrl: string;
	reachable: boolean;
	source: "live" | "fallback";
	apiKeySource: string;
	clientName?: string;
	activeProvider?: string;
	activeModel?: string;
	serviceVersion?: string;
	copilotReady?: boolean;
	copilotAccountType?: string;
	models: readonly PiProviderModelConfig[];
	error?: string;
}): string {
	const lines: string[] = [
		"## Maximal Provider Status (`maximal`)",
		`- **Endpoint:** \`${params.baseUrl}\` (${params.reachable ? "ONLINE" : "OFFLINE — using fallback catalog"})`,
		`- **Catalog Source:** \`${params.source}\` (${params.models.length} chat models registered)`,
		`- **Default Preferred Model:** \`${MAXIMAL_PROVIDER_NAME}/${DEFAULT_MAXIMAL_MODEL}\``,
		`- **Active Session Model:** \`${params.activeProvider && params.activeModel ? `${params.activeProvider}/${params.activeModel}` : "none"}\``,
		`- **Auth Key Source:** \`${params.apiKeySource}\`${params.clientName ? ` (client: \`${params.clientName}\`)` : ""}`,
	];

	if (params.serviceVersion) {
		lines.push(
			`- **Maximal Service:** \`v${params.serviceVersion}\` (Copilot ready: \`${Boolean(params.copilotReady)}\`${params.copilotAccountType ? `, account: \`${params.copilotAccountType}\`` : ""})`,
		);
	}
	if (params.error) {
		lines.push(`- **Last Probe Note:** ${params.error}`);
	}

	lines.push("", "### Available Maximal Models", "| Model ID | Display Name | Context | Max Output | Thinking | Vision |", "| :--- | :--- | :--- | :--- | :--- | :--- |");
	for (const m of params.models) {
		lines.push(
			`| \`${m.id}\` | ${m.name} | ${m.contextWindow.toLocaleString()} | ${m.maxTokens.toLocaleString()} | ${m.reasoning ? "yes" : "no"} | ${m.input.includes("image") ? "yes" : "no"} |`,
		);
	}

	return lines.join("\n");
}

export default async function woodchipperMaximalExtension(
	pi: ExtensionAPI,
	options: WoodchipperMaximalOptions = {},
): Promise<void> {
	const env = options.env ?? process.env;

	pi.registerFlag("maximal-url", {
		description: "Custom Maximal proxy base URL (default: http://127.0.0.1:4141)",
		type: "string",
	});

	pi.registerFlag("no-maximal", {
		description: "Disable registering the Maximal model provider extension",
		type: "boolean",
		default: false,
	});

	if (env.WOODCHIPPER_NO_MAXIMAL === "1") {
		return;
	}

	let currentBaseUrl = normalizeMaximalBaseUrl(options.baseUrl, { env });
	const resolvedAuth = options.apiKey
		? { apiKey: options.apiKey, source: "env" as const }
		: resolveMaximalApiKey({ env });

	let lastProbe = await probeMaximalProvider({
		baseUrl: currentBaseUrl,
		apiKey: resolvedAuth.apiKey,
		fetchImpl: options.fetchImpl,
		env,
	});

	const registerWithPi = (baseUrl: string, models: PiProviderModelConfig[]) => {
		if (typeof pi.registerProvider !== "function") return;
		pi.registerProvider(MAXIMAL_PROVIDER_NAME, {
			baseUrl,
			apiKey: resolvedAuth.apiKey,
			api: "anthropic-messages",
			models,
			refreshModels: async () => {
				const fresh = await fetchMaximalModels({
					baseUrl,
					apiKey: resolvedAuth.apiKey,
					fetchImpl: options.fetchImpl,
				});
				lastProbe = {
					...lastProbe,
					reachable: true,
					baseUrl,
					models: fresh,
					source: "live",
					error: undefined,
				};
				return fresh;
			},
		});
	};

	registerWithPi(currentBaseUrl, lastProbe.models);

	// Track last user prompt and attempted failover models for automatic cyber-policy refusal resilience
	let lastUserPromptText = "";
	let activeModelId: string = DEFAULT_MAXIMAL_MODEL;
	const attemptedFailoverModels = new Set<string>();

	pi.on("before_agent_start", async (event) => {
		if (event.messageType === "user" && typeof event.prompt === "string" && event.prompt.trim()) {
			if (event.prompt.trim() !== lastUserPromptText) {
				lastUserPromptText = event.prompt.trim();
				attemptedFailoverModels.clear();
			}
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (env.WOODCHIPPER_DISABLE_MODEL_FAILOVER === "1") return;
		const messages = Array.isArray(event.messages) ? event.messages : [];
		if (messages.length === 0) return;

		const lastMsg = messages[messages.length - 1] as {
			role?: string;
			model?: string;
			stopReason?: string;
			errorMessage?: string;
			content?: Array<{ type?: string; text?: string }>;
		};
		const check = isCyberPolicyRefusalOrBlock(lastMsg);
		if (!check.refused) return;

		const currentId = lastMsg.model || ctx?.model?.id || activeModelId;
		if (currentId) {
			attemptedFailoverModels.add(currentId);
		}

		const fallback = selectNextFallbackModel(currentId, attemptedFailoverModels, lastProbe.models);
		if (!fallback) return;

		attemptedFailoverModels.add(fallback.id);
		activeModelId = fallback.id;

		const registryModel =
			ctx?.modelRegistry?.find?.(MAXIMAL_PROVIDER_NAME, fallback.id) ??
			({ provider: MAXIMAL_PROVIDER_NAME, id: fallback.id } as unknown);

		if (typeof pi.setModel === "function" && registryModel) {
			await pi.setModel(registryModel as Parameters<typeof pi.setModel>[0]);
		}

		const notice = `[woodchipper-maximal] Model '${currentId}' triggered an upstream safety/policy refusal (${check.reason ?? "refusal"}); automatically failing over to '${MAXIMAL_PROVIDER_NAME}/${fallback.id}' (chain: ${MAXIMAL_FAILOVER_CHAIN.join(" -> ")}).`;
		if (ctx?.hasUI) {
			ctx.ui.notify(notice, "warning");
		}
		pi.sendMessage(
			{
				customType: "woodchipper-maximal-failover",
				content: notice,
				display: true,
				details: {
					fromModel: currentId,
					toModel: fallback.id,
					reason: check.reason,
				},
			},
			{ triggerTurn: false },
		);

		if (lastUserPromptText && typeof pi.sendUserMessage === "function") {
			pi.sendUserMessage(lastUserPromptText);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const noMaximal = Boolean(pi.getFlag("no-maximal")) || env.WOODCHIPPER_NO_MAXIMAL === "1";
		if (noMaximal) {
			if (typeof pi.unregisterProvider === "function") {
				pi.unregisterProvider(MAXIMAL_PROVIDER_NAME);
			}
			return;
		}

		const flagUrl =
			typeof pi.getFlag("maximal-url") === "string" ? (pi.getFlag("maximal-url") as string).trim() : "";
		if (flagUrl) {
			try {
				const normalizedFlagUrl = normalizeMaximalBaseUrl(flagUrl, { env });
				if (normalizedFlagUrl !== currentBaseUrl) {
					currentBaseUrl = normalizedFlagUrl;
					lastProbe = await probeMaximalProvider({
						baseUrl: currentBaseUrl,
						apiKey: resolvedAuth.apiKey,
						fetchImpl: options.fetchImpl,
						env,
					});
					registerWithPi(currentBaseUrl, lastProbe.models);
				}
			} catch (err) {
				if (ctx?.hasUI) {
					ctx.ui.notify(
						`Invalid --maximal-url '${flagUrl}': ${err instanceof Error ? err.message : String(err)}`,
						"warning",
					);
				}
			}
		}
	});

	pi.registerTool({
		name: "woodchipper_maximal",
		label: "Woodchipper Maximal Provider",
		description:
			"Inspect or refresh the local Maximal model provider on localhost:4141 (status, Copilot readiness, and available reasoning/chat models).",
		promptSnippet:
			"woodchipper_maximal: Check status or refresh models from the local Maximal proxy on localhost:4141",
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union([Type.Literal("status"), Type.Literal("models"), Type.Literal("refresh")], {
					description: "Action to perform (default: status)",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action || "status";
			lastProbe = await probeMaximalProvider({
				baseUrl: currentBaseUrl,
				apiKey: resolvedAuth.apiKey,
				fetchImpl: options.fetchImpl,
				env,
			});

			if (action === "refresh" && lastProbe.source === "live") {
				registerWithPi(currentBaseUrl, lastProbe.models);
			}

			const report = formatMaximalStatusReport({
				baseUrl: currentBaseUrl,
				reachable: lastProbe.reachable,
				source: lastProbe.source,
				apiKeySource: resolvedAuth.source,
				clientName: resolvedAuth.clientName,
				activeProvider: ctx?.model?.provider,
				activeModel: ctx?.model?.id,
				serviceVersion: lastProbe.status?.version,
				copilotReady: lastProbe.status?.subsystems?.copilot?.ready,
				copilotAccountType: lastProbe.status?.subsystems?.copilot?.account_type,
				models: lastProbe.models,
				error: lastProbe.error,
			});

			return {
				content: [{ type: "text" as const, text: report }],
				details: {
					provider: MAXIMAL_PROVIDER_NAME,
					baseUrl: currentBaseUrl,
					reachable: lastProbe.reachable,
					source: lastProbe.source,
					defaultModel: DEFAULT_MAXIMAL_MODEL,
					modelCount: lastProbe.models.length,
					models: lastProbe.models.map((m) => m.id),
					status: lastProbe.status,
				},
			};
		},
	});

	pi.registerCommand("maximal", {
		description:
			"Inspect, refresh, or switch models on the local Maximal provider (/maximal [status|models|refresh|use <model-id>])",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const sub = (tokens[0] || "status").toLowerCase();

			if (sub === "use" || sub === "model") {
				const requestedModelId = tokens[1] || DEFAULT_MAXIMAL_MODEL;
				const targetModel =
					ctx?.modelRegistry?.find?.(MAXIMAL_PROVIDER_NAME, requestedModelId) ??
					lastProbe.models.find((m) => m.id === requestedModelId);

				if (!targetModel) {
					const msg = `Model '${requestedModelId}' not found on provider '${MAXIMAL_PROVIDER_NAME}'. Run '/maximal models' to see available IDs.`;
					if (ctx?.hasUI) {
						ctx.ui.notify(msg, "warning");
					}
					return;
				}

				if (typeof pi.setModel === "function" && ctx?.modelRegistry?.find) {
					const registryModel = ctx.modelRegistry.find(MAXIMAL_PROVIDER_NAME, requestedModelId);
					if (registryModel) {
						await pi.setModel(registryModel);
						if (ctx?.hasUI) {
							ctx.ui.notify(`Switched active model to ${MAXIMAL_PROVIDER_NAME}/${requestedModelId}`, "info");
						}
						return;
					}
				}

				if (ctx?.hasUI) {
					ctx.ui.notify(`Selected ${MAXIMAL_PROVIDER_NAME}/${requestedModelId}`, "info");
				}
				return;
			}

			lastProbe = await probeMaximalProvider({
				baseUrl: currentBaseUrl,
				apiKey: resolvedAuth.apiKey,
				fetchImpl: options.fetchImpl,
				env,
			});

			if (sub === "refresh") {
				registerWithPi(currentBaseUrl, lastProbe.models);
			}

			const report = formatMaximalStatusReport({
				baseUrl: currentBaseUrl,
				reachable: lastProbe.reachable,
				source: lastProbe.source,
				apiKeySource: resolvedAuth.source,
				clientName: resolvedAuth.clientName,
				activeProvider: ctx?.model?.provider,
				activeModel: ctx?.model?.id,
				serviceVersion: lastProbe.status?.version,
				copilotReady: lastProbe.status?.subsystems?.copilot?.ready,
				copilotAccountType: lastProbe.status?.subsystems?.copilot?.account_type,
				models: lastProbe.models,
				error: lastProbe.error,
			});

			if (ctx?.hasUI) {
				ctx.ui.notify(
					`Maximal (${currentBaseUrl}): ${lastProbe.reachable ? "ONLINE" : "OFFLINE"} — ${lastProbe.models.length} models (${lastProbe.source})`,
					lastProbe.reachable ? "info" : "warning",
				);
			}
			pi.sendMessage(
				{
					customType: "woodchipper-maximal-status",
					content: report,
					display: true,
				},
				{ triggerTurn: false },
			);
		},
	});
}
