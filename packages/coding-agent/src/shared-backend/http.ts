import { timingSafeEqual } from "node:crypto";
import { BackendError, type BackendUiResponse, type SharedSessionHost } from "./session-host";

export const BACKEND_PROTOCOL_VERSION = 1;
export const BACKEND_MAX_BODY_BYTES = 64 * 1024;
export interface BackendHttpOptions {
	token: string;
	/** Exact listening authority, including the port. Evaluated after Bun binds port 0. */
	authority: () => string;
	onError?: (error: unknown) => void;
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

async function body(request: Request): Promise<Record<string, unknown>> {
	if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
		throw new BackendError(415, "json_required", "Content-Type must be application/json");
	const reader = request.body?.getReader();
	if (!reader) throw new BackendError(400, "body_required", "A JSON object is required");
	const chunks: Uint8Array[] = [];
	let length = 0;
	const { promise: deadline, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new BackendError(408, "body_timeout", "Request body timed out")), 10_000);
	try {
		for (;;) {
			const chunk = await Promise.race([reader.read(), deadline]);
			if (chunk.done) break;
			length += chunk.value.byteLength;
			if (length > BACKEND_MAX_BODY_BYTES) throw new BackendError(413, "body_too_large", "Request body exceeds 64 KiB");
			chunks.push(chunk.value);
		}
	} catch (error) {
		void reader.cancel().catch(() => {});
		throw error;
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	let value: unknown;
	try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
	catch { throw new BackendError(400, "invalid_json", "Invalid UTF-8 JSON"); }
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new BackendError(400, "invalid_body", "A JSON object is required");
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[]): void {
	if (Object.keys(value).some(key => !allowed.includes(key)))
		throw new BackendError(400, "unknown_field", "Unknown request field");
}
function optionalString(value: unknown, name: string, max = 512): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.length || value.length > max)
		throw new BackendError(400, "invalid_field", `Invalid ${name}`);
	return value;
}
function integer(value: string | null, fallback: number, max: number): number {
	if (value === null) return fallback;
	if (!/^\d+$/.test(value)) throw new BackendError(400, "invalid_number", "Expected a nonnegative integer");
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed > max) throw new BackendError(400, "invalid_number", "Integer out of range");
	return parsed;
}

/** Fetch-compatible handler, independent of the listening socket and agent implementation. */
export function createBackendHandler(host: SharedSessionHost, options: BackendHttpOptions): (request: Request) => Promise<Response> {
	if (options.token.length < 32 || /\s/.test(options.token)) throw new Error("Backend token must be at least 32 characters without whitespace");
	const encoder = new TextEncoder();
	const expected = encoder.encode(`Bearer ${options.token}`);
	return async request => {
		try {
			const url = new URL(request.url);
			const authority = options.authority();
			const hostHeader = request.headers.get("host");
			if (url.host !== authority || (hostHeader !== null && hostHeader !== authority)
				|| request.headers.has("origin") || (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "none"))
				throw new BackendError(403, "origin_rejected", "Browser origins and foreign hosts are not accepted");
			const supplied = encoder.encode(request.headers.get("authorization") ?? "");
			if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
				const response = json({ error: { code: "unauthorized", message: "Bearer authentication required" } }, 401);
				response.headers.set("WWW-Authenticate", "Bearer");
				return response;
			}
			if (request.method === "GET" && url.pathname === "/v1/status")
				return json({ version: BACKEND_PROTOCOL_VERSION, epoch: host.epoch });
			if (request.headers.get("x-omp-backend-epoch") !== host.epoch)
				throw new BackendError(409, "epoch_mismatch", "Reconnect to this backend instance; do not replay uncertain commands");
			if (url.pathname === "/v1/sessions") {
				if (request.method === "GET") return json({ sessions: host.list() });
				if (request.method === "POST") {
					const input = await body(request);
					keys(input, ["provider", "model"]);
					return json({ session: host.create({ provider: optionalString(input.provider, "provider"), model: optionalString(input.model, "model") }) }, 202);
				}
			}
			const match = /^\/v1\/sessions\/([0-9a-f-]{36})(?:\/(state|messages|prompt|abort|events|ui))?$/.exec(url.pathname);
			if (!match) throw new BackendError(404, "not_found", "Endpoint not found");
			const [, id, action] = match;
			if (!action && request.method === "GET") return json({ session: host.info(id) });
			if (!action && request.method === "DELETE") { await host.close(id); return json({ closed: true }); }
			if (request.method === "GET") {
				switch (action) {
					case "state": return json(await host.state(id));
					case "messages": {
						const limit = integer(url.searchParams.get("limit"), 64, 128);
						if (limit < 1) throw new BackendError(400, "invalid_limit", "limit must be positive");
						return json(await host.messages(id, { cursor: optionalString(url.searchParams.get("cursor") ?? undefined, "cursor", 4096), limit }));
					}
					case "ui": return json({ requests: host.pendingUi(id) });
					case "events": return json(await host.poll(id, integer(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER), integer(url.searchParams.get("wait"), 0, 25_000), request.signal));
				}
			}
			if (request.method === "POST") {
				const input = await body(request);
				if (action === "prompt") {
					keys(input, ["requestId", "message"]);
					if (typeof input.requestId !== "string" || typeof input.message !== "string")
						throw new BackendError(400, "invalid_prompt", "requestId and message must be strings");
					return json(await host.prompt(id, input.requestId, input.message), 202);
				}
				if (action === "abort") { keys(input, []); await host.abort(id); return json({ aborted: true }); }
				if (action === "ui") {
					keys(input, ["id", "value", "confirmed", "cancelled"]);
					const requestId = optionalString(input.id, "id", 128);
					const choices = [input.value !== undefined, input.confirmed !== undefined, input.cancelled !== undefined].filter(Boolean).length;
					if (!requestId || choices !== 1 || (input.value !== undefined && typeof input.value !== "string")
						|| (input.confirmed !== undefined && typeof input.confirmed !== "boolean")
						|| (input.cancelled !== undefined && input.cancelled !== true))
						throw new BackendError(400, "invalid_ui_response", "Supply an id and exactly one of value, confirmed, or cancelled: true");
					await host.respondUi(id, input as unknown as BackendUiResponse);
					return json({ accepted: true });
				}
			}
			throw new BackendError(405, "method_not_allowed", "Method not allowed");
		} catch (error) {
			if (error instanceof BackendError) return json({ error: { code: error.code, message: error.message } }, error.status);
			if (request.signal.aborted) return json({ error: { code: "disconnected", message: "Client disconnected" } }, 408);
			options.onError?.(error);
			return json({ error: { code: "runtime_error", message: "Backend runtime operation failed" } }, 502);
		}
	};
}
