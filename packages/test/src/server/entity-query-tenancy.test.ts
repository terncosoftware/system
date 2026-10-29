/**
 * EntityQuery cross-tenant isolation — real Postgres (TRN-531, fix F7).
 *
 * The flat EntityQuery type scans (.count/.all/.first/.where) previously issued
 * `store.find({ predicate: rdf:type, object })` and property/edge scans WITHOUT
 * a graph key, so they matched quads across every tenant's named graph. On top
 * of that, EntityStore.hydrateMany returned a record for every input IRI even
 * when the subject carried zero quads in the scoped graph, so a foreign-tenant
 * IRI surfaced as an empty "ghost" record. Two tenants seeded in the SAME
 * database therefore leaked into each other's counts, listings, and existence
 * checks.
 *
 * This suite proves isolation on real Postgres (the engine prod runs). SQLite's
 * fresh-:memory:-per-test database can never exhibit a shared-DB cross-graph
 * leak, so the leak — and its fix — are only observable on a shared engine.
 * The suite is therefore Postgres-only and runs when SYS_PG_URL is set. Each
 * test isolates inside a rolled-back transaction.
 */

import { IRI } from "@terncosoftware/core";
import { TripleStore } from "@terncosoftware/data";
import { EntitySchema } from "@terncosoftware/entities";
import { buildServerContext, EntityStore, type ServerContext } from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

// ── Account schema (plain, non-PII so `where('email','=')` matches a literal) ──

const NS = "urn:sys:test:trn531:";

interface AccountProps extends Record<string, unknown> {
    email: string;
    name: string;
}

const AccountSchema = new EntitySchema<AccountProps>({
    typeIRI: new IRI(`${NS}Account`),
    ns: NS,
    properties: {
        email: new IRI(`${NS}email`),
        name: new IRI(`${NS}name`),
    },
});

const TENANT_A = "trn531-tenant-a";
const TENANT_B = "trn531-tenant-b";

// Postgres-only: skipped (and reported as skipped) when SYS_PG_URL is unset.
const PG_URL = process.env.SYS_PG_URL ?? "";

describe.skipIf(PG_URL === "")("EntityQuery — cross-tenant isolation (Postgres)", () => {
    let knex: Knex;
    let trx: Knex.Transaction;
    let store: TripleStore;
    let entityStore: EntityStore;

    beforeEach(async () => {
        const url = new URL(PG_URL);
        knex = await createTestDataContext({
            client: "pg",
            host: url.hostname,
            port: url.port ? Number(url.port) : 5432,
            database: url.pathname.slice(1),
            user: url.username,
            password: url.password,
        });
        trx = await knex.transaction();
        store = new TripleStore(knex);
        entityStore = new EntityStore(store);
    });

    afterEach(async () => {
        await trx.rollback();
        await assertEmptyStore(knex);
        await knex.destroy();
    });

    function ctx(tenantId: string): ServerContext {
        return buildServerContext(store, { trx, tenantId });
    }

    it("count() counts only the calling tenant's entities", async () => {
        await entityStore.create(ctx(TENANT_A), AccountSchema, { email: "a1@x.com", name: "A1" });
        await entityStore.create(ctx(TENANT_A), AccountSchema, { email: "a2@x.com", name: "A2" });
        await entityStore.create(ctx(TENANT_B), AccountSchema, { email: "b1@x.com", name: "B1" });
        await entityStore.create(ctx(TENANT_B), AccountSchema, { email: "b2@x.com", name: "B2" });
        await entityStore.create(ctx(TENANT_B), AccountSchema, { email: "b3@x.com", name: "B3" });

        expect(await ctx(TENANT_A).entities(AccountSchema).count(ctx(TENANT_A))).toBe(2);
        expect(await ctx(TENANT_B).entities(AccountSchema).count(ctx(TENANT_B))).toBe(3);
    });

    it("all() returns only the calling tenant's entities — no ghosts from the other", async () => {
        await entityStore.create(ctx(TENANT_A), AccountSchema, {
            email: "alice@x.com",
            name: "Alice",
        });
        await entityStore.create(ctx(TENANT_B), AccountSchema, { email: "bob@x.com", name: "Bob" });

        const fromA = await ctx(TENANT_A).entities(AccountSchema).all(ctx(TENANT_A));
        expect(fromA.map((r) => r.props.email)).toEqual(["alice@x.com"]);

        const fromB = await ctx(TENANT_B).entities(AccountSchema).all(ctx(TENANT_B));
        expect(fromB.map((r) => r.props.email)).toEqual(["bob@x.com"]);
    });

    it("first() never returns another tenant's entity", async () => {
        await entityStore.create(ctx(TENANT_B), AccountSchema, { email: "bob@x.com", name: "Bob" });

        // Tenant A has nothing; first() must be null, not tenant B's ghost.
        expect(await ctx(TENANT_A).entities(AccountSchema).first(ctx(TENANT_A))).toBeNull();
    });

    it("where('email','=', <other tenant's email>) does NOT confirm existence", async () => {
        await entityStore.create(ctx(TENANT_B), AccountSchema, {
            email: "secret@b.com",
            name: "Secret",
        });

        // Existence probe from tenant A for tenant B's email must find nothing:
        // no count, no first, no listing.
        const probe = () =>
            ctx(TENANT_A).entities(AccountSchema).where("email", "=", "secret@b.com");

        expect(await probe().count(ctx(TENANT_A))).toBe(0);
        expect(await probe().first(ctx(TENANT_A))).toBeNull();
        expect(await probe().all(ctx(TENANT_A))).toHaveLength(0);

        // The owning tenant still sees it — the filter itself is not broken.
        const owner = ctx(TENANT_B).entities(AccountSchema).where("email", "=", "secret@b.com");
        expect(await owner.count(ctx(TENANT_B))).toBe(1);
    });

    it("acrossTenants() is the explicit cross-tenant view: sees every tenant's entities", async () => {
        await entityStore.create(ctx(TENANT_A), AccountSchema, {
            email: "alice@x.com",
            name: "Alice",
        });
        await entityStore.create(ctx(TENANT_B), AccountSchema, { email: "bob@x.com", name: "Bob" });

        // A tenant-scoped ctx still counts/lists ONLY its own graph...
        expect(await ctx(TENANT_A).entities(AccountSchema).count(ctx(TENANT_A))).toBe(1);

        // ...while the sanctioned cross-tenant mode sees both, fully hydrated.
        const query = ctx(TENANT_A).entities(AccountSchema).acrossTenants();
        expect(await query.count(ctx(TENANT_A))).toBe(2);
        const all = await ctx(TENANT_B).entities(AccountSchema).acrossTenants().all(ctx(TENANT_B));
        expect(all.map((r) => r.props.email).sort()).toEqual(["alice@x.com", "bob@x.com"]);
    });

    it("hydrateMany drops a foreign-tenant subject instead of returning a ghost record", async () => {
        const bob = await entityStore.create(ctx(TENANT_B), AccountSchema, {
            email: "bob@x.com",
            name: "Bob",
        });

        // Hydrating tenant B's IRI in tenant A's graph must yield no record: the
        // subject has no rdf:type quad in A's graph, so it is a foreign ghost.
        const ghosts = await entityStore.hydrateMany(ctx(TENANT_A), AccountSchema, [bob.iri]);
        expect(ghosts).toHaveLength(0);

        // Sanity: the owning tenant hydrates it normally.
        const real = await entityStore.hydrateMany(ctx(TENANT_B), AccountSchema, [bob.iri]);
        expect(real).toHaveLength(1);
        expect(real[0]?.props.email).toBe("bob@x.com");
    });
});
