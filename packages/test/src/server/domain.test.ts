/**
 * DomainSchema integration tests.
 *
 * Verifies that DomainSchema is correctly defined, registered in the tenancy
 * topology, and usable with EntityStore for basic CRUD within tenant graphs.
 *
 * Runs against SQLite (always) and Postgres (when SYS_PG_URL is set), each in
 * a rolled-back transaction.
 */

import { DomainIRI, hasDomainIRI } from "@terncosoftware/core/tenancy";
import { TripleStore } from "@terncosoftware/data";
import {
    buildServerContext,
    CORE_CONTAINMENT_SCHEMAS,
    containmentPredicatesOf,
    DomainSchema,
    EntityStore,
    type ServerContext,
    TenantSchema,
} from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

// ── Schema contract tests (no DB) ─────────────────────────────────────────────

describe("DomainSchema — static contract", () => {
    it("test typeIRI, ns, and idSegment are correct", () => {
        expect(DomainSchema.typeIRI.value).toBe(DomainIRI.value);
        expect(DomainSchema.ns).toBe("urn:sys:core:tenancy");
        expect(DomainSchema.idSegment).toBe("domain");
    });

    it("test schema exposes core domain properties", () => {
        expect(DomainSchema.properties).toHaveProperty("name");
        expect(DomainSchema.properties).toHaveProperty("description");
        expect(DomainSchema.properties).toHaveProperty("url");
    });

    it("test TenantSchema has an outward containment edge for domains", () => {
        const edge = TenantSchema.edges?.domain;
        expect(edge).toBeDefined();
        expect(edge?.predicate.value).toBe(hasDomainIRI.value);
        expect(edge?.direction).toBe("out");
        expect(edge?.containment).toBe(true);
    });

    it("test hasDomainIRI is a containment predicate of the core backbone", () => {
        const predicates = containmentPredicatesOf(CORE_CONTAINMENT_SCHEMAS).map((p) => p.value);
        expect(predicates).toContain(hasDomainIRI.value);
    });
});

// ── CRUD integration tests ────────────────────────────────────────────────────

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

for (const provider of providers) {
    describe(`Domain CRUD — ${provider.name}`, () => {
        let knex: Knex;
        let store: TripleStore;
        let entityStore: EntityStore;
        let trx: Knex.Transaction;

        function ctx(tenantId?: string): ServerContext {
            return tenantId
                ? buildServerContext(store, { trx, tenantId })
                : buildServerContext(store, { trx });
        }

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            store = new TripleStore(knex);
            entityStore = new EntityStore(store);
        });

        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("test create and retrieve a domain entity", async () => {
            const domain = await entityStore.create(ctx("tenant-a"), DomainSchema, {
                name: "example.com",
                description: "Primary site",
                url: "https://example.com",
            });
            expect(domain.id).toBeTruthy();
            expect(domain.props.name).toBe("example.com");

            const found = await entityStore.findById(ctx("tenant-a"), DomainSchema, domain.id);
            expect(found?.props.name).toBe("example.com");
            expect(found?.props.description).toBe("Primary site");
            expect(found?.props.url).toBe("https://example.com");
        });

        it("test domain is isolated to its tenant", async () => {
            const domain = await entityStore.create(ctx("tenant-a"), DomainSchema, {
                name: "example.com",
            });
            const crossLookup = await entityStore.findById(
                ctx("tenant-b"),
                DomainSchema,
                domain.id,
            );
            expect(crossLookup).toBeNull();
        });

        it("test domain name can be updated", async () => {
            const domain = await entityStore.create(ctx("tenant-a"), DomainSchema, {
                name: "old.com",
            });
            await entityStore.update(ctx("tenant-a"), DomainSchema, domain.id, {
                name: "new.com",
            });
            const updated = await entityStore.findById(ctx("tenant-a"), DomainSchema, domain.id);
            expect(updated?.props.name).toBe("new.com");
        });

        it("test domain can be deleted", async () => {
            const domain = await entityStore.create(ctx("tenant-a"), DomainSchema, {
                name: "gone.com",
            });
            await entityStore.delete(ctx("tenant-a"), DomainSchema, domain.id);
            const found = await entityStore.findById(ctx("tenant-a"), DomainSchema, domain.id);
            expect(found).toBeNull();
        });
    });
}
