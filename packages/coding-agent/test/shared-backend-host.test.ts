import assert from "node:assert/strict";
import { test } from "bun:test";
import { backendFixture } from "./helpers/shared-backend";

test("two clients share one agent and a cancelled poll does not stop ongoing work", async () => {
	const { host, runtimes } = backendFixture();
	const { id } = host.create();
	await host.state(id);
	const cursor = host.info(id).cursor;
	const disconnected = new AbortController();
	const abandoned = host.poll(id, cursor, 1000, disconnected.signal);
	const other = host.poll(id, cursor, 1000);
	disconnected.abort();
	await assert.rejects(abandoned);
	runtimes[0].emit({ type: "message", text: "still running" });
	assert.deepEqual((await other).events.map(event => event.data), [{ type: "message", text: "still running" }]);
	await host.prompt(id, "client-b-1", "continue");
	assert.equal(runtimes.length, 1);
	assert.equal(runtimes[0].stops, 0);
	await host.shutdown();
});

test("concurrent retries execute a prompt once and conflicting reuse is rejected", async () => {
	const { host, runtimes } = backendFixture();
	const { id } = host.create();
	const first = host.prompt(id, "same-id", "one effect");
	const retry = host.prompt(id, "same-id", "one effect");
	assert.deepEqual(await first, await retry);
	assert.deepEqual(runtimes[0].prompts, ["one effect"]);
	assert.throws(() => host.prompt(id, "same-id", "different effect"), { code: "request_conflict" });
	await host.shutdown();
});

test("abort bypasses a blocked prompt and later prompts retain admission order", async () => {
	const { host, runtimes } = backendFixture();
	const { id } = host.create();
	await host.state(id);
	const gate = Promise.withResolvers<string>();
	runtimes[0].pendingPrompt = gate.promise;
	const first = host.prompt(id, "1", "first");
	const second = host.prompt(id, "2", "second");
	await host.abort(id);
	assert.equal(runtimes[0].aborts, 1);
	gate.resolve("accepted");
	await Promise.all([first, second]);
	assert.deepEqual(runtimes[0].prompts, ["first", "second"]);
	await host.shutdown();
});

test("failed prompt outcomes are retained instead of repeating uncertain effects", async () => {
	const { host, runtimes } = backendFixture();
	const { id } = host.create();
	await host.state(id);
	const gate = Promise.withResolvers<string>();
	runtimes[0].pendingPrompt = gate.promise;
	const first = host.prompt(id, "uncertain", "write");
	gate.reject(new Error("transport lost after write"));
	await assert.rejects(first);
	await assert.rejects(host.prompt(id, "uncertain", "write"));
	assert.equal(runtimes[0].prompts.length, 1);
	await host.shutdown();
});

test("evicted or oversized events demand resynchronization rather than silent data loss", async () => {
	const { host, runtimes } = backendFixture({ maxEvents: 2, maxEventBytes: 256 });
	const { id } = host.create();
	await host.state(id);
	const old = host.info(id).cursor;
	for (let n = 0; n < 3; n++) runtimes[0].emit({ n });
	assert.throws(() => host.events(id, old), { status: 410, code: "replay_expired" });
	const recent = host.info(id).cursor;
	runtimes[0].emit({ text: "x".repeat(512) });
	assert.throws(() => host.events(id, recent), { code: "replay_expired" });
	assert.deepEqual(host.events(id, host.info(id).cursor).events, []);
	await host.shutdown();
});

test("replay returns isolated values so one client cannot corrupt another client's events", async () => {
	const { host, runtimes } = backendFixture();
	const { id } = host.create();
	await host.state(id);
	const cursor = host.info(id).cursor;
	runtimes[0].emit({ text: "original" });
	const client = host.events(id, cursor);
	(client.events[0].data as { text: string }).text = "changed";
	assert.deepEqual(host.events(id, cursor).events[0].data, { text: "original" });
	await host.shutdown();
});

test("session and dedupe limits reject new work without forgetting prior outcomes", async () => {
	const { host } = backendFixture({ maxSessions: 1, maxRequests: 1 });
	const { id } = host.create();
	assert.throws(() => host.create(), { code: "session_limit" });
	const result = await host.prompt(id, "1", "retained");
	assert.throws(() => host.prompt(id, "2", "overflow"), { code: "request_limit" });
	assert.deepEqual(await host.prompt(id, "1", "retained"), result);
	await host.close(id);
	assert.equal(host.list().length, 0);
	const replacement = host.create();
	assert.notEqual(replacement.id, id);
	await host.shutdown();
});

test("failed startup remains discoverable and closing it reaps its runtime once", async () => {
	const { host, runtimes } = backendFixture();
	const { id } = host.create();
	runtimes[0].startFailure = true;
	await assert.rejects(host.state(id), { code: "session_unavailable" });
	assert.equal(host.info(id).status, "failed");
	await Promise.all([host.close(id), host.close(id)]);
	assert.equal(runtimes[0].stops, 1);
});

test("worker exit wakes clients and makes subsequent prompts unavailable", async () => {
	const { host, runtimes } = backendFixture();
	const { id } = host.create();
	await host.state(id);
	const waiting = host.poll(id, host.info(id).cursor, 1000);
	runtimes[0].exited();
	assert.deepEqual((await waiting).events[0].data, { type: "backend_failed" });
	assert.throws(() => host.prompt(id, "1", "not admitted"), { code: "session_unavailable" });
	await host.shutdown();
});

test("shutdown closes every runtime once and prevents new sessions", async () => {
	const { host, runtimes } = backendFixture();
	host.create(); host.create();
	await Promise.all([host.shutdown(), host.shutdown()]);
	assert.deepEqual(runtimes.map(runtime => runtime.stops), [1, 1]);
	assert.throws(() => host.create(), { code: "stopping" });
	assert.equal(host.list().length, 0);
});
