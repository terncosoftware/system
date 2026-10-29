/**
 * TRN-214: a permission is found by key in the caller's tenant graph only.
 *
 * Every product bootstraps a tenant's RBAC by find-or-create: look the
 * permission up by key, create it when absent, and grant it to the tenant's
 * roles. When the lookup reached past the tenant graph, the second tenant found
 * the first tenant's permission, created none of its own, and granted its roles
 * a permission whose key lives in another graph. The access checker resolves
 * keys in the caller's graph only, so every later tenant was silently denied.
 *
 * Real Postgres only, each test in a rolled-back transaction.
 */

import { TripleStore } from "@terncosoftware/data";
import {
    buildServerContext,
    PermissionRepository,
    PolicyGrantRepository,
    RbacService,
    ResourceNodeRepository,
    RoleRepository,
    type SecurityContext,
    type ServerContext,
    ServiceAccountRepository,
    seedSystemData,
    systemSec,
    TenantRepository,
    UserGroupRepository,
} from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

const PG_URL = process.env.SYS_PG_URL ?? "postgresql://sys:sys@localhost:5432/sys";

const PERMISSION_KEY = "project.read";
const ALICE = "urn:sys:core:auth:user:test-alice";
const DAVE = "urn:sys:core:auth:user:test-dave";

function pgContext(): Promise<Knex> {
    const url = new URL(PG_URL);
    return createTestDataContext({
        client: "pg",
        host: url.hostname,
        port: url.port ? Number(url.port) : 5432,
        database: url.pathname.slice(1),
        user: url.username,
        password: url.password,
    });
}

function secFor(principalIri: string): SecurityContext {
    return { principalIri, sessionId: null, isImpersonating: false };
}

interface Bootstrapped {
    permissionIri: string;
    roleIri: string;
}

describe("TRN-214: permissions resolve within the tenant graph", () => {
    let knex: Knex | null = null;
    let trx: Knex.Transaction | null = null;
    let store: TripleStore;
    let ctx: ServerContext;
    let rbac: RbacService;

    beforeAll(async () => {
        knex = await pgContext();
    });
    afterAll(async () => {
        if (knex !== null) {
            await knex.destroy();
            knex = null;
        }
    });

    beforeEach(async () => {
        if (knex === null) {
            throw new Error("Postgres connection was not established in beforeAll");
        }
        trx = await knex.transaction();
        store = new TripleStore(trx as unknown as Knex);
        ctx = buildServerContext(store, { trx });
        await seedSystemData(ctx, store);
        rbac = new RbacService({
            store,
            tenants: new TenantRepository(store),
            groups: new UserGroupRepository(store),
            roles: new RoleRepository(store),
            grants: new PolicyGrantRepository(store),
            permissions: new PermissionRepository(store),
            resources: new ResourceNodeRepository(store),
            serviceAccounts: new ServiceAccountRepository(store),
        });
    });
    afterEach(async () => {
        if (trx !== null && !trx.isCompleted()) {
            await trx.rollback();
        }
        trx = null;
        if (knex !== null) {
            await assertEmptyStore(knex);
        }
    });

    async function tenantCtx(name: string): Promise<ServerContext> {
        const tenant = await rbac.createTenant(ctx, systemSec, { name });
        return buildServerContext(store, { trx: trx as Knex.Transaction, tenantId: tenant.id });
    }

    /** Find-or-create the permission and grant it to a new role, as a product bootstrap does. */
    async function bootstrap(tctx: ServerContext): Promise<Bootstrapped> {
        const found = await rbac.findPermissionByKey(tctx, systemSec, { key: PERMISSION_KEY });
        const permission =
            found ?? (await rbac.createPermission(tctx, systemSec, { key: PERMISSION_KEY }));
        const role = await rbac.createRole(tctx, systemSec, {
            roleName: "Reader",
            tenantId: tctx.tenantId,
        });
        await rbac.addPermissionToRole(tctx, systemSec, {
            roleIri: role.iri,
            permissionIri: permission.iri,
        });
        return { permissionIri: permission.iri, roleIri: role.iri };
    }

    it("a tenant bootstrapped after another gets its own permission, and its roles resolve it", async () => {
        const acme = await tenantCtx("Acme Corp");
        const globex = await tenantCtx("Globex Corp");

        const a = await bootstrap(acme);
        const b = await bootstrap(globex);

        expect(b.permissionIri).not.toBe(a.permissionIri);
        expect(
            (await rbac.findPermissionByKey(globex, systemSec, { key: PERMISSION_KEY }))?.iri,
        ).toBe(b.permissionIri);
        expect(
            (await rbac.findPermissionByKey(acme, systemSec, { key: PERMISSION_KEY }))?.iri,
        ).toBe(a.permissionIri);

        await rbac.grant(globex, systemSec, { principalIri: DAVE, roleIri: b.roleIri });
        await rbac.grant(acme, systemSec, { principalIri: ALICE, roleIri: a.roleIri });
        expect(await rbac.can(globex, secFor(DAVE), { permission: PERMISSION_KEY })).toBe(true);
        expect(await rbac.can(acme, secFor(ALICE), { permission: PERMISSION_KEY })).toBe(true);
        expect(await rbac.can(acme, secFor(DAVE), { permission: PERMISSION_KEY })).toBe(false);
        expect(await rbac.can(globex, secFor(ALICE), { permission: PERMISSION_KEY })).toBe(false);
    });

    it("a tenant does not find a permission only another tenant holds", async () => {
        const acme = await tenantCtx("Acme Corp");
        const globex = await tenantCtx("Globex Corp");
        await rbac.createPermission(acme, systemSec, { key: PERMISSION_KEY });

        expect(
            await rbac.findPermissionByKey(globex, systemSec, { key: PERMISSION_KEY }),
        ).toBeNull();
    });
});
