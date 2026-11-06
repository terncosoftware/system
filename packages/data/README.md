# @terncosoftware/data

Database layer for the Tern platform. Manages schema migrations and provides `TripleStore` — the low-level RDF quad store backed by SQLite or PostgreSQL.

## Setup

```typescript
import { createDataContext, TripleStore } from '@terncosoftware/data';

// SQLite (development / tests)
const knex = await createDataContext({ client: 'sqlite', filename: ':memory:' });

// PostgreSQL (production)
const knex = await createDataContext({
    client: 'pg',
    host:     'localhost',
    port:     5432,
    database: 'myapp',
    user:     'myapp',
    password: 'secret',
});

const store = new TripleStore(knex);
```

`createDataContext` runs all platform migrations before returning. The returned `knex` instance is used directly by `TripleStore` and can be passed to `EntityStore` via `ServerContext`.

## TripleStore

`TripleStore` is the RDF quad storage layer. Normal application code does not interact with it directly — use `EntityStore` from `@terncosoftware/server` instead. `TripleStore` is used when bootstrapping the application and in migrations.

```typescript
import { defaultServerContext } from '@terncosoftware/server';

// Register a namespace prefix (call once at startup).
await store.ensureNamespace(ctx, 'myapp', 'http://example.com/ns/');
```

## Testing

All tests that touch the database should run against both SQLite and PostgreSQL. Use in-memory SQLite for speed; use a real PostgreSQL instance for integration coverage. Roll back in transactions at the end of each test suite to reset state.

```typescript
// Per-suite setup
const knex = await createDataContext({ client: 'sqlite', filename: ':memory:' });
const store = new TripleStore(knex);

// Per-test teardown (preferred over truncation)
await knex.transaction(async (trx) => {
    // run test inside trx — rolled back automatically on throw
});
```

## Supported Databases

| Client | Driver | Notes |
|---|---|---|
| `sqlite` | `better-sqlite3` | Development, tests, single-process deployments |
| `pg` | `pg` | Production; required for multi-instance deployments |

Install the driver for the client you use; knex loads it by name:

```bash
yarn add better-sqlite3   # SQLite
yarn add pg               # PostgreSQL
```

## Installation

```bash
yarn add @terncosoftware/data
```

Published to GitHub Packages (`https://npm.pkg.github.com`).
