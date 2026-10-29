/**
 * A store read declares its scope, or it does not happen (TRN-890).
 *
 * The store used to decide the scope of a read from what the caller left out:
 * `graph: null` read the default graph, a graph IRI read that graph, and
 * omitting `graph` read every graph in the database, which is to say every
 * tenant. The three looked identical at the call site and the widest of them
 * was the one you got by saying nothing, so a read that crossed a tenant
 * boundary never announced itself in review and its symptom, rows belonging to
 * somebody else, pointed nowhere near the cause.
 *
 * `graph` is now required, an omitted one throws, and findAcrossTenants() is
 * the one way to span tenants on purpose.
 *
 * Real Postgres throughout, no SQLite or in-memory substitute: one rolled-back
 * transaction per test, the same isolation every other real-infrastructure
 * suite in this package uses.
 */

import type { IRI, Literal, Quad } from "@terncosoftware/core";
import { DEFAULT_GRAPH } from "@terncosoftware/core";
import { type Knex, type QuadPattern, TripleStore } from "@terncosoftware/data";
import { buildServerContext, type ServerContext } from "@terncosoftware/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    assertEmptyStore,
    assertStoreIntegrity,
    createTestDataContext,
} from "../assertEmptyStore.js";

// Same resolution as the other real-infrastructure suites: the env var wins,
// else the shared dev/CI default.
const PG_URL = process.env.SYS_PG_URL ?? "postgresql://sys:sys@localhost:5432/sys";

function iri(value: string): IRI {
    return { value } as IRI;
}

function literal(value: string): Literal {
    return {
        termType: "Literal",
        value,
        datatype: iri("http://www.w3.org/2001/XMLSchema#string"),
    };
}

const SUBJECT = iri("http://example.org/trn890/shared-subject");
const NAME = iri("http://example.org/trn890/name");
const TENANT_A = iri("urn:sys:tenant:trn890-a");
const TENANT_B = iri("urn:sys:tenant:trn890-b");

/** The pattern a caller writes when they forget to say which graph they mean. */
const UNSCOPED = {} as QuadPattern;

function values(quads: readonly Quad[]): string[] {
    return quads.map((q) => (q.object as Literal).value).sort();
}

/** Runs a read that must be rejected and returns the message explaining why. */
async function scopeError(read: Promise<unknown>): Promise<string> {
    try {
        await read;
    } catch (e) {
        return (e as Error).message;
    }
    throw new Error("expected an unscoped read to throw, but it resolved");
}

describe("TripleStore graph scope (real Postgres)", () => {
    let knex: Knex | null = null;
    let trx: Knex.Transaction | null = null;
    let store: TripleStore;
    let ctx: ServerContext;

    // One connection for the file, so migrations run once rather than once per
    // test: concurrent migrations against a shared Postgres collide on the
    // timestamp triggers (TRN-538). Isolation is still per test, by transaction.
    beforeAll(async () => {
        const url = new URL(PG_URL);
        knex = await createTestDataContext({
            client: "pg",
            host: url.hostname,
            port: url.port ? Number(url.port) : 5432,
            database: url.pathname.slice(1),
            user: url.username,
            password: url.password,
        });
    });

    afterAll(async () => {
        if (knex) {
            await assertEmptyStore(knex);
            await knex.destroy();
            knex = null;
        }
    });

    beforeEach(async () => {
        if (!knex) {
            throw new Error("no Postgres connection; beforeAll did not complete");
        }
        trx = await knex.transaction();
        store = new TripleStore(knex);
        ctx = buildServerContext(store, { trx });

        // One subject, three graphs. Every assertion below is about which of
        // these three a given call is entitled to see.
        await store.insert(ctx, {
            subject: SUBJECT,
            predicate: NAME,
            object: literal("default-graph"),
            graph: DEFAULT_GRAPH,
        });
        await store.insert(ctx, {
            subject: SUBJECT,
            predicate: NAME,
            object: literal("tenant-a"),
            graph: TENANT_A,
        });
        await store.insert(ctx, {
            subject: SUBJECT,
            predicate: NAME,
            object: literal("tenant-b"),
            graph: TENANT_B,
        });
    });

    afterEach(async () => {
        if (trx) {
            await assertStoreIntegrity(trx as unknown as Knex);
            await trx.rollback();
            trx = null;
        }
    });

    // ── The guard ─────────────────────────────────────────────────────────────

    // TypeScript already rejects these patterns; the cast is what a JavaScript
    // caller, a wire payload or an `as` somewhere upstream can still produce,
    // and it is exactly what the runtime guard is here to catch.

    it("find() with no graph throws instead of reading every tenant", async () => {
        await expect(store.find(ctx, UNSCOPED)).rejects.toThrow(/no 'graph'/);
    });

    it("findOrdered() with no graph throws instead of reading every tenant", async () => {
        await expect(store.findOrdered(ctx, UNSCOPED)).rejects.toThrow(/no 'graph'/);
    });

    it("findHistory() with no graph throws instead of reading every tenant", async () => {
        await expect(store.findHistory(ctx, UNSCOPED)).rejects.toThrow(/no 'graph'/);
    });

    it("names both alternatives, so the message carries its own fix", async () => {
        const message = await scopeError(store.find(ctx, UNSCOPED));
        // Which call spans tenants...
        expect(message).toContain("findAcrossTenants");
        // ...and what the other scope means.
        expect(message).toContain("graph: null");
        expect(message).toContain("urn:sys:graph:default");
        // And which call was at fault.
        expect(message).toContain("TripleStore.find()");
    });

    it("names the method that was actually called", async () => {
        expect(await scopeError(store.findHistory(ctx, UNSCOPED))).toContain(
            "TripleStore.findHistory()",
        );
        expect(await scopeError(store.findOrdered(ctx, UNSCOPED))).toContain(
            "TripleStore.findOrdered()",
        );
    });

    // ── graph: null still reads the default graph ─────────────────────────────

    it("graph: null reads the default graph and nothing else", async () => {
        const quads = await store.find(ctx, { subject: SUBJECT, graph: null });
        expect(values(quads)).toEqual(["default-graph"]);
    });

    it("graph: null is the scope foundational entities are read in", async () => {
        // Provisioning writes users, orgs, tenants and memberships with
        // DEFAULT_GRAPH, so a null-scoped read finds a quad written that way
        // however many tenant graphs exist alongside it.
        const history = await store.findHistory(ctx, { subject: SUBJECT, graph: null });
        expect(values(history)).toEqual(["default-graph"]);

        const ordered = await store.findOrdered(ctx, { subject: SUBJECT, graph: null });
        expect(values(ordered)).toEqual(["default-graph"]);
    });

    // ── A named graph reads that tenant only ──────────────────────────────────

    it("a tenant graph reads that tenant and neither its neighbour nor the default", async () => {
        const quads = await store.find(ctx, { subject: SUBJECT, graph: TENANT_A });
        expect(values(quads)).toEqual(["tenant-a"]);
    });

    // ── The one way to span tenants ───────────────────────────────────────────

    it("findAcrossTenants() reads every graph, which is the point of it", async () => {
        const quads = await store.findAcrossTenants(ctx, { subject: SUBJECT });
        expect(values(quads)).toEqual(["default-graph", "tenant-a", "tenant-b"]);
    });

    it("findAcrossTenants() still honours the rest of the pattern", async () => {
        const byObject = await store.findAcrossTenants(ctx, {
            subject: SUBJECT,
            object: literal("tenant-b"),
        });
        expect(values(byObject)).toEqual(["tenant-b"]);
    });
});
