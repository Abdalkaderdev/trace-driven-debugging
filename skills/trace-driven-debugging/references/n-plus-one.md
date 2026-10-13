# N+1 queries

## Spot it

- `find_n_plus_one` returns `statement`, `max_per_request`, `affected_requests` and `example_trace_id` per endpoint.
- `slowest_endpoints` shows `nPlusOne` and a hint like `N+1: "SELECT ... WHERE author_id = $1" runs up to 12 times per request.`
- In `get_trace`, the repeated spans carry `n_plus_one: true`, run one after another, and follow one query that loaded the parent rows.

The shape is one query for a list, then one query per row of that list. `db_calls` grows with the size of the list. On a dev database with 10 rows it looks harmless; with 10,000 rows it is 10,001 round trips.

## Find the code

Search for the route, then look for a query inside a loop, `map`, comprehension, serializer, or a lazy relation accessed per item (`author.books`, `post.comments.all()`, `{{ item.owner.name }}` in a template). The repeated `statement` in the trace tells you which table and column to look for.

ORMs hide the loop. A lazy relation accessed inside a serializer or template produces the same trace as a hand-written loop.

## Fix options, best first

1. Load the children in one query with `IN`/`ANY` and group in memory. Works everywhere, keeps the row shape, 2 queries total.
2. Join and aggregate in SQL (`json_agg`, `array_agg`), 1 query. Good for read endpoints.
3. ORM eager loading. Use the ORM's own mechanism so the code stays idiomatic.
4. A DataLoader-style batcher when the per-item access is spread across resolvers (GraphQL).

Keep ordering and the response shape the same as before. Children with no rows must still produce an empty list, not a missing key.

## Raw SQL

### node-postgres (`pg`)

Before:

```js
const { rows: authors } = await pool.query('SELECT id, name FROM authors ORDER BY id');
for (const author of authors) {
  const { rows } = await pool.query('SELECT id, title, price FROM books WHERE author_id = $1', [author.id]);
  author.books = rows;
}
```

After, 2 queries:

```js
const { rows: authors } = await pool.query('SELECT id, name FROM authors ORDER BY id');
const { rows: books } = await pool.query(
  'SELECT id, title, price, author_id FROM books WHERE author_id = ANY($1::int[]) ORDER BY id',
  [authors.map((a) => a.id)],
);
const byAuthor = Map.groupBy(books, (b) => b.author_id);
for (const author of authors) {
  author.books = (byAuthor.get(author.id) ?? []).map(({ author_id, ...book }) => book);
}
```

`Map.groupBy` needs Node 21+. On older Node build the map with a loop.

After, 1 query (Postgres):

```sql
SELECT a.id, a.name,
       coalesce(json_agg(b ORDER BY b.id) FILTER (WHERE b.id IS NOT NULL), '[]') AS books
FROM authors a LEFT JOIN books b ON b.author_id = a.id
GROUP BY a.id ORDER BY a.id
```

`json_agg(b)` includes every column of `b`, including `author_id`. Use `json_build_object('id', b.id, ...)` to keep the exact old shape.

### Python DB-API (`sqlite3`, `psycopg`)

```python
rows = [dict(r) for r in conn.execute("SELECT id, name, price FROM products ORDER BY id")]
ids = [r["id"] for r in rows]
marks = ",".join("?" * len(ids))
by_product = {}
for r in conn.execute(f"SELECT product_id, stars, body FROM reviews WHERE product_id IN ({marks})", ids):
    by_product.setdefault(r["product_id"], []).append({"stars": r["stars"], "body": r["body"]})
for row in rows:
    row["reviews"] = by_product.get(row["id"], [])
```

Use `%s` placeholders for psycopg, or `= ANY(%s)` with a list. Guard against an empty `ids` list: `IN ()` is a syntax error.

## ORMs

### Prisma

```ts
const authors = await prisma.author.findMany({
  orderBy: { id: 'asc' },
  include: { books: { select: { id: true, title: true, price: true } } },
});
```

Or `select` at the top level to pick parent fields and the relation together. Either way Prisma loads the relation with one extra query for the whole list, not one per row.

`relationLoadStrategy: 'join'` loads relations in a single SQL statement on PostgreSQL, CockroachDB and MySQL; `'query'` is the multi-query mode. In Prisma 7 it is still a preview feature: add `previewFeatures = ["relationJoins"]` to the `generator client` block and run `prisma generate`, otherwise the option is rejected.

```ts
const authors = await prisma.author.findMany({
  relationLoadStrategy: 'join',
  include: { books: true },
});
```

The N+1 in Prisma code is almost always `findMany` followed by `findUnique`/`findMany` inside a loop or `Promise.all(items.map(...))`. `Promise.all` makes the queries concurrent, not fewer; the trace still shows N statements.

### Drizzle

Relational queries load relations in one SQL statement:

```ts
const result = await db.query.authors.findMany({
  orderBy: (authors, { asc }) => [asc(authors.id)],
  with: { books: { columns: { id: true, title: true, price: true } } },
});
```

This is the Drizzle 0.x syntax (the current stable line): relations declared per table with `relations(...)` and the schema passed as `drizzle(url, { schema })`. Drizzle 1.x (in beta as of October 2026) declares them with `defineRelations(...)`, passes `drizzle(url, { relations })`, and takes object syntax for filters and ordering (`orderBy: { id: 'asc' }`); `with: { books: true }` works in both. Check the installed version in `package.json` before writing the query. Without relations, use the core builder with `inArray(books.authorId, ids)` and group in memory.

### TypeORM

```ts
const authors = await authorRepo.find({
  relations: { books: true },
  order: { id: 'ASC' },
});
```

Or with the query builder:

```ts
const authors = await authorRepo
  .createQueryBuilder('author')
  .leftJoinAndSelect('author.books', 'book')
  .orderBy('author.id', 'ASC')
  .getMany();
```

The default `relationLoadStrategy` is `'join'`. `relationLoadStrategy: 'query'` in `find` options issues one query per relation instead of a join, which helps when a join multiplies rows. Lazy relations (`Promise<Book[]>`) awaited in a loop are the usual cause.

### SQLAlchemy 2.x

```python
from sqlalchemy import select
from sqlalchemy.orm import selectinload, joinedload

authors = session.scalars(
    select(Author).options(selectinload(Author.books)).order_by(Author.id)
).all()
```

- `selectinload` for collections (one-to-many, many-to-many): one extra `SELECT ... WHERE author_id IN (...)`.
- `joinedload` for many-to-one and one-to-one: one `LEFT OUTER JOIN`. With `joinedload` on a collection, call `.unique()` on the result before `.all()`, which SQLAlchemy 2.0 requires.
- `raiseload("*")` in tests makes any remaining lazy load raise, so the N+1 cannot come back silently.

Async sessions cannot lazy load at all; the N+1 there shows up as `MissingGreenlet` errors instead of extra queries. The fix is the same eager loading options.

### Django

```python
authors = Author.objects.order_by("id").prefetch_related("books")
books = Book.objects.select_related("author", "author__publisher")
```

- `select_related` for ForeignKey and OneToOne (forward): one query with a JOIN.
- `prefetch_related` for reverse ForeignKey and ManyToMany: one extra query per relation, joined in Python.
- `Prefetch("books", queryset=Book.objects.only("id", "title", "price").order_by("id"))` to filter or shape the prefetched rows. Calling `.filter()` on `author.books` inside the loop throws the prefetch away and queries again.
- In Django REST Framework, put `select_related`/`prefetch_related` on the view's `get_queryset()`; nested serializers access relations per object.

## Verify

1. Same request, same count as before the fix.
2. `find_n_plus_one` with the `endpoint` filter. The old statement must not appear in traces newer than the fix. The tool scans the whole buffer, so old findings stay listed; check `example_trace_id` is an old trace, or use `slowest_endpoints` with `since`.
3. `get_trace` on a new trace: `db_calls` should be a constant (1 or 2), independent of row count.
4. Diff the response body before and after.

Report `db_calls` per request and p50/p95 before and after. On small dev data the latency gain is small; the query count is the number that scales, so lead with it.
