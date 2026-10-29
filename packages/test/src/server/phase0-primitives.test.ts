/**
 * Phase 0 primitive tests — the additive groundwork for the entity-system
 * simplification: `ctx.tx` (the unit of work), `ctx.entityStore` (cipher
 * pre-wired), `EntityStore.addRawEdge`/`removeRawEdge` (non-schema edges), and
 * the schema-derived `recordToEntity` mapper.
 *
 * Runs against both SQLite (always) and Postgres (when SYS_PG_URL is set).
 *
 * Two suite shapes per provider:
 *   - "within a transaction": each test runs in an ambient trx rolled back after,
 *     and assertEmptyStore proves nothing leaked (the leak-detection contract).
 *   - "managing its own transaction": tests that deliberately let `ctx.tx` open a
 *     top-level transaction (commit / rollback paths). These can auto-commit, so
 *     the teardown clears the tables (mirrors transaction-composability.test.ts).
 *     They must NOT hold an ambient trx — on single-connection SQLite a nested
 *     top-level transaction would deadlock.
 */

import { IRI } from "@terncosoftware/core";
import { TripleStore } from "@terncosoftware/data";
import type { EntityRecord } from "@terncosoftware/entities";
import { EntitySchema } from "@terncosoftware/entities";
import { buildServerContext, EntityStore, recordToEntity } from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

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

// ── Test schemas ────────────────────────────────────────────────────────────

const titleIRI = new IRI("http://test.dev/p0/title");
const labelIRI = new IRI("http://test.dev/p0/label");
const parentEdgeIRI = new IRI("http://test.dev/p0/parent");
const memberEdgeIRI = new IRI("http://test.dev/p0/member");
const ownsIRI = new IRI("http://test.dev/p0/owns");

function makeParentSchema() {
    return new EntitySchema({
        typeIRI: new IRI("http://test.dev/p0/Parent"),
        ns: "http://test.dev/p0/",
        idSegment: "parent",
        properties: { title: titleIRI },
    });
}

function makeChildSchema(parent: EntitySchema) {
    return new EntitySchema({
        typeIRI: new IRI("http://test.dev/p0/Child"),
        ns: "http://test.dev/p0/",
        idSegment: "child",
        properties: { label: labelIRI },
        edges: {
            parent: {
                predicate: parentEdgeIRI,
                target: () => parent,
                cardinality: "one",
                direction: "out",
            },
            members: {
                predicate: memberEdgeIRI,
                target: () => parent,
                cardinality: "many",
                direction: "out",
            },
        },
    });
}

const parentSchema = makeParentSchema();
const childSchema = makeChildSchema(parentSchema);

// ── recordToEntity (pure — no DB) ─────────────────────────────────────────────

describe("recordToEntity (pure)", () => {
    it("flattens props + id/iri and passes timestamps through", () => {
        const rec: EntityRecord = {
            id: "c1",
            iri: "urn:test:p0:child:c1",
            props: { label: "hi" },
            createdAt: new Date(1000),
            updatedAt: new Date(2000),
        };
        const e = recordToEntity(childSchema, rec);
        expect(e).toMatchObject({ id: "c1", iri: "urn:test:p0:child:c1", label: "hi" });
        expect(e.createdAt).toEqual(new Date(1000));
        expect(e.updatedAt).toEqual(new Date(2000));
    });

    it("omits timestamps when the record has none (no fabricated Date)", () => {
        const rec: EntityRecord = { id: "c2", iri: "urn:test:p0:child:c2", props: { label: "x" } };
        const e = recordToEntity(childSchema, rec);
        expect("createdAt" in e).toBe(false);
        expect("updatedAt" in e).toBe(false);
    });

    it("projects a cardinality-one out edge to <edge>Id / <edge>Iri", () => {
        const rec: EntityRecord = {
            id: "c3",
            iri: "urn:test:p0:child:c3",
            props: { label: "y" },
            edges: { parent: { iri: "urn:test:p0:parent:p1", id: "p1", load: async () => null } },
        };
        const e = recordToEntity(childSchema, rec);
        expect(e.parentIri).toBe("urn:test:p0:parent:p1");
        expect(e.parentId).toBe("p1");
    });

    it("projects a cardinality-many out edge to <edge>Ids / <edge>Iris", () => {
        const rec: EntityRecord = {
            id: "c4",
            iri: "urn:test:p0:child:c4",
            props: { label: "z" },
            edges: {
                members: {
                    iris: ["urn:test:p0:parent:a", "urn:test:p0:parent:b"],
                    ids: ["a", "b"],
                    load: async () => [],
                },
            },
        };
        const e = recordToEntity(childSchema, rec);
        expect(e.membersIris).toEqual(["urn:test:p0:parent:a", "urn:test:p0:parent:b"]);
        expect(e.membersIds).toEqual(["a", "b"]);
    });
});

// ── Primitives that run inside an ambient transaction (rollback + leak check) ──

for (const db of providers) {
    describe(`Phase 0 primitives — within a transaction (${db.name})`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let store: TripleStore;

        beforeEach(async () => {
            knex = await db.create();
            trx = await knex.transaction();
            store = new TripleStore(knex);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("ctx.entityStore is a working, pre-wired EntityStore", async () => {
            const ctx = buildServerContext(store, { trx });
            expect(ctx.entityStore).toBeInstanceOf(EntityStore);
            const rec = await ctx.entityStore.create(ctx, childSchema, { label: "via-ctx" });
            const found = await ctx.entityStore.findById(ctx, childSchema, rec.id);
            expect(found?.props.label).toBe("via-ctx");
        });

        it("ctx.tx reuses the ambient transaction when one is present", async () => {
            const ctx = buildServerContext(store, { trx });
            let innerCtx: typeof ctx | undefined;
            await ctx.tx(async (tx) => {
                innerCtx = tx;
                await tx.entityStore.create(tx, childSchema, { label: "reentrant" }, "fixed-re");
            });
            // Reentrant: same ctx object, same trx — no new transaction opened.
            expect(innerCtx).toBe(ctx);
            expect(innerCtx?.trx).toBe(trx);
            expect(await ctx.entityStore.findById(ctx, childSchema, "fixed-re")).not.toBeNull();
        });

        it("addRawEdge inserts a non-schema edge; removeRawEdge deletes it", async () => {
            const ctx = buildServerContext(store, { trx });
            const from = "urn:test:p0:owner:1";
            const to = "urn:test:p0:thing:2";

            await ctx.entityStore.addRawEdge(ctx, from, ownsIRI, to);
            const after = await store.find(ctx, {
                subject: new IRI(from),
                predicate: ownsIRI,
                graph: null,
            });
            expect(after).toHaveLength(1);
            expect((after[0]?.object as IRI).value).toBe(to);

            const removed = await ctx.entityStore.removeRawEdge(ctx, from, ownsIRI, to);
            expect(removed).toBe(true);
            const cleared = await store.find(ctx, {
                subject: new IRI(from),
                predicate: ownsIRI,
                graph: null,
            });
            expect(cleared).toHaveLength(0);
        });
    });

    // ── ctx.tx managing its OWN top-level transaction (no ambient trx) ─────────

    describe(`Phase 0 primitives — ctx.tx self-managed transaction (${db.name})`, () => {
        let knex: Knex;
        let store: TripleStore;

        beforeEach(async () => {
            knex = await db.create();
            store = new TripleStore(knex);
        });
        afterEach(async () => {
            // These tests can auto-commit; clear the tables before disconnecting so
            // nothing leaks across the shared Postgres database.
            for (const t of ["edges", "nodes", "namespaces"]) {
                await knex(t).del();
            }
            await knex.destroy();
        });

        it("opens a fresh, fully-wired transaction and commits on success", async () => {
            const ctx = buildServerContext(store); // no ambient trx
            let handed: typeof ctx | undefined;
            await ctx.tx(async (tx) => {
                handed = tx;
                expect(tx).not.toBe(ctx); // rebuilt and bound to the new trx
                expect(tx.trx).toBeDefined();
                await tx.entityStore.create(tx, childSchema, { label: "committed" }, "fixed-ok");
            });
            expect(handed?.trx).toBeDefined();
            // Committed: visible on a fresh, trx-less ctx after the block returns.
            const clean = buildServerContext(store);
            expect(await clean.entityStore.findById(clean, childSchema, "fixed-ok")).not.toBeNull();
        });

        it("is atomic: a throw rolls back every write in the block", async () => {
            const ctx = buildServerContext(store); // no ambient trx
            await expect(
                ctx.tx(async (tx) => {
                    await tx.entityStore.create(tx, childSchema, { label: "a" }, "atomic-a");
                    await tx.entityStore.create(tx, childSchema, { label: "b" }, "atomic-b");
                    throw new Error("boom");
                }),
            ).rejects.toThrow("boom");
            const clean = buildServerContext(store);
            expect(await clean.entityStore.findById(clean, childSchema, "atomic-a")).toBeNull();
            expect(await clean.entityStore.findById(clean, childSchema, "atomic-b")).toBeNull();
        });
    });
}
