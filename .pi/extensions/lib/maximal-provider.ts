/**
 * Woodchipper Maximal Provider Library (`.pi/extensions/lib/maximal-provider.ts`)
 *
 * Connects the Woodchipper Pi harness (interactive TUI, headless A2A daemon, RPC, and one-shot CLI)
 * to a local `maximal` reverse-proxy instance on `http://127.0.0.1:4141`.
 *
 * Key responsibilities:
 * 1. Loopback-safe base URL normalization (`http://127.0.0.1:4141` by default; blocks unencrypted
 *    non-loopback HTTP unless explicitly permitted).
 * 2. Automatic API key resolution from `MAXIMAL_API_KEY`, `~/.local/share/maximal/config.json`
 *    (`auth.apiKeyEntries` / `auth.apiKeys`), or fallback `"maximal-local"`.
 * 3. Live model catalog discovery via `GET /v1/models` with `anthropic-version: 2023-06-01`
 *    (filtering out embedding-only models and preserving token limits, vision support, and
 *    adaptive-thinking capabilities), with a static fallback catalog when offline.
 * 4. Health/status probing via `GET /status`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MAXIMAL_PROVIDER_NAME = "maximal";
export const DEFAULT_MAXIMAL_BASE_URL = "http://127.0.0.1:4141";
export const DEFAULT_MAXIMAL_MODEL = "claude-sonnet-5-5-20260301";
export const DEFAULT_MAXIMAL_API_KEY_FALLBACK = "maximal-local";
export const ANTHROPIC_API_VERSION = "2023-06-01";

/**
 * Preferred model priority order for Woodchipper reverse-engineering workloads.
 */
export const PREFERRED_MAXIMAL_MODEL_ORDER: readonly string[] = [
	"claude-sonnet-5-5-20260301",
	"claude-opus-5-5-20260301",
	"gpt-5.3-codex",
	"gpt-6",
	"gemini-4-argon",
	"claude-haiku-5-5-20260301",
	"claude-sonnet-5",
	"gpt-6-mini",
	"grok-4.6",
	"grok-4.7",
	"gemini-3.8-flash",
];

/**
 * Ordered resilient fallback chain when an upstream model endpoint triggers a
 * false-positive cyber-policy refusal or safety block on authorized reverse-engineering context.
 */
export const MAXIMAL_FAILOVER_CHAIN: readonly string[] = [
	"claude-sonnet-5-5-20260301",
	"gemini-4-argon",
	"gpt-5.3-codex",
	"gpt-6",
	"claude-haiku-5-5-20260301",
];

const CYBER_POLICY_ERROR_REGEX =
	/\b(policy|safety|content_filter|cyber|refusal|cannot assist with|can't assist with|violates our usage|security guidelines|invalid_request_error|responsible ai)\b/i;

const ASSISTANT_REFUSAL_TEXT_REGEX =
	/\b(i cannot assist with|i can't assist with|i'm sorry,?\s+but i can't|i am unable to assist with|cannot help with reverse engineering|cannot help with analyzing|cannot fulfill this request|against my safety guidelines|violates usage policies)\b/i;

/**
 * Detect whether an assistant turn ended due to an upstream cyber-policy / safety refusal
 * (either as an API error or a zero-tool-call refusal response).
 */
export function isCyberPolicyRefusalOrBlock(assistantMessage: unknown): {
	refused: boolean;
	reason?: string;
} {
	if (!assistantMessage || typeof assistantMessage !== "object") {
		return { refused: false };
	}
	const msg = assistantMessage as {
		role?: string;
		stopReason?: string;
		errorMessage?: string;
		content?: Array<{ type?: string; text?: string }>;
	};
	if (msg.role && msg.role !== "assistant") {
		return { refused: false };
	}

	if (msg.stopReason === "error" && typeof msg.errorMessage === "string") {
		if (CYBER_POLICY_ERROR_REGEX.test(msg.errorMessage)) {
			return {
				refused: true,
				reason: `Upstream API error: ${msg.errorMessage.slice(0, 200)}`,
			};
		}
	}

	const content = Array.isArray(msg.content) ? msg.content : [];
	const hasToolUse = content.some((part) => part?.type === "toolCall" || part?.type === "tool_use");
	if (hasToolUse) {
		return { refused: false };
	}

	const textCombined = content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text ?? "")
		.join("\n")
		.trim();

	if (msg.stopReason === "refusal") {
		return {
			refused: true,
			reason: textCombined ? `Model refusal: ${textCombined.slice(0, 160)}` : "Model stopReason=refusal",
		};
	}

	if (textCombined.length > 0 && textCombined.length <= 600 && ASSISTANT_REFUSAL_TEXT_REGEX.test(textCombined)) {
		return {
			refused: true,
			reason: `Refusal response: ${textCombined.slice(0, 160)}`,
		};
	}

	return { refused: false };
}

/**
 * Select the next fallback model from `MAXIMAL_FAILOVER_CHAIN` that has not yet been
 * attempted for the current prompt.
 */
export function selectNextFallbackModel(
	currentModelId: string | undefined,
	attemptedModels: ReadonlySet<string>,
	availableModels: readonly PiProviderModelConfig[],
): PiProviderModelConfig | undefined {
	const availableMap = new Map(availableModels.map((m) => [m.id, m]));
	for (const candidateId of MAXIMAL_FAILOVER_CHAIN) {
		if (candidateId === currentModelId) continue;
		if (attemptedModels.has(candidateId)) continue;
		const found = availableMap.get(candidateId);
		if (found) return found;
	}
	return undefined;
}

export interface MaximalAnthropicModelWire {
	id: string;
	type?: string;
	display_name?: string;
	created_at?: string | null;
	max_input_tokens?: number | null;
	max_tokens?: number | null;
	capabilities?: {
		batch?: { supported?: boolean };
		citations?: { supported?: boolean };
		code_execution?: { supported?: boolean };
		context_management?: Record<string, unknown>;
		effort?: Record<string, unknown>;
		image_input?: { supported?: boolean };
		pdf_input?: { supported?: boolean };
		structured_outputs?: { supported?: boolean };
		thinking?: {
			supported?: boolean;
			types?: {
				adaptive?: { supported?: boolean };
				enabled?: { supported?: boolean };
			};
		};
	} | null;
}

export interface MaximalStatusResponse {
	service?: string;
	status?: string;
	version?: string;
	uptime_ms?: number;
	subsystems?: {
		copilot?: {
			authenticated?: boolean;
			ready?: boolean;
			account_type?: string;
		};
		models?: {
			cached?: number;
		};
	};
}

export interface PiProviderModelConfig {
	id: string;
	name: string;
	api: "anthropic-messages";
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	compat?: {
		forceAdaptiveThinking?: boolean;
		supportsMidConvoSystemMessages?: boolean;
	};
}

export interface MaximalApiKeyResolution {
	apiKey: string;
	source: "env" | "config-entry" | "config-legacy" | "fallback";
	clientName?: string;
}

export interface MaximalProbeResult {
	reachable: boolean;
	baseUrl: string;
	status: MaximalStatusResponse | null;
	models: PiProviderModelConfig[];
	source: "live" | "fallback";
	error?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Fallback static model catalog matching Maximal's `/v1/models` inventory so Pi
 * can resolve `maximal/claude-opus-5-5-20260301` even when `PI_OFFLINE=1` or before
 * Maximal finishes starting up.
 */
export const FALLBACK_MAXIMAL_WIRE_MODELS: readonly MaximalAnthropicModelWire[] = [
	{
		id: "claude-opus-5-5-20260301",
		display_name: "Claude Opus 4.6",
		max_input_tokens: 200000,
		max_tokens: 64000,
		capabilities: {
			image_input: { supported: true },
			pdf_input: { supported: true },
			structured_outputs: { supported: true },
			thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } },
		},
	},
	{
		id: "claude-sonnet-5-5-20260301",
		display_name: "Claude Sonnet 4.6",
		max_input_tokens: 200000,
		max_tokens: 64000,
		capabilities: {
			image_input: { supported: true },
			pdf_input: { supported: true },
			structured_outputs: { supported: true },
			thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } },
		},
	},
	{
		id: "claude-haiku-5-5-20260301",
		display_name: "Claude Haiku 4.5",
		max_input_tokens: 128000,
		max_tokens: 32000,
		capabilities: {
			image_input: { supported: true },
			pdf_input: { supported: true },
			structured_outputs: { supported: true },
			thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } },
		},
	},
	{
		id: "claude-sonnet-5",
		display_name: "Claude Sonnet 4",
		max_input_tokens: 128000,
		max_tokens: 16000,
		capabilities: {
			image_input: { supported: true },
			pdf_input: { supported: true },
			structured_outputs: { supported: false },
			thinking: { supported: false },
		},
	},
	{
		id: "gpt-6",
		display_name: "GPT-5.4",
		max_input_tokens: 272000,
		max_tokens: 128000,
		capabilities: {
			image_input: { supported: true },
			pdf_input: { supported: false },
			structured_outputs: { supported: true },
			thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } },
		},
	},
	{
		id: "gpt-5.3-codex",
		display_name: "GPT-5.3-Codex",
		max_input_tokens: 272000,
		max_tokens: 128000,
		capabilities: {
			image_input: { supported: true },
			pdf_input: { supported: false },
			structured_outputs: { supported: true },
			thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } },
		},
	},
	{
		id: "gemini-4-argon",
		display_name: "Gemini 3.1 Pro (Preview)",
		max_input_tokens: 128000,
		max_tokens: 64000,
		capabilities: {
			image_input: { supported: true },
			pdf_input: { supported: false },
			structured_outputs: { supported: false },
			thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } },
		},
	},
	{
		id: "gemini-3.8-flash",
		display_name: "Gemini 3 Flash (Preview)",
		max_input_tokens: 128000,
		max_tokens: 64000,
		capabilities: {
			image_input: { supported: true },
			pdf_input: { supported: false },
			structured_outputs: { supported: false },
			thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } },
		},
	},
	{
		id: "gpt-6-mini",
		display_name: "GPT-5.4 mini",
		max_input_tokens: 272000,
		max_tokens: 128000,
		capabilities: {
			image_input: { supported: true },
			pdf_input: { supported: false },
			structured_outputs: { supported: true },
			thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } },
		},
	},
	{
		id: "grok-4.6",
		display_name: "Grok 4.1",
		max_input_tokens: 128000,
		max_tokens: 64000,
		capabilities: {
			image_input: { supported: false },
			pdf_input: { supported: false },
			structured_outputs: { supported: false },
			thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } },
		},
	},
	{
		id: "grok-4.7",
		display_name: "Grok 4.20",
		max_input_tokens: 128000,
		max_tokens: 64000,
		capabilities: {
			image_input: { supported: true },
			pdf_input: { supported: false },
			structured_outputs: { supported: false },
			thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } },
		},
	},
];

/**
 * Normalize and validate the Maximal base URL.
 * Rejects unencrypted non-loopback `http://` targets unless `allowRemoteHttp` is enabled.
 */
export function normalizeMaximalBaseUrl(
	rawUrl?: string | null,
	options: { allowRemoteHttp?: boolean; env?: NodeJS.ProcessEnv } = {},
): string {
	const env = options.env ?? process.env;
	const candidate = (
		rawUrl ||
		env.WOODCHIPPER_MAXIMAL_URL ||
		env.MAXIMAL_BASE_URL ||
		DEFAULT_MAXIMAL_BASE_URL
	).trim();

	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		throw new Error(`Invalid Maximal base URL: '${candidate}'`);
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Unsupported Maximal URL protocol '${parsed.protocol}' (expected http: or https:)`);
	}

	const allowRemoteHttp =
		options.allowRemoteHttp === true || env.WOODCHIPPER_ALLOW_REMOTE_MAXIMAL === "1";

	if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) && !allowRemoteHttp) {
		throw new Error(
			`Refusing unencrypted non-loopback Maximal URL '${candidate}'. Use 127.0.0.1/localhost, https://, or set WOODCHIPPER_ALLOW_REMOTE_MAXIMAL=1.`,
		);
	}

	// Strip trailing slashes and accidental `/v1` suffix because @anthropic-ai/sdk appends `/v1/messages`
	let pathname = parsed.pathname.replace(/\/+$/, "");
	if (pathname === "/v1") {
		pathname = "";
	}
	parsed.pathname = pathname || "/";
	parsed.search = "";
	parsed.hash = "";

	const formatted = parsed.toString().replace(/\/+$/, "");
	return formatted;
}

/**
 * Resolve the path to Maximal's config file (`~/.local/share/maximal/config.json`).
 */
export function resolveMaximalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	if (env.MAXIMAL_CONFIG_PATH && env.MAXIMAL_CONFIG_PATH.trim()) {
		return path.resolve(env.MAXIMAL_CONFIG_PATH.trim());
	}
	const xdgDataHome = env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
	return path.join(xdgDataHome, "maximal", "config.json");
}

/**
 * Resolve the client API key to authenticate with Maximal.
 * Checks env vars first, then `~/.local/share/maximal/config.json`, then falls back to `"maximal-local"`.
 */
export function resolveMaximalApiKey(options: {
	env?: NodeJS.ProcessEnv;
	configPath?: string;
} = {}): MaximalApiKeyResolution {
	const env = options.env ?? process.env;
	const envKey = (env.WOODCHIPPER_MAXIMAL_API_KEY || env.MAXIMAL_API_KEY || "").trim();
	if (envKey) {
		return { apiKey: envKey, source: "env" };
	}

	const configPath = options.configPath || resolveMaximalConfigPath(env);
	try {
		if (fs.existsSync(configPath)) {
			const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
				auth?: {
					apiKeyEntries?: Array<{
						id?: string;
						name?: string;
						client?: string;
						key?: string;
						enabled?: boolean;
					}>;
					apiKeys?: string[];
				};
			};

			const entries = Array.isArray(raw?.auth?.apiKeyEntries)
				? raw.auth.apiKeyEntries.filter(
						(e) => e && e.enabled !== false && typeof e.key === "string" && e.key.trim().length > 0,
					)
				: [];

			if (entries.length > 0) {
				const preferredClients = ["woodchipper", "pi", "claude-code"];
				for (const target of preferredClients) {
					const matched = entries.find(
						(e) =>
							e.client?.toLowerCase() === target ||
							e.name?.toLowerCase().includes(target),
					);
					if (matched?.key) {
						return {
							apiKey: matched.key.trim(),
							source: "config-entry",
							clientName: matched.name || matched.client || target,
						};
					}
				}

				const first = entries[0];
				if (first?.key) {
					return {
						apiKey: first.key.trim(),
						source: "config-entry",
						clientName: first.name || first.client || "default",
					};
				}
			}

			const legacyKeys = Array.isArray(raw?.auth?.apiKeys)
				? raw.auth.apiKeys.filter((k) => typeof k === "string" && k.trim().length > 0)
				: [];
			if (legacyKeys.length > 0) {
				return {
					apiKey: legacyKeys[0].trim(),
					source: "config-legacy",
				};
			}
		}
	} catch {
		// Fall through to default local key if config is unreadable
	}

	return {
		apiKey: DEFAULT_MAXIMAL_API_KEY_FALLBACK,
		source: "fallback",
	};
}

/**
 * Determine whether a Maximal model ID is an embedding or non-chat model that should
 * be excluded from Pi's interactive chat/reasoning model selector.
 */
export function isEmbeddingOrNonChatModel(modelId: string): boolean {
	const lower = modelId.trim().toLowerCase();
	if (!lower) return true;
	return (
		lower.includes("embedding") ||
		lower.startsWith("text-embedding-") ||
		lower.startsWith("tts-") ||
		lower.startsWith("whisper-")
	);
}

/**
 * Infer whether a model supports reasoning/thinking when Maximal's capabilities block is absent.
 */
export function inferReasoningSupport(wire: MaximalAnthropicModelWire): boolean {
	if (typeof wire.capabilities?.thinking?.supported === "boolean") {
		return wire.capabilities.thinking.supported;
	}
	const id = wire.id.toLowerCase();
	if (id === "claude-sonnet-5" || id.startsWith("gpt-5.6")) {
		return false;
	}
	return (
		id.startsWith("claude-opus-") ||
		id.startsWith("claude-sonnet-5-5") ||
		id.startsWith("claude-haiku-5-5") ||
		id.startsWith("gpt-5") ||
		id.startsWith("gpt-6") ||
		id.startsWith("gemini-3") ||
		id.startsWith("gemini-4") ||
		id.startsWith("grok-4")
	);
}

/**
 * Convert a single Maximal `/v1/models` wire entry into a Pi `ProviderModelConfig`.
 */
export function mapWireModelToPiModel(wire: MaximalAnthropicModelWire): PiProviderModelConfig {
	const reasoning = inferReasoningSupport(wire);
	const supportsImage = wire.capabilities?.image_input?.supported !== false;
	const rawContext = typeof wire.max_input_tokens === "number" && wire.max_input_tokens > 0 ? wire.max_input_tokens : 0;
	const rawMaxOut = typeof wire.max_tokens === "number" && wire.max_tokens > 0 ? wire.max_tokens : 0;

	const contextWindow = rawContext || (rawMaxOut >= 64000 ? 200000 : 128000);
	const maxTokens = rawMaxOut || (reasoning ? 64000 : 16384);
	const baseDisplayName = (wire.display_name || wire.id).trim();
	const displayName = baseDisplayName.includes("(Maximal)")
		? baseDisplayName
		: `${baseDisplayName} (Maximal)`;

	return {
		id: wire.id,
		name: displayName,
		api: "anthropic-messages",
		reasoning,
		input: supportsImage ? ["text", "image"] : ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow,
		maxTokens,
		...(reasoning
			? {
					compat: {
						forceAdaptiveThinking: true,
					},
				}
			: {}),
	};
}

/**
 * Convert and sort a list of Maximal wire models into Pi `ProviderModelConfig` entries,
 * placing Woodchipper's preferred reverse-engineering models first.
 */
export function buildPiModelsFromWireList(
	wireModels: readonly MaximalAnthropicModelWire[],
): PiProviderModelConfig[] {
	const seen = new Set<string>();
	const filtered: PiProviderModelConfig[] = [];

	for (const item of wireModels) {
		if (!item || typeof item.id !== "string") continue;
		const id = item.id.trim();
		if (!id || seen.has(id) || isEmbeddingOrNonChatModel(id)) continue;
		seen.add(id);
		filtered.push(mapWireModelToPiModel({ ...item, id }));
	}

	const priorityIndex = new Map<string, number>(
		PREFERRED_MAXIMAL_MODEL_ORDER.map((id, idx) => [id, idx]),
	);

	filtered.sort((a, b) => {
		const pa = priorityIndex.get(a.id);
		const pb = priorityIndex.get(b.id);
		if (pa !== undefined && pb !== undefined) return pa - pb;
		if (pa !== undefined) return -1;
		if (pb !== undefined) return 1;
		return a.id.localeCompare(b.id);
	});

	return filtered;
}

/**
 * Return the static fallback catalog converted to Pi `ProviderModelConfig[]`.
 */
export function getFallbackMaximalModels(): PiProviderModelConfig[] {
	return buildPiModelsFromWireList(FALLBACK_MAXIMAL_WIRE_MODELS);
}

/**
 * Fetch Maximal health status from `GET <baseUrl>/status`.
 */
export async function fetchMaximalStatus(options: {
	baseUrl?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
} = {}): Promise<MaximalStatusResponse | null> {
	const baseUrl = normalizeMaximalBaseUrl(options.baseUrl);
	const fetchFn = options.fetchImpl ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? 1500;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchFn(`${baseUrl}/status`, {
			method: "GET",
			headers: { accept: "application/json" },
			signal: controller.signal,
		});
		if (!res.ok) return null;
		const data = (await res.json()) as MaximalStatusResponse;
		return data && typeof data === "object" ? data : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Discover models from Maximal's `GET <baseUrl>/v1/models` using Anthropic wire metadata.
 */
export async function fetchMaximalModels(options: {
	baseUrl?: string;
	apiKey?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
} = {}): Promise<PiProviderModelConfig[]> {
	const baseUrl = normalizeMaximalBaseUrl(options.baseUrl);
	const apiKey = options.apiKey || resolveMaximalApiKey().apiKey;
	const fetchFn = options.fetchImpl ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? 2000;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchFn(`${baseUrl}/v1/models`, {
			method: "GET",
			headers: {
				accept: "application/json",
				"anthropic-version": ANTHROPIC_API_VERSION,
				"x-api-key": apiKey,
				authorization: `Bearer ${apiKey}`,
			},
			signal: controller.signal,
		});
		if (!res.ok) {
			throw new Error(`Maximal /v1/models returned HTTP ${res.status}`);
		}
		const payload = (await res.json()) as { data?: MaximalAnthropicModelWire[] };
		const rawList = Array.isArray(payload?.data) ? payload.data : [];
		const mapped = buildPiModelsFromWireList(rawList);
		if (mapped.length === 0) {
			throw new Error("Maximal /v1/models returned no usable chat models");
		}
		return mapped;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Probe Maximal (`/status` + `/v1/models`) and return either the live catalog or the
 * static fallback catalog when Maximal is unreachable or `PI_OFFLINE` is set.
 */
export async function probeMaximalProvider(options: {
	baseUrl?: string;
	apiKey?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	env?: NodeJS.ProcessEnv;
} = {}): Promise<MaximalProbeResult> {
	const env = options.env ?? process.env;
	const baseUrl = normalizeMaximalBaseUrl(options.baseUrl, { env });
	const apiKey = options.apiKey || resolveMaximalApiKey({ env }).apiKey;

	if (env.PI_OFFLINE === "1" || env.PI_OFFLINE === "true") {
		return {
			reachable: false,
			baseUrl,
			status: null,
			models: getFallbackMaximalModels(),
			source: "fallback",
			error: "PI_OFFLINE is enabled",
		};
	}

	const [status, modelsResult] = await Promise.all([
		fetchMaximalStatus({
			baseUrl,
			timeoutMs: options.timeoutMs ?? 1500,
			fetchImpl: options.fetchImpl,
		}),
		fetchMaximalModels({
			baseUrl,
			apiKey,
			timeoutMs: options.timeoutMs ?? 2000,
			fetchImpl: options.fetchImpl,
		}).then(
			(models) => ({ ok: true as const, models }),
			(err: unknown) => ({
				ok: false as const,
				error: err instanceof Error ? err.message : String(err),
			}),
		),
	]);

	if (modelsResult.ok) {
		return {
			reachable: true,
			baseUrl,
			status,
			models: modelsResult.models,
			source: "live",
		};
	}

	return {
		reachable: Boolean(status?.status === "ok"),
		baseUrl,
		status,
		models: getFallbackMaximalModels(),
		source: "fallback",
		error: modelsResult.error,
	};
}
