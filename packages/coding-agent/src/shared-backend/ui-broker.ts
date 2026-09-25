import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "../modes/rpc/rpc-types";
import { BackendError, type BackendUiResponse } from "./session-host";

type Dialog = Extract<RpcExtensionUIRequest, { method: "select" | "confirm" | "input" | "editor" }>;
interface PendingDialog { request: Dialog; timer: NodeJS.Timeout; }

/** First authorized answer wins. Disconnects never approve or cancel a pending question. */
export class BackendUiBroker {
	#pending = new Map<string, PendingDialog>();
	#send: (response: RpcExtensionUIResponse) => Promise<void>;
	#emit: (event: unknown) => void;
	#closed = false;

	constructor(send: (response: RpcExtensionUIResponse) => Promise<void>, emit: (event: unknown) => void) {
		this.#send = send;
		this.#emit = emit;
	}

	observe(request: RpcExtensionUIRequest): void {
		if (this.#closed) return;
		if (request.method === "cancel") {
			this.#take(request.targetId);
			this.#emit(request);
			return;
		}
		if (request.method !== "select" && request.method !== "confirm" && request.method !== "input" && request.method !== "editor") {
			this.#emit(request);
			return;
		}
		if (this.#pending.has(request.id)) return;
		if (this.#pending.size >= 32 || new TextEncoder().encode(JSON.stringify(request)).byteLength > 64 * 1024) {
			void this.#send({ type: "extension_ui_response", id: request.id, cancelled: true }).catch(() => {});
			this.#emit({ type: "backend_ui_rejected", id: request.id, reason: "capacity" });
			return;
		}
		const requested = "timeout" in request ? request.timeout : undefined;
		const timeout = typeof requested === "number" && Number.isFinite(requested)
			? Math.max(0, Math.min(requested, 300_000)) : 300_000;
		const timer = setTimeout(() => {
			if (!this.#take(request.id)) return;
			void this.#send({ type: "extension_ui_response", id: request.id, cancelled: true, timedOut: true }).catch(() => {});
			this.#emit({ type: "backend_ui_resolved", id: request.id, reason: "timeout" });
		}, timeout);
		this.#pending.set(request.id, { request: structuredClone(request), timer });
		this.#emit(request);
	}

	list(): Dialog[] { return [...this.#pending.values()].map(({ request }) => structuredClone(request)); }

	async respond(response: BackendUiResponse): Promise<void> {
		const pending = this.#pending.get(response.id);
		if (!pending) throw new BackendError(409, "ui_request_expired", "UI request was already answered, cancelled, or expired");
		const choices = [response.value !== undefined, response.confirmed !== undefined, response.cancelled !== undefined].filter(Boolean).length;
		if (choices !== 1) throw new BackendError(400, "invalid_ui_response", "Exactly one answer is required");
		let frame: RpcExtensionUIResponse;
		if (response.cancelled === true) frame = { type: "extension_ui_response", id: response.id, cancelled: true };
		else if (pending.request.method === "confirm" && typeof response.confirmed === "boolean")
			frame = { type: "extension_ui_response", id: response.id, confirmed: response.confirmed };
		else if (pending.request.method !== "confirm" && typeof response.value === "string") {
			if (pending.request.method === "select" && !pending.request.options.includes(response.value))
				throw new BackendError(400, "invalid_ui_option", "Value is not an offered option");
			frame = { type: "extension_ui_response", id: response.id, value: response.value };
		} else throw new BackendError(400, "invalid_ui_response", "Answer does not match the pending question");
		// Consume synchronously before I/O. An uncertain write must not accept a competing answer.
		this.#take(response.id);
		this.#emit({ type: "backend_ui_resolved", id: response.id, reason: "answered" });
		await this.#send(frame);
	}

	dispose(): void {
		this.#closed = true;
		for (const id of this.#pending.keys()) this.#take(id);
	}
	#take(id: string): PendingDialog | undefined {
		const pending = this.#pending.get(id);
		if (pending) { clearTimeout(pending.timer); this.#pending.delete(id); }
		return pending;
	}
}
