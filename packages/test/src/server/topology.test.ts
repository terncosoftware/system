/**
 * Authorization scope chain — the containment topology is composed, never registered (TRN-627).
 *
 * `scopeChainFor` resolves the authorization scope chain: the resource plus every
 * ancestor reachable by walking containment edges up to the tenant root. A grant
 * scoped to any IRI in that chain authorizes the resource.
 *
 * The topology used to live in a process-wide mutable Map populated by import-time
 * side effects in generated schema files. When nothing had imported those files the
 * map was empty and the chain silently collapsed to `[entityIri]` — the resource
 * alone, no ancestors. Whether an ancestor grant worked therefore depended on module
 * import order, tree-shaking, or which entry point a test happened to load.
 *
 * The topology is now a value derived from schemas and carried on the context
 * (`ctx.containment`), composed by `buildServerContext` from the core tenancy
 * backbone plus any extension `schemas`. Two consequences are asserted here:
 *
 *   - every context reaches the tenant root by construction, whatever was imported;
 *   - an empty topology throws instead of quietly narrowing the scope chain.
 *
 * Runs against SQLite (always) and Postgres (when SYS_PG_URL is set), each inside a
 * transaction that is rolled back.
 */

import { IRI } from "@terncosoftware/core";
import { hasDomainIRI, hasOrgIRI } from "@terncosoftware/core/tenancy";
import { TripleStore } from "@terncosoftware/data";
import { EntitySchema, entityIriFor } from "@terncosoftware/entities";
import {
    buildServerContext,
    CORE_CONTAINMENT_SCHEMAS,
    containmentPredicatesOf,
    EntityStore,
    OrgSchema,
    PermissionRepository,
    PolicyGrantRepository,
    RbacService,
    ResourceNodeRepository,
    RoleRepository,
    type SecurityContext,
    type ServerContext,
    ServiceAccountRepository,
    scopeChainFor,
    systemSec,
    TenantRepository,
    TenantSchema,
    UserGroupRepository,
} from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

// ── An extension topology: Tenant --hasForum--> Forum --hasPost--> Post ───────

const NS = "urn:sys:ext:topologytest:";
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
// A Tenant view owning forums, so the extension chain reaches the tenant root.
const TenantForums = new EntitySchema({
    typeIRI: TenantSchema.typeIRI,
    ns: TenantSchema.ns,
    idSegment: "tenant",
    properties: { name: new IRI("urn:sys:core:tenancy:tenantName") },
    edges: { forum: { predicate: hasForumIRI, direction: "out", containment: true } },
});
const FORUM_SCHEMAS = [ForumSchema, TenantForums];

const PERM_UPDATE = "post.update";
const ALICE = "urn:sys:core:auth:user:test-alice";
const BOB = "urn:sys:core:auth:user:test-bob";

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

// ── Topology composition (pure, no DB) ───────────────────────────────────────

describe("containment topology — composition", () => {
    it("test the core backbone carries the tenant-rooted containment predicates", () => {
        const predicates = containmentPredicatesOf(CORE_CONTAINMENT_SCHEMAS).map((p) => p.value);
        expect(predicates).toContain(hasOrgIRI.value);
        expect(predicates).toContain(hasDomainIRI.value);
    });

    it("test only containment edges join the topology", () => {
        // OrgSchema.tenant / OrgSchema.owner are back-references, deliberately not
        // containment, so they can never widen a principal's authority.
        const predicates = containmentPredicatesOf([OrgSchema]).map((p) => p.value);
        expect(predicates).toEqual([]);
    });

    it("test extension schemas extend the topology and duplicates collapse", () => {
        const predicates = containmentPredicatesOf([
            ...CORE_CONTAINMENT_SCHEMAS,
            ...FORUM_SCHEMAS,
            ...FORUM_SCHEMAS,
        ]).map((p) => p.value);
        expect(predicates).toContain(hasPostIRI.value);
        expect(predicates).toContain(hasForumIRI.value);
        expect(predicates).toContain(hasOrgIRI.value);
        expect(new Set(predicates).size).toBe(predicates.length);
    });

    it("test no schemas yields no topology", () => {
        expect(containmentPredicatesOf([])).toEqual([]);
    });
});

// ── Provider matrix ──────────────────────────────────────────────────────────

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
    describe(`containment topology — scope chain (${provider.name})`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let store: TripleStore;
        let es: EntityStore;
        let rbac: RbacService;
        let ctx: ServerContext;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            store = new TripleStore(knex);
            es = new EntityStore(store);
            rbac = makeRbac(store);
            ctx = buildServerContext(store, {
                trx,
                tenantId: "acme",
                schemas: FORUM_SCHEMAS,
            });
        });

        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        /** Tenant --hasForum--> Forum --hasPost--> Post, all inside the test trx. */
        async function seedForum(): Promise<{ tenantIri: string; forumIri: string; post: string }> {
            await es.create(ctx, TenantSchema, { name: "Acme" }, "acme");
            const forum = await es.create(ctx, ForumSchema, { name: "Community" });
            await es.addEdge(ctx, TenantForums, "acme", "forum", forum.iri);
            const post = await es.create(ctx, PostSchema, { body: "hi" });
            await es.addEdge(ctx, ForumSchema, forum.id, "post", post.iri);
            return {
                tenantIri: entityIriFor(TenantSchema, "acme").value,
                forumIri: forum.iri,
                post: post.id,
            };
        }

        it("test the scope chain walks containment edges up to the tenant root", async () => {
            const { tenantIri, forumIri, post } = await seedForum();
            const postIri = entityIriFor(PostSchema, post).value;

            const chain = await scopeChainFor(ctx, postIri);

            expect(chain).toContain(postIri);
            expect(chain).toContain(forumIri);
            expect(chain).toContain(tenantIri);
        });

        it("test a grant on an ancestor authorizes a descendant", async () => {
            const { forumIri, post } = await seedForum();

            // Alice is a moderator of the FORUM — never of the post itself.
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
                scopeIri: forumIri,
            });

            // The ancestor grant reaches the descendant post.
            await ctx
                .graph(secFor(ALICE))
                .update(PostSchema, post, { body: "edited" }, { requires: PERM_UPDATE });
            expect((await es.findById(ctx, PostSchema, post))?.props.body).toBe("edited");

            // Bob holds no grant anywhere on the chain.
            await expect(
                ctx
                    .graph(secFor(BOB))
                    .update(PostSchema, post, { body: "hacked" }, { requires: PERM_UPDATE }),
            ).rejects.toThrow(/Access denied/);
            expect((await es.findById(ctx, PostSchema, post))?.props.body).toBe("edited");
        });

        it("test a context built with no extension schemas still reaches the tenant root", async () => {
            // The entry-point independence guarantee: this context is built from the
            // bare `buildServerContext` seam with no `schemas` argument and nothing
            // registered anywhere, yet the core backbone is present by construction.
            // Under the old import-time global this chain collapsed to [orgIri]
            // whenever the tenancy schema module had not been imported first.
            const bare = buildServerContext(store, { trx, tenantId: "acme" });
            expect(bare.containment.length).toBeGreaterThan(0);

            await es.create(bare, TenantSchema, { name: "Acme" }, "acme");
            const org = await es.create(bare, OrgSchema, { name: "Engineering" });
            await es.addEdge(bare, TenantSchema, "acme", "org", org.iri);

            const chain = await scopeChainFor(bare, org.iri);

            expect(chain).toContain(org.iri);
            expect(chain).toContain(entityIriFor(TenantSchema, "acme").value);
        });

        it("test every context composes the same topology regardless of build order", async () => {
            const first = buildServerContext(store, { trx, tenantId: "acme" });
            const second = buildServerContext(store, {
                trx,
                tenantId: "acme",
                schemas: FORUM_SCHEMAS,
            });
            const third = buildServerContext(store, { trx, tenantId: "acme" });

            // Building a context with extension schemas cannot mutate any other
            // context's topology — there is no shared mutable state to mutate.
            expect(third.containment.map((p) => p.value)).toEqual(
                first.containment.map((p) => p.value),
            );
            expect(second.containment.map((p) => p.value)).toContain(hasPostIRI.value);
            expect(first.containment.map((p) => p.value)).not.toContain(hasPostIRI.value);
        });

        it("test an empty topology throws instead of narrowing the scope chain", async () => {
            const { post } = await seedForum();
            const postIri = entityIriFor(PostSchema, post).value;
            const untopologized: ServerContext = { ...ctx, containment: [] };

            // The old behaviour returned [entityIri] — the resource alone, silently
            // dropping every ancestor grant. Authorization cannot be evaluated
            // against an unknown topology, so it must fail loudly instead.
            await expect(scopeChainFor(untopologized, postIri)).rejects.toThrow(
                /no containment topology/,
            );
        });
    });
}
