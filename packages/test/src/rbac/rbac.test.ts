/**
 * RBAC integration tests.
 *
 * Every suite runs against both SQLite (always) and Postgres (when SYS_PG_URL
 * is set), each in a rolled-back transaction for clean isolation.
 *
 * Scenarios are drawn from a fictional B2B SaaS called "Tern Cloud" with two
 * tenants — Acme Corp and Globex Corp — and a set of real-world principals,
 * groups, roles, and resources.
 */

import { TripleStore } from "@terncosoftware/data";
import {
    AccessChecker,
    buildServerContext,
    PermissionRepository,
    PolicyGrantRepository,
    RbacService,
    ResourceNodeRepository,
    RoleRepository,
    type SecurityContext,
    type ServerContext,
    ServiceAccountRepository,
    SYS_SUPERUSERS_IRI,
    seedSystemData,
    systemSec,
    TenantRepository,
    UserGroupRepository,
} from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

// ── Provider matrix ───────────────────────────────────────────────────────────

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

// ── Synthetic user IRIs (no auth dependency) ──────────────────────────────────

const ALICE = "urn:sys:core:auth:user:test-alice";
const BOB = "urn:sys:core:auth:user:test-bob";
const CHARLIE = "urn:sys:core:auth:user:test-charlie";
const DAVE = "urn:sys:core:auth:user:test-dave"; // Globex user

// ── Shared suite (runs once per provider) ─────────────────────────────────────

// ── SecurityContext helpers ───────────────────────────────────────────────────

function secFor(principalIri: string): SecurityContext {
    return { principalIri, sessionId: null, isImpersonating: false };
}

function secActingAs(principalIri: string, actingAsIri: string): SecurityContext {
    return {
        principalIri,
        sessionId: null,
        isImpersonating: true,
        actingAsIri,
    };
}

for (const provider of providers) {
    describe(`RBAC — ${provider.name}`, () => {
        let knex: Knex;
        let store: TripleStore;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let rbac: RbacService;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            store = new TripleStore(knex);
            ctx = buildServerContext(store, { trx });
            // Seed inside the test transaction so afterEach's rollback removes it —
            // seeding on the raw knex would commit and leak across the shared PG DB.
            await seedSystemData(ctx, store);

            const tenants = new TenantRepository(store);
            const groups = new UserGroupRepository(store);
            const roles = new RoleRepository(store);
            const grants = new PolicyGrantRepository(store);
            const permissions = new PermissionRepository(store);
            const resources = new ResourceNodeRepository(store);
            const serviceAccounts = new ServiceAccountRepository(store);

            rbac = new RbacService({
                store,
                tenants,
                groups,
                roles,
                grants,
                permissions,
                resources,
                serviceAccounts,
            });
        });

        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        // ── Migration bootstrap ───────────────────────────────────────────────

        describe("migration 004 bootstrap", () => {
            it("superadmin role has wildcard permission", async () => {
                const allowed = await rbac.can(ctx, secFor(ALICE), {
                    permission: "anything.atAll",
                });
                // ALICE is not in superusers yet, so denied
                expect(allowed).toBe(false);
            });

            it("seeding is idempotent — running it twice does not error", async () => {
                // beforeEach already seeded once; seeding again must be a no-op.
                await expect(seedSystemData(ctx, store)).resolves.toBeUndefined();
            });
        });

        // ── Tenants and groups ────────────────────────────────────────────────

        describe("tenants and groups", () => {
            it("creates a tenant", async () => {
                const acme = await rbac.createTenant(ctx, systemSec, { name: "Acme Corp" });
                expect(acme.name).toBe("Acme Corp");
                expect(acme.id).toBeTruthy();
            });

            it("creates a group inside a tenant", async () => {
                const acme = await rbac.createTenant(ctx, systemSec, { name: "Acme Corp" });
                const admins = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Admins",
                    tenantId: acme.id,
                });
                expect(admins.groupName).toBe("Admins");
                expect(admins.isInTenant?.id).toBe(acme.id);
            });

            it("adds a member to a group", async () => {
                const acme = await rbac.createTenant(ctx, systemSec, { name: "Acme Corp" });
                const group = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Staff",
                    tenantId: acme.id,
                });
                await rbac.addMember(ctx, systemSec, { groupIri: group.iri, memberIri: ALICE });
                const members = await rbac.listMembers(ctx, systemSec, { groupIri: group.iri });
                expect(members).toContain(ALICE);
            });

            it("removes a member from a group", async () => {
                const acme = await rbac.createTenant(ctx, systemSec, { name: "Acme Corp" });
                const group = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Staff",
                    tenantId: acme.id,
                });
                await rbac.addMember(ctx, systemSec, { groupIri: group.iri, memberIri: ALICE });
                await rbac.removeMember(ctx, systemSec, { groupIri: group.iri, memberIri: ALICE });
                const members = await rbac.listMembers(ctx, systemSec, { groupIri: group.iri });
                expect(members).not.toContain(ALICE);
            });
        });

        // ── UserGroup CRUD ────────────────────────────────────────────────────

        describe("UserGroup CRUD", () => {
            it("findByName returns the group", async () => {
                const acme = await rbac.createTenant(ctx, systemSec, { name: "Acme Corp" });
                await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Engineering",
                    tenantId: acme.id,
                });
                const found = await rbac.findUserGroupByName(ctx, systemSec, {
                    name: "Engineering",
                    tenantId: acme.id,
                });
                expect(found?.groupName).toBe("Engineering");
            });

            it("findByName returns null when name does not exist", async () => {
                const found = await rbac.findUserGroupByName(ctx, systemSec, { name: "Nobody" });
                expect(found).toBeNull();
            });

            it("listUserGroups returns all groups for a tenant", async () => {
                const acme = await rbac.createTenant(ctx, systemSec, { name: "Acme Corp" });
                await rbac.createUserGroup(ctx, systemSec, { groupName: "Eng", tenantId: acme.id });
                await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Design",
                    tenantId: acme.id,
                });
                const groups = await rbac.listUserGroups(ctx, systemSec, { tenantId: acme.id });
                expect(groups.map((g) => g.groupName)).toEqual(
                    expect.arrayContaining(["Eng", "Design"]),
                );
            });

            it("updateUserGroup renames the group", async () => {
                const acme = await rbac.createTenant(ctx, systemSec, { name: "Acme Corp" });
                const group = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "OldName",
                    tenantId: acme.id,
                });
                const updated = await rbac.updateUserGroup(ctx, systemSec, {
                    id: group.id,
                    patch: {
                        groupName: "NewName",
                    },
                });
                expect(updated?.groupName).toBe("NewName");
            });

            it("deleteUserGroup removes the group and its memberships", async () => {
                const acme = await rbac.createTenant(ctx, systemSec, { name: "Acme Corp" });
                const group = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Temp",
                    tenantId: acme.id,
                });
                await rbac.addMember(ctx, systemSec, { groupIri: group.iri, memberIri: ALICE });
                await rbac.deleteUserGroup(ctx, systemSec, { id: group.id });

                // Group is gone
                expect(await rbac.getUserGroup(ctx, systemSec, { id: group.id })).toBeNull();
                // Alice is no longer in it
                const members = await rbac.listMembers(ctx, systemSec, { groupIri: group.iri });
                expect(members).toHaveLength(0);
            });

            it("getUserGroup returns null for unknown id", async () => {
                expect(await rbac.getUserGroup(ctx, systemSec, { id: "nonexistent" })).toBeNull();
            });
        });

        // ── RbacInspector ─────────────────────────────────────────────────────

        describe("RbacInspector", () => {
            it("listEffectivePermissions delegates to AccessChecker", async () => {
                const perm = await rbac.createPermission(ctx, systemSec, { key: "report.view" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "Reporter",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: perm.iri,
                });
                await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: role.iri });

                const inspector = rbac.inspector();
                const perms = await inspector.listEffectivePermissions(ctx, systemSec, {
                    principalIri: ALICE,
                });
                expect(perms.has("report.view")).toBe(true);
            });

            it("explain returns allowed:true with a grant path for a direct grant", async () => {
                const perm = await rbac.createPermission(ctx, systemSec, { key: "invoice.read" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "BillingViewer",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: perm.iri,
                });
                await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: role.iri });

                const inspector = rbac.inspector();
                const result = await inspector.explain(ctx, systemSec, {
                    principal: ALICE,
                    permission: "invoice.read",
                });
                expect(result.allowed).toBe(true);
                expect(result.allowedBy).toHaveLength(1);
                expect(result.allowedBy[0].roleIri).toBe(role.iri);
                expect(result.allowedBy[0].membershipChain).toHaveLength(0);
                expect(result.deniedBy).toHaveLength(0);
            });

            it("explain shows membership chain when permission comes via a group", async () => {
                const perm = await rbac.createPermission(ctx, systemSec, { key: "deploy.run" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "Deployer",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: perm.iri,
                });
                const group = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Ops",
                    tenantId: null,
                });
                await rbac.addMember(ctx, systemSec, { groupIri: group.iri, memberIri: ALICE });
                await rbac.grant(ctx, systemSec, { principalIri: group.iri, roleIri: role.iri });

                const inspector = rbac.inspector();
                const result = await inspector.explain(ctx, systemSec, {
                    principal: ALICE,
                    permission: "deploy.run",
                });
                expect(result.allowed).toBe(true);
                expect(result.allowedBy[0].membershipChain).toContain(group.iri);
            });

            it("explain shows roleInheritanceChain when permission is inherited", async () => {
                const read = await rbac.createPermission(ctx, systemSec, { key: "doc.read" });
                const viewer = await rbac.createRole(ctx, systemSec, {
                    roleName: "Viewer",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: viewer.iri,
                    permissionIri: read.iri,
                });
                const editor = await rbac.createRole(ctx, systemSec, {
                    roleName: "Editor",
                    tenantId: null,
                });
                await rbac.addRoleInheritance(ctx, systemSec, {
                    childRoleIri: editor.iri,
                    parentRoleIri: viewer.iri,
                });
                await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: editor.iri });

                const inspector = rbac.inspector();
                const result = await inspector.explain(ctx, systemSec, {
                    principal: ALICE,
                    permission: "doc.read",
                });
                expect(result.allowed).toBe(true);
                expect(result.allowedBy[0].roleIri).toBe(editor.iri);
                expect(result.allowedBy[0].roleInheritanceChain).toContain(viewer.iri);
            });

            it("explain returns allowed:false with deniedBy populated for a denial", async () => {
                const perm = await rbac.createPermission(ctx, systemSec, { key: "billing.delete" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "BillingOwner",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: perm.iri,
                });
                await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: role.iri });
                await rbac.grant(ctx, systemSec, {
                    principalIri: ALICE,
                    roleIri: role.iri,
                    isDenial: true,
                });

                const inspector = rbac.inspector();
                const result = await inspector.explain(ctx, systemSec, {
                    principal: ALICE,
                    permission: "billing.delete",
                });
                expect(result.allowed).toBe(false);
                expect(result.deniedBy.length).toBeGreaterThan(0);
            });

            it("explain returns allowed:false with empty paths for a principal with no grants", async () => {
                const inspector = rbac.inspector();
                const result = await inspector.explain(ctx, systemSec, {
                    principal: DAVE,
                    permission: "anything",
                });
                expect(result.allowed).toBe(false);
                expect(result.allowedBy).toHaveLength(0);
            });

            it("listGroupMemberships returns direct groups", async () => {
                const g1 = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "G1",
                    tenantId: null,
                });
                const g2 = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "G2",
                    tenantId: null,
                });
                await rbac.addMember(ctx, systemSec, { groupIri: g1.iri, memberIri: ALICE });
                await rbac.addMember(ctx, systemSec, { groupIri: g2.iri, memberIri: ALICE });

                const inspector = rbac.inspector();
                const groups = await inspector.listGroupMemberships(ctx, systemSec, {
                    principalIri: ALICE,
                });
                const names = groups.map((g) => g.groupName);
                expect(names).toContain("G1");
                expect(names).toContain("G2");
            });

            it("listGroupMemberships transitive includes nested groups", async () => {
                const parent = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Parent",
                    tenantId: null,
                });
                const child = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Child",
                    tenantId: null,
                });
                await rbac.addMember(ctx, systemSec, {
                    groupIri: parent.iri,
                    memberIri: child.iri,
                }); // child is member of parent
                await rbac.addMember(ctx, systemSec, { groupIri: child.iri, memberIri: ALICE }); // ALICE is member of child

                const inspector = rbac.inspector();
                const direct = await inspector.listGroupMemberships(ctx, systemSec, {
                    principalIri: ALICE,
                });
                const transitive = await inspector.listGroupMemberships(ctx, systemSec, {
                    principalIri: ALICE,
                    transitive: true,
                });
                expect(direct.map((g) => g.groupName)).toContain("Child");
                expect(direct.map((g) => g.groupName)).not.toContain("Parent");
                expect(transitive.map((g) => g.groupName)).toContain("Child");
                expect(transitive.map((g) => g.groupName)).toContain("Parent");
            });

            it("listGroupMembers returns direct members", async () => {
                const group = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Team",
                    tenantId: null,
                });
                await rbac.addMember(ctx, systemSec, { groupIri: group.iri, memberIri: ALICE });
                await rbac.addMember(ctx, systemSec, { groupIri: group.iri, memberIri: BOB });

                const inspector = rbac.inspector();
                const members = await inspector.listGroupMembers(ctx, systemSec, {
                    groupIri: group.iri,
                });
                expect(members).toContain(ALICE);
                expect(members).toContain(BOB);
            });

            it("listGroupMembers transitive expands nested groups", async () => {
                const outer = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Outer",
                    tenantId: null,
                });
                const inner = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Inner",
                    tenantId: null,
                });
                await rbac.addMember(ctx, systemSec, { groupIri: outer.iri, memberIri: inner.iri });
                await rbac.addMember(ctx, systemSec, { groupIri: inner.iri, memberIri: ALICE });

                const inspector = rbac.inspector();
                const direct = await inspector.listGroupMembers(ctx, systemSec, {
                    groupIri: outer.iri,
                });
                const transitive = await inspector.listGroupMembers(ctx, systemSec, {
                    groupIri: outer.iri,
                    transitive: true,
                });
                expect(direct).toContain(inner.iri);
                expect(direct).not.toContain(ALICE);
                expect(transitive).toContain(ALICE);
            });

            it("listGroupsWithMembers returns groups with their member lists", async () => {
                const acme = await rbac.createTenant(ctx, systemSec, { name: "Acme Corp" });
                const g = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Devs",
                    tenantId: acme.id,
                });
                await rbac.addMember(ctx, systemSec, { groupIri: g.iri, memberIri: ALICE });
                await rbac.addMember(ctx, systemSec, { groupIri: g.iri, memberIri: BOB });

                const inspector = rbac.inspector();
                const result = await inspector.listGroupsWithMembers(ctx, systemSec, {
                    tenantId: acme.id,
                });
                const devs = result.find((r) => r.groupName === "Devs");
                expect(devs?.members).toContain(ALICE);
                expect(devs?.members).toContain(BOB);
            });
        });

        // ── Roles and permissions ─────────────────────────────────────────────

        describe("roles and permissions", () => {
            it("creates a role and assigns a permission", async () => {
                const acme = await rbac.createTenant(ctx, systemSec, { name: "Acme Corp" });
                const read = await rbac.createPermission(ctx, systemSec, { key: "project.read" });
                const viewer = await rbac.createRole(ctx, systemSec, {
                    roleName: "Viewer",
                    tenantId: acme.id,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: viewer.iri,
                    permissionIri: read.iri,
                });

                await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: viewer.iri });

                expect(await rbac.can(ctx, secFor(ALICE), { permission: "project.read" })).toBe(
                    true,
                );
                expect(await rbac.can(ctx, secFor(ALICE), { permission: "project.write" })).toBe(
                    false,
                );
            });

            it("removing a permission from a role immediately revokes it", async () => {
                const read = await rbac.createPermission(ctx, systemSec, { key: "project.read" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "Viewer",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: read.iri,
                });
                await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: role.iri });

                expect(await rbac.can(ctx, secFor(ALICE), { permission: "project.read" })).toBe(
                    true,
                );

                await rbac.removePermissionFromRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: read.iri,
                });
                expect(await rbac.can(ctx, secFor(ALICE), { permission: "project.read" })).toBe(
                    false,
                );
            });
        });

        // ── Role inheritance ──────────────────────────────────────────────────

        describe("role inheritance", () => {
            it("child role inherits parent permissions", async () => {
                const read = await rbac.createPermission(ctx, systemSec, { key: "project.read" });
                const write = await rbac.createPermission(ctx, systemSec, { key: "project.write" });

                const viewer = await rbac.createRole(ctx, systemSec, {
                    roleName: "Viewer",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: viewer.iri,
                    permissionIri: read.iri,
                });

                const editor = await rbac.createRole(ctx, systemSec, {
                    roleName: "Editor",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: editor.iri,
                    permissionIri: write.iri,
                });
                await rbac.addRoleInheritance(ctx, systemSec, {
                    childRoleIri: editor.iri,
                    parentRoleIri: viewer.iri,
                }); // editor inherits viewer

                await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: editor.iri });

                expect(await rbac.can(ctx, secFor(ALICE), { permission: "project.read" })).toBe(
                    true,
                );
                expect(await rbac.can(ctx, secFor(ALICE), { permission: "project.write" })).toBe(
                    true,
                );
            });

            it("three-level inheritance chain propagates all permissions", async () => {
                const read = await rbac.createPermission(ctx, systemSec, { key: "project.read" });
                const write = await rbac.createPermission(ctx, systemSec, { key: "project.write" });
                const admin = await rbac.createPermission(ctx, systemSec, { key: "project.admin" });

                const viewer = await rbac.createRole(ctx, systemSec, {
                    roleName: "Viewer",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: viewer.iri,
                    permissionIri: read.iri,
                });

                const editor = await rbac.createRole(ctx, systemSec, {
                    roleName: "Editor",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: editor.iri,
                    permissionIri: write.iri,
                });
                await rbac.addRoleInheritance(ctx, systemSec, {
                    childRoleIri: editor.iri,
                    parentRoleIri: viewer.iri,
                });

                const owner = await rbac.createRole(ctx, systemSec, {
                    roleName: "Owner",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: owner.iri,
                    permissionIri: admin.iri,
                });
                await rbac.addRoleInheritance(ctx, systemSec, {
                    childRoleIri: owner.iri,
                    parentRoleIri: editor.iri,
                });

                await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: owner.iri });

                expect(await rbac.can(ctx, secFor(ALICE), { permission: "project.read" })).toBe(
                    true,
                );
                expect(await rbac.can(ctx, secFor(ALICE), { permission: "project.write" })).toBe(
                    true,
                );
                expect(await rbac.can(ctx, secFor(ALICE), { permission: "project.admin" })).toBe(
                    true,
                );
                expect(await rbac.can(ctx, secFor(ALICE), { permission: "billing.write" })).toBe(
                    false,
                );
            });

            it("non-inherited sibling role permissions do not bleed across", async () => {
                const permA = await rbac.createPermission(ctx, systemSec, { key: "a.action" });
                const permB = await rbac.createPermission(ctx, systemSec, { key: "b.action" });

                const roleA = await rbac.createRole(ctx, systemSec, {
                    roleName: "RoleA",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: roleA.iri,
                    permissionIri: permA.iri,
                });

                const roleB = await rbac.createRole(ctx, systemSec, {
                    roleName: "RoleB",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: roleB.iri,
                    permissionIri: permB.iri,
                });

                await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: roleA.iri });

                expect(await rbac.can(ctx, secFor(ALICE), { permission: "a.action" })).toBe(true);
                expect(await rbac.can(ctx, secFor(ALICE), { permission: "b.action" })).toBe(false);
            });
        });

        // ── Group-based access control ────────────────────────────────────────

        describe("group-based access", () => {
            it("user inherits role via group membership", async () => {
                const read = await rbac.createPermission(ctx, systemSec, { key: "project.read" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "Viewer",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: read.iri,
                });

                const group = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Staff",
                    tenantId: null,
                });
                await rbac.addMember(ctx, systemSec, { groupIri: group.iri, memberIri: ALICE });
                await rbac.grant(ctx, systemSec, { principalIri: group.iri, roleIri: role.iri });

                expect(await rbac.can(ctx, secFor(ALICE), { permission: "project.read" })).toBe(
                    true,
                );
                // Non-member Bob cannot
                expect(await rbac.can(ctx, secFor(BOB), { permission: "project.read" })).toBe(
                    false,
                );
            });

            it("nested groups: user in subgroup gains parent-group permissions", async () => {
                const manage = await rbac.createPermission(ctx, systemSec, { key: "user.manage" });
                const adminRole = await rbac.createRole(ctx, systemSec, {
                    roleName: "Admin",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: adminRole.iri,
                    permissionIri: manage.iri,
                });

                const admins = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Admins",
                    tenantId: null,
                });
                const superAdmins = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "SuperAdmins",
                    tenantId: null,
                });

                // superAdmins is a member of admins (nested group)
                await rbac.addMember(ctx, systemSec, {
                    groupIri: admins.iri,
                    memberIri: superAdmins.iri,
                });
                await rbac.grant(ctx, systemSec, {
                    principalIri: admins.iri,
                    roleIri: adminRole.iri,
                });

                // Alice is in superAdmins
                await rbac.addMember(ctx, systemSec, {
                    groupIri: superAdmins.iri,
                    memberIri: ALICE,
                });

                // Alice should inherit via: ALICE → superAdmins → admins → Admin role → user.manage
                expect(await rbac.can(ctx, secFor(ALICE), { permission: "user.manage" })).toBe(
                    true,
                );
            });

            it("revoking group membership removes inherited permissions", async () => {
                const read = await rbac.createPermission(ctx, systemSec, { key: "project.read" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "Viewer",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: read.iri,
                });
                const group = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Staff",
                    tenantId: null,
                });
                await rbac.addMember(ctx, systemSec, { groupIri: group.iri, memberIri: ALICE });
                await rbac.grant(ctx, systemSec, { principalIri: group.iri, roleIri: role.iri });

                expect(await rbac.can(ctx, secFor(ALICE), { permission: "project.read" })).toBe(
                    true,
                );

                await rbac.removeMember(ctx, systemSec, { groupIri: group.iri, memberIri: ALICE });
                expect(await rbac.can(ctx, secFor(ALICE), { permission: "project.read" })).toBe(
                    false,
                );
            });
        });

        // ── Explicit denials ──────────────────────────────────────────────────

        describe("explicit denials", () => {
            it("denial blocks an otherwise-allowed permission", async () => {
                const read = await rbac.createPermission(ctx, systemSec, { key: "billing.read" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "Viewer",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: read.iri,
                });
                const group = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Staff",
                    tenantId: null,
                });
                await rbac.addMember(ctx, systemSec, { groupIri: group.iri, memberIri: ALICE });
                await rbac.grant(ctx, systemSec, { principalIri: group.iri, roleIri: role.iri });

                // Explicit denial directly on Alice
                await rbac.grant(ctx, systemSec, {
                    principalIri: ALICE,
                    roleIri: role.iri,
                    isDenial: true,
                });

                expect(await rbac.can(ctx, secFor(ALICE), { permission: "billing.read" })).toBe(
                    false,
                );
            });

            it("denial does not affect other principals in the same group", async () => {
                const read = await rbac.createPermission(ctx, systemSec, { key: "billing.read" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "Viewer",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: read.iri,
                });
                const group = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Staff",
                    tenantId: null,
                });
                await rbac.addMember(ctx, systemSec, { groupIri: group.iri, memberIri: ALICE });
                await rbac.addMember(ctx, systemSec, { groupIri: group.iri, memberIri: BOB });
                await rbac.grant(ctx, systemSec, { principalIri: group.iri, roleIri: role.iri });

                // Deny only Alice
                await rbac.grant(ctx, systemSec, {
                    principalIri: ALICE,
                    roleIri: role.iri,
                    isDenial: true,
                });

                expect(await rbac.can(ctx, secFor(ALICE), { permission: "billing.read" })).toBe(
                    false,
                );
                expect(await rbac.can(ctx, secFor(BOB), { permission: "billing.read" })).toBe(true);
            });
        });

        // ── Temporary grants ──────────────────────────────────────────────────

        describe("temporary grants", () => {
            it("grant with future expiry is honoured", async () => {
                const perm = await rbac.createPermission(ctx, systemSec, { key: "temp.access" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "TempRole",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: perm.iri,
                });

                const expiresAt = new Date(Date.now() + 60_000); // 1 minute from now
                await rbac.grant(ctx, systemSec, {
                    principalIri: ALICE,
                    roleIri: role.iri,
                    grantExpiresAt: expiresAt,
                });

                expect(await rbac.can(ctx, secFor(ALICE), { permission: "temp.access" })).toBe(
                    true,
                );
            });

            it("grant with past expiry is not honoured", async () => {
                const perm = await rbac.createPermission(ctx, systemSec, { key: "temp.access" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "TempRole",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: perm.iri,
                });

                const expired = new Date(Date.now() - 1); // already in the past
                await rbac.grant(ctx, systemSec, {
                    principalIri: ALICE,
                    roleIri: role.iri,
                    grantExpiresAt: expired,
                });

                expect(await rbac.can(ctx, secFor(ALICE), { permission: "temp.access" })).toBe(
                    false,
                );
            });

            it("revoking a grant immediately removes access", async () => {
                const perm = await rbac.createPermission(ctx, systemSec, { key: "project.write" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "Editor",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: perm.iri,
                });
                const g = await rbac.grant(ctx, systemSec, {
                    principalIri: ALICE,
                    roleIri: role.iri,
                });

                expect(await rbac.can(ctx, secFor(ALICE), { permission: "project.write" })).toBe(
                    true,
                );

                await rbac.revoke(ctx, systemSec, { grantIri: g.iri });
                expect(await rbac.can(ctx, secFor(ALICE), { permission: "project.write" })).toBe(
                    false,
                );
            });
        });

        // ── Resource-scoped grants ────────────────────────────────────────────

        describe("resource-scoped grants", () => {
            it("system-wide grant (no scope) allows access on any resource", async () => {
                const read = await rbac.createPermission(ctx, systemSec, { key: "project.read" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "Reader",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: read.iri,
                });
                const project = await rbac.createResource(ctx, systemSec, {
                    resourceType: "project",
                });

                await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: role.iri });

                expect(
                    await rbac.can(ctx, secFor(ALICE), {
                        permission: "project.read",
                        scope: project.iri,
                    }),
                ).toBe(true);
            });

            it("resource-scoped grant only allows access on that resource", async () => {
                const read = await rbac.createPermission(ctx, systemSec, { key: "project.read" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "Reader",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: read.iri,
                });
                const projectA = await rbac.createResource(ctx, systemSec, {
                    resourceType: "project",
                });
                const projectB = await rbac.createResource(ctx, systemSec, {
                    resourceType: "project",
                });

                await rbac.grant(ctx, systemSec, {
                    principalIri: ALICE,
                    roleIri: role.iri,
                    scopeIri: projectA.iri,
                });

                expect(
                    await rbac.can(ctx, secFor(ALICE), {
                        permission: "project.read",
                        scope: projectA.iri,
                    }),
                ).toBe(true);
                expect(
                    await rbac.can(ctx, secFor(ALICE), {
                        permission: "project.read",
                        scope: projectB.iri,
                    }),
                ).toBe(false);
                expect(await rbac.can(ctx, secFor(ALICE), { permission: "project.read" })).toBe(
                    false,
                );
            });

            it("grant on parent resource applies to child (scope chain)", async () => {
                const read = await rbac.createPermission(ctx, systemSec, { key: "file.read" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "Reader",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: read.iri,
                });

                const project = await rbac.createResource(ctx, systemSec, {
                    resourceType: "project",
                });
                const folder = await rbac.createResource(ctx, systemSec, {
                    resourceType: "folder",
                    parentIri: project.iri,
                });
                const file = await rbac.createResource(ctx, systemSec, {
                    resourceType: "file",
                    parentIri: folder.iri,
                });

                // Grant scoped to the top-level project
                await rbac.grant(ctx, systemSec, {
                    principalIri: ALICE,
                    roleIri: role.iri,
                    scopeIri: project.iri,
                });

                // Should propagate down through folder → file
                expect(
                    await rbac.can(ctx, secFor(ALICE), {
                        permission: "file.read",
                        scope: file.iri,
                    }),
                ).toBe(true);
                expect(
                    await rbac.can(ctx, secFor(ALICE), {
                        permission: "file.read",
                        scope: folder.iri,
                    }),
                ).toBe(true);
                expect(
                    await rbac.can(ctx, secFor(ALICE), {
                        permission: "file.read",
                        scope: project.iri,
                    }),
                ).toBe(true);
            });

            it("grant on sibling resource does not grant access to another sibling", async () => {
                const read = await rbac.createPermission(ctx, systemSec, { key: "file.read" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "Reader",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: read.iri,
                });

                const folderA = await rbac.createResource(ctx, systemSec, {
                    resourceType: "folder",
                });
                const folderB = await rbac.createResource(ctx, systemSec, {
                    resourceType: "folder",
                });

                await rbac.grant(ctx, systemSec, {
                    principalIri: ALICE,
                    roleIri: role.iri,
                    scopeIri: folderA.iri,
                });

                expect(
                    await rbac.can(ctx, secFor(ALICE), {
                        permission: "file.read",
                        scope: folderA.iri,
                    }),
                ).toBe(true);
                expect(
                    await rbac.can(ctx, secFor(ALICE), {
                        permission: "file.read",
                        scope: folderB.iri,
                    }),
                ).toBe(false);
            });

            it("resolvePermissions returns correct set for a scoped principal", async () => {
                const read = await rbac.createPermission(ctx, systemSec, { key: "doc.read" });
                const write = await rbac.createPermission(ctx, systemSec, { key: "doc.write" });

                const viewerRole = await rbac.createRole(ctx, systemSec, {
                    roleName: "Viewer",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: viewerRole.iri,
                    permissionIri: read.iri,
                });

                const editorRole = await rbac.createRole(ctx, systemSec, {
                    roleName: "Editor",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: editorRole.iri,
                    permissionIri: write.iri,
                });

                const resource = await rbac.createResource(ctx, systemSec, { resourceType: "doc" });

                // Viewer grant system-wide; editor grant scoped to resource
                await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: viewerRole.iri });
                await rbac.grant(ctx, systemSec, {
                    principalIri: ALICE,
                    roleIri: editorRole.iri,
                    scopeIri: resource.iri,
                });

                const perms = await rbac.resolvePermissions(ctx, secFor(ALICE), {
                    scope: resource.iri,
                });
                expect(perms.has("doc.read")).toBe(true);
                expect(perms.has("doc.write")).toBe(true);
                expect(perms.has("doc.delete")).toBe(false);
            });
        });

        // ── Superusers (system wildcard) ──────────────────────────────────────

        describe("superusers (wildcard)", () => {
            it("member of superusers group can do anything", async () => {
                await rbac.addMember(ctx, systemSec, {
                    groupIri: SYS_SUPERUSERS_IRI,
                    memberIri: ALICE,
                });

                expect(await rbac.can(ctx, secFor(ALICE), { permission: "any.permission" })).toBe(
                    true,
                );
                expect(await rbac.can(ctx, secFor(ALICE), { permission: "billing.delete" })).toBe(
                    true,
                );
                expect(await rbac.can(ctx, secFor(ALICE), { permission: "system.destroy" })).toBe(
                    true,
                );
            });

            it("non-superuser does not get wildcard", async () => {
                expect(await rbac.can(ctx, secFor(BOB), { permission: "any.permission" })).toBe(
                    false,
                );
            });

            it("wildcard via resolvePermissions contains '*'", async () => {
                await rbac.addMember(ctx, systemSec, {
                    groupIri: SYS_SUPERUSERS_IRI,
                    memberIri: ALICE,
                });
                const perms = await rbac.resolvePermissions(ctx, secFor(ALICE), {});
                expect(perms.has("*")).toBe(true);
            });
        });

        // ── Impersonation ─────────────────────────────────────────────────────

        describe("impersonation", () => {
            it("principal with actsFor can impersonate target and use their permissions", async () => {
                // Alice is the admin; agent service account will impersonate her
                const manage = await rbac.createPermission(ctx, systemSec, { key: "user.manage" });
                const adminRole = await rbac.createRole(ctx, systemSec, {
                    roleName: "Admin",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: adminRole.iri,
                    permissionIri: manage.iri,
                });
                await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: adminRole.iri });

                const agent = await rbac.createServiceAccount(ctx, systemSec, {
                    serviceAccountName: "agent",
                    serviceAccountToken: "token-abc",
                    tenantId: null,
                });
                await rbac.allowImpersonation(ctx, systemSec, { fromIri: agent.iri, toIri: ALICE });

                // Agent has no permissions itself, but can act as Alice
                expect(await rbac.can(ctx, secFor(agent.iri), { permission: "user.manage" })).toBe(
                    false,
                );
                expect(
                    await rbac.can(ctx, secActingAs(agent.iri, ALICE), {
                        permission: "user.manage",
                    }),
                ).toBe(true);
            });

            it("principal without actsFor cannot impersonate", async () => {
                const manage = await rbac.createPermission(ctx, systemSec, { key: "user.manage" });
                const adminRole = await rbac.createRole(ctx, systemSec, {
                    roleName: "Admin",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: adminRole.iri,
                    permissionIri: manage.iri,
                });
                await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: adminRole.iri });

                // BOB has no actsFor Alice
                expect(
                    await rbac.can(ctx, secActingAs(BOB, ALICE), { permission: "user.manage" }),
                ).toBe(false);
            });

            it("revoking actsFor removes impersonation", async () => {
                const perm = await rbac.createPermission(ctx, systemSec, { key: "secret.read" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "SecretReader",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: perm.iri,
                });
                await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: role.iri });

                const agent = await rbac.createServiceAccount(ctx, systemSec, {
                    serviceAccountName: "agent",
                    serviceAccountToken: "tok",
                    tenantId: null,
                });
                await rbac.allowImpersonation(ctx, systemSec, { fromIri: agent.iri, toIri: ALICE });
                expect(
                    await rbac.can(ctx, secActingAs(agent.iri, ALICE), {
                        permission: "secret.read",
                    }),
                ).toBe(true);

                await rbac.revokeImpersonation(ctx, systemSec, {
                    fromIri: agent.iri,
                    toIri: ALICE,
                });
                expect(
                    await rbac.can(ctx, secActingAs(agent.iri, ALICE), {
                        permission: "secret.read",
                    }),
                ).toBe(false);
            });
        });

        // ── Service accounts ──────────────────────────────────────────────────

        describe("service accounts", () => {
            it("service account can be granted a role directly", async () => {
                const read = await rbac.createPermission(ctx, systemSec, { key: "api.read" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "APIReader",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: read.iri,
                });

                const sa = await rbac.createServiceAccount(ctx, systemSec, {
                    serviceAccountName: "data-sync",
                    serviceAccountToken: "sync-token",
                    tenantId: null,
                });
                await rbac.grant(ctx, systemSec, { principalIri: sa.iri, roleIri: role.iri });

                expect(await rbac.can(ctx, secFor(sa.iri), { permission: "api.read" })).toBe(true);
            });

            it("service account can be a member of a group", async () => {
                const write = await rbac.createPermission(ctx, systemSec, { key: "data.write" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "DataWriter",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: write.iri,
                });
                const group = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Writers",
                    tenantId: null,
                });
                await rbac.grant(ctx, systemSec, { principalIri: group.iri, roleIri: role.iri });

                const sa = await rbac.createServiceAccount(ctx, systemSec, {
                    serviceAccountName: "writer-bot",
                    serviceAccountToken: "tok",
                    tenantId: null,
                });
                await rbac.addMember(ctx, systemSec, { groupIri: group.iri, memberIri: sa.iri });

                expect(await rbac.can(ctx, secFor(sa.iri), { permission: "data.write" })).toBe(
                    true,
                );
            });
        });

        // ── Tenant isolation ──────────────────────────────────────────────────

        describe("tenant isolation", () => {
            it("grant scoped to tenant A does not apply in tenant B", async () => {
                const read = await rbac.createPermission(ctx, systemSec, { key: "project.read" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "Reader",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: read.iri,
                });

                const acme = await rbac.createTenant(ctx, systemSec, { name: "Acme Corp" });
                const globex = await rbac.createTenant(ctx, systemSec, { name: "Globex Corp" });

                const acmeProject = await rbac.createResource(ctx, systemSec, {
                    resourceType: "project",
                    tenantId: acme.id,
                });
                const globexProject = await rbac.createResource(ctx, systemSec, {
                    resourceType: "project",
                    tenantId: globex.id,
                });

                // Grant Alice only in Acme's project
                await rbac.grant(ctx, systemSec, {
                    principalIri: ALICE,
                    roleIri: role.iri,
                    scopeIri: acmeProject.iri,
                });

                expect(
                    await rbac.can(ctx, secFor(ALICE), {
                        permission: "project.read",
                        scope: acmeProject.iri,
                    }),
                ).toBe(true);
                expect(
                    await rbac.can(ctx, secFor(ALICE), {
                        permission: "project.read",
                        scope: globexProject.iri,
                    }),
                ).toBe(false);
            });

            it("Dave (Globex user) cannot access Acme resources", async () => {
                const read = await rbac.createPermission(ctx, systemSec, { key: "project.read" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "Reader",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: read.iri,
                });

                const acme = await rbac.createTenant(ctx, systemSec, { name: "Acme Corp" });
                const acmeProject = await rbac.createResource(ctx, systemSec, {
                    resourceType: "project",
                    tenantId: acme.id,
                });

                // Only Alice is granted in Acme
                await rbac.grant(ctx, systemSec, {
                    principalIri: ALICE,
                    roleIri: role.iri,
                    scopeIri: acmeProject.iri,
                });

                expect(
                    await rbac.can(ctx, secFor(DAVE), {
                        permission: "project.read",
                        scope: acmeProject.iri,
                    }),
                ).toBe(false);
            });
        });

        // ── Direct permission grants ──────────────────────────────────────────

        describe("direct permission grants (no role)", () => {
            it("principal can be granted a permission directly without a role", async () => {
                const perm = await rbac.createPermission(ctx, systemSec, { key: "special.action" });
                await rbac.grant(ctx, systemSec, { principalIri: ALICE, permissionIri: perm.iri });

                expect(await rbac.can(ctx, secFor(ALICE), { permission: "special.action" })).toBe(
                    true,
                );
            });
        });

        // ── Delegation chain ──────────────────────────────────────────────────

        describe("delegation chain", () => {
            it("delegatedFrom tracks the originating grant", async () => {
                const perm = await rbac.createPermission(ctx, systemSec, { key: "resource.edit" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "Editor",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: perm.iri,
                });

                const source = await rbac.grant(ctx, systemSec, {
                    principalIri: ALICE,
                    roleIri: role.iri,
                });
                const delegated = await rbac.grant(ctx, systemSec, {
                    principalIri: BOB,
                    roleIri: role.iri,
                    grantedByIri: ALICE,
                    delegatedFromIri: source.iri,
                });

                expect(delegated.delegatedFrom?.iri).toBe(source.iri);
                expect(delegated.grantedBy?.iri).toBe(ALICE);
                expect(await rbac.can(ctx, secFor(BOB), { permission: "resource.edit" })).toBe(
                    true,
                );
            });
        });

        // ── RbacService façade ────────────────────────────────────────────────

        describe("RbacService façade", () => {
            it("assert() resolves when principal is allowed", async () => {
                const perm = await rbac.createPermission(ctx, systemSec, { key: "docs.read" });
                const role = await rbac.createRole(ctx, systemSec, {
                    roleName: "Viewer",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: perm.iri,
                });
                await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: role.iri });

                await expect(
                    rbac.assert(ctx, secFor(ALICE), { permission: "docs.read" }),
                ).resolves.toBeUndefined();
            });

            it("assert() throws when principal is denied", async () => {
                await expect(
                    rbac.assert(ctx, secFor(BOB), { permission: "docs.read" }),
                ).rejects.toThrow(/Access denied/);
            });

            it("assert() error message names the principal and permission", async () => {
                const err = await rbac
                    .assert(ctx, secFor(BOB), { permission: "billing.write" })
                    .catch((e: Error) => e);
                expect((err as Error).message).toContain("billing.write");
                expect((err as Error).message).toContain(BOB);
            });

            it("can() never throws — returns false on denial", async () => {
                await expect(
                    rbac.can(ctx, secFor("http://nobody"), { permission: "anything" }),
                ).resolves.toBe(false);
            });
        });

        // ── AccessChecker standalone ──────────────────────────────────────────

        describe("AccessChecker standalone", () => {
            it("can be used directly without RbacService", async () => {
                const grants = new PolicyGrantRepository(store);
                const permissions = new PermissionRepository(store);
                const roles = new RoleRepository(store);
                const checker = new AccessChecker(store, grants);

                const perm = await permissions.create(ctx, systemSec, {
                    permissionKey: "raw.check",
                });
                const role = await roles.create(ctx, systemSec, {
                    roleName: "Raw",
                    tenantId: null,
                });
                await roles.addPermission(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: perm.iri,
                });
                await grants.create(ctx, systemSec, { principalIri: ALICE, roleIri: role.iri });

                const result = await checker.check(ctx, {
                    principal: ALICE,
                    permission: "raw.check",
                });
                expect(result).toBe(true);
            });
        });

        // ── Full real-world scenario: Acme project collaboration ─────────────

        describe("full scenario: Acme project collaboration", () => {
            it("complete multi-user, multi-role, scoped access scenario", async () => {
                // ── Permissions ───────────────────────────────────────────────
                const projRead = await rbac.createPermission(ctx, systemSec, {
                    key: "project.read",
                });
                const projWrite = await rbac.createPermission(ctx, systemSec, {
                    key: "project.write",
                });
                const projDelete = await rbac.createPermission(ctx, systemSec, {
                    key: "project.delete",
                });
                const userManage = await rbac.createPermission(ctx, systemSec, {
                    key: "user.manage",
                });

                // ── Roles (with inheritance) ───────────────────────────────────
                const viewerRole = await rbac.createRole(ctx, systemSec, {
                    roleName: "Viewer",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: viewerRole.iri,
                    permissionIri: projRead.iri,
                });

                const editorRole = await rbac.createRole(ctx, systemSec, {
                    roleName: "Editor",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: editorRole.iri,
                    permissionIri: projWrite.iri,
                });
                await rbac.addRoleInheritance(ctx, systemSec, {
                    childRoleIri: editorRole.iri,
                    parentRoleIri: viewerRole.iri,
                });

                const ownerRole = await rbac.createRole(ctx, systemSec, {
                    roleName: "Owner",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: ownerRole.iri,
                    permissionIri: projDelete.iri,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: ownerRole.iri,
                    permissionIri: userManage.iri,
                });
                await rbac.addRoleInheritance(ctx, systemSec, {
                    childRoleIri: ownerRole.iri,
                    parentRoleIri: editorRole.iri,
                });

                // ── Groups ────────────────────────────────────────────────────
                const acme = await rbac.createTenant(ctx, systemSec, { name: "Acme Corp" });
                const owners = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Owners",
                    tenantId: acme.id,
                });
                const editors = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Editors",
                    tenantId: acme.id,
                });
                const viewers = await rbac.createUserGroup(ctx, systemSec, {
                    groupName: "Viewers",
                    tenantId: acme.id,
                });

                // ── Grant roles to groups ─────────────────────────────────────
                await rbac.grant(ctx, systemSec, {
                    principalIri: owners.iri,
                    roleIri: ownerRole.iri,
                });
                await rbac.grant(ctx, systemSec, {
                    principalIri: editors.iri,
                    roleIri: editorRole.iri,
                });
                await rbac.grant(ctx, systemSec, {
                    principalIri: viewers.iri,
                    roleIri: viewerRole.iri,
                });

                // ── Assign principals to groups ───────────────────────────────
                await rbac.addMember(ctx, systemSec, { groupIri: owners.iri, memberIri: ALICE });
                await rbac.addMember(ctx, systemSec, { groupIri: editors.iri, memberIri: BOB });
                await rbac.addMember(ctx, systemSec, { groupIri: viewers.iri, memberIri: CHARLIE });

                // ── Resources ─────────────────────────────────────────────────
                const project = await rbac.createResource(ctx, systemSec, {
                    resourceType: "project",
                    tenantId: acme.id,
                });
                const subfolder = await rbac.createResource(ctx, systemSec, {
                    resourceType: "folder",
                    parentIri: project.iri,
                });

                // ── Assertions ────────────────────────────────────────────────

                // Alice (owner) can do everything on both project and subfolder
                expect(await rbac.can(ctx, secFor(ALICE), { permission: "project.read" })).toBe(
                    true,
                );
                expect(await rbac.can(ctx, secFor(ALICE), { permission: "project.write" })).toBe(
                    true,
                );
                expect(await rbac.can(ctx, secFor(ALICE), { permission: "project.delete" })).toBe(
                    true,
                );
                expect(await rbac.can(ctx, secFor(ALICE), { permission: "user.manage" })).toBe(
                    true,
                );

                // Bob (editor) can read and write but not delete
                expect(await rbac.can(ctx, secFor(BOB), { permission: "project.read" })).toBe(true);
                expect(await rbac.can(ctx, secFor(BOB), { permission: "project.write" })).toBe(
                    true,
                );
                expect(await rbac.can(ctx, secFor(BOB), { permission: "project.delete" })).toBe(
                    false,
                );
                expect(await rbac.can(ctx, secFor(BOB), { permission: "user.manage" })).toBe(false);

                // Charlie (viewer) can only read
                expect(await rbac.can(ctx, secFor(CHARLIE), { permission: "project.read" })).toBe(
                    true,
                );
                expect(await rbac.can(ctx, secFor(CHARLIE), { permission: "project.write" })).toBe(
                    false,
                );

                // Dave (different tenant) can do nothing
                expect(await rbac.can(ctx, secFor(DAVE), { permission: "project.read" })).toBe(
                    false,
                );

                // Scope chain: grants apply transitively to the subfolder
                await rbac.grant(ctx, systemSec, {
                    principalIri: owners.iri,
                    roleIri: ownerRole.iri,
                    scopeIri: project.iri,
                });
                expect(
                    await rbac.can(ctx, secFor(ALICE), {
                        permission: "project.read",
                        scope: subfolder.iri,
                    }),
                ).toBe(true);

                // Charlie is denied billing even though unrelated role gave it
                const billingRead = await rbac.createPermission(ctx, systemSec, {
                    key: "billing.read",
                });
                const billingRole = await rbac.createRole(ctx, systemSec, {
                    roleName: "BillingViewer",
                    tenantId: null,
                });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: billingRole.iri,
                    permissionIri: billingRead.iri,
                });
                await rbac.grant(ctx, systemSec, {
                    principalIri: viewers.iri,
                    roleIri: billingRole.iri,
                });
                await rbac.grant(ctx, systemSec, {
                    principalIri: CHARLIE,
                    roleIri: billingRole.iri,
                    isDenial: true,
                });

                expect(await rbac.can(ctx, secFor(CHARLIE), { permission: "billing.read" })).toBe(
                    false,
                );
                expect(await rbac.can(ctx, secFor(BOB), { permission: "billing.read" })).toBe(
                    false,
                ); // not in viewers

                // Temporary access for Charlie to write on the project
                const tempExpiry = new Date(Date.now() + 60_000);
                await rbac.grant(ctx, systemSec, {
                    principalIri: CHARLIE,
                    roleIri: editorRole.iri,
                    scopeIri: project.iri,
                    grantExpiresAt: tempExpiry,
                });
                expect(
                    await rbac.can(ctx, secFor(CHARLIE), {
                        permission: "project.write",
                        scope: project.iri,
                    }),
                ).toBe(true);
                expect(await rbac.can(ctx, secFor(CHARLIE), { permission: "project.write" })).toBe(
                    false,
                ); // no scope = denied
            });
        });

        // ── Admin enforcement (TRN-206) ─────────────────────────────────────────
        //
        // RbacService admin methods now require RBAC_ADMIN_PERMISSION. A member of
        // the seeded superusers group holds the wildcard "*" and so passes; a plain
        // principal with no grants is denied. `systemSec` bypasses the checker and
        // is used everywhere above to set up fixtures, so those suites stay green.

        describe("admin enforcement (TRN-206)", () => {
            async function makeAdmin(principalIri: string): Promise<void> {
                await rbac.addMember(ctx, systemSec, {
                    groupIri: SYS_SUPERUSERS_IRI,
                    memberIri: principalIri,
                });
            }

            it("non-admin is denied createRole", async () => {
                await expect(
                    rbac.createRole(ctx, secFor(BOB), { roleName: "Sneaky" }),
                ).rejects.toThrow(/Access denied/);
            });

            it("admin (superuser) is allowed createRole", async () => {
                await makeAdmin(ALICE);
                const role = await rbac.createRole(ctx, secFor(ALICE), { roleName: "Editors" });
                expect(role.iri).toBeTruthy();
            });

            it("non-admin is denied grant", async () => {
                const role = await rbac.createRole(ctx, systemSec, { roleName: "R" });
                await expect(
                    rbac.grant(ctx, secFor(BOB), { principalIri: CHARLIE, roleIri: role.iri }),
                ).rejects.toThrow(/Access denied/);
            });

            it("admin is allowed grant", async () => {
                await makeAdmin(ALICE);
                const role = await rbac.createRole(ctx, systemSec, { roleName: "R" });
                const g = await rbac.grant(ctx, secFor(ALICE), {
                    principalIri: CHARLIE,
                    roleIri: role.iri,
                });
                expect(g.iri).toBeTruthy();
            });

            it("non-admin is denied addMember", async () => {
                const group = await rbac.createUserGroup(ctx, systemSec, { groupName: "G" });
                await expect(
                    rbac.addMember(ctx, secFor(BOB), {
                        groupIri: group.iri,
                        memberIri: CHARLIE,
                    }),
                ).rejects.toThrow(/Access denied/);
            });

            it("admin is allowed addMember", async () => {
                await makeAdmin(ALICE);
                const group = await rbac.createUserGroup(ctx, systemSec, { groupName: "G" });
                await rbac.addMember(ctx, secFor(ALICE), {
                    groupIri: group.iri,
                    memberIri: CHARLIE,
                });
                const members = await rbac.listMembers(ctx, systemSec, { groupIri: group.iri });
                expect(members).toContain(CHARLIE);
            });

            it("non-admin is denied createUserGroup and createPermission", async () => {
                await expect(
                    rbac.createUserGroup(ctx, secFor(BOB), { groupName: "Nope" }),
                ).rejects.toThrow(/Access denied/);
                await expect(
                    rbac.createPermission(ctx, secFor(BOB), { key: "nope.read" }),
                ).rejects.toThrow(/Access denied/);
            });

            it("anonymous principal is denied admin mutations", async () => {
                await expect(
                    rbac.createRole(ctx, secFor(""), { roleName: "Anon" }),
                ).rejects.toThrow(/Access denied/);
            });

            it("inspector introspection is admin-gated", async () => {
                const inspector = rbac.inspector();
                await expect(
                    inspector.listEffectivePermissions(ctx, secFor(BOB), {
                        principalIri: CHARLIE,
                    }),
                ).rejects.toThrow(/Access denied/);

                await makeAdmin(ALICE);
                const perms = await inspector.listEffectivePermissions(ctx, secFor(ALICE), {
                    principalIri: ALICE,
                });
                expect(perms.has("*")).toBe(true);
            });
        });
    });
}

// ── Migration down() ──────────────────────────────────────────────────────────

describe("migration 001_init down()", () => {
    it("drops all tables and data; up() restores a working system", async () => {
        const { up, down } = await import("../../../data/src/migrations/001_init.js");

        const { default: Knex } = await import("knex");
        const knex = Knex({
            client: "better-sqlite3",
            connection: { filename: ":memory:" },
            useNullAsDefault: true,
            pool: { min: 1, max: 1 },
        });

        await up(knex);

        // Verify tables exist before down()
        await expect(knex("edges").count()).resolves.toBeDefined();

        // down() drops all tables
        await down(knex);
        await expect(knex("edges").count()).rejects.toThrow();

        // up() rebuilds everything from scratch
        await expect(up(knex)).resolves.toBeUndefined();
        await expect(knex("edges").count()).resolves.toBeDefined();

        // RBAC is functional again after restore
        const store = new TripleStore(knex);
        const grants = new PolicyGrantRepository(store);
        const checker = new AccessChecker(store, grants);
        const allowed = await checker.check(buildServerContext(store), {
            principal: ALICE,
            permission: "anything",
        });
        expect(allowed).toBe(false); // ALICE not in superusers — correctly denied

        await knex.destroy();
    });
});
