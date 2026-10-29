/**
 * Auth + RBAC enforcement tests (TRN-203).
 *
 * Proves deny-by-default and allow-on-grant for the cross-user session
 * administration operations on AuthService: a non-system principal without a
 * grant is denied, the same principal acting on its OWN sessions is allowed
 * without a grant, and a granted admin permission unlocks another user's
 * sessions. The internal system principal keeps bypassing RBAC, so the
 * token-resolved HTTP edge (which uses systemSec) is unaffected.
 *
 * Runs against both SQLite (always) and Postgres (when SYS_PG_URL is set),
 * each inside a rolled-back transaction.
 */

import {
    AuthService,
    GoogleProvider,
    MemorySessionStore,
    PERM_SESSION_LIST_ANY,
    PERM_SESSION_REVOKE_ANY,
    UserDeviceRepository,
    UserIdentityRepository,
    UserRepository,
    UserSessionRepository,
} from "@terncosoftware/auth";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";
import { TEST_CIPHER } from "./testCipher.js";

// ── Provider matrix ───────────────────────────────────────────────────────────

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

// ── Helpers ─────────────────────────────────────────────────────────────────

function secFor(principalIri: string): SecurityContext {
    return { principalIri, sessionId: null, isImpersonating: false };
}

function makeRbacService(store: TripleStore): RbacService {
    return new RbacService({
        store,
        tenants: new TenantRepository(store),
        groups: new UserGroupRepository(store),
        roles: new RoleRepository(store),
        grants: new PolicyGrantRepository(store),
        permissions: new PermissionRepository(store),
        resources: new ResourceNodeRepository(store),
        serviceAccounts: new ServiceAccountRepository(store),
    });
}

function makeAuthService(store: TripleStore, rbac: RbacService): AuthService {
    return new AuthService({
        providers: [new GoogleProvider("cid", "cs")],
        sessionStore: new MemorySessionStore(),
        users: new UserRepository(store, TEST_CIPHER),
        identities: new UserIdentityRepository(store, TEST_CIPHER),
        sessions: new UserSessionRepository(store),
        devices: new UserDeviceRepository(store),
        rbac,
    });
}

/** Grant `permission` to `principalIri` via a fresh single-permission role. */
async function grantPermission(
    ctx: ServerContext,
    rbac: RbacService,
    principalIri: string,
    permissionKey: string,
): Promise<void> {
    const perm = await rbac.createPermission(ctx, systemSec, { key: permissionKey });
    const role = await rbac.createRole(ctx, systemSec, {
        roleName: `role-${permissionKey}`,
        tenantId: null,
    });
    await rbac.addPermissionToRole(ctx, systemSec, {
        roleIri: role.iri,
        permissionIri: perm.iri,
    });
    await rbac.grant(ctx, systemSec, { principalIri, roleIri: role.iri });
}

for (const provider of providers) {
    describe(`AuthService + RBAC — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let rbac: RbacService;
        let svc: AuthService;
        let users: UserRepository;
        let sessions: UserSessionRepository;
        let devices: UserDeviceRepository;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            store = new TripleStore(knex);
            ctx = buildServerContext(store, { trx });
            // Seed inside the test transaction so afterEach's rollback removes it.
            await seedSystemData(ctx, store);
            rbac = makeRbacService(store);
            svc = makeAuthService(store, rbac);
            users = new UserRepository(store, TEST_CIPHER);
            sessions = new UserSessionRepository(store);
            devices = new UserDeviceRepository(store);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        async function makeUserWithSession(email: string) {
            const user = await users.create(ctx, systemSec, { email });
            const device = await devices.findOrCreate(ctx, systemSec, {
                userId: user.id,
                info: { userAgent: `ua-${email}` },
            });
            await sessions.create(ctx, systemSec, {
                userId: user.id,
                deviceId: device.id,
                expiresAt: new Date(Date.now() + 60_000),
            });
            return user;
        }

        // ── listSessions ──────────────────────────────────────────────────────

        it("listSessions: denies a non-system principal listing ANOTHER user's sessions without a grant", async () => {
            const alice = await makeUserWithSession("alice@test.com");
            const bob = await makeUserWithSession("bob@test.com");

            await expect(
                svc.listSessions(ctx, secFor(bob.iri), { userId: alice.id }),
            ).rejects.toThrow(/Access denied/);
        });

        it("listSessions: allows a principal to list its OWN sessions without any grant", async () => {
            const alice = await makeUserWithSession("alice@test.com");

            const result = await svc.listSessions(ctx, secFor(alice.iri), { userId: alice.id });
            expect(result).toHaveLength(1);
            expect(result[0]?.userId).toBe(alice.id);
        });

        it("listSessions: allows listing another user's sessions once tern.auth:session.list.any is granted", async () => {
            const alice = await makeUserWithSession("alice@test.com");
            const admin = await makeUserWithSession("admin@test.com");
            await grantPermission(ctx, rbac, admin.iri, PERM_SESSION_LIST_ANY);

            const result = await svc.listSessions(ctx, secFor(admin.iri), { userId: alice.id });
            expect(result).toHaveLength(1);
            expect(result[0]?.userId).toBe(alice.id);
        });

        it("listSessions: the system principal bypasses RBAC (token-resolved edge path)", async () => {
            const alice = await makeUserWithSession("alice@test.com");
            const result = await svc.listSessions(ctx, systemSec, { userId: alice.id });
            expect(result).toHaveLength(1);
        });

        // ── revokeAllSessions ───────────────────────────────────────────────────

        it("revokeAllSessions: denies a non-system principal revoking ANOTHER user's sessions without a grant", async () => {
            const alice = await makeUserWithSession("alice@test.com");
            const bob = await makeUserWithSession("bob@test.com");

            await expect(
                svc.revokeAllSessions(ctx, secFor(bob.iri), { userId: alice.id }),
            ).rejects.toThrow(/Access denied/);
        });

        it("revokeAllSessions: allows a principal to revoke its OWN sessions without any grant", async () => {
            const alice = await makeUserWithSession("alice@test.com");

            const revoked = await svc.revokeAllSessions(ctx, secFor(alice.iri), {
                userId: alice.id,
            });
            expect(revoked).toBe(1);
        });

        it("revokeAllSessions: allows revoking another user's sessions once tern.auth:session.revoke.any is granted", async () => {
            const alice = await makeUserWithSession("alice@test.com");
            const admin = await makeUserWithSession("admin@test.com");
            await grantPermission(ctx, rbac, admin.iri, PERM_SESSION_REVOKE_ANY);

            const revoked = await svc.revokeAllSessions(ctx, secFor(admin.iri), {
                userId: alice.id,
            });
            expect(revoked).toBe(1);
        });

        it("revokeAllSessions: a list.any grant does NOT satisfy a revoke.any check (deny-by-default)", async () => {
            const alice = await makeUserWithSession("alice@test.com");
            const admin = await makeUserWithSession("admin@test.com");
            await grantPermission(ctx, rbac, admin.iri, PERM_SESSION_LIST_ANY);

            await expect(
                svc.revokeAllSessions(ctx, secFor(admin.iri), { userId: alice.id }),
            ).rejects.toThrow(/Access denied/);
        });
    });
}
