import { BACKEND_PROTOCOL_VERSION } from "./http";
import { BackendError, type BackendEvents, type BackendSessionInfo, type BackendUiResponse } from "./session-host";

export interface BackendClientOptions {
	url: string;
	token: string;
	/** Transport seam for embedding and contract tests. No automatic retries. */
	fetch?: (request: Request) => Promise<Response>;
}

/** Owner-authorized local client. Never launches a fallback agent on connection failure. */
export class SharedBackendClient {
	#url: URL;
	#token: string;
	#fetch: (request: Request) => Promise<Response>;
	#epoch = "";

	constructor(options: BackendClientOptions) {
		this.#url = new URL(options.url);
		if (this.#url.protocol !== "http:" || this.#url.hostname !== "127.0.0.1" || this.#url.username
			|| this.#url.password || this.#url.pathname !== "/" || this.#url.search || this.#url.hash)
			throw new Error("Backend URL must be http://127.0.0.1:<port> without credentials, path, query, or fragment");
		this.#token = options.token;
		this.#fetch = options.fetch ?? (request => fetch(request));
	}

	static async connect(options: BackendClientOptions): Promise<SharedBackendClient> {
		const client = new SharedBackendClient(options);
		const status = await client.#request<{ version: number; epoch: string }>("GET", "/v1/status");
		if (status.version !== BACKEND_PROTOCOL_VERSION || typeof status.epoch !== "string" || !status.epoch)
			throw new BackendError(409, "protocol_mismatch", "Incompatible backend protocol");
		client.#epoch = status.epoch;
		return client;
	}

	get epoch(): string { return this.#epoch; }
	async list(): Promise<BackendSessionInfo[]> {
		return (await this.#request<{ sessions: BackendSessionInfo[] }>("GET", "/v1/sessions")).sessions;
	}
	async create(options: { provider?: string; model?: string } = {}): Promise<BackendSessionInfo> {
		return (await this.#request<{ session: BackendSessionInfo }>("POST", "/v1/sessions", options)).session;
	}
	async info(id: string): Promise<BackendSessionInfo> {
		return (await this.#request<{ session: BackendSessionInfo }>("GET", this.#path(id))).session;
	}
	state(id: string): Promise<{ cursor: number; state: unknown }> { return this.#request("GET", `${this.#path(id)}/state`); }
	messages(id: string, options: { cursor?: string; limit?: number } = {}): Promise<unknown> {
		const query = new URLSearchParams();
		if (options.cursor !== undefined) query.set("cursor", options.cursor);
		if (options.limit !== undefined) query.set("limit", String(options.limit));
		return this.#request("GET", `${this.#path(id)}/messages?${query}`);
	}
	prompt(id: string, message: string, requestId: string): Promise<{ requestId: string }> {
		return this.#request("POST", `${this.#path(id)}/prompt`, { message, requestId });
	}
	async abort(id: string): Promise<void> { await this.#request("POST", `${this.#path(id)}/abort`, {}); }
	async close(id: string): Promise<void> { await this.#request("DELETE", this.#path(id)); }
	events(id: string, after: number, signal?: AbortSignal): Promise<BackendEvents> {
		return this.#request("GET", `${this.#path(id)}/events?after=${after}&wait=25000`, undefined, signal);
	}
	async pendingUi(id: string): Promise<unknown[]> {
		return (await this.#request<{ requests: unknown[] }>("GET", `${this.#path(id)}/ui`)).requests;
	}
	async respondUi(id: string, response: BackendUiResponse): Promise<void> {
		await this.#request("POST", `${this.#path(id)}/ui`, response);
	}

	#path(id: string): string {
		if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid backend session ID");
		return `/v1/sessions/${id}`;
	}
	async #request<T>(method: string, pathname: string, body?: unknown, signal?: AbortSignal): Promise<T> {
		const timeout = AbortSignal.timeout(45_000);
		const response = await this.#fetch(new Request(new URL(pathname, this.#url), {
			method, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json", "x-omp-backend-epoch": this.#epoch },
			body: body === undefined ? undefined : JSON.stringify(body),
		}));
		let value: unknown;
		try { value = await response.json(); }
		catch { throw new BackendError(response.status, "invalid_response", "Backend returned invalid JSON"); }
		if (!response.ok) {
			const object = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
			const error = object.error !== null && typeof object.error === "object" ? object.error as Record<string, unknown> : {};
			throw new BackendError(response.status, typeof error.code === "string" ? error.code : "http_error",
				typeof error.message === "string" ? error.message : `Backend returned HTTP ${response.status}`);
		}
		return value as T;
	}
}
