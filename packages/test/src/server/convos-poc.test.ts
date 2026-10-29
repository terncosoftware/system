/**
 * THROWAWAY PoC — the convos "update system" end to end on the new model:
 *
 *   • graph = tenant  (physical isolation)
 *   • outward-from-root topology:  Tenant --hasOrg--> Org --hasConversation--> Conversation
 *   • the ONE query way: a rooted traversal from the tenant root (never a flat type scan)
 *   • writes via EntityStore (create / update)
 *   • every mutation gated by a real RbacService.assert
 *
 * Not wired into the convos package — it defines its own tiny schemas so the demo
 * is self-contained. Run: `yarn start server/convos-poc.test.ts`.
 */
import { IRI } from "@terncosoftware/core";
import { type Knex, TripleStore } from "@terncosoftware/data";
import { EntitySchema } from "@terncosoftware/entities";
import { entityIriFor } from "@terncosoftware/entities";
import {
    buildServerContext,
    EntityStore,
    OrgSchema,
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

// ── PoC schemas (a tiny convos topology) ──────────────────────────────────────

const POC_NS = "urn:sys:ext:convospoc:";
const hasConversationIRI = new IRI(`${POC_NS}hasConversation`);

const ConversationSchema = new EntitySchema<{ title: string; status: string }>({
    typeIRI: new IRI(`${POC_NS}Conversation`),
    ns: POC_NS,
    idSegment: "conversation",
    properties: { title: new IRI(`${POC_NS}title`), status: new IRI(`${POC_NS}status`) },
});

// An Org that also owns conversations (real OrgSchema only declares `member`).
const OrgWithConvos = new EntitySchema({
    typeIRI: OrgSchema.typeIRI,
    ns: OrgSchema.ns,
    idSegment: "org",
    properties: { name: new IRI("urn:sys:core:tenancy:orgName") },
    edges: {
        conversation: {
            predicate: hasConversationIRI,
            target: () => ConversationSchema,
            cardinality: "many",
            direction: "out",
        },
    },
});

const PERM = "conversation.update";

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

describe("PoC — convos update system (rooted traversal + RBAC)", () => {
    let knex: Knex;
    let trx: Knex.Transaction;
    let store: TripleStore;
    let es: EntityStore;
    let rbac: RbacService;
    let ctx: ServerContext;

    const ALICE = entityIriFor({ ns: "urn:sys:core:auth:", typeIRI: new IRI("urn:sys:core:auth:User") }, "alice").value;
    const BOB = entityIriFor({ ns: "urn:sys:core:auth:", typeIRI: new IRI("urn:sys:core:auth:User") }, "bob").value;

    beforeEach(async () => {
        knex = await createTestDataContext({ client: "sqlite", filename: ":memory:" });
        trx = await knex.transaction();
        store = new TripleStore(knex);
        es = new EntityStore(store);
        rbac = makeRbac(store);
        ctx = buildServerContext(store, { trx, tenantId: "acme" }); // graph = tenant "acme"
    });
    afterEach(async () => {
        await trx.rollback();
        await assertEmptyStore(knex);
        await knex.destroy();
    });

    /** Update gated by RBAC: assert the permission, then write through EntityStore. */
    async function updateConversation(
        sec: SecurityContext,
        id: string,
        patch: { title?: string; status?: string },
    ): Promise<void> {
        await rbac.assert(ctx, sec, { permission: PERM });
        await es.update(ctx, ConversationSchema, id, patch);
    }

    /** The ONE query way: walk the tenant root down to its conversations. */
    async function listConversations(c: ServerContext) {
        const tenantRoot = entityIriFor(TenantSchema, c.tenantId as string);
        const iris = await store.rootedTraverse(c, {
            root: tenantRoot,
            graph: tenantGraph(c),
            hops: [
                { predicate: TenantSchema.edges!.org.predicate, direction: "out" },
                { predicate: hasConversationIRI, direction: "out" },
            ],
            leafType: ConversationSchema.typeIRI,
        });
        return es.hydrateMany(c, ConversationSchema, iris.map((i) => i.value));
    }

    it("demonstrates the full update flow with RBAC and a rooted, tenant-scoped read", async () => {
        // ── Topology: Tenant(acme) -> Org -> Conversation, all in tenant "acme"'s graph ──
        await es.create(ctx, TenantSchema, { name: "Acme" }, "acme");
        const org = await es.create(ctx, OrgSchema, { name: "Acme Eng" });
        await es.addEdge(ctx, TenantSchema, "acme", "org", org);

        const convo = await es.create(ctx, ConversationSchema, { title: "Kickoff", status: "open" });
        await es.addEdge(ctx, OrgWithConvos, org.id, "conversation", convo.iri);

        // ── RBAC: ALICE gets an editor role with conversation.update; BOB gets nothing ──
        const perm = await rbac.createPermission(ctx, systemSec, { key: PERM });
        const editor = await rbac.createRole(ctx, systemSec, { roleName: "ConvoEditor", tenantId: null });
        await rbac.addPermissionToRole(ctx, systemSec, { roleIri: editor.iri, permissionIri: perm.iri });
        await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: editor.iri });

        // ── BOB is denied ──
        expect(await rbac.can(ctx, secFor(BOB), { permission: PERM })).toBe(false);
        await expect(updateConversation(secFor(BOB), convo.id, { title: "Hacked" })).rejects.toThrow(
            /Access denied/,
        );

        // ── ALICE is allowed; the update goes through ──
        await updateConversation(secFor(ALICE), convo.id, { title: "Kickoff (edited)", status: "closed" });

        // ── Read it back via the rooted traversal (tenant -> org -> conversation) ──
        const convos = await listConversations(ctx);
        expect(convos).toHaveLength(1);
        expect(convos[0].props.title).toBe("Kickoff (edited)");
        expect(convos[0].props.status).toBe("closed");

        // ── Tenant isolation: another tenant's identical query sees nothing ──
        const otherTenant = buildServerContext(store, { trx, tenantId: "globex" });
        await es.create(otherTenant, TenantSchema, { name: "Globex" }, "globex");
        expect(await listConversations(otherTenant)).toHaveLength(0);

        // ── Reachability rigor: a convo not attached under the org is invisible ──
        await es.create(ctx, ConversationSchema, { title: "Orphan", status: "open" });
        expect(await listConversations(ctx)).toHaveLength(1);
    });
});
