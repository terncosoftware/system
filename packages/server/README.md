# @terncosoftware/server

Entity storage, querying, and extension management for the Tern platform. The primary data access layer for application code.

## ServerContext

`ServerContext` extends `ApplicationContext` with database transaction, session, and tenancy fields.

```typescript
import type { ServerContext } from '@terncosoftware/server';
import { defaultServerContext } from '@terncosoftware/server';

const ctx: ServerContext = {
    ...defaultServerContext,
    logger:   myLogger,
    events:   eventBus,
    trx:      knexTransaction,   // optional; auto-managed by inTransaction()
    session:  userSession,       // optional; set after auth
    tenantId: 'tenant-abc',      // optional; scopes reads/writes to tenant graph
};
```

## EntityStore

The main data access object. All entity reads and writes go through here — never access `TripleStore` directly in application code.

```typescript
import { EntityStore } from '@terncosoftware/server';
import { TripleStore } from '@terncosoftware/data';

const store = new EntityStore(new TripleStore(knex));
```

### Create

```typescript
import { nameIRI, priceIRI } from './product/types.generated.js';

const product = await store.create(ctx, ProductSchema, {
    [nameIRI.value]:  Literal.string('Widget'),
    [priceIRI.value]: Literal.decimal(9.99),
});
// product.id → UUID; product.iri → full IRI
```

### Read

```typescript
const record = await store.findById(ctx, ProductSchema, productId);
const many   = await store.hydrateMany(ctx, ProductSchema, iris);
```

### Update

```typescript
await store.update(ctx, ProductSchema, productId, {
    [priceIRI.value]: Literal.decimal(14.99),
});
```

### Delete

Soft-delete — the entity's quads are timestamped and marked deleted, not physically removed. The historical record is always recoverable.

```typescript
await store.delete(ctx, ProductSchema, productId);
```

### Transactions

```typescript
const { a, b } = await store.inTransaction(async (ctx) => {
    const a = await store.create(ctx, ProductSchema, { /* ... */ });
    const b = await store.create(ctx, ProductSchema, { /* ... */ });
    return { a, b };
});
```

The transaction `ctx` automatically propagates `trx` to all nested store operations. Do not pass `ctx` from outside the transaction callback into nested calls.

## EntityQuery

Fluent reads of one schema. Every filter, sort, search and page runs in SQL, so a page costs the rows on it.

```typescript
import { EntityQuery } from '@terncosoftware/server';

const { records, total } = await EntityQuery.from(store, ProductSchema)
    .where('price', '>=', 10)
    .whereIn('status', ['active', 'draft'])     // [] matches nothing
    .search('blue widget', ['name', 'sku'])     // every term in one of the fields, any case
    .orderBy('price', 'desc')
    .orderBy('name')                            // breaks ties on price; the IRI breaks the rest
    .offset(20)
    .limit(20)
    .page(ctx);                                 // total counts every match, not the page

const first = await EntityQuery.from(store, ProductSchema).where('name', '=', 'Widget').first(ctx);
```

`createdAt` and `updatedAt` sort and compare like properties. Values order as
`compareListValues` in `@terncosoftware/core/list` does: a missing value last
ascending, strings case-insensitively and then exactly. A PII property is
encrypted at rest, so naming one in a filter, sort or search throws.

A list topic answers its window with `window`, which applies a `ListQuery`
(list field names are property names, the list key is the record id):

```typescript
read: (ctx, sec, { query }) =>
    EntityQuery.from(store, ProductSchema).window(ctx, query, PRODUCTS_LIST, toRow),
```

## Extension Data

Extensions associate their own data with existing entities by writing into a named subgraph scoped to the extension's namespace. `EntityStore` exposes `writeExtension` and `readExtension` for this:

```typescript
const ANALYTICS_NS = 'http://analytics.example.com/ext/';

await store.writeExtension(ctx, userIri, ANALYTICS_NS, [
    [lastActiveAtIRI, Literal.dateTime(new Date())],
]);

const data = await store.readExtension(ctx, userIri, ANALYTICS_NS, [lastActiveAtIRI]);
```

Extension graphs are soft-deleted alongside the entity and never overlap with the base entity's graph or another extension's graph.

## Collections

Ordered lists of IRIs or literals associated with an entity:

```typescript
await store.collectionPush(ctx, ProductSchema, id, 'tags', tagIri);
const tags = await store.collectionGet(ctx, ProductSchema, id, 'tags');
await store.collectionRemove(ctx, ProductSchema, id, 'tags', tagIri);
await store.collectionInsertAt(ctx, ProductSchema, id, 'tags', tagIri, 0);
```

## Collection Views

Sorted, filtered windows over a collection. Managed via `store.views`.

```typescript
const view = await store.createCollectionView(ctx, ProductSchema, id, 'tags', {
    sortProp: nameIRI,
    sortDir:  'asc',
});
```

## ExtensionRegistry and ExtensionManager

Track and drive the lifecycle of installed extensions.

```typescript
import { ExtensionRegistry, ExtensionManager } from '@terncosoftware/server';

const registry = new ExtensionRegistry();
const manager  = new ExtensionManager(registry, store);

registry.register(myExtension);
await manager.installAll(ctx);
```

## Tenancy

Pass `tenantId` on `ctx` to scope all reads and writes to a tenant's named graph. Without `tenantId`, operations target the global graph.

```typescript
const ctx: ServerContext = { ...defaultServerContext, tenantId: 'tenant-abc' };
const record = await store.create(ctx, ProductSchema, { /* ... */ });
// Written to graph http://tern.dev/g/tenant-abc
```

## Installation

```bash
yarn add @terncosoftware/server
yarn add knex better-sqlite3   # or: knex pg
```

Published to GitHub Packages (`https://npm.pkg.github.com`).
