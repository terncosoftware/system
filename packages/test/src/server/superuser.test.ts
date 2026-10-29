/**
 * Superuser membership integration tests.
 *
 * SuperuserService is a thin facade over RBAC's SYS_SUPERUSERS group (seeded by
 * migration 004_rbac). Runs against SQLite (always) and Postgres (when
 * SYS_PG_URL is set), each in a rolled-back transaction.
 */

import { TripleStore } from "@terncosoftware/data";
import {
    buildServerContext,
    PermissionRepository,
    PolicyGrantRepository,
    RbacService,
    ResourceNodeRepository,
    RoleRepository,
    type ServerContext,
    ServiceAccountRepository,
    SuperuserService,
    seedSystemData,
    systemSec,
    TenantRepository,
    UserGroupRepository,
} from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

interface DbProvider {
    name: string;
    create(): Promise<Knex>;
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

const ALICE = "urn:sys:core:auth:user:test-alice";
const BOB = "urn:sys:core:auth:user:test-bob";

for (const provider of providers) {
    describe(`SuperuserService — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let superusers: SuperuserService;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            store = new TripleStore(knex);
            ctx = buildServerContext(store, { trx });
            // Seed inside the transaction so afterEach's rollback removes it.
            await seedSystemData(ctx, store);

            const rbac = new RbacService({
                store,
                tenants: new TenantRepository(store),
                groups: new UserGroupRepository(store),
                roles: new RoleRepository(store),
                grants: new PolicyGrantRepository(store),
                permissions: new PermissionRepository(store),
                resources: new ResourceNodeRepository(store),
                serviceAccounts: new ServiceAccountRepository(store),
            });
            superusers = new SuperuserService(rbac);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("reports a non-member as not a superuser", async () => {
            expect(await superusers.isSuperuser(ctx, systemSec, { userIri: ALICE })).toBe(false);
            expect(await superusers.list(ctx, systemSec)).not.toContain(ALICE);
        });

        it("grants and revokes superuser membership", async () => {
            await superusers.grant(ctx, systemSec, { userIri: ALICE });
            expect(await superusers.isSuperuser(ctx, systemSec, { userIri: ALICE })).toBe(true);
            expect(await superusers.list(ctx, systemSec)).toContain(ALICE);

            await superusers.revoke(ctx, systemSec, { userIri: ALICE });
            expect(await superusers.isSuperuser(ctx, systemSec, { userIri: ALICE })).toBe(false);
            expect(await superusers.list(ctx, systemSec)).not.toContain(ALICE);
        });

        it("tracks multiple superusers independently", async () => {
            await superusers.grant(ctx, systemSec, { userIri: ALICE });
            await superusers.grant(ctx, systemSec, { userIri: BOB });
            const members = await superusers.list(ctx, systemSec);
            expect(members).toContain(ALICE);
            expect(members).toContain(BOB);

            await superusers.revoke(ctx, systemSec, { userIri: ALICE });
            expect(await superusers.isSuperuser(ctx, systemSec, { userIri: BOB })).toBe(true);
            expect(await superusers.isSuperuser(ctx, systemSec, { userIri: ALICE })).toBe(false);
        });
    });
}
