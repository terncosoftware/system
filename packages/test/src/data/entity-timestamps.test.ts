/**
 * TripleStore.entityTimestamps integration tests.
 *
 * Entity timestamps are derived from the edge rows' DB-managed created_at /
 * updated_at columns (populated by triggers), aggregated per subject:
 *   createdAt = MIN(created_at) over the subject's live edges
 *   updatedAt = MAX(updated_at) over the subject's live edges
 *
 * Postgres pins NOW() per transaction and these suites run inside one rolled-back
 * transaction, so wall-clock progression cannot be asserted; the tests verify
 * structural correctness (presence, batching, graph scoping, soft-delete
 * exclusion, updatedAt >= createdAt) rather than relative ordering over time.
 *
 * Runs against SQLite (always) and Postgres (when SYS_PG_URL is set).
 */

import type { IRI, Literal } from "@terncosoftware/core";
import { TripleStore } from "@terncosoftware/data";
import { buildServerContext, type ServerContext } from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

function iri(value: string): IRI {
    return { value } as IRI;
}

function literal(value: string): Literal {
    return {
        termType: "Literal",
        value,
        datatype: iri("http://www.w3.org/2001/XMLSchema#string"),
        language: undefined,
    };
}

const RDF_TYPE = iri("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
const NAME = iri("http://example.org/name");
const THING = iri("http://example.org/Thing");
const EX = (local: string) => iri(`http://example.org/${local}`);
const GRAPH_A = EX("graphA");
const GRAPH_B = EX("graphB");

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

for (const provider of providers) {
    describe(`TripleStore.entityTimestamps — ${provider.name}`, () => {
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
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("returns createdAt/updatedAt Dates for a subject with edges", async () => {
            const subj = EX("ent1");
            await store.insertMany(ctx, [
                { subject: subj, predicate: RDF_TYPE, object: THING, graph: GRAPH_A },
                { subject: subj, predicate: NAME, object: literal("Alice"), graph: GRAPH_A },
            ]);

            const ts = await store.entityTimestamps(ctx, [subj]);
            const got = ts.get(subj.value);
            expect(got).toBeDefined();
            expect(got?.createdAt).toBeInstanceOf(Date);
            expect(got?.updatedAt).toBeInstanceOf(Date);
            expect(got?.updatedAt.getTime()).toBeGreaterThanOrEqual(got?.createdAt.getTime() ?? 0);
        });

        it("batches multiple subjects in one call", async () => {
            const a = EX("a");
            const b = EX("b");
            await store.insertMany(ctx, [
                { subject: a, predicate: RDF_TYPE, object: THING, graph: GRAPH_A },
                { subject: b, predicate: RDF_TYPE, object: THING, graph: GRAPH_A },
            ]);

            const ts = await store.entityTimestamps(ctx, [a, b]);
            expect(ts.get(a.value)).toBeDefined();
            expect(ts.get(b.value)).toBeDefined();
            expect(ts.size).toBe(2);
        });

        it("returns an empty map for no subjects", async () => {
            const ts = await store.entityTimestamps(ctx, []);
            expect(ts.size).toBe(0);
        });

        it("omits subjects that have no edges", async () => {
            const known = EX("known");
            await store.insert(ctx, {
                subject: known,
                predicate: RDF_TYPE,
                object: THING,
                graph: GRAPH_A,
            });

            const ts = await store.entityTimestamps(ctx, [known, EX("ghost")]);
            expect(ts.get(known.value)).toBeDefined();
            expect(ts.has(EX("ghost").value)).toBe(false);
        });

        it("respects the graph filter", async () => {
            const subj = EX("scoped");
            await store.insert(ctx, {
                subject: subj,
                predicate: RDF_TYPE,
                object: THING,
                graph: GRAPH_A,
            });

            const inA = await store.entityTimestamps(ctx, [subj], GRAPH_A);
            expect(inA.get(subj.value)).toBeDefined();

            const inB = await store.entityTimestamps(ctx, [subj], GRAPH_B);
            expect(inB.has(subj.value)).toBe(false);
        });

        it("excludes a subject whose only edges are soft-deleted", async () => {
            const subj = EX("gone");
            await store.insert(ctx, {
                subject: subj,
                predicate: RDF_TYPE,
                object: THING,
                graph: GRAPH_A,
            });
            await store.delete(ctx, { subject: subj, graph: GRAPH_A });

            const ts = await store.entityTimestamps(ctx, [subj]);
            expect(ts.has(subj.value)).toBe(false);
        });
    });
}
