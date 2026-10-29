/**
 * TernAggregate + AggregateRepository integration tests.
 *
 * Uses a real SQLite in-memory store.  No mocks.
 *
 * The "Widget" aggregate is defined inline — a minimal concrete aggregate
 * with two properties (name, color) and one domain event (renamed).
 */

import type { DomainEvent } from "@terncosoftware/core";
import { IRI } from "@terncosoftware/core";
import { TripleStore } from "@terncosoftware/data";
import { type EntityRecord, EntitySchema, TernAggregate } from "@terncosoftware/entities";
import type { ServerContext } from "@terncosoftware/server";
import { AggregateRepository, buildServerContext, EntityStore } from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up as seedData } from "../../../data/src/migrations/001_init.js";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

// ── Widget domain objects ─────────────────────────────────────────────────────

const NS = "urn:sys:test:widget:";
const WIDGET_IRI = new IRI(`${NS}Widget`);
const NAME_IRI = new IRI(`${NS}name`);
const COLOR_IRI = new IRI(`${NS}color`);

interface WidgetProps extends Record<string, unknown> {
    name: string;
    color: string;
}

const WidgetSchema = new EntitySchema<WidgetProps>({
    typeIRI: WIDGET_IRI,
    ns: NS,
    properties: { name: NAME_IRI, color: COLOR_IRI },
});

class Widget extends TernAggregate<WidgetProps> {
    static readonly RENAMED = "urn:sys:test:widget.renamed";

    get name(): string | undefined {
        return this._get("name");
    }

    get color(): string | undefined {
        return this._get("color");
    }

    rename(newName: string): void {
        const old = this.name;
        this._set("name", newName);
        this._emit<{ from: string | undefined; to: string }>({
            id: Math.random().toString(36).slice(2),
            type: Widget.RENAMED,
            source: this.iri,
            timestamp: Date.now(),
            payload: { from: old, to: newName },
        });
    }

    recolor(newColor: string): void {
        this._set("color", newColor);
    }
}

class WidgetRepository extends AggregateRepository<Widget> {
    get schema() {
        return WidgetSchema;
    }
    reconstruct(record: EntityRecord): Widget {
        return new Widget(record);
    }
}

// ── Test setup ────────────────────────────────────────────────────────────────

describe("TernAggregate + AggregateRepository", () => {
    let knex: Knex;
    let store: TripleStore;
    let entityStore: EntityStore;
    let repo: WidgetRepository;
    let trx: Knex.Transaction;
    let ctx: ServerContext;

    beforeEach(async () => {
        knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        await seedData(knex);
        trx = await knex.transaction();
        ctx = buildServerContext(store, { trx });
        store = new TripleStore(knex);
        entityStore = new EntityStore(store);
        repo = new WidgetRepository(entityStore);
    });

    afterEach(async () => {
        await trx.rollback();
        await assertEmptyStore(knex);
        await knex.destroy();
    });

    // ── Unit behaviour (no store) ─────────────────────────────────────────────

    it("test get returns constructor props", () => {
        const record: EntityRecord = {
            id: "test-id",
            iri: `${NS}widget/test-id`,
            props: { name: "Sprocket", color: "blue" },
        };
        const widget = new Widget(record);
        expect(widget.name).toBe("Sprocket");
        expect(widget.color).toBe("blue");
    });

    it("test set mutates in memory state", () => {
        const record: EntityRecord = {
            id: "test-id",
            iri: `${NS}widget/test-id`,
            props: { name: "Sprocket", color: "blue" },
        };
        const widget = new Widget(record);
        widget.rename("Cog");
        expect(widget.name).toBe("Cog");
    });

    it("test is dirty after mutation", () => {
        const record: EntityRecord = {
            id: "test-id",
            iri: `${NS}widget/test-id`,
            props: { name: "A", color: "red" },
        };
        const widget = new Widget(record);
        expect(widget.isDirty).toBe(false);
        widget.rename("B");
        expect(widget.isDirty).toBe(true);
    });

    it("test drain changes returns and clears changes", () => {
        const record: EntityRecord = {
            id: "test-id",
            iri: `${NS}widget/test-id`,
            props: { name: "A", color: "red" },
        };
        const widget = new Widget(record);
        widget.rename("B");
        widget.recolor("green");

        const changes = widget.drainChanges();
        expect(changes).toEqual({ name: "B", color: "green" });
        expect(widget.isDirty).toBe(false);
    });

    it("test domain event emitted on rename", () => {
        const record: EntityRecord = {
            id: "test-id",
            iri: `${NS}widget/test-id`,
            props: { name: "A", color: "red" },
        };
        const widget = new Widget(record);
        widget.rename("B");

        const events = widget.drainEvents();
        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe(Widget.RENAMED);
        expect((events[0]?.payload as { to: string }).to).toBe("B");
    });

    it("test drain events clears buffer", () => {
        const record: EntityRecord = {
            id: "test-id",
            iri: `${NS}widget/test-id`,
            props: { name: "A", color: "red" },
        };
        const widget = new Widget(record);
        widget.rename("B");
        widget.drainEvents();
        expect(widget.drainEvents()).toHaveLength(0);
    });

    it("test no event emitted for recolor", () => {
        const record: EntityRecord = {
            id: "test-id",
            iri: `${NS}widget/test-id`,
            props: { name: "A", color: "red" },
        };
        const widget = new Widget(record);
        widget.recolor("green");
        expect(widget.drainEvents()).toHaveLength(0);
    });

    // ── Repository round-trips (real SQLite store) ────────────────────────────

    it("test find by id returns null for missing entity", async () => {
        const result = await repo.findById(ctx, "nonexistent");
        expect(result).toBeNull();
    });

    it("test find by id reconstitutes aggregate", async () => {
        const record = await entityStore.create(ctx, WidgetSchema, {
            name: "Sprocket",
            color: "blue",
        });

        const widget = await repo.findById(ctx, record.id);
        expect(widget).not.toBeNull();
        expect(widget?.id).toBe(record.id);
        expect(widget?.name).toBe("Sprocket");
        expect(widget?.color).toBe("blue");
    });

    it("test save persists changes", async () => {
        const record = await entityStore.create(ctx, WidgetSchema, {
            name: "Sprocket",
            color: "blue",
        });

        const widget = await repo.findById(ctx, record.id);
        if (widget === null) {
            throw new Error("expected widget");
        }
        widget.rename("Cog");
        await repo.save(ctx, widget);

        const reloaded = await repo.findById(ctx, record.id);
        expect(reloaded?.name).toBe("Cog");
        expect(reloaded?.color).toBe("blue");
    });

    it("test save publishes domain events to ctx bus", async () => {
        const { InMemorySystemBus } = await import("@terncosoftware/core");
        const bus = new InMemorySystemBus();
        const received: DomainEvent[] = [];
        await bus.subscribe(Widget.RENAMED, "test", async (e) => {
            received.push(e);
        });

        const ctxWithBus = { ...ctx, bus };
        const record = await entityStore.create(ctxWithBus, WidgetSchema, {
            name: "Sprocket",
            color: "blue",
        });

        const widget = await repo.findById(ctxWithBus, record.id);
        if (widget === null) {
            throw new Error("expected widget");
        }
        widget.rename("Cog");
        await repo.save(ctxWithBus, widget);

        expect(received).toHaveLength(1);
        expect(received[0]?.type).toBe(Widget.RENAMED);
        await bus.close();
    });

    it("test save with no pending changes is noop", async () => {
        const record = await entityStore.create(ctx, WidgetSchema, {
            name: "Sprocket",
            color: "blue",
        });

        const widget = await repo.findById(ctx, record.id);
        if (widget === null) {
            throw new Error("expected widget");
        }
        await repo.save(ctx, widget); // no changes — should not throw

        const reloaded = await repo.findById(ctx, record.id);
        expect(reloaded?.name).toBe("Sprocket");
    });

    it("test save no event bus drops events silently", async () => {
        const record = await entityStore.create(ctx, WidgetSchema, {
            name: "Sprocket",
            color: "blue",
        });

        const widget = await repo.findById(ctx, record.id);
        if (widget === null) {
            throw new Error("expected widget");
        }
        widget.rename("Cog");
        await repo.save(ctx, widget); // bus omitted — events drained silently
        expect(widget.isDirty).toBe(false);
    });

    it("test save skips unknown props in change set silently", async () => {
        // If drainChanges() somehow returns a prop name not in the schema,
        // EntityStore.update() filters it out — no throw.
        const record = await entityStore.create(ctx, WidgetSchema, {
            name: "Rivet",
            color: "copper",
        });

        const widget = await repo.findById(ctx, record.id);
        if (widget === null) {
            throw new Error("expected widget");
        }

        // Inject a key that isn't in WidgetSchema.properties
        (widget as unknown as { _changes: Record<string, unknown> })._changes.unknownProp = "bar";

        widget.rename("RivetV2");
        await expect(repo.save(ctx, widget)).resolves.not.toThrow();

        const reloaded = await repo.findById(ctx, record.id);
        expect(reloaded).not.toBeNull();
        expect(reloaded?.name).toBe("RivetV2");
    });
});
