import { type BackendLimits, type BackendRuntime, type BackendRuntimeFactory, SharedSessionHost } from "../../src/shared-backend/session-host";

export class TestBackendRuntime implements BackendRuntime {
	prompts: string[] = [];
	stops = 0;
	aborts = 0;
	startFailure = false;
	pendingPrompt?: Promise<string>;
	emit: (data: unknown) => void;
	exited: () => void;
	constructor(emit: (data: unknown) => void, exited: () => void) { this.emit = emit; this.exited = exited; }
	async start(): Promise<void> { if (this.startFailure) throw new Error("secret startup diagnostic"); }
	async stop(): Promise<void> { this.stops++; }
	async prompt(message: string): Promise<string> {
		this.prompts.push(message);
		return this.pendingPrompt ?? `rpc-${this.prompts.length}`;
	}
	async abort(): Promise<void> { this.aborts++; }
	async getState(): Promise<unknown> { return { prompts: this.prompts.length }; }
	async getMessagesPage(): Promise<unknown> { return { messages: this.prompts, totalMessages: this.prompts.length }; }
	getPendingUi(): unknown[] { return []; }
	async respondUi(): Promise<void> { throw new Error("UI request does not exist"); }
}

export function backendFixture(limits: BackendLimits = {}): {
	host: SharedSessionHost;
	runtimes: TestBackendRuntime[];
} {
	const runtimes: TestBackendRuntime[] = [];
	const factory: BackendRuntimeFactory = (_options, emit, exited) => {
		const runtime = new TestBackendRuntime(emit, exited);
		runtimes.push(runtime);
		return runtime;
	};
	return { host: new SharedSessionHost(factory, limits), runtimes };
}
