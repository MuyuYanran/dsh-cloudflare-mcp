import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path, { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListToolsResultSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region src/store.ts
/**
* dsh-cloudflare-mcp — credential/token store.
*
* Persists the Cloudflare MCP OAuth state (dynamic client registration +
* tokens) to ~/.dsh/dsh-cloudflare-mcp.json (mode 0600). Secrets never
* leave this module; the public view() masks everything. The config path
* can be overridden with DSH_CLOUDFLARE_MCP_CONFIG (used by tests).
*/
/** Default machine-wide config location (mode 0600). */
const DEFAULT_CONFIG_FILE = path.join(homedir(), ".dsh", "dsh-cloudflare-mcp.json");
/** Test override for the config location. */
function configPath() {
	const override = process.env.DSH_CLOUDFLARE_MCP_CONFIG;
	return override !== void 0 && override !== "" ? override : DEFAULT_CONFIG_FILE;
}
/** The Cloudflare MCP endpoint. */
const MCP_URL = "https://mcp.cloudflare.com/mcp";
/** Mask a credential for display, keeping only the head and tail. */
function mask(value) {
	if (!value) return "";
	if (value.length <= 8) return value.slice(0, 2) + "****";
	return value.slice(0, 4) + "****" + value.slice(-4);
}
/** Empty credentials record. */
function empty() {
	return {
		clientInformation: null,
		tokens: null,
		tokenUpdatedAt: "",
		discoveryState: null
	};
}
/** Parse an unknown JSON record into credentials (tolerates missing keys). */
function parse(raw) {
	const record = typeof raw === "object" && raw !== null ? raw : {};
	const info = record.clientInformation;
	const tokens = record.tokens;
	const str = (value) => typeof value === "string" ? value : "";
	const infoRecord = typeof info === "object" && info !== null ? info : null;
	const tokensRecord = typeof tokens === "object" && tokens !== null ? tokens : null;
	return {
		clientInformation: infoRecord !== null && str(infoRecord.client_id) !== "" ? {
			client_id: str(infoRecord.client_id),
			client_secret: infoRecord.client_secret !== void 0 ? str(infoRecord.client_secret) : void 0,
			client_id_issued_at: typeof infoRecord.client_id_issued_at === "number" ? infoRecord.client_id_issued_at : void 0,
			client_secret_expires_at: typeof infoRecord.client_secret_expires_at === "number" ? infoRecord.client_secret_expires_at : void 0,
			redirect_uris: Array.isArray(infoRecord.redirect_uris) ? infoRecord.redirect_uris.filter((u) => typeof u === "string") : void 0
		} : null,
		tokens: tokensRecord !== null && str(tokensRecord.access_token) !== "" ? {
			access_token: str(tokensRecord.access_token),
			refresh_token: tokensRecord.refresh_token !== void 0 ? str(tokensRecord.refresh_token) : void 0,
			expires_at: typeof tokensRecord.expires_at === "number" ? tokensRecord.expires_at : void 0,
			scope: typeof tokensRecord.scope === "string" ? tokensRecord.scope : void 0,
			token_type: typeof tokensRecord.token_type === "string" ? tokensRecord.token_type : void 0
		} : null,
		tokenUpdatedAt: str(record.tokenUpdatedAt),
		discoveryState: typeof record.discoveryState === "object" && record.discoveryState !== null ? record.discoveryState : null
	};
}
/**
* Small credential store backed by ~/.dsh/dsh-cloudflare-mcp.json.
* Reads are lazy and cached; writes use mode 0600 so OAuth tokens never
* leak to other local users.
*/
var CloudflareMcpStore = class {
	config = null;
	async load() {
		if (this.config !== null) return this.config;
		try {
			const raw = await readFile(configPath(), "utf8");
			this.config = parse(JSON.parse(raw));
		} catch {
			this.config = empty();
		}
		return this.config;
	}
	async save(next) {
		this.config = next;
		await mkdir(path.dirname(configPath()), { recursive: true });
		await writeFile(configPath(), JSON.stringify(next, null, 2), { mode: 384 });
	}
	/** Public, secret-free view. */
	async view(callbackUrl) {
		const cfg = await this.load();
		return {
			configured: cfg.clientInformation !== null || cfg.tokens !== null,
			authorized: cfg.tokens !== null && cfg.tokens.access_token.trim() !== "",
			tokenUpdatedAt: cfg.tokenUpdatedAt,
			clientIdMasked: cfg.clientInformation !== null ? mask(cfg.clientInformation.client_id) : "",
			callbackUrl,
			mcpUrl: MCP_URL,
			configPath: configPath()
		};
	}
	/** Clear every credential (tokens, client registration, discovery state). */
	async clearAll() {
		await this.save(empty());
	}
	/** Clear only tokens (keeps the client registration and discovery state). */
	async clearTokens() {
		const cfg = await this.load();
		cfg.tokens = null;
		cfg.tokenUpdatedAt = "";
		await this.save(cfg);
	}
	/** Clear the client registration (forces dynamic re-registration next auth). */
	async clearClientInformation() {
		const cfg = await this.load();
		cfg.clientInformation = null;
		await this.save(cfg);
	}
};
/** How long `begin()` waits for the authorization URL to materialize (ms). */
const AUTHORIZE_URL_TIMEOUT_MS = 30 * 1e3;
/**
* OAuth client provider backed by the credential store. Implements the MCP
* SDK's OAuthClientProvider contract: persisted client registration + tokens,
* memory-held PKCE verifier, and a captured authorization URL for the GUI.
*/
var CloudflareOAuthProvider = class {
	store;
	callbackUrl;
	pending = null;
	codeVerifierValue = null;
	constructor(store, callbackUrl) {
		this.store = store;
		this.callbackUrl = callbackUrl;
	}
	/** The loopback callback URL (registered on the GUI's own web server). */
	get redirectUrl() {
		return this.callbackUrl;
	}
	/** Client metadata for dynamic registration (public client + PKCE). */
	get clientMetadata() {
		return {
			client_name: "dsh-cloudflare-mcp",
			redirect_uris: [this.callbackUrl],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"]
		};
	}
	/**
	* Flow-bound state (verified on the callback).
	*
	* The MCP SDK builds the authorize URL by calling this method itself; if it
	* returned a fresh UUID every time, the URL's `state` would differ from the
	* one `begin()` recorded in the pending flow, and the callback's state could
	* never match (the "state 校验未通过" failure). Return the active pending
	* flow's state so the authorize request reuses the exact value the pending
	* flow will verify.
	*/
	async state() {
		const pending = this.pending;
		if (pending !== null) return pending.state;
		return randomUUID();
	}
	async clientInformation() {
		return (await this.store.load()).clientInformation ?? void 0;
	}
	async saveClientInformation(information) {
		const cfg = await this.store.load();
		cfg.clientInformation = information;
		await this.store.save(cfg);
	}
	async tokens() {
		const cfg = await this.store.load();
		if (cfg.tokens === null) return void 0;
		const tokens = {
			access_token: cfg.tokens.access_token,
			token_type: cfg.tokens.token_type ?? "Bearer"
		};
		if (cfg.tokens.refresh_token !== void 0) tokens.refresh_token = cfg.tokens.refresh_token;
		if (cfg.tokens.scope !== void 0) tokens.scope = cfg.tokens.scope;
		return tokens;
	}
	async saveTokens(tokens) {
		const cfg = await this.store.load();
		cfg.tokens = {
			access_token: tokens.access_token,
			refresh_token: tokens.refresh_token,
			expires_at: tokens.expires_in !== void 0 ? Date.now() + tokens.expires_in * 1e3 : void 0,
			scope: tokens.scope,
			token_type: tokens.token_type ?? "Bearer"
		};
		cfg.tokenUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
		await this.store.save(cfg);
	}
	async saveDiscoveryState(state) {
		const cfg = await this.store.load();
		cfg.discoveryState = state;
		await this.store.save(cfg);
	}
	async discoveryState() {
		return (await this.store.load()).discoveryState;
	}
	async invalidateCredentials(scope) {
		if (scope === "all") await this.store.clearAll();
		else if (scope === "client") await this.store.clearClientInformation();
		else if (scope === "tokens") await this.store.clearTokens();
		else if (scope === "verifier") this.codeVerifierValue = null;
		else if (scope === "discovery") {
			const cfg = await this.store.load();
			cfg.discoveryState = null;
			await this.store.save(cfg);
		}
	}
	async saveCodeVerifier(codeVerifier) {
		this.codeVerifierValue = codeVerifier;
	}
	async codeVerifier() {
		if (this.codeVerifierValue === null) throw new Error("OAuth flow: missing PKCE code verifier (flow may have expired)");
		return this.codeVerifierValue;
	}
	async redirectToAuthorization(authorizationUrl) {
		const pending = this.pending;
		if (pending !== null) pending.resolveAuthorizeUrl(authorizationUrl.toString());
	}
	/** Wait for the pending flow's authorization URL (bounded). */
	waitForAuthorizationUrl(timeoutMs) {
		const pending = this.pending;
		if (pending === null) return Promise.reject(/* @__PURE__ */ new Error("OAuth flow: no pending authorization"));
		return Promise.race([pending.authorizeUrlPromise, new Promise((_, reject) => {
			setTimeout(() => reject(/* @__PURE__ */ new Error("OAuth flow: authorization URL timed out")), timeoutMs).unref();
		})]);
	}
	/** Register the pending flow slot (rejects when one is already active). */
	beginPending(state) {
		if (this.pending !== null && Date.now() - this.pending.startedAt < 6e5) throw new Error("已有一个待完成的 Cloudflare 授权流程，请先完成或等待它过期。");
		let resolveAuthorizeUrl;
		let rejectAuthorizeUrl;
		const authorizeUrlPromise = new Promise((resolve, reject) => {
			resolveAuthorizeUrl = resolve;
			rejectAuthorizeUrl = reject;
		});
		const pending = {
			state,
			provider: this,
			authorizeUrlPromise,
			resolveAuthorizeUrl,
			rejectAuthorizeUrl,
			code: null,
			startedAt: Date.now()
		};
		this.pending = pending;
		this.codeVerifierValue = null;
		return pending;
	}
	/** The active pending flow (or null). */
	get pendingFlow() {
		const pending = this.pending;
		if (pending === null) return null;
		if (Date.now() - pending.startedAt > 6e5) {
			this.pending = null;
			return null;
		}
		return pending;
	}
	/** Settle a pending flow (call after the callback or manual code arrives). */
	settlePending(state, code) {
		const pending = this.pendingFlow;
		if (pending === null || pending.state !== state) return null;
		pending.code = code;
		this.pending = null;
		return pending;
	}
	/** Abort any pending flow (rejects a waiting begin() with an error). */
	settlePendingAbort() {
		const pending = this.pending;
		this.pending = null;
		this.codeVerifierValue = null;
		if (pending !== null) pending.rejectAuthorizeUrl(/* @__PURE__ */ new Error("授权流程已被取消。"));
	}
};
/**
* OAuth orchestration shared by the routes and the agent tools.
* Phase 1 (`begin`) starts discovery/registration and returns the
* authorization URL; phase 2 (`complete`) exchanges the code. The provider
* instance is created once per callback URL and reused across flows: it
* reads/writes tokens through the store, so the MCP transport keeps working
* (and auto-refreshing) between authorizations.
*/
var OAuthFlow = class {
	store;
	provider = null;
	constructor(store) {
		this.store = store;
	}
	/** The provider used by the MCP transport (created lazily). */
	get activeProvider() {
		return this.provider;
	}
	/** Get (creating if needed) the provider bound to this callback URL. */
	getProvider(callbackUrl) {
		if (this.provider === null) this.provider = new CloudflareOAuthProvider(this.store, callbackUrl);
		return this.provider;
	}
	/**
	* Start an authorization: fresh dynamic client registration (the callback
	* URL is fixed per host run, but re-registering is cheap and always
	* consistent), then the discovery + authorize-URL dance. Returns the URL
	* for the browser once it exists.
	*/
	async begin(callbackUrl) {
		await this.store.clearClientInformation();
		const provider = this.getProvider(callbackUrl);
		provider.settlePendingAbort();
		const state = await provider.state();
		const pending = provider.beginPending(state);
		auth(provider, { serverUrl: MCP_URL }).catch((error) => {
			pending.rejectAuthorizeUrl(error);
		});
		try {
			return {
				authorizeUrl: await provider.waitForAuthorizationUrl(AUTHORIZE_URL_TIMEOUT_MS),
				state
			};
		} catch (error) {
			throw error;
		}
	}
	/**
	* Complete the flow with the authorization code (from the loopback
	* callback or a manually pasted code). Verifies the state, exchanges the
	* code, and persists the tokens. Returns { ok, message }.
	*/
	async complete(code, state) {
		const provider = this.provider;
		if (provider === null) return {
			ok: false,
			message: "没有待完成的授权流程：请先点击「开始授权」。"
		};
		if (provider.settlePending(state ?? "", code) === null) return {
			ok: false,
			message: "state 校验未通过（授权流程可能已过期或重复）。请重新点击「开始授权」。"
		};
		let result;
		try {
			result = await auth(provider, {
				serverUrl: MCP_URL,
				authorizationCode: code
			});
		} catch (error) {
			return {
				ok: false,
				message: "令牌交换失败：" + String(error instanceof Error ? error.message : error)
			};
		}
		if (result !== "AUTHORIZED") return {
			ok: false,
			message: "授权未完成（未知状态）。"
		};
		return {
			ok: true,
			message: "授权成功：Cloudflare MCP 令牌已保存，MCP 工具已就绪。"
		};
	}
	/** Drop any pending flow (used by clear/reset). */
	abort() {
		if (this.provider !== null) this.provider.settlePendingAbort();
	}
};
//#endregion
//#region src/mcp.ts
/**
* dsh-cloudflare-mcp — MCP connection supervisor.
*
* Connects to https://mcp.cloudflare.com/mcp with the OAuth provider
* (the transport auto-attaches the bearer token and auto-refreshes on
* 401), discovers the server's tools, and registers them on `ctx.tools`
* under deterministic server-qualified public names
* (`mcp__cloudflare__<rawName>`, same contract as @deepseek-ai/dsh-mcp-client).
*
* Lifecycle: only starts when tokens exist (an unauthenticated connect
* would otherwise spin the OAuth redirect loop). On connection loss it
* retries with bounded exponential backoff; when the user clears
* credentials mid-run the supervisor stops.
*/
/** Raw call result record: the bridge owns JSON-value validation after transport. */
const RawCallToolResultSchema = z.record(z.string(), z.unknown());
/** DeepSeek function-name contract: at most 64 characters. */
const MAX_PUBLIC_NAME_LENGTH = 64;
/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12;
/** Default per-tool-call timeout (ms). */
const TOOL_CALL_TIMEOUT_MS = 6e4;
/** Close-signal wait before giving up on a generation (ms). */
const GENERATION_CLOSE_TIMEOUT_MS = 5e3;
/** Reconnect backoff bounds. */
const RECONNECT = {
	initialDelayMs: 1e3,
	maxDelayMs: 3e4,
	maxAttempts: 10
};
/** Derive the model-facing public name (mcp__cloudflare__<rawName>). */
function publicToolName(rawName) {
	const joined = `mcp__cloudflare__${rawName}`;
	const normalized = joined.replace(INVALID_NAME_CHARS, "_");
	if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
	const hash = createHash("sha256").update(`cloudflare\0${rawName}`).digest("hex").slice(0, HASH_LENGTH);
	return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}
/** Extract readable text from an MCP content array. */
function extractText(mcpContent, toolName) {
	if (!Array.isArray(mcpContent)) return `(${toolName} returned non-content output)`;
	const parts = [];
	for (const value of mcpContent) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			parts.push("[unsupported content type: unknown]");
			continue;
		}
		const block = value;
		switch (block.type) {
			case "text":
				if (typeof block.text === "string") parts.push(block.text);
				break;
			case "image":
				parts.push(`[image: ${typeof block.mimeType === "string" ? block.mimeType : "unknown"}, content discarded]`);
				break;
			case "audio":
				parts.push(`[audio: ${typeof block.mimeType === "string" ? block.mimeType : "unknown"}, content discarded]`);
				break;
			case "resource":
			case "resource_link":
				parts.push("[resource: content discarded]");
				break;
			default: parts.push(`[unsupported content type: ${String(block.type)}]`);
		}
	}
	return parts.join("\n") || `(${toolName} returned no text content)`;
}
/**
* Create the supervised connection for the Cloudflare MCP server.
* @param ctx - cordis context carrying the tools registry and logger.
* @param store - credential store (tokens gate the connection).
* @param flow - OAuth flow providing the transport's auth provider.
* @param callbackUrl - the loopback OAuth callback URL.
* @param options - registration behaviour, see {@link SupervisorOptions}.
* @returns the supervisor handle.
*/
function createSupervisor(ctx, store, flow, callbackUrl, options = {}) {
	let registerToolsOn = options.registerTools !== false;
	const label = "cloudflare-mcp";
	/** The tools the upstream server last advertised (wire shapes). */
	let advertisedTools = [];
	/** The last built ctx.tools definitions, kept so registration can be re-applied. */
	let lastDefinitions = [];
	/** Notified when the advertised tool set changes (the bridge pushes the MCP notification). */
	const onToolsetChanged = options.onToolsetChanged;
	let client = null;
	let clientClosed = null;
	let disposers = /* @__PURE__ */ new Map();
	let reconnectTimer = null;
	let failedAttempts = 0;
	let disposed = false;
	/** Serializes every tool sync (initial and notification re-syncs). */
	let syncChain = Promise.resolve();
	const isCurrent = (generation) => !disposed && client === generation;
	function enqueueSync(generation) {
		const run = syncChain.then(async () => {
			if (!isCurrent(generation)) return;
			disposers = await syncTools(generation);
		});
		syncChain = run.catch(() => {});
		return run;
	}
	function syncTools(generation) {
		return listToolsAll(generation).then((tools) => {
			const changed = tools.map((tool) => tool.name).join("\n") !== advertisedTools.map((tool) => tool.name).join("\n");
			advertisedTools = tools;
			lastDefinitions = buildToolDefinitions(generation, tools);
			applyRegistration();
			if (changed) onToolsetChanged?.();
			return disposers;
		});
	}
	/** Rebuild `ctx.tools` registrations from the cached definitions. */
	function applyRegistration() {
		for (const dispose of disposers.values()) dispose();
		const next = /* @__PURE__ */ new Map();
		if (registerToolsOn) for (const definition of lastDefinitions) next.set(definition.name, ctx.tools.register(definition));
		disposers = next;
	}
	/** Bring the connection up if needed, then return the advertised tool set. */
	async function ensureTools() {
		if (client === null) await connectGeneration(false);
		if (client === null) throw new Error("Cloudflare MCP 无法连接：请先完成 OAuth 授权。");
		await syncChain;
		if (advertisedTools.length === 0) advertisedTools = await listToolsAll(client);
		return advertisedTools;
	}
	async function listToolsAll(generation) {
		const tools = [];
		let cursor;
		do {
			const response = await generation.request({
				method: "tools/list",
				...cursor === void 0 ? {} : { params: { cursor } }
			}, ListToolsResultSchema);
			for (const tool of response.tools) tools.push({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema
			});
			cursor = response.nextCursor;
		} while (cursor !== void 0);
		return tools;
	}
	async function callToolUncached(generation, rawName, args, signal) {
		return await generation.request({
			method: "tools/call",
			params: {
				name: rawName,
				arguments: args
			}
		}, RawCallToolResultSchema, {
			signal,
			timeout: TOOL_CALL_TIMEOUT_MS
		});
	}
	/**
	* Build the ctx.tools definitions for one advertised tool set. The executor
	* closes over the generation it was discovered on, so a stale generation's
	* tools are always dropped before they could be registered.
	*/
	function buildToolDefinitions(generation, tools) {
		return tools.map((tool) => ({
			name: publicToolName(tool.name),
			description: tool.description ?? "",
			parameters: tool.inputSchema,
			output: {
				schema: {
					type: "object",
					properties: {
						content: {
							type: "array",
							items: {}
						},
						structuredContent: {}
					},
					required: ["content"],
					additionalProperties: false
				},
				render(_args, value) {
					return [{
						type: "text",
						text: extractText(typeof value === "object" && value !== null ? value.content : void 0, tool.name)
					}];
				}
			},
			execute: async (args, exec) => {
				const cleanArgs = typeof args === "object" && args !== null ? args : {};
				const result = await callToolUncached(generation, tool.name, cleanArgs, exec.signal);
				if (!Array.isArray(result.content)) {
					const text = "toolResult" in result ? JSON.stringify(result.toolResult) : "(no output)";
					if (result.isError === true) throw new Error(text);
					return { content: [{
						type: "text",
						text
					}] };
				}
				if (result.isError === true) throw new Error(extractText(result.content, tool.name));
				return { content: result.content };
			}
		}));
	}
	function generationDown(generation) {
		if (!isCurrent(generation)) return;
		client = null;
		clientClosed = null;
		scheduleReconnect();
	}
	/**
	* Close the current generation without scheduling a reconnect, and drop every
	* tool registration. Used by the service switch (off) and by disposal; both
	* stay restartable afterwards — `start()` simply opens a fresh generation.
	*/
	async function stopConnection() {
		if (reconnectTimer !== null) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		failedAttempts = 0;
		const current = client;
		const currentClosed = clientClosed;
		client = null;
		clientClosed = null;
		if (current !== null) {
			try {
				await current.close();
			} catch {}
			if (currentClosed !== null && !await waitForClose(currentClosed)) ctx.logger.error(`${label}: generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms during stop`);
		}
		await syncChain;
		for (const dispose of disposers.values()) dispose();
		disposers = /* @__PURE__ */ new Map();
	}
	function waitForClose(closed) {
		return new Promise((resolve) => {
			const timeout = setTimeout(() => resolve(false), GENERATION_CLOSE_TIMEOUT_MS);
			timeout.unref();
			closed.then(() => {
				clearTimeout(timeout);
				resolve(true);
			});
		});
	}
	function scheduleReconnect() {
		if (disposed) return;
		if (failedAttempts >= RECONNECT.maxAttempts) {
			syncChain = syncChain.then(() => {
				for (const dispose of disposers.values()) dispose();
				disposers = /* @__PURE__ */ new Map();
			});
			ctx.logger.error(`${label}: giving up after ${RECONNECT.maxAttempts} reconnect attempts — tools unregistered; re-authorize or restart to reconnect`);
			return;
		}
		const delayMs = Math.min(RECONNECT.maxDelayMs, RECONNECT.initialDelayMs * 2 ** failedAttempts);
		failedAttempts += 1;
		ctx.logger.warn(`${label}: connection lost; retrying in ${delayMs}ms (attempt ${failedAttempts}/${RECONNECT.maxAttempts})`);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connectGeneration(false);
		}, delayMs);
		reconnectTimer.unref();
	}
	async function connectGeneration(startup) {
		if (disposed) return;
		const cfg = await store.load();
		if (cfg.tokens === null || cfg.tokens.access_token === "") {
			ctx.logger.info(`${label}: no OAuth tokens — connection deferred until authorization completes`);
			return;
		}
		const generation = new Client({
			name: "dsh-cloudflare-mcp",
			version: "0.1.0"
		}, { capabilities: {} });
		let resolveClosed;
		const closed = new Promise((resolve) => {
			resolveClosed = resolve;
		});
		let attemptSettled = false;
		let closeObserved = false;
		client = generation;
		clientClosed = closed;
		generation.onclose = () => {
			closeObserved = true;
			resolveClosed();
			if (attemptSettled) generationDown(generation);
		};
		generation.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
			if (!isCurrent(generation)) return;
			ctx.logger.info(`${label}: tool list changed, re-syncing`);
			try {
				await enqueueSync(generation);
			} catch (error) {
				if (!disposed) ctx.logger.error(`${label}: tool re-sync failed: ${String(error)}`);
			}
		});
		try {
			const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: flow.getProvider(callbackUrl) });
			await generation.connect(transport);
			if (closeObserved) {
				attemptSettled = true;
				generationDown(generation);
				return;
			}
			await enqueueSync(generation);
		} catch (error) {
			if (firstAttemptError === void 0 && startup) firstAttemptError = error;
			if (isCurrent(generation)) ctx.logger.warn(`${label}: connection attempt failed: ${String(error)}`);
			try {
				await generation.close();
			} catch {}
			const quiesced = closeObserved || await waitForClose(closed);
			attemptSettled = true;
			if (!isCurrent(generation)) return;
			if (!quiesced) {
				client = null;
				clientClosed = null;
				ctx.logger.error(`${label}: failed generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms — reconnect stopped; restart the Host to retry`);
				return;
			}
			generationDown(generation);
			return;
		}
		attemptSettled = true;
		if (closeObserved) {
			generationDown(generation);
			return;
		}
		if (!isCurrent(generation)) return;
		if (failedAttempts > 0) ctx.logger.info(`${label}: reconnected and re-synced tools (attempt ${failedAttempts}/${RECONNECT.maxAttempts})`);
	}
	let firstAttemptError = null;
	return {
		async start() {
			failedAttempts = 0;
			await connectGeneration(true);
			if (firstAttemptError !== null && client === null) {
				const error = firstAttemptError;
				firstAttemptError = null;
				throw error;
			}
		},
		isConnected() {
			return client !== null;
		},
		toolCount() {
			return registerToolsOn ? disposers.size : advertisedTools.length;
		},
		setRegistration(next) {
			if (next === registerToolsOn) return;
			registerToolsOn = next;
			applyRegistration();
		},
		isRegistrationOn() {
			return registerToolsOn;
		},
		async listTools() {
			if (client === null) throw new Error("Cloudflare MCP 未连接。");
			return (await listToolsAll(client)).map((tool) => tool.name);
		},
		async listToolDefinitions() {
			return ensureTools();
		},
		async callTool(rawName, args, signal) {
			if (client === null) await connectGeneration(false);
			const generation = client;
			if (generation === null) throw new Error("Cloudflare MCP 未连接：请先在设置页完成授权。");
			return callToolUncached(generation, rawName, args, signal ?? new AbortController().signal);
		},
		async stop() {
			await stopConnection();
		},
		async dispose() {
			disposed = true;
			advertisedTools = [];
			await stopConnection();
		}
	};
}
//#endregion
//#region src/bridge.ts
/**
* dsh-cloudflare-mcp — loopback MCP endpoint (the standard-protocol bridge).
*
* The Cloudflare MCP server needs OAuth, which `@deepseek-ai/dsh-mcp-client`
* cannot do — that is the whole reason this plugin owns the connection. But an
* OAuth-authenticated connection is also the only thing a standard MCP row needs
* to *point at*, so this module re-exposes the plugin's upstream connection as a
* plain Streamable HTTP MCP server on the harness's own loopback web server:
*
*     http://127.0.0.1:<gui-port>/mcp/cloudflare
*
* A standard row — `@deepseek-ai/dsh-mcp-client`, `serverName: cloudflare` — then
* registers its tools exactly like any other MCP server, which makes the
* connection visible and manageable in dsh-mcp-manager-plus (list / enable /
* disable / restart), and makes the plugin's own tool registration unnecessary:
* with `registerToolsOnMount: false` the supervisor only keeps the upstream
* connection, and the model reaches it through the bridge.
*
* Design notes:
* - **One transport per request, stateless.** dsh-mcp-client opens a single
*   connection per server and never re-initializes on a dropped session, so a
*   session-id carrying transport would break on every profile reload. A
*   stateless transport answers every POST in-band and needs no resume stream.
* - **Lazy upstream.** `tools/list` and `tools/call` bring the OAuth connection
*   up on demand, so the bridge works right after an OAuth callback without the
*   caller sequencing `start()` first.
* - **No secrets on the wire.** The endpoint is loopback-only and the OAuth token
*   stays inside this process; the bridge adds nothing to the request.
* - **Tool-set changes are pushed.** When the supervisor re-syncs and the set of
*   names changed, every live session gets `notifications/tools/list_changed`,
*   which is what makes the model-facing tool list follow upstream changes.
*/
/** Path of the loopback MCP endpoint, registered as an exact webserver route. */
const MCP_BRIDGE_PATH = "/mcp/cloudflare";
/**
* Whether the request came from the loopback interface. The bridge forwards
* calls with the user's Cloudflare OAuth token and has no credential of its own,
* so it must never answer a remote client — the GUI can also be bound to a
* network address, and the standard MCP row then sits on that same server.
*/
function isLoopbackSocket(request) {
	const address = request.socket.remoteAddress ?? "";
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.");
}
/** Client-facing identity of the bridge (shown in loader logs). */
const BRIDGE_INFO = {
	name: "cloudflare-mcp",
	version: "1.0.0"
};
/** How the bridge describes itself to the model, through the standard bridge. */
const BRIDGE_INSTRUCTIONS = "Cloudflare API 工具，经 dsh-cloudflare-mcp 插件的官方 OAuth 授权连接 mcp.cloudflare.com。";
/**
* Create the loopback MCP endpoint for one supervisor.
* @param supervisor - the supervised Cloudflare connection.
* @param logger - sink for bridge diagnostics.
* @returns the bridge handle.
*/
function createMcpBridge(supervisor, logger) {
	const sessions = /* @__PURE__ */ new Set();
	const buildServer = () => {
		const server = new Server(BRIDGE_INFO, {
			capabilities: { tools: {} },
			instructions: BRIDGE_INSTRUCTIONS
		});
		server.setRequestHandler(ListToolsRequestSchema, async () => {
			return { tools: (await supervisor.listToolDefinitions()).map((tool) => ({
				name: tool.name,
				...tool.description === void 0 ? {} : { description: tool.description },
				inputSchema: tool.inputSchema
			})) };
		});
		server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
			const name = request.params.name;
			const args = typeof request.params.arguments === "object" && request.params.arguments !== null ? request.params.arguments : {};
			const result = await supervisor.callTool(name, args, extra.signal);
			if (!Array.isArray(result.content)) {
				const text = "toolResult" in result ? JSON.stringify(result.toolResult) : "(no output)";
				if (result.isError === true) throw new Error(text);
				return { content: [{
					type: "text",
					text
				}] };
			}
			if (result.isError === true) return {
				content: result.content,
				isError: true
			};
			return { content: result.content };
		});
		return server;
	};
	const handler = async (req, res) => {
		if (!isLoopbackSocket(req)) {
			res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ error: "cloudflare-mcp bridge: loopback-only" }));
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(req.method === "GET" ? 405 : 400, {
				"content-type": "application/json; charset=utf-8",
				allow: "POST"
			});
			res.end(JSON.stringify({ error: "cloudflare-mcp bridge: stateless endpoint, POST only" }));
			return;
		}
		const server = buildServer();
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: void 0,
			enableJsonResponse: true
		});
		const session = {
			server,
			transport
		};
		sessions.add(session);
		let settled = false;
		const release = () => {
			if (settled) return;
			settled = true;
			sessions.delete(session);
		};
		transport.onclose = () => {
			release();
			server.close().catch(() => {});
		};
		try {
			await server.connect(transport);
			await transport.handleRequest(req, res);
		} catch (error) {
			logger.warn("cloudflare-mcp bridge: request failed: " + String(error instanceof Error ? error.message : error));
			if (!res.headersSent) {
				res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: "cloudflare-mcp bridge request failed" }));
			}
		} finally {
			if (res.writableEnded) release();
			else res.once("close", () => {
				release();
				server.close().catch(() => {});
			});
		}
	};
	return {
		handler,
		announceToolsChanged() {
			for (const session of sessions) session.server.sendToolListChanged().catch(() => {});
		},
		async dispose() {
			const live = [...sessions];
			sessions.clear();
			for (const session of live) try {
				await session.transport.close();
				await session.server.close();
			} catch {}
		}
	};
}
//#endregion
//#region src/routes.ts
/** Route paths. */
const CLOUDFLARE_MCP_API = {
	status: "/api/dsh-cloudflare-mcp/status",
	oauthStart: "/api/dsh-cloudflare-mcp/oauth/start",
	oauthCallback: "/api/dsh-cloudflare-mcp/oauth/callback",
	oauthFinish: "/api/dsh-cloudflare-mcp/oauth/finish",
	oauthRefresh: "/api/dsh-cloudflare-mcp/oauth/refresh",
	test: "/api/dsh-cloudflare-mcp/test",
	clear: "/api/dsh-cloudflare-mcp/clear",
	/** Enable/disable the MCP service row (shared with dsh-mcp-manager-plus). */
	service: "/api/dsh-cloudflare-mcp/service"
};
/** Port of a loopback URL; 0 when it cannot be parsed. */
function portOf(url) {
	try {
		return Number(new URL(url).port) || 0;
	} catch {
		return 0;
	}
}
/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 64 * 1024;
/** Strict loopback fence for the non-callback routes. */
function isLoopbackRequest(request) {
	const address = request.socket.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
/** Callback route fence: loopback client + host header, any origin (cross-site navigation from the OAuth provider is expected). */
function isLoopbackCallbackRequest(request) {
	const address = request.socket.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	try {
		const hostUrl = new URL(`http://${host}`);
		return hostUrl.hostname === "127.0.0.1" || hostUrl.hostname === "localhost" || hostUrl.hostname === "[::1]";
	} catch {
		return false;
	}
}
/** One JSON response. */
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"referrer-policy": "no-referrer"
	});
	res.end(payload);
}
/** One HTML response (used only by the OAuth callback page). */
function writeHtml(res, status, title, body) {
	const html = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>" + title + "</title><style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0;background:#f6f7f9;color:#1f2328}.card{background:#fff;border:1px solid #e2e5e9;border-radius:12px;padding:32px 40px;max-width:520px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:18px;margin:0 0 12px}p{font-size:14px;line-height:1.7;margin:0}</style></head><body><div class=\"card\"><h1>" + title + "</h1><p>" + body + "</p></div></body></html>";
	res.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"referrer-policy": "no-referrer"
	});
	res.end(html);
}
/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > MAX_JSON_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : void 0;
	} catch {
		return;
	}
}
/** Extract a string query parameter. */
function queryParam(req, name) {
	try {
		return new URL(req.url ?? "", "http://localhost").searchParams.get(name) ?? "";
	} catch {
		return "";
	}
}
/**
* Build every /api/dsh-cloudflare-mcp route (exact paths).
* @param deps - store, oauth flow, MCP supervisor, callback URL, service switch.
* @returns the route list.
*/
function makeRoutes(deps) {
	const { store, flow, supervisor, callbackUrl, service, authorized } = deps;
	const guard = (req, res, method) => {
		if (!isLoopbackRequest(req)) {
			writeJson(res, 403, { error: "forbidden: loopback-only" });
			return false;
		}
		if (req.method !== method) {
			writeJson(res, 405, { error: `method not allowed: ${req.method}` });
			return false;
		}
		return true;
	};
	const statusView = async () => {
		const view = await store.view(callbackUrl);
		const state = service.state();
		return {
			...view,
			connected: supervisor.isConnected(),
			toolCount: supervisor.toolCount(),
			mcpEndpoint: `http://127.0.0.1:${portOf(callbackUrl)}${MCP_BRIDGE_PATH}`,
			service: state
		};
	};
	/** Report one switch outcome with a freshly read state. */
	const serviceResult = (enabled) => {
		try {
			const state = service.set(enabled);
			return {
				ok: true,
				message: state.enabled ? "Cloudflare MCP 服务已开启：mcp__cloudflare__* 工具与插件公告会重新进入提示词。" : "Cloudflare MCP 服务已关闭：模型不再看到 mcp__cloudflare__* 工具与插件公告，因此不再消耗这部分提示词额度。随时可重新开启。",
				service: state
			};
		} catch (error) {
			return {
				ok: false,
				error: String(error instanceof Error ? error.message : error),
				service: service.state()
			};
		}
	};
	return [
		{
			kind: "exact",
			path: CLOUDFLARE_MCP_API.status,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, await statusView());
			}
		},
		{
			kind: "exact",
			path: CLOUDFLARE_MCP_API.oauthStart,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					const { authorizeUrl } = await flow.begin(callbackUrl);
					writeJson(res, 200, {
						ok: true,
						authorizeUrl,
						callbackUrl
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						error: String(error instanceof Error ? error.message : error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CLOUDFLARE_MCP_API.oauthCallback,
			handler: async (req, res) => {
				if (!isLoopbackCallbackRequest(req)) {
					writeHtml(res, 403, "授权失败", "回调请求来自非本机地址，已拒绝。");
					return;
				}
				const code = queryParam(req, "code");
				const state = queryParam(req, "state");
				const error = queryParam(req, "error");
				if (error !== "") {
					flow.abort();
					writeHtml(res, 400, "授权失败", "Cloudflare 返回错误：" + error + "。请重试或使用手动粘贴 code 的方式。");
					return;
				}
				if (code === "") {
					writeHtml(res, 400, "授权失败", "回调中没有 code 参数。");
					return;
				}
				const result = await flow.complete(code, state);
				if (!result.ok) {
					writeHtml(res, 400, "授权失败", result.message);
					return;
				}
				authorized();
				writeHtml(res, 200, "授权成功", "Cloudflare MCP 授权已完成，令牌已保存。现在可以关闭此页面，回到 DSH 设置面板或继续对话。");
			}
		},
		{
			kind: "exact",
			path: CLOUDFLARE_MCP_API.oauthFinish,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 400, { error: "invalid JSON body" });
					return;
				}
				let code = typeof body.code === "string" ? body.code.trim() : "";
				if (code === "" && typeof body.redirectUrl === "string") try {
					code = new URL(body.redirectUrl).searchParams.get("code") ?? "";
				} catch {
					code = "";
				}
				if (code === "") {
					writeJson(res, 400, { error: "缺少 code（或无法从 redirectUrl 提取 code）" });
					return;
				}
				const result = await flow.complete(code, "");
				if (result.ok) authorized();
				writeJson(res, 200, {
					ok: result.ok,
					message: result.message,
					view: await statusView()
				});
			}
		},
		{
			kind: "exact",
			path: CLOUDFLARE_MCP_API.oauthRefresh,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const provider = flow.activeProvider;
				if (provider === null) {
					writeJson(res, 200, {
						ok: false,
						message: "没有活动的 OAuth provider（服务重启后请先测试连接以触发刷新）。",
						view: await statusView()
					});
					return;
				}
				try {
					const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
					const result = await auth(provider, { serverUrl: "https://mcp.cloudflare.com/mcp" });
					writeJson(res, 200, {
						ok: result === "AUTHORIZED",
						message: result === "AUTHORIZED" ? "令牌刷新成功。" : "刷新未完成。",
						view: await statusView()
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						message: "刷新失败：" + String(error instanceof Error ? error.message : error),
						view: await statusView()
					});
				}
			}
		},
		{
			kind: "exact",
			path: CLOUDFLARE_MCP_API.test,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				if (!(await store.view(callbackUrl)).authorized) {
					writeJson(res, 200, {
						ok: false,
						error: "尚未授权：请先点击「开始授权」。",
						view: await statusView()
					});
					return;
				}
				try {
					if (!supervisor.isConnected()) await supervisor.start();
					const tools = await supervisor.listTools();
					writeJson(res, 200, {
						ok: true,
						message: `连接成功，发现 ${tools.length} 个 Cloudflare MCP 工具。`,
						tools,
						view: await statusView()
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						error: String(error instanceof Error ? error.message : error),
						view: await statusView()
					});
				}
			}
		},
		{
			kind: "exact",
			path: CLOUDFLARE_MCP_API.clear,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				flow.abort();
				await supervisor.dispose();
				await store.clearAll();
				writeJson(res, 200, {
					ok: true,
					message: "已清除 Cloudflare MCP 的令牌与客户端注册。",
					view: await statusView()
				});
			}
		},
		{
			kind: "exact",
			path: CLOUDFLARE_MCP_API.service,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0 || typeof body.enabled !== "boolean") {
					writeJson(res, 400, { error: "缺少布尔参数 enabled" });
					return;
				}
				writeJson(res, 200, serviceResult(body.enabled));
			}
		}
	];
}
//#endregion
//#region src/patch.ts
/**
* dsh-cloudflare-mcp — profile patch layer for the MCP-service switch.
*
* The Cloudflare MCP connection ships as two loader rows:
*
*   - `cloudflare-mcp`    — this plugin: OAuth, the settings panel, the
*                           loopback MCP endpoint (always mounted, otherwise the
*                           switch could never be flipped back on).
*   - `mcp-cloudflare`    — a standard `@deepseek-ai/dsh-mcp-client` row pointed
*                           at that endpoint. THIS is the row that puts
*                           `mcp__cloudflare__*` into the model's tool list, so
*                           it is what "the Cloudflare MCP service" means for
*                           token cost.
*
* That second row is exactly what dsh-mcp-manager-plus manages, so the durable
* state of the switch is the `disabled` override the manager reads and writes in
* the profile's user patch layer (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`).
* One file, two surfaces: the panel switch and the manager switch address the
* same row and therefore cannot drift.
*
* Shape of an override (a top-level item of the patch list):
*
*     - id: mcp-cloudflare
*       disabled: true
*
* Writes are textual and surgical: comments, unrelated items and unknown keys in
* the file survive verbatim, because the file belongs to the user. There is no
* YAML dependency here — the layer stays writable on a profile that has no
* `js-yaml` at its root, and a mistake can only ever cost one 2-line block.
*/
/** The row id of the standard MCP client row this bundle inserts. */
const SERVICE_ROW_ID = "mcp-cloudflare";
/** The package that row mounts (kept here so the two halves agree on one name). */
const MCP_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";
/** The DSH home, honouring `DSH_HOME` the way every harness tool does. */
function dshHome() {
	const override = process.env.DSH_HOME;
	return override !== void 0 && override.trim() !== "" ? override : join(homedir(), ".dsh");
}
/** The profile this process booted (`--profile <name>`), if any. */
function argvProfile() {
	const index = process.argv.indexOf("--profile");
	if (index !== -1 && index + 1 < process.argv.length && !process.argv[index + 1].startsWith("-")) return process.argv[index + 1];
}
/**
* Resolve the user patch layer the way dsh-mcp-manager-plus does: the
* `cordis:include` entry the loader actually read is authoritative (a host that
* owns the profile directory, such as DSH Desktop, may place it elsewhere), with
* the conventional path as the fallback.
* @param loader - the running composition's loader service, when reachable.
* @returns absolute path of the profile's `cordis.patch.yml`.
*/
function resolvePatchPath(loader) {
	const fromLoader = includePatchPath(loader);
	if (fromLoader !== void 0) return fromLoader;
	return join(dshHome(), "profiles", argvProfile() ?? "web", "cordis.patch.yml");
}
/**
* Find the root include entry and rewrite its `cordis.yml` path onto the
* sibling `cordis.patch.yml`.
* @param loader - the loader service, if any.
* @returns the patch path, or undefined when it cannot be determined.
*/
function includePatchPath(loader) {
	if (loader === void 0 || typeof loader.entries !== "function") return void 0;
	for (const entry of loader.entries()) {
		const options = entry.options;
		if (options?.name !== "cordis:include") continue;
		const path = options.config?.path;
		if (typeof path !== "string" || !path.includes("cordis.yml")) continue;
		return fromFileUrl(path).replace(/cordis\.yml$/u, "cordis.patch.yml");
	}
}
/**
* Decode a `file://` URL to a native path; a plain path passes through. Percent
* escapes must be decoded — a host that hands the include path over as a file
* URL names a directory containing a space as `%20`, and an undecoded path then
* resolves to a file that does not exist.
* @param value - a `file://` URL or a native path.
*/
function fromFileUrl(value) {
	if (!value.startsWith("file://")) return value;
	try {
		return fileURLToPath(value);
	} catch {}
	try {
		const path = decodeURIComponent(new URL(value).pathname);
		return /^\/[A-Za-z]:/u.test(path) ? path.slice(1) : path;
	} catch {
		return value.replace(/^file:\/\//u, "");
	}
}
/** Read the patch file; a missing file is an empty document, anything else throws. */
function readPatchText(patchPath) {
	try {
		return readFileSync(patchPath, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return "";
		throw new Error("补丁层读取失败：" + String(error?.message ?? error));
	}
}
/**
* Split a patch document into top-level items.
*
* An item starts at a line opening a top-level sequence entry (`- …`). Lines
* before the first item are the preamble (the comment block users write, plus
* the header every profile ships); trailing comments stay inside the item they
* follow, which is what keeps a rewrite from relocating someone's note.
* @param text - raw file text.
* @returns the document view.
*/
function parsePatch(text) {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const starts = topLevelStarts(lines);
	const items = [];
	for (let order = 0; order < starts.length; order += 1) {
		const from = starts[order];
		const to = order + 1 < starts.length ? starts[order + 1] : lines.length;
		const body = lines.slice(from, to);
		items.push({
			start: from,
			end: to,
			...classify(body),
			text: body.join("\n")
		});
	}
	return {
		eol,
		lines,
		items
	};
}
/**
* The line indices that open a top-level entry.
*
* A YAML block scalar (`script: !!js |-` followed by indented lines — exactly
* what dsh-mcp-manager-plus writes for a `!!js` expression) may legitimately
* carry lines that begin with `- `. Reading those as new top-level entries would
* split one user row in half, and a later rewrite would relocate their content.
* So block bodies are skipped by indent, the same rule YAML itself uses.
* @param lines - the document's lines.
*/
function topLevelStarts(lines) {
	const starts = [];
	let blockIndent = -1;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (blockIndent >= 0) {
			if (line.trim() === "" || indentOf(line) >= blockIndent) continue;
			blockIndent = -1;
		}
		if (/^-(?:[ \t]|$)/u.test(line)) starts.push(index);
		const opened = blockScalarIndent(line);
		if (opened !== null) blockIndent = opened.keyIndent + 1;
	}
	return starts;
}
/**
* Whether one line opens a YAML block scalar, and at what indent.
* @param line - a raw document line.
* @returns the key's indent, or null when the line opens no block.
*/
function blockScalarIndent(line) {
	if (/^\s*#/u.test(line)) return null;
	const match = /^(\s*)[^\s].*:\s*(?:!![A-Za-z_][\w-]*\s+)?[-|>][0-9]*[-+]?\s*(?:#.*)?$/u.exec(line);
	if (match === null) return null;
	return { keyIndent: match[1].length };
}
/** Leading-space count of a line (tabs count as one level each). */
function indentOf(line) {
	const match = /^[ \t]*/u.exec(line);
	return match === null ? 0 : match[0].length;
}
/** Extract the structural facts the switch needs from one item's lines. */
function classify(body) {
	let id = null;
	let disabledKey = false;
	let disabledValue = "";
	let isInsert = false;
	for (const line of body) {
		if (/^\s*#/u.test(line)) continue;
		if (/^-[ \t]+insert:/u.test(line)) isInsert = true;
		const idMatch = /^(?:-[ \t]+| {2})id:[ \t]*(.+?)[ \t]*$/u.exec(line);
		if (idMatch !== null && id === null) id = unquote(idMatch[1]);
		const disabledMatch = /^ {2}disabled:[ \t]*(.+?)[ \t]*$/u.exec(line);
		if (disabledMatch !== null) {
			disabledKey = true;
			disabledValue = unquote(disabledMatch[1]);
		}
	}
	if (isInsert) id = null;
	return {
		id,
		disabledKey,
		disabledValue,
		isInsert
	};
}
/** Strip one layer of YAML quoting from a scalar. */
function unquote(value) {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && (trimmed.startsWith("\"") && trimmed.endsWith("\"") || trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
	return trimmed;
}
/** Whether the document's `disabled` override for `rowId` turns the row off. */
function readDisabled(document, rowId) {
	let disabled = false;
	for (const item of document.items) {
		if (item.isInsert || item.id !== rowId || !item.disabledKey) continue;
		disabled = item.disabledValue !== "false";
	}
	return disabled;
}
/** Whether the document carries any `disabled` override for `rowId`. */
function hasDisabledOverride(document, rowId) {
	return document.items.some((item) => !item.isInsert && item.id === rowId && item.disabledKey);
}
/**
* Render a document back to text. The preamble is the lines before the first
* item of the parsed document — a synthetic item added by {@link setDisabled}
* carries `start: -1` and never relocates it.
* @param document - the document view.
* @param items - the replacement item list (defaults to the parsed items).
* @returns file text ending in a newline; an empty document stays an empty list.
*/
function joinPatch(document, items = document.items) {
	const chunks = [];
	const preambleEnd = document.items.length > 0 ? document.items[0].start : document.lines.length;
	const preamble = document.lines.slice(0, preambleEnd).join(document.eol);
	if (preamble.trim() !== "") chunks.push(preamble);
	let wroteItem = false;
	for (const item of items) {
		const body = item.text.split("\n").join(document.eol);
		if (body.trim() === "") continue;
		chunks.push(body);
		wroteItem = true;
	}
	if (!wroteItem) chunks.push("[]");
	let text = chunks.join(document.eol);
	if (text.trim() === "") return "[]" + document.eol;
	if (!text.endsWith(document.eol)) text += document.eol;
	return text;
}
/**
* Set or clear the `disabled` override for one row.
*
* Enabling a row that a bundle layer inserts needs an explicit `disabled:
* false`: dropping the override cannot lift a row another layer holds down, and
* dsh-mcp-manager-plus writes exactly this shape, so the two surfaces produce
* byte-identical documents.
* @param text - raw patch text (missing file = empty string).
* @param rowId - the loader row to address.
* @param enabled - the desired state.
* @returns the new document text.
*/
function setDisabled(text, rowId, enabled) {
	const document = parsePatch(text);
	const keep = document.items.filter((item) => !(item.id === rowId && !item.isInsert && item.disabledKey));
	const block = {
		start: -1,
		end: -1,
		id: rowId,
		disabledKey: true,
		disabledValue: enabled ? "false" : "true",
		isInsert: false,
		text: ["- id: " + rowId, "  disabled: " + (enabled ? "false" : "true")].join("\n")
	};
	return joinPatch(document, [...keep, block]);
}
/**
* Atomically replace the patch file, with an optimistic compare-and-swap.
*
* dsh-mcp-manager-plus writes this same file (it polls and writes on its own
* page), so a read-modify-write that started from stale bytes would silently
* drop whatever the other surface wrote in between. When `expectedPrevious` is
* given, a file whose current content differs is refused instead of clobbered,
* and the caller re-reads and retries against the fresh state.
* @param patchPath - absolute path.
* @param next - candidate content.
* @param expectedPrevious - the exact text the candidate was built from.
* @throws when the candidate is not a top-level entry list, the profile
* directory is missing, or the file changed since it was read.
*/
function writePatch(patchPath, next, expectedPrevious) {
	const candidate = parsePatch(next);
	const withoutComments = next.replace(/^[ \t]*#.*$/gmu, "").trim();
	if (candidate.items.length === 0 && withoutComments !== "" && withoutComments !== "[]") throw new Error("补丁层写入被拒绝：候选内容不是顶层条目列表");
	if ((candidate.items.length > 0 ? candidate.lines.slice(0, candidate.items[0].start) : candidate.lines).some((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))) throw new Error("补丁层写入被拒绝：首个条目前只允许注释或空行");
	if (!next.endsWith("\n")) throw new Error("补丁层写入被拒绝：候选内容缺少结尾换行");
	if (!existsSync(dirname(patchPath))) throw new Error("补丁层写入被拒绝：profile 目录不存在");
	const current = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
	if (expectedPrevious !== void 0 && current !== expectedPrevious) throw new PatchConflictError("补丁层在读取之后被改动（可能有其他界面同时在写入），本次写入已取消。");
	const temp = patchPath + ".tmp-" + process.pid + "-" + Date.now();
	writeFileSync(temp, next);
	renameSync(temp, patchPath);
}
/** The error a refused write reports when another writer got there first. */
var PatchConflictError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "PatchConflictError";
	}
};
//#endregion
//#region src/index.ts
/** Stable cordis plugin name. */
const name = "cloudflare-mcp";
/** Services required before the surfaces can mount. */
const inject = [
	"tools",
	"systemPrompt",
	"webServer"
];
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 161;
/** The `serverName` namespace of the standard row (and thus the tool prefix). */
const SERVICE_SERVER_NAME = "cloudflare";
/** Local event fired after this plugin wrote the switch itself. */
const SERVICE_TOGGLE_EVENT = "dsh-cloudflare-mcp/service-changed";
/** Model-facing announcement: plugin presence, capabilities, and limits. */
const CLOUDFLARE_MCP_GUIDANCE = "本机已安装 dsh-cloudflare-mcp 插件（Cloudflare MCP 连接）：通过官方 OAuth 授权后，Cloudflare 官方 MCP 服务器（mcp.cloudflare.com）的工具以 mcp__cloudflare__* 形式可用，覆盖账户信息、Workers、Pages、DNS、R2、KV、D1、AI 等 Cloudflare API 操作。授权流程：cloudflare_mcp_oauth_start 获取授权链接 → 用户浏览器登录 Cloudflare 并授权 → 自动回调完成（也可把回调地址里的 code 交给 cloudflare_mcp_oauth_finish）。cloudflare_mcp_status 查看连接状态（不回显令牌），cloudflare_mcp_test 测试连接并列出工具，cloudflare_mcp_service 开启/关闭该 MCP 服务（关闭后这些工具与本公告都不再占用提示词）。令牌存 ~/.dsh/dsh-cloudflare-mcp.json（权限 0600）。也可在 Web 设置页「Cloudflare MCP」面板中授权与测试。用户提到「Cloudflare / MCP / Workers 部署 / 查账户」时即指本插件，请据此协作。";
/**
* Mount the Cloudflare MCP connection, its surfaces, and the service switch.
* @param ctx - host plugin context carrying tools/systemPrompt/webServer.
* @param config - plugin config from the composition row.
*/
function apply(ctx, config) {
	const announceToAgent = config?.announceToAgent !== false;
	const enabled = config?.enabled !== false;
	const directMode = config?.registerToolsDirectly === true;
	const store = new CloudflareMcpStore();
	const flow = new OAuthFlow(store);
	const callbackUrl = `http://127.0.0.1:${ctx.webServer.port}${CLOUDFLARE_MCP_API.oauthCallback}`;
	let bridge;
	const supervisor = createSupervisor(ctx, store, flow, callbackUrl, {
		registerTools: directMode,
		onToolsetChanged: () => {
			bridge?.announceToolsChanged();
		}
	});
	bridge = directMode ? void 0 : createMcpBridge(supervisor, ctx.logger);
	/** The patch layer this profile uses as the switch's durable record. */
	const patchPath = () => resolvePatchPath(ctx.get("loader"));
	/**
	* The service state, recomputed on every read: in bridge mode the patch layer
	* is the truth (that is what makes the manager's toggle and this panel's
	* toggle one switch), and the live loader row says whether it converged.
	*/
	const serviceState = () => {
		let fromLayer = true;
		try {
			fromLayer = !readDisabled(parsePatch(readPatchText(patchPath())), SERVICE_ROW_ID);
		} catch (error) {
			ctx.logger.warn(`dsh-cloudflare-mcp: patch layer unreadable: ${String(error instanceof Error ? error.message : error)}`);
		}
		const entry = findServiceEntry(ctx);
		return {
			enabled: directMode ? enabled && supervisor.isRegistrationOn() : fromLayer,
			mounted: directMode ? supervisor.isConnected() : entry !== void 0 && entry.disabled !== true && entry.fiber !== void 0,
			mode: directMode ? "direct" : "bridge",
			managerManaged: hasManagerRow(ctx),
			modelToolCount: countModelTools(ctx),
			patchPath: patchPath()
		};
	};
	/**
	* Write the switch. In bridge mode this is literally the operation
	* dsh-mcp-manager-plus performs on the same row, so the two surfaces are one
	* toggle; the harness then reloads the profile and the row mounts or unmounts.
	* @param on - the desired state.
	* @returns the state as it stands right after the write.
	*/
	const setService = (on) => {
		if (directMode) {
			supervisor.setRegistration(on);
			if (!on) supervisor.stop().catch(() => {});
			return {
				...serviceState(),
				enabled: on
			};
		}
		const file = patchPath();
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const previous = readPatchText(file);
			try {
				writePatch(file, setDisabled(previous, SERVICE_ROW_ID, on), previous);
				break;
			} catch (error) {
				if (!(error instanceof PatchConflictError) || attempt === 1) throw error;
			}
		}
		ctx.emit(SERVICE_TOGGLE_EVENT);
		return {
			...serviceState(),
			enabled: on
		};
	};
	const service = {
		state: serviceState,
		set: setService
	};
	/**
	* What a completed authorization does: open the upstream connection, and only
	* once that is settled re-run the standard MCP row so it re-discovers tools.
	* Reversing the order would have the row ask the bridge while the bridge still
	* has nothing, which is exactly the empty state the user just escaped.
	*/
	const authorized = () => {
		(async () => {
			try {
				await supervisor.start();
			} catch {}
			if (!directMode) {
				const entry = findServiceEntry(ctx);
				if (entry !== void 0) restartRow(entry, ctx.logger);
			}
			sync();
		})();
	};
	const context = {
		store,
		flow,
		supervisor,
		callbackUrl,
		service,
		authorized
	};
	/** Disposer for whatever surface mode is currently applied. */
	let disposeSurfaces;
	/**
	* The last surface mode applied: 'on' = everything the model pays for,
	* 'off' = the keeper switch only, 'none' = the plugin master switch is off,
	* undefined = nothing mounted yet.
	*/
	let surfaceMode;
	let started = false;
	/**
	* Match the model-facing surfaces to the switch. The HTTP routes, the OAuth
	* callback and the loopback MCP endpoint are mounted once and stay mounted:
	* they cost no prompt tokens, and they are how the service gets turned back
	* on. With the service off, only `cloudflare_mcp_service` stays registered —
	* it is the one tool that must remain callable to turn things around from the
	* chat, and it is small enough not to matter for cost.
	*/
	const sync = () => {
		const serviceOn = enabled && serviceState().enabled;
		const wanted = !enabled ? "none" : serviceOn ? "on" : "off";
		if (wanted === surfaceMode) return;
		if (surfaceMode !== void 0) {
			disposeSurfaces?.();
			disposeSurfaces = void 0;
		}
		surfaceMode = wanted;
		if (wanted === "none") return;
		if (wanted === "off") {
			supervisor.setRegistration(false);
			supervisor.stop().catch(() => {});
			started = false;
			disposeSurfaces = ctx.effect(() => ctx.tools.register(cloudflareMcpServiceTool(context)), "dsh-cloudflare-mcp: switch kept online");
			return;
		}
		supervisor.setRegistration(directMode);
		disposeSurfaces = ctx.effect(() => {
			const disposers = buildTools(context).map((tool) => ctx.tools.register(tool));
			const section = announceToAgent ? ctx.systemPrompt.section({
				name: "plugin:dsh-cloudflare-mcp",
				order: SECTION_ORDER,
				text: CLOUDFLARE_MCP_GUIDANCE
			}) : void 0;
			return () => {
				for (const dispose of disposers) dispose();
				if (section !== void 0) section();
			};
		}, "dsh-cloudflare-mcp: model surfaces");
		if (!started) (async () => {
			if ((await store.view(callbackUrl)).authorized && !started && surfaceMode === "on") {
				started = true;
				supervisor.start().catch(() => {});
			}
		})();
	};
	if (enabled) {
		for (const route of makeRoutes(context)) ctx.effect(() => ctx.webServer.register(route), "dsh-cloudflare-mcp: route " + route.path);
		if (bridge !== void 0) {
			const active = bridge;
			ctx.effect(() => ctx.webServer.register({
				kind: "exact",
				path: MCP_BRIDGE_PATH,
				handler: active.handler
			}), "dsh-cloudflare-mcp: mcp endpoint");
		}
	}
	sync();
	ctx.on("app-boot/config-reload", () => {
		sync();
	});
	ctx.on(SERVICE_TOGGLE_EVENT, () => {
		sync();
	});
	ctx.effect(() => {
		return () => {
			supervisor.dispose();
			bridge?.dispose();
		};
	}, "dsh-cloudflare-mcp: connection");
}
/**
* Re-run the live loader entry for the standard MCP row so it reconnects and
* re-discovers its tools. This is the same in-place restart dsh-mcp-manager-plus
* performs, and both loader generations are handled because the row API changed:
* - cordis-plugin-loader ≤ 1.0.3 (dsh ≤ 0.1.6-alpha.x) disposes through the
*   private `entry._dispose()` and remounts with `entry.init()`;
* - 1.0.5+ (dsh ≥ 0.2.0-rc.x) replaced that with `entry.fiber.restart()`.
* A missing row or an unsupported shape is not an error here: the tools simply
* appear on the next host start.
* @param entry - the live row entry.
* @param logger - sink for diagnostics.
*/
function restartRow(entry, logger) {
	const own = entry;
	if (typeof own._dispose === "function" && typeof own.init === "function") {
		(async () => {
			await own._dispose?.();
			await own.init?.();
		})().catch(() => logger.warn("dsh-cloudflare-mcp: could not restart the mcp-cloudflare row"));
		return;
	}
	if (typeof own.fiber?.restart === "function") {
		own.fiber.restart().catch(() => logger.warn("dsh-cloudflare-mcp: could not restart the mcp-cloudflare row"));
		return;
	}
	logger.warn("dsh-cloudflare-mcp: the loader cannot restart the mcp-cloudflare row in place; its tools appear after the next host start");
}
/**
* How many `mcp__<server>__*` definitions the model currently sees. The tool
* registry's catalog is read defensively: an older host without `schemas()`
* simply reports zero rather than failing the status route.
* @param ctx - host plugin context carrying the tools registry.
*/
function countModelTools(ctx) {
	const registry = ctx.tools;
	if (typeof registry.schemas !== "function") return 0;
	const prefix = `mcp__${SERVICE_SERVER_NAME}__`;
	try {
		return registry.schemas().filter((schema) => typeof schema?.name === "string" && schema.name.startsWith(prefix)).length;
	} catch {
		return 0;
	}
}
/**
* The live loader entries, or an empty list when no loader is reachable.
* @param ctx - host plugin context.
*/
function loaderEntries(ctx) {
	const loader = ctx.get("loader");
	if (loader === void 0 || typeof loader.entries !== "function") return [];
	try {
		return [...loader.entries()];
	} catch {
		return [];
	}
}
/**
* The live loader entry for the standard MCP row, if the composition has one.
* @param ctx - host plugin context.
*/
function findServiceEntry(ctx) {
	return loaderEntries(ctx).find((entry) => entry.options?.name === "@deepseek-ai/dsh-mcp-client" && entry.options.config?.serverName === "cloudflare");
}
/**
* Whether dsh-mcp-manager-plus is mounted, so the panel can name the shared
* switch instead of leaving the user guessing where the other toggle lives.
* @param ctx - host plugin context.
*/
function hasManagerRow(ctx) {
	return loaderEntries(ctx).some((entry) => entry.options?.name === "dsh-mcp-manager-plus");
}
/** Build every agent-facing cloudflare_mcp_* tool. */
function buildTools(ctx) {
	return [
		cloudflareMcpStatusTool(ctx),
		cloudflareMcpOAuthStartTool(ctx),
		cloudflareMcpOAuthFinishTool(ctx),
		cloudflareMcpTestTool(ctx),
		cloudflareMcpClearTool(ctx),
		cloudflareMcpServiceTool(ctx)
	];
}
/** One text content block. */
function text(value) {
	return [{
		type: "text",
		text: value
	}];
}
/** Status tool: connection state, token age, switch state, tool count. */
function cloudflareMcpStatusTool(ctx) {
	return defineTool({
		name: "cloudflare_mcp_status",
		description: "查看 dsh-cloudflare-mcp 插件状态：是否已 OAuth 授权、令牌最近更新时间、MCP 是否已连接、MCP 服务开关状态、模型当前可见的 Cloudflare 工具数量。不会泄露任何密钥。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					authorized: { type: "boolean" },
					connected: { type: "boolean" },
					toolCount: { type: "number" },
					serviceEnabled: { type: "boolean" },
					serviceMounted: { type: "boolean" },
					modelToolCount: { type: "number" },
					tokenUpdatedAt: { type: "string" },
					mcpUrl: { type: "string" },
					configPath: { type: "string" }
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute() {
			const view = await ctx.store.view(ctx.callbackUrl);
			const state = ctx.service.state();
			return {
				ok: true,
				message: "dsh-cloudflare-mcp：" + [
					view.authorized ? "已授权（令牌更新于 " + view.tokenUpdatedAt + "）" : "未授权",
					"上游连接" + (ctx.supervisor.isConnected() ? "已建立" : "未建立"),
					"MCP 服务" + (state.enabled ? "开启" : "关闭"),
					"模型可见 Cloudflare 工具 " + state.modelToolCount + " 个",
					"上游端点 " + view.mcpUrl,
					"凭据文件 " + view.configPath
				].join("；") + "。" + (!view.authorized ? "请用 cloudflare_mcp_oauth_start 开始授权。" : state.enabled ? "可直接使用 mcp__cloudflare__* 工具。" : "服务当前关闭（不占提示词额度）；用 cloudflare_mcp_service action=on 打开。"),
				authorized: view.authorized,
				connected: ctx.supervisor.isConnected(),
				toolCount: ctx.supervisor.toolCount(),
				serviceEnabled: state.enabled,
				serviceMounted: state.mounted,
				modelToolCount: state.modelToolCount,
				tokenUpdatedAt: view.tokenUpdatedAt,
				mcpUrl: view.mcpUrl,
				configPath: view.configPath
			};
		}
	});
}
/** OAuth start tool: begin the flow, return the browser URL. */
function cloudflareMcpOAuthStartTool(ctx) {
	return defineTool({
		name: "cloudflare_mcp_oauth_start",
		description: "开始 Cloudflare MCP 的 OAuth 授权流程：返回授权链接（authorizeUrl），让用户用浏览器打开并登录 Cloudflare 授权。授权完成后自动回调本机完成。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					authorizeUrl: { type: "string" }
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute() {
			try {
				const { authorizeUrl } = await ctx.flow.begin(ctx.callbackUrl);
				return {
					ok: true,
					message: "请在浏览器中打开以下链接完成 Cloudflare 授权（打开后登录并点击允许）：" + authorizeUrl,
					authorizeUrl
				};
			} catch (error) {
				return {
					ok: false,
					message: "开始授权失败：" + String(error instanceof Error ? error.message : error)
				};
			}
		}
	});
}
/** OAuth finish tool: manual code paste fallback. */
function cloudflareMcpOAuthFinishTool(ctx) {
	return defineTool({
		name: "cloudflare_mcp_oauth_finish",
		description: "手动完成 Cloudflare MCP 授权：把授权后浏览器地址栏里的 code 参数（或完整回调 URL）传给本工具，完成令牌交换。用于浏览器未能自动回调的情况。",
		parameters: {
			code: {
				type: "string",
				description: "授权回调 URL 中的 code 参数值"
			},
			redirectUrl: {
				type: "string",
				description: "完整的授权回调 URL（自动提取 code）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute(args) {
			let code = typeof args.code === "string" ? args.code.trim() : "";
			if (code === "" && typeof args.redirectUrl === "string" && args.redirectUrl !== "") try {
				code = new URL(args.redirectUrl).searchParams.get("code") ?? "";
			} catch {
				code = "";
			}
			if (code === "") return {
				ok: false,
				message: "缺少 code（或无法从 redirectUrl 提取 code）。"
			};
			const result = await ctx.flow.complete(code, "");
			if (result.ok && ctx.service.state().enabled) ctx.supervisor.start().catch(() => {});
			return result;
		}
	});
}
/** Test tool: connect and list the Cloudflare MCP tools. */
function cloudflareMcpTestTool(ctx) {
	return defineTool({
		name: "cloudflare_mcp_test",
		description: "测试 Cloudflare MCP 连接：确认授权有效并列出服务器当前提供的全部工具名（这些名字会以 mcp__cloudflare__<name> 暴露给模型）。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					tools: {
						type: "array",
						items: { type: "string" }
					}
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute() {
			if (!(await ctx.store.view(ctx.callbackUrl)).authorized) return {
				ok: false,
				message: "尚未授权：请用 cloudflare_mcp_oauth_start 开始授权。"
			};
			try {
				if (!ctx.supervisor.isConnected()) await ctx.supervisor.start();
				const tools = await ctx.supervisor.listTools();
				return {
					ok: true,
					message: "连接成功：Cloudflare MCP 提供 " + tools.length + " 个工具。" + (tools.length > 0 ? " 示例：" + tools.slice(0, 8).join("、") : ""),
					tools
				};
			} catch (error) {
				return {
					ok: false,
					message: "测试失败：" + String(error instanceof Error ? error.message : error)
				};
			}
		}
	});
}
/** Clear tool: wipe credentials and disconnect. */
function cloudflareMcpClearTool(ctx) {
	return defineTool({
		name: "cloudflare_mcp_clear",
		description: "清除 Cloudflare MCP 的全部凭据（OAuth 令牌与客户端注册）并断开连接，MCP 工具随之不可用。需要用户确认后执行。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute() {
			ctx.flow.abort();
			await ctx.supervisor.dispose();
			await ctx.store.clearAll();
			return {
				ok: true,
				message: "已清除 Cloudflare MCP 的全部凭据。重新授权后工具才会回来。"
			};
		}
	});
}
/**
* The MCP-service switch: turn the Cloudflare MCP connection off (no
* `mcp__cloudflare__*` definitions, no helper tools, no announcement — hence no
* prompt-token cost) or back on. It writes the same loader row that
* dsh-mcp-manager-plus toggles, so both surfaces always report one state.
*/
function cloudflareMcpServiceTool(ctx) {
	return defineTool({
		name: "cloudflare_mcp_service",
		description: "开启或关闭 Cloudflare MCP 服务。关闭后模型不再看到 mcp__cloudflare__* 工具与本插件的工具和公告（省下这部分提示词 token），OAuth 授权、设置页与回环端点都保留，随时可再打开。这与「MCP 管理」页面里 cloudflare 那一行的启停是同一个开关。不带 action 参数时只查询当前状态。",
		parameters: { action: {
			type: "string",
			description: "on=开启服务，off=关闭服务，status=只查询当前状态（默认 status）",
			enum: [
				"on",
				"off",
				"status"
			]
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					enabled: { type: "boolean" },
					mounted: { type: "boolean" },
					modelToolCount: { type: "number" },
					patchPath: { type: "string" }
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute(args) {
			const action = args.action === "on" || args.action === "off" ? args.action : "status";
			try {
				const state = action === "status" ? ctx.service.state() : ctx.service.set(action === "on");
				return {
					ok: true,
					message: "Cloudflare MCP 服务" + (state.enabled ? "已开启" : "已关闭") + "（装载" + (state.mounted ? "是" : "否") + "，模型可见工具 " + state.modelToolCount + " 个）。" + (action === "status" ? "需要改动请用 action=on 或 action=off。" : state.enabled ? "工具与公告已恢复。" : "这部分提示词额度已释放；设置页「Cloudflare MCP」或 MCP 管理页都能重新打开。"),
					enabled: state.enabled,
					mounted: state.mounted,
					modelToolCount: state.modelToolCount,
					patchPath: state.patchPath
				};
			} catch (error) {
				return {
					ok: false,
					message: "切换失败：" + String(error instanceof Error ? error.message : error)
				};
			}
		}
	});
}
//#endregion
export { CLOUDFLARE_MCP_API, CLOUDFLARE_MCP_GUIDANCE, CloudflareMcpStore, CloudflareOAuthProvider, MCP_BRIDGE_PATH, MCP_URL, OAuthFlow, PatchConflictError, SERVICE_ROW_ID, MCP_CLIENT_PACKAGE as SERVICE_ROW_PACKAGE, SERVICE_SERVER_NAME, apply, argvProfile, configPath, createMcpBridge, createSupervisor, defineTool, dshHome, fromFileUrl, hasDisabledOverride, inject, joinPatch, makeRoutes, mask, name, parsePatch, readDisabled, readPatchText, resolvePatchPath, setDisabled, writePatch };
