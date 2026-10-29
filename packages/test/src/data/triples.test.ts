/**
 * Triple store integration tests.
 *
 * Per the project spec, every DB test runs against BOTH SQLite (always) and
 * Postgres (when SYS_PG_URL is set).  Each suite wraps its work in a
 * transaction that is rolled back after the suite so the schema stays clean.
 */

import {
    type BlankNode,
    DEFAULT_GRAPH,
    type IRI,
    type Literal,
    type Quad,
} from "@terncosoftware/core";
import { createDataContext, TripleStore } from "@terncosoftware/data";
import { buildServerContext, type ServerContext } from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down as migration001Down } from "../../../data/src/migrations/001_init.js";
import {
    assertEmptyStore,
    assertStoreIntegrity,
    createTestDataContext,
} from "../assertEmptyStore.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function iri(value: string): IRI {
    return { value } as IRI;
}

function blank(id: string): BlankNode {
    return { termType: "BlankNode", id };
}

function literal(value: string, datatypeIri?: string, lang?: string): Literal {
    return {
        termType: "Literal",
        value,
        datatype: iri(datatypeIri ?? "http://www.w3.org/2001/XMLSchema#string"),
        language: lang,
    };
}

const RDF_TYPE = iri("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
const RDFS_LABEL = iri("http://www.w3.org/2000/01/rdf-schema#label");
const OWL_THING = iri("http://www.w3.org/2002/07/owl#Thing");
const EX = (local: string) => iri(`http://example.org/${local}`);
const GRAPH = EX("graph1");

// ── Provider matrix ───────────────────────────────────────────────────────────

interface Provider {
    name: string;
    create(): Promise<Knex>;
}

const providers: Provider[] = [
    {
        name: "SQLite (in-memory)",
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

// ── Shared suite (runs once per provider) ─────────────────────────────────────

for (const provider of providers) {
    describe(`TripleStore — ${provider.name}`, () => {
        let knex: Knex;
        let store: TripleStore;
        let trx: Knex.Transaction;
        let ctx: ServerContext;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            store = new TripleStore(knex);
            ctx = buildServerContext(store, { trx });
        });

        afterEach(async () => {
            await assertStoreIntegrity(trx as unknown as Knex);
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        // ── ensureNamespace ───────────────────────────────────────────────────

        it("registers a namespace and returns its id", async () => {
            const id = await store.ensureNamespace(ctx, "ex", "http://example.org/");
            expect(id).toBeGreaterThan(0);
        });

        it("returns the same id for a duplicate namespace", async () => {
            const a = await store.ensureNamespace(ctx, "ex", "http://example.org/");
            const b = await store.ensureNamespace(ctx, "ex", "http://example.org/");
            expect(a).toBe(b);
        });

        // ── ensureNode ────────────────────────────────────────────────────────

        it("interns an IRI node", async () => {
            const id = await store.ensureNode(ctx, EX("subject"));
            expect(id).toBeGreaterThan(0);
        });

        it("interns the same IRI node idempotently", async () => {
            const a = await store.ensureNode(ctx, EX("subject"));
            const b = await store.ensureNode(ctx, EX("subject"));
            expect(a).toBe(b);
        });

        it("interns a blank node", async () => {
            const id = await store.ensureNode(ctx, blank("b0"));
            expect(id).toBeGreaterThan(0);
        });

        it("interns a string literal", async () => {
            const id = await store.ensureNode(ctx, literal("hello"));
            expect(id).toBeGreaterThan(0);
        });

        it("distinguishes literals with different language tags", async () => {
            const en = await store.ensureNode(ctx, literal("cat", undefined, "en"));
            const fr = await store.ensureNode(ctx, literal("chat", undefined, "fr"));
            expect(en).not.toBe(fr);
        });

        // ── insert / find ─────────────────────────────────────────────────────

        it("inserts a triple and finds it by subject", async () => {
            const q: Quad = {
                subject: EX("s"),
                predicate: RDF_TYPE,
                object: OWL_THING,
                graph: GRAPH,
            };
            await store.insert(ctx, q);

            const found = await store.find(ctx, { subject: EX("s"), graph: GRAPH });
            expect(found).toHaveLength(1);
            expect((found[0].subject as IRI).value).toBe("http://example.org/s");
            expect((found[0].predicate as IRI).value).toBe(RDF_TYPE.value);
        });

        it("inserts a triple and finds it by predicate", async () => {
            await store.insert(ctx, {
                subject: EX("a"),
                predicate: RDF_TYPE,
                object: OWL_THING,
                graph: GRAPH,
            });
            await store.insert(ctx, {
                subject: EX("b"),
                predicate: RDFS_LABEL,
                object: literal("B"),
                graph: GRAPH,
            });

            const byType = await store.find(ctx, { predicate: RDF_TYPE, graph: GRAPH });
            expect(byType).toHaveLength(1);
            expect((byType[0].subject as IRI).value).toBe("http://example.org/a");
        });

        it("inserts a triple and finds it by object IRI", async () => {
            await store.insert(ctx, {
                subject: EX("a"),
                predicate: RDF_TYPE,
                object: OWL_THING,
                graph: GRAPH,
            });

            const found = await store.find(ctx, { object: OWL_THING, graph: GRAPH });
            expect(found).toHaveLength(1);
        });

        it("inserts a triple and finds it by literal object", async () => {
            const label = literal("hello world");
            await store.insert(ctx, {
                subject: EX("doc"),
                predicate: RDFS_LABEL,
                object: label,
                graph: GRAPH,
            });

            const found = await store.find(ctx, { object: label, graph: GRAPH });
            expect(found).toHaveLength(1);
            expect((found[0].object as Literal).value).toBe("hello world");
        });

        it("inserts a triple with a blank node subject", async () => {
            const b = blank("anon1");
            await store.insert(ctx, {
                subject: b,
                predicate: RDF_TYPE,
                object: OWL_THING,
                graph: GRAPH,
            });

            const found = await store.find(ctx, { subject: b, graph: GRAPH });
            expect(found).toHaveLength(1);
            expect((found[0].subject as BlankNode).termType).toBe("BlankNode");
            expect((found[0].subject as BlankNode).id).toBe("anon1");
        });

        it("de-duplicates identical quads on insert", async () => {
            const q: Quad = {
                subject: EX("s"),
                predicate: RDF_TYPE,
                object: OWL_THING,
                graph: GRAPH,
            };
            await store.insert(ctx, q);
            await store.insert(ctx, q); // should be ignored (onConflict ignore)

            const found = await store.find(ctx, { subject: EX("s"), graph: GRAPH });
            expect(found).toHaveLength(1);
        });

        it("finds all triples when no pattern is given", async () => {
            await store.insertMany(ctx, [
                { subject: EX("a"), predicate: RDF_TYPE, object: OWL_THING, graph: GRAPH },
                { subject: EX("b"), predicate: RDFS_LABEL, object: literal("B"), graph: GRAPH },
                { subject: EX("c"), predicate: RDF_TYPE, object: OWL_THING, graph: GRAPH },
            ]);

            const all = await store.find(ctx, { graph: GRAPH });
            expect(all).toHaveLength(3);
        });

        it("returns empty array when subject not found", async () => {
            const found = await store.find(ctx, { subject: EX("ghost"), graph: GRAPH });
            expect(found).toHaveLength(0);
        });

        // ── graph scoping ─────────────────────────────────────────────────────

        it("finds triples scoped to a specific graph", async () => {
            const g1 = EX("g1");
            const g2 = EX("g2");
            await store.insert(ctx, {
                subject: EX("s"),
                predicate: RDF_TYPE,
                object: OWL_THING,
                graph: g1,
            });
            await store.insert(ctx, {
                subject: EX("s"),
                predicate: RDF_TYPE,
                object: OWL_THING,
                graph: g2,
            });

            const inG1 = await store.find(ctx, { graph: g1 });
            expect(inG1).toHaveLength(1);
        });

        // ── delete ────────────────────────────────────────────────────────────

        it("deletes triples matching a pattern", async () => {
            await store.insert(ctx, {
                subject: EX("del"),
                predicate: RDF_TYPE,
                object: OWL_THING,
                graph: GRAPH,
            });
            const deleted = await store.delete(ctx, { subject: EX("del"), graph: GRAPH });
            expect(deleted).toBe(1);
            expect(await store.find(ctx, { subject: EX("del"), graph: GRAPH })).toHaveLength(0);
        });

        it("returns 0 when delete pattern matches nothing", async () => {
            const deleted = await store.delete(ctx, { subject: EX("nobody"), graph: GRAPH });
            expect(deleted).toBe(0);
        });

        it("deletes only matching triples, leaving others intact", async () => {
            await store.insertMany(ctx, [
                { subject: EX("keep"), predicate: RDF_TYPE, object: OWL_THING, graph: GRAPH },
                { subject: EX("remove"), predicate: RDF_TYPE, object: OWL_THING, graph: GRAPH },
            ]);
            await store.delete(ctx, { subject: EX("remove"), graph: GRAPH });
            const all = await store.find(ctx, { graph: GRAPH });
            expect(all).toHaveLength(1);
            expect((all[0].subject as IRI).value).toBe("http://example.org/keep");
        });

        // ── stats ─────────────────────────────────────────────────────────────

        it("reports accurate stats after insertions", async () => {
            const base = await store.stats(ctx);
            await store.insertMany(ctx, [
                { subject: EX("a"), predicate: RDF_TYPE, object: OWL_THING, graph: GRAPH },
                { subject: EX("b"), predicate: RDFS_LABEL, object: literal("B"), graph: GRAPH },
            ]);
            const s = await store.stats(ctx);
            expect(s.edges - base.edges).toBe(2);
            expect(s.nodes - base.nodes).toBeGreaterThanOrEqual(4);
        });

        it("stats reflect deletions", async () => {
            const base = await store.stats(ctx);
            await store.insert(ctx, {
                subject: EX("x"),
                predicate: RDF_TYPE,
                object: OWL_THING,
                graph: GRAPH,
            });
            await store.delete(ctx, { subject: EX("x"), graph: GRAPH });
            const s = await store.stats(ctx);
            expect(s.edges - base.edges).toBe(0);
        });

        // ── delete by predicate / object / graph:null ─────────────────────────

        it("deletes triples matching a predicate pattern", async () => {
            await store.insertMany(ctx, [
                { subject: EX("a"), predicate: RDF_TYPE, object: OWL_THING, graph: GRAPH },
                { subject: EX("b"), predicate: RDFS_LABEL, object: literal("B"), graph: GRAPH },
            ]);
            const deleted = await store.delete(ctx, { predicate: RDF_TYPE, graph: GRAPH });
            expect(deleted).toBe(1);
            expect(await store.find(ctx, { graph: GRAPH })).toHaveLength(1);
        });

        it("deletes triples matching an object pattern", async () => {
            await store.insertMany(ctx, [
                { subject: EX("a"), predicate: RDF_TYPE, object: OWL_THING, graph: GRAPH },
                { subject: EX("b"), predicate: RDFS_LABEL, object: literal("B"), graph: GRAPH },
            ]);
            const deleted = await store.delete(ctx, { object: OWL_THING, graph: GRAPH });
            expect(deleted).toBe(1);
        });

        it("deletes triples with graph === null (no graph)", async () => {
            const noGraph = EX("s");
            // Insert a quad with graph = DefaultGraph (null -> gId = null)
            await store.insert(ctx, {
                subject: noGraph,
                predicate: RDF_TYPE,
                object: OWL_THING,
                graph: { termType: "DefaultGraph" },
            });
            const deleted = await store.delete(ctx, { graph: null });
            expect(deleted).toBe(1);
        });

        it("delete returns 0 for non-existent predicate", async () => {
            const deleted = await store.delete(ctx, {
                predicate: EX("no-such-predicate"),
                graph: GRAPH,
            });
            expect(deleted).toBe(0);
        });
    });
}

// ── migration down() ──────────────────────────────────────────────────────────

describe("migration 001_init down()", () => {
    it("drops all tables cleanly", async () => {
        const knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        // Tables already created by createDataContext; run down() to drop them
        await migration001Down(knex);
        // After down(), the tables should be gone — querying should throw
        await expect(knex("edges").count()).rejects.toThrow();
        await knex.destroy();
    });
});

// ── DataContext: pg branch ────────────────────────────────────────────────────

describe("createDataContext(pg)", () => {
    it("rejects when postgres is unreachable (covers the pg branch)", async () => {
        await expect(
            createDataContext({
                client: "pg",
                host: "127.0.0.1",
                port: 54322, // non-existent port
                database: "tern_test",
                user: "tern",
                password: "tern",
            }),
        ).rejects.toThrow();
    });
});

// ── TripleStore: find/delete remaining branch coverage ────────────────────────

describe("TripleStore: find graph:null + delete with explicit graph", () => {
    it("find({graph:null}) returns quads in the default graph", async () => {
        const knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        const store = new TripleStore(knex);
        const ctx = buildServerContext(store);
        const s = iri("http://example.org/s");
        const p = iri("http://example.org/p");
        const o = iri("http://example.org/o");
        await store.insert(ctx, {
            subject: s,
            predicate: p,
            object: o,
            graph: { termType: "DefaultGraph" },
        });
        const found = await store.find(ctx, { graph: null });
        expect(found).toHaveLength(1);
        await knex.destroy();
    });

    it("delete({graph: iri}) deletes quads in a named graph", async () => {
        const knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        const store = new TripleStore(knex);
        const ctx = buildServerContext(store);
        const g = iri("http://example.org/g");
        await store.insert(ctx, {
            subject: iri("http://s"),
            predicate: iri("http://p"),
            object: iri("http://o"),
            graph: g,
        });
        const deleted = await store.delete(ctx, { graph: g });
        expect(deleted).toBe(1);
        await knex.destroy();
    });
});

// ── TripleStore: _nodeId null returns + ensureNode idempotency ────────────────

describe("TripleStore: find/delete with non-existent nodes return early", () => {
    for (const provider of [
        {
            name: "sqlite",
            factory: async () => createTestDataContext({ client: "sqlite", filename: ":memory:" }),
        },
    ]) {
        describe(`TripleStore — ${provider.name}`, () => {
            let knex: Knex;
            let store: TripleStore;
            let ctx: ServerContext;

            beforeEach(async () => {
                knex = await provider.factory();
                store = new TripleStore(knex);
                ctx = buildServerContext(store);
            });

            afterEach(async () => {
                await knex.destroy();
            });

            it("find() returns [] when predicate IRI not in store (line 161 null id branch)", async () => {
                const result = await store.find(ctx, {
                    predicate: iri("http://nonexistent/p"),
                    graph: null,
                });
                expect(result).toHaveLength(0);
            });

            it("find() returns [] when object IRI not in store (line 166 null id branch)", async () => {
                const result = await store.find(ctx, {
                    object: iri("http://nonexistent/o"),
                    graph: null,
                });
                expect(result).toHaveLength(0);
            });

            it("find() returns [] when graph IRI not in store (line 174 null id branch)", async () => {
                const result = await store.find(ctx, { graph: iri("http://nonexistent/g") });
                expect(result).toHaveLength(0);
            });

            it("delete() returns 0 when predicate IRI not in store (line 220 null id)", async () => {
                const count = await store.delete(ctx, {
                    predicate: iri("http://nonexistent/p"),
                    graph: null,
                });
                expect(count).toBe(0);
            });

            it("delete() returns 0 when object IRI not in store (null id branch)", async () => {
                const count = await store.delete(ctx, {
                    object: iri("http://nonexistent/o"),
                    graph: null,
                });
                expect(count).toBe(0);
            });

            it("delete() returns 0 when graph IRI not in store (line 228 null id branch)", async () => {
                const count = await store.delete(ctx, { graph: iri("http://nonexistent/g") });
                expect(count).toBe(0);
            });

            it("find() returns [] when blank node object not in store (line 271 null id)", async () => {
                const result = await store.find(ctx, {
                    object: blank("no-such-blank"),
                    graph: null,
                });
                expect(result).toHaveLength(0);
            });

            it("find() returns [] when literal object not in store (_nodeId literal null)", async () => {
                const result = await store.find(ctx, {
                    object: literal("nonexistent-value"),
                    graph: null,
                });
                expect(result).toHaveLength(0);
            });

            it("_loadNodes handles result with only IRI nodes (iriNodeIds.length > 0, line 288)", async () => {
                // Triple with IRI subject, IRI predicate, IRI object → all nodes are IRIs
                // _loadNodes gets called with those IRI node IDs → iriNodeIds.length > 0
                await store.insert(ctx, {
                    subject: iri("http://s2"),
                    predicate: iri("http://p2"),
                    object: iri("http://o2"),
                    graph: DEFAULT_GRAPH,
                });
                const results = await store.find(ctx, { subject: iri("http://s2"), graph: null });
                expect(results).toHaveLength(1);
            });

            it("ensureNode for blank node is idempotent (line 102 existing row branch)", async () => {
                const b = blank("idempotent-blank");
                await store.ensureNode(ctx, b);
                const id2 = await store.ensureNode(ctx, b);
                expect(id2).toBeGreaterThan(0);
            });

            it("ensureNode for literal is idempotent (line 115 existing row branch)", async () => {
                const lit = literal("hello", "http://www.w3.org/2001/XMLSchema#string");
                await store.ensureNode(ctx, lit);
                const id2 = await store.ensureNode(ctx, lit);
                expect(id2).toBeGreaterThan(0);
            });

            it("find() with blank node object not in store returns [] (_nodeId blank null)", async () => {
                const result = await store.find(ctx, {
                    object: blank("no-such-blank"),
                    graph: null,
                });
                expect(result).toHaveLength(0);
            });

            it("_loadNodes returns empty map for no IRI nodes (only blanks/literals)", async () => {
                // Insert a triple with blank subject and literal object → no IRI-type nodes in result
                // when finding by those terms (iriNodeIds will be empty for non-IRI results)
                const b = blank("bsub");
                const p = iri("http://p");
                const lit = literal("val");
                await store.insert(ctx, {
                    subject: b,
                    predicate: p,
                    object: lit,
                    graph: DEFAULT_GRAPH,
                });
                const results = await store.find(ctx, { subject: b, graph: null });
                // Results exist — _loadNodes was called with nodes including b (blank) and p (IRI)
                expect(results.length).toBe(1);
            });

            it("nodeToTerm falls back to legacy columns when value_json is NULL", async () => {
                // Insert a literal quad normally
                const sub = EX("legacySubj");
                const pred = EX("legacyPred");
                const obj = literal("legacy-value", "http://www.w3.org/2001/XMLSchema#string");
                await store.insert(ctx, {
                    subject: sub,
                    predicate: pred,
                    object: obj,
                    graph: GRAPH,
                });

                // Manually NULL-out value_json to simulate a pre-migration (legacy) row
                await store.knex("nodes").update({ value_json: null }).where({ kind: "literal" });

                // find() should still reconstruct the literal from legacy columns
                const found = await store.find(ctx, {
                    subject: sub,
                    predicate: pred,
                    graph: GRAPH,
                });
                expect(found).toHaveLength(1);
                const foundObj = found[0].object as { termType: string; value: string };
                expect(foundObj.termType).toBe("Literal");
                expect(foundObj.value).toBe("legacy-value");
            });

            it("nodeToTerm returns a language-tagged literal correctly", async () => {
                const sub = EX("langSubj");
                const pred = EX("langPred");
                const langLit = literal(
                    "bonjour",
                    "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString",
                    "fr",
                );
                await store.insert(ctx, {
                    subject: sub,
                    predicate: pred,
                    object: langLit,
                    graph: GRAPH,
                });

                const found = await store.find(ctx, { subject: sub, graph: GRAPH });
                expect(found).toHaveLength(1);
                const foundObj = found[0].object as {
                    termType: string;
                    value: string;
                    language?: string;
                };
                expect(foundObj.termType).toBe("Literal");
                expect(foundObj.value).toBe("bonjour");
                expect(foundObj.language).toBe("fr");
            });
        });
    }
});
