/**
 * TRN-171 — auth audit trail, throttle, and negative-cache.
 *
 * All tests use real infrastructure: real TripleStore (SQLite always, Postgres
 * when SYS_PG_URL is set) in rolled-back transactions, a real MemorySessionStore
 * (same ISessionStore contract as RedisSessionStore), real repositories, and a
 * real OAuth provider implementation. No mocks/stubs/spies.
 *
 * Observability seams (instead of spies):
 *   - Audit: assert LoginAttempt rows via LoginAttemptRepository.findByNonce.
 *   - Throttle: drive N requests through the real router and assert HTTP 429.
 *   - Negative cache: read the sentinel directly from the session store, and
 *     prove a TripleStore-backed lookup is NOT repeated by using a store whose
 *     findByToken throws on a second call — the neg-cache short-circuits it.
 */

import {
    AuthRouterComponent,
    AuthService,
    AuthThrottle,
    type IOAuthProvider,
    LoginAttemptRepository,
    MemorySessionStore,
    type OAuthProvider,
    SessionStore,
    sessionCacheKey,
    UserDeviceRepository,
    UserIdentityRepository,
    UserRepository,
    UserSessionRepository,
} from "@terncosoftware/auth";
import { bindService } from "@terncosoftware/core";
import { TripleStore } from "@terncosoftware/data";
import { FlowContext, type HttpResponseDraft, type ParsedHttpRequest } from "@terncosoftware/flow";
import { buildServerContext, type ServerContext, systemSec } from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";
import { TEST_CIPHER } from "./testCipher.js";

const NEG_CACHE_SENTINEL = "__neg__";

// ── Real OAuth provider (no mock) ──────────────────────────────────────────────

class TestOAuthProvider implements IOAuthProvider {
    readonly name: OAuthProvider = "google";
    getAuthUrl(_redirectUri: string, state: string): string {
        return `https://accounts.google.com/o/oauth2/auth?state=${state}`;
    }
    async exchangeCode(
        _code: string,
        _redirectUri: string,
    ): Promise<{
        profile: {
            providerUserId: string;
            email: string;
            emailVerified: boolean;
            displayName?: string;
            avatarUrl?: string;
        };
        tokens: { accessToken: string; refreshToken?: string; expiresAt?: Date };
    }> {
        return {
            profile: {
                providerUserId: "trn171-sub",
                email: "trn171@test.com",
                emailVerified: true,
                displayName: "TRN171 User",
            },
            tokens: { accessToken: "at-171", expiresAt: new Date(Date.now() + 3600_000) },
        };
    }
}

// ── DB providers ───────────────────────────────────────────────────────────────

interface DbProvider {
    name: string;
    create: () => Promise<Knex>;
}

const dbProviders: DbProvider[] = [
    {
        name: "SQLite (in-memory)",
        create: () => createTestDataContext({ client: "sqlite", filename: ":memory:" }),
    },
];

if (process.env.SYS_PG_URL) {
    const url = new URL(process.env.SYS_PG_URL);
    dbProviders.push({
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

// ── AuthThrottle (store-backed, real MemorySessionStore) ───────────────────────

describe("AuthThrottle", () => {
    let store: MemorySessionStore;

    beforeEach(() => {
        store = new MemorySessionStore();
    });

    it("allows hits up to the per-IP max then denies", async () => {
        const throttle = new AuthThrottle(store, { maxPerIp: 3, windowSecs: 60 });
        const results: boolean[] = [];
        for (let i = 0; i < 5; i++) {
            const { allowed } = await throttle.check({ ip: "1.2.3.4" });
            results.push(allowed);
        }
        expect(results).toEqual([true, true, true, false, false]);
    });

    it("enforces the per-identity max independently of the IP", async () => {
        const throttle = new AuthThrottle(store, {
            maxPerIp: 100,
            maxPerIdentity: 2,
            windowSecs: 60,
        });
        const results: boolean[] = [];
        for (let i = 0; i < 4; i++) {
            // Each request from a different IP, but the same identity.
            const { allowed } = await throttle.check({
                ip: `10.0.0.${i}`,
                identity: "google:fixed-state",
            });
            results.push(allowed);
        }
        expect(results).toEqual([true, true, false, false]);
    });

    it("resets after the window elapses", async () => {
        // 0-second window means each hit starts a fresh window → always allowed.
        const throttle = new AuthThrottle(store, { maxPerIp: 1, windowSecs: 0 });
        expect((await throttle.check({ ip: "9.9.9.9" })).allowed).toBe(true);
        expect((await throttle.check({ ip: "9.9.9.9" })).allowed).toBe(true);
    });

    it("fails open when the backing store throws", async () => {
        class ThrowingStore extends MemorySessionStore {
            override async get(): Promise<string | null> {
                throw new Error("store down");
            }
        }
        const throttle = new AuthThrottle(new ThrowingStore(), { maxPerIp: 1, windowSecs: 60 });
        // Both calls allowed despite being over the limit — fail-open.
        expect((await throttle.check({ ip: "5.5.5.5" })).allowed).toBe(true);
        expect((await throttle.check({ ip: "5.5.5.5" })).allowed).toBe(true);
    });
});

// ── AuthService audit + negative cache (per DB provider) ───────────────────────

for (const db of dbProviders) {
    describe(`AuthService audit + neg-cache — ${db.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let store: TripleStore;
        let memStore: MemorySessionStore;
        let attempts: LoginAttemptRepository;
        let service: AuthService;

        beforeEach(async () => {
            knex = await db.create();
            trx = await knex.transaction();
            store = new TripleStore(trx as unknown as Knex);
            memStore = new MemorySessionStore();
            attempts = new LoginAttemptRepository(store);
            service = new AuthService({
                providers: [new TestOAuthProvider()],
                sessionStore: memStore,
                users: new UserRepository(store, TEST_CIPHER),
                identities: new UserIdentityRepository(store, TEST_CIPHER),
                sessions: new UserSessionRepository(store),
                devices: new UserDeviceRepository(store),
                attempts,
            });
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("writes a success LoginAttempt row on handleCallback", async () => {
            const { user } = await service.handleCallback({
                provider: "google",
                code: "good",
                redirectUri: "http://localhost/cb",
                device: { userAgent: "Chrome", platform: "web" },
                ipAddress: "203.0.113.7",
                nonce: "state-success",
            });

            const ctx = buildServerContext(store, { trx });
            const row = await attempts.findByNonce(ctx, systemSec, { nonce: "state-success" });
            expect(row).not.toBeNull();
            expect(row?.status).toBe("success");
            expect(row?.provider).toBe("google");
            expect(row?.ipAddress).toBe("203.0.113.7");
            expect(row?.userAgent).toBe("Chrome");
            expect(row?.userId).toBe(user.id);
        });

        it("writes an error LoginAttempt row when handleCallback throws", async () => {
            class FailingProvider implements IOAuthProvider {
                readonly name: OAuthProvider = "google";
                getAuthUrl(_r: string, s: string): string {
                    return `https://accounts.google.com/o/oauth2/auth?state=${s}`;
                }
                async exchangeCode(): Promise<never> {
                    throw new Error("exchange_failed");
                }
            }
            const failing = new AuthService({
                providers: [new FailingProvider()],
                sessionStore: memStore,
                users: new UserRepository(store, TEST_CIPHER),
                identities: new UserIdentityRepository(store, TEST_CIPHER),
                sessions: new UserSessionRepository(store),
                devices: new UserDeviceRepository(store),
                attempts,
            });

            await expect(
                failing.handleCallback({
                    provider: "google",
                    code: "bad",
                    redirectUri: "http://localhost/cb",
                    device: { userAgent: "Curl" },
                    nonce: "state-error",
                }),
            ).rejects.toThrow("exchange_failed");

            const ctx = buildServerContext(store, { trx });
            const row = await attempts.findByNonce(ctx, systemSec, { nonce: "state-error" });
            expect(row).not.toBeNull();
            expect(row?.status).toBe("error");
            expect(row?.errorCode).toBe("exchange_failed");
            expect(row?.userId).toBeUndefined();
        });

        it("negative-caches an invalid token (sentinel in the session store)", async () => {
            const ctx = buildServerContext(store, { trx });
            const result = await service.validateToken(ctx, systemSec, { token: "garbage-token" });
            expect(result).toBeNull();

            // SEAM: the negative-cache entry now exists in the session store.
            const key = sessionCacheKey("garbage-token");
            expect(await memStore.get(key)).toBe(NEG_CACHE_SENTINEL);
        });
    });
}

// ── Negative cache short-circuits the TripleStore lookup ───────────────────────

describe("AuthService.validateToken — neg-cache avoids the triple store", () => {
    it("does not re-hit the session repository on the second invalid lookup", async () => {
        const knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        const store = new TripleStore(knex);
        const memStore = new MemorySessionStore();

        // SEAM: a real UserSessionRepository subclass that counts findByToken
        // calls and throws on the second. If the negative cache works, the second
        // validateToken never reaches the repository, so it never throws.
        let findCalls = 0;
        class CountingSessionRepository extends UserSessionRepository {
            override async findByToken(
                ctx: ServerContext,
                sec: typeof systemSec,
                args: { token: string },
            ): ReturnType<UserSessionRepository["findByToken"]> {
                findCalls += 1;
                if (findCalls > 1) {
                    throw new Error("session repository hit twice — neg-cache failed");
                }
                return super.findByToken(ctx, sec, args);
            }
        }

        const svc = new AuthService({
            providers: [new TestOAuthProvider()],
            sessionStore: memStore,
            users: new UserRepository(store, TEST_CIPHER),
            identities: new UserIdentityRepository(store, TEST_CIPHER),
            sessions: new CountingSessionRepository(store),
            devices: new UserDeviceRepository(store),
        });

        const ctx = buildServerContext(store);
        const first = await svc.validateToken(ctx, systemSec, { token: "repeat-garbage" });
        const second = await svc.validateToken(ctx, systemSec, { token: "repeat-garbage" });

        expect(first).toBeNull();
        expect(second).toBeNull();
        expect(findCalls).toBe(1);

        await knex.destroy();
    });
});

// ── AuthRouterComponent throttle + trusted-proxy + state-mismatch audit ────────

describe("AuthRouterComponent — throttle / trusted-proxy / audit", () => {
    let knex: Knex;
    let trx: Knex.Transaction;
    let store: TripleStore;
    let memStore: MemorySessionStore;
    let attempts: LoginAttemptRepository;

    function makeReq(
        method: "GET" | "POST",
        pathname: string,
        opts: {
            headers?: Record<string, string>;
            query?: Record<string, string>;
            remoteAddress?: string;
        } = {},
    ): ParsedHttpRequest {
        const params = new URLSearchParams(opts.query ?? {});
        return {
            requestId: Math.random().toString(36).slice(2),
            method,
            url: `http://localhost:3000${pathname}${params.size ? `?${params}` : ""}`,
            pathname,
            searchParams: params,
            headers: opts.headers ?? {},
            remoteAddress: opts.remoteAddress,
        };
    }

    function makeRouter(trustedProxies?: string[]): AuthRouterComponent {
        bindService(SessionStore, memStore);
        bindService(UserRepository, new UserRepository(store, TEST_CIPHER));
        bindService(UserIdentityRepository, new UserIdentityRepository(store, TEST_CIPHER));
        bindService(UserSessionRepository, new UserSessionRepository(store));
        bindService(UserDeviceRepository, new UserDeviceRepository(store));
        bindService(LoginAttemptRepository, attempts);
        return new AuthRouterComponent({
            name: "auth",
            context: new FlowContext(),
            providers: [new TestOAuthProvider()],
            baseUrl: "http://localhost:3000",
            trustedProxies,
        });
    }

    async function dispatch(
        router: AuthRouterComponent,
        method: "GET" | "POST",
        pathname: string,
        opts: {
            headers?: Record<string, string>;
            query?: Record<string, string>;
            remoteAddress?: string;
        } = {},
    ): Promise<HttpResponseDraft> {
        router.requests.put(makeReq(method, pathname, opts));
        router.step();
        await new Promise((r) => setTimeout(r, 100));
        const resp = router.responses.read();
        if (!resp) {
            throw new Error("No response received");
        }
        return resp;
    }

    beforeEach(async () => {
        knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        trx = await knex.transaction();
        store = new TripleStore(trx as unknown as Knex);
        memStore = new MemorySessionStore();
        attempts = new LoginAttemptRepository(store);
    });
    afterEach(async () => {
        await trx.rollback();
        await assertEmptyStore(knex);
        await knex.destroy();
    });

    it("returns 429 once the per-IP throttle is exceeded on the begin route", async () => {
        // Default per-IP limit is 20; drive 21 begin requests from one IP.
        const router = makeRouter();
        let last: HttpResponseDraft | null = null;
        for (let i = 0; i < 21; i++) {
            last = await dispatch(router, "GET", "/auth/google", {
                remoteAddress: "198.51.100.1",
            });
        }
        expect(last?.status).toBe(429);
        expect(last?.headers?.["retry-after"]).toBeDefined();
    });

    it("does not throttle distinct IPs", async () => {
        const router = makeRouter();
        let last: HttpResponseDraft | null = null;
        for (let i = 0; i < 21; i++) {
            last = await dispatch(router, "GET", "/auth/google", {
                remoteAddress: `192.0.2.${i}`,
            });
        }
        expect(last?.status).toBe(302);
    });

    it("ignores spoofed x-forwarded-for from an untrusted peer (per-IP throttle binds to socket)", async () => {
        // No trusted proxies configured. A single socket peer rotates XFF on
        // every request trying to dodge the per-IP limit; it must still 429.
        const router = makeRouter();
        let last: HttpResponseDraft | null = null;
        for (let i = 0; i < 21; i++) {
            last = await dispatch(router, "GET", "/auth/google", {
                remoteAddress: "203.0.113.99",
                headers: { "x-forwarded-for": `172.16.0.${i}` },
            });
        }
        expect(last?.status).toBe(429);
    });

    it("honors x-forwarded-for from a trusted proxy (distinct client IPs are not throttled)", async () => {
        // Peer 10.0.0.1 is a trusted proxy; the real client IP comes from XFF and
        // varies per request, so none should be throttled.
        const router = makeRouter(["10.0.0.1"]);
        let last: HttpResponseDraft | null = null;
        for (let i = 0; i < 21; i++) {
            last = await dispatch(router, "GET", "/auth/google", {
                remoteAddress: "10.0.0.1",
                headers: { "x-forwarded-for": `198.18.0.${i}` },
            });
        }
        expect(last?.status).toBe(302);
    });

    it("records a state-mismatch login attempt and redirects to failure", async () => {
        const router = makeRouter();
        const resp = await dispatch(router, "GET", "/auth/google/callback", {
            headers: { cookie: "tern_oauth_state=server-state" },
            query: { code: "abc", state: "attacker-state" },
            remoteAddress: "198.51.100.50",
        });
        expect(resp.status).toBe(302);
        expect(resp.headers?.location).toBe("/auth/error");

        const ctx = buildServerContext(store, { trx });
        const row = await attempts.findByNonce(ctx, systemSec, { nonce: "attacker-state" });
        expect(row).not.toBeNull();
        expect(row?.status).toBe("error");
        expect(row?.errorCode).toBe("state_mismatch");
        expect(row?.ipAddress).toBe("198.51.100.50");
    });

    it("records a success login attempt on a matching-state callback", async () => {
        const router = makeRouter();
        const resp = await dispatch(router, "GET", "/auth/google/callback", {
            headers: { cookie: `tern_oauth_state=${encodeURIComponent("ok-state")}` },
            query: { code: "good", state: "ok-state" },
            remoteAddress: "198.51.100.60",
        });
        expect(resp.status).toBe(302);
        expect(resp.headers?.location).toBe("/");

        const ctx = buildServerContext(store, { trx });
        const row = await attempts.findByNonce(ctx, systemSec, { nonce: "ok-state" });
        expect(row).not.toBeNull();
        expect(row?.status).toBe("success");
        expect(row?.ipAddress).toBe("198.51.100.60");
    });
});
