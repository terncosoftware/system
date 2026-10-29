/**
 * Phase 3 - batched hydration has no N+1.
 *
 * EntityStore.hydrateMany loads N entities via TripleStore.findForSubjects and
 * entityTimestamps. Both used to resolve each subject IRI to its node id with a
 * separate SELECT (Promise.all(subjects.map(_nodeId))), so hydrating N entities
 * cost ~2N+3 queries. With the batched _nodeIds resolver the subject ids are
 * resolved in one round-trip, so the query count is independent of N.
 *
 * This guards that invariant by counting real queries (via the knex 'query'
 * event, not a mock) for two different N and asserting they are equal.
 *
 * Runs against SQLite (always) and Postgres (when SYS_PG_URL is set).
 */

import { IRI } from "@terncosoftware/core";
import { type Knex, TripleStore } from "@terncosoftware/data";
import { EntitySchema } from "@terncosoftware/entities";
import { buildServerContext, EntityStore } from "@terncosoftware/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

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

function makeSchema() {
    return new EntitySchema({
        typeIRI: new IRI("http://test.dev/batch/Item"),
        ns: "http://test.dev/batch/",
        idSegment: "item",
        properties: {
            name: new IRI("http://test.dev/batch/name"),
            score: new IRI("http://test.dev/batch/score"),
        },
    });
}

for (const db of providers) {
    describe(`hydrateMany batching (no N+1) - ${db.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let store: TripleStore;
        let es: EntityStore;
        let ctx: ReturnType<typeof buildServerContext>;
        const schema = makeSchema();

        beforeEach(async () => {
            knex = await db.create();
            trx = await knex.transaction();
            store = new TripleStore(knex);
            es = new EntityStore(store);
            ctx = buildServerContext(store, { trx });
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        async function createN(n: number): Promise<string[]> {
            const iris: string[] = [];
            for (let i = 0; i < n; i++) {
                const rec = await es.create(ctx, schema, { name: `n${i}`, score: i });
                iris.push(rec.iri);
            }
            return iris;
        }

        async function countQueries(fn: () => Promise<unknown>): Promise<number> {
            let count = 0;
            const onQuery = () => {
                count += 1;
            };
            knex.on("query", onQuery);
            try {
                await fn();
            } finally {
                knex.removeListener("query", onQuery);
            }
            return count;
        }

        it("hydrateMany query count is independent of N", async () => {
            const small = await createN(2);
            const large = await createN(8);

            const smallRecs = await es.hydrateMany(ctx, schema, small);
            expect(smallRecs).toHaveLength(2);
            const largeRecs = await es.hydrateMany(ctx, schema, large);
            expect(largeRecs).toHaveLength(8);
            // Hydration is correct (props + timestamps present).
            expect(largeRecs[0]?.props.name).toBe("n0");
            expect(largeRecs[0]?.createdAt).toBeInstanceOf(Date);

            const q2 = await countQueries(() => es.hydrateMany(ctx, schema, small));
            const q8 = await countQueries(() => es.hydrateMany(ctx, schema, large));

            expect(q2).toBeGreaterThan(0); // sanity: queries were observed
            expect(q8).toBe(q2); // constant query count -> no per-entity N+1
        });
    });
}
