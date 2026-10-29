/**
 * THROWAWAY PoC — RBAC scoped to subgraphs over the ENTITY topology.
 *
 * A forum shape:  Tenant --hasForum--> Forum --hasSubforum--> SubForum
 *                        --hasThread--> Thread --hasPost--> Post
 *
 * The point: the SAME outward edges power both directions —
 *   • queries traverse DOWN from the tenant root (rootedTraverse), and
 *   • RBAC resolves a grant's scope chain by walking UP those edges (reachable "in").
 * So a role scoped to "SubForum A" automatically covers every thread/post under A,
 * with no parallel rbac:parentResource tree. Allow + deny + carve-outs all fall out.
 *
 * Demonstrates: Alice is a moderator in SubForum A but not B, with a deny carve-out
 * on one thread inside A.  Run: `yarn start server/forum-rbac-poc.test.ts`.
 */
import { IRI } from "@terncosoftware/core";
import { type Knex, TripleStore } from "@terncosoftware/data";
import { EntitySchema, entityIriFor } from "@terncosoftware/entities";
import {
    buildServerContext,
    EntityStore,
    PermissionRepository,
    PolicyGrantRepository,
    RbacService,
    ResourceNodeRepository,
    RoleRepository,
    type SecurityContext,
    ServiceAccountRepository,
    type ServerContext,
    systemSec,
    TenantRepository,
    TenantSchema,
    tenantGraph,
    UserGroupRepository,
} from "@terncosoftware/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

// ── Forum topology (PoC schemas) ──────────────────────────────────────────────

const NS = "urn:sys:ext:forumpoc:";
const hasForumIRI = new IRI(`${NS}hasForum`);
const hasSubforumIRI = new IRI(`${NS}hasSubforum`);
const hasThreadIRI = new IRI(`${NS}hasThread`);
const hasPostIRI = new IRI(`${NS}hasPost`);
/** The containment edges, in order — used both to traverse down and to scope up. */
const CONTAINMENT = [hasForumIRI, hasSubforumIRI, hasThreadIRI, hasPostIRI];

const out = (predicate: IRI, target: () => EntitySchema) =>
    ({ predicate, target, cardinality: "many", direction: "out" }) as const;

const PostSchema = new EntitySchema<{ body: string }>({
    typeIRI: new IRI(`${NS}Post`),
    ns: NS,
    idSegment: "post",
    properties: { body: new IRI(`${NS}body`) },
});
const ThreadSchema = new EntitySchema<{ title: string }>({
    typeIRI: new IRI(`${NS}Thread`),
    ns: NS,
    idSegment: "thread",
    properties: { title: new IRI(`${NS}title`) },
    edges: { post: out(hasPostIRI, () => PostSchema) },
});
const SubForumSchema = new EntitySchema<{ name: string }>({
    typeIRI: new IRI(`${NS}SubForum`),
    ns: NS,
    idSegment: "subforum",
    properties: { name: new IRI(`${NS}name`) },
    edges: { thread: out(hasThreadIRI, () => ThreadSchema) },
});
const ForumSchema = new EntitySchema<{ name: string }>({
    typeIRI: new IRI(`${NS}Forum`),
    ns: NS,
    idSegment: "forum",
    properties: { name: new IRI(`${NS}name`) },
    edges: { subforum: out(hasSubforumIRI, () => SubForumSchema) },
});
// A Tenant view that owns forums (real TenantSchema only declares `org`).
const TenantWithForums = new EntitySchema({
    typeIRI: TenantSchema.typeIRI,
    ns: TenantSchema.ns,
    idSegment: "tenant",
    properties: { name: new IRI("urn:sys:core:tenancy:tenantName") },
    edges: { forum: out(hasForumIRI, () => ForumSchema) },
});

const PERM = "post.update";

function secFor(principalIri: string): SecurityContext {
    return { principalIri, sessionId: null, isImpersonating: false };
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

describe("PoC — forum RBAC scoped over the entity topology", () => {
    let knex: Knex;
    let trx: Knex.Transaction;
    let store: TripleStore;
    let es: EntityStore;
    let rbac: RbacService;
    let ctx: ServerContext;

    const userIri = (id: string) =>
        entityIriFor({ ns: "urn:sys:core:auth:", typeIRI: new IRI("urn:sys:core:auth:User") }, id).value;
    const ALICE = userIri("alice");
    const NOBODY = userIri("nobody");

    beforeEach(async () => {
        knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        trx = await knex.transaction();
        store = new TripleStore(knex);
        es = new EntityStore(store);
        rbac = makeRbac(store);
        ctx = buildServerContext(store, { trx, tenantId: "acme" });
    });
    afterEach(async () => {
        await trx.rollback();
        await assertEmptyStore(knex);
        await knex.destroy();
    });

    /**
     * The scope chain for a resource = the resource + every ancestor up to the tenant,
     * resolved by walking the containment edges INWARD. This is the unification:
     * the authorization scope is the entity topology, not a separate resource tree.
     */
    async function scopeChain(resourceIri: string): Promise<string[]> {
        const chain = await store.reachable(ctx, {
            roots: [new IRI(resourceIri)],
            predicates: CONTAINMENT,
            direction: "in",
            graph: tenantGraph(ctx),
            includeRoots: true,
        });
        return chain.map((i) => i.value);
    }

    /** Walk DOWN from a subforum to its posts (the query side of the same edges). */
    async function postsUnder(subforumIri: string): Promise<string[]> {
        const iris = await store.rootedTraverse(ctx, {
            root: new IRI(subforumIri),
            graph: tenantGraph(ctx),
            hops: [
                { predicate: hasThreadIRI, direction: "out" },
                { predicate: hasPostIRI, direction: "out" },
            ],
            leafType: PostSchema.typeIRI,
        });
        return iris.map((i) => i.value);
    }

    it("scopes a moderator role to SubForum A — allow, deny, and a carve-out", async () => {
        // ── Build Tenant → Forum → SubForum(A,B) → Thread → Post in the tenant graph ──
        await es.create(ctx, TenantSchema, { name: "Acme" }, "acme");
        const forum = await es.create(ctx, ForumSchema, { name: "Community" });
        await es.addEdge(ctx, TenantWithForums, "acme", "forum", forum.iri);

        const subA = await es.create(ctx, SubForumSchema, { name: "Announcements" });
        const subB = await es.create(ctx, SubForumSchema, { name: "Off-Topic" });
        await es.addEdge(ctx, ForumSchema, forum.id, "subforum", subA.iri);
        await es.addEdge(ctx, ForumSchema, forum.id, "subforum", subB.iri);

        const threadA1 = await es.create(ctx, ThreadSchema, { title: "Welcome" });
        const threadA2 = await es.create(ctx, ThreadSchema, { title: "Locked" });
        const threadB1 = await es.create(ctx, ThreadSchema, { title: "Random" });
        await es.addEdge(ctx, SubForumSchema, subA.id, "thread", threadA1.iri);
        await es.addEdge(ctx, SubForumSchema, subA.id, "thread", threadA2.iri);
        await es.addEdge(ctx, SubForumSchema, subB.id, "thread", threadB1.iri);

        const postA1 = await es.create(ctx, PostSchema, { body: "hi" });
        const postA2 = await es.create(ctx, PostSchema, { body: "in locked thread" });
        const postB1 = await es.create(ctx, PostSchema, { body: "elsewhere" });
        await es.addEdge(ctx, ThreadSchema, threadA1.id, "post", postA1.iri);
        await es.addEdge(ctx, ThreadSchema, threadA2.id, "post", postA2.iri);
        await es.addEdge(ctx, ThreadSchema, threadB1.id, "post", postB1.iri);

        // ── RBAC: a Moderator role with post.update ──
        const perm = await rbac.createPermission(ctx, systemSec, { key: PERM });
        const mod = await rbac.createRole(ctx, systemSec, { roleName: "Moderator", tenantId: null });
        await rbac.addPermissionToRole(ctx, systemSec, { roleIri: mod.iri, permissionIri: perm.iri });

        // Alice is a moderator of SubForum A (scope = the subforum entity node).
        await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: mod.iri, scopeIri: subA.iri });
        // …but threadA2 is locked — a denial carve-out scoped to that thread.
        await rbac.grant(ctx, systemSec, {
            principalIri: ALICE,
            roleIri: mod.iri,
            scopeIri: threadA2.iri,
            isDenial: true,
        });

        const canEdit = (who: SecurityContext, postIri: string) =>
            scopeChain(postIri).then((chain) => rbac.can(ctx, who, { permission: PERM, scopeChain: chain }));

        // Alice CAN edit a post in SubForum A …
        expect(await canEdit(secFor(ALICE), postA1.iri)).toBe(true);
        // … but NOT a post in SubForum B (A is not in B's ancestry) …
        expect(await canEdit(secFor(ALICE), postB1.iri)).toBe(false);
        // … and NOT in the locked thread A2 (deny carve-out wins) …
        expect(await canEdit(secFor(ALICE), postA2.iri)).toBe(false);
        // … and a user with no grant can edit nothing.
        expect(await canEdit(secFor(NOBODY), postA1.iri)).toBe(false);

        // ── Same edges, queried downward: SubForum A contains exactly its two posts. ──
        const aPosts = await postsUnder(subA.iri);
        expect(aPosts.sort()).toEqual([postA1.iri, postA2.iri].sort());
        expect(await postsUnder(subB.iri)).toEqual([postB1.iri]);

        // ── Sanity: the moderator update actually goes through where allowed. ──
        await rbac.assert(ctx, secFor(ALICE), { permission: PERM, scopeChain: await scopeChain(postA1.iri) });
        await es.update(ctx, PostSchema, postA1.id, { body: "edited by mod" });
        const reread = await es.findById(ctx, PostSchema, postA1.id);
        expect(reread?.props.body).toBe("edited by mod");
    });

    it("tenant-roots RBAC: a grant in tenant A is invisible in tenant B; system bypasses", async () => {
        // A global grant for ALICE, created in tenant "acme"'s graph.
        const perm = await rbac.createPermission(ctx, systemSec, { key: "thing.read" });
        const role = await rbac.createRole(ctx, systemSec, { roleName: "Reader", tenantId: null });
        await rbac.addPermissionToRole(ctx, systemSec, { roleIri: role.iri, permissionIri: perm.iri });
        await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: role.iri });

        // Visible in acme …
        expect(await rbac.can(ctx, secFor(ALICE), { permission: "thing.read" })).toBe(true);
        // … but RBAC data lives in the tenant graph, so a different tenant can't see it.
        const globex = buildServerContext(store, { trx, tenantId: "globex" });
        expect(await rbac.can(globex, secFor(ALICE), { permission: "thing.read" })).toBe(false);
        // … and the internal system principal bypasses RBAC in any tenant.
        expect(await rbac.can(globex, systemSec, { permission: "thing.read" })).toBe(true);
    });
});
