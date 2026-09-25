/** Server-owned sessions. Client connections never own or dispose an agent. */
export class BackendError extends Error {
	constructor(readonly status: number, readonly code: string, message: string) {
		super(message);
		this.name = "BackendError";
	}
}

export interface BackendSessionOptions {
	id: string;
	provider?: string;
	model?: string;
}
export interface BackendUiResponse {
	id: string;
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
}
export interface BackendRuntime {
	start(): Promise<void>;
	stop(): Promise<void>;
	prompt(message: string): Promise<string>;
	abort(): Promise<void>;
	getState(): Promise<unknown>;
	getMessagesPage(options: { cursor?: string; limit?: number }): Promise<unknown>;
	getPendingUi(): unknown[];
	respondUi(response: BackendUiResponse): Promise<void>;
}
export type BackendRuntimeFactory = (
	options: BackendSessionOptions,
	emit: (data: unknown) => void,
	exited: () => void,
) => BackendRuntime;
export interface BackendEvent {
	sequence: number;
	data: unknown;
}
export interface BackendSessionInfo {
	id: string;
	status: "starting" | "ready" | "failed" | "closing";
	createdAt: number;
	cursor: number;
}
export interface BackendEvents {
	cursor: number;
	events: BackendEvent[];
}
interface Entry {
	info: BackendSessionInfo;
	runtime: BackendRuntime;
	ready: Promise<void>;
	tail: Promise<void>;
	closing?: Promise<void>;
	journal: { sequence: number; json: string; bytes: number }[];
	bytes: number;
	evictedThrough: number;
	pending: number;
	requestBytes: number;
	requests: Map<string, { message: string; result: Promise<{ requestId: string }> }>;
	listeners: Set<() => void>;
}
export interface BackendLimits {
	maxSessions?: number;
	maxEvents?: number;
	maxEventBytes?: number;
	maxRequests?: number;
	maxRequestBytes?: number;
	maxPending?: number;
	maxSubscribers?: number;
}

/** Bounded in-memory ownership and replay; transcripts remain the runtime's responsibility. */
export class SharedSessionHost {
	readonly epoch = crypto.randomUUID();
	#entries = new Map<string, Entry>();
	#factory: BackendRuntimeFactory;
	#limits: Required<BackendLimits>;
	#shutdown?: Promise<void>;
	#closed = false;
	#encoder = new TextEncoder();

	constructor(factory: BackendRuntimeFactory, limits: BackendLimits = {}) {
		this.#factory = factory;
		this.#limits = {
			maxSessions: 16, maxEvents: 512, maxEventBytes: 2 * 1024 * 1024,
			maxRequests: 1024, maxRequestBytes: 2 * 1024 * 1024, maxPending: 32, maxSubscribers: 32, ...limits,
		};
		for (const value of Object.values(this.#limits)) {
			if (!Number.isSafeInteger(value) || value < 1) throw new Error("Backend limits must be positive integers");
		}
	}

	create(options: Omit<BackendSessionOptions, "id"> = {}): BackendSessionInfo {
		if (this.#closed) throw new BackendError(503, "stopping", "Backend is stopping");
		if (this.#entries.size >= this.#limits.maxSessions)
			throw new BackendError(429, "session_limit", "Close a session before creating another");
		const id = crypto.randomUUID();
		// Factories must not emit until start(); publication precedes startup.
		const runtime = this.#factory({ ...options, id }, data => this.#publish(id, data), () => this.#fail(id));
		const entry: Entry = {
			info: { id, status: "starting", createdAt: Date.now(), cursor: 0 }, runtime,
			ready: Promise.resolve(), tail: Promise.resolve(), journal: [], bytes: 0,
			evictedThrough: 0, pending: 0, requestBytes: 0, requests: new Map(), listeners: new Set(),
		};
		this.#entries.set(id, entry);
		entry.ready = Promise.resolve().then(() => runtime.start()).then(() => {
			if (entry.info.status === "starting") {
				entry.info.status = "ready";
				this.#publish(id, { type: "backend_ready" });
			}
		}, () => this.#fail(id));
		return { ...entry.info };
	}

	list(): BackendSessionInfo[] { return [...this.#entries.values()].map(entry => ({ ...entry.info })); }
	info(id: string): BackendSessionInfo { return { ...this.#get(id).info }; }
	pendingUi(id: string): unknown[] { return this.#get(id).runtime.getPendingUi(); }

	async state(id: string): Promise<{ cursor: number; state: unknown }> {
		const entry = await this.#ready(id);
		// Capture BEFORE the RPC read: replay can overlap this state, but cannot skip intervening events.
		const cursor = entry.info.cursor;
		return { cursor, state: await entry.runtime.getState() };
	}

	async messages(id: string, options: { cursor?: string; limit?: number }): Promise<unknown> {
		return (await this.#ready(id)).runtime.getMessagesPage(options);
	}

	/** Retain outcomes, including failures, for the session lifetime. Never retry uncertain effects. */
	prompt(id: string, requestId: string, message: string): Promise<{ requestId: string }> {
		if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId) || !message.trim() || message.length > 60_000)
			throw new BackendError(400, "invalid_prompt", "A request ID and nonempty message of at most 60000 characters are required");
		const entry = this.#get(id);
		const prior = entry.requests.get(requestId);
		if (prior) {
			if (prior.message !== message) throw new BackendError(409, "request_conflict", "Request ID reused with different content");
			return prior.result;
		}
		if (entry.info.status === "closing" || entry.info.status === "failed")
			throw new BackendError(409, "session_unavailable", "Session is not available");
		const requestBytes = this.#encoder.encode(message).byteLength;
		if (entry.requests.size >= this.#limits.maxRequests || entry.pending >= this.#limits.maxPending
			|| entry.requestBytes + requestBytes > this.#limits.maxRequestBytes)
			throw new BackendError(429, "request_limit", "Session request limit reached");
		entry.pending++;
		entry.requestBytes += requestBytes;
		const result = entry.tail.then(async () => {
			await this.#ready(id);
			return { requestId: await entry.runtime.prompt(message) };
		}).finally(() => { entry.pending--; });
		entry.requests.set(requestId, { message, result });
		entry.tail = result.then(() => {}, () => {});
		return result;
	}

	/** Abort and UI replies bypass prompt admission so a blocked command cannot prevent cancellation. */
	async abort(id: string): Promise<void> { await (await this.#ready(id)).runtime.abort(); }
	async respondUi(id: string, response: BackendUiResponse): Promise<void> {
		const entry = this.#get(id);
		if (entry.info.status === "closing" || entry.info.status === "failed")
			throw new BackendError(409, "session_unavailable", "Session is not available");
		await entry.runtime.respondUi(response);
	}

	events(id: string, after: number): BackendEvents {
		const entry = this.#get(id);
		if (!Number.isSafeInteger(after) || after < 0 || after > entry.info.cursor)
			throw new BackendError(400, "invalid_cursor", "Invalid event cursor");
		if (after < entry.evictedThrough)
			throw new BackendError(410, "replay_expired", "Replay expired; refresh state and transcript before reconnecting");
		return {
			cursor: entry.info.cursor,
			events: entry.journal.filter(event => event.sequence > after).map(event => JSON.parse(event.json) as BackendEvent),
		};
	}

	async poll(id: string, after: number, waitMs: number, signal?: AbortSignal): Promise<BackendEvents> {
		if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 25_000)
			throw new BackendError(400, "invalid_wait", "wait must be between 0 and 25000 milliseconds");
		signal?.throwIfAborted();
		const current = this.events(id, after);
		if (current.events.length || waitMs === 0) return current;
		const entry = this.#get(id);
		if (entry.info.status === "failed" || entry.info.status === "closing") return current;
		if (entry.listeners.size >= this.#limits.maxSubscribers)
			throw new BackendError(429, "subscriber_limit", "Too many waiting clients");
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const cancel = () => reject(signal?.reason ?? new Error("Client disconnected"));
		entry.listeners.add(resolve);
		signal?.addEventListener("abort", cancel, { once: true });
		const timer = setTimeout(resolve, waitMs);
		try {
			await promise;
			return this.events(id, after);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			entry.listeners.delete(resolve);
		}
	}

	close(id: string): Promise<void> {
		const entry = this.#get(id);
		if (entry.closing) return entry.closing;
		entry.info.status = "closing";
		this.#publish(id, { type: "backend_closing" });
		entry.closing = (async () => {
			// start() has a runtime-owned deadline. Stop reaps the worker, including startup failures.
			await entry.ready;
			try { await entry.runtime.stop(); }
			finally {
				await entry.tail;
				this.#entries.delete(id);
				for (const wake of entry.listeners) wake();
			}
		})();
		return entry.closing;
	}

	shutdown(): Promise<void> {
		if (this.#shutdown) return this.#shutdown;
		this.#closed = true;
		this.#shutdown = Promise.allSettled([...this.#entries.keys()].map(id => this.close(id))).then(results => {
			const failures = results.filter(result => result.status === "rejected");
			if (failures.length) throw new Error(`Failed to stop ${failures.length} backend session(s)`);
		});
		return this.#shutdown;
	}

	#get(id: string): Entry {
		const entry = this.#entries.get(id);
		if (!entry) throw new BackendError(404, "session_not_found", "Session not found");
		return entry;
	}
	async #ready(id: string): Promise<Entry> {
		const entry = this.#get(id);
		await entry.ready;
		if (entry.info.status !== "ready") throw new BackendError(409, "session_unavailable", "Session is not ready");
		return entry;
	}
	#fail(id: string): void {
		const entry = this.#entries.get(id);
		if (!entry || entry.info.status === "closing" || entry.info.status === "failed") return;
		entry.info.status = "failed";
		this.#publish(id, { type: "backend_failed" });
	}
	#publish(id: string, data: unknown): void {
		const entry = this.#entries.get(id);
		if (!entry) return;
		const sequence = ++entry.info.cursor;
		const json = JSON.stringify({ sequence, data } satisfies BackendEvent);
		const bytes = this.#encoder.encode(json).byteLength;
		entry.journal.push({ sequence, json, bytes });
		entry.bytes += bytes;
		while (entry.journal.length > this.#limits.maxEvents || entry.bytes > this.#limits.maxEventBytes) {
			const removed = entry.journal.shift();
			if (!removed) break;
			entry.bytes -= removed.bytes;
			entry.evictedThrough = removed.sequence;
		}
		for (const wake of entry.listeners) wake();
	}
}
