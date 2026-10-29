/**
 * CollectionView integration tests.
 *
 * Scenario: A Group entity has a `members` collection whose values are User
 * entity IRI strings.  A CollectionView is created over that collection and
 * automatically tracks additions and removals.
 *
 * Covers:
 *   - createCollectionView() + getView()
 *   - Auto-update on collectionPush
 *   - Auto-update on collectionRemove
 *   - Explicit addItem / removeItem on CollectionViewStore
 *   - reorder()
 *   - sortProp (direct property on entity IRI)
 *   - sync()
 *   - Multiple views on the same source collection
 *   - delete() cleans up all nodes
 */

import { UserSchema } from "@terncosoftware/auth";
import { IRI } from "@terncosoftware/core";
import { TripleStore } from "@terncosoftware/data";
import { EntitySchema } from "@terncosoftware/entities";
import { CollectionViewStore, buildServerContext, EntityStore } from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";
import { TEST_CIPHER } from "../auth/testCipher.js";

// ── Provider matrix ───────────────────────────────────────────────────────────

interface DbProvider {
    name: string;
    create(): Promise<Knex>;
}

const providers: DbProvider[] = [
    { name: "SQLite", create: () => createTestDataContext({ client: "sqlite", filename: ":memory:" }) },
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

// ── Test schema: Group with a members collection ──────────────────────────────

const memberIRI = new IRI("http://test.dev/group/member");
const groupNameIRI = new IRI("http://test.dev/group/name");

function makeGroupSchema() {
    return new EntitySchema({
        typeIRI: new IRI("http://test.dev/group/Group"),
        ns: "http://test.dev/group/",
        properties: { name: groupNameIRI, member: memberIRI },
    });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

async function setup(db: DbProvider) {
    const knex = await db.create();
    const trx = await knex.transaction();
    const store = new TripleStore(knex);
    const es = new EntityStore(store, undefined, TEST_CIPHER);
    const cvs = new CollectionViewStore(store);
    return { ...buildServerContext(store, { trx, cipher: TEST_CIPHER }), knex, trx, store, es, cvs };
}

async function teardown(ctx: Awaited<ReturnType<typeof setup>>) {
    await ctx.trx.rollback();
    await assertEmptyStore(ctx.knex);
    await ctx.knex.destroy();
}

// ─────────────────────────────────────────────────────────────────────────────

for (const db of providers) {
    // ── Basic create + read ───────────────────────────────────────────────────

    describe(`CollectionView — basic (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        let cvs: CollectionViewStore;
        let schema: EntitySchema;
        let groupId: string;

        beforeEach(async () => {
            ctx = await setup(db);
            ({ es, cvs } = ctx);
            schema = makeGroupSchema();
            const g = await es.create(ctx, schema, { name: "Engineering" });
            groupId = g.id;
        });
        afterEach(() => teardown(ctx));

        it("createCollectionView on empty collection returns empty items", async () => {
            const viewIri = await es.createCollectionView(ctx, schema, groupId, "member");
            const view = await cvs.getView(ctx, viewIri);
            expect(view).not.toBeNull();
            expect(view?.items).toHaveLength(0);
            expect(view?.sourcePg).toContain("http://test.dev/group/");
            expect(view?.prop).toBe(memberIRI.value);
        });

        it("createCollectionView on populated collection pre-fills items", async () => {
            await es.collectionPush(ctx, schema, groupId, "member", "alice", "bob", "carol");
            const viewIri = await es.createCollectionView(ctx, schema, groupId, "member");
            const view = await cvs.getView(ctx, viewIri);
            expect(view?.items).toHaveLength(3);
            expect(view?.items.map((i) => i.ref)).toEqual(["alice", "bob", "carol"]);
        });

        it("getView returns items in position order (ascending)", async () => {
            await es.collectionPush(ctx, schema, groupId, "member", "z", "m", "a");
            const viewIri = await es.createCollectionView(ctx, schema, groupId, "member");
            const view = await cvs.getView(ctx, viewIri);
            expect(view?.items.map((i) => i.ref)).toEqual(["z", "m", "a"]);
        });

        it("getView returns null for unknown viewIri", async () => {
            const view = await cvs.getView(ctx, "urn:sys:core:core:view:no-such-view");
            expect(view).toBeNull();
        });
    });

    // ── Auto-update on collection mutations ───────────────────────────────────

    describe(`CollectionView — auto-update (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        let cvs: CollectionViewStore;
        let schema: EntitySchema;
        let groupId: string;
        let viewIri: string;

        beforeEach(async () => {
            ctx = await setup(db);
            ({ es, cvs } = ctx);
            schema = makeGroupSchema();
            const g = await es.create(ctx, schema, { name: "Dev" });
            groupId = g.id;
            viewIri = await es.createCollectionView(ctx, schema, groupId, "member");
        });
        afterEach(() => teardown(ctx));

        it("collectionPush adds item to registered view", async () => {
            await es.collectionPush(ctx, schema, groupId, "member", "alice");
            const view = await cvs.getView(ctx, viewIri);
            expect(view?.items).toHaveLength(1);
            expect(view?.items[0]?.ref).toBe("alice");
        });

        it("collectionPush with multiple values adds all items", async () => {
            await es.collectionPush(ctx, schema, groupId, "member", "alice", "bob");
            const view = await cvs.getView(ctx, viewIri);
            expect(view?.items).toHaveLength(2);
            expect(view?.items.map((i) => i.ref)).toContain("alice");
            expect(view?.items.map((i) => i.ref)).toContain("bob");
        });

        it("collectionRemove removes item from registered view", async () => {
            await es.collectionPush(ctx, schema, groupId, "member", "alice", "bob", "carol");
            await es.collectionRemove(ctx, schema, groupId, "member", "bob");
            const view = await cvs.getView(ctx, viewIri);
            expect(view?.items).toHaveLength(2);
            expect(view?.items.map((i) => i.ref)).not.toContain("bob");
        });

        it("collectionPush is idempotent in view (same ref not added twice)", async () => {
            await es.collectionPush(ctx, schema, groupId, "member", "alice");
            await cvs.addItem(ctx, viewIri, "alice"); // explicit duplicate attempt
            const view = await cvs.getView(ctx, viewIri);
            expect(view?.items).toHaveLength(1);
        });

        it("collectionSet syncs registered views", async () => {
            await es.collectionPush(ctx, schema, groupId, "member", "alice", "bob", "carol");
            await es.collectionSet(ctx, schema, groupId, "member", ["dave", "eve"]);
            const view = await cvs.getView(ctx, viewIri);
            const refs = view?.items.map((i) => i.ref);
            expect(refs).toContain("dave");
            expect(refs).toContain("eve");
            expect(refs).not.toContain("alice");
        });
    });

    // ── Direct CollectionViewStore operations ─────────────────────────────────

    describe(`CollectionViewStore — direct ops (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let cvs: CollectionViewStore;
        let viewIri: string;

        beforeEach(async () => {
            ctx = await setup(db);
            ({ cvs } = ctx);
            viewIri = await cvs.create(ctx, "http://test/pg", "http://test/prop", [
                "alpha",
                "beta",
                "gamma",
            ]);
        });
        afterEach(() => teardown(ctx));

        it("getView returns correct metadata", async () => {
            const view = await cvs.getView(ctx, viewIri);
            expect(view?.sourcePg).toBe("http://test/pg");
            expect(view?.prop).toBe("http://test/prop");
        });

        it("addItem appends to the end", async () => {
            await cvs.addItem(ctx, viewIri, "delta");
            const view = await cvs.getView(ctx, viewIri);
            expect(view?.items).toHaveLength(4);
            expect(view?.items[3]?.ref).toBe("delta");
        });

        it("removeItem removes the matching item", async () => {
            const removed = await cvs.removeItem(ctx, viewIri, "beta");
            expect(removed).toBe(true);
            const view = await cvs.getView(ctx, viewIri);
            expect(view?.items).toHaveLength(2);
            expect(view?.items.map((i) => i.ref)).not.toContain("beta");
        });

        it("removeItem returns false for unknown ref", async () => {
            const removed = await cvs.removeItem(ctx, viewIri, "no-such-value");
            expect(removed).toBe(false);
        });

        it("reorder updates positions", async () => {
            await cvs.reorder(ctx, viewIri, ["gamma", "alpha", "beta"]);
            const view = await cvs.getView(ctx, viewIri);
            expect(view?.items.map((i) => i.ref)).toEqual(["gamma", "alpha", "beta"]);
        });

        it("sync adds new refs and removes stale ones", async () => {
            await cvs.sync(ctx, viewIri, ["alpha", "gamma", "epsilon"]);
            const view = await cvs.getView(ctx, viewIri);
            const refs = view?.items.map((i) => i.ref);
            expect(refs).toContain("alpha");
            expect(refs).toContain("gamma");
            expect(refs).toContain("epsilon");
            expect(refs).not.toContain("beta");
        });

        it("delete removes view and all CollectionViewItem nodes", async () => {
            await cvs.delete(ctx, viewIri);
            const view = await cvs.getView(ctx, viewIri);
            expect(view).toBeNull();
        });
    });

    // ── Sort by property on referenced entities ────────────────────────────────

    describe(`CollectionView — sortProp (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        let cvs: CollectionViewStore;
        let schema: EntitySchema;
        let groupId: string;

        beforeEach(async () => {
            ctx = await setup(db);
            ({ es, cvs } = ctx);
            schema = makeGroupSchema();

            const charlie = await es.create(ctx, UserSchema, {
                email: "c@test.com",
                displayName: "Charlie",
            });
            const alice = await es.create(ctx, UserSchema, {
                email: "a@test.com",
                displayName: "Alice",
            });
            const bob = await es.create(ctx, UserSchema, {
                email: "b@test.com",
                displayName: "Bob",
            });

            const g = await es.create(ctx, schema, { name: "Sorted Group" });
            groupId = g.id;
            await es.collectionPush(ctx, schema, groupId, "member", charlie.iri, alice.iri, bob.iri);
        });
        afterEach(() => teardown(ctx));

        it("sortProp asc sorts items by property on referenced entity", async () => {
            const displayNameIRI = new IRI("urn:sys:core:auth:displayName");
            const viewIri = await es.createCollectionView(ctx, schema, groupId, "member", {
                sortProp: displayNameIRI,
                sortDir: "asc",
            });
            const view = await cvs.getView(ctx, viewIri);
            const refs = view?.items.map((i) => i.ref) ?? [];
            for (let i = 0; i < refs.length - 1; i++) {
                const refA = refs[i] ?? "";
                const refB = refs[i + 1] ?? "";
                const a = await es.findById(ctx, UserSchema, refA.split("/").pop() ?? refA);
                const b = await es.findById(ctx, UserSchema, refB.split("/").pop() ?? refB);
                const aDN = String(a?.props.displayName ?? "");
                const bDN = String(b?.props.displayName ?? "");
                expect(aDN <= bDN).toBe(true);
            }
        });

        it("sortProp desc reverses the sort", async () => {
            const displayNameIRI = new IRI("urn:sys:core:auth:displayName");
            const viewIri = await es.createCollectionView(ctx, schema, groupId, "member", {
                sortProp: displayNameIRI,
                sortDir: "desc",
            });
            const view = await cvs.getView(ctx, viewIri);
            const refs = view?.items.map((i) => i.ref) ?? [];
            for (let i = 0; i < refs.length - 1; i++) {
                const refA = refs[i] ?? "";
                const refB = refs[i + 1] ?? "";
                const a = await es.findById(ctx, UserSchema, refA.split("/").pop() ?? refA);
                const b = await es.findById(ctx, UserSchema, refB.split("/").pop() ?? refB);
                const aDN = String(a?.props.displayName ?? "");
                const bDN = String(b?.props.displayName ?? "");
                expect(aDN >= bDN).toBe(true);
            }
        });

        it("sortProp stores config on the view", async () => {
            const displayNameIRI = new IRI("urn:sys:core:auth:displayName");
            const viewIri = await es.createCollectionView(ctx, schema, groupId, "member", {
                sortProp: displayNameIRI,
                sortDir: "asc",
            });
            const view = await cvs.getView(ctx, viewIri);
            expect(view?.sortProp).toBe(displayNameIRI.value);
            expect(view?.sortDir).toBe("asc");
        });
    });

    // ── Multiple views on the same collection ─────────────────────────────────

    describe(`CollectionView — multiple views (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        let cvs: CollectionViewStore;
        let schema: EntitySchema;
        let groupId: string;
        let viewA: string;
        let viewB: string;

        beforeEach(async () => {
            ctx = await setup(db);
            ({ es, cvs } = ctx);
            schema = makeGroupSchema();
            const g = await es.create(ctx, schema, { name: "Multi-View Group" });
            groupId = g.id;
            viewA = await es.createCollectionView(ctx, schema, groupId, "member");
            viewB = await es.createCollectionView(ctx, schema, groupId, "member");
        });
        afterEach(() => teardown(ctx));

        it("both views receive the push", async () => {
            await es.collectionPush(ctx, schema, groupId, "member", "alice");
            const va = await cvs.getView(ctx, viewA);
            const vb = await cvs.getView(ctx, viewB);
            expect(va?.items).toHaveLength(1);
            expect(vb?.items).toHaveLength(1);
        });

        it("both views lose the item on remove", async () => {
            await es.collectionPush(ctx, schema, groupId, "member", "alice", "bob");
            await es.collectionRemove(ctx, schema, groupId, "member", "alice");
            const va = await cvs.getView(ctx, viewA);
            const vb = await cvs.getView(ctx, viewB);
            expect(va?.items).toHaveLength(1);
            expect(vb?.items).toHaveLength(1);
        });

        it("deleting one view leaves the other intact", async () => {
            await es.collectionPush(ctx, schema, groupId, "member", "alice");
            await cvs.delete(ctx, viewA);
            expect(await cvs.getView(ctx, viewA)).toBeNull();
            const vb = await cvs.getView(ctx, viewB);
            expect(vb?.items).toHaveLength(1);
        });
    });

    // ── findViewsForSource ────────────────────────────────────────────────────

    describe(`CollectionViewStore.findViewsForSource (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        let cvs: CollectionViewStore;
        let schema: EntitySchema;

        beforeEach(async () => {
            ctx = await setup(db);
            ({ es, cvs } = ctx);
            schema = makeGroupSchema();
        });
        afterEach(() => teardown(ctx));

        it("returns all view IRIs watching a given source + prop", async () => {
            const g1 = await es.create(ctx, schema, { name: "G1" });
            const g2 = await es.create(ctx, schema, { name: "G2" });
            const v1 = await es.createCollectionView(ctx, schema, g1.id, "member");
            const v2 = await es.createCollectionView(ctx, schema, g1.id, "member");
            const v3 = await es.createCollectionView(ctx, schema, g2.id, "member");

            const v1Record = await cvs.getView(ctx, v1);
            if (v1Record == null) {
                throw new Error("v1Record must not be null");
            }
            const { sourcePg, prop } = v1Record;

            const views = await cvs.findViewsForSource(ctx, sourcePg, prop);
            expect(views).toContain(v1);
            expect(views).toContain(v2);
            expect(views).not.toContain(v3);
        });

        it("returns empty array when no views watch the source", async () => {
            const views = await cvs.findViewsForSource(ctx, "http://nonexistent/pg", memberIRI.value);
            expect(views).toHaveLength(0);
        });
    });

    // ── reorder with unknown ref (continue branch) ────────────────────────────

    describe(`CollectionViewStore — reorder unknown-ref continue (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let cvs: CollectionViewStore;
        let viewIri: string;

        beforeEach(async () => {
            ctx = await setup(db);
            ({ cvs } = ctx);
            viewIri = await cvs.create(ctx, "http://test/pg", "http://test/prop", ["alpha", "beta"]);
        });
        afterEach(() => teardown(ctx));

        it("reorder silently skips refs not in the view", async () => {
            await cvs.reorder(ctx, viewIri, ["beta", "alpha", "delta"]);
            const view = await cvs.getView(ctx, viewIri);
            expect(view?.items.map((i) => i.ref)).toContain("alpha");
            expect(view?.items.map((i) => i.ref)).toContain("beta");
        });
    });

    // ── _sortByProp with non-IRI ref (skip branch) ────────────────────────────

    describe(`CollectionViewStore — sortProp non-IRI refs (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        let es: EntityStore;
        let cvs: CollectionViewStore;
        let schema: EntitySchema;

        beforeEach(async () => {
            ctx = await setup(db);
            ({ es, cvs } = ctx);
            schema = makeGroupSchema();
        });
        afterEach(() => teardown(ctx));

        it("sortProp handles refs with no matching property (all sort vals undefined)", async () => {
            const g = await es.create(ctx, schema, { name: "Direct Sort Group" });
            await es.collectionPush(ctx, schema, g.id, "member", "ref-c", "ref-a", "ref-b");

            const viewIri = await es.createCollectionView(ctx, schema, g.id, "member", {
                sortProp: new IRI("http://test.dev/group/name"),
                sortDir: "asc",
            });

            const view = await cvs.getView(ctx, viewIri);
            expect(view?.items).toHaveLength(3);
        });
    });
}
