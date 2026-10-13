# Recipes: outbound calls, slow queries, errors, chatty services

N+1 queries have their own file: [n-plus-one.md](n-plus-one.md).

## Slow outbound calls

### Spot it

- `slowest_endpoints` hint: `3 outbound calls (registry.npmjs.org) run sequentially; run them concurrently.`
- In `get_trace`, spans with a `peer` whose `offset_ms` starts after the previous one ends. Request duration close to the sum of their durations.
- `service_map` shows the external host, call count and average latency per endpoint.

### Fix 1: run independent calls concurrently

Only when no call needs the result of another.

Node:

```js
const names = ['express', 'pg', 'fastify'];
const versions = await Promise.all(
  names.map(async (name) => {
    const r = await fetch(`https://registry.npmjs.org/${name}/latest`, { signal: AbortSignal.timeout(3000) });
    return [name, (await r.json()).version];
  }),
);
const out = Object.fromEntries(versions);
```

Use `Promise.allSettled` when one failure should not fail the whole request.

Python (async handler):

```python
async with httpx.AsyncClient(timeout=3.0) as client:
    responses = await asyncio.gather(*(client.get(f"https://pypi.org/pypi/{n}/json") for n in names))
```

Python (sync handler): `concurrent.futures.ThreadPoolExecutor().map(fetch, names)`.

Database work that does not depend on the outbound calls can run alongside them in the same `Promise.all` or `gather`.

Expected trace after: outbound spans overlap, request duration close to the slowest single call, not the sum.

### Fix 2: cache

When the same URL is fetched on many requests and the data tolerates staleness: an in-process map with an expiry, or the project's existing cache (Redis, `lru_cache`, framework cache). Confirm in the next trace that the second request has no span to that `peer`.

### Fix 3: timeouts

An outbound span that sometimes takes seconds needs a timeout so one slow dependency cannot hold the request. `fetch`: `AbortSignal.timeout(ms)`. `httpx`: `timeout=`. `requests`: `timeout=` (it has none by default). Decide with the user what the endpoint returns when the dependency times out.

## One slow query

### Spot it

- A single DB span with `slow: true` or a `duration_ms` far above the others.
- `slowest_endpoints` with high `dbShare` but low `avgDbCalls`.

### Fix

1. Copy the statement from the trace. Literals are redacted, so take real values from the code or the request.
2. Run `EXPLAIN ANALYZE` (Postgres), `EXPLAIN QUERY PLAN` (SQLite) or `EXPLAIN ANALYZE` (MySQL 8) against the dev database.
3. Sequential scan on a filtered or joined column: add an index through the project's migration tool, not by hand.
4. Fetching columns or rows the response does not use: select fewer columns, add `LIMIT` and pagination.
5. Re-run and compare that span's `duration_ms`.

`pg_sleep`, `time.sleep` or a fixed delay in a query or handler is deliberate or a leftover. Ask before removing it.

## Error triage

### Spot it

`errors_since` with `since: "15m"` returns failed spans with message, stack and trace id. `list_requests` with `errors_only: true` gives the failed requests.

### Read it

1. `get_trace` on the failing trace. Find the deepest span with `error`. That is where it started; spans above it only propagated it.
2. Read what ran before the error in the same trace: the last SQL statement, the last outbound call and its status code. A 4xx from a `peer` right before an exception usually is the cause.
3. The `stack` gives file and line. Open that code.
4. Compare with a successful trace of the same endpoint (`list_requests` with the endpoint filter) to see which span differs.

### Fix

Fix the cause, not the symptom. Do not wrap the call in a catch that swallows the error and returns 200. If the error is expected (validation, upstream rejection), return the right status (`400`, `402`, `409`, `502`) with a clear body and keep it visible.

Verify: repeat the request, `errors_since` with `since` set to the time of the fix returns nothing for that endpoint, and the status code is the intended one.

## Chatty services

### Spot it

- `service_map` shows one endpoint calling the same internal host or database many times.
- In `get_trace`, many short spans to the same `peer` with different paths, often one per item.
- When several services export to the same runlens, spans carry their own `service`, so the hop between them is visible.

### Fix

- Use or add a batch endpoint (`GET /users?ids=1,2,3`) instead of one call per item.
- Cache stable lookups (configuration, feature flags, user profiles) per request or with a short expiry.
- Move aggregation to the service that owns the data instead of fetching raw rows across the network.
- Run the remaining independent calls concurrently.

Report calls per request and request duration before and after.
