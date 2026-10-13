# trace-driven-debugging

An Agent Skill that makes coding agents debug from what your app actually did at runtime, not from what the code looks like it does.

[![CI](https://github.com/Abdalkaderdev/trace-driven-debugging/actions/workflows/ci.yml/badge.svg)](https://github.com/Abdalkaderdev/trace-driven-debugging/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Works with Claude Code, Codex, Gemini CLI and Cursor. Plain `SKILL.md` folder following the [Agent Skills specification](https://agentskills.io/specification). Free and MIT licensed.

## Why

Ask an agent why an endpoint is slow and it reads the handler, spots something that might be slow, and rewrites it. Sometimes that is the problem. Often it is not, and nobody measures either way.

This skill gives the agent a different routine: run the dev server under [runlens](https://github.com/Abdalkaderdev/runlens), send the real request, read the trace through MCP (every SQL statement, outbound call, timing and exception), fix the code the trace points at, send the same request again, and report the numbers from both runs.

## Demo

Real run, 2026-10-13. The `express-postgres` example from runlens (Express 5, `pg`, Postgres 17 in Docker) running under `runlens node --watch server.js`. Headless Claude Code with only this plugin and the runlens MCP server:

```sh
claude -p "The bookshop API in this folder is running at http://localhost:3100 under runlens (started as 'runlens node --watch server.js', so edits to server.js reload automatically; do not start or stop it). Users say GET /api/authors is slower than it should be. Find out why from runtime evidence, fix it without changing the response, and report before and after numbers." \
  --plugin-dir ./trace-driven-debugging --mcp-config runlens.mcp.json --strict-mcp-config
```

The prompt does not mention N+1, SQL or the skill. What the agent did, in order: loaded `trace-driven-debugging`, saved the current response, sent 20 requests, called `slowest_endpoints`, read `server.js`, made one edit, sent 20 more requests, called `slowest_endpoints` with `since` set to the time of the fix and `errors_since`. 12 turns, 62 seconds.

What runlens returned before the fix:

```json
{"endpoint":"GET /api/authors","count":21,"p50Ms":21.89,"p95Ms":49.45,"avgDbCalls":13,"dbShare":0.85,
 "nPlusOne":[{"statement":"SELECT id, title, price FROM books WHERE author_id = $1","count":12}],
 "hints":["N+1: \"SELECT id, title, price FROM books WHERE author_id = $1\" runs up to 12 times per request.",
          "85% of time is spent in the database (13.0 calls per request)."]}
```

The edit:

```diff
-  for (const author of authors) {
-    const { rows } = await pool.query('SELECT id, title, price FROM books WHERE author_id = $1', [author.id]);
-    author.books = rows;
-  }
+  const { rows: books } = await pool.query(
+    'SELECT author_id, id, title, price FROM books WHERE author_id = ANY($1) ORDER BY id',
+    [authors.map((a) => a.id)],
+  );
+  const byAuthor = new Map(authors.map((a) => [a.id, (a.books = [])]));
+  for (const { author_id, ...book } of books) byAuthor.get(author_id).push(book);
```

The agent's report:

| | before | after |
| --- | --- | --- |
| DB calls per request | 13 | 2 |
| p50 | 21.9 ms | 3.0 ms |
| p95 | 49.5 ms | 3.7 ms |
| max | 67.0 ms | 3.7 ms |

Response body byte-identical, no errors since the change. It also noted that requests during the reload were excluded, that the sample is small, and that it left the existing `/api/authors-fast` route alone because that one returns a different shape.

Independent check afterwards, 100 warm requests per version, buffer cleared between runs:

| | before | after |
| --- | --- | --- |
| DB calls per request | 13 | 2 |
| p50 | 14.5 ms | 3.4 ms |
| p95 | 24.1 ms | 5.7 ms |
| max | 53.2 ms | 8.8 ms |

The seed data has 12 authors. The old handler runs one query per author, so the gap grows with the table.

## Install

The skill needs runlens for its main path:

```sh
go install github.com/Abdalkaderdev/runlens@latest
```

Without runlens it falls back to any OpenTelemetry source, or to query logs and timing, and says so in its report.

### Claude Code

As a plugin:

```text
/plugin marketplace add Abdalkaderdev/trace-driven-debugging
/plugin install trace-driven-debugging@trace-driven-debugging
```

Manually:

```bash
git clone https://github.com/Abdalkaderdev/trace-driven-debugging.git
cp -r trace-driven-debugging/skills/trace-driven-debugging ~/.claude/skills/
```

Connect runlens for one project:

```sh
claude mcp add --transport http --scope project runlens http://127.0.0.1:4318/mcp
```

### Codex CLI

```bash
git clone https://github.com/Abdalkaderdev/trace-driven-debugging.git
mkdir -p ~/.agents/skills
cp -r trace-driven-debugging/skills/trace-driven-debugging ~/.agents/skills/
codex mcp add runlens --url http://127.0.0.1:4318/mcp
```

Project scope: `.agents/skills/` in the repository.

### Gemini CLI

```bash
gemini skills install https://github.com/Abdalkaderdev/trace-driven-debugging.git --path skills
gemini mcp add --transport http runlens http://127.0.0.1:4318/mcp
```

`gemini mcp add` writes to the project's `.gemini/settings.json` by default.

### Cursor

```bash
git clone https://github.com/Abdalkaderdev/trace-driven-debugging.git
mkdir -p ~/.cursor/skills
cp -r trace-driven-debugging/skills/trace-driven-debugging ~/.cursor/skills/
```

`.cursor/mcp.json` in the project:

```json
{ "mcpServers": { "runlens": { "url": "http://127.0.0.1:4318/mcp" } } }
```

Cursor also reads `~/.claude/skills` and `~/.agents/skills`. On Windows PowerShell, use `Copy-Item -Recurse` and `$HOME` in place of `cp -r` and `~`. stdio configs (`runlens mcp`) for every agent are in [setup.md](skills/trace-driven-debugging/references/setup.md).

## How it works

The skill is one `SKILL.md` with three reference files the agent opens when needed:

| File | Contents |
| --- | --- |
| [SKILL.md](skills/trace-driven-debugging/SKILL.md) | When to trace, start runlens, reproduce, read traces, hypothesis, fix, verify, report |
| [references/setup.md](skills/trace-driven-debugging/references/setup.md) | Install, flags, MCP config per agent, HTTP API without MCP, OTLP fallback |
| [references/n-plus-one.md](skills/trace-driven-debugging/references/n-plus-one.md) | Spotting N+1 in traces, fixes for raw SQL, Prisma, Drizzle, TypeORM, SQLAlchemy, Django |
| [references/recipes.md](skills/trace-driven-debugging/references/recipes.md) | Sequential outbound calls, one slow query, error triage, chatty services |

The loop:

1. Decide whether runtime evidence is needed. Slow, too many queries, 500s and "what does this request do" qualify. Type errors do not.
2. Attach to a running runlens, or start the dev server under it.
3. Reproduce: send the real request 20 times, or run the failing test.
4. `slowest_endpoints`, `errors_since` or `find_n_plus_one`, then `get_trace` on the trace it points at. `list_requests` and `service_map` for filtering and topology.
5. One-sentence hypothesis, then read only the code the trace implicates.
6. Fix by pattern.
7. Same request, same count. Compare with `since` set to the fix time so old traces do not dilute the result.
8. Report measured numbers from the same tool, before and after, with what was not verified.

## FAQ

**Does it work without runlens?** Yes, with less detail. If the app already exports OpenTelemetry, start `runlens` with no command and point `OTEL_EXPORTER_OTLP_ENDPOINT` at it; all MCP tools then work for any language. If nothing can be installed, the skill uses query logs (`pg_stat_statements`, Django `connection.queries`, SQLAlchemy `echo`, Prisma query logging) and `curl` timing, and labels the numbers as such.

**Which languages?** runlens injects instrumentation into Node.js and Python dev servers. Everything else goes through the OTLP route.

**Does it change my project?** The skill tells the agent not to add logging, timers or tracing code. runlens injects instrumentation from outside. The only files it may write are project-scope MCP configs, and only with your agreement.

**Is my data sent anywhere?** runlens listens on 127.0.0.1, keeps traces in memory, and redacts SQL literals and auth headers by default.

**The latency gain on my laptop is tiny. Was the fix worth it?** Look at queries per request. A dev database with a dozen rows hides an N+1 that costs thousands of round trips in production. The skill leads with the count for that reason.

**Why did the agent not touch my code?** If the trace does not support a hypothesis, the skill says to gather more evidence or ask instead of guessing.

## More from the author

- [runlens](https://github.com/Abdalkaderdev/runlens): the trace collector, UI and MCP server this skill drives.
- Paid skill packs for production work with coding agents: [agensi.io/creators/abdalkaderdev](https://www.agensi.io/creators/abdalkaderdev).

## Contributing

Issues and PRs welcome, especially recipes for other ORMs and runtimes. Claims about library APIs should link to the library's docs. Run `npm test` before opening a PR; CI runs the same check. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## License

[MIT](LICENSE)

## Author

Abdalkader Alhamoud · [abdalkader.dev](https://abdalkader.dev) · [github.com/Abdalkaderdev](https://github.com/Abdalkaderdev)
