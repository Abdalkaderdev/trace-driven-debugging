---
name: trace-driven-debugging
description: Debugs slow endpoints, N+1 queries, sequential outbound calls, chatty services and server errors from real runtime traces instead of guessing from code. Runs the dev server under runlens (or reads any OpenTelemetry source), reproduces the request, reads spans through the runlens MCP tools, fixes the code, re-runs and reports before and after numbers. Use when a request is slow, a page makes too many queries, an endpoint returns 500, latency regressed, or the user asks why something is slow or what a request actually does at runtime.
license: MIT
compatibility: Needs the runlens binary (Go 1.26+ to install) or another OTLP trace source, and a local dev server written in Node.js or Python, or any app that exports OpenTelemetry.
metadata:
  author: abdalkaderdev
  version: "0.1.0"
  homepage: https://github.com/Abdalkaderdev/trace-driven-debugging
---

# Trace-driven debugging

Code shows what a request might do. A trace shows what it did: every SQL statement, every outbound call, their order, their timing, and the exception that ended it. Debug from the trace, then read only the code the trace points at.

## When runtime evidence is needed

Get a trace before touching code when the problem is about behavior over time:

- "This endpoint is slow", "the page takes seconds", latency regressed after a change.
- Too many queries, suspected N+1, high database load from one route.
- A 500 or exception whose cause is not obvious from the message.
- A request that calls other services or APIs and you need to know which one is slow.
- The user asks what a request actually does.

Skip tracing for compile errors, type errors, failing pure unit tests, styling, and bugs the stack trace in front of you already explains.

## Step 1: get traces flowing

Check whether runlens is already running and the MCP tools are available. If the `list_requests` tool exists, call it with `limit: 1`. If it answers, go to step 2.

Otherwise start the dev server under runlens. Put `runlens` in front of the command the project already uses:

```sh
runlens npm run dev
runlens node server.js
runlens uv run uvicorn main:app --reload
runlens python manage.py runserver
```

Run it in the background so you keep control of the terminal, and wait until the app answers. Flags go before the command: `runlens --no-open --slow 300ms npm run dev`. Use `--no-open` when running headless. The first run per runtime installs OpenTelemetry packages into the user cache and can take up to a minute.

If `runlens` is not installed: `go install github.com/Abdalkaderdev/runlens@latest`. If Go is missing or the app is not Node or Python, see [references/setup.md](references/setup.md) for the OTLP fallback.

If the runlens MCP tools are not connected to your session, add the server for your agent with the snippets in [references/setup.md](references/setup.md). Prefer the HTTP endpoint `http://127.0.0.1:4318/mcp`; use `runlens mcp` (stdio) when the client cannot speak HTTP. Write to project scope, never to the user's global config unless they ask. A newly added MCP server usually needs a session restart; if you cannot restart, read the same data from the HTTP API in [references/setup.md](references/setup.md#http-api-without-mcp).

Prefer a dev command with file watching (`node --watch`, `--reload`, `next dev`) so fixes reload without restarting runlens. Traces survive child restarts; they are lost only when runlens itself stops.

## Step 2: reproduce the symptom

Traces only exist for requests that ran. Send the request that shows the problem, several times, so p50 and p95 mean something:

```sh
for i in $(seq 1 20); do curl -s -o /dev/null -w "%{http_code} %{time_total}\n" http://localhost:3000/api/orders; done
```

PowerShell:

```powershell
1..20 | % { (Measure-Command { Invoke-WebRequest http://localhost:3000/api/orders -UseBasicParsing | Out-Null }).TotalMilliseconds }
```

Use the real method, path, headers and body. For POST, send a realistic payload. If the bug shows up in a test, run that test while runlens is recording instead. If auth is required, ask the user for a dev token or use the project's seed user; do not disable auth.

## Step 3: read the traces

Work top-down. Each tool narrows the next call.

| Question | Tool | Key inputs |
| --- | --- | --- |
| Which endpoints are slow and why? | `slowest_endpoints` | `since`, `limit` |
| Which requests failed? | `errors_since` | `since` (`10m` or RFC3339) |
| Which routes repeat a query? | `find_n_plus_one` | `endpoint` |
| What did one request do? | `get_trace` | `trace_id` |
| Which requests match a filter? | `list_requests` | `endpoint`, `errors_only`, `min_duration_ms`, `limit` |
| What talks to what? | `service_map` | none |

Starting point by symptom:

- Slow: `slowest_endpoints`. Read `p50Ms`, `p95Ms`, `avgDbCalls`, `dbShare`, `nPlusOne`, `hints`, then `get_trace` on `slowestTraceId`.
- Errors: `errors_since` with `since: "15m"`. Each item has the message, stack and trace id. Then `get_trace`.
- Too many queries: `find_n_plus_one`, then `get_trace` on `example_trace_id`.
- Unknown: `list_requests` with `min_duration_ms` or `errors_only`, then `get_trace`.

Reading a `get_trace` result:

- `spans` are in tree order with `depth`, `offset_ms` and `duration_ms`. Spans that start one after another with no overlap ran sequentially.
- `statement` is the SQL with literals redacted (`?` or `$1`). The same statement many times at increasing offsets is a loop.
- `peer` is the external host. `error` and `stack` hold the exception. `slow` and `n_plus_one` mark the spans that matter.
- `db_calls`, `db_ms`, `external_calls` and `duration_ms` at the top are the numbers to quote.
- `hints` are runlens's own diagnosis. Treat them as leads, then confirm in the spans.

## Step 4: hypothesis, then code

Write one sentence before editing: "`GET /api/authors` runs `SELECT ... FROM books WHERE author_id = $1` 12 times per request because it queries inside a loop over authors."

Then find the code. Search for the route string (`'/api/authors'`, `@app.get("/products")`) and for a distinctive fragment of the statement or the host from `peer`. The stack in an error span names the file and line. Read only what the trace implicates.

If the trace does not support a hypothesis, do not invent one. Add a request with different inputs, compare a fast and a slow trace of the same endpoint, or ask the user.

## Step 5: fix by pattern

| Pattern in the trace | Fix | Recipe |
| --- | --- | --- |
| Same statement N times per request | Batch: join, `IN`/`ANY`, or ORM eager loading | [references/n-plus-one.md](references/n-plus-one.md) |
| Outbound calls back to back, no overlap | Run concurrently, cache, set timeouts | [references/recipes.md](references/recipes.md#slow-outbound-calls) |
| One query with large `duration_ms` | Index, limit columns, paginate | [references/recipes.md](references/recipes.md#one-slow-query) |
| Exception span, 5xx | Read message and stack, fix the cause | [references/recipes.md](references/recipes.md#error-triage) |
| Many calls to one internal service | Batch endpoint, cache, move work | [references/recipes.md](references/recipes.md#chatty-services) |

Keep the response shape identical unless the user asked to change it. Diff the JSON before and after when the fix changes how data is loaded.

## Step 6: verify with the same request

1. Note the time just before the fix is live (RFC3339, e.g. `2026-10-13T14:05:00Z`), or wait for the watcher to reload.
2. Send the same request the same number of times as in step 2.
3. Call `slowest_endpoints` with `since` set to that time, or `list_requests` with the `endpoint` filter and look at the newest rows. Without `since`, the aggregate mixes old and new traces.
4. `get_trace` on one new trace and confirm the pattern is gone, not just smaller.
5. Check the response body is unchanged and nothing new appears in `errors_since`.

If the numbers did not move, the fix missed. Go back to step 3 with the new trace.

## Step 7: report with real numbers

Report only measured values, from the same tool, before and after:

```text
GET /api/authors had an N+1: SELECT id, title, price FROM books WHERE author_id = $1 ran 12 times per request.
Fixed in server.js by loading all books with WHERE author_id = ANY($1) and grouping them in memory.

                before   after    (21 requests each, runlens slowest_endpoints)
DB calls/req    13       2
p50             21.9 ms  3.0 ms
p95             49.5 ms  3.7 ms
Response body byte-identical. No new errors.
```

Say what was measured and how (request count, tool). Do not round in your favor, do not extrapolate to production, and say so if the local sample is too small to be confident. If something was not verified, name it.

## Rules

- Evidence first. No performance claim without a trace or a measurement behind it.
- Reproduce before and after with the same request, the same count, the same data.
- Do not add instrumentation code, logging, or timers to the project to debug; runlens injects tracing from outside.
- Do not commit generated config such as `.mcp.json` unless the user wants it.
- SQL in traces is redacted by default. Do not turn on `--show-values` unless the user asks; it exposes literals and auth headers.
- Stop the runlens process you started when you are done, unless the user wants it kept running. Stopping runlens may leave the dev server child running; stop that too.
