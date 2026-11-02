/**
 * TRN-196 — entity-layer PII encryption seam.
 *
 * Proves that a `pii`-flagged property (labs:contactEmail, emitted by codegen as
 * `{ iri, pii: true }`) round-trips through EntityStore returning CLEARTEXT to
 * the caller while the underlying `nodes` row holds CIPHERTEXT, and that a direct
 * TripleStore.find() of the same node returns CIPHERTEXT — i.e. the seam lives at
 * the entity layer, not below it.  Runs against SQLite and (when SYS_PG_URL is
 * set) Postgres, with real infrastructure and a real deterministic FieldCipher.
 */

import { IRI } from "@terncosoftware/core";
import { createDataContext, TripleStore } from "@terncosoftware/data";
import { ProjectSchema } from "@terncosoftware/sandbox-labs";
import { buildServerContext, EntityStore } from "@terncosoftware/server";
import { FieldCipher } from "@terncosoftware/vaults";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ── Provider matrix ───────────────────────────────────────────────────────────

interface DbProvider {
    name: string;
    isPg: boolean;
    create(): Promise<Knex>;
}

const providers: DbProvider[] = [
    {
        name: "SQLite",
        isPg: false,
        create: () => createDataContext({ client: "sqlite", filename: ":memory:" }),
    },
];

if (process.env.SYS_PG_URL) {
    const url = new URL(process.env.SYS_PG_URL);
    providers.push({
        name: "Postgres",
        isPg: true,
        create: () =>
            createDataContext({
                client: "pg",
                host: url.hostname,
                port: url.port ? Number(url.port) : 5432,
                database: url.pathname.slice(1),
                user: url.username,
                password: url.password,
            }),
    });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_KEY = "qG+IgQ50CHW4qU+XU7xeBBEGqVrehg93Z28LRlSsNtM=";
const KEY_ID = "test-1";
const CONTACT_EMAIL_IRI = new IRI("urn:sys:ext:labs:contactEmail");

function makeCipher(): FieldCipher {
    return new FieldCipher({ keys: { [KEY_ID]: TEST_KEY }, currentKeyId: KEY_ID });
}

async function setup(db: DbProvider) {
    const knex = await db.create();
    const store = new TripleStore(knex);
    const cipher = makeCipher();
    const es = new EntityStore(store, undefined, cipher);
    return { knex, store, cipher, es };
}

async function teardown(env: Awaited<ReturnType<typeof setup>>) {
    for (const t of ["edges", "nodes", "namespaces"]) {
        await env.knex(t).del();
    }
    await env.knex.destroy();
}

/** Reads the raw stored lexical value of the contactEmail literal node, if any. */
async function storedEmailNodeValue(
    knex: Knex,
): Promise<{ value: string; isEncrypted: boolean; keyId: string | null } | null> {
    // The contactEmail object is the only xsd:string literal node whose value is
    // not a plaintext project field; read every encrypted literal node.
    const rows = await knex("nodes")
        .where({ kind: "literal" })
        .where("is_encrypted", true)
        .select<{ value: string; is_encrypted: boolean | number; key_id: string | null }[]>("*");
    const row = rows[0];
    if (!row) {
        return null;
    }
    return { value: row.value, isEncrypted: !!row.is_encrypted, keyId: row.key_id };
}

// ─────────────────────────────────────────────────────────────────────────────

for (const db of providers) {
    describe(`EntityStore — PII encryption seam (${db.name})`, () => {
        let env: Awaited<ReturnType<typeof setup>>;

        beforeEach(async () => {
            env = await setup(db);
        });
        afterEach(async () => {
            await teardown(env);
        });

        it("test pii property round-trips as cleartext through the entity layer", async () => {
            const { es, store } = env;
            const ctx = buildServerContext(store, { cipher: env.cipher });

            const created = await es.create(ctx, ProjectSchema, {
                projectName: "Acme Analytics",
                projectSlug: "acme",
                contactEmail: "alice@example.com",
            });
            // create() echoes the caller's input — already cleartext.
            expect(created.props.contactEmail).toBe("alice@example.com");

            // findById hydrates from the store and must decrypt transparently.
            const found = await es.findById(ctx, ProjectSchema, created.id);
            expect(found).not.toBeNull();
            expect(found?.props.contactEmail).toBe("alice@example.com");
            // Non-PII props are untouched.
            expect(found?.props.projectName).toBe("Acme Analytics");
        });

        it("test underlying node row holds ciphertext flagged is_encrypted with key id", async () => {
            const { es, store, knex, cipher } = env;
            const ctx = buildServerContext(store, { cipher });

            await es.create(ctx, ProjectSchema, {
                projectName: "Acme",
                projectSlug: "acme",
                contactEmail: "bob@example.com",
            });

            const node = await storedEmailNodeValue(knex);
            expect(node).not.toBeNull();
            // Stored value is ciphertext, not the plaintext email.
            expect(node?.value).not.toBe("bob@example.com");
            expect(node?.value.startsWith("v1:")).toBe(true);
            expect(node?.isEncrypted).toBe(true);
            expect(node?.keyId).toBe(KEY_ID);
            // And it decrypts back to the original plaintext.
            expect(cipher.decrypt(KEY_ID, node?.value ?? "")).toBe("bob@example.com");
        });

        it("test direct TripleStore.find returns ciphertext, not plaintext", async () => {
            const { es, store, cipher } = env;
            const ctx = buildServerContext(store, { cipher });

            const created = await es.create(ctx, ProjectSchema, {
                projectName: "Acme",
                projectSlug: "acme",
                contactEmail: "carol@example.com",
            });

            const ent = new IRI(created.iri);
            const quads = await store.withTransaction(buildServerContext(store), (txCtx) =>
                store.find(txCtx, { subject: ent, predicate: CONTACT_EMAIL_IRI, graph: null }),
            );
            expect(quads).toHaveLength(1);
            const objectValue = (quads[0]?.object as { value: string }).value;
            // Raw store access bypasses the entity seam ⇒ ciphertext.
            expect(objectValue).not.toBe("carol@example.com");
            expect(objectValue.startsWith("v1:")).toBe(true);
            expect(cipher.decrypt(KEY_ID, objectValue)).toBe("carol@example.com");
        });

        it("test update re-encrypts the pii property and stays cleartext on read", async () => {
            const { es, store, cipher } = env;
            const ctx = buildServerContext(store, { cipher });

            const created = await es.create(ctx, ProjectSchema, {
                projectName: "Acme",
                projectSlug: "acme",
                contactEmail: "old@example.com",
            });
            await es.update(ctx, ProjectSchema, created.id, { contactEmail: "new@example.com" });

            const found = await es.findById(ctx, ProjectSchema, created.id);
            expect(found?.props.contactEmail).toBe("new@example.com");

            const ent = new IRI(created.iri);
            const quads = await store.withTransaction(buildServerContext(store), (txCtx) =>
                store.find(txCtx, { subject: ent, predicate: CONTACT_EMAIL_IRI, graph: null }),
            );
            expect(quads).toHaveLength(1);
            const objectValue = (quads[0]?.object as { value: string }).value;
            expect(objectValue).not.toBe("new@example.com");
            expect(cipher.decrypt(KEY_ID, objectValue)).toBe("new@example.com");
        });

        it("test deterministic ciphertext — equal plaintext stores equal ciphertext", async () => {
            const { es, store, knex, cipher } = env;
            const ctx = buildServerContext(store, { cipher });

            await es.create(ctx, ProjectSchema, {
                projectName: "One",
                projectSlug: "one",
                contactEmail: "dup@example.com",
            });
            await es.create(ctx, ProjectSchema, {
                projectName: "Two",
                projectSlug: "two",
                contactEmail: "dup@example.com",
            });

            const rows = await knex("nodes")
                .where({ kind: "literal" })
                .where("is_encrypted", true)
                .select<{ value: string }[]>("value");
            // Deterministic cipher ⇒ identical plaintext yields identical ciphertext,
            // one literal node per entity.
            expect(rows).toHaveLength(2);
            expect(rows[0]?.value).toBe(rows[1]?.value);
        });

        it("test writing pii without a cipher throws rather than storing cleartext", async () => {
            const { store } = env;
            const es = new EntityStore(store); // no cipher anywhere
            const ctx = buildServerContext(store); // no ctx.cipher

            await expect(
                es.create(ctx, ProjectSchema, {
                    projectName: "Acme",
                    projectSlug: "acme",
                    contactEmail: "nope@example.com",
                }),
            ).rejects.toThrow(/PII/);
        });

        it("test non-pii-only entity still writes without a cipher", async () => {
            const { store } = env;
            const es = new EntityStore(store);
            const ctx = buildServerContext(store);

            const created = await es.create(ctx, ProjectSchema, {
                projectName: "No PII",
                projectSlug: "no-pii",
            });
            const found = await es.findById(ctx, ProjectSchema, created.id);
            expect(found?.props.projectName).toBe("No PII");
        });
    });
}
