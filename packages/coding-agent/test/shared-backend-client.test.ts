import assert from "node:assert/strict";
import { test } from "bun:test";
import { SharedBackendClient } from "../src/shared-backend/client";
import { createBackendHandler } from "../src/shared-backend/http";
import { backendFixture } from "./helpers/shared-backend";

const token = "client-contract-test-00000000000000000000";
const url = "http://127.0.0.1:7467";

test("two SDK clients observe the same runtime and retain prompt IDs across reconnect", async () => {
	const { host, runtimes } = backendFixture();
	const fetch = createBackendHandler(host, { token, authority: () => "127.0.0.1:7467" });
	const a = await SharedBackendClient.connect({ url, token, fetch });
	const session = await a.create();
	await a.prompt(session.id, "one prompt", "caller-1");
	const b = await SharedBackendClient.connect({ url, token, fetch });
	assert.equal((await b.list())[0].id, session.id);
	await b.prompt(session.id, "one prompt", "caller-1");
	assert.deepEqual(runtimes[0].prompts, ["one prompt"]);
	await b.close(session.id);
	assert.deepEqual(await a.list(), []);
	await host.shutdown();
});

test("an existing SDK connection rejects a restarted server instead of replaying mutations", async () => {
	const first = backendFixture();
	const second = backendFixture();
	let handler = createBackendHandler(first.host, { token, authority: () => "127.0.0.1:7467" });
	const client = await SharedBackendClient.connect({ url, token, fetch: request => handler(request) });
	handler = createBackendHandler(second.host, { token, authority: () => "127.0.0.1:7467" });
	await assert.rejects(client.create(), { code: "epoch_mismatch" });
	assert.equal(second.runtimes.length, 0);
	await Promise.all([first.host.shutdown(), second.host.shutdown()]);
});

test("SDK refuses non-loopback credential destinations before invoking the transport", async () => {
	let calls = 0;
	for (const invalid of ["http://example.com", "http://127.0.0.1@evil.test", "http://127.0.0.1/path"]) {
		await assert.rejects(SharedBackendClient.connect({ url: invalid, token, fetch: async () => { calls++; return Response.json({}); } }));
	}
	assert.equal(calls, 0);
});

test("incompatible protocols are rejected during handshake before creating sessions", async () => {
	let calls = 0;
	await assert.rejects(SharedBackendClient.connect({ url, token, fetch: async () => {
		calls++;
		return Response.json({ version: 999, epoch: "foreign" });
	} }), { code: "protocol_mismatch" });
	assert.equal(calls, 1);
});
