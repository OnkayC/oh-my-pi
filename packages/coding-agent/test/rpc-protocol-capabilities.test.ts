import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { RpcCapabilitySelection, resolveRpcAuthProviderStatus } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcSemanticCapabilities } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { isRecord, readJsonl, removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const FULL_METADATA_CAPABILITIES: RpcSemanticCapabilities = {
	runtimePolicy: 1,
	authStatus: 1,
	modelCatalog: 1,
	slashCommands: 1,
	skills: 1,
	tasks: 1,
	subagents: 1,
};

async function withFakeRpcServer(
	ready: object,
	handler: string,
	run: (client: RpcClient) => Promise<void>,
	capabilities?: RpcSemanticCapabilities | false,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-capabilities-${Snowflake.next()}-`));
	const cliPath = path.join(dir, "server.ts");
	await Bun.write(
		cliPath,
		`import * as readline from "node:readline";\n` +
			`const ready = ${JSON.stringify(ready)};\n` +
			`process.stdout.write(JSON.stringify(ready) + "\\n");\n` +
			`const input = readline.createInterface({ input: process.stdin });\n` +
			`for await (const line of input) {\n` +
			`  const command = JSON.parse(line);\n` +
			`${handler}\n` +
			`}\n`,
	);
	const client = new RpcClient({ cliPath, capabilities });
	try {
		await client.start();
		await run(client);
	} finally {
		await client.stop();
		await removeWithRetries(dir);
	}
}

function respond(command: string, data: string): string {
	return `  if (command.type === ${JSON.stringify(command)}) { process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: ${data} }) + "\\n"); continue; }`;
}

type NativeRpcHarness = {
	send: (frame: object) => Promise<void>;
	nextFrame: () => Promise<Record<string, unknown>>;
	nextMatching: (predicate: (frame: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
};

async function withNativeRpcServer(run: (harness: NativeRpcHarness) => Promise<void>): Promise<void> {
	const cliPath = path.join(import.meta.dir, "..", "src", "cli.ts");
	const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-native-${Snowflake.next()}-`));
	const child = Bun.spawn(
		["bun", cliPath, "--mode", "rpc", "--provider", "anthropic", "--model", "claude-sonnet-4-5"],
		{
			cwd: path.join(import.meta.dir, ".."),
			env: { ...Bun.env, PI_CODING_AGENT_DIR: sessionDir, PI_NO_TITLE: "1" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const frames = readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)[Symbol.asyncIterator]();
	const nextFrame: NativeRpcHarness["nextFrame"] = async () => {
		for (;;) {
			const next = await frames.next();
			if (next.done) throw new Error("OMP RPC stdout closed before the expected frame");
			if (isRecord(next.value)) return next.value;
		}
	};
	const nextMatching: NativeRpcHarness["nextMatching"] = async predicate => {
		for (;;) {
			const frame = await nextFrame();
			if (predicate(frame)) return frame;
		}
	};
	const send: NativeRpcHarness["send"] = async frame => {
		child.stdin.write(`${JSON.stringify(frame)}\n`);
		await child.stdin.flush();
	};

	try {
		expect(await nextMatching(frame => frame.type === "ready")).toMatchObject({ type: "ready" });
		await run({ send, nextFrame, nextMatching });
	} finally {
		child.stdin.end();
		child.kill();
		await child.exited.catch(() => {});
		await removeWithRetries(sessionDir);
	}
}

describe("RPC semantic capability negotiation", () => {
	test("selects only known offered revisions and ignores unknown keys", () => {
		const selection = new RpcCapabilitySelection({ runtimePolicy: 2, authStatus: 1, futureFeature: 9 });
		expect(selection.has("runtimePolicy")).toBe(false);
		const selected = selection.select({ runtimePolicy: 1, authStatus: 3, skills: 1, futureFeature: 4 });

		expect(selected).toEqual({ runtimePolicy: 1, authStatus: 1 });
		expect(selection.has("runtimePolicy", 1)).toBe(true);
		expect(selection.has("runtimePolicy", 2)).toBe(false);
		expect(selection.has("skills", 1)).toBe(false);
	});

	test("prefers effective external credentials over stale stored-account status", () => {
		const staleAccounts = [
			{ type: "oauth" as const, status: "expired" as const },
			{ type: "api_key" as const, status: "error" as const },
		];
		expect(
			resolveRpcAuthProviderStatus({
				credentialOrigin: { kind: "runtime" },
				accounts: staleAccounts,
				hasDisabledCredentials: true,
			}),
		).toBe("authenticated");
		expect(
			resolveRpcAuthProviderStatus({
				credentialOrigin: { kind: "oauth" },
				accounts: staleAccounts,
				hasDisabledCredentials: true,
			}),
		).toBe("expired");
	});

	test("does not consume negotiation when the first capability payload is invalid", async () => {
		const selection = new RpcCapabilitySelection({ planReview: 1 });
		expect(() => selection.select(null)).toThrow("RPC semantic capabilities must be a non-null object");
		expect(selection.select({ planReview: 1 })).toEqual({ planReview: 1 });

		await withNativeRpcServer(async ({ send, nextMatching }) => {
			const request = async (frame: Record<string, unknown> & { id: string }) => {
				await send(frame);
				return await nextMatching(candidate => candidate.type === "response" && candidate.id === frame.id);
			};

			expect(
				await request({ id: "invalid-capabilities", type: "negotiate_capabilities", capabilities: null }),
			).toMatchObject({
				command: "negotiate_capabilities",
				success: false,
				error: "RPC semantic capabilities must be a non-null object",
			});
			expect(
				await request({
					id: "valid-capabilities",
					type: "negotiate_capabilities",
					capabilities: { planReview: 1 },
				}),
			).toMatchObject({
				command: "negotiate_capabilities",
				success: true,
				data: { capabilities: { planReview: 1 } },
			});
		});
	}, 30000);

	test("rejects renegotiation without replacing the selected capability set", async () => {
		const selection = new RpcCapabilitySelection({ planReview: 1, structuredApprovals: 1 });
		expect(selection.select({ planReview: 1 })).toEqual({ planReview: 1 });
		expect(() => selection.select({})).toThrow("RPC semantic capabilities were already negotiated");
		expect(selection.selected).toEqual({ planReview: 1 });

		await withNativeRpcServer(async ({ send, nextMatching }) => {
			const request = async (frame: Record<string, unknown> & { id: string }) => {
				await send(frame);
				return await nextMatching(candidate => candidate.type === "response" && candidate.id === frame.id);
			};

			expect(
				await request({
					id: "first-capabilities",
					type: "negotiate_capabilities",
					capabilities: { planReview: 1 },
				}),
			).toMatchObject({ success: true, data: { capabilities: { planReview: 1 } } });
			expect(
				await request({ id: "second-capabilities", type: "negotiate_capabilities", capabilities: {} }),
			).toMatchObject({
				success: false,
				error: "RPC semantic capabilities were already negotiated",
			});
			expect(await request({ id: "state-after-rejection", type: "get_state" })).toMatchObject({
				success: true,
				data: { pendingPlanReviews: [] },
			});
		});
	}, 30000);

	test("journals durable fast and rename builtins once and rejects other durable local commands", async () => {
		await withNativeRpcServer(async ({ send, nextFrame, nextMatching }) => {
			const request = async (frame: Record<string, unknown> & { id: string }) => {
				await send(frame);
				return await nextMatching(candidate => candidate.type === "response" && candidate.id === frame.id);
			};

			expect(
				await request({
					id: "host-turn-capability",
					type: "negotiate_capabilities",
					capabilities: { hostTurns: 1 },
				}),
			).toMatchObject({ success: true, data: { capabilities: { hostTurns: 1 } } });

			await send({ id: "fast-first", type: "prompt", message: "/fast", clientTurnId: "builtin-fast" });
			expect(await nextFrame()).toMatchObject({ type: "command_output", text: "Fast mode enabled." });
			expect(await nextFrame()).toMatchObject({
				id: "fast-first",
				type: "response",
				command: "prompt",
				success: true,
				data: { agentInvoked: false },
			});

			await send({ id: "fast-retry", type: "prompt", message: "/fast", clientTurnId: "builtin-fast" });
			expect(await nextFrame()).toMatchObject({ id: "fast-retry", type: "response", success: true });
			expect(await request({ id: "fast-state", type: "get_state" })).toMatchObject({
				data: { fastModeEnabled: true },
			});

			await send({
				id: "rename-first",
				type: "prompt",
				message: "/rename Durable RPC",
				clientTurnId: "builtin-rename",
			});
			expect(await nextFrame()).toMatchObject({ type: "session_info_update", title: "Durable RPC" });
			expect(await nextFrame()).toMatchObject({ type: "command_output", text: "Session renamed to Durable RPC." });
			expect(await nextFrame()).toMatchObject({ id: "rename-first", type: "response", success: true });

			await send({
				id: "rename-retry",
				type: "prompt",
				message: "/rename Durable RPC",
				clientTurnId: "builtin-rename",
			});
			expect(await nextFrame()).toMatchObject({ id: "rename-retry", type: "response", success: true });
			expect(await request({ id: "rename-state", type: "get_state" })).toMatchObject({
				data: { sessionName: "Durable RPC" },
			});

			expect(
				await request({ id: "model-durable", type: "prompt", message: "/model", clientTurnId: "builtin-model" }),
			).toMatchObject({ success: false, code: "durable_builtin_not_supported" });
			expect(await request({ id: "durable-turns", type: "get_turns" })).toMatchObject({
				success: true,
				data: {
					turns: [
						{ clientTurnId: "builtin-fast", kind: "prompt", status: "settled", outcome: "completed" },
						{ clientTurnId: "builtin-rename", kind: "prompt", status: "settled", outcome: "completed" },
					],
				},
			});
		});
	}, 30000);

	test("legacy ready frames remain valid and do not trigger semantic negotiation", async () => {
		await withFakeRpcServer(
			{ type: "ready" },
			`  process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "unexpected command" }) + "\\n");`,
			async client => {
				expect(client.offeredCapabilities).toEqual({});
				expect(client.selectedCapabilities).toEqual({});
			},
		);
	});

	test("preserves legacy follow-up and subagent commands until capabilities are explicitly negotiated", async () => {
		await withNativeRpcServer(async ({ send, nextMatching }) => {
			const request = async (frame: Record<string, unknown> & { id: string }) => {
				await send(frame);
				return await nextMatching(candidate => candidate.type === "response" && candidate.id === frame.id);
			};

			expect(await request({ id: "protocol-v2", type: "negotiate_protocol", protocolVersion: 2 })).toMatchObject({
				command: "negotiate_protocol",
				success: true,
				data: { protocolVersion: 2 },
			});

			expect(
				await request({ id: "legacy-follow-up", type: "follow_up", message: "queued by a v2 client" }),
			).toMatchObject({
				command: "follow_up",
				success: true,
			});
			expect(
				await request({ id: "legacy-subscription", type: "set_subagent_subscription", level: "progress" }),
			).toMatchObject({ command: "set_subagent_subscription", success: true, data: { level: "progress" } });
			expect(await request({ id: "legacy-subagents", type: "get_subagents" })).toMatchObject({
				command: "get_subagents",
				success: true,
				data: { subagents: [] },
			});
			expect(
				await request({
					id: "legacy-subagent-messages",
					type: "get_subagent_messages",
					sessionFile: path.join(os.tmpdir(), `missing-subagent-${Snowflake.next()}.jsonl`),
				}),
			).toMatchObject({ command: "get_subagent_messages", success: false, error: "Unknown subagent session file" });

			expect(
				await request({ id: "negotiate-empty", type: "negotiate_capabilities", capabilities: {} }),
			).toMatchObject({ command: "negotiate_capabilities", success: true, data: { capabilities: {} } });
			expect(
				await request({
					id: "enhanced-follow-up",
					type: "follow_up",
					message: "durable host turn",
					clientTurnId: "turn-1",
					optionFingerprint: "options-1",
				}),
			).toMatchObject({ command: "follow_up", success: false, code: "capability_not_selected" });

			for (const frame of [
				{ id: "negotiated-subscription", type: "set_subagent_subscription", level: "events" },
				{ id: "negotiated-subagents", type: "get_subagents" },
				{
					id: "negotiated-subagent-messages",
					type: "get_subagent_messages",
					sessionFile: "/tmp/subagent.jsonl",
				},
			]) {
				expect(await request(frame)).toMatchObject({
					command: frame.type,
					success: false,
					code: "capability_not_selected",
				});
			}
		});
	}, 30000);

	test("requires planReview before planControl can activate plan mode", async () => {
		await withNativeRpcServer(async ({ send, nextMatching }) => {
			const request = async (frame: Record<string, unknown> & { id: string }) => {
				await send(frame);
				return await nextMatching(candidate => candidate.type === "response" && candidate.id === frame.id);
			};

			expect(
				await request({
					id: "plan-control-only",
					type: "negotiate_capabilities",
					capabilities: { planControl: 1 },
				}),
			).toMatchObject({
				command: "negotiate_capabilities",
				success: true,
				data: { capabilities: { planControl: 1 } },
			});
			expect(await request({ id: "activate-plan", type: "set_plan_mode", status: "active" })).toMatchObject({
				command: "set_plan_mode",
				success: false,
				code: "capability_not_selected",
				error: "planReview capability was not selected",
			});
		});
	}, 30000);

	test("negotiates a requested subset and exposes typed metadata APIs", async () => {
		const handler = [
			respond("negotiate_protocol", `{ protocolVersion: 2 }`),
			respond(
				"negotiate_capabilities",
				`{ capabilities: { runtimePolicy: 1, authStatus: 1, modelCatalog: 1, skills: 1 } }`,
			),
			respond("set_runtime_policy", `{ approvalMode: command.approvalMode }`),
			respond(
				"get_auth_status",
				`{ providers: [{ provider: "anthropic", status: "authenticated", accounts: [{ type: "oauth", status: "authenticated", email: "dev@example.com" }] }] }`,
			),
			respond(
				"get_available_models",
				`{ models: [{ provider: "anthropic", id: "claude", name: "Claude", contextWindow: 200000, input: ["text"], reasoning: true, thinkingEfforts: ["low", "high"], fastModeSupported: true }] }`,
			),
			respond(
				"get_available_skills",
				`{ skills: [{ name: "reviewer", description: "Review code", source: "project" }] }`,
			),
			`  if (command.type === "prompt") { process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true }) + "\\n"); process.stdout.write(JSON.stringify({ type: "future_notification", value: 42 }) + "\\n"); continue; }`,
		].join("\n");
		const requested = {
			runtimePolicy: 1,
			authStatus: 1,
			modelCatalog: 1,
			skills: 1,
		} satisfies RpcSemanticCapabilities;
		await withFakeRpcServer(
			{
				type: "ready",
				protocolVersion: 1,
				supportedProtocolVersions: [1, 2],
				maxFrameBytes: 1024 * 1024,
				maxReassembledFrameBytes: 128 * 1024 * 1024,
				capabilities: FULL_METADATA_CAPABILITIES,
			},
			handler,
			async client => {
				expect(client.offeredCapabilities).toEqual(FULL_METADATA_CAPABILITIES);
				expect(client.selectedCapabilities).toEqual(requested);
				expect(await client.setRuntimePolicy("write")).toEqual({ approvalMode: "write" });
				expect((await client.getAuthStatus()).providers[0]?.accounts[0]?.email).toBe("dev@example.com");
				const models = await client.getAvailableModels();
				expect(models[0]?.thinkingEfforts).toEqual([Effort.Low, Effort.High]);
				expect(models[0]?.fastModeSupported).toBe(true);
				expect(await client.getAvailableSkills()).toEqual([
					{ name: "reviewer", description: "Review code", source: "project" },
				]);
				const unknown = Promise.withResolvers<object>();
				const unsubscribe = client.onUnknownNotification(frame => unknown.resolve(frame));
				await client.prompt("emit future notification");
				expect(await unknown.promise).toEqual({ type: "future_notification", value: 42 });
				unsubscribe();
			},
			requested,
		);
	});
});
