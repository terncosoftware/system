/**
 * Entity system integration tests.
 *
 * Runs against both SQLite (always) and Postgres (when SYS_PG_URL is set),
 * each suite inside a rolled-back transaction so the schema stays clean.
 *
 * Covers:
 *   - UserSchema CRUD via EntityStore
 *   - Default values (createdAt / updatedAt auto-applied)
 *   - EntityQuery: 1 / 2 / 3 attribute filters
 *   - Sorting (orderBy asc / desc)
 *   - Collection API: push / get / remove / pop / set / insertAt
 */

import { UserSchema } from "@terncosoftware/auth";
import { IRI } from "@terncosoftware/core";
import { TripleStore } from "@terncosoftware/data";
import { EntitySchema } from "@terncosoftware/entities";
import type { ShaclNodeShape } from "@terncosoftware/gen";
import { buildServerContext, EntityStore, EntityValidationError } from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromLiteral, invertPropertyMap, propertyMapFor } from "../../../entities/src/util.js";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";
import { TEST_CIPHER } from "../auth/testCipher.js";

// ── Provider matrix ───────────────────────────────────────────────────────────

interface DbProvider {
    name: string;
    create(): Promise<Knex>;
}

const providers: DbProvider[] = [
    {
        name: "SQLite",
        create: () => createTestDataContext({ client: "sqlite", filename: ":memory:" }),
    },
];

if (process.env.SYS_PG_URL) {
    const url = new URL(process.env.SYS_PG_URL);
    providers.push({
        name: "Postgres",
        create: () =>
            createTestDataContext({
                client: "pg",
                host: url.hostname,
                port: url.port ? Number(url.port) : 5432,
                database: url.pathname.slice(1),
                user: url.username,
                password: url.password,
            }),
    });
}

// ── Test-specific schema ──────────────────────────────────────────────────────

const nameIRI = new IRI("http://test.dev/name");
const emailIRI = new IRI("http://test.dev/email");
const scoreIRI = new IRI("http://test.dev/score");
const activeIRI = new IRI("http://test.dev/active");
const tagIRI = new IRI("http://test.dev/tag");
const rankIRI = new IRI("http://test.dev/rank");

function makeTestSchema() {
    return new EntitySchema({
        typeIRI: new IRI("http://test.dev/Item"),
        ns: "http://test.dev/",
        properties: {
            name: nameIRI,
            email: emailIRI,
            score: scoreIRI,
            active: activeIRI,
            tags: tagIRI,
            rank: rankIRI,
        },
        defaults: { score: 0, active: true },
    });
}

// ── Shared helper ─────────────────────────────────────────────────────────────

async function setup(db: DbProvider) {
    const knex = await db.create();
    const trx = await knex.transaction();
    const store = new TripleStore(knex);
    const es = new EntityStore(store, undefined, TEST_CIPHER);
    return { ...buildServerContext(store, { trx, cipher: TEST_CIPHER }), knex, trx, store, es };
}

async function teardown(ctx: Awaited<ReturnType<typeof setup>>) {
    await ctx.trx.rollback();
    await assertEmptyStore(ctx.knex);
    await ctx.knex.destroy();
}

// ─────────────────────────────────────────────────────────────────────────────

for (const db of providers) {
    // ── CRUD via UserSchema ───────────────────────────────────────────────────

    describe(`EntityStore — UserSchema CRUD (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;

        beforeEach(async () => {
            ctx = await setup(db);
            ({ es } = ctx);
        });
        afterEach(async () => {
            await teardown(ctx);
        });

        it("creates a user and returns an id / iri", async () => {
            const rec = await es.create(ctx, UserSchema, { email: "alice@example.com" });
            expect(rec.id).toBeTruthy();
            expect(rec.iri).toContain("urn:sys:core:auth:user:");
            expect(rec.iri).toContain(rec.id);
        });

        it("surfaces DB-managed createdAt / updatedAt on the record (create + findById)", async () => {
            const created = await es.create(ctx, UserSchema, { email: "ts@example.com" });
            const createdAt = created.createdAt;
            const updatedAt = created.updatedAt;
            expect(createdAt).toBeInstanceOf(Date);
            expect(updatedAt).toBeInstanceOf(Date);
            expect(updatedAt?.getTime() ?? 0).toBeGreaterThanOrEqual(createdAt?.getTime() ?? 0);

            const found = await es.findById(ctx, UserSchema, created.id);
            expect(found?.createdAt).toBeInstanceOf(Date);
            expect(found?.updatedAt).toBeInstanceOf(Date);
        });

        it("findById returns the entity with correct props", async () => {
            const created = await es.create(ctx, UserSchema, {
                email: "carol@example.com",
                displayName: "Carol",
            });
            const found = await es.findById(ctx, UserSchema, created.id);
            if (found == null) {
                throw new Error("found must not be null");
            }
            expect(found.props.email).toBe("carol@example.com");
            expect(found.props.displayName).toBe("Carol");
        });

        it("findById returns null for unknown id", async () => {
            expect(await es.findById(ctx, UserSchema, "no-such-id")).toBeNull();
        });

        it("update patches specific fields", async () => {
            const rec = await es.create(ctx, UserSchema, {
                email: "d@example.com",
                displayName: "Old",
            });
            await es.update(ctx, UserSchema, rec.id, { displayName: "New" });
            const updated = await es.findById(ctx, UserSchema, rec.id);
            expect(updated?.props.displayName).toBe("New");
            expect(updated?.props.email).toBe("d@example.com"); // unchanged
        });

        it("delete removes the entity", async () => {
            const rec = await es.create(ctx, UserSchema, { email: "e@example.com" });
            await es.delete(ctx, UserSchema, rec.id);
            expect(await es.findById(ctx, UserSchema, rec.id)).toBeNull();
        });
    });

    // ── Default values ────────────────────────────────────────────────────────

    describe(`EntityStore — defaults (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        beforeEach(async () => {
            ctx = await setup(db);
            ({ es } = ctx);
        });
        afterEach(async () => {
            await teardown(ctx);
        });

        it("applies static defaults when property is absent", async () => {
            const schema = makeTestSchema();
            const rec = await es.create(ctx, schema, { name: "Widget" });
            expect(rec.props.score).toBe(0);
        });

        it("does not override an explicitly supplied value", async () => {
            const schema = makeTestSchema();
            const rec = await es.create(ctx, schema, { name: "Widget", score: 99 });
            expect(rec.props.score).toBe(99);
        });

        it("DB-managed createdAt is monotonic across entities", async () => {
            const rec1 = await es.create(ctx, UserSchema, { email: "h1@example.com" });
            await new Promise((r) => setTimeout(r, 5));
            const rec2 = await es.create(ctx, UserSchema, { email: "h2@example.com" });

            const t1 = rec1.createdAt as Date;
            const t2 = rec2.createdAt as Date;
            expect(t1.getTime()).toBeLessThanOrEqual(t2.getTime());
        });
    });

    // ── EntityQuery: 1 filter ─────────────────────────────────────────────────

    describe(`EntityQuery — 1 filter (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        let schema: EntitySchema;

        beforeEach(async () => {
            ctx = await setup(db);
            ({ es } = ctx);
            schema = makeTestSchema();
            await es.create(ctx, schema, { name: "Alpha", email: "alpha@example.com", score: 10 });
            await es.create(ctx, schema, { name: "Beta", email: "beta@example.com", score: 20 });
            await es.create(ctx, schema, { name: "Gamma", email: "gamma@example.com", score: 30 });
        });
        afterEach(async () => {
            await teardown(ctx);
        });

        it("finds entity by exact email match", async () => {
            const results = await ctx
                .entities(schema)
                .where("email", "=", "beta@example.com")
                .all(ctx);
            expect(results).toHaveLength(1);
            expect(results[0]?.props.name).toBe("Beta");
        });

        it("returns empty array when filter matches nothing", async () => {
            const results = await ctx
                .entities(schema)
                .where("email", "=", "nobody@example.com")
                .all(ctx);
            expect(results).toHaveLength(0);
        });

        it("count() reflects filter", async () => {
            const n = await ctx
                .entities(schema)
                .where("email", "=", "alpha@example.com")
                .count(ctx);
            expect(n).toBe(1);
        });

        it("first() returns one or null", async () => {
            const found = await ctx.entities(schema).where("name", "=", "Gamma").first(ctx);
            expect(found).not.toBeNull();
            expect(found?.props.name).toBe("Gamma");
        });

        it("limit() + offset() paginate correctly", async () => {
            const page = await ctx.entities(schema).limit(2).all(ctx);
            expect(page).toHaveLength(2);

            const rest = await ctx.entities(schema).offset(2).all(ctx);
            expect(rest).toHaveLength(1);
        });
    });

    // ── EntityQuery: 2 filters ────────────────────────────────────────────────

    describe(`EntityQuery — 2 filters (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        let schema: EntitySchema;

        beforeEach(async () => {
            ctx = await setup(db);
            ({ es } = ctx);
            schema = makeTestSchema();
            await es.create(ctx, schema, {
                name: "Alice",
                email: "a@example.com",
                score: 10,
                active: true,
                rank: 1,
            });
            await es.create(ctx, schema, {
                name: "Bob",
                email: "b@example.com",
                score: 20,
                active: false,
                rank: 2,
            });
        });
        afterEach(async () => {
            await teardown(ctx);
        });

        it("intersects two equality filters", async () => {
            const results = await ctx
                .entities(schema)
                .where("name", "=", "Alice")
                .where("active", "=", true)
                .all(ctx);
            expect(results).toHaveLength(1);
            expect(results[0]?.props.name).toBe("Alice");
        });

        it("returns empty when filters exclude all entities", async () => {
            const results = await ctx
                .entities(schema)
                .where("name", "=", "Alice")
                .where("active", "=", false) // Alice is active:true
                .all(ctx);
            expect(results).toHaveLength(0);
        });
    });

    // ── EntityQuery: 3 filters ────────────────────────────────────────────────

    describe(`EntityQuery — 3 filters (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        let schema: EntitySchema;

        beforeEach(async () => {
            ctx = await setup(db);
            ({ es } = ctx);
            schema = makeTestSchema();
            const entityList = [
                { name: "P1", email: "p1@ex.com", score: 10 },
                { name: "P2", email: "p2@ex.com", score: 20 },
                { name: "P3", email: "p3@ex.com", score: 30 },
            ];
            for (const [i, e] of entityList.entries()) {
                await es.create(ctx, schema, { ...e, rank: i + 1, active: i !== 1 });
            }
        });
        afterEach(async () => {
            await teardown(ctx);
        });

        it("narrows to exactly one entity with 3 coincident conditions", async () => {
            const results = await ctx
                .entities(schema)
                .where("name", "=", "P3")
                .where("score", "=", 30)
                .where("active", "=", true)
                .all(ctx);
            expect(results).toHaveLength(1);
            expect(results[0]?.props.name).toBe("P3");
        });

        it("excludes entities that fail any of the three conditions", async () => {
            const results = await ctx
                .entities(schema)
                .where("score", "=", 20) // only P2
                .where("active", "=", true) // P2 is inactive
                .where("rank", "=", 2)
                .all(ctx);
            expect(results).toHaveLength(0);
        });
    });

    // ── EntityQuery: sorting ──────────────────────────────────────────────────

    describe(`EntityQuery — sorting (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        let schema: EntitySchema;

        beforeEach(async () => {
            ctx = await setup(db);
            ({ es } = ctx);
            schema = makeTestSchema();
            await es.create(ctx, schema, { name: "Charlie", score: 30 });
            await es.create(ctx, schema, { name: "Alice", score: 10 });
            await es.create(ctx, schema, { name: "Bob", score: 20 });
        });
        afterEach(async () => {
            await teardown(ctx);
        });

        it("orderBy string field ascending", async () => {
            const results = await ctx.entities(schema).orderBy("name", "asc").all(ctx);
            const names = results.map((r) => r.props.name);
            expect(names).toEqual(["Alice", "Bob", "Charlie"]);
        });

        it("orderBy string field descending", async () => {
            const results = await ctx.entities(schema).orderBy("name", "desc").all(ctx);
            const names = results.map((r) => r.props.name);
            expect(names).toEqual(["Charlie", "Bob", "Alice"]);
        });

        it("orderBy numeric field ascending", async () => {
            const results = await ctx.entities(schema).orderBy("score", "asc").all(ctx);
            const scores = results.map((r) => r.props.score);
            expect(scores).toEqual([10, 20, 30]);
        });

        it("orderBy combined with filter", async () => {
            await es.create(ctx, schema, { name: "Dave", score: 10 });
            const results = await ctx
                .entities(schema)
                .where("score", "=", 10)
                .orderBy("name", "asc")
                .all(ctx);
            const names = results.map((r) => r.props.name);
            expect(names).toEqual(["Alice", "Dave"]);
        });

        it("orderBy handles equal values (av === bv branch returns 0)", async () => {
            await es.create(ctx, schema, { name: "Extra", score: 10 });
            const results = await ctx.entities(schema).orderBy("score", "asc").all(ctx);
            const scores = results.map((r) => r.props.score);
            expect(scores.filter((s) => s === 10)).toHaveLength(2);
        });

        it("orderBy: bv==null when one record has no value for the sort prop", async () => {
            await es.create(ctx, schema, { name: "HasEmail", email: "z@test.com", score: 99 });
            const results = await ctx.entities(schema).orderBy("email", "asc").all(ctx);
            expect(results.length).toBeGreaterThanOrEqual(4);
            const emails = results.map((r) => r.props.email);
            expect(emails[emails.length - 1]).toBe("z@test.com");
        });
    });

    // ── Collection API ────────────────────────────────────────────────────────

    describe(`EntityStore — collections (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        let schema: EntitySchema;
        let itemId: string;

        beforeEach(async () => {
            ctx = await setup(db);
            ({ es } = ctx);
            schema = makeTestSchema();
            const rec = await es.create(ctx, schema, { name: "Colls" });
            itemId = rec.id;
        });
        afterEach(async () => {
            await teardown(ctx);
        });

        it("create() with an array property value populates collection via _propQuads", async () => {
            const rec = await es.create(ctx, schema, { name: "WithTags", tags: ["x", "y", "z"] });
            const found = await es.findById(ctx, schema, rec.id);
            expect(found?.props.tags).toEqual(["x", "y", "z"]);
        });

        it("collectionGet returns empty array before any push", async () => {
            const tags = await es.collectionGet(ctx, schema, itemId, "tags");
            expect(tags).toEqual([]);
        });

        it("collectionPush appends values in insertion order", async () => {
            await es.collectionPush(ctx, schema, itemId, "tags", "alpha", "beta", "gamma");
            const tags = await es.collectionGet(ctx, schema, itemId, "tags");
            expect(tags).toEqual(["alpha", "beta", "gamma"]);
        });

        it("collectionRemove deletes a specific value", async () => {
            await es.collectionPush(ctx, schema, itemId, "tags", "a", "b", "c");
            const removed = await es.collectionRemove(ctx, schema, itemId, "tags", "b");
            expect(removed).toBe(true);
            const tags = await es.collectionGet(ctx, schema, itemId, "tags");
            expect(tags).not.toContain("b");
            expect(tags).toContain("a");
            expect(tags).toContain("c");
        });

        it("collectionRemove returns false when value not present", async () => {
            const removed = await es.collectionRemove(ctx, schema, itemId, "tags", "ghost");
            expect(removed).toBe(false);
        });

        it("collectionPop removes and returns the last item", async () => {
            await es.collectionPush(ctx, schema, itemId, "tags", "first", "second", "third");
            const last = await es.collectionPop(ctx, schema, itemId, "tags");
            expect(last).toBe("third");
            const tags = await es.collectionGet(ctx, schema, itemId, "tags");
            expect(tags).toEqual(["first", "second"]);
        });

        it("collectionPop on empty returns undefined", async () => {
            const last = await es.collectionPop(ctx, schema, itemId, "tags");
            expect(last).toBeUndefined();
        });

        it("collectionSet replaces entire collection", async () => {
            await es.collectionPush(ctx, schema, itemId, "tags", "x", "y");
            await es.collectionSet(ctx, schema, itemId, "tags", ["p", "q", "r"]);
            const tags = await es.collectionGet(ctx, schema, itemId, "tags");
            expect(tags).toEqual(["p", "q", "r"]);
        });

        it("collectionSet with empty array clears the collection", async () => {
            await es.collectionPush(ctx, schema, itemId, "tags", "tag1");
            await es.collectionSet(ctx, schema, itemId, "tags", []);
            const tags = await es.collectionGet(ctx, schema, itemId, "tags");
            expect(tags).toEqual([]);
        });

        it("collectionInsertAt inserts at the beginning", async () => {
            await es.collectionPush(ctx, schema, itemId, "tags", "b", "c");
            await es.collectionInsertAt(ctx, schema, itemId, "tags", 0, "a");
            const tags = await es.collectionGet(ctx, schema, itemId, "tags");
            expect(tags).toEqual(["a", "b", "c"]);
        });

        it("collectionInsertAt inserts in the middle", async () => {
            await es.collectionPush(ctx, schema, itemId, "tags", "a", "c");
            await es.collectionInsertAt(ctx, schema, itemId, "tags", 1, "b");
            const tags = await es.collectionGet(ctx, schema, itemId, "tags");
            expect(tags).toEqual(["a", "b", "c"]);
        });

        it("collectionInsertAt appends when index exceeds length", async () => {
            await es.collectionPush(ctx, schema, itemId, "tags", "one", "two");
            await es.collectionInsertAt(ctx, schema, itemId, "tags", 99, "three");
            const tags = await es.collectionGet(ctx, schema, itemId, "tags");
            expect(tags).toEqual(["one", "two", "three"]);
        });

        it("sorting a collection via collectionSet", async () => {
            await es.collectionPush(ctx, schema, itemId, "tags", "gamma", "alpha", "beta");
            const current = (await es.collectionGet(ctx, schema, itemId, "tags")) as string[];
            const sorted = [...current].sort();
            await es.collectionSet(ctx, schema, itemId, "tags", sorted);
            const tags = await es.collectionGet(ctx, schema, itemId, "tags");
            expect(tags).toEqual(["alpha", "beta", "gamma"]);
        });

        it("hydrated findById returns collection as array", async () => {
            await es.collectionPush(ctx, schema, itemId, "tags", "x", "y", "z");
            const found = await es.findById(ctx, schema, itemId);
            expect(found?.props.tags).toEqual(["x", "y", "z"]);
        });
    });

    // ── EntityValidationError ─────────────────────────────────────────────────

    describe(`EntityValidationError (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;

        beforeEach(async () => {
            ctx = await setup(db);
        });
        afterEach(async () => {
            await teardown(ctx);
        });

        it("carries structured violations", () => {
            const err = new EntityValidationError([
                { property: "email", value: "", message: "Required.", severity: "violation" },
            ]);
            expect(err).toBeInstanceOf(Error);
            expect(err.violations).toHaveLength(1);
            expect(err.violations[0]?.property).toBe("email");
        });

        it("message includes the property name", () => {
            const err = new EntityValidationError([
                { property: "email", value: "", message: "Required.", severity: "violation" },
            ]);
            expect(err.message).toContain("email");
        });
    });
}

// ── Non-DB tests (EntitySchema, util helpers) ─────────────────────────────────

describe("EntityStore — defensive throw paths", () => {
    let knex: import("knex").Knex;
    let es: EntityStore;
    let schema: EntitySchema;
    let itemId: string;

    beforeEach(async () => {
        knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        es = new EntityStore(new TripleStore(knex));
        schema = makeTestSchema();
        const rec = await es.create(buildServerContext(es.store), schema, { name: "Item" });
        itemId = rec.id;
    });
    afterEach(async () => {
        await knex.destroy();
    });

    it("collectionSet throws when prop not in schema", async () => {
        await expect(
            es.collectionSet(buildServerContext(es.store), schema, itemId, "nonExistentProp", [
                "x",
            ]),
        ).rejects.toThrow();
    });

    it("createCollectionView throws when prop not in schema", async () => {
        await expect(
            es.createCollectionView(
                buildServerContext(es.store),
                schema,
                itemId,
                "nonExistentProp",
            ),
        ).rejects.toThrow();
    });

    it("collectionPush throws when prop not in schema", async () => {
        await expect(
            es.collectionPush(buildServerContext(es.store), schema, itemId, "ghostProp", "val"),
        ).rejects.toThrow("ghostProp");
    });
});

describe("EntityStore — views getter", () => {
    it("es.views returns a CollectionViewStore instance", async () => {
        const knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        const store = new TripleStore(knex);
        const es = new EntityStore(store);
        expect(es.views).toBeDefined();
        await knex.destroy();
    });
});

describe("EntityStore — collectionGet/Remove with unknown prop returns early", () => {
    let knex: import("knex").Knex;
    let es: EntityStore;
    let schema: EntitySchema;
    let itemId: string;

    beforeEach(async () => {
        knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        es = new EntityStore(new TripleStore(knex));
        schema = makeTestSchema();
        const rec = await es.create(buildServerContext(es.store), schema, { name: "Item" });
        itemId = rec.id;
    });
    afterEach(async () => {
        await knex.destroy();
    });

    it("collectionGet returns [] when prop is not in the schema", async () => {
        const result = await es.collectionGet(
            buildServerContext(es.store),
            schema,
            itemId,
            "unknownProp",
        );
        expect(result).toEqual([]);
    });

    it("collectionRemove returns false when prop is not in the schema", async () => {
        const removed = await es.collectionRemove(
            buildServerContext(es.store),
            schema,
            itemId,
            "unknownProp",
            "value",
        );
        expect(removed).toBe(false);
    });

    it("collectionPush throws when prop is not in the schema", async () => {
        await expect(
            es.collectionPush(buildServerContext(es.store), schema, itemId, "unknownProp", "value"),
        ).rejects.toThrow("unknownProp");
    });
});

describe("EntityStore — inTransaction wraps work in a DB transaction", () => {
    it("executes fn inside a knex transaction and returns result", async () => {
        const knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        const store = new TripleStore(knex);
        const es = new EntityStore(store);
        const schema = makeTestSchema();

        const result = await es.inTransaction(async (ctx) => {
            return es.create(ctx, schema, { name: "TxItem" });
        });

        expect(result.id).toBeTruthy();
        const found = await es.findById(buildServerContext(es.store), schema, result.id);
        expect(found?.props.name).toBe("TxItem");
        await knex.destroy();
    });
});

describe("EntityStore._validate — schema with shape", () => {
    const nameIRI = new IRI("http://test.dev/name");
    const schemaWithShape = new EntitySchema({
        typeIRI: new IRI("http://test.dev/ValidatedItem"),
        ns: "http://test.dev/",
        properties: { name: nameIRI },
        shape: {
            iri: "http://test.dev/ValidatedItemShape",
            targetClass: "http://test.dev/ValidatedItem",
            closed: false,
            properties: [{ path: "http://test.dev/name", minCount: 1 }],
        } satisfies ShaclNodeShape,
    });

    it("validates successfully when required prop is present", async () => {
        const knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        const store = new TripleStore(knex);
        const es = new EntityStore(store);
        const rec = await es.create(buildServerContext(es.store), schemaWithShape, {
            name: "ValidName",
        });
        expect(rec.id).toBeTruthy();
        await knex.destroy();
    });

    it("throws EntityValidationError when required prop missing", async () => {
        const knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        const store = new TripleStore(knex);
        const es = new EntityStore(store);
        await expect(
            es.create(buildServerContext(es.store), schemaWithShape, {}),
        ).rejects.toBeInstanceOf(EntityValidationError);
        await knex.destroy();
    });
});

describe("fromLiteral — utility branches", () => {
    it("returns the value for a BlankNode term", () => {
        const result = fromLiteral({ termType: "BlankNode", id: "b0", value: "b0" });
        expect(result).toBe("b0");
    });

    it("returns undefined for unknown term shape", () => {
        expect(fromLiteral(null)).toBeUndefined();
        expect(fromLiteral(42)).toBeUndefined();
    });
});

describe("invertPropertyMap / propertyMapFor", () => {
    const props = { name: new IRI("http://x/name"), score: new IRI("http://x/score") };

    it("invertPropertyMap maps IRI string → property name", () => {
        const inv = invertPropertyMap(props);
        expect(inv.get("http://x/name")).toBe("name");
        expect(inv.get("http://x/score")).toBe("score");
    });

    it("propertyMapFor maps property name → IRI string", () => {
        const map = propertyMapFor(props);
        expect(map.name).toBe("http://x/name");
        expect(map.score).toBe("http://x/score");
    });
});

// ── EntityQuery filter operators (non-equality) — runs per DB provider ────────

for (const db of providers) {
    describe(`EntityQuery — filter operators (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        let schema: EntitySchema;

        beforeEach(async () => {
            ctx = await setup(db);
            ({ es } = ctx);
            schema = makeTestSchema();
            await es.create(ctx, schema, { name: "Alice", score: 10 });
            await es.create(ctx, schema, { name: "Bob", score: 20 });
            await es.create(ctx, schema, { name: "Charlie", score: 30 });
        });
        afterEach(async () => {
            await teardown(ctx);
        });

        it("!= excludes the matching record", async () => {
            const results = await ctx.entities(schema).where("score", "!=", 20).all(ctx);
            const scores = results.map((r) => r.props.score);
            expect(scores).not.toContain(20);
            expect(scores).toHaveLength(2);
        });

        it("< returns records below the threshold", async () => {
            const results = await ctx.entities(schema).where("score", "<", 20).all(ctx);
            const scores = results.map((r) => r.props.score);
            expect(scores).toEqual([10]);
        });

        it("<= returns records at or below the threshold", async () => {
            const results = await ctx.entities(schema).where("score", "<=", 20).all(ctx);
            const scores = results.map((r) => r.props.score);
            expect(scores).toContain(10);
            expect(scores).toContain(20);
            expect(scores).not.toContain(30);
        });

        it("> returns records above the threshold", async () => {
            const results = await ctx.entities(schema).where("score", ">", 10).all(ctx);
            const scores = results.map((r) => r.props.score);
            expect(scores).toContain(20);
            expect(scores).toContain(30);
            expect(scores).not.toContain(10);
        });

        it(">= returns records at or above the threshold", async () => {
            const results = await ctx.entities(schema).where("score", ">=", 20).all(ctx);
            const scores = results.map((r) => r.props.score);
            expect(scores).toContain(20);
            expect(scores).toContain(30);
            expect(scores).not.toContain(10);
        });

        it("LIKE pattern matches names starting with prefix", async () => {
            const results = await ctx.entities(schema).where("name", "LIKE", "Ali%").all(ctx);
            expect(results).toHaveLength(1);
            expect(results[0]?.props.name).toBe("Alice");
        });

        it("ILIKE pattern is case-insensitive", async () => {
            const results = await ctx.entities(schema).where("name", "ILIKE", "ali%").all(ctx);
            expect(results).toHaveLength(1);
            expect(results[0]?.props.name).toBe("Alice");
        });

        it(".store getter returns a TripleStore", () => {
            const q = ctx.entities(schema);
            expect(q.store).toBe(ctx.store);
        });

        it("_applyEqFilter: unknown prop skips filtering (returns all)", async () => {
            const results = await ctx
                .entities(schema)
                .where("nonexistentProp", "=", "anything")
                .all(ctx);
            expect(results.length).toBe(3);
        });

        it("_matchFilter default branch: unknown operator returns false", async () => {
            const results = await ctx
                .entities(schema)
                .where("score", "BOGUS" as unknown as "=" | "!=" | "<" | "<=" | ">" | ">=", 10)
                .all(ctx);
            expect(results.length).toBe(0);
        });

        it("_matchFilter: non-eq filter on undefined prop compares against undefined", async () => {
            // email is not set on any entity in beforeEach (no default for email).
            // != filter: undefined !== "x" is true, so all records pass.
            const results = await ctx
                .entities(schema)
                .where("email", "!=", "nobody@example.com")
                .all(ctx);
            expect(results.length).toBe(3);
        });
    });

    // Dedicated sort-branch test with a fresh describe to control insertion order
    describe(`EntityQuery — orderBy bv==null branch (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        let schema: EntitySchema;

        beforeEach(async () => {
            ctx = await setup(db);
            ({ es } = ctx);
            schema = makeTestSchema();
            await es.create(ctx, schema, { name: "HasEmail", email: "a@test.com", score: 1 });
            await es.create(ctx, schema, { name: "NoEmail", score: 2 });
        });
        afterEach(async () => {
            await teardown(ctx);
        });

        it("bv==null: element-with-value appears before element-without → cmp=1 branch", async () => {
            const results = await ctx.entities(schema).orderBy("email", "asc").all(ctx);
            expect(results).toHaveLength(2);
            expect(results[0]?.props.name).toBe("NoEmail");
            expect(results[1]?.props.name).toBe("HasEmail");
        });
    });
}
