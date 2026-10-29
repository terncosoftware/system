/**
 * Graph-scoped multi-tenancy tests.
 *
 * Verifies that EntityStore operations are isolated to the tenant graph when
 * tenantId is present on ServerContext, and fall back to DEFAULT_GRAPH when
 * tenantId is absent.
 */

import { IRI } from "@terncosoftware/core";
import { TripleStore } from "@terncosoftware/data";
import { EntitySchema } from "@terncosoftware/entities";
import { buildServerContext, EntityStore, type ServerContext } from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up as seedData } from "../../../data/src/migrations/001_init.js";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

// ── Widget schema ─────────────────────────────────────────────────────────────

const NS = "urn:sys:test:tenancy:";
const WIDGET_IRI = new IRI(`${NS}Widget`);
const NAME_IRI = new IRI(`${NS}name`);

interface WidgetProps extends Record<string, unknown> {
    name: string;
}

const WidgetSchema = new EntitySchema<WidgetProps>({
    typeIRI: WIDGET_IRI,
    ns: NS,
    properties: { name: NAME_IRI },
});

// ── Test setup ────────────────────────────────────────────────────────────────

describe("EntityStore — tenant isolation", () => {
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
        knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        await seedData(knex);
        trx = await knex.transaction();
        store = new TripleStore(knex);
        entityStore = new EntityStore(store);
    });

    afterEach(async () => {
        await trx.rollback();
        await assertEmptyStore(knex);
        await knex.destroy();
    });

    it("test entities created in tenant graph are not visible without tenant id", async () => {
        const record = await entityStore.create(ctx("tenant-a"), WidgetSchema, { name: "Alpha" });
        const found = await entityStore.findById(ctx(), WidgetSchema, record.id);
        expect(found).toBeNull();
    });

    it("test entities created without tenant id are not visible to tenants", async () => {
        const record = await entityStore.create(ctx(), WidgetSchema, { name: "Global" });
        const found = await entityStore.findById(ctx("tenant-a"), WidgetSchema, record.id);
        expect(found).toBeNull();
    });

    it("test tenant only sees own entities", async () => {
        const a = await entityStore.create(ctx("tenant-a"), WidgetSchema, { name: "AlphaWidget" });
        const b = await entityStore.create(ctx("tenant-b"), WidgetSchema, { name: "BetaWidget" });

        const foundA = await entityStore.findById(ctx("tenant-a"), WidgetSchema, a.id);
        const foundB = await entityStore.findById(ctx("tenant-b"), WidgetSchema, b.id);
        const crossAB = await entityStore.findById(ctx("tenant-a"), WidgetSchema, b.id);
        const crossBA = await entityStore.findById(ctx("tenant-b"), WidgetSchema, a.id);

        expect(foundA?.id).toBe(a.id);
        expect(foundB?.id).toBe(b.id);
        expect(crossAB).toBeNull();
        expect(crossBA).toBeNull();
    });

    it("test update remains within tenant graph", async () => {
        const record = await entityStore.create(ctx("tenant-a"), WidgetSchema, { name: "Before" });

        await entityStore.update(ctx("tenant-a"), WidgetSchema, record.id, { name: "After" });

        const updated = await entityStore.findById(ctx("tenant-a"), WidgetSchema, record.id);
        expect(updated?.props.name).toBe("After");

        const crossLookup = await entityStore.findById(ctx("tenant-b"), WidgetSchema, record.id);
        expect(crossLookup).toBeNull();
    });

    it("test delete only affects tenant graph", async () => {
        const a = await entityStore.create(ctx("tenant-a"), WidgetSchema, { name: "TenantA" });
        const b = await entityStore.create(ctx("tenant-b"), WidgetSchema, { name: "TenantB" });

        await entityStore.delete(ctx("tenant-a"), WidgetSchema, a.id);

        expect(await entityStore.findById(ctx("tenant-a"), WidgetSchema, a.id)).toBeNull();
        expect(await entityStore.findById(ctx("tenant-b"), WidgetSchema, b.id)).not.toBeNull();
    });

    it("test no tenant context continues to use default graph", async () => {
        const record = await entityStore.create(ctx(), WidgetSchema, { name: "Global" });
        const found = await entityStore.findById(ctx(), WidgetSchema, record.id);
        expect(found?.id).toBe(record.id);
    });

    it("test tenant id with special characters is encoded", async () => {
        const weirdTenantId = "acme corp/division & branch";
        const record = await entityStore.create(ctx(weirdTenantId), WidgetSchema, {
            name: "Quirky",
        });

        const found = await entityStore.findById(ctx(weirdTenantId), WidgetSchema, record.id);
        expect(found?.id).toBe(record.id);

        const notFound = await entityStore.findById(ctx("acme-corp"), WidgetSchema, record.id);
        expect(notFound).toBeNull();
    });

    it("test tenant graph iri is stable across instances", async () => {
        const r1 = await entityStore.create(ctx("stable"), WidgetSchema, { name: "First" });
        const r2 = await entityStore.findById(ctx("stable"), WidgetSchema, r1.id);
        expect(r2?.props.name).toBe("First");
    });
});
