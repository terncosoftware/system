/**
 * Session revocation against real infrastructure.
 *
 * A revoked session must stop validating on the very next call, through the
 * warm fast-path cache rather than only once the cache TTL has run out. The
 * three cases below each take one route to revocation:
 *
 *   1. The store is revoked without the cache being told (a direct repository
 *      call, another process, an operator marking the row inactive). The Redis
 *      entry is still the positive blob when the next validate runs, and that
 *      validate must reject.
 *   2. Revocation through SessionComponent, whose cache key must be the same
 *      key every other reader and writer derives.
 *   3. A store revoke that fails. The failure must surface, and it must not be
 *      preceded by a cache eviction that lets the next validate re-read a
 *      still-live record.
 *
 * Infrastructure is real throughout: a real Postgres triple store and a real
 * Redis session store, no in-memory or SQLite substitute. Postgres isolation is
 * one rolled-back transaction per test; Redis is not transactional, so the keys
 * a test touches are deleted explicitly.
 */

import {
    AuthService,
    GoogleProvider,
    RedisSessionStore,
    SessionComponent,
    SessionStore,
    sessionCacheKey,
    UserDeviceRepository,
    UserIdentityRepository,
    UserRepository,
    UserSessionRepository,
} from "@terncosoftware/auth";
import { bindService } from "@terncosoftware/core";
import { type Knex, TripleStore } from "@terncosoftware/data";
import { FlowContext, type FlowPort } from "@terncosoftware/flow";
import { buildServerContext, type ServerContext, systemSec } from "@terncosoftware/server";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";
import { TEST_CIPHER } from "./testCipher.js";

// Same resolution as the other real-infrastructure suites: the env var wins,
// else the shared dev/CI default. Identical URLs everywhere means one Postgres
// and one Redis are shared by every suite.
const PG_URL = process.env.SYS_PG_URL ?? "postgresql://sys:sys@localhost:5432/sys";
const REDIS_URL = process.env.SYS_REDIS_URL ?? "redis://localhost:6379";

// Short enough that anything a crashed run leaves in the shared Redis ages out
// on its own, long enough that no test can pass by waiting for an expiry.
const CACHE_TTL_SECS = 300;

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

/**
 * Reads one message off a port, polling until it arrives.
 *
 * SessionComponent answers asynchronously, so the message lands some ticks
 * after step() returns. Polling for the condition keeps the suite off a fixed
 * sleep, which would be either flaky or slow.
 */
async function readPort<T>(port: FlowPort<T>, deadlineMs = 10_000): Promise<T> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
        const message = port.read();
        if (message !== undefined) {
            return message;
        }
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for a message on port "${port.name}"`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

describe("Session revocation (real Postgres + real Redis)", () => {
    // knex/redis are null until their setup hook succeeds, and teardown guards
    // on that, so a failed connection reports the real setup error instead of
    // cascading a TypeError out of afterEach/afterAll.
    let knex: Knex | null = null;
    let redis: Redis | null = null;
    let trx: Knex.Transaction | null = null;
    let store: TripleStore;
    let ctx: ServerContext;
    let sessionStore: RedisSessionStore;
    let auth: AuthService;
    let users: UserRepository;
    let devices: UserDeviceRepository;
    let sessions: UserSessionRepository;

    // Every cache key a test touches, deleted in afterEach: Redis is not part
    // of the Postgres transaction and does not roll back with it.
    let touchedKeys: string[] = [];

    beforeAll(async () => {
        knex = await pgContext();
        redis = new Redis(REDIS_URL);
    });

    afterAll(async () => {
        if (knex !== null) {
            await knex.destroy();
            knex = null;
        }
        if (redis !== null) {
            await redis.quit();
            redis = null;
        }
    });

    beforeEach(async () => {
        if (knex === null || redis === null) {
            throw new Error("Postgres or Redis was not connected in beforeAll");
        }
        trx = await knex.transaction();
        // Binding the store to the transaction makes even an internal
        // buildServerContext(store) with no explicit trx run inside a savepoint
        // of this transaction, so every write rolls back.
        store = new TripleStore(trx as unknown as Knex);
        ctx = buildServerContext(store, { trx });

        sessionStore = new RedisSessionStore(redis);
        users = new UserRepository(store, TEST_CIPHER);
        devices = new UserDeviceRepository(store);
        sessions = new UserSessionRepository(store);
        auth = new AuthService({
            providers: [new GoogleProvider("cid", "cs")],
            sessionStore,
            users,
            identities: new UserIdentityRepository(store, TEST_CIPHER),
            sessions,
            devices,
        });
        touchedKeys = [];
    });

    afterEach(async () => {
        if (redis !== null && touchedKeys.length > 0) {
            await redis.del(...touchedKeys);
        }
        touchedKeys = [];
        if (trx !== null && !trx.isCompleted()) {
            await trx.rollback();
        }
        trx = null;
        if (knex !== null) {
            await assertEmptyStore(knex);
        }
    });

    /**
     * Mints a real session and warms the fast-path cache exactly as a login
     * does: same key derivation, same blob shape, same store.
     */
    async function mintSession(email: string): Promise<{ token: string; userId: string }> {
        const user = await users.create(ctx, systemSec, { email, displayName: "Revocation" });
        const device = await devices.findOrCreate(ctx, systemSec, { userId: user.id, info: {} });
        const expiresAt = new Date(Date.now() + CACHE_TTL_SECS * 1000);
        const session = await sessions.create(ctx, systemSec, {
            userId: user.id,
            deviceId: device.id,
            expiresAt,
        });
        const key = sessionCacheKey(session.sessionToken);
        touchedKeys.push(key);
        await sessionStore.set(
            key,
            JSON.stringify({
                userId: user.id,
                deviceId: device.id,
                expiresAt: expiresAt.getTime(),
                sessionId: session.id,
            }),
            CACHE_TTL_SECS,
        );
        return { token: session.sessionToken, userId: user.id };
    }

    // ── 1. A revocation the cache was never told about ────────────────────────

    it("test a session revoked in the store stops validating while its cache entry is still warm", async () => {
        const { token, userId } = await mintSession("warm-cache@revocation.test");
        const key = sessionCacheKey(token);

        const before = await auth.validateToken(ctx, systemSec, { token });
        expect(before?.id).toBe(userId);

        // Revoke through the repository, so nothing clears the cache. This is
        // the revocation that bypasses AuthService: another process, a direct
        // repository call, an operator marking the row inactive.
        expect(await sessions.revoke(ctx, systemSec, { token })).toBe(true);

        // The positive blob is still what Redis holds, so the next validate
        // runs with the fast path warm rather than against an expired entry.
        const cached = await sessionStore.get(key);
        expect(cached).not.toBeNull();
        expect(JSON.parse(cached as string)).toMatchObject({ userId });

        expect(await auth.validateToken(ctx, systemSec, { token })).toBeNull();
    });

    it("test a session revoked through AuthService stops validating on the very next call", async () => {
        const { token, userId } = await mintSession("revoke-token@revocation.test");
        const key = sessionCacheKey(token);

        expect((await auth.validateToken(ctx, systemSec, { token }))?.id).toBe(userId);
        expect(await sessionStore.get(key)).not.toBeNull();

        await auth.revokeToken(ctx, systemSec, { token });

        expect(await auth.validateToken(ctx, systemSec, { token })).toBeNull();
    });

    it("test revokeAllSessions leaves none of a user's tokens validating", async () => {
        const laptop = await mintSession("all-sessions@revocation.test");
        const phone = await sessions.create(ctx, systemSec, {
            userId: laptop.userId,
            deviceId: (
                await devices.findOrCreate(ctx, systemSec, {
                    userId: laptop.userId,
                    info: { name: "phone" },
                })
            ).id,
            expiresAt: new Date(Date.now() + CACHE_TTL_SECS * 1000),
        });
        const phoneKey = sessionCacheKey(phone.sessionToken);
        touchedKeys.push(phoneKey);
        await sessionStore.set(
            phoneKey,
            JSON.stringify({
                userId: laptop.userId,
                deviceId: phone.deviceId,
                expiresAt: phone.expiresAt.getTime(),
                sessionId: phone.id,
            }),
            CACHE_TTL_SECS,
        );

        expect(await auth.revokeAllSessions(ctx, systemSec, { userId: laptop.userId })).toBe(2);

        // Checked before validating: a validate that rejects writes the
        // negative sentinel over the key, which would mask a missed eviction.
        expect(await sessionStore.get(sessionCacheKey(laptop.token))).toBeNull();
        expect(await sessionStore.get(phoneKey)).toBeNull();

        expect(await auth.validateToken(ctx, systemSec, { token: laptop.token })).toBeNull();
        expect(await auth.validateToken(ctx, systemSec, { token: phone.sessionToken })).toBeNull();
    });

    // ── 2. Revocation through SessionComponent ────────────────────────────────

    describe("SessionComponent", () => {
        let component: SessionComponent;

        beforeEach(() => {
            bindService(SessionStore, sessionStore);
            bindService(UserRepository, users);
            bindService(UserSessionRepository, sessions);
            component = new SessionComponent({
                name: "session-revocation",
                context: new FlowContext(),
            });
        });

        it("test a session revoked through SessionComponent stops validating", async () => {
            const { token } = await mintSession("component@revocation.test");
            const key = sessionCacheKey(token);

            component.validateIn.put({ token, requestId: "before" });
            component.step();
            const before = await readPort(component.validateOut);
            expect(before.valid).toBe(true);
            expect(before.requestId).toBe("before");

            component.revokeIn.put({ token, requestId: "revoke" });
            component.step();
            const revoked = await readPort(component.revokeOut);
            expect(revoked.success).toBe(true);

            // The component derives the same key as every other writer, so the
            // entry it evicts is the entry that exists.
            expect(await sessionStore.get(key)).toBeNull();

            component.validateIn.put({ token, requestId: "after" });
            component.step();
            const after = await readPort(component.validateOut);
            expect(after.valid).toBe(false);
            expect(after.requestId).toBe("after");
        });

        it("test a session revoked through SessionComponent stops validating through AuthService too", async () => {
            const { token, userId } = await mintSession("component-cross@revocation.test");

            expect((await auth.validateToken(ctx, systemSec, { token }))?.id).toBe(userId);

            component.revokeIn.put({ token, requestId: "cross" });
            component.step();
            expect((await readPort(component.revokeOut)).success).toBe(true);

            expect(await auth.validateToken(ctx, systemSec, { token })).toBeNull();
        });

        it("test SessionComponent validates a live session whose cache entry is warm", async () => {
            const { token } = await mintSession("component-warm@revocation.test");
            expect(await sessionStore.get(sessionCacheKey(token))).not.toBeNull();

            component.validateIn.put({ token, requestId: "warm" });
            component.step();
            const result = await readPort(component.validateOut);
            expect(result.valid).toBe(true);
            expect(result.session?.isActive).toBe(true);
        });
    });

    // ── 3. A store revoke that fails ──────────────────────────────────────────

    it("test a revoke whose store write fails surfaces the failure without evicting the cache first", async () => {
        if (knex === null) {
            throw new Error("Postgres was not connected in beforeAll");
        }
        const { token, userId } = await mintSession("store-failure@revocation.test");
        const key = sessionCacheKey(token);

        expect((await auth.validateToken(ctx, systemSec, { token }))?.id).toBe(userId);

        // A real Postgres failure, not a substitute: this transaction is already
        // rolled back, so every statement issued against it errors.
        const deadTrx = await knex.transaction();
        await deadTrx.rollback();
        const deadStore = new TripleStore(deadTrx as unknown as Knex);
        const deadCtx = buildServerContext(deadStore, { trx: deadTrx });
        const failing = new AuthService({
            providers: [new GoogleProvider("cid", "cs")],
            // The same real Redis the healthy service uses, so an eviction here
            // would be visible to it.
            sessionStore,
            users: new UserRepository(deadStore, TEST_CIPHER),
            identities: new UserIdentityRepository(deadStore, TEST_CIPHER),
            sessions: new UserSessionRepository(deadStore),
            devices: new UserDeviceRepository(deadStore),
        });

        await expect(failing.revokeToken(deadCtx, systemSec, { token })).rejects.toThrow();

        // The store is revoked before the cache, so a store write that failed
        // cannot have been preceded by an eviction. Nothing is half-revoked.
        expect(await sessionStore.get(key)).not.toBeNull();

        // And the revocation is still available to be completed: once the store
        // write lands, the very next validate rejects.
        await auth.revokeToken(ctx, systemSec, { token });
        expect(await auth.validateToken(ctx, systemSec, { token })).toBeNull();
    });

    it("test a revoke whose cache eviction fails still leaves the session rejected", async () => {
        const { token, userId } = await mintSession("cache-failure@revocation.test");

        expect((await auth.validateToken(ctx, systemSec, { token }))?.id).toBe(userId);

        // A real Redis connection that is closed: del() rejects for real.
        const closed = new Redis(REDIS_URL, { lazyConnect: true });
        await closed.connect();
        await closed.quit();
        const brokenCache = new RedisSessionStore(closed);
        const evictionFails = new AuthService({
            providers: [new GoogleProvider("cid", "cs")],
            sessionStore: brokenCache,
            users,
            identities: new UserIdentityRepository(store, TEST_CIPHER),
            sessions,
            devices,
        });

        // The store revoke lands first, so the revocation takes effect even
        // though the cache could not be cleared.
        await evictionFails.revokeToken(ctx, systemSec, { token });

        expect(await auth.validateToken(ctx, systemSec, { token })).toBeNull();
    });
});
