import { type Knex, TripleStore } from "@terncosoftware/data";
import {
    buildServerContext,
    EntityStore,
    OrgSchema,
    type ServerContext,
    systemSec,
    TenantSchema,
} from "@terncosoftware/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

interface DbProvider {
    name: string;
    create: () => Promise<Knex>;
}

const providers: DbProvider[] = [
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

/** Builds a tenant with the named orgs attached under it in the tenant's graph. */
async function seedTree(
    es: EntityStore,
    ctx: ServerContext,
    tenantId: string,
    orgNames: string[],
): Promise<void> {
    await es.create(ctx, TenantSchema, { name: `tenant-${tenantId}` }, tenantId);
    for (const name of orgNames) {
        const org = await es.create(ctx, OrgSchema, { name });
        await es.addEdge(ctx, TenantSchema, tenantId, "org", org);
    }
}

for (const provider of providers) {
    describe(`GraphQuery rooted traversal — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let store: TripleStore;
        let es: EntityStore;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            store = new TripleStore(knex);
            es = new EntityStore(store);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        const ctxFor = (tenantId: string): ServerContext =>
            buildServerContext(store, { trx, tenantId });

        it("walks tenant→org to the orgs", async () => {
            const ctx = ctxFor("t1");
            await seedTree(es, ctx, "t1", ["alpha", "beta"]);

            const orgs = await ctx.graph(systemSec).out("org").all(OrgSchema);
            expect(orgs.map((o) => o.props.name).sort()).toEqual(["alpha", "beta"]);
        });

        it("filters the leaf with .where", async () => {
            const ctx = ctxFor("t1");
            await seedTree(es, ctx, "t1", ["alpha", "beta"]);

            const found = await ctx
                .graph(systemSec)
                .out("org")
                .where("name", "=", "alpha")
                .all(OrgSchema);
            expect(found.map((o) => o.props.name)).toEqual(["alpha"]);

            const none = await ctx
                .graph(systemSec)
                .out("org")
                .where("name", "=", "nobody")
                .all(OrgSchema);
            expect(none).toHaveLength(0);
        });

        it("isolates tenants: an org in tenant B is unreachable from tenant A", async () => {
            await seedTree(es, ctxFor("t1"), "t1", ["alice-org"]);
            await seedTree(es, ctxFor("t2"), "t2", ["bob-org"]);

            const fromA = await ctxFor("t1").graph(systemSec).out("org").all(OrgSchema);
            expect(fromA.map((o) => o.props.name)).toEqual(["alice-org"]);

            const fromB = await ctxFor("t2").graph(systemSec).out("org").all(OrgSchema);
            expect(fromB.map((o) => o.props.name)).toEqual(["bob-org"]);
        });

        it("reachability rigor: an org not attached under the tenant tree is invisible", async () => {
            const ctx = ctxFor("t1");
            await seedTree(es, ctx, "t1", ["attached"]);
            // An orphan org in the same tenant graph, never linked via hasOrg.
            await es.create(ctx, OrgSchema, { name: "orphan" });

            const orgs = await ctx.graph(systemSec).out("org").all(OrgSchema);
            expect(orgs.map((o) => o.props.name)).toEqual(["attached"]);
        });

        it("returns nothing when ctx has no tenant root", async () => {
            const ctx = ctxFor("t1");
            await seedTree(es, ctx, "t1", ["alpha"]);

            const rootless = buildServerContext(store, { trx }); // no tenantId
            const orgs = await rootless.graph(systemSec).out("org").all(OrgSchema);
            expect(orgs).toHaveLength(0);
        });
    });
}
