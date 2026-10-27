import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import woodchipperMaximalExtension from "../.pi/extensions/woodchipper-maximal.ts";
import {
	ANTHROPIC_API_VERSION,
	DEFAULT_MAXIMAL_API_KEY_FALLBACK,
	DEFAULT_MAXIMAL_BASE_URL,
	DEFAULT_MAXIMAL_MODEL,
	MAXIMAL_PROVIDER_NAME,
	buildPiModelsFromWireList,
	isCyberPolicyRefusalOrBlock,
	isEmbeddingOrNonChatModel,
	normalizeMaximalBaseUrl,
	probeMaximalProvider,
	resolveMaximalApiKey,
	selectNextFallbackModel,
} from "../.pi/extensions/lib/maximal-provider.ts";

function createMockPiApi(flagOverrides = {}) {
	const state = {
		providers: new Map(),
		tools: new Map(),
		commands: new Map(),
		flags: new Map(),
		handlers: new Map(),
		sentMessages: [],
		selectedModels: [],
	};

	const pi = {
		registerProvider(name, config) {
			state.providers.set(name, config);
		},
		unregisterProvider(name) {
			state.providers.delete(name);
		},
		registerTool(tool) {
			state.tools.set(tool.name, tool);
		},
		registerCommand(name, options) {
			state.commands.set(name, { name, ...options });
		},
		registerFlag(name, options) {
			state.flags.set(name, options);
		},
		getFlag(name) {
			if (Object.prototype.hasOwnProperty.call(flagOverrides, name)) {
				return flagOverrides[name];
			}
			return state.flags.get(name)?.default;
		},
		on(event, handler) {
			const list = state.handlers.get(event) ?? [];
			list.push(handler);
			state.handlers.set(event, list);
			return () => {};
		},
		sendMessage(message, options) {
			state.sentMessages.push({ message, options });
		},
		sendUserMessage(content, options) {
			state.sentMessages.push({ userMessage: content, options });
		},
		async setModel(model) {
			state.selectedModels.push(model);
			return true;
		},
	};

	return { pi, state };
}

test("normalizeMaximalBaseUrl enforces loopback security for HTTP and strips trailing /v1", () => {
	assert.equal(normalizeMaximalBaseUrl(undefined, { env: {} }), DEFAULT_MAXIMAL_BASE_URL);
	assert.equal(normalizeMaximalBaseUrl("http://localhost:4141/v1/", { env: {} }), "http://localhost:4141");
	assert.equal(normalizeMaximalBaseUrl("http://127.0.0.1:4141///", { env: {} }), "http://127.0.0.1:4141");
	assert.equal(normalizeMaximalBaseUrl("https://maximal.example.com:8443/v1", { env: {} }), "https://maximal.example.com:8443");

	assert.throws(
		() => normalizeMaximalBaseUrl("http://192.168.1.50:4141", { env: {} }),
		/Refusing unencrypted non-loopback Maximal URL/,
	);

	assert.equal(
		normalizeMaximalBaseUrl("http://192.168.1.50:4141", { allowRemoteHttp: true, env: {} }),
		"http://192.168.1.50:4141",
	);
});

test("resolveMaximalApiKey prioritizes env, then enabled config entries by client priority, then fallback", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-maximal-auth-"));
	try {
		const configPath = path.join(tmpDir, "config.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				auth: {
					apiKeyEntries: [
						{ id: "disabled-key", name: "woodchipper-disabled", client: "woodchipper", key: "sk-disabled", enabled: false },
						{ id: "cursor-key", name: "cursor", client: "cursor", key: "sk-cursor-111", enabled: true },
						{ id: "cc-key", name: "claude-code", client: "claude-code", key: "sk-cc-222", enabled: true },
					],
				},
			}),
			"utf8",
		);

		// 1. Env override wins
		const fromEnv = resolveMaximalApiKey({
			env: { MAXIMAL_API_KEY: "sk-env-override" },
			configPath,
		});
		assert.equal(fromEnv.apiKey, "sk-env-override");
		assert.equal(fromEnv.source, "env");

		// 2. Config entry prefers claude-code / pi / woodchipper over cursor and ignores disabled entries
		const fromConfig = resolveMaximalApiKey({ env: {}, configPath });
		assert.equal(fromConfig.apiKey, "sk-cc-222");
		assert.equal(fromConfig.source, "config-entry");
		assert.equal(fromConfig.clientName, "claude-code");

		// 3. Fallback when config does not exist
		const fallback = resolveMaximalApiKey({
			env: {},
			configPath: path.join(tmpDir, "nonexistent.json"),
		});
		assert.equal(fallback.apiKey, DEFAULT_MAXIMAL_API_KEY_FALLBACK);
		assert.equal(fallback.source, "fallback");
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("buildPiModelsFromWireList filters embeddings, preserves capabilities, and orders preferred models first", () => {
	assert.equal(isEmbeddingOrNonChatModel("text-embedding-3-small"), true);
	assert.equal(isEmbeddingOrNonChatModel("text-embedding-ada-002"), true);
	assert.equal(isEmbeddingOrNonChatModel("claude-opus-5-5-20260301"), false);

	const models = buildPiModelsFromWireList([
		{
			id: "text-embedding-3-small",
			display_name: "Embedding 3 Small",
			max_input_tokens: 8191,
			max_tokens: 8191,
		},
		{
			id: "grok-4.6",
			display_name: "Grok 4.1",
			max_input_tokens: 128000,
			max_tokens: 64000,
			capabilities: {
				image_input: { supported: false },
				thinking: { supported: true },
			},
		},
		{
			id: "claude-opus-5-5-20260301",
			display_name: "Claude Opus 4.6",
			max_input_tokens: 200000,
			max_tokens: 64000,
			capabilities: {
				image_input: { supported: true },
				thinking: { supported: true },
			},
		},
		{
			id: "claude-sonnet-5",
			display_name: "Claude Sonnet 4",
			max_input_tokens: 128000,
			max_tokens: 16000,
			capabilities: {
				image_input: { supported: true },
				thinking: { supported: false },
			},
		},
	]);

	assert.equal(models.length, 3);
	assert.equal(models[0].id, "claude-opus-5-5-20260301");
	assert.equal(models[0].api, "anthropic-messages");
	assert.equal(models[0].contextWindow, 200000);
	assert.equal(models[0].maxTokens, 64000);
	assert.equal(models[0].reasoning, true);
	assert.deepEqual(models[0].compat, { forceAdaptiveThinking: true });
	assert.deepEqual(models[0].input, ["text", "image"]);

	const sonnet4 = models.find((m) => m.id === "claude-sonnet-5");
	assert.equal(sonnet4.reasoning, false);
	assert.equal(sonnet4.compat, undefined);

	const grok = models.find((m) => m.id === "grok-4.6");
	assert.deepEqual(grok.input, ["text"]);
});

test("woodchipperMaximalExtension discovers live models from Maximal HTTP server and handles /maximal & woodchipper_maximal", async () => {
	let receivedAnthropicVersion = null;
	let receivedApiKey = null;

	const server = http.createServer((req, res) => {
		if (req.url === "/status") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					service: "maximal",
					status: "ok",
					version: "0.4.47",
					subsystems: {
						copilot: { authenticated: true, ready: true, account_type: "individual" },
						models: { cached: 3 },
					},
				}),
			);
			return;
		}
		if (req.url === "/v1/models") {
			receivedAnthropicVersion = req.headers["anthropic-version"];
			receivedApiKey = req.headers["x-api-key"];
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "text-embedding-3-small",
							display_name: "Embedding",
							max_input_tokens: 8192,
							max_tokens: 8192,
						},
						{
							id: "claude-sonnet-5-5-20260301",
							display_name: "Claude Sonnet 4.6",
							max_input_tokens: 200000,
							max_tokens: 64000,
							capabilities: {
								image_input: { supported: true },
								thinking: { supported: true },
							},
						},
						{
							id: "claude-opus-5-5-20260301",
							display_name: "Claude Opus 4.6",
							max_input_tokens: 200000,
							max_tokens: 64000,
							capabilities: {
								image_input: { supported: true },
								thinking: { supported: true },
							},
						},
						{
							id: "gpt-6",
							display_name: "GPT-5.4",
							max_input_tokens: 272000,
							max_tokens: 128000,
							capabilities: {
								image_input: { supported: true },
								thinking: { supported: true },
							},
						},
					],
				}),
			);
			return;
		}
		res.writeHead(444);
		res.end();
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		const { pi, state } = createMockPiApi();
		await woodchipperMaximalExtension(pi, {
			baseUrl,
			apiKey: "sk-test-maximal-key",
			env: {},
		});

		assert.equal(receivedAnthropicVersion, ANTHROPIC_API_VERSION);
		assert.equal(receivedApiKey, "sk-test-maximal-key");

		assert.ok(state.providers.has(MAXIMAL_PROVIDER_NAME));
		const providerConfig = state.providers.get(MAXIMAL_PROVIDER_NAME);
		assert.equal(providerConfig.baseUrl, baseUrl);
		assert.equal(providerConfig.apiKey, "sk-test-maximal-key");
		assert.equal(providerConfig.api, "anthropic-messages");
		assert.equal(providerConfig.models.length, 3);
		assert.equal(providerConfig.models[0].id, DEFAULT_MAXIMAL_MODEL);

		// Verify refreshModels callback works
		const refreshed = await providerConfig.refreshModels();
		assert.equal(refreshed.length, 3);

		// Verify woodchipper_maximal tool
		const tool = state.tools.get("woodchipper_maximal");
		assert.ok(tool);
		const toolRes = await tool.execute("tc_max_1", { action: "status" }, undefined, undefined, {
			model: { provider: "maximal", id: "claude-sonnet-5-5-20260301" },
		});
		assert.equal(toolRes.details.reachable, true);
		assert.equal(toolRes.details.source, "live");
		assert.equal(toolRes.details.modelCount, 3);
		assert.match(toolRes.content[0].text, /ONLINE/);
		assert.match(toolRes.content[0].text, /v0\.4\.47/);

		// Verify /maximal use <model-id>
		const cmd = state.commands.get("maximal");
		assert.ok(cmd);
		await cmd.handler("use gpt-6", {
			hasUI: true,
			ui: { notify() {} },
			modelRegistry: {
				find(prov, id) {
					return prov === "maximal" && id === "gpt-6" ? { provider: prov, id } : undefined;
				},
			},
		});
		assert.equal(state.selectedModels.length, 1);
		assert.deepEqual(state.selectedModels[0], { provider: "maximal", id: "gpt-6" });

		// Verify /maximal status emits custom message
		await cmd.handler("status", {
			hasUI: false,
			ui: { notify() {} },
		});
		assert.equal(state.sentMessages.length, 1);
		assert.equal(state.sentMessages[0].message.customType, "woodchipper-maximal-status");
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("probeMaximalProvider and woodchipperMaximalExtension fall back cleanly when offline and respect --no-maximal", async () => {
	const offlineProbe = await probeMaximalProvider({
		baseUrl: "http://127.0.0.1:4141",
		env: { PI_OFFLINE: "1" },
	});
	assert.equal(offlineProbe.reachable, false);
	assert.equal(offlineProbe.source, "fallback");
	assert.ok(offlineProbe.models.some((m) => m.id === DEFAULT_MAXIMAL_MODEL));

	// Verify --no-maximal unregisters provider on session_start
	const { pi, state } = createMockPiApi({ "no-maximal": true });
	await woodchipperMaximalExtension(pi, {
		baseUrl: "http://127.0.0.1:4141",
		env: { PI_OFFLINE: "1" },
	});
	assert.equal(state.providers.has(MAXIMAL_PROVIDER_NAME), true);

	const sessionStart = state.handlers.get("session_start")[0];
	await sessionStart({ type: "session_start" }, { hasUI: false });
	assert.equal(state.providers.has(MAXIMAL_PROVIDER_NAME), false);
});

test("woodchipperMaximalExtension automatically fails over to next resilient model on upstream cyber-policy refusal", async () => {
	assert.equal(
		isCyberPolicyRefusalOrBlock({
			role: "assistant",
			stopReason: "error",
			errorMessage: "400 invalid_request_error: Blocked by upstream cyber safety policy",
			content: [],
		}).refused,
		true,
	);
	assert.equal(
		isCyberPolicyRefusalOrBlock({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "I'm sorry, but I can't assist with reverse engineering or analyzing binaries." }],
		}).refused,
		true,
	);
	assert.equal(
		isCyberPolicyRefusalOrBlock({
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "toolCall", name: "woodchipper_triage" }],
		}).refused,
		false,
	);

	const { pi, state } = createMockPiApi();
	await woodchipperMaximalExtension(pi, {
		baseUrl: "http://127.0.0.1:4141",
		env: { PI_OFFLINE: "1" },
	});

	const beforeStart = state.handlers.get("before_agent_start")[0];
	const agentEnd = state.handlers.get("agent_end")[0];

	await beforeStart({
		type: "before_agent_start",
		messageType: "user",
		prompt: "Triage /bin/ls and check its Mach-O segments",
	});

	await agentEnd(
		{
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					model: "claude-opus-5-5-20260301",
					stopReason: "error",
					errorMessage: "HTTP 400 invalid_request_error: upstream cyber policy refusal",
					content: [],
				},
			],
		},
		{
			hasUI: false,
			model: { provider: "maximal", id: "claude-opus-5-5-20260301" },
			modelRegistry: {
				find(prov, id) {
					return { provider: prov, id };
				},
			},
		},
	);

	assert.equal(state.selectedModels.length, 1);
	assert.deepEqual(state.selectedModels[0], {
		provider: "maximal",
		id: "claude-sonnet-5-5-20260301",
	});
	assert.ok(state.sentMessages.some((m) => m.userMessage === "Triage /bin/ls and check its Mach-O segments"));
	assert.ok(typeof selectNextFallbackModel === "function");
});
