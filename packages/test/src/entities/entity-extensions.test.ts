/**
 * Entity-layer extensions for the RBAC migration:
 *   - EntitySchema.graphIri: pin an entity type to a fixed, tenant-independent graph
 *   - EntityStore.addEdge / removeEdge: append/remove a single edge (many-edges)
 *   - EntityQuery.connectedToAny: reverse batched edge-membership filter
 * Runs against SQLite (always) and Postgres (when SYS_PG_URL is set).
 */

import { IRI } from "@terncosoftware/core";
import { TripleStore } from "@terncosoftware/data";
import { EntitySchema } from "@terncosoftware/entities";
import {
    buildServerContext,
    EntityQuery,
    EntityStore,
    type ServerContext,
} from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

const NS = "http://test.dev/ext/";
const FIXED_GRAPH = new IRI(`${NS}graph`);

interface GroupProps extends Record<string, unknown> {
    groupName: string;
}
// Members live in the same fixed graph; membership is a polymorphic edge.
const GroupSchema: EntitySchema<GroupProps> = new EntitySchema<GroupProps>({
    typeIRI: new IRI(`${NS}Group`),
    ns: NS,
    properties: { groupName: new IRI(`${NS}groupName`) },
    graphIri: FIXED_GRAPH,
    edges: {
        isMemberOf: {
            predicate: new IRI(`${NS}isMemberOf`),
            direction: "out",
            cardinality: "many",
        },
    },
});

interface Provider {
    name: string;
    create(): Promise<Knex>;
}
const providers: Provider[] = [
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

for (const provider of providers) {
    describe(`entity-layer extensions — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let store: TripleStore;
        let es: EntityStore;
        let ctx: ServerContext;

        beforeEach(async () => {
            knex = await provider.create();
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

        it("graphIri pins reads/writes to a fixed graph regardless of tenant", async () => {
            const tenantCtx = buildServerContext(store, { tenantId: "acme", trx });
            const g = await es.create(tenantCtx, GroupSchema, { groupName: "admins" });

            // The entity is written to the fixed graph, not the tenant graph.
            const inFixed = await store.find(ctx, { graph: FIXED_GRAPH });
            expect(inFixed.some((q) => (q.subject as IRI).value === g.iri)).toBe(true);

            // Found from a different (no-tenant) context, because the graph is fixed.
            const found = await es.findById(ctx, GroupSchema, g.id);
            expect(found?.props.groupName).toBe("admins");
        });

        it("addEdge appends a single edge without disturbing others; removeEdge soft-deletes it", async () => {
            const g = await es.create(ctx, GroupSchema, { groupName: "team" });
            const userA = `${NS}user/a`;
            const userB = `${NS}user/b`;

            await es.addEdge(ctx, GroupSchema, g.id, "isMemberOf", userA);
            await es.addEdge(ctx, GroupSchema, g.id, "isMemberOf", userB);

            let rec = await es.findById(ctx, GroupSchema, g.id);
            expect((rec?.edges?.isMemberOf as { iris: string[] }).iris.sort()).toEqual(
                [userA, userB].sort(),
            );

            const removed = await es.removeEdge(ctx, GroupSchema, g.id, "isMemberOf", userA);
            expect(removed).toBe(true);

            rec = await es.findById(ctx, GroupSchema, g.id);
            expect((rec?.edges?.isMemberOf as { iris: string[] }).iris).toEqual([userB]);
        });

        it("connectedToAny finds entities whose edge points at any target in a set", async () => {
            const g1 = await es.create(ctx, GroupSchema, { groupName: "g1" });
            const g2 = await es.create(ctx, GroupSchema, { groupName: "g2" });
            const g3 = await es.create(ctx, GroupSchema, { groupName: "g3" });
            const org1 = `${NS}org/1`;
            const org2 = `${NS}org/2`;
            const org3 = `${NS}org/3`;
            await es.addEdge(ctx, GroupSchema, g1.id, "isMemberOf", org1);
            await es.addEdge(ctx, GroupSchema, g2.id, "isMemberOf", org2);
            await es.addEdge(ctx, GroupSchema, g3.id, "isMemberOf", org3);

            const matches = await EntityQuery.from(store, GroupSchema)
                .connectedToAny("isMemberOf", [org1, org2])
                .all(ctx);
            expect(matches.map((m) => m.props.groupName).sort()).toEqual(["g1", "g2"]);
        });

        it("connectedToAny with an empty target set matches nothing", async () => {
            const g = await es.create(ctx, GroupSchema, { groupName: "g" });
            await es.addEdge(ctx, GroupSchema, g.id, "isMemberOf", `${NS}org/x`);
            const matches = await EntityQuery.from(store, GroupSchema)
                .connectedToAny("isMemberOf", [])
                .all(ctx);
            expect(matches).toEqual([]);
        });
    });
}
