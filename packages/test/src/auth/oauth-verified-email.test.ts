/**
 * OAuth sign-in only ever trusts an address the provider has verified (GH #1214).
 *
 * Sign-in finds the user by email, so an address the provider does not vouch
 * for would let anyone who types someone else's address into a provider
 * account land in that person's user, or claim the address before its owner
 * does. Both providers run against real local HTTP servers standing in for the
 * provider endpoints, and the store is real (SQLite always, Postgres when
 * SYS_PG_URL is set), inside a rolled-back transaction.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
    AuthService,
    CallbackComponent,
    GitHubProvider,
    GoogleProvider,
    type IOAuthProvider,
    MemorySessionStore,
    OAUTH_EMAIL_NOT_VERIFIED,
    OAuthEmailNotVerifiedError,
    SessionStore,
    UserDeviceRepository,
    UserIdentityRepository,
    UserRepository,
    UserSessionRepository,
} from "@terncosoftware/auth";
import { bindService } from "@terncosoftware/core";
import { TripleStore } from "@terncosoftware/data";
import { FlowContext } from "@terncosoftware/flow";
import { buildServerContext, type ServerContext, systemSec } from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";
import { TEST_CIPHER } from "./testCipher.js";

const VICTIM = "owner@example.com";

interface FakeProviderServer {
    baseUrl: string;
    close: () => Promise<void>;
}

function startServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<FakeProviderServer> {
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

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
}

/** What the fake provider answers from its userinfo (Google) or emails (GitHub) endpoint. */
let googleUserinfo: Record<string, unknown> = {};
let githubEmails: { status: number; body: unknown } = { status: 200, body: [] };
let githubUser: Record<string, unknown> = {};

let google: FakeProviderServer;
let github: FakeProviderServer;

beforeAll(async () => {
    google = await startServer((req, res) => {
        if (req.url === "/token") {
            json(res, 200, { access_token: "g-at", expires_in: 3600, token_type: "Bearer" });
            return;
        }
        json(res, 200, googleUserinfo);
    });
    github = await startServer((req, res) => {
        if (req.url === "/token") {
            json(res, 200, { access_token: "gh-at", token_type: "bearer", scope: "" });
            return;
        }
        if (req.url === "/user") {
            json(res, 200, githubUser);
            return;
        }
        json(res, githubEmails.status, githubEmails.body);
    });
});

afterAll(async () => {
    await google.close();
    await github.close();
});

function googleProvider(): GoogleProvider {
    return new GoogleProvider("cid", "cs", {
        tokenUrl: `${google.baseUrl}/token`,
        userUrl: `${google.baseUrl}/userinfo`,
    });
}

function githubProvider(): GitHubProvider {
    return new GitHubProvider("cid", "cs", {
        tokenUrl: `${github.baseUrl}/token`,
        userUrl: `${github.baseUrl}/user`,
        emailUrl: `${github.baseUrl}/emails`,
    });
}

// ── Providers report what the provider vouches for ────────────────────────────

describe("GoogleProvider.exchangeCode reports email_verified", () => {
    it("is verified only when Google says email_verified: true", async () => {
        googleUserinfo = { sub: "g-1", email: VICTIM, email_verified: true };
        const verified = await googleProvider().exchangeCode("c", "http://localhost/cb");
        expect(verified.profile.email).toBe(VICTIM);
        expect(verified.profile.emailVerified).toBe(true);
    });

    it("is unverified when Google says email_verified: false", async () => {
        googleUserinfo = { sub: "g-1", email: VICTIM, email_verified: false };
        const result = await googleProvider().exchangeCode("c", "http://localhost/cb");
        expect(result.profile.emailVerified).toBe(false);
    });

    it("is unverified when Google omits email_verified", async () => {
        googleUserinfo = { sub: "g-1", email: VICTIM };
        const result = await googleProvider().exchangeCode("c", "http://localhost/cb");
        expect(result.profile.emailVerified).toBe(false);
    });
});

describe("GitHubProvider.exchangeCode uses only the primary email from /user/emails", () => {
    beforeEach(() => {
        // The profile's public email is attacker-settable and unverified; it
        // must never be the address a sign-in is matched on.
        githubUser = { id: 7, login: "dev", name: "Dev", email: "public@example.com" };
    });

    it("takes the verified primary, ignoring other verified addresses", async () => {
        githubEmails = {
            status: 200,
            body: [
                { email: "other@example.com", primary: false, verified: true },
                { email: VICTIM, primary: true, verified: true },
            ],
        };
        const result = await githubProvider().exchangeCode("c", "http://localhost/cb");
        expect(result.profile.email).toBe(VICTIM);
        expect(result.profile.emailVerified).toBe(true);
    });

    it("reports an unverified primary as unverified", async () => {
        githubEmails = {
            status: 200,
            body: [
                { email: VICTIM, primary: true, verified: false },
                { email: "other@example.com", primary: false, verified: true },
            ],
        };
        const result = await githubProvider().exchangeCode("c", "http://localhost/cb");
        expect(result.profile.email).toBe(VICTIM);
        expect(result.profile.emailVerified).toBe(false);
    });

    it("throws when the emails call fails, instead of falling back to the profile email", async () => {
        githubEmails = { status: 403, body: { message: "Resource not accessible" } };
        await expect(githubProvider().exchangeCode("c", "http://localhost/cb")).rejects.toThrow(
            /GitHub email fetch failed: 403/,
        );
    });

    it("throws when the account has no primary email, instead of inventing a noreply one", async () => {
        githubEmails = {
            status: 200,
            body: [{ email: "other@example.com", primary: false, verified: true }],
        };
        await expect(githubProvider().exchangeCode("c", "http://localhost/cb")).rejects.toThrow(
            /no primary email/,
        );
    });
});

// ── Sign-in refuses an unverified address before touching any user ────────────

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

for (const db of dbProviders) {
    describe(`OAuth sign-in with an unverified email — ${db.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let store: TripleStore;
        let ctx: ServerContext;
        let users: UserRepository;
        let identities: UserIdentityRepository;

        function service(providers: IOAuthProvider[]): AuthService {
            return new AuthService({
                providers,
                sessionStore: new MemorySessionStore(),
                users,
                identities,
                sessions: new UserSessionRepository(store),
                devices: new UserDeviceRepository(store),
            });
        }

        function signIn(svc: AuthService, provider: "google" | "github") {
            return svc.handleCallback({
                provider,
                code: "code",
                redirectUri: "http://localhost/cb",
                device: { userAgent: "Chrome" },
            });
        }

        beforeEach(async () => {
            knex = await db.create();
            trx = await knex.transaction();
            store = new TripleStore(trx as unknown as Knex);
            ctx = buildServerContext(store, { trx });
            users = new UserRepository(store, TEST_CIPHER);
            identities = new UserIdentityRepository(store, TEST_CIPHER);
        });

        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("Google: refuses, and never links the identity to the user already holding that address", async () => {
            // The pre-registration: a user exists for the address before its
            // owner ever signs in with a provider.
            const existing = await users.create(ctx, systemSec, { email: VICTIM });
            googleUserinfo = { sub: "g-attacker", email: VICTIM, email_verified: false };

            await expect(signIn(service([googleProvider()]), "google")).rejects.toBeInstanceOf(
                OAuthEmailNotVerifiedError,
            );

            expect(
                await identities.findByUserId(ctx, systemSec, { userId: existing.id }),
            ).toHaveLength(0);
            expect(
                await identities.findByProvider(ctx, systemSec, {
                    provider: "google",
                    providerUserId: "g-attacker",
                }),
            ).toBeNull();
        });

        it("Google: refuses, and creates no user, when nobody holds the address yet", async () => {
            googleUserinfo = { sub: "g-claim", email: VICTIM };

            await expect(signIn(service([googleProvider()]), "google")).rejects.toThrow(
                OAUTH_EMAIL_NOT_VERIFIED,
            );
            expect(await users.findByEmail(ctx, systemSec, { email: VICTIM })).toBeNull();
        });

        it("Google: a verified address still signs in and links to the existing user", async () => {
            const existing = await users.create(ctx, systemSec, { email: VICTIM });
            googleUserinfo = { sub: "g-owner", email: VICTIM, email_verified: true };

            const { user } = await signIn(service([googleProvider()]), "google");

            expect(user.id).toBe(existing.id);
            const linked = await identities.findByUserId(ctx, systemSec, { userId: existing.id });
            expect(linked.map((i) => i.providerUserId)).toEqual(["g-owner"]);
        });

        it("GitHub: an unverified primary is refused and links nothing", async () => {
            const existing = await users.create(ctx, systemSec, { email: VICTIM });
            githubUser = { id: 99, login: "attacker" };
            githubEmails = {
                status: 200,
                body: [{ email: VICTIM, primary: true, verified: false }],
            };

            await expect(signIn(service([githubProvider()]), "github")).rejects.toBeInstanceOf(
                OAuthEmailNotVerifiedError,
            );
            expect(
                await identities.findByUserId(ctx, systemSec, { userId: existing.id }),
            ).toHaveLength(0);
        });

        it("GitHub: a verified primary signs in and links to the existing user", async () => {
            const existing = await users.create(ctx, systemSec, { email: VICTIM });
            githubUser = { id: 100, login: "owner" };
            githubEmails = {
                status: 200,
                body: [{ email: VICTIM, primary: true, verified: true }],
            };

            const { user } = await signIn(service([githubProvider()]), "github");
            expect(user.id).toBe(existing.id);
        });

        it("CallbackComponent: refuses an unverified address on errorOut and links nothing", async () => {
            const existing = await users.create(ctx, systemSec, { email: VICTIM });
            googleUserinfo = { sub: "g-fbp", email: VICTIM, email_verified: false };
            bindService(SessionStore, new MemorySessionStore());
            bindService(UserRepository, users);
            bindService(UserIdentityRepository, identities);
            bindService(UserSessionRepository, new UserSessionRepository(store));
            bindService(UserDeviceRepository, new UserDeviceRepository(store));
            const comp = new CallbackComponent({
                name: "callback",
                context: new FlowContext(),
                providers: [googleProvider()],
            });

            comp.callbackIn.put({
                provider: "google",
                code: "c",
                state: "s",
                redirectUri: "http://localhost/cb",
                device: {},
                requestId: "fbp-unverified",
            });
            comp.step();
            // The component settles asynchronously onto exactly one of its out
            // ports; wait for that, not for a fixed delay.
            await vi.waitFor(() => {
                expect(comp.errorOut.size + comp.successOut.size).toBe(1);
            });

            const err = comp.errorOut.read();
            expect(err?.error).toContain(OAUTH_EMAIL_NOT_VERIFIED);
            expect(err?.requestId).toBe("fbp-unverified");
            expect(comp.successOut.read()).toBeUndefined();
            expect(
                await identities.findByUserId(ctx, systemSec, { userId: existing.id }),
            ).toHaveLength(0);
        });
    });
}
