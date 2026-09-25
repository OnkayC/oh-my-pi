import assert from "node:assert/strict";
import { test } from "bun:test";
import { BACKEND_MAX_BODY_BYTES, createBackendHandler } from "../src/shared-backend/http";
import { backendFixture } from "./helpers/shared-backend";

const token = "test-only-backend-token-0000000000000000";
function fixture() {
	const { host, runtimes } = backendFixture();
	const handle = createBackendHandler(host, { token, authority: () => "127.0.0.1:7467" });
	const request = (path: string, init: RequestInit = {}) => handle(new Request(`http://127.0.0.1:7467${path}`, {
		...init, headers: { authorization: `Bearer ${token}`, "x-omp-backend-epoch": host.epoch, "content-type": "application/json", ...init.headers },
	}));
	return { host, runtimes, handle, request };
}

test("unauthenticated status does not disclose backend identity or sessions", async () => {
	const { handle, host } = fixture();
	const response = await handle(new Request("http://127.0.0.1:7467/v1/status"));
	assert.equal(response.status, 401);
	assert.equal(response.headers.get("www-authenticate"), "Bearer");
	assert.equal((await response.json()).epoch, undefined);
	await host.shutdown();
});

test("browser origins, cross-site fetches and hostile Host headers are rejected even with a token", async () => {
	const { host, request, handle } = fixture();
	for (const headers of [{ origin: "http://127.0.0.1:7467" }, { "sec-fetch-site": "cross-site" }, { host: "attacker.test" }]) {
		assert.equal((await request("/v1/status", { headers })).status, 403);
	}
	assert.equal((await handle(new Request("http://attacker.test/v1/status", { headers: { authorization: `Bearer ${token}` } }))).status, 403);
	await host.shutdown();
});

test("a stale backend epoch cannot create a replacement session after restart", async () => {
	const { host, request } = fixture();
	const response = await request("/v1/sessions", { method: "POST", headers: { "x-omp-backend-epoch": "old-instance" }, body: "{}" });
	assert.equal(response.status, 409);
	assert.equal(host.list().length, 0);
	await host.shutdown();
});

test("malformed, oversized, and unrecognized request bodies never launch a worker", async () => {
	const { host, request, runtimes } = fixture();
	const cases: [string, number][] = [["{", 400], ["[]", 400], [JSON.stringify({ cwd: "/other-project" }), 400], [JSON.stringify({ model: "x".repeat(BACKEND_MAX_BODY_BYTES) }), 413]];
	for (const [body, status] of cases) assert.equal((await request("/v1/sessions", { method: "POST", body })).status, status);
	assert.equal(runtimes.length, 0);
	await host.shutdown();
});

test("HTTP clients share a session and repeated prompt IDs cannot duplicate work", async () => {
	const { host, request, runtimes } = fixture();
	const created = await request("/v1/sessions", { method: "POST", body: "{}" });
	assert.equal(created.status, 202);
	const { session } = await created.json();
	const endpoint = `/v1/sessions/${session.id}`;
	const submit = () => request(`${endpoint}/prompt`, { method: "POST", body: JSON.stringify({ requestId: "retry-1", message: "shared" }) });
	const responses = await Promise.all([submit(), submit()]);
	assert.deepEqual(responses.map(response => response.status), [202, 202]);
	assert.deepEqual(runtimes[0].prompts, ["shared"]);
	const state = await (await request(`${endpoint}/state`)).json();
	const polling = request(`${endpoint}/events?after=${state.cursor}&wait=1000`);
	runtimes[0].emit({ type: "message_end" });
	assert.deepEqual((await (await polling).json()).events[0].data, { type: "message_end" });
	assert.equal((await request(endpoint, { method: "DELETE" })).status, 200);
	assert.equal(runtimes[0].stops, 1);
	await host.shutdown();
});

test("runtime failures do not disclose raw diagnostics or credentials in HTTP errors", async () => {
	const { host, request, runtimes } = fixture();
	const { id } = host.create();
	await host.state(id);
	const gate = Promise.withResolvers<string>();
	runtimes[0].pendingPrompt = gate.promise;
	const response = request(`/v1/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ requestId: "failure", message: "try" }) });
	// Attach the rejection handler before failing the simulated transport.
	await Promise.resolve(); await Promise.resolve();
	gate.reject(new Error("SECRET provider-token"));
	const result = await response;
	assert.equal(result.status, 502);
	assert.equal((await result.text()).includes("SECRET"), false);
	await host.shutdown();
});

test("invalid cursors and empty UI confirmations fail before touching the runtime", async () => {
	const { host, request } = fixture();
	const { id } = host.create();
	await host.state(id);
	assert.equal((await request(`/v1/sessions/${id}/events?after=-1`)).status, 400);
	assert.equal((await request(`/v1/sessions/${id}/messages?limit=0`)).status, 400);
	assert.equal((await request(`/v1/sessions/${id}/ui`, { method: "POST", body: JSON.stringify({ id: "question", cancelled: false }) })).status, 400);
	await host.shutdown();
});
