# Shared backend (experimental, opt-in)

`omp server serve` runs a loopback HTTP service that owns agent sessions independently
of its clients. Several CLI or SDK clients can read and prompt the same session.
Closing a client, cancelling a long poll, or pressing Ctrl-C in `server events`
does not stop that session. Explicit `server abort`, `server close`, or stopping
the server does.

This is an initial shared-backend implementation inspired by the lifecycle in
[OpenCode 2](https://opencode.ai/v2/docs), not API compatibility or full feature
parity. It does **not** replace the default OMP TUI, implement a remote native TUI,
automatically spawn/discover a daemon, restore live sessions after server restart,
or provide multi-user isolation. Collab and existing standalone/RPC modes are unchanged.
The server runs one configured workspace/profile; separate servers may serve others.

## Start and connect

Use a long random secret, supplied in the environment rather than argv. For example,
generate it once with `openssl rand -hex 32`, then supply the same value to the
server and each trusted client. Do not commit it or put it into links.

```sh
export OMP_SERVER_TOKEN='<the-generated-secret>'
omp server serve --cwd /absolute/path/to/project --port 7467
```

The server runs in the foreground and prints its URL and instance epoch, never the
secret. Keep this process alive in a separate terminal or your process supervisor.
`--port 0` selects an available port; copy the printed URL into `OMP_SERVER_URL` for
clients. Binding conflicts fail rather than replacing another server.

In another terminal, with the same token:

```sh
export OMP_SERVER_URL=http://127.0.0.1:7467
omp server new                         # returns a backend session ID in JSON
omp server list
omp server events <session-id>         # JSONL events; Ctrl-C detaches only
```

Then from another connected terminal:

```sh
omp server prompt <session-id> --message 'Explain the entry point'
omp server state <session-id>
omp server messages <session-id> --limit 64
omp server abort <session-id>
omp server close <session-id>
```

Provider/model overrides apply at creation: `omp server new --provider <provider>
--model <model>`. Provider authentication and tools run on the server machine with
its selected profile and workspace settings. The backend's own token is removed
from worker environments. This is not a tool sandbox.

`prompt` prints a caller retry ID **before** sending the request and returns the
RPC prompt ID after admission. Admission is not completion: observe `prompt_result`
and, for work that can wake the agent again, `session_settled` in the event stream.
A connection failure is never an instruction to repeat the prompt with a new ID.
To recover a lost acknowledgement while the same backend/session is alive, repeat
the identical message with the printed `--request-id`. Different text with that
ID is rejected. Failed/uncertain outcomes are also retained, not re-executed.

## Interactive questions

`omp server ui <session-id>` lists pending extension/tool dialogs, including those
raised during startup. All authenticated clients have owner-level authority.

```sh
omp server respond <session-id> --request-id <question-id> --answer false
omp server respond <session-id> --request-id <question-id> --value 'an offered option'
omp server respond <session-id> --request-id <question-id> --cancel
```

Exactly one answer is accepted. Runtime cancellation, an expired request, or a
competing first answer invalidates the old ID. Dialogs survive client disconnects;
no disconnect implicitly approves them. A requested timeout is honored up to a
five-minute maximum; without a timeout, five minutes is used. Timeout/overflow
cancels rather than approves. There are at most 32 pending dialogs per runtime,
each at most 64 KiB. This timeout policy is new to the opt-in backend.

## HTTP contract

Every endpoint requires `Authorization: Bearer <token>`. First call `GET /v1/status`
and check `version: 1`. Supply its `epoch` as `X-OMP-Backend-Epoch` on all other
requests. A restarted server rejects the old epoch with `409 epoch_mismatch`.
The SDK performs this handshake without falling back to a local agent.

| Method/path | Behavior |
| --- | --- |
| `GET /v1/status` | Protocol version and backend epoch |
| `GET /v1/sessions` | List backend-owned sessions |
| `POST /v1/sessions` | Create; JSON accepts optional `provider`, `model`; returns 202 with a starting session |
| `GET /v1/sessions/:id` | Lifecycle info and current event cursor |
| `DELETE /v1/sessions/:id` | Explicitly stop and remove the live runtime |
| `GET /v1/sessions/:id/state` | Current RPC state and an early replay cursor |
| `GET /v1/sessions/:id/messages?cursor=...&limit=64` | Underlying RPC's stable transcript page; up to 128 messages |
| `POST /v1/sessions/:id/prompt` | JSON `{requestId,message}`; 202 acknowledges RPC admission |
| `POST /v1/sessions/:id/abort` | JSON `{}`; interrupt independently of prompt admission |
| `GET /v1/sessions/:id/events?after=N&wait=25000` | Bounded JSON event page; long-poll for up to 25 seconds |
| `GET /v1/sessions/:id/ui` | Pending dialogs, including startup questions |
| `POST /v1/sessions/:id/ui` | JSON `{id,value}`, `{id,confirmed}`, or `{id,cancelled:true}` |

Long polling is intentional in this first adapter; there is no SSE/WebSocket
endpoint. JSON POST bodies are limited to 64 KiB, must arrive within ten seconds,
and reject unknown fields. The listener binds only `127.0.0.1`. Foreign Host headers,
all browser Origin headers, and cross-site browser requests are refused. No CORS
access is granted. Do not publish the endpoint through an unauthenticated proxy.
A bearer token grants the ability to run tools as the server account, not read-only access.

The fetch-compatible handler and `SharedBackendClient` are in
`packages/coding-agent/src/shared-backend/`. They are internal source APIs, not yet
new package-root SDK exports.

## Replay, limits, and persistence

Events carry a monotonically increasing sequence per session. The journal retains
at most 512 events and 2 MiB. An old cursor, including one that crossed an oversized
event, gets `410 replay_expired`; it never silently becomes a complete replay.
Refresh state/transcript and pending UI before reconnecting. Capture an early
cursor, read state/transcript, then replay from it. State and transcript are **not
an atomic snapshot**: reconcile overlaps by the existing RPC message IDs and retry
pagination when the underlying RPC reports a stale cursor. The backend does not
promise gap-free reconstruction while a transcript is changing continuously.

The host limits sessions to 16, pending prompt admissions to 32 per session, and
waiting event readers to 32 per session. The prompt dedupe ledger holds at most
1024 requests and 2 MiB of message text per session; it refuses new requests when
full rather than forgetting IDs. This deliberately favors avoiding duplicate
external effects over indefinite operation. Close/create another session at the
limit; automatic transcript continuation is not implemented.

Each new session gets an exclusive randomly named directory under the selected
agent directory's `shared-backend-sessions/`, and its normal RPC runtime persists
transcripts there. Clients cannot choose arbitrary session files or switch an
owned runtime into another persisted session through this API. Do not manually
open a live backend transcript in another writer. On server exit the runtimes
are reaped; transcript files remain, but the registry, replay, and request ledger
are **not** restored. Resuming persisted transcripts is a separate, explicit
standalone workflow after the old runtime has stopped.

## Verification and rollout gates

Run these in a full development checkout:

```sh
bun test packages/coding-agent/test/shared-backend-*.test.ts
bun --cwd=packages/coding-agent run check
```

Before considering the drafts ready, launch a real server with configured model
credentials, attach two clients, prompt from one and watch both, disconnect the
originator during a tool call, answer a question from the other client, reconnect,
and exercise abort/close/SIGTERM. Repeat with source, npm-bundle and compiled
installs. Check profile selection and provider auth, worker exit, transcript
pagination/replay gaps, and existing standalone/RPC/Collab regressions.

The authoring environment ran the dependency-free host/HTTP/client/UI contract
tests under Node after TypeScript transpilation and changing only test-runner
imports. That does not verify Bun sockets, the native RPC worker, the CLI parser,
full repository types/lint, model-provider calls, or packaged installs. Those are
explicit outstanding gates, not checked boxes.
