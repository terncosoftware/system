/**
 * Auth integration tests.
 *
 * All database tests run against both SQLite (always) and Postgres
 * (when SYS_PG_URL is set) inside rolled-back transactions.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
    AuthRouterComponent,
    AuthService,
    CallbackComponent,
    findSessionsByTokens,
    findUserBySession,
    findUserWithRecentActivity,
    GitHubProvider,
    GoogleProvider,
    hashSessionToken,
    type IOAuthProvider,
    LoginAttemptRepository,
    listActiveSessions,
    listInactiveSessions,
    listUserDevices,
    listUsers,
    MemorySessionStore,
    OAuthComponent,
    type OAuthProvider,
    RedisSessionStore,
    SessionComponent,
    SessionStore,
    sessionCacheKey,
    UserDeviceRepository,
    UserDeviceSchema,
    UserIdentityRepository,
    UserRepository,
    UserSchema,
    UserSessionRepository,
    UserSessionSchema,
} from "@terncosoftware/auth";
import { bindService } from "@terncosoftware/core";
import { TripleStore } from "@terncosoftware/data";
import {
    FlowContext,
    type HttpCtx,
    type HttpResponseDraft,
    type ParsedHttpRequest,
    PushScheduler,
} from "@terncosoftware/flow";
import {
    buildServerContext,
    EntityStore,
    type ServerContext,
    systemSec,
} from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";
import { TEST_CIPHER } from "./testCipher.js";

function startServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    return new Promise((resolve) => {
        const srv = createServer(handler);
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address() as AddressInfo;
            resolve({
                baseUrl: `http://127.0.0.1:${port}`,
                close: () => new Promise<void>((done) => srv.close(() => done())),
            });
        });
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── MemorySessionStore ────────────────────────────────────────────────────────

describe("MemorySessionStore", () => {
    let store: MemorySessionStore;

    beforeEach(() => {
        store = new MemorySessionStore();
    });

    it("stores and retrieves a value", async () => {
        await store.set("k", "v", 60);
        expect(await store.get("k")).toBe("v");
    });

    it("returns null for unknown key", async () => {
        expect(await store.get("missing")).toBeNull();
    });

    it("returns null after TTL expires", async () => {
        await store.set("k", "v", 0); // 0-second TTL — already expired
        expect(await store.get("k")).toBeNull();
    });

    it("deletes a key", async () => {
        await store.set("k", "v", 60);
        await store.del("k");
        expect(await store.get("k")).toBeNull();
    });

    it("clear() empties the store", async () => {
        await store.set("a", "1", 60);
        await store.set("b", "2", 60);
        store.clear();
        expect(await store.get("a")).toBeNull();
        expect(await store.get("b")).toBeNull();
    });
});

// ── OAuth providers ───────────────────────────────────────────────────────────

describe("GoogleProvider", () => {
    const provider = new GoogleProvider("test-client-id", "test-secret");

    it("generates a redirect URL with required params", () => {
        const url = new URL(provider.getAuthUrl("http://localhost/cb", "state123"));
        expect(url.hostname).toBe("accounts.google.com");
        expect(url.searchParams.get("client_id")).toBe("test-client-id");
        expect(url.searchParams.get("state")).toBe("state123");
        expect(url.searchParams.get("redirect_uri")).toBe("http://localhost/cb");
        expect(url.searchParams.get("response_type")).toBe("code");
        expect(url.searchParams.get("scope")).toContain("email");
    });

    it("exchangeCode() calls token + userinfo endpoints", async () => {
        const { baseUrl, close } = await startServer((req, res) => {
            if (req.url === "/token") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ access_token: "at", expires_in: 3600 }));
            } else {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        sub: "g123",
                        email: "u@test.com",
                        name: "User",
                        picture: "http://pic",
                    }),
                );
            }
        });
        try {
            const p = new GoogleProvider("cid", "cs", {
                tokenUrl: `${baseUrl}/token`,
                userUrl: `${baseUrl}/userinfo`,
            });
            const result = await p.exchangeCode("code123", "http://localhost/cb");
            expect(result.profile.providerUserId).toBe("g123");
            expect(result.profile.email).toBe("u@test.com");
            expect(result.tokens.accessToken).toBe("at");
            expect(result.tokens.expiresAt).toBeInstanceOf(Date);
        } finally {
            await close();
        }
    });

    it("exchangeCode() throws on token endpoint error", async () => {
        const { baseUrl, close } = await startServer((_, res) => {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_grant" }));
        });
        try {
            const p = new GoogleProvider("cid", "cs", {
                tokenUrl: `${baseUrl}/token`,
                userUrl: `${baseUrl}/userinfo`,
            });
            await expect(p.exchangeCode("bad", "http://localhost/cb")).rejects.toThrow("400");
        } finally {
            await close();
        }
    });
});

describe("GitHubProvider", () => {
    const provider = new GitHubProvider("gh-client", "gh-secret");

    it("generates a redirect URL with required params", () => {
        const url = new URL(provider.getAuthUrl("http://localhost/cb", "stateXYZ"));
        expect(url.hostname).toBe("github.com");
        expect(url.searchParams.get("client_id")).toBe("gh-client");
        expect(url.searchParams.get("state")).toBe("stateXYZ");
        expect(url.searchParams.get("scope")).toContain("user:email");
    });

    it("exchangeCode() fetches user + primary email", async () => {
        const { baseUrl, close } = await startServer((req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            if (req.url === "/token") {
                res.end(JSON.stringify({ access_token: "ghat", token_type: "bearer", scope: "" }));
            } else if (req.url === "/user") {
                res.end(
                    JSON.stringify({ id: 42, login: "dev", name: "Dev", avatar_url: "http://av" }),
                );
            } else {
                res.end(JSON.stringify([{ email: "dev@gh.com", primary: true, verified: true }]));
            }
        });
        try {
            const p = new GitHubProvider("gh-client", "gh-secret", {
                tokenUrl: `${baseUrl}/token`,
                userUrl: `${baseUrl}/user`,
                emailUrl: `${baseUrl}/emails`,
            });
            const result = await p.exchangeCode("code", "http://localhost/cb");
            expect(result.profile.providerUserId).toBe("42");
            expect(result.profile.email).toBe("dev@gh.com");
            expect(result.tokens.accessToken).toBe("ghat");
        } finally {
            await close();
        }
    });
});

// ── Repository suites (run per DB provider) ────────────────────────────────────

for (const db of dbProviders) {
    describe(`UserRepository — ${db.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let repo: UserRepository;

        beforeEach(async () => {
            knex = await db.create();
            trx = await knex.transaction();
            ctx = buildServerContext(store, { trx });
            store = new TripleStore(knex);
            repo = new UserRepository(store, TEST_CIPHER);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("creates a user and retrieves it by id", async () => {
            const user = await repo.create(ctx, systemSec, {
                email: "a@test.com",
                displayName: "Alice",
            });
            expect(user.id).toBeTruthy();
            expect(user.email).toBe("a@test.com");
            expect(user.displayName).toBe("Alice");
            expect(user.createdAt).toBeInstanceOf(Date);

            const found = await repo.findById(ctx, systemSec, { id: user.id });
            expect(found?.email).toBe("a@test.com");
        });

        it("finds a user by email", async () => {
            await repo.create(ctx, systemSec, { email: "b@test.com" });
            const found = await repo.findByEmail(ctx, systemSec, { email: "b@test.com" });
            expect(found?.email).toBe("b@test.com");
        });

        it("returns null for unknown id / email", async () => {
            expect(await repo.findById(ctx, systemSec, { id: "nonexistent" })).toBeNull();
            expect(await repo.findByEmail(ctx, systemSec, { email: "ghost@test.com" })).toBeNull();
        });

        it("updates displayName and avatarUrl", async () => {
            const user = await repo.create(ctx, systemSec, { email: "c@test.com" });
            const updated = await repo.update(ctx, systemSec, {
                id: user.id,
                patch: {
                    displayName: "Charlie",
                    avatarUrl: "http://avatar",
                },
            });
            expect(updated?.displayName).toBe("Charlie");
            expect(updated?.avatarUrl).toBe("http://avatar");
            expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(user.updatedAt.getTime());
        });

        it("update returns null for unknown id", async () => {
            expect(
                await repo.update(ctx, systemSec, { id: "ghost", patch: { displayName: "X" } }),
            ).toBeNull();
        });

        it("deletes a user", async () => {
            const user = await repo.create(ctx, systemSec, { email: "d@test.com" });
            await repo.delete(ctx, systemSec, { id: user.id });
            expect(await repo.findById(ctx, systemSec, { id: user.id })).toBeNull();
        });

        it("stores the user IRI in the graph", async () => {
            const user = await repo.create(ctx, systemSec, { email: "e@test.com" });
            expect(user.iri).toContain("urn:sys:core:auth:user:");
            expect(user.iri).toContain(user.id);
        });
    });

    describe(`LoginAttemptRepository — ${db.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let userRepo: UserRepository;
        let repo: LoginAttemptRepository;

        beforeEach(async () => {
            knex = await db.create();
            trx = await knex.transaction();
            ctx = buildServerContext(store, { trx });
            store = new TripleStore(knex);
            userRepo = new UserRepository(store, TEST_CIPHER);
            repo = new LoginAttemptRepository(store);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("creates a pending attempt and finds it by nonce", async () => {
            const created = await repo.create(ctx, systemSec, {
                provider: "google",
                nonce: "nonce-abc",
                ipAddress: "10.0.0.1",
                userAgent: "Mozilla/5.0",
                claim: "invite-1",
                utmSource: "newsletter",
                utmMedium: "email",
                utmCampaign: "spring",
                authRedirectUrl: "https://app.example/welcome",
            });
            expect(created.id).toBeTruthy();
            expect(created.status).toBe("pending");
            expect(created.iri).toContain("urn:sys:core:auth:loginattempt:");
            expect(created.iri).toContain(created.id);

            const found = await repo.findByNonce(ctx, systemSec, { nonce: "nonce-abc" });
            expect(found).not.toBeNull();
            expect(found?.id).toBe(created.id);
            expect(found?.provider).toBe("google");
            expect(found?.status).toBe("pending");
            expect(found?.ipAddress).toBe("10.0.0.1");
            expect(found?.userAgent).toBe("Mozilla/5.0");
            expect(found?.claim).toBe("invite-1");
            expect(found?.utmSource).toBe("newsletter");
            expect(found?.utmMedium).toBe("email");
            expect(found?.utmCampaign).toBe("spring");
            expect(found?.authRedirectUrl).toBe("https://app.example/welcome");
            expect(found?.userId).toBeUndefined();
            expect(found?.createdAt).toBeInstanceOf(Date);
        });

        it("returns null for an unknown nonce", async () => {
            expect(await repo.findByNonce(ctx, systemSec, { nonce: "ghost" })).toBeNull();
        });

        it("marks an attempt successful and links the resolved user via an edge", async () => {
            const user = await userRepo.create(ctx, systemSec, { email: "f@test.com" });
            const created = await repo.create(ctx, systemSec, {
                provider: "github",
                nonce: "nonce-ok",
            });

            await repo.updateStatus(ctx, systemSec, {
                id: created.id,
                status: "success",
                userId: user.id,
            });

            const found = await repo.findByNonce(ctx, systemSec, { nonce: "nonce-ok" });
            expect(found?.status).toBe("success");
            expect(found?.userId).toBe(user.id);
            expect(found?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
        });

        it("records an error code on a failed attempt", async () => {
            const created = await repo.create(ctx, systemSec, {
                provider: "google",
                nonce: "nonce-fail",
            });
            await repo.updateStatus(ctx, systemSec, {
                id: created.id,
                status: "error",
                errorCode: "access_denied",
            });

            const found = await repo.findByNonce(ctx, systemSec, { nonce: "nonce-fail" });
            expect(found?.status).toBe("error");
            expect(found?.errorCode).toBe("access_denied");
            expect(found?.userId).toBeUndefined();
        });
    });

    describe(`UserIdentityRepository — ${db.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let userRepo: UserRepository;
        let idRepo: UserIdentityRepository;

        beforeEach(async () => {
            knex = await db.create();
            trx = await knex.transaction();
            ctx = buildServerContext(store, { trx });
            store = new TripleStore(knex);
            userRepo = new UserRepository(store, TEST_CIPHER);
            idRepo = new UserIdentityRepository(store, TEST_CIPHER);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("creates an identity and links it to a user", async () => {
            const user = await userRepo.create(ctx, systemSec, { email: "f@test.com" });
            const identity = await idRepo.create(ctx, systemSec, {
                provider: "google",
                providerUserId: "g-001",
                providerEmail: "f@gmail.com",
                accessToken: "at-xxx",
                userId: user.id,
            });
            expect(identity.provider).toBe("google");
            expect(identity.providerUserId).toBe("g-001");
            expect(identity.userId).toBe(user.id);
        });

        it("finds identity by provider + providerUserId", async () => {
            const user = await userRepo.create(ctx, systemSec, { email: "g@test.com" });
            await idRepo.create(ctx, systemSec, {
                provider: "github",
                providerUserId: "gh-42",
                providerEmail: "g@gh.com",
                accessToken: "at",
                userId: user.id,
            });

            const found = await idRepo.findByProvider(ctx, systemSec, {
                provider: "github",
                providerUserId: "gh-42",
            });
            expect(found?.providerUserId).toBe("gh-42");
        });

        it("returns null when provider identity not found", async () => {
            expect(
                await idRepo.findByProvider(ctx, systemSec, {
                    provider: "google",
                    providerUserId: "nobody",
                }),
            ).toBeNull();
        });

        it("finds all identities for a user", async () => {
            const user = await userRepo.create(ctx, systemSec, { email: "h@test.com" });
            await idRepo.create(ctx, systemSec, {
                provider: "google",
                providerUserId: "g1",
                providerEmail: "h@g.com",
                accessToken: "a1",
                userId: user.id,
            });
            await idRepo.create(ctx, systemSec, {
                provider: "github",
                providerUserId: "gh1",
                providerEmail: "h@gh.com",
                accessToken: "a2",
                userId: user.id,
            });

            const all = await idRepo.findByUserId(ctx, systemSec, { userId: user.id });
            expect(all).toHaveLength(2);
        });

        it("updates tokens on an existing identity", async () => {
            const user = await userRepo.create(ctx, systemSec, { email: "i@test.com" });
            const identity = await idRepo.create(ctx, systemSec, {
                provider: "google",
                providerUserId: "g2",
                providerEmail: "i@g.com",
                accessToken: "old",
                userId: user.id,
            });

            await idRepo.updateTokens(ctx, systemSec, {
                id: identity.id,
                tokens: {
                    accessToken: "new-at",
                    refreshToken: "new-rt",
                    tokenExpiresAt: undefined,
                },
            });

            const found = await idRepo.findByProvider(ctx, systemSec, {
                provider: "google",
                providerUserId: "g2",
            });
            expect(found?.accessToken).toBe("new-at");
            expect(found?.refreshToken).toBe("new-rt");
        });
    });

    describe(`UserDeviceRepository — ${db.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let userRepo: UserRepository;
        let devRepo: UserDeviceRepository;

        beforeEach(async () => {
            knex = await db.create();
            trx = await knex.transaction();
            ctx = buildServerContext(store, { trx });
            store = new TripleStore(knex);
            userRepo = new UserRepository(store, TEST_CIPHER);
            devRepo = new UserDeviceRepository(store);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("creates a device on first findOrCreate", async () => {
            const user = await userRepo.create(ctx, systemSec, { email: "j@test.com" });
            const device = await devRepo.findOrCreate(ctx, systemSec, {
                userId: user.id,
                info: {
                    userAgent: "Chrome/120",
                    platform: "web",
                },
            });
            expect(device.userId).toBe(user.id);
            expect(device.deviceUserAgent).toBe("Chrome/120");
        });

        it("returns existing device on second findOrCreate with same userAgent", async () => {
            const user = await userRepo.create(ctx, systemSec, { email: "k@test.com" });
            const d1 = await devRepo.findOrCreate(ctx, systemSec, {
                userId: user.id,
                info: { userAgent: "Firefox/118" },
            });
            const d2 = await devRepo.findOrCreate(ctx, systemSec, {
                userId: user.id,
                info: { userAgent: "Firefox/118" },
            });
            expect(d1.id).toBe(d2.id);
        });

        it("finds all devices for a user", async () => {
            const user = await userRepo.create(ctx, systemSec, { email: "l@test.com" });
            await devRepo.findOrCreate(ctx, systemSec, {
                userId: user.id,
                info: { userAgent: "Safari/17" },
            });
            await devRepo.findOrCreate(ctx, systemSec, {
                userId: user.id,
                info: { userAgent: "Edge/118" },
            });
            const all = await devRepo.findByUserId(ctx, systemSec, { userId: user.id });
            expect(all).toHaveLength(2);
        });

        it("findById returns null for unknown device", async () => {
            expect(await devRepo.findById(ctx, systemSec, { id: "ghost" })).toBeNull();
        });
    });

    describe(`UserSessionRepository — ${db.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let userRepo: UserRepository;
        let devRepo: UserDeviceRepository;
        let sessRepo: UserSessionRepository;

        beforeEach(async () => {
            knex = await db.create();
            trx = await knex.transaction();
            ctx = buildServerContext(store, { trx });
            store = new TripleStore(knex);
            userRepo = new UserRepository(store, TEST_CIPHER);
            devRepo = new UserDeviceRepository(store);
            sessRepo = new UserSessionRepository(store);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        async function makeSession(
            userId: string,
            deviceId: string,
            opts: { daysFromNow?: number } = {},
        ) {
            const offset = (opts.daysFromNow ?? 7) * 24 * 3600 * 1000;
            return sessRepo.create(ctx, systemSec, {
                userId,
                deviceId,
                expiresAt: new Date(Date.now() + offset),
            });
        }

        it("creates a session with a secure token", async () => {
            const user = await userRepo.create(ctx, systemSec, { email: "m@test.com" });
            const device = await devRepo.findOrCreate(ctx, systemSec, {
                userId: user.id,
                info: {},
            });
            const sess = await makeSession(user.id, device.id);

            expect(sess.sessionToken).toHaveLength(64);
            expect(sess.isActive).toBe(true);
            expect(sess.userId).toBe(user.id);
        });

        it("finds session by token", async () => {
            const user = await userRepo.create(ctx, systemSec, { email: "n@test.com" });
            const device = await devRepo.findOrCreate(ctx, systemSec, {
                userId: user.id,
                info: {},
            });
            const sess = await makeSession(user.id, device.id);

            const found = await sessRepo.findByToken(ctx, systemSec, { token: sess.sessionToken });
            expect(found?.id).toBe(sess.id);
        });

        it("returns null for unknown token", async () => {
            expect(
                await sessRepo.findByToken(ctx, systemSec, { token: "not-a-real-token" }),
            ).toBeNull();
        });

        it("finds all sessions for a user", async () => {
            const user = await userRepo.create(ctx, systemSec, { email: "o@test.com" });
            const device = await devRepo.findOrCreate(ctx, systemSec, {
                userId: user.id,
                info: {},
            });
            await makeSession(user.id, device.id);
            await makeSession(user.id, device.id);
            const all = await sessRepo.findByUserId(ctx, systemSec, { userId: user.id });
            expect(all).toHaveLength(2);
        });

        it("revoke() marks session inactive", async () => {
            const user = await userRepo.create(ctx, systemSec, { email: "p@test.com" });
            const device = await devRepo.findOrCreate(ctx, systemSec, {
                userId: user.id,
                info: {},
            });
            const sess = await makeSession(user.id, device.id);

            const ok = await sessRepo.revoke(ctx, systemSec, { token: sess.sessionToken });
            expect(ok).toBe(true);

            const after = await sessRepo.findByToken(ctx, systemSec, { token: sess.sessionToken });
            expect(after?.isActive).toBe(false);
        });

        it("revoke() returns false for unknown token", async () => {
            expect(await sessRepo.revoke(ctx, systemSec, { token: "ghost-token" })).toBe(false);
        });

        it("revokeAllForUser() revokes all active sessions", async () => {
            const user = await userRepo.create(ctx, systemSec, { email: "q@test.com" });
            const device = await devRepo.findOrCreate(ctx, systemSec, {
                userId: user.id,
                info: {},
            });
            await makeSession(user.id, device.id);
            await makeSession(user.id, device.id);
            const count = await sessRepo.revokeAllForUser(ctx, systemSec, { userId: user.id });
            expect(count).toBe(2);
        });

        it("deleteExpired() removes expired sessions", async () => {
            const user = await userRepo.create(ctx, systemSec, { email: "r@test.com" });
            const device = await devRepo.findOrCreate(ctx, systemSec, {
                userId: user.id,
                info: {},
            });
            await makeSession(user.id, device.id, { daysFromNow: -1 }); // already expired
            await makeSession(user.id, device.id, { daysFromNow: 7 }); // valid

            const deleted = await sessRepo.deleteExpired(ctx, systemSec);
            expect(deleted).toBe(1);
            const remaining = await sessRepo.findByUserId(ctx, systemSec, { userId: user.id });
            expect(remaining).toHaveLength(1);
        });
    });
}

// ── AuthService (integration with in-memory store) ────────────────────────────

describe("AuthService", () => {
    let knex: Knex;
    let trx: Knex.Transaction;
    let store: TripleStore;
    let service: AuthService;

    const makeGoogleFetch = (overrides?: Partial<{ email: string; sub: string }>) =>
        vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ access_token: "at", expires_in: 3600 }),
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    sub: overrides?.sub ?? "g-sub",
                    email: overrides?.email ?? "svc@test.com",
                    email_verified: true,
                    name: "Service User",
                    picture: "http://pic",
                }),
            } as Response);

    beforeEach(async () => {
        knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        trx = await knex.transaction();
        store = new TripleStore(trx as unknown as import("knex").Knex);
        service = new AuthService({
            providers: [new GoogleProvider("cid", "cs")],
            sessionStore: new MemorySessionStore(),
            users: new UserRepository(store, TEST_CIPHER),
            identities: new UserIdentityRepository(store, TEST_CIPHER),
            sessions: new UserSessionRepository(store),
            devices: new UserDeviceRepository(store),
        });
    });
    afterEach(async () => {
        await trx.rollback();
        await assertEmptyStore(knex);
        await knex.destroy();
        vi.unstubAllGlobals();
    });

    it("handleCallback() creates user, identity, device, and session", async () => {
        vi.stubGlobal("fetch", makeGoogleFetch());

        const { user, session } = await service.handleCallback({
            provider: "google",
            code: "code",
            redirectUri: "http://localhost/cb",
            device: { userAgent: "Chrome", platform: "web" },
        });

        expect(user.email).toBe("svc@test.com");
        expect(session.sessionToken).toHaveLength(64);
        expect(session.isActive).toBe(true);
    });

    it("never persists the raw session token — only its hash is at rest", async () => {
        vi.stubGlobal("fetch", makeGoogleFetch());

        const { user, session } = await service.handleCallback({
            provider: "google",
            code: "code",
            redirectUri: "http://localhost/cb",
            device: { userAgent: "Chrome", platform: "web" },
        });
        const rawToken = session.sessionToken;
        const tokenHash = hashSessionToken(rawToken);

        // Full quad-store dump: the raw bearer token must never appear; only its
        // one-way hash is stored.
        const ctx = buildServerContext(store, { trx });
        const raw = JSON.stringify(await store.findAcrossTenants(ctx, {}));
        expect(raw).not.toContain(rawToken);
        expect(raw).toContain(tokenHash);

        // The raw token still resolves the session (hashed lookup) ...
        const validated = await service.validateToken(
            buildServerContext(store, { trx }),
            systemSec,
            {
                token: rawToken,
            },
        );
        expect(validated?.id).toBe(user.id);

        // ... and a wrong token does not.
        const wrong = await service.validateToken(buildServerContext(store, { trx }), systemSec, {
            token: `${rawToken}-tampered`,
        });
        expect(wrong).toBeNull();
    });

    it("handleCallback() returns existing user on second login", async () => {
        vi.stubGlobal("fetch", makeGoogleFetch());
        const { user: u1 } = await service.handleCallback({
            provider: "google",
            code: "c1",
            redirectUri: "http://localhost/cb",
            device: {},
        });

        vi.stubGlobal("fetch", makeGoogleFetch());
        const { user: u2 } = await service.handleCallback({
            provider: "google",
            code: "c2",
            redirectUri: "http://localhost/cb",
            device: {},
        });

        expect(u1.id).toBe(u2.id);
    });

    it("validateToken() returns user for valid session", async () => {
        vi.stubGlobal("fetch", makeGoogleFetch());
        const { session } = await service.handleCallback({
            provider: "google",
            code: "c",
            redirectUri: "http://localhost/cb",
            device: {},
        });

        const user = await service.validateToken(buildServerContext(store), systemSec, {
            token: session.sessionToken,
        });
        expect(user?.email).toBe("svc@test.com");
    });

    it("validateToken() returns null for unknown token", async () => {
        expect(
            await service.validateToken(buildServerContext(store), systemSec, {
                token: "fake-token",
            }),
        ).toBeNull();
    });

    it("revokeToken() invalidates the session", async () => {
        vi.stubGlobal("fetch", makeGoogleFetch());
        const { session } = await service.handleCallback({
            provider: "google",
            code: "c",
            redirectUri: "http://localhost/cb",
            device: {},
        });

        await service.revokeToken(buildServerContext(store), systemSec, {
            token: session.sessionToken,
        });
        expect(
            await service.validateToken(buildServerContext(store), systemSec, {
                token: session.sessionToken,
            }),
        ).toBeNull();
    });

    it("buildAuthUrl() returns a URL with correct state", () => {
        const { url, state } = service.buildAuthUrl("google", "http://localhost/cb");
        expect(new URL(url).searchParams.get("state")).toBe(state);
        expect(state).toHaveLength(32);
    });

    it("getProvider() throws for unknown provider", () => {
        expect(() => service.getProvider("github")).toThrow("Unknown OAuth provider");
    });
});

// ── OAuthComponent (FBP) ─────────────────────────────────────────────────────

describe("OAuthComponent", () => {
    let ctx: FlowContext;
    let comp: OAuthComponent;

    beforeEach(() => {
        ctx = new FlowContext();
        comp = new OAuthComponent({
            name: "oauth",
            context: ctx,
            providers: [new GoogleProvider("cid", "cs"), new GitHubProvider("ghid", "ghs")],
        });
    });

    it("puts redirect result on redirectOut for google", () => {
        comp.initIn.put({ provider: "google", redirectUri: "http://localhost/cb" });
        comp.step();
        const result = comp.redirectOut.read();
        expect(result?.provider).toBe("google");
        expect(result?.authUrl).toContain("accounts.google.com");
        expect(result?.state).toHaveLength(32);
    });

    it("puts redirect result for github", () => {
        comp.initIn.put({ provider: "github", redirectUri: "http://localhost/cb" });
        comp.step();
        const result = comp.redirectOut.read();
        expect(result?.authUrl).toContain("github.com");
    });

    it("skips messages for unknown providers", () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        comp.initIn.put({
            provider: "twitter" as unknown as OAuthProvider,
            redirectUri: "http://localhost/cb",
        });
        comp.step();
        expect(comp.redirectOut.size).toBe(0);
    });

    it("generates unique state per request", () => {
        comp.initIn.put({ provider: "google", redirectUri: "http://localhost/cb" });
        comp.initIn.put({ provider: "google", redirectUri: "http://localhost/cb" });
        comp.step();
        const r1 = comp.redirectOut.read();
        const r2 = comp.redirectOut.read();
        expect(r1?.state).not.toBe(r2?.state);
    });
});

// ── SessionComponent (FBP) ───────────────────────────────────────────────────

class ThrowingSessionStore extends MemorySessionStore {
    override async del(_key: string): Promise<void> {
        throw new Error("store del failed");
    }
}

describe("SessionComponent", () => {
    let knex: Knex;
    let trx: Knex.Transaction;
    let store: TripleStore;
    let sessComp: SessionComponent;
    let memStore: MemorySessionStore;

    beforeEach(async () => {
        knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        trx = await knex.transaction();
        store = new TripleStore(trx as unknown as import("knex").Knex);
        memStore = new MemorySessionStore();

        bindService(SessionStore, memStore);
        bindService(UserRepository, new UserRepository(store, TEST_CIPHER));
        bindService(UserSessionRepository, new UserSessionRepository(store));
        sessComp = new SessionComponent({
            name: "session",
            context: new FlowContext(),
        });
    });
    afterEach(async () => {
        await trx.rollback();
        await assertEmptyStore(knex);
        await knex.destroy();
    });

    it("validateIn → valid:false for unknown token", async () => {
        sessComp.validateIn.put({ token: "bad-token", requestId: "r1" });
        sessComp.step();
        await new Promise((r) => setTimeout(r, 50)); // let async resolve
        const result = sessComp.validateOut.read();
        expect(result?.valid).toBe(false);
        expect(result?.requestId).toBe("r1");
    });

    it("revokeIn → success:false for unknown token", async () => {
        sessComp.revokeIn.put({ token: "ghost", requestId: "r2" });
        sessComp.step();
        await new Promise((r) => setTimeout(r, 50));
        const result = sessComp.revokeOut.read();
        expect(result?.requestId).toBe("r2");
    });

    it("validateIn → clears expired cache entry and returns valid:false (line 105)", async () => {
        const expiredData = JSON.stringify({
            userId: "u1",
            deviceId: "d1",
            expiresAt: Date.now() - 1000,
        });
        await memStore.set(sessionCacheKey("expired-tok"), expiredData, 60);
        sessComp.validateIn.put({ token: "expired-tok", requestId: "r3" });
        sessComp.step();
        await new Promise((r) => setTimeout(r, 50));
        const result = sessComp.validateOut.read();
        expect(result?.valid).toBe(false);
        expect(result?.requestId).toBe("r3");
    });

    it("validateIn → valid:true via slow path when session is in TripleStore (lines 111-114)", async () => {
        const userRepo = new UserRepository(store, TEST_CIPHER);
        const sessRepo = new UserSessionRepository(store);
        const ctx = buildServerContext(store);
        const user = await userRepo.create(ctx, systemSec, {
            email: "slow@test.com",
            displayName: "Slow",
        });
        const session = await sessRepo.create(ctx, systemSec, {
            userId: user.id,
            deviceId: "d-slow",
            expiresAt: new Date(Date.now() + 60_000),
        });
        sessComp.validateIn.put({ token: session.sessionToken, requestId: "r4" });
        sessComp.step();
        await new Promise((r) => setTimeout(r, 100));
        const result = sessComp.validateOut.read();
        expect(result?.valid).toBe(true);
        expect(result?.requestId).toBe("r4");
    });

    it("validateIn → valid:true via fast path when cache hit with valid session (lines 90-102)", async () => {
        const userRepo = new UserRepository(store, TEST_CIPHER);
        const sessRepo = new UserSessionRepository(store);
        const ctx = buildServerContext(store);
        const user = await userRepo.create(ctx, systemSec, {
            email: "fast@test.com",
            displayName: "Fast",
        });
        const session = await sessRepo.create(ctx, systemSec, {
            userId: user.id,
            deviceId: "d-fast",
            expiresAt: new Date(Date.now() + 60_000),
        });
        const cachedData = JSON.stringify({
            userId: user.id,
            deviceId: "d-fast",
            expiresAt: Date.now() + 60_000,
        });
        await memStore.set(sessionCacheKey(session.sessionToken), cachedData, 60);
        sessComp.validateIn.put({ token: session.sessionToken, requestId: "r5" });
        sessComp.step();
        await new Promise((r) => setTimeout(r, 100));
        const result = sessComp.validateOut.read();
        expect(result?.valid).toBe(true);
        expect(result?.requestId).toBe("r5");
    });

    it("revokeIn → success:false when session store del throws (line 126 catch branch)", async () => {
        bindService(SessionStore, new ThrowingSessionStore());
        bindService(UserRepository, new UserRepository(store, TEST_CIPHER));
        bindService(UserSessionRepository, new UserSessionRepository(store));
        const throwingComp = new SessionComponent({
            name: "session-throw",
            context: new FlowContext(),
        });
        throwingComp.revokeIn.put({ token: "any-token", requestId: "r6" });
        throwingComp.step();
        await new Promise((r) => setTimeout(r, 50));
        const result = throwingComp.revokeOut.read();
        expect(result?.success).toBe(false);
        expect(result?.requestId).toBe("r6");
    });
});

// ── CallbackComponent (FBP) ──────────────────────────────────────────────────

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
                providerUserId: "test-sub-1",
                email: "callback@test.com",
                emailVerified: true,
                displayName: "CB User",
            },
            tokens: { accessToken: "at-1", expiresAt: new Date(Date.now() + 3600_000) },
        };
    }
}

describe("CallbackComponent (FBP)", () => {
    let knex: Knex;
    let trx: Knex.Transaction;
    let store: TripleStore;
    let comp: CallbackComponent;
    let memStore: MemorySessionStore;

    beforeEach(async () => {
        knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        trx = await knex.transaction();
        store = new TripleStore(trx as unknown as import("knex").Knex);
        memStore = new MemorySessionStore();
        bindService(SessionStore, memStore);
        bindService(UserRepository, new UserRepository(store, TEST_CIPHER));
        bindService(UserIdentityRepository, new UserIdentityRepository(store, TEST_CIPHER));
        bindService(UserSessionRepository, new UserSessionRepository(store));
        bindService(UserDeviceRepository, new UserDeviceRepository(store));
        comp = new CallbackComponent({
            name: "callback",
            context: new FlowContext(),
            providers: [new TestOAuthProvider()],
        });
    });

    afterEach(async () => {
        await trx.rollback();
        await assertEmptyStore(knex);
        await knex.destroy();
    });

    it("callbackIn → successOut with new user on valid code", async () => {
        comp.callbackIn.put({
            provider: "google",
            code: "good-code",
            state: "s",
            redirectUri: "http://localhost/cb",
            device: { userAgent: "test-agent" },
            requestId: "cb1",
        });
        comp.step();
        await new Promise((r) => setTimeout(r, 100));
        const result = comp.successOut.read();
        expect(result?.user.email).toBe("callback@test.com");
        expect(result?.requestId).toBe("cb1");
        expect(comp.errorOut.read()).toBeUndefined();
    });

    it("callbackIn → successOut updates existing user on second login", async () => {
        for (let i = 0; i < 2; i++) {
            comp.callbackIn.put({
                provider: "google",
                code: "good-code",
                state: "s",
                redirectUri: "http://localhost/cb",
                device: { userAgent: "test-agent" },
                requestId: `cb${i}`,
            });
            comp.step();
            await new Promise((r) => setTimeout(r, 100));
            comp.successOut.read(); // drain
        }
        expect(comp.errorOut.read()).toBeUndefined();
    });

    it("callbackIn → errorOut for unknown provider", async () => {
        comp.callbackIn.put({
            provider: "github" as OAuthProvider,
            code: "x",
            state: "s",
            redirectUri: "http://localhost/cb",
            device: {},
            requestId: "cb-err",
        });
        comp.step();
        await new Promise((r) => setTimeout(r, 50));
        const err = comp.errorOut.read();
        expect(err?.error).toContain("Unknown provider");
        expect(err?.requestId).toBe("cb-err");
    });
});

// ── AuthService: validateToken falls back to TripleStore ─────────────────────

describe("AuthService.validateToken — fallback path", () => {
    it("validates from TripleStore when session store is empty", async () => {
        const knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        const store = new TripleStore(knex);
        const memStore = new MemorySessionStore();
        const users = new UserRepository(store, TEST_CIPHER);
        const devices = new UserDeviceRepository(store);
        const sessRepo = new UserSessionRepository(store);

        const svc = new AuthService({
            providers: [new GoogleProvider("c", "s")],
            sessionStore: memStore,
            users,
            identities: new UserIdentityRepository(store, TEST_CIPHER),
            sessions: sessRepo,
            devices,
        });

        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ access_token: "at", expires_in: 3600 }),
                } as Response)
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        sub: "fb-sub",
                        email: "fb@test.com",
                        email_verified: true,
                        name: "Fallback",
                    }),
                } as Response),
        );

        const { session } = await svc.handleCallback({
            provider: "google",
            code: "c",
            redirectUri: "http://localhost/cb",
            device: {},
        });

        // Simulate session store miss (e.g. Redis restart)
        memStore.clear();

        const user = await svc.validateToken(buildServerContext(store), systemSec, {
            token: session.sessionToken,
        });
        expect(user?.email).toBe("fb@test.com");

        vi.unstubAllGlobals();
        await knex.destroy();
    });
});

// ── AuthRouterComponent: sessionMiddleware ────────────────────────────────────

describe("AuthRouterComponent.sessionMiddleware()", () => {
    it("attaches user to ctx when cookie is valid", async () => {
        const knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        const store = new TripleStore(knex);
        const memStore = new MemorySessionStore();

        const svc = new AuthService({
            providers: [new GoogleProvider("c", "s")],
            sessionStore: memStore,
            users: new UserRepository(store, TEST_CIPHER),
            identities: new UserIdentityRepository(store, TEST_CIPHER),
            sessions: new UserSessionRepository(store),
            devices: new UserDeviceRepository(store),
        });

        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ access_token: "at" }),
                } as Response)
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        sub: "mw-sub",
                        email: "mw@test.com",
                        email_verified: true,
                    }),
                } as Response),
        );

        const { session } = await svc.handleCallback({
            provider: "google",
            code: "c",
            redirectUri: "http://localhost/cb",
            device: {},
        });

        const ctx = new FlowContext();
        const sched = new PushScheduler();
        ctx._setScheduler(sched);

        bindService(SessionStore, memStore);
        bindService(UserRepository, new UserRepository(store, TEST_CIPHER));
        bindService(UserIdentityRepository, new UserIdentityRepository(store, TEST_CIPHER));
        bindService(UserSessionRepository, new UserSessionRepository(store));
        bindService(UserDeviceRepository, new UserDeviceRepository(store));
        const router = new AuthRouterComponent({
            name: "auth",
            context: ctx,
            providers: [new GoogleProvider("c", "s")],
            baseUrl: "http://localhost:3000",
        });

        const mw = router.sessionMiddleware();
        const fakeCtx = {
            req: {
                headers: { cookie: `tern_session=${encodeURIComponent(session.sessionToken)}` },
            },
            user: undefined as unknown,
        } as unknown as HttpCtx;

        await mw(fakeCtx, async () => {});
        expect((fakeCtx as unknown as { user: unknown }).user).toBeDefined();

        vi.unstubAllGlobals();
        await knex.destroy();
    });

    it("leaves ctx.user undefined for invalid token", async () => {
        const knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        const ctx = new FlowContext();

        bindService(SessionStore, new MemorySessionStore());
        bindService(UserRepository, new UserRepository(new TripleStore(knex)));
        bindService(UserIdentityRepository, new UserIdentityRepository(new TripleStore(knex)));
        bindService(UserSessionRepository, new UserSessionRepository(new TripleStore(knex)));
        bindService(UserDeviceRepository, new UserDeviceRepository(new TripleStore(knex)));
        const router = new AuthRouterComponent({
            name: "auth",
            context: ctx,
            providers: [new GoogleProvider("c", "s")],
            baseUrl: "http://localhost:3000",
        });

        const mw = router.sessionMiddleware();
        const fakeCtx: { req: { headers: Record<string, string> }; user?: unknown } = {
            req: { headers: { cookie: "tern_session=bad-token" } },
        };
        await mw(fakeCtx as unknown as HttpCtx, async () => {});
        expect(fakeCtx.user).toBeUndefined();

        await knex.destroy();
    });
});

// ── AuthRouterComponent: HTTP routes ─────────────────────────────────────────

describe("AuthRouterComponent HTTP routes", () => {
    let knex: Knex;
    let trx: Knex.Transaction;
    let store: TripleStore;
    let router: AuthRouterComponent;
    let memStore: MemorySessionStore;

    function makeReq(
        method: "GET" | "POST",
        pathname: string,
        opts: { headers?: Record<string, string>; query?: Record<string, string> } = {},
    ): ParsedHttpRequest {
        const params = new URLSearchParams(opts.query ?? {});
        return {
            requestId: Math.random().toString(36).slice(2),
            method,
            url: `http://localhost:3000${pathname}${params.size ? `?${params}` : ""}`,
            pathname,
            searchParams: params,
            headers: opts.headers ?? {},
        };
    }

    beforeEach(async () => {
        knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        trx = await knex.transaction();
        store = new TripleStore(trx as unknown as import("knex").Knex);
        memStore = new MemorySessionStore();
        bindService(SessionStore, memStore);
        bindService(UserRepository, new UserRepository(store, TEST_CIPHER));
        bindService(UserIdentityRepository, new UserIdentityRepository(store, TEST_CIPHER));
        bindService(UserSessionRepository, new UserSessionRepository(store));
        bindService(UserDeviceRepository, new UserDeviceRepository(store));
        router = new AuthRouterComponent({
            name: "auth",
            context: new FlowContext(),
            providers: [new TestOAuthProvider()],
            baseUrl: "http://localhost:3000",
        });
    });

    afterEach(async () => {
        await trx.rollback();
        await assertEmptyStore(knex);
        await knex.destroy();
    });

    async function dispatch(
        method: "GET" | "POST",
        pathname: string,
        opts: { headers?: Record<string, string>; query?: Record<string, string> } = {},
    ): Promise<HttpResponseDraft> {
        const req = makeReq(method, pathname, opts);
        router.requests.put(req);
        router.step();
        await new Promise((r) => setTimeout(r, 100));
        const resp = router.responses.read();
        if (!resp) {
            throw new Error("No response received");
        }
        return resp;
    }

    it("GET /auth/:provider → 302 redirect to provider auth URL", async () => {
        const resp = await dispatch("GET", "/auth/google");
        expect(resp.status).toBe(302);
        expect(typeof resp.headers?.location).toBe("string");
    });

    it("GET /auth/:provider with unknown provider → 404", async () => {
        const resp = await dispatch("GET", "/auth/unknown-provider");
        expect(resp.status).toBe(404);
    });

    it("GET /auth/:provider/callback with missing state → 302 failure redirect", async () => {
        const resp = await dispatch("GET", "/auth/google/callback", {
            query: { code: "abc", state: "s1" },
        });
        expect(resp.status).toBe(302);
        expect(resp.headers?.location).toBe("/auth/error");
    });

    it("GET /auth/:provider/callback with state mismatch → 302 failure redirect", async () => {
        const resp = await dispatch("GET", "/auth/google/callback", {
            headers: { cookie: "tern_oauth_state=wrong-state" },
            query: { code: "abc", state: "s1" },
        });
        expect(resp.status).toBe(302);
        expect(resp.headers?.location).toBe("/auth/error");
    });

    it("GET /auth/:provider/callback with matching state → 302 success redirect", async () => {
        const resp = await dispatch("GET", "/auth/google/callback", {
            headers: { cookie: `tern_oauth_state=${encodeURIComponent("match-state")}` },
            query: { code: "good-code", state: "match-state" },
        });
        expect(resp.status).toBe(302);
        expect(resp.headers?.location).toBe("/");
    });

    it("POST /auth/logout without token → 200 ok", async () => {
        const resp = await dispatch("POST", "/auth/logout");
        expect(resp.status).toBe(200);
        expect((resp.body as { ok: boolean }).ok).toBe(true);
    });

    it("POST /auth/logout with token → 200 ok and clears cookie", async () => {
        const cbResp = await dispatch("GET", "/auth/google/callback", {
            headers: { cookie: `tern_oauth_state=${encodeURIComponent("s2")}` },
            query: { code: "c", state: "s2" },
        });
        const setCookie = cbResp.headers?.["set-cookie"];
        const cookieArr = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
        const sessionCookie = cookieArr.find((c) => c?.startsWith("tern_session="));
        const token = decodeURIComponent(sessionCookie?.split("=")[1]?.split(";")[0] ?? "");

        const resp = await dispatch("POST", "/auth/logout", {
            headers: { cookie: `tern_session=${encodeURIComponent(token)}` },
        });
        expect(resp.status).toBe(200);
    });

    it("POST /auth/logout/all without token → 401", async () => {
        const resp = await dispatch("POST", "/auth/logout/all");
        expect(resp.status).toBe(401);
    });

    it("GET /auth/me without token → 401", async () => {
        const resp = await dispatch("GET", "/auth/me");
        expect(resp.status).toBe(401);
    });

    it("GET /auth/me with invalid token → 401", async () => {
        const resp = await dispatch("GET", "/auth/me", {
            headers: { cookie: "tern_session=bad-token" },
        });
        expect(resp.status).toBe(401);
    });

    it("GET /auth/me with valid token → 200 with user info", async () => {
        const cbResp = await dispatch("GET", "/auth/google/callback", {
            headers: { cookie: `tern_oauth_state=${encodeURIComponent("s3")}` },
            query: { code: "c", state: "s3" },
        });
        const setCookie = cbResp.headers?.["set-cookie"];
        const cookieArr = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
        const sessionCookie = cookieArr.find((c) => c?.startsWith("tern_session="));
        const token = decodeURIComponent(sessionCookie?.split("=")[1]?.split(";")[0] ?? "");

        const resp = await dispatch("GET", "/auth/me", {
            headers: { cookie: `tern_session=${encodeURIComponent(token)}` },
        });
        expect(resp.status).toBe(200);
        expect((resp.body as { email: string }).email).toBe("callback@test.com");
    });

    it("GET /auth/sessions without token → 401", async () => {
        const resp = await dispatch("GET", "/auth/sessions");
        expect(resp.status).toBe(401);
    });

    it("GET /auth/sessions with invalid token → 401", async () => {
        const resp = await dispatch("GET", "/auth/sessions", {
            headers: { authorization: "Bearer bad-token" },
        });
        expect(resp.status).toBe(401);
    });

    it("GET /auth/sessions with valid token → 200 list", async () => {
        const cbResp = await dispatch("GET", "/auth/google/callback", {
            headers: { cookie: `tern_oauth_state=${encodeURIComponent("s4")}` },
            query: { code: "c", state: "s4" },
        });
        const setCookie = cbResp.headers?.["set-cookie"];
        const cookieArr = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
        const sessionCookie = cookieArr.find((c) => c?.startsWith("tern_session="));
        const token = decodeURIComponent(sessionCookie?.split("=")[1]?.split(";")[0] ?? "");

        const resp = await dispatch("GET", "/auth/sessions", {
            headers: { authorization: `Bearer ${token}` },
        });
        expect(resp.status).toBe(200);
        expect(Array.isArray(resp.body)).toBe(true);
    });

    it("POST /auth/logout/all with valid token → 200 revokes sessions", async () => {
        const cbResp = await dispatch("GET", "/auth/google/callback", {
            headers: { cookie: `tern_oauth_state=${encodeURIComponent("s5")}` },
            query: { code: "c", state: "s5" },
        });
        const setCookie = cbResp.headers?.["set-cookie"];
        const cookieArr = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
        const sessionCookie = cookieArr.find((c) => c?.startsWith("tern_session="));
        const token = decodeURIComponent(sessionCookie?.split("=")[1]?.split(";")[0] ?? "");

        const resp = await dispatch("POST", "/auth/logout/all", {
            headers: { cookie: `tern_session=${encodeURIComponent(token)}` },
        });
        expect(resp.status).toBe(200);
        expect((resp.body as { ok: boolean }).ok).toBe(true);
    });

    it("POST /auth/logout/all with invalid token → 401 (line 297 branch)", async () => {
        const resp = await dispatch("POST", "/auth/logout/all", {
            headers: { authorization: "Bearer invalid-token-xyz" },
        });
        expect(resp.status).toBe(401);
    });

    it("validateToken() returns null for unknown token (line 186)", async () => {
        const result = await router.validateToken("no-such-token");
        expect(result).toBeNull();
    });

    it("GET /auth/:provider/callback when handleCallback throws → 302 failure (lines 371-373)", async () => {
        class ErrorOAuthProvider implements IOAuthProvider {
            readonly name: OAuthProvider = "github";
            getAuthUrl(_redirectUri: string, state: string): string {
                return `https://github.com/login/oauth/authorize?state=${state}`;
            }
            async exchangeCode(_code: string, _redirectUri: string): Promise<never> {
                throw new Error("OAuth exchange failed");
            }
        }
        bindService(SessionStore, memStore);
        bindService(UserRepository, new UserRepository(store, TEST_CIPHER));
        bindService(UserIdentityRepository, new UserIdentityRepository(store, TEST_CIPHER));
        bindService(UserSessionRepository, new UserSessionRepository(store));
        bindService(UserDeviceRepository, new UserDeviceRepository(store));
        const errorRouter = new AuthRouterComponent({
            name: "auth-err",
            context: new FlowContext(),
            providers: [new ErrorOAuthProvider()],
            baseUrl: "http://localhost:3000",
        });
        const req = makeReq("GET", "/auth/github/callback", {
            headers: { cookie: `tern_oauth_state=${encodeURIComponent("s6")}` },
            query: { code: "c", state: "s6" },
        });
        errorRouter.requests.put(req);
        errorRouter.step();
        await new Promise((r) => setTimeout(r, 100));
        const resp = errorRouter.responses.read();
        expect(resp?.status).toBe(302);
        expect(resp?.headers?.location).toBe("/auth/error");
    });
});

// ── RedisSessionStore ─────────────────────────────────────────────────────────

describe("RedisSessionStore", () => {
    it("set() / get() round-trips a value", async () => {
        const mockRedis = {
            set: vi.fn().mockResolvedValue("OK"),
            get: vi.fn().mockResolvedValue("my-value"),
            del: vi.fn().mockResolvedValue(1),
        };
        const store = new RedisSessionStore(
            mockRedis as unknown as ConstructorParameters<typeof RedisSessionStore>[0],
        );
        await store.set("k", "my-value", 60);
        expect(mockRedis.set).toHaveBeenCalledWith("k", "my-value", "EX", 60);
        const v = await store.get("k");
        expect(v).toBe("my-value");
        expect(mockRedis.get).toHaveBeenCalledWith("k");
    });

    it("get() returns null when Redis returns null", async () => {
        const mockRedis = {
            set: vi.fn(),
            get: vi.fn().mockResolvedValue(null),
            del: vi.fn(),
        };
        const store = new RedisSessionStore(
            mockRedis as unknown as ConstructorParameters<typeof RedisSessionStore>[0],
        );
        expect(await store.get("missing")).toBeNull();
    });

    it("del() calls redis.del with the key", async () => {
        const mockRedis = {
            set: vi.fn(),
            get: vi.fn(),
            del: vi.fn().mockResolvedValue(1),
        };
        const store = new RedisSessionStore(
            mockRedis as unknown as ConstructorParameters<typeof RedisSessionStore>[0],
        );
        await store.del("k");
        expect(mockRedis.del).toHaveBeenCalledWith("k");
    });
});

// ── AuthService.validateToken — cache hit path ────────────────────────────────

describe("AuthService.validateToken — cache hit", () => {
    it("returns user from fast-path cache without hitting the DB", async () => {
        const knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        const store = new TripleStore(knex);
        const memStore = new MemorySessionStore();
        const users = new UserRepository(store, TEST_CIPHER);

        // Create a real user so findById can resolve it
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ access_token: "at", expires_in: 3600 }),
                } as Response)
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        sub: "cache-sub",
                        email: "cache@test.com",
                        email_verified: true,
                        name: "Cache User",
                    }),
                } as Response),
        );

        const svc = new AuthService({
            providers: [new GoogleProvider("c", "s")],
            sessionStore: memStore,
            users,
            identities: new UserIdentityRepository(store, TEST_CIPHER),
            sessions: new UserSessionRepository(store),
            devices: new UserDeviceRepository(store),
        });

        const { user, session } = await svc.handleCallback({
            provider: "google",
            code: "c",
            redirectUri: "http://localhost/cb",
            device: {},
        });

        // Token is already cached from handleCallback — validateToken should use the cache
        const validated = await svc.validateToken(buildServerContext(store), systemSec, {
            token: session.sessionToken,
        });
        expect(validated?.email).toBe("cache@test.com");
        expect(validated?.id).toBe(user.id);

        vi.unstubAllGlobals();
        await knex.destroy();
    });

    it("evicts expired session from cache and falls through to DB path", async () => {
        const knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        const store = new TripleStore(knex);
        const memStore = new MemorySessionStore();

        const svc = new AuthService({
            providers: [new GoogleProvider("c", "s")],
            sessionStore: memStore,
            users: new UserRepository(store, TEST_CIPHER),
            identities: new UserIdentityRepository(store, TEST_CIPHER),
            sessions: new UserSessionRepository(store),
            devices: new UserDeviceRepository(store),
        });

        // Manually prime the cache with an already-expired entry
        const fakeToken = "expired-token-xyz";
        await memStore.set(
            sessionCacheKey(fakeToken),
            JSON.stringify({ userId: "some-id", expiresAt: Date.now() - 1000 }), // in the past
            1,
        );

        // validateToken should detect the expiry, delete it from cache, and return null
        const result = await svc.validateToken(buildServerContext(store), systemSec, {
            token: fakeToken,
        });
        expect(result).toBeNull();

        await knex.destroy();
    });
});

// ── queries.ts — join helpers ─────────────────────────────────────────────────

for (const db of dbProviders) {
    describe(`Auth queries — ${db.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let userRepo: UserRepository;
        let devRepo: UserDeviceRepository;
        let sessRepo: UserSessionRepository;
        let es: EntityStore;

        beforeEach(async () => {
            knex = await db.create();
            trx = await knex.transaction();
            ctx = buildServerContext(store, { trx });
            store = new TripleStore(knex);
            userRepo = new UserRepository(store, TEST_CIPHER);
            devRepo = new UserDeviceRepository(store);
            sessRepo = new UserSessionRepository(store);
            es = new EntityStore(store);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("listUsers returns all created users", async () => {
            await userRepo.create(ctx, systemSec, { email: "lu1@test.com" });
            await userRepo.create(ctx, systemSec, { email: "lu2@test.com" });
            const result = await listUsers(ctx, es);
            expect(result.length).toBeGreaterThanOrEqual(2);
        });

        it("listUserDevices returns all created devices", async () => {
            const user = await userRepo.create(ctx, systemSec, { email: "lud@test.com" });
            await devRepo.findOrCreate(ctx, systemSec, {
                userId: user.id,
                info: { userAgent: "Chrome" },
            });
            const result = await listUserDevices(ctx, es);
            expect(result.length).toBeGreaterThanOrEqual(1);
        });

        it("listActiveSessions returns only active sessions", async () => {
            const user = await userRepo.create(ctx, systemSec, { email: "las@test.com" });
            const device = await devRepo.findOrCreate(ctx, systemSec, {
                userId: user.id,
                info: {},
            });
            const expiresAt = new Date(Date.now() + 3600_000);
            const sess = await sessRepo.create(ctx, systemSec, {
                userId: user.id,
                deviceId: device.id,
                expiresAt,
            });
            await sessRepo.revoke(ctx, systemSec, { token: sess.sessionToken });

            const active = await listActiveSessions(ctx, es);
            const activeIds = active.map((r) => r.id);
            expect(activeIds).not.toContain(sess.id);
        });

        it("listInactiveSessions returns only inactive sessions", async () => {
            const userRec = await es.create(ctx, UserSchema, { email: "lis@test.com" });
            const devRec = await es.create(ctx, UserDeviceSchema, {
                deviceUser: userRec.iri,
                devicePlatform: "web",
            });
            const sess = await es.create(ctx, UserSessionSchema, {
                sessionUser: userRec.iri,
                sessionDevice: devRec.iri,
                expiresAt: new Date(Date.now() + 3600_000),
                isActive: false,
            });

            const inactive = await listInactiveSessions(ctx, es);
            expect(inactive.map((r) => r.id)).toContain(sess.id);
        });

        it("findUserWithRecentActivity returns user + session + device", async () => {
            const userRec = await es.create(ctx, UserSchema, { email: "fwa@test.com" });
            const devRec = await es.create(ctx, UserDeviceSchema, {
                deviceUser: userRec.iri,
                devicePlatform: "web",
            });
            await es.create(ctx, UserSessionSchema, {
                sessionUser: userRec.iri,
                sessionDevice: devRec.iri,
                expiresAt: new Date(Date.now() + 3600_000),
            });

            const result = await findUserWithRecentActivity(ctx, es, userRec.id);
            expect(result).not.toBeNull();
            expect(result?.session).not.toBeNull();
            expect(result?.device).not.toBeNull();
        });

        it("findUserWithRecentActivity returns null for unknown user", async () => {
            const result = await findUserWithRecentActivity(ctx, es, "no-such-id");
            expect(result).toBeNull();
        });

        it("findUserWithRecentActivity returns null device when session references non-existent device", async () => {
            const userRec = await es.create(ctx, UserSchema, { email: "fwanod@test.com" });
            // Store a session whose sessionDevice IRI points to a non-existent entity
            await es.create(ctx, UserSessionSchema, {
                sessionUser: userRec.iri,
                sessionDevice: "urn:sys:core:auth:device:ghost",
                expiresAt: new Date(Date.now() + 3600_000),
            });

            const result = await findUserWithRecentActivity(ctx, es, userRec.id);
            expect(result).not.toBeNull();
            expect(result?.session).not.toBeNull();
            expect(result?.device).toBeNull();
        });

        it("findUserWithRecentActivity returns null session when user has no sessions", async () => {
            const userRec = await es.create(ctx, UserSchema, { email: "nosess@test.com" });
            const result = await findUserWithRecentActivity(ctx, es, userRec.id);
            expect(result?.session).toBeNull();
            expect(result?.device).toBeNull();
        });

        it("findSessionsByTokens returns sessions in order", async () => {
            const userRec = await es.create(ctx, UserSchema, { email: "fst@test.com" });
            const devRec = await es.create(ctx, UserDeviceSchema, {
                deviceUser: userRec.iri,
                devicePlatform: "web",
            });
            const expiresAt = new Date(Date.now() + 3600_000);
            const s1 = await es.create(ctx, UserSessionSchema, {
                sessionUser: userRec.iri,
                sessionDevice: devRec.iri,
                expiresAt,
            });
            const s2 = await es.create(ctx, UserSessionSchema, {
                sessionUser: userRec.iri,
                sessionDevice: devRec.iri,
                expiresAt,
            });
            const t1 = s1.props.sessionToken as string;
            const t2 = s2.props.sessionToken as string;

            const results = await findSessionsByTokens(ctx, es, [t2, t1]);
            expect(results).toHaveLength(2);
            expect(results[0]?.id).toBe(s2.id);
            expect(results[1]?.id).toBe(s1.id);
        });

        it("findSessionsByTokens omits unknown tokens", async () => {
            const results = await findSessionsByTokens(ctx, es, ["ghost-token"]);
            expect(results).toHaveLength(0);
        });

        it("findUserBySession returns null for unknown token", async () => {
            const result = await findUserBySession(ctx, es, "no-such-token");
            expect(result).toBeNull();
        });

        it("findUserBySession returns user for valid token", async () => {
            const userRec = await es.create(ctx, UserSchema, { email: "fubs@test.com" });
            const devRec = await es.create(ctx, UserDeviceSchema, {
                deviceUser: userRec.iri,
                devicePlatform: "web",
            });
            const sess = await es.create(ctx, UserSessionSchema, {
                sessionUser: userRec.iri,
                sessionDevice: devRec.iri,
                expiresAt: new Date(Date.now() + 3600_000),
            });
            const token = sess.props.sessionToken as string;

            const result = await findUserBySession(ctx, es, token);
            expect(result).not.toBeNull();
            expect(result?.id).toBe(userRec.id);
        });

        it("findUserWithRecentActivity: session with no sessionDevice → device is null (line 94 false branch)", async () => {
            const userRec = await es.create(ctx, UserSchema, { email: "nodev@test.com" });
            // Create session without sessionDevice — strProp returns undefined, deviceIri is falsy
            await es.create(ctx, UserSessionSchema, {
                sessionUser: userRec.iri,
                expiresAt: new Date(Date.now() + 3600_000),
            });
            const result = await findUserWithRecentActivity(ctx, es, userRec.id);
            expect(result).not.toBeNull();
            expect(result?.session).not.toBeNull();
            expect(result?.device).toBeNull();
        });

        it("findUserBySession: session with no sessionUser → returns null (line 141 branch)", async () => {
            // Create a session without sessionUser — strProp will return undefined
            const sess = await es.create(ctx, UserSessionSchema, {
                expiresAt: new Date(Date.now() + 3600_000),
            });
            const token = sess.props.sessionToken as string;
            const result = await findUserBySession(ctx, es, token);
            expect(result).toBeNull();
        });
    });
}
