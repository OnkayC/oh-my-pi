import assert from "node:assert/strict";
import { test } from "bun:test";
import type { RpcExtensionUIResponse } from "../src/modes/rpc/rpc-types";
import { BackendUiBroker } from "../src/shared-backend/ui-broker";

test("only the first client answer reaches a shared confirmation", async () => {
	const sent: RpcExtensionUIResponse[] = [];
	const broker = new BackendUiBroker(async response => { sent.push(response); }, () => {});
	broker.observe({ type: "extension_ui_request", method: "confirm", id: "q", title: "Run?", message: "Confirm" });
	const results = await Promise.allSettled([broker.respond({ id: "q", confirmed: false }), broker.respond({ id: "q", confirmed: true })]);
	assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected"]);
	assert.deepEqual(sent, [{ type: "extension_ui_response", id: "q", confirmed: false }]);
	assert.equal(broker.list().length, 0);
	broker.dispose();
});

test("runtime cancellation rejects stale answers without affecting a newer question", async () => {
	const sent: RpcExtensionUIResponse[] = [];
	const broker = new BackendUiBroker(async response => { sent.push(response); }, () => {});
	broker.observe({ type: "extension_ui_request", method: "input", id: "old", title: "Old" });
	broker.observe({ type: "extension_ui_request", method: "cancel", id: "cancel", targetId: "old" });
	broker.observe({ type: "extension_ui_request", method: "input", id: "new", title: "New" });
	await assert.rejects(broker.respond({ id: "old", value: "stale" }), { code: "ui_request_expired" });
	await broker.respond({ id: "new", value: "current" });
	assert.deepEqual(sent, [{ type: "extension_ui_response", id: "new", value: "current" }]);
	broker.dispose();
});

test("invalid selections and answer types leave the pending question unanswered", async () => {
	const sent: RpcExtensionUIResponse[] = [];
	const broker = new BackendUiBroker(async response => { sent.push(response); }, () => {});
	broker.observe({ type: "extension_ui_request", method: "select", id: "q", title: "Select", options: ["A", "B"] });
	await assert.rejects(broker.respond({ id: "q", value: "C" }), { code: "invalid_ui_option" });
	await assert.rejects(broker.respond({ id: "q", confirmed: true }), { code: "invalid_ui_response" });
	assert.equal(sent.length, 0);
	assert.equal(broker.list().length, 1);
	broker.dispose();
});

test("a question timeout cancels rather than approving it", async () => {
	const delivered = Promise.withResolvers<RpcExtensionUIResponse>();
	const broker = new BackendUiBroker(async response => { delivered.resolve(response); }, () => {});
	broker.observe({ type: "extension_ui_request", method: "confirm", id: "q", title: "Confirm", message: "Never auto-approve", timeout: 1 });
	assert.deepEqual(await delivered.promise, { type: "extension_ui_response", id: "q", cancelled: true, timedOut: true });
	assert.equal(broker.list().length, 0);
	broker.dispose();
});

test("an uncertain UI write cannot be replaced by a conflicting second answer", async () => {
	let sends = 0;
	const broker = new BackendUiBroker(async () => { sends++; throw new Error("transport lost"); }, () => {});
	broker.observe({ type: "extension_ui_request", method: "confirm", id: "q", title: "Confirm", message: "Question" });
	await assert.rejects(broker.respond({ id: "q", confirmed: false }));
	await assert.rejects(broker.respond({ id: "q", confirmed: true }), { code: "ui_request_expired" });
	assert.equal(sends, 1);
	broker.dispose();
});
