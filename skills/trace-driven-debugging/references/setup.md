# Setup: runlens, MCP per agent, and fallbacks

## Install runlens

```sh
go install github.com/Abdalkaderdev/runlens@latest
runlens version
```

Needs Go 1.26+. The binary lands in `$(go env GOPATH)/bin`; make sure that is on `PATH`. Source and releases: https://github.com/Abdalkaderdev/runlens

## Start it

Put `runlens` in front of the dev command:

```sh
runlens npm run dev
runlens node --watch server.js
runlens uv run uvicorn main:app --reload --port 8000
runlens python manage.py runserver
runlens flask --app app run
```

Runtime is detected from the command name. Force it with `--runtime node` or `--runtime python` when a wrapper hides it (`make dev`, a shell script).

It prints:

```text
  runlens dev
  ui    http://127.0.0.1:4318
  mcp   http://127.0.0.1:4318/mcp
  otlp  http://127.0.0.1:4318 (http)  127.0.0.1:4317 (grpc)
```

If 4318 is taken it picks a free port and prints it; use that URL everywhere below. `runlens mcp` finds the most recent instance automatically.

Useful flags (before the command): `--no-open` (no browser, also implied when `CI` is set), `--slow 300ms` (request threshold), `--slow-query 50ms`, `--n1 3` (repeat count that counts as N+1), `--service api`.

Starting it from an agent: run it as a background process, then poll the app's URL until it answers. Stop it when finished. On Windows, killing `runlens.exe` with `taskkill /F` can leave the dev server child running on its port; stop that process too.

## Connect the MCP server

Two transports:

- Streamable HTTP: `http://127.0.0.1:4318/mcp`, available while runlens runs.
- stdio: `runlens mcp` (optionally `--url http://127.0.0.1:PORT`), which reads from a running runlens.

Use project scope so nothing changes in the user's global config. The server must be added before the agent session starts, or the session restarted afterwards.

### Claude Code

```sh
claude mcp add --transport http --scope project runlens http://127.0.0.1:4318/mcp
claude mcp add --scope project runlens -- runlens mcp
```

Both write `.mcp.json` at the project root. Options go before the server name; everything after `--` is the server command.

```json
{ "mcpServers": { "runlens": { "type": "http", "url": "http://127.0.0.1:4318/mcp" } } }
```

stdio form: `{ "mcpServers": { "runlens": { "type": "stdio", "command": "runlens", "args": ["mcp"] } } }`. An HTTP entry without `"type": "http"` is a configuration error.

For a one-off headless run without touching any config file, pass a config file to the session:

```sh
claude -p "why is GET /api/authors slow?" --mcp-config runlens.mcp.json --strict-mcp-config
```

`--strict-mcp-config` ignores every other configured server for that run.

### Codex CLI

```sh
codex mcp add runlens -- runlens mcp
codex mcp add runlens --url http://127.0.0.1:4318/mcp
```

`~/.codex/config.toml`, or `.codex/config.toml` in a trusted project:

```toml
[mcp_servers.runlens]
url = "http://127.0.0.1:4318/mcp"
```

stdio form:

```toml
[mcp_servers.runlens]
command = "runlens"
args = ["mcp"]
```

### Gemini CLI

```sh
gemini mcp add --transport http runlens http://127.0.0.1:4318/mcp
gemini mcp add runlens runlens mcp
```

`gemini mcp add` defaults to project scope (`.gemini/settings.json`); `--scope user` writes the global file. In `settings.json`, streamable HTTP uses `httpUrl`; `url` means the older SSE transport.

```json
{ "mcpServers": { "runlens": { "httpUrl": "http://127.0.0.1:4318/mcp" } } }
```

stdio form: `{ "mcpServers": { "runlens": { "command": "runlens", "args": ["mcp"] } } }`

### Cursor

`.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` globally):

```json
{ "mcpServers": { "runlens": { "url": "http://127.0.0.1:4318/mcp" } } }
```

stdio form: `{ "mcpServers": { "runlens": { "command": "runlens", "args": ["mcp"] } } }`

### Any other client

Configure `runlens mcp` as a stdio server.

## HTTP API without MCP

When the MCP tools are not connected and the session cannot be restarted, read the same data over plain HTTP:

| Endpoint | Equivalent |
| --- | --- |
| `GET /api/endpoints` | `slowest_endpoints` (all captured traces) |
| `GET /api/requests` | `list_requests` |
| `GET /api/traces/{id}` | `get_trace` |
| `GET /api/export` | raw spans |
| `POST /api/clear` | empty the buffer before a clean measurement |

```sh
curl -s http://127.0.0.1:4318/api/endpoints
curl -s -X POST http://127.0.0.1:4318/api/clear
```

The HTTP API has no `since` filter. Clear the buffer before the "after" run, or compare only traces newer than the fix.

## Fallback: no runlens injection

### The app already exports OpenTelemetry, or is not Node or Python

Start runlens on its own as a collector and point the app's exporter at it:

```sh
runlens --no-open
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_SERVICE_NAME=api ./your-app
```

gRPC exporters use `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4317` with `OTEL_EXPORTER_OTLP_PROTOCOL=grpc`. runlens accepts OTLP/HTTP protobuf, OTLP/HTTP JSON and OTLP/gRPC. All MCP tools then work the same way. Bun, Deno, Go, Java, .NET and Ruby apps go this route.

Manual auto-instrumentation if you are not using runlens injection:

```sh
node --require @opentelemetry/auto-instrumentations-node/register server.js
opentelemetry-instrument python app.py
```

### runlens cannot be installed

If the project already sends traces somewhere (Jaeger, Grafana Tempo, Honeycomb, Datadog, a local collector), use that backend's UI or API for the same loop: find the slow or failing endpoint, open one trace, read the spans, fix, compare. If nothing exports traces, fall back to measured evidence without tracing:

- Postgres: `log_min_duration_statement = 0` or `pg_stat_statements` to count queries per request.
- Django: `django.db.connection.queries` with `DEBUG=True`, or `assertNumQueries` in a test.
- SQLAlchemy: `echo=True` on the engine.
- Prisma: `log: ['query']` on the client.
- Time the request with `curl -w "%{time_total}"` before and after.

Say in the report that these numbers came from logs or timing, not traces.
