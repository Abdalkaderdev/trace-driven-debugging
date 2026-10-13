# Marketplace listing

## Title

Trace-Driven Debugging

## One-line pitch

Free skill that makes your coding agent debug slow endpoints, N+1 queries and 500s from real runtime traces, then prove the fix with before and after numbers.

## Description

Ask an agent why an endpoint is slow and it reads the code, guesses, and rewrites something. Nobody measures before or after. The N+1 hiding in a serializer, the three API calls that run one after another, the exception two layers below the one in the log: these are visible in a trace and easy to miss in code.

This skill gives the agent a fixed routine built on [runlens](https://github.com/Abdalkaderdev/runlens), a local OpenTelemetry collector with an MCP server:

- Decide whether the problem needs runtime evidence at all.
- Start the dev server under runlens (`runlens npm run dev`, `runlens uvicorn main:app --reload`) or attach to one that is running, and connect the MCP server for Claude Code, Codex, Gemini CLI or Cursor.
- Reproduce the request so traces exist.
- Read them with `slowest_endpoints`, `errors_since`, `find_n_plus_one`, `get_trace`, `list_requests` and `service_map`.
- Write a hypothesis, read only the code the trace points at, fix it.
- Re-run the same request, compare with a `since` window so old traces do not dilute the result, and report measured numbers.

Recipes cover N+1 fixes for raw SQL, Prisma (`include`, `relationLoadStrategy`), Drizzle relational queries, TypeORM `relations` and `leftJoinAndSelect`, SQLAlchemy `selectinload` and `joinedload`, Django `select_related` and `prefetch_related`, plus sequential outbound calls, single slow queries, error triage and chatty services.

No runlens? The skill falls back to any OTLP source via `OTEL_EXPORTER_OTLP_ENDPOINT`, or to query logs and timing, and labels those numbers as such.

Free, MIT licensed. Source: https://github.com/Abdalkaderdev/trace-driven-debugging

## Tags

debugging, performance, opentelemetry, tracing, n-plus-one, mcp, runlens, prisma, sqlalchemy, django, node, python

## Suggested price

Free.

## Compatibility

Claude Code (skill folder or plugin), Codex CLI, Gemini CLI, Cursor. runlens injects tracing into Node.js and Python dev servers; other runtimes work through OTLP export. runlens needs Go 1.26+ to install.

## Author

Abdalkader Alhamoud, https://abdalkader.dev, https://github.com/Abdalkaderdev

## Demo

Request, sent to headless Claude Code with this skill and the runlens MCP server, against the runlens `express-postgres` example app (Express 5, `pg`, Postgres 17) running under `runlens node --watch server.js`:

> The bookshop API in this folder is running at http://localhost:3100 under runlens. Users say GET /api/authors is slower than it should be. Find out why from runtime evidence, fix it without changing the response, and report before and after numbers.

The agent loaded the skill, saved the current response, sent 20 requests and called `slowest_endpoints`. runlens returned:

```json
{"endpoint":"GET /api/authors","count":21,"p50Ms":21.89,"p95Ms":49.45,"avgDbCalls":13,"dbShare":0.85,
 "nPlusOne":[{"statement":"SELECT id, title, price FROM books WHERE author_id = $1","count":12}],
 "hints":["N+1: \"SELECT id, title, price FROM books WHERE author_id = $1\" runs up to 12 times per request."]}
```

It read `server.js`, found the query inside the loop over authors, and replaced it:

```js
const { rows: books } = await pool.query(
  'SELECT author_id, id, title, price FROM books WHERE author_id = ANY($1) ORDER BY id',
  [authors.map((a) => a.id)],
);
const byAuthor = new Map(authors.map((a) => [a.id, (a.books = [])]));
for (const { author_id, ...book } of books) byAuthor.get(author_id).push(book);
```

Then it sent the same 20 requests, called `slowest_endpoints` with `since` set to the time of the fix and `errors_since`, and reported (lightly trimmed):

> I fixed `GET /api/authors`. It was running one books query per author, 12 per request, inside the loop at `server.js:32`. It now loads all the books in one `WHERE author_id = ANY($1)` query and groups them in memory. The response body is byte-identical to the one I saved before the change.
>
> | | before | after |
> |---|---|---|
> | DB calls/req | 13 | 2 |
> | p50 | 21.9 ms | 3.0 ms |
> | p95 | 49.5 ms | 3.7 ms |
> | max | 67.0 ms | 3.7 ms |
>
> Errors: none since the change. A few requests that hit the server while it was reloading are not in the "after" numbers. This is a small local sample; with more authors the old version would get slower, one extra query per author.

12 turns, 62 seconds. An independent re-measurement over 100 warm requests per version gave 13 to 2 queries, p50 14.5 to 3.4 ms, p95 24.1 to 5.7 ms.
