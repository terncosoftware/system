/**
 * TRN-194 / closes TRN-169: at-rest PII encryption for the auth bounded context.
 *
 * Proves the round-trip: User.displayName / avatarUrl and UserIdentity access /
 * refresh tokens are stored as ciphertext in the nodes table — a raw TripleStore
 * scan never sees the plaintext — while repository hydration returns cleartext to
 * callers. Runs against SQLite always + Postgres when SYS_PG_URL is set; each test
 * runs inside a rolled-back transaction.
 */

import { UserIdentityRepository, UserRepository } from "@terncosoftware/auth";
import { TripleStore } from "@terncosoftware/data";
import { buildServerContext, systemSec } from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";
import { TEST_CIPHER } from "./testCipher.js";

interface DbProvider {
    name: string;
    create(): Promise<Knex>;
}

const providers: DbProvider[] = [
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

const ACCESS = "super-secret-access-token-AAA";
const REFRESH = "super-secret-refresh-token-BBB";
const DISPLAY = "Ada Lovelace PII Marker";
const AVATAR = "https://example.com/ada-secret-avatar.png";

for (const db of providers) {
    describe(`At-rest PII encryption (${db.name})`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let store: TripleStore;
        let users: UserRepository;
        let identities: UserIdentityRepository;

        beforeEach(async () => {
            knex = await db.create();
            trx = await knex.transaction();
            store = new TripleStore(trx as unknown as Knex);
            users = new UserRepository(store, TEST_CIPHER);
            identities = new UserIdentityRepository(store, TEST_CIPHER);
        });

        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("stores PII as ciphertext at rest but hydrates cleartext", async () => {
            const ctx = buildServerContext(store, { trx });
            const user = await users.create(ctx, systemSec, {
                email: "ada@example.com",
                displayName: DISPLAY,
                avatarUrl: AVATAR,
            });
            await identities.create(ctx, systemSec, {
                userId: user.id,
                provider: "google",
                providerUserId: "sub-ada-1",
                providerEmail: "ada@example.com",
                accessToken: ACCESS,
                refreshToken: REFRESH,
            });

            // Raw quad scan: no plaintext PII at rest, cipher envelope present.
            const raw = JSON.stringify(await store.findAcrossTenants(ctx, {}));
            expect(raw).not.toContain(ACCESS);
            expect(raw).not.toContain(REFRESH);
            expect(raw).not.toContain(DISPLAY);
            expect(raw).not.toContain(AVATAR);
            expect(raw).toContain("v1:");

            // Typed hydration: callers see cleartext.
            const hydratedUser = await users.findById(ctx, systemSec, { id: user.id });
            expect(hydratedUser?.displayName).toBe(DISPLAY);
            expect(hydratedUser?.avatarUrl).toBe(AVATAR);

            const ident = await identities.findByProvider(ctx, systemSec, {
                provider: "google",
                providerUserId: "sub-ada-1",
            });
            expect(ident?.accessToken).toBe(ACCESS);
            expect(ident?.refreshToken).toBe(REFRESH);
        });
    });
}
