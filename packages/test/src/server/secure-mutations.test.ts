/**
 * THROWAWAY PoC — security folded into the mutation path ("hard to get wrong").
 *
 * A privileged write goes through ctx.graph(sec).update/create/delete, which
 * REQUIRES a permission and asserts it against the entity's scope chain —
 * resolved automatically over the containment topology. There is no separate
 * "remember to call rbac.assert"; you cannot issue the write without it.
 *
 *   Tenant --hasForum--> Forum --hasPost--> Post   (both edges containment)
 *
 * Run: `yarn start server/secure-mutations.test.ts`.
 */
import { IRI } from "@terncosoftware/core";
import { type Knex, TripleStore } from "@terncosoftware/data";
import { EntitySchema, entityIriFor, RDF_TYPE } from "@terncosoftware/entities";
import {
    buildServerContext,
    EntityStore,
    PermissionRepository,
    PolicyGrantRepository,
    RbacService,
    ResourceNodeRepository,
    RoleRepository,
    type SecurityContext,
    type ServerContext,
    ServiceAccountRepository,
    systemSec,
    TenantRepository,
    TenantSchema,
    tenantGraph,
    UserGroupRepository,
} from "@terncosoftware/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

const NS = "urn:sys:ext:securepoc:";
const hasForumIRI = new IRI(`${NS}hasForum`);
const hasPostIRI = new IRI(`${NS}hasPost`);

const PostSchema = new EntitySchema<{ body: string }>({
    typeIRI: new IRI(`${NS}Post`),
    ns: NS,
    idSegment: "post",
    properties: { body: new IRI(`${NS}body`) },
});
const ForumSchema = new EntitySchema<{ name: string }>({
    typeIRI: new IRI(`${NS}Forum`),
    ns: NS,
    idSegment: "forum",
    properties: { name: new IRI(`${NS}name`) },
    edges: { post: { predicate: hasPostIRI, direction: "out", containment: true } },
});
// Tenant view that owns forums (containment), so the chain reaches the tenant root.
const TenantForums = new EntitySchema({
    typeIRI: TenantSchema.typeIRI,
    ns: TenantSchema.ns,
    idSegment: "tenant",
    properties: { name: new IRI("urn:sys:core:tenancy:tenantName") },
    edges: { forum: { predicate: hasForumIRI, direction: "out", containment: true } },
});

// The forum topology is handed to each context explicitly — no module-scope
// registration, so the scope chain cannot depend on import order (TRN-627).
const FORUM_SCHEMAS = [ForumSchema, TenantForums];

const PERM_UPDATE = "post.update";
const PERM_CREATE = "post.create";

function secFor(iri: string): SecurityContext {
    return { principalIri: iri, sessionId: null, isImpersonating: false };
}
function makeRbac(store: TripleStore): RbacService {
    return new RbacService({
        store,
        tenants: new TenantRepository(store),
        groups: new UserGroupRepository(store),
        roles: new RoleRepository(store),
        grants: new PolicyGrantRepository(store),
        permissions: new PermissionRepository(store),
        resources: new ResourceNodeRepository(store),
        serviceAccounts: new ServiceAccountRepository(store),
    });
}

describe("PoC — secure-by-default mutations", () => {
    let knex: Knex;
    let trx: Knex.Transaction;
    let store: TripleStore;
    let es: EntityStore;
    let rbac: RbacService;
    let ctx: ServerContext;

    const userIri = (id: string) =>
        entityIriFor({ ns: "urn:sys:core:auth:", typeIRI: new IRI("urn:sys:core:auth:User") }, id)
            .value;
    const ALICE = userIri("alice");
    const BOB = userIri("bob");

    beforeEach(async () => {
        knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        trx = await knex.transaction();
        store = new TripleStore(knex);
        es = new EntityStore(store);
        rbac = makeRbac(store);
        ctx = buildServerContext(store, { trx, tenantId: "acme", schemas: FORUM_SCHEMAS });
    });
    afterEach(async () => {
        await trx.rollback();
        await assertEmptyStore(knex);
        await knex.destroy();
    });

    it("won't update without the permission, and asserts the scope chain automatically", async () => {
        await es.create(ctx, TenantSchema, { name: "Acme" }, "acme");
        const forum = await es.create(ctx, ForumSchema, { name: "Community" });
        await es.addEdge(ctx, TenantForums, "acme", "forum", forum.iri);
        const post = await es.create(ctx, PostSchema, { body: "hi" });
        await es.addEdge(ctx, ForumSchema, forum.id, "post", post.iri);

        // Alice is a moderator of the forum (post.update scoped to the forum node).
        const perm = await rbac.createPermission(ctx, systemSec, { key: PERM_UPDATE });
        const mod = await rbac.createRole(ctx, systemSec, {
            roleName: "Moderator",
            tenantId: null,
        });
        await rbac.addPermissionToRole(ctx, systemSec, {
            roleIri: mod.iri,
            permissionIri: perm.iri,
        });
        await rbac.grant(ctx, systemSec, {
            principalIri: ALICE,
            roleIri: mod.iri,
            scopeIri: forum.iri,
        });

        // Bob can't — and there's no way to skip the check; the write never happens.
        await expect(
            ctx
                .graph(secFor(BOB))
                .update(PostSchema, post.id, { body: "hacked" }, { requires: PERM_UPDATE }),
        ).rejects.toThrow(/Access denied/);
        expect((await es.findById(ctx, PostSchema, post.id))?.props.body).toBe("hi");

        // Alice can — the scope chain (post→forum→tenant) is resolved for her, no manual assert.
        await ctx
            .graph(secFor(ALICE))
            .update(PostSchema, post.id, { body: "edited" }, { requires: PERM_UPDATE });
        expect((await es.findById(ctx, PostSchema, post.id))?.props.body).toBe("edited");

        // The system principal bypasses RBAC.
        await ctx
            .graph(systemSec)
            .update(PostSchema, post.id, { body: "sys" }, { requires: PERM_UPDATE });
        expect((await es.findById(ctx, PostSchema, post.id))?.props.body).toBe("sys");
    });

    it("create attaches under a parent (reachable by construction) and is authorized there", async () => {
        await es.create(ctx, TenantSchema, { name: "Acme" }, "acme");
        const forum = await es.create(ctx, ForumSchema, { name: "Community" });
        await es.addEdge(ctx, TenantForums, "acme", "forum", forum.iri);

        const perm = await rbac.createPermission(ctx, systemSec, { key: PERM_CREATE });
        const author = await rbac.createRole(ctx, systemSec, {
            roleName: "Author",
            tenantId: null,
        });
        await rbac.addPermissionToRole(ctx, systemSec, {
            roleIri: author.iri,
            permissionIri: perm.iri,
        });
        await rbac.grant(ctx, systemSec, {
            principalIri: ALICE,
            roleIri: author.iri,
            scopeIri: forum.iri,
        });

        // Bob can't create under the forum.
        await expect(
            ctx.graph(secFor(BOB)).create(
                PostSchema,
                { body: "x" },
                {
                    requires: PERM_CREATE,
                    under: { schema: ForumSchema, id: forum.id, edge: "post" },
                },
            ),
        ).rejects.toThrow(/Access denied/);

        // Alice can — and the new post is attached under the forum, so it's reachable.
        const post = await ctx.graph(secFor(ALICE)).create(
            PostSchema,
            { body: "first post" },
            {
                requires: PERM_CREATE,
                under: { schema: ForumSchema, id: forum.id, edge: "post" },
            },
        );
        const reachable = await store.rootedTraverse(ctx, {
            root: entityIriFor(TenantSchema, "acme"),
            graph: tenantGraphOf(ctx),
            hops: [
                { predicate: hasForumIRI, direction: "out" },
                { predicate: hasPostIRI, direction: "out" },
            ],
            leafType: PostSchema.typeIRI,
        });
        expect(reachable.map((i) => i.value)).toEqual([post.iri]);
    });
});

// local helper to avoid importing tenantGraph by name collision in the test
function tenantGraphOf(ctx: ServerContext): IRI {
    return new IRI(`urn:sys:core:tenant:${ctx.tenantId}`);
}

/**
 * Atomicity of create-and-attach (no ambient transaction). The bug this guards:
 * GraphQuery.create used to run `es.create` then `es.addEdge` as two separate
 * commits, so a failure attaching the entity under its parent left an orphaned
 * entity persisted but unreachable. With the fix the whole mutation is one
 * reentrant transaction, so a failed attach rolls the created entity back too.
 *
 * This suite must NOT hold an ambient trx (the bug only manifests when
 * GraphQuery opens its own transaction); writes can auto-commit, so the teardown
 * clears the tables.
 */
describe("PoC — secure mutations are atomic (create + attach-under)", () => {
    let knex: Knex;
    let store: TripleStore;
    let es: EntityStore;
    let ctx: ServerContext;

    beforeEach(async () => {
        knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        store = new TripleStore(knex);
        es = new EntityStore(store);
        ctx = buildServerContext(store, { tenantId: "acme", schemas: FORUM_SCHEMAS }); // no ambient trx
    });
    afterEach(async () => {
        for (const t of ["edges", "nodes", "namespaces"]) {
            await knex(t).del();
        }
        await knex.destroy();
    });

    it("rolls the created entity back when attach-under fails (no orphan)", async () => {
        await ctx.tx((c) => es.create(c, TenantSchema, { name: "Acme" }, "acme"));
        const forum = await ctx.tx((c) => es.create(c, ForumSchema, { name: "Community" }));
        await ctx.tx((c) => es.addEdge(c, TenantForums, "acme", "forum", forum.iri));

        const before = await store.find(ctx, {
            predicate: RDF_TYPE,
            object: PostSchema.typeIRI,
            graph: tenantGraph(ctx),
        });

        // systemSec bypasses RBAC so _assert passes; a bogus edge name makes the
        // attach (addEdge) throw AFTER the post has been created within the txn.
        await expect(
            ctx.graph(systemSec).create(
                PostSchema,
                { body: "orphan" },
                {
                    requires: PERM_CREATE,
                    under: { schema: ForumSchema, id: forum.id, edge: "nonexistent" },
                },
            ),
        ).rejects.toThrow(/no edge/);

        const after = await store.find(ctx, {
            predicate: RDF_TYPE,
            object: PostSchema.typeIRI,
            graph: tenantGraph(ctx),
        });
        expect(after.length).toBe(before.length); // the created Post was rolled back
    });
});
