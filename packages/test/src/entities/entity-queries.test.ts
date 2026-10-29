/**
 * Auth entity query integration tests — list queries and join traversal.
 *
 * All tests run against both SQLite and Postgres (when SYS_PG_URL is set),
 * each suite inside a rolled-back transaction.
 *
 * Schemas under test:
 *   UserSchema       (CoreHandle)         — auth:User
 *   UserDeviceSchema (DeviceCoreHandle)   — auth:UserDevice
 *   UserSessionSchema (SessionCoreHandle) — auth:UserSession
 *
 * Queries under test:
 *   listUsers()
 *   listUserDevices()
 *   listActiveSessions()  / listInactiveSessions()
 *   findUserWithRecentActivity()        ← join: User → Session → Device
 *   findSessionsByTokens()              ← lookup by token strings
 *   findUserBySession()                 ← join: Session.sessionUser → User
 */

import {
    findSessionsByTokens,
    findUserBySession,
    findUserWithRecentActivity,
    listActiveSessions,
    listInactiveSessions,
    listUserDevices,
    listUsers,
    UserDeviceSchema,
    UserSchema,
    UserSessionSchema,
} from "@terncosoftware/auth";
import { TripleStore } from "@terncosoftware/data";
import { buildServerContext, EntityStore } from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";
import { TEST_CIPHER } from "../auth/testCipher.js";

// ── DB provider matrix ────────────────────────────────────────────────────────

interface DbProvider {
    name: string;
    create(): Promise<Knex>;
}

const providers: DbProvider[] = [
    { name: "SQLite", create: () => createTestDataContext({ client: "sqlite", filename: ":memory:" }) },
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

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setup(db: DbProvider) {
    const knex = await db.create();
    const trx = await knex.transaction();
    // Use trx as the knex instance so es.inTransaction() creates savepoints
    // rather than new connection-level transactions (avoids SQLite deadlock).
    const store = new TripleStore(trx as unknown as import("knex").Knex);
    const es = new EntityStore(store, undefined, TEST_CIPHER);
    return { ...buildServerContext(store, { trx, cipher: TEST_CIPHER }), knex, trx, es };
}

async function teardown(ctx: Awaited<ReturnType<typeof setup>>) {
    await ctx.trx.rollback();
    await assertEmptyStore(ctx.knex);
    await ctx.knex.destroy();
}

/** Creates a user, device, and session atomically, returning all three records. */
async function makeUserWithSession(
    es: EntityStore,
    email: string,
    opts: { isActive?: boolean; deviceUserAgent?: string } = {},
) {
    return es.inTransaction(async (ctx) => {
        const user = await es.create(ctx, UserSchema, { email });
        const device = await es.create(ctx, UserDeviceSchema, {
            deviceUser: user.iri,
            deviceUserAgent: opts.deviceUserAgent ?? "TestBrowser/1.0",
            devicePlatform: "web",
        });
        // TODO: Move to constants/config
        const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
        const session = await es.create(ctx, UserSessionSchema, {
            sessionUser: user.iri,
            sessionDevice: device.iri,
            expiresAt,
            isActive: opts.isActive ?? true,
        });
        return { user, device, session };
    });
}

// ─────────────────────────────────────────────────────────────────────────────

for (const db of providers) {
    // ── listUsers ─────────────────────────────────────────────────────────────

    describe(`listUsers (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        beforeEach(async () => {
            ctx = await setup(db);
            ({ es } = ctx);
        });
        afterEach(async () => {
            await teardown(ctx);
        });

        it("returns empty array when no users exist", async () => {
            const users = await listUsers(ctx, es);
            expect(users).toHaveLength(0);
        });

        it("returns all users", async () => {
            await es.create(ctx, UserSchema, { email: "a@test.com" });
            await es.create(ctx, UserSchema, { email: "b@test.com" });
            await es.create(ctx, UserSchema, { email: "c@test.com" });
            const users = await listUsers(ctx, es);
            expect(users).toHaveLength(3);
        });

        it("each user record has id, iri, and core group", async () => {
            await es.create(ctx, UserSchema, { email: "alice@test.com", displayName: "Alice" });
            const [user] = await listUsers(ctx, es);
            expect(user?.id).toBeTruthy();
            expect(user?.iri).toContain("urn:sys:core:auth:user:");
            expect(user?.props.email).toBe("alice@test.com");
            expect(user?.props.displayName).toBe("Alice");
        });
    });

    // ── listUserDevices ───────────────────────────────────────────────────────

    describe(`listUserDevices (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        beforeEach(async () => {
            ctx = await setup(db);
            ({ es } = ctx);
        });
        afterEach(async () => {
            await teardown(ctx);
        });

        it("returns empty array when no devices exist", async () => {
            expect(await listUserDevices(ctx, es)).toHaveLength(0);
        });

        it("returns all devices across all users", async () => {
            const alice = await es.create(ctx, UserSchema, { email: "a@test.com" });
            const bob = await es.create(ctx, UserSchema, { email: "b@test.com" });
            await es.create(ctx, UserDeviceSchema, {
                deviceUser: alice.iri,
                devicePlatform: "web",
            });
            await es.create(ctx, UserDeviceSchema, {
                deviceUser: alice.iri,
                devicePlatform: "ios",
            });
            await es.create(ctx, UserDeviceSchema, {
                deviceUser: bob.iri,
                devicePlatform: "android",
            });
            const devices = await listUserDevices(ctx, es);
            expect(devices).toHaveLength(3);
        });

        it("device record contains deviceUser IRI for join traversal", async () => {
            const user = await es.create(ctx, UserSchema, { email: "a@test.com" });
            await es.create(ctx, UserDeviceSchema, {
                deviceUser: user.iri,
                deviceUserAgent: "Chrome/120",
                devicePlatform: "web",
            });
            const [device] = await listUserDevices(ctx, es);
            const deviceUserIri = device?.props.deviceUser as string;
            expect(deviceUserIri).toBe(user.iri);
        });
    });

    // ── listActiveSessions / listInactiveSessions ─────────────────────────────

    describe(`listActiveSessions / listInactiveSessions (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        beforeEach(async () => {
            ctx = await setup(db);
            ({ es } = ctx);
        });
        afterEach(async () => {
            await teardown(ctx);
        });

        it("separates active and inactive sessions", async () => {
            const { user, device } = await makeUserWithSession(es, "x@test.com");
            await es.create(ctx, UserSessionSchema, {
                sessionUser: user.iri,
                sessionDevice: device.iri,
                expiresAt: new Date(Date.now() + 3600_000),
                isActive: false,
            });

            const active = await listActiveSessions(ctx, es);
            const inactive = await listInactiveSessions(ctx, es);

            expect(active.every((s) => s.props.isActive === true)).toBe(
                true,
            );
            expect(inactive.every((s) => s.props.isActive === false)).toBe(
                true,
            );
            expect(active.length + inactive.length).toBe(2);
        });

        it("listActiveSessions returns empty when all sessions revoked", async () => {
            const { user: _user, device: _device } = await makeUserWithSession(es, "y@test.com", {
                isActive: false,
            });
            expect(await listActiveSessions(ctx, es)).toHaveLength(0);
            expect(await listInactiveSessions(ctx, es)).toHaveLength(1);
        });

        it("active session record has isActive = true and sessionUser IRI", async () => {
            const { user } = await makeUserWithSession(es, "z@test.com");
            const [sess] = await listActiveSessions(ctx, es);
            expect(sess?.props.isActive).toBe(true);
            expect(sess?.props.sessionUser).toBe(user.iri);
        });
    });

    // ── findUserWithRecentActivity (join) ─────────────────────────────────────

    describe(`findUserWithRecentActivity (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        beforeEach(async () => {
            ctx = await setup(db);
            ({ es } = ctx);
        });
        afterEach(async () => {
            await teardown(ctx);
        });

        it("returns null for unknown userId", async () => {
            const result = await findUserWithRecentActivity(ctx, es, "no-such-id");
            expect(result).toBeNull();
        });

        it("returns user with null session and device when user has no sessions", async () => {
            const user = await es.create(ctx, UserSchema, { email: "a@test.com" });
            const result = await findUserWithRecentActivity(ctx, es, user.id);
            expect(result).not.toBeNull();
            expect(result?.user.id).toBe(user.id);
            expect(result?.session).toBeNull();
            expect(result?.device).toBeNull();
        });

        it("joins session and device onto the user record", async () => {
            const { user, device, session } = await makeUserWithSession(es, "b@test.com");
            const result = await findUserWithRecentActivity(ctx, es, user.id);

            expect(result?.user.iri).toBe(user.iri);
            expect(result?.session?.id).toBe(session.id);
            expect(result?.device?.id).toBe(device.id);
        });

        it("returns the most recent session when user has multiple", async () => {
            const { user, device } = await makeUserWithSession(es, "c@test.com");

            // Add a second session (created after the first)
            const laterSession = await es.create(ctx, UserSessionSchema, {
                sessionUser: user.iri,
                sessionDevice: device.iri,
                expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
            });

            const result = await findUserWithRecentActivity(ctx, es, user.id);
            expect(result?.session?.id).toBe(laterSession.id);
        });

        it("resolves device from most-recent session, not older sessions", async () => {
            const user = await es.create(ctx, UserSchema, { email: "d@test.com" });
            const device1 = await es.create(ctx, UserDeviceSchema, {
                deviceUser: user.iri,
                devicePlatform: "web",
            });
            const device2 = await es.create(ctx, UserDeviceSchema, {
                deviceUser: user.iri,
                devicePlatform: "ios",
            });

            await es.create(ctx, UserSessionSchema, {
                sessionUser: user.iri,
                sessionDevice: device1.iri,
                expiresAt: new Date(Date.now() + 1_000),
            });
            // Second (more recent) session uses device2
            const newerSession = await es.create(ctx, UserSessionSchema, {
                sessionUser: user.iri,
                sessionDevice: device2.iri,
                expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
            });

            const result = await findUserWithRecentActivity(ctx, es, user.id);
            expect(result?.session?.id).toBe(newerSession.id);
            expect(result?.device?.id).toBe(device2.id);
            const platform = result?.device?.props.devicePlatform;
            expect(platform).toBe("ios");
        });
    });

    // ── findSessionsByTokens ──────────────────────────────────────────────────

    describe(`findSessionsByTokens (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        beforeEach(async () => {
            ctx = await setup(db);
            ({ es } = ctx);
        });
        afterEach(async () => {
            await teardown(ctx);
        });

        it("returns empty array for unknown tokens", async () => {
            const results = await findSessionsByTokens(ctx, es, ["bad-token-1", "bad-token-2"]);
            expect(results).toHaveLength(0);
        });

        it("finds a single session by token", async () => {
            const { session } = await makeUserWithSession(es, "e@test.com");
            const token = session.props.sessionToken as string;

            const results = await findSessionsByTokens(ctx, es, [token]);
            expect(results).toHaveLength(1);
            expect(results[0]?.id).toBe(session.id);
        });

        it("finds multiple sessions by their tokens", async () => {
            const { session: s1 } = await makeUserWithSession(es, "f1@test.com");
            const { session: s2 } = await makeUserWithSession(es, "f2@test.com");
            const t1 = s1.props.sessionToken as string;
            const t2 = s2.props.sessionToken as string;

            const results = await findSessionsByTokens(ctx, es, [t1, t2]);
            expect(results).toHaveLength(2);
            const ids = results.map((r) => r.id);
            expect(ids).toContain(s1.id);
            expect(ids).toContain(s2.id);
        });

        it("ignores tokens that do not exist", async () => {
            const { session } = await makeUserWithSession(es, "g@test.com");
            const token = session.props.sessionToken as string;

            const results = await findSessionsByTokens(ctx, es, [token, "ghost-token"]);
            expect(results).toHaveLength(1);
            expect(results[0]?.id).toBe(session.id);
        });

        it("session records include isActive and sessionUser for further joins", async () => {
            const { user, session } = await makeUserWithSession(es, "h@test.com");
            const token = session.props.sessionToken as string;

            const [found] = await findSessionsByTokens(ctx, es, [token]);
            expect(found?.props.isActive).toBe(true);
            expect(found?.props.sessionUser).toBe(user.iri);
        });
    });

    // ── findUserBySession (join) ──────────────────────────────────────────────

    describe(`findUserBySession (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        beforeEach(async () => {
            ctx = await setup(db);
            ({ es } = ctx);
        });
        afterEach(async () => {
            await teardown(ctx);
        });

        it("returns null for an unknown token", async () => {
            const user = await findUserBySession(ctx, es, "ghost-token");
            expect(user).toBeNull();
        });

        it("resolves the owning user from a session token", async () => {
            const { user, session } = await makeUserWithSession(es, "i@test.com");
            const token = session.props.sessionToken as string;

            const found = await findUserBySession(ctx, es, token);
            expect(found).not.toBeNull();
            expect(found?.id).toBe(user.id);
            expect(found?.props.email).toBe("i@test.com");
        });

        it("returns the correct user when multiple users exist", async () => {
            const { session: _s1 } = await makeUserWithSession(es, "j1@test.com");
            const { user: u2, session: s2 } = await makeUserWithSession(es, "j2@test.com");

            const token = s2.props.sessionToken as string;
            const found = await findUserBySession(ctx, es, token);
            expect(found?.id).toBe(u2.id);
            expect(found?.props.email).toBe("j2@test.com");
        });

        it("works for inactive sessions (token still resolves user)", async () => {
            const { user, session } = await makeUserWithSession(es, "k@test.com", {
                isActive: false,
            });
            const token = session.props.sessionToken as string;

            const found = await findUserBySession(ctx, es, token);
            expect(found?.id).toBe(user.id);
        });
    });
}
