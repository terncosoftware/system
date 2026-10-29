/**
 * Convos integration tests.
 *
 * Runs against both SQLite (always) and Postgres (when SYS_PG_URL is set),
 * each operation inside a rolled-back transaction for clean isolation.
 *
 * Suites:
 *   ConversationRepository  — CRUD, subject/inbox queries, status/assignment
 *   MessageRepository       — create, edit (revisions), soft-delete, threading
 *   ParticipantRepository   — add, remove, role change, idempotent add
 *   DraftRepository         — save, update, delete, find by author
 *   InboxRepository         — create, membership, find by subject
 *   NotificationRepository  — create, read, dismiss, fan-out, unread count,
 *                             templateKey + payload storage, findByTemplateKey
 *   ReadReceiptRepository   — upsert watermark, find by user+conversation
 *   ConvoService (no RBAC)  — orchestrated happy-path scenarios
 *   ConvoService + RBAC     — permission grant/deny per operation
 *   installConvos           — seeds permissions and roles
 *   NotificationService     — one-time, resettable, window dedupe; payload;
 *                             sendToMany; history; NPM-consumer example
 */

import {
    ConversationRepository,
    ConvoService,
    DraftRepository,
    InboxRepository,
    installConvos,
    MessageRepository,
    NotificationRepository,
    NotificationService,
    ParticipantRepository,
    PERM_CONVO_CLOSE,
    PERM_CONVO_CREATE,
    PERM_CONVO_READ,
    PERM_INBOX_CREATE,
    PERM_MESSAGE_EDIT_ANY,
    PERM_MESSAGE_EDIT_OWN,
    PERM_MESSAGE_POST,
    ReadReceiptRepository,
    uninstallConvos,
} from "@terncosoftware/convos";
import { TripleStore } from "@terncosoftware/data";
import {
    buildServerContext,
    PermissionRepository,
    PolicyGrantRepository,
    RbacService,
    ResourceNodeRepository,
    RoleRepository,
    type SecurityContext,
    type ServerContext,
    ServiceAccountRepository,
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

// ── Synthetic IRIs ────────────────────────────────────────────────────────────

const ALICE = "urn:sys:core:auth:user:alice";
const BOB = "urn:sys:core:auth:user:bob";
const CHARLIE = "urn:sys:core:auth:user:charlie";

const CONTRACT_IRI = "urn:sys:ext:crm:contract:c001";
const USER_SUBJECT_IRI = "urn:sys:core:auth:user:alice";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRepos(store: TripleStore) {
    return {
        conversations: new ConversationRepository(store),
        messages: new MessageRepository(store),
        participants: new ParticipantRepository(store),
        drafts: new DraftRepository(store),
        inboxes: new InboxRepository(store),
        notifications: new NotificationRepository(store),
        receipts: new ReadReceiptRepository(store),
    };
}

function makeService(store: TripleStore): ConvoService {
    return new ConvoService(makeRepos(store));
}

function makeRbacService(store: TripleStore): RbacService {
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

function makeServiceWithRbac(store: TripleStore, rbac: RbacService): ConvoService {
    return new ConvoService({ ...makeRepos(store), rbac });
}

// ═════════════════════════════════════════════════════════════════════════════

function secFor(principalIri: string): SecurityContext {
    return { principalIri, sessionId: null, isImpersonating: false };
}

for (const provider of providers) {
    // ── ConversationRepository ────────────────────────────────────────────────

    describe(`ConversationRepository — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let repo: ConversationRepository;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            ctx = buildServerContext(store, { trx });
            store = new TripleStore(knex);
            repo = new ConversationRepository(store);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("creates a conversation and retrieves it by id", async () => {
            const c = await repo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "Q4 review",
                createdBy: ALICE,
            });
            expect(c.title).toBe("Q4 review");
            expect(c.subjectIri).toBe(CONTRACT_IRI);
            expect(c.status).toBe("open");
            expect(c.createdBy).toBe(ALICE);
            expect(c.inboxId).toBeNull();
            expect(c.assignedTo).toBeNull();
            expect((await repo.findById(ctx, systemSec, { id: c.id }))?.title).toBe("Q4 review");
        });

        it("stores the IRI under the convos namespace", async () => {
            const c = await repo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            expect(c.iri).toContain("urn:sys:ext:convos:conversation:");
            expect(c.iri).toContain(c.id);
        });

        it("returns null for unknown id", async () => {
            expect(await repo.findById(ctx, systemSec, { id: "ghost-id" })).toBeNull();
        });

        it("finds conversations by subject IRI", async () => {
            await repo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "A",
                createdBy: ALICE,
            });
            await repo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "B",
                createdBy: BOB,
            });
            await repo.create(ctx, systemSec, {
                subjectIri: "http://other.iri",
                title: "C",
                createdBy: ALICE,
            });
            const found = await repo.findBySubject(ctx, systemSec, { subjectIri: CONTRACT_IRI });
            expect(found).toHaveLength(2);
            expect(found.map((c) => c.title)).toEqual(expect.arrayContaining(["A", "B"]));
        });

        it("findBySubject returns empty when no conversations exist", async () => {
            expect(
                await repo.findBySubject(ctx, systemSec, { subjectIri: "http://nothing.test" }),
            ).toHaveLength(0);
        });

        it("updates status", async () => {
            const c = await repo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            const updated = await repo.updateStatus(ctx, systemSec, { id: c.id, status: "closed" });
            expect(updated?.status).toBe("closed");
            expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(c.updatedAt.getTime());
        });

        it("updateStatus returns null for unknown id", async () => {
            expect(
                await repo.updateStatus(ctx, systemSec, { id: "ghost", status: "closed" }),
            ).toBeNull();
        });

        it("updates assignment and clears it", async () => {
            const c = await repo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            expect(
                (await repo.updateAssignment(ctx, systemSec, { id: c.id, assignedTo: BOB }))
                    ?.assignedTo,
            ).toBe(BOB);
            expect(
                (await repo.updateAssignment(ctx, systemSec, { id: c.id, assignedTo: null }))
                    ?.assignedTo,
            ).toBeNull();
        });

        it("creates with optional inboxId and assignedTo", async () => {
            const c = await repo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
                inboxId: "inbox-id",
                assignedTo: BOB,
            });
            expect(c.inboxId).toBe("inbox-id");
            expect(c.assignedTo).toBe(BOB);
        });

        it("deletes a conversation", async () => {
            const c = await repo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            await repo.delete(ctx, systemSec, { id: c.id });
            expect(await repo.findById(ctx, systemSec, { id: c.id })).toBeNull();
        });
    });

    // ── MessageRepository ─────────────────────────────────────────────────────

    describe(`MessageRepository — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let convRepo: ConversationRepository;
        let msgRepo: MessageRepository;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            ctx = buildServerContext(store, { trx });
            store = new TripleStore(knex);
            convRepo = new ConversationRepository(store);
            msgRepo = new MessageRepository(store);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("posts and retrieves a message", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            const m = await msgRepo.create(ctx, systemSec, {
                conversationId: c.id,
                authorId: ALICE,
                content: "Hello world",
                contentType: "text/markdown",
            });
            expect(m.content).toBe("Hello world");
            expect(m.isDeleted).toBe(false);
            expect(m.revisionCount).toBe(0);
            expect(m.replyToId).toBeNull();
            expect((await msgRepo.findById(ctx, systemSec, { id: m.id }))?.content).toBe(
                "Hello world",
            );
        });

        it("lists messages sorted by creation time", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            await msgRepo.create(ctx, systemSec, {
                conversationId: c.id,
                authorId: ALICE,
                content: "first",
                contentType: "text/markdown",
            });
            await msgRepo.create(ctx, systemSec, {
                conversationId: c.id,
                authorId: BOB,
                content: "second",
                contentType: "text/markdown",
            });
            const msgs = await msgRepo.findByConversation(ctx, systemSec, { conversationId: c.id });
            expect(msgs).toHaveLength(2);
            expect(msgs[0].content).toBe("first");
            expect(msgs[1].content).toBe("second");
        });

        it("does not return participants as messages", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            const partRepo = new ParticipantRepository(store);
            await partRepo.create(ctx, systemSec, {
                conversationId: c.id,
                userId: ALICE,
                role: "owner",
            });
            await msgRepo.create(ctx, systemSec, {
                conversationId: c.id,
                authorId: ALICE,
                content: "msg",
                contentType: "text/markdown",
            });
            const msgs = await msgRepo.findByConversation(ctx, systemSec, { conversationId: c.id });
            expect(msgs).toHaveLength(1);
            expect(msgs[0].content).toBe("msg");
        });

        it("supports threaded replies via replyToId", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            const parent = await msgRepo.create(ctx, systemSec, {
                conversationId: c.id,
                authorId: ALICE,
                content: "parent",
                contentType: "text/markdown",
            });
            const reply = await msgRepo.create(ctx, systemSec, {
                conversationId: c.id,
                authorId: BOB,
                content: "reply",
                contentType: "text/markdown",
                replyToId: parent.id,
            });
            expect(reply.replyToId).toBe(parent.id);
        });

        it("edit saves a revision snapshot and updates content + revisionCount", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            const m = await msgRepo.create(ctx, systemSec, {
                conversationId: c.id,
                authorId: ALICE,
                content: "original",
                contentType: "text/markdown",
            });
            const result = await msgRepo.edit(ctx, systemSec, {
                id: m.id,
                newContent: "updated",
                editorId: ALICE,
            });
            expect(result?.message.content).toBe("updated");
            expect(result?.message.revisionCount).toBe(1);
            expect(result?.revision.content).toBe("original");
            expect(result?.revision.revision).toBe(0);
        });

        it("edit returns null for unknown or deleted message", async () => {
            expect(
                await msgRepo.edit(ctx, systemSec, {
                    id: "ghost",
                    newContent: "x",
                    editorId: ALICE,
                }),
            ).toBeNull();
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            const m = await msgRepo.create(ctx, systemSec, {
                conversationId: c.id,
                authorId: ALICE,
                content: "bye",
                contentType: "text/markdown",
            });
            await msgRepo.softDelete(ctx, systemSec, { id: m.id });
            expect(
                await msgRepo.edit(ctx, systemSec, { id: m.id, newContent: "x", editorId: ALICE }),
            ).toBeNull();
        });

        it("findRevisionsForMessage returns ordered edit history", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            const m = await msgRepo.create(ctx, systemSec, {
                conversationId: c.id,
                authorId: ALICE,
                content: "v0",
                contentType: "text/markdown",
            });
            await msgRepo.edit(ctx, systemSec, { id: m.id, newContent: "v1", editorId: ALICE });
            await msgRepo.edit(ctx, systemSec, { id: m.id, newContent: "v2", editorId: ALICE });
            const revs = await msgRepo.findRevisionsForMessage(ctx, systemSec, { messageId: m.id });
            expect(revs).toHaveLength(2);
            expect(revs[0].content).toBe("v0");
            expect(revs[1].content).toBe("v1");
        });

        it("softDelete marks the message deleted", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            const m = await msgRepo.create(ctx, systemSec, {
                conversationId: c.id,
                authorId: ALICE,
                content: "bye",
                contentType: "text/markdown",
            });
            expect((await msgRepo.softDelete(ctx, systemSec, { id: m.id }))?.isDeleted).toBe(true);
            expect(await msgRepo.softDelete(ctx, systemSec, { id: "ghost" })).toBeNull();
        });
    });

    // ── ParticipantRepository ─────────────────────────────────────────────────

    describe(`ParticipantRepository — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let convRepo: ConversationRepository;
        let partRepo: ParticipantRepository;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            ctx = buildServerContext(store, { trx });
            store = new TripleStore(knex);
            convRepo = new ConversationRepository(store);
            partRepo = new ParticipantRepository(store);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("adds a participant and retrieves by conversation", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            const p = await partRepo.create(ctx, systemSec, {
                conversationId: c.id,
                userId: ALICE,
                role: "owner",
            });
            expect(p.userId).toBe(ALICE);
            expect(p.role).toBe("owner");
            expect(
                await partRepo.findByConversation(ctx, systemSec, { conversationId: c.id }),
            ).toHaveLength(1);
        });

        it("create is idempotent", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            const p1 = await partRepo.create(ctx, systemSec, {
                conversationId: c.id,
                userId: ALICE,
                role: "owner",
            });
            const p2 = await partRepo.create(ctx, systemSec, {
                conversationId: c.id,
                userId: ALICE,
                role: "member",
            });
            expect(p1.id).toBe(p2.id);
        });

        it("findByConversationAndUser returns null for non-participant", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            await partRepo.create(ctx, systemSec, {
                conversationId: c.id,
                userId: BOB,
                role: "member",
            });
            expect(
                (
                    await partRepo.findByConversationAndUser(ctx, systemSec, {
                        conversationId: c.id,
                        userId: BOB,
                    })
                )?.userId,
            ).toBe(BOB);
            expect(
                await partRepo.findByConversationAndUser(ctx, systemSec, {
                    conversationId: c.id,
                    userId: CHARLIE,
                }),
            ).toBeNull();
        });

        it("updateRole changes the role", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            const p = await partRepo.create(ctx, systemSec, {
                conversationId: c.id,
                userId: BOB,
                role: "member",
            });
            expect(
                (await partRepo.updateRole(ctx, systemSec, { id: p.id, newRole: "viewer" }))?.role,
            ).toBe("viewer");
        });

        it("remove deletes the participant", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            const p = await partRepo.create(ctx, systemSec, {
                conversationId: c.id,
                userId: BOB,
                role: "member",
            });
            await partRepo.remove(ctx, systemSec, { id: p.id });
            expect(
                await partRepo.findByConversation(ctx, systemSec, { conversationId: c.id }),
            ).toHaveLength(0);
        });
    });

    // ── DraftRepository ───────────────────────────────────────────────────────

    describe(`DraftRepository — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let convRepo: ConversationRepository;
        let draftRepo: DraftRepository;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            ctx = buildServerContext(store, { trx });
            store = new TripleStore(knex);
            convRepo = new ConversationRepository(store);
            draftRepo = new DraftRepository(store);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("saves and retrieves a draft", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            const d = await draftRepo.create(ctx, systemSec, {
                conversationId: c.id,
                authorId: ALICE,
                content: "draft",
                contentType: "text/markdown",
            });
            expect(d.content).toBe("draft");
            expect(await draftRepo.findById(ctx, systemSec, { id: d.id })).not.toBeNull();
            expect(await draftRepo.findById(ctx, systemSec, { id: "ghost" })).toBeNull();
        });

        it("finds drafts by author, filtered by conversation", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            await draftRepo.create(ctx, systemSec, {
                conversationId: c.id,
                authorId: ALICE,
                content: "d1",
                contentType: "text/markdown",
            });
            await draftRepo.create(ctx, systemSec, {
                conversationId: c.id,
                authorId: BOB,
                content: "d2",
                contentType: "text/markdown",
            });
            expect(await draftRepo.findByAuthor(ctx, systemSec, { authorId: ALICE })).toHaveLength(
                1,
            );
            expect(
                await draftRepo.findByAuthorAndConversation(ctx, systemSec, {
                    authorId: ALICE,
                    conversationId: c.id,
                }),
            ).toHaveLength(1);
            expect(
                await draftRepo.findByAuthorAndConversation(ctx, systemSec, {
                    authorId: BOB,
                    conversationId: c.id,
                }),
            ).toHaveLength(1);
        });

        it("updates and deletes a draft", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            const d = await draftRepo.create(ctx, systemSec, {
                conversationId: c.id,
                authorId: ALICE,
                content: "old",
                contentType: "text/markdown",
            });
            expect(
                (await draftRepo.update(ctx, systemSec, { id: d.id, content: "new" }))?.content,
            ).toBe("new");
            expect(
                await draftRepo.update(ctx, systemSec, { id: "ghost", content: "x" }),
            ).toBeNull();
            await draftRepo.delete(ctx, systemSec, { id: d.id });
            expect(await draftRepo.findById(ctx, systemSec, { id: d.id })).toBeNull();
        });
    });

    // ── InboxRepository ───────────────────────────────────────────────────────

    describe(`InboxRepository — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let inboxRepo: InboxRepository;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            ctx = buildServerContext(store, { trx });
            store = new TripleStore(knex);
            inboxRepo = new InboxRepository(store);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("creates and retrieves an inbox", async () => {
            const inbox = await inboxRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                name: "Support",
                createdBy: ALICE,
            });
            expect(inbox.name).toBe("Support");
            expect((await inboxRepo.findById(ctx, systemSec, { id: inbox.id }))?.name).toBe(
                "Support",
            );
            expect(await inboxRepo.findById(ctx, systemSec, { id: "ghost" })).toBeNull();
        });

        it("finds inboxes by subject, skips unrelated subjects", async () => {
            await inboxRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                name: "A",
                createdBy: ALICE,
            });
            await inboxRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                name: "B",
                createdBy: ALICE,
            });
            await inboxRepo.create(ctx, systemSec, {
                subjectIri: "http://other",
                name: "C",
                createdBy: ALICE,
            });
            expect(
                await inboxRepo.findBySubject(ctx, systemSec, { subjectIri: CONTRACT_IRI }),
            ).toHaveLength(2);
        });

        it("adds and removes members idempotently", async () => {
            const inbox = await inboxRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                name: "Team",
                createdBy: ALICE,
            });
            await inboxRepo.addMember(ctx, systemSec, {
                inboxId: inbox.id,
                userId: ALICE,
                role: "owner",
            });
            await inboxRepo.addMember(ctx, systemSec, {
                inboxId: inbox.id,
                userId: BOB,
                role: "member",
            });
            const m1 = await inboxRepo.addMember(ctx, systemSec, {
                inboxId: inbox.id,
                userId: ALICE,
                role: "member",
            });
            const m2 = await inboxRepo.addMember(ctx, systemSec, {
                inboxId: inbox.id,
                userId: ALICE,
                role: "owner",
            });
            expect(m1.id).toBe(m2.id);
            expect(await inboxRepo.listMembers(ctx, systemSec, { inboxId: inbox.id })).toHaveLength(
                2,
            );
            await inboxRepo.removeMember(ctx, systemSec, { inboxId: inbox.id, userId: BOB });
            expect(await inboxRepo.listMembers(ctx, systemSec, { inboxId: inbox.id })).toHaveLength(
                1,
            );
        });

        it("listInboxesForUser returns all memberships", async () => {
            const a = await inboxRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                name: "A",
                createdBy: ALICE,
            });
            const b = await inboxRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                name: "B",
                createdBy: ALICE,
            });
            await inboxRepo.addMember(ctx, systemSec, {
                inboxId: a.id,
                userId: BOB,
                role: "member",
            });
            await inboxRepo.addMember(ctx, systemSec, {
                inboxId: b.id,
                userId: BOB,
                role: "viewer",
            });
            const mbs = await inboxRepo.listInboxesForUser(ctx, systemSec, { userId: BOB });
            expect(mbs.map((m) => m.inboxId)).toEqual(expect.arrayContaining([a.id, b.id]));
        });
    });

    // ── NotificationRepository ────────────────────────────────────────────────

    describe(`NotificationRepository — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let notifRepo: NotificationRepository;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            ctx = buildServerContext(store, { trx });
            store = new TripleStore(knex);
            notifRepo = new NotificationRepository(store);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("creates, retrieves, and marks read", async () => {
            const n = await notifRepo.create(ctx, systemSec, {
                userId: ALICE,
                notifType: "reply",
                sourceIri: "http://src/1",
            });
            expect(n.isRead).toBe(false);
            expect((await notifRepo.findById(ctx, systemSec, { id: n.id }))?.notifType).toBe(
                "reply",
            );
            expect(await notifRepo.findById(ctx, systemSec, { id: "ghost" })).toBeNull();
            expect((await notifRepo.markRead(ctx, systemSec, { id: n.id }))?.isRead).toBe(true);
            expect(await notifRepo.markRead(ctx, systemSec, { id: "ghost" })).toBeNull();
        });

        it("findByUser with unreadOnly filters read notifications", async () => {
            const n1 = await notifRepo.create(ctx, systemSec, {
                userId: ALICE,
                notifType: "reply",
                sourceIri: "s1",
            });
            await notifRepo.create(ctx, systemSec, {
                userId: ALICE,
                notifType: "mention",
                sourceIri: "s2",
            });
            await notifRepo.create(ctx, systemSec, {
                userId: BOB,
                notifType: "reply",
                sourceIri: "s3",
            });
            await notifRepo.markRead(ctx, systemSec, { id: n1.id });
            expect(await notifRepo.findByUser(ctx, systemSec, { userId: ALICE })).toHaveLength(2);
            expect(
                await notifRepo.findByUser(ctx, systemSec, { userId: ALICE, unreadOnly: true }),
            ).toHaveLength(1);
        });

        it("markAllReadForUser returns count and clears unread", async () => {
            await notifRepo.create(ctx, systemSec, {
                userId: ALICE,
                notifType: "reply",
                sourceIri: "s1",
            });
            await notifRepo.create(ctx, systemSec, {
                userId: ALICE,
                notifType: "reply",
                sourceIri: "s2",
            });
            expect(await notifRepo.markAllReadForUser(ctx, systemSec, { userId: ALICE })).toBe(2);
            expect(
                await notifRepo.findByUser(ctx, systemSec, { userId: ALICE, unreadOnly: true }),
            ).toHaveLength(0);
        });

        it("dismiss excludes from unread count", async () => {
            const n = await notifRepo.create(ctx, systemSec, {
                userId: ALICE,
                notifType: "reply",
                sourceIri: "s",
            });
            await notifRepo.dismiss(ctx, systemSec, { id: n.id });
            expect(await notifRepo.countUnread(ctx, systemSec, { userId: ALICE })).toBe(0);
        });

        it("countUnread counts only non-dismissed unread notifications", async () => {
            await notifRepo.create(ctx, systemSec, {
                userId: ALICE,
                notifType: "reply",
                sourceIri: "s1",
            });
            await notifRepo.create(ctx, systemSec, {
                userId: ALICE,
                notifType: "mention",
                sourceIri: "s2",
            });
            const n3 = await notifRepo.create(ctx, systemSec, {
                userId: ALICE,
                notifType: "reply",
                sourceIri: "s3",
            });
            await notifRepo.markRead(ctx, systemSec, { id: n3.id });
            expect(await notifRepo.countUnread(ctx, systemSec, { userId: ALICE })).toBe(2);
        });

        it("fanOut creates notifications for all except the excluded user", async () => {
            const created = await notifRepo.fanOut(ctx, systemSec, {
                recipientIds: [ALICE, BOB, CHARLIE],
                sourceIri: "http://src/msg",
                notifType: "reply",
                excludeUserId: ALICE,
            });
            expect(created).toHaveLength(2);
            expect(created.map((n) => n.userId)).toEqual(expect.arrayContaining([BOB, CHARLIE]));
        });
    });

    // ── ReadReceiptRepository ─────────────────────────────────────────────────

    describe(`ReadReceiptRepository — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let convRepo: ConversationRepository;
        let msgRepo: MessageRepository;
        let receiptRepo: ReadReceiptRepository;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            ctx = buildServerContext(store, { trx });
            store = new TripleStore(knex);
            convRepo = new ConversationRepository(store);
            msgRepo = new MessageRepository(store);
            receiptRepo = new ReadReceiptRepository(store);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("creates a read receipt for a user", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            const m = await msgRepo.create(ctx, systemSec, {
                conversationId: c.id,
                authorId: ALICE,
                content: "hello",
                contentType: "text/markdown",
            });
            const r = await receiptRepo.upsert(ctx, systemSec, {
                conversationId: c.id,
                userId: ALICE,
                lastReadMessageId: m.id,
            });
            expect(r.conversationId).toBe(c.id);
            expect(r.userId).toBe(ALICE);
            expect(r.lastReadMessageId).toBe(m.id);
        });

        it("upsert advances the watermark on second call", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            const m1 = await msgRepo.create(ctx, systemSec, {
                conversationId: c.id,
                authorId: ALICE,
                content: "first",
                contentType: "text/markdown",
            });
            const m2 = await msgRepo.create(ctx, systemSec, {
                conversationId: c.id,
                authorId: BOB,
                content: "second",
                contentType: "text/markdown",
            });
            const r1 = await receiptRepo.upsert(ctx, systemSec, {
                conversationId: c.id,
                userId: ALICE,
                lastReadMessageId: m1.id,
            });
            const r2 = await receiptRepo.upsert(ctx, systemSec, {
                conversationId: c.id,
                userId: ALICE,
                lastReadMessageId: m2.id,
            });
            expect(r1.id).toBe(r2.id);
            expect(r2.lastReadMessageId).toBe(m2.id);
            expect(r2.lastReadAt.getTime()).toBeGreaterThanOrEqual(r1.lastReadAt.getTime());
        });

        it("findByConversationAndUser returns null when no receipt exists", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            expect(
                await receiptRepo.findByConversationAndUser(ctx, systemSec, {
                    conversationId: c.id,
                    userId: ALICE,
                }),
            ).toBeNull();
        });

        it("findByConversation returns receipts for all users", async () => {
            const c = await convRepo.create(ctx, systemSec, {
                subjectIri: CONTRACT_IRI,
                title: "t",
                createdBy: ALICE,
            });
            const m = await msgRepo.create(ctx, systemSec, {
                conversationId: c.id,
                authorId: ALICE,
                content: "msg",
                contentType: "text/markdown",
            });
            await receiptRepo.upsert(ctx, systemSec, {
                conversationId: c.id,
                userId: ALICE,
                lastReadMessageId: m.id,
            });
            await receiptRepo.upsert(ctx, systemSec, {
                conversationId: c.id,
                userId: BOB,
                lastReadMessageId: m.id,
            });
            const all = await receiptRepo.findByConversation(ctx, systemSec, {
                conversationId: c.id,
            });
            expect(all).toHaveLength(2);
            expect(all.map((r) => r.userId)).toEqual(expect.arrayContaining([ALICE, BOB]));
        });
    });

    // ── ConvoService (no RBAC) ────────────────────────────────────────────────

    describe(`ConvoService — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let svc: ConvoService;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            ctx = buildServerContext(store, { trx });
            store = new TripleStore(knex);
            svc = makeService(store);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("createConversation adds owner participant automatically", async () => {
            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "Contract discussion",
            });
            expect(conversation.createdBy).toBe(ALICE);
            const parts = await svc.getParticipants(ctx, systemSec, {
                conversationId: conversation.id,
            });
            expect(parts).toHaveLength(1);
            expect(parts[0].role).toBe("owner");
        });

        it("createConversation with initialMessage fans out notifications to other participants", async () => {
            const { message } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "Welcome",
                initialMessage: "Hello!",
                participantIds: [BOB],
            });
            expect(message?.content).toBe("Hello!");
            expect(await svc.getNotificationsForUser(ctx, systemSec, { userId: BOB })).toHaveLength(
                1,
            );
            expect(
                await svc.getNotificationsForUser(ctx, systemSec, { userId: ALICE }),
            ).toHaveLength(0);
        });

        it("postMessage creates notification for participants, not author", async () => {
            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "t",
                participantIds: [BOB, CHARLIE],
            });
            await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "Hey team",
            });
            expect(await svc.getNotificationsForUser(ctx, systemSec, { userId: BOB })).toHaveLength(
                1,
            );
            expect(
                await svc.getNotificationsForUser(ctx, systemSec, { userId: CHARLIE }),
            ).toHaveLength(1);
            expect(
                await svc.getNotificationsForUser(ctx, systemSec, { userId: ALICE }),
            ).toHaveLength(0);
        });

        it("postMessage skips notification for user with a current read receipt", async () => {
            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "t",
                participantIds: [BOB],
            });
            const msg = await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "first message",
            });
            // BOB marks the first message as read — dismisses the msg1 notification
            await svc.markConversationRead(ctx, systemSec, {
                userId: BOB,
                conversationId: conversation.id,
                lastReadMessageId: msg.id,
            });
            // New message posted after BOB's watermark — BOB gets exactly one new notification
            await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "second message",
            });
            const notifs = await svc.getNotificationsForUser(ctx, systemSec, { userId: BOB });
            const active = notifs.filter((n) => !n.isDismissed);
            expect(active).toHaveLength(1);
        });

        it("postMessage types a reply notification 'reply' and a plain message 'mention'", async () => {
            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "t",
                participantIds: [BOB],
            });
            const plain = await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "plain message",
            });
            const reply = await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "a reply",
                replyToId: plain.id,
            });
            const notifs = await svc.getNotificationsForUser(ctx, systemSec, { userId: BOB });
            const plainNotif = notifs.find((n) => n.sourceIri === plain.iri);
            const replyNotif = notifs.find((n) => n.sourceIri === reply.iri);
            expect(plainNotif?.notifType).toBe("mention");
            expect(replyNotif?.notifType).toBe("reply");
        });

        it("editMessage returns updated content with revision", async () => {
            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "t",
            });
            const msg = await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "original",
            });
            const result = await svc.editMessage(ctx, secFor(ALICE), {
                messageId: msg.id,
                newContent: "updated",
            });
            expect(result?.message.content).toBe("updated");
            expect(result?.revision.content).toBe("original");
        });

        it("deleteMessage soft-deletes", async () => {
            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "t",
            });
            const msg = await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "bye",
            });
            expect(
                (await svc.deleteMessage(ctx, secFor(ALICE), { messageId: msg.id }))?.isDeleted,
            ).toBe(true);
        });

        it("closeConversation updates status", async () => {
            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "t",
            });
            expect(
                (
                    await svc.closeConversation(ctx, secFor(ALICE), {
                        conversationId: conversation.id,
                    })
                )?.status,
            ).toBe("closed");
        });

        it("sendDraft promotes draft to message and removes the draft", async () => {
            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "t",
            });
            const draft = await svc.createDraft(ctx, systemSec, {
                conversationId: conversation.id,
                authorId: ALICE,
                content: "my draft",
            });
            const message = await svc.sendDraft(ctx, secFor(ALICE), { draftId: draft.id });
            expect(message?.content).toBe("my draft");
            expect(await svc.getDraftsForAuthor(ctx, systemSec, { authorId: ALICE })).toHaveLength(
                0,
            );
        });

        it("createInbox adds owner membership for creator", async () => {
            const inbox = await svc.createInbox(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                name: "Support",
                memberIds: [BOB],
            });
            const members = await svc.getInboxMembers(ctx, systemSec, { inboxId: inbox.id });
            expect(members.map((m) => m.userId)).toEqual(expect.arrayContaining([ALICE, BOB]));
            expect(members.find((m) => m.userId === ALICE)?.role).toBe("owner");
        });

        it("getConversationsForSubject works with any subject IRI (cross-domain)", async () => {
            await svc.createConversation(ctx, secFor(BOB), {
                subjectIri: USER_SUBJECT_IRI,
                title: "Alice profile thread",
            });
            const convos = await svc.getConversationsForSubject(ctx, systemSec, {
                subjectIri: USER_SUBJECT_IRI,
            });
            expect(convos).toHaveLength(1);
            expect(convos[0].subjectIri).toBe(USER_SUBJECT_IRI);
        });

        it("markAllNotificationsRead clears unread count", async () => {
            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "t",
                participantIds: [BOB],
            });
            await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "m1",
            });
            await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "m2",
            });
            expect(await svc.getUnreadCount(ctx, systemSec, { userId: BOB })).toBe(2);
            expect(await svc.markAllNotificationsRead(ctx, systemSec, { userId: BOB })).toBe(2);
            expect(await svc.getUnreadCount(ctx, systemSec, { userId: BOB })).toBe(0);
        });
    });

    // ── Read receipts via ConvoService ────────────────────────────────────────

    describe(`ConvoService read receipts — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let svc: ConvoService;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            ctx = buildServerContext(store, { trx });
            store = new TripleStore(knex);
            svc = makeService(store);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("markConversationRead sets a receipt and advances watermark", async () => {
            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "t",
            });
            const m1 = await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "first",
            });
            await svc.markConversationRead(ctx, systemSec, {
                userId: ALICE,
                conversationId: conversation.id,
                lastReadMessageId: m1.id,
            });
            const r = await svc.getReadReceipt(ctx, systemSec, {
                conversationId: conversation.id,
                userId: ALICE,
            });
            expect(r?.lastReadMessageId).toBe(m1.id);

            const m2 = await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "second",
            });
            await svc.markConversationRead(ctx, systemSec, {
                userId: ALICE,
                conversationId: conversation.id,
                lastReadMessageId: m2.id,
            });
            const r2 = await svc.getReadReceipt(ctx, systemSec, {
                conversationId: conversation.id,
                userId: ALICE,
            });
            expect(r2?.lastReadMessageId).toBe(m2.id);
        });

        it("getUnreadMessageCount returns correct count relative to watermark", async () => {
            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "t",
            });
            const m1 = await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "msg1",
            });
            await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "msg2",
            });
            await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "msg3",
            });

            // No receipt — all messages are unread
            expect(
                await svc.getUnreadMessageCount(ctx, systemSec, {
                    conversationId: conversation.id,
                    userId: BOB,
                }),
            ).toBe(3);

            // Read through msg1 — two remain
            await svc.markConversationRead(ctx, systemSec, {
                userId: BOB,
                conversationId: conversation.id,
                lastReadMessageId: m1.id,
            });
            expect(
                await svc.getUnreadMessageCount(ctx, systemSec, {
                    conversationId: conversation.id,
                    userId: BOB,
                }),
            ).toBe(2);
        });

        it("getReadReceiptsForConversation returns receipts for all readers", async () => {
            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "t",
            });
            const m = await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "x",
            });
            await svc.markConversationRead(ctx, systemSec, {
                userId: ALICE,
                conversationId: conversation.id,
                lastReadMessageId: m.id,
            });
            await svc.markConversationRead(ctx, systemSec, {
                userId: BOB,
                conversationId: conversation.id,
                lastReadMessageId: m.id,
            });
            const receipts = await svc.getReadReceiptsForConversation(ctx, systemSec, {
                conversationId: conversation.id,
            });
            expect(receipts).toHaveLength(2);
        });

        it("markConversationRead dismisses pre-watermark notifications", async () => {
            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "t",
                participantIds: [BOB],
            });
            const msg = await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "hello",
            });
            expect(await svc.getUnreadCount(ctx, systemSec, { userId: BOB })).toBe(1);
            await svc.markConversationRead(ctx, systemSec, {
                userId: BOB,
                conversationId: conversation.id,
                lastReadMessageId: msg.id,
            });
            expect(await svc.getUnreadCount(ctx, systemSec, { userId: BOB })).toBe(0);
        });

        it("markConversationRead does not dismiss notifications from other conversations", async () => {
            const { conversation: convA } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "A",
                participantIds: [BOB],
            });
            const { conversation: convB } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "B",
                participantIds: [BOB],
            });
            const msgA = await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: convA.id,
                content: "in A",
            });
            const msgB = await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: convB.id,
                content: "in B",
            });
            expect(await svc.getUnreadCount(ctx, systemSec, { userId: BOB })).toBe(2);

            // BOB reads conversation A only.
            await svc.markConversationRead(ctx, systemSec, {
                userId: BOB,
                conversationId: convA.id,
                lastReadMessageId: msgA.id,
            });

            // The notification for conversation B must survive; only A's is dismissed.
            const notifs = await svc.getNotificationsForUser(ctx, systemSec, { userId: BOB });
            const notifA = notifs.find((n) => n.sourceIri === msgA.iri);
            const notifB = notifs.find((n) => n.sourceIri === msgB.iri);
            expect(notifA?.isDismissed).toBe(true);
            expect(notifB?.isDismissed).toBe(false);
            expect(await svc.getUnreadCount(ctx, systemSec, { userId: BOB })).toBe(1);
        });
    });

    // ── ConvoService with RBAC ────────────────────────────────────────────────

    describe(`ConvoService + RBAC — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let rbac: RbacService;
        let svc: ConvoService;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            store = new TripleStore(knex);
            ctx = buildServerContext(store, { trx });
            rbac = makeRbacService(store);
            // Seed inside the test transaction so afterEach's rollback removes it.
            await seedSystemData(ctx, store);
            svc = makeServiceWithRbac(store, rbac);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("createConversation denied without tern.convos:conversation.create", async () => {
            await expect(
                svc.createConversation(ctx, secFor(ALICE), {
                    subjectIri: CONTRACT_IRI,
                    title: "Denied",
                }),
            ).rejects.toThrow(/Access denied/);
        });

        it("createConversation succeeds when permission is granted", async () => {
            const p = await rbac.createPermission(ctx, systemSec, { key: PERM_CONVO_CREATE });
            const role = await rbac.createRole(ctx, systemSec, {
                roleName: "User",
                tenantId: null,
            });
            await rbac.addPermissionToRole(ctx, systemSec, {
                roleIri: role.iri,
                permissionIri: p.iri,
            });
            await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: role.iri });
            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "OK",
            });
            expect(conversation.title).toBe("OK");
        });

        it("postMessage denied without tern.convos:message.post", async () => {
            const cp = await rbac.createPermission(ctx, systemSec, { key: PERM_CONVO_CREATE });
            const role = await rbac.createRole(ctx, systemSec, {
                roleName: "Creator",
                tenantId: null,
            });
            await rbac.addPermissionToRole(ctx, systemSec, {
                roleIri: role.iri,
                permissionIri: cp.iri,
            });
            await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: role.iri });
            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "t",
            });
            await expect(
                svc.postMessage(ctx, secFor(BOB), {
                    conversationId: conversation.id,
                    content: "hi",
                }),
            ).rejects.toThrow(/Access denied/);
        });

        it("editMessage denied when BOB (non-author) lacks tern.convos:message.edit.any", async () => {
            const createP = await rbac.createPermission(ctx, systemSec, { key: PERM_CONVO_CREATE });
            const postP = await rbac.createPermission(ctx, systemSec, { key: PERM_MESSAGE_POST });
            const editOwnP = await rbac.createPermission(ctx, systemSec, {
                key: PERM_MESSAGE_EDIT_OWN,
            });
            const userRole = await rbac.createRole(ctx, systemSec, {
                roleName: "User",
                tenantId: null,
            });
            await rbac.addPermissionToRole(ctx, systemSec, {
                roleIri: userRole.iri,
                permissionIri: createP.iri,
            });
            await rbac.addPermissionToRole(ctx, systemSec, {
                roleIri: userRole.iri,
                permissionIri: postP.iri,
            });
            await rbac.addPermissionToRole(ctx, systemSec, {
                roleIri: userRole.iri,
                permissionIri: editOwnP.iri,
            });
            await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: userRole.iri });
            await rbac.grant(ctx, systemSec, { principalIri: BOB, roleIri: userRole.iri });

            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "t",
            });
            const msg = await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "alice's message",
            });
            await expect(
                svc.editMessage(ctx, secFor(BOB), { messageId: msg.id, newContent: "tampered" }),
            ).rejects.toThrow(/Access denied/);
        });

        it("editMessage succeeds when moderator has tern.convos:message.edit.any", async () => {
            const createP = await rbac.createPermission(ctx, systemSec, { key: PERM_CONVO_CREATE });
            const postP = await rbac.createPermission(ctx, systemSec, { key: PERM_MESSAGE_POST });
            const editAnyP = await rbac.createPermission(ctx, systemSec, {
                key: PERM_MESSAGE_EDIT_ANY,
            });
            const userRole = await rbac.createRole(ctx, systemSec, {
                roleName: "User",
                tenantId: null,
            });
            await rbac.addPermissionToRole(ctx, systemSec, {
                roleIri: userRole.iri,
                permissionIri: createP.iri,
            });
            await rbac.addPermissionToRole(ctx, systemSec, {
                roleIri: userRole.iri,
                permissionIri: postP.iri,
            });
            const modRole = await rbac.createRole(ctx, systemSec, {
                roleName: "Mod",
                tenantId: null,
            });
            await rbac.addPermissionToRole(ctx, systemSec, {
                roleIri: modRole.iri,
                permissionIri: editAnyP.iri,
            });
            await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: userRole.iri });
            await rbac.grant(ctx, systemSec, { principalIri: BOB, roleIri: modRole.iri });

            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "t",
            });
            const msg = await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "original",
            });
            const result = await svc.editMessage(ctx, secFor(BOB), {
                messageId: msg.id,
                newContent: "moderated",
            });
            expect(result?.message.content).toBe("moderated");
        });

        it("closeConversation denied without tern.convos:conversation.close", async () => {
            const cp = await rbac.createPermission(ctx, systemSec, { key: PERM_CONVO_CREATE });
            const role = await rbac.createRole(ctx, systemSec, {
                roleName: "User",
                tenantId: null,
            });
            await rbac.addPermissionToRole(ctx, systemSec, {
                roleIri: role.iri,
                permissionIri: cp.iri,
            });
            await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: role.iri });
            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "t",
            });
            await expect(
                svc.closeConversation(ctx, secFor(ALICE), { conversationId: conversation.id }),
            ).rejects.toThrow(/Access denied/);
        });

        it("createInbox denied without tern.convos:inbox.create", async () => {
            await expect(
                svc.createInbox(ctx, secFor(ALICE), {
                    subjectIri: CONTRACT_IRI,
                    name: "X",
                }),
            ).rejects.toThrow(/Access denied/);
        });

        it("full moderator role can create, post, edit any, close, and create inbox", async () => {
            const perms = [
                PERM_CONVO_CREATE,
                PERM_CONVO_CLOSE,
                PERM_MESSAGE_POST,
                PERM_MESSAGE_EDIT_ANY,
                PERM_INBOX_CREATE,
            ];
            const modRole = await rbac.createRole(ctx, systemSec, {
                roleName: "Mod",
                tenantId: null,
            });
            for (const key of perms) {
                const p = await rbac.createPermission(ctx, systemSec, { key: key });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: modRole.iri,
                    permissionIri: p.iri,
                });
            }
            await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: modRole.iri });

            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "Full access",
            });
            const msg = await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "original",
            });
            expect(
                (
                    await svc.editMessage(ctx, secFor(ALICE), {
                        messageId: msg.id,
                        newContent: "edited",
                    })
                )?.message.content,
            ).toBe("edited");
            expect(
                (
                    await svc.closeConversation(ctx, secFor(ALICE), {
                        conversationId: conversation.id,
                    })
                )?.status,
            ).toBe("closed");
            expect(
                (
                    await svc.createInbox(ctx, secFor(ALICE), {
                        subjectIri: CONTRACT_IRI,
                        name: "Inbox",
                    })
                ).name,
            ).toBe("Inbox");
        });

        // ── Read enforcement (participant-gated reads) ──────────────────────────
        //
        // A non-participant must not read a conversation, its messages,
        // participants, or read receipts. ConvoService gates these reads on
        // conversation membership, OR on PERM_CONVO_READ scoped to the
        // conversation IRI (the moderator / cross-conversation reader grant).

        async function grantPerms(principalIri: string, keys: string[]): Promise<void> {
            const role = await rbac.createRole(ctx, systemSec, {
                roleName: `role-${principalIri}-${keys.join("-")}`,
                tenantId: null,
            });
            for (const key of keys) {
                const p = await rbac.createPermission(ctx, systemSec, { key: key });
                await rbac.addPermissionToRole(ctx, systemSec, {
                    roleIri: role.iri,
                    permissionIri: p.iri,
                });
            }
            await rbac.grant(ctx, systemSec, { principalIri: principalIri, roleIri: role.iri });
        }

        async function seedConversationWithMessage(): Promise<{ id: string; iri: string }> {
            await grantPerms(ALICE, [PERM_CONVO_CREATE, PERM_MESSAGE_POST]);
            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "private thread",
            });
            await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "secret",
            });
            return { id: conversation.id, iri: conversation.iri };
        }

        it("getConversation denied for a non-participant without PERM_CONVO_READ", async () => {
            const conv = await seedConversationWithMessage();
            await expect(
                svc.getConversation(ctx, secFor(CHARLIE), { conversationId: conv.id }),
            ).rejects.toThrow(/Access denied/);
        });

        it("getMessagesForConversation denied for a non-participant", async () => {
            const conv = await seedConversationWithMessage();
            await expect(
                svc.getMessagesForConversation(ctx, secFor(CHARLIE), { conversationId: conv.id }),
            ).rejects.toThrow(/Access denied/);
        });

        it("getParticipants denied for a non-participant", async () => {
            const conv = await seedConversationWithMessage();
            await expect(
                svc.getParticipants(ctx, secFor(CHARLIE), { conversationId: conv.id }),
            ).rejects.toThrow(/Access denied/);
        });

        it("getReadReceiptsForConversation denied for a non-participant", async () => {
            const conv = await seedConversationWithMessage();
            await expect(
                svc.getReadReceiptsForConversation(ctx, secFor(CHARLIE), {
                    conversationId: conv.id,
                }),
            ).rejects.toThrow(/Access denied/);
        });

        it("getUnreadMessageCount denied for a non-participant", async () => {
            const conv = await seedConversationWithMessage();
            await expect(
                svc.getUnreadMessageCount(ctx, secFor(CHARLIE), {
                    conversationId: conv.id,
                    userId: CHARLIE,
                }),
            ).rejects.toThrow(/Access denied/);
        });

        it("a participant may read the conversation and its messages without PERM_CONVO_READ", async () => {
            await grantPerms(ALICE, [PERM_CONVO_CREATE, PERM_MESSAGE_POST]);
            const { conversation } = await svc.createConversation(ctx, secFor(ALICE), {
                subjectIri: CONTRACT_IRI,
                title: "team thread",
                participantIds: [BOB],
            });
            await svc.postMessage(ctx, secFor(ALICE), {
                conversationId: conversation.id,
                content: "hello bob",
            });

            // ALICE (owner) reads her own conversation.
            expect(
                (await svc.getConversation(ctx, secFor(ALICE), { conversationId: conversation.id }))
                    ?.title,
            ).toBe("team thread");

            // BOB is a participant with no convos permissions at all, yet may read.
            const msgs = await svc.getMessagesForConversation(ctx, secFor(BOB), {
                conversationId: conversation.id,
            });
            expect(msgs).toHaveLength(1);
            expect(msgs[0].content).toBe("hello bob");
            expect(
                await svc.getParticipants(ctx, secFor(BOB), { conversationId: conversation.id }),
            ).toHaveLength(2);
        });

        it("a non-participant holding PERM_CONVO_READ may read (moderator path)", async () => {
            const conv = await seedConversationWithMessage();
            await grantPerms(CHARLIE, [PERM_CONVO_READ]);

            expect(
                (await svc.getConversation(ctx, secFor(CHARLIE), { conversationId: conv.id }))
                    ?.title,
            ).toBe("private thread");
            const msgs = await svc.getMessagesForConversation(ctx, secFor(CHARLIE), {
                conversationId: conv.id,
            });
            expect(msgs).toHaveLength(1);
            expect(msgs[0].content).toBe("secret");
        });
    });

    // ── installConvos ─────────────────────────────────────────────────────────

    describe(`installConvos — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let rbac: RbacService;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            store = new TripleStore(knex);
            ctx = buildServerContext(store, { trx });
            rbac = makeRbacService(store);
            // Seed inside the test transaction so afterEach's rollback removes it.
            await seedSystemData(ctx, store);
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("seeds all convos permissions", async () => {
            const result = await installConvos(ctx, rbac);
            for (const key of Object.keys(result.permissionIris)) {
                const found = await rbac.findPermissionByKey(ctx, systemSec, { key: key });
                expect(found?.permissionKey).toBe(key);
            }
        });

        it("creates ConvoUser and ConvoModerator roles", async () => {
            const result = await installConvos(ctx, rbac);
            expect(result.userRoleIri).toBeTruthy();
            expect(result.moderatorRoleIri).toBeTruthy();
            expect(result.userRoleIri).not.toBe(result.moderatorRoleIri);
        });

        it("ConvoUser role grants tern.convos:conversation.create", async () => {
            const result = await installConvos(ctx, rbac);
            await rbac.grant(ctx, systemSec, { principalIri: ALICE, roleIri: result.userRoleIri });
            expect(await rbac.can(ctx, secFor(ALICE), { permission: PERM_CONVO_CREATE })).toBe(
                true,
            );
        });

        it("ConvoModerator role grants tern.convos:conversation.close", async () => {
            const result = await installConvos(ctx, rbac);
            await rbac.grant(ctx, systemSec, {
                principalIri: ALICE,
                roleIri: result.moderatorRoleIri,
            });
            expect(await rbac.can(ctx, secFor(ALICE), { permission: PERM_CONVO_CLOSE })).toBe(true);
        });

        it("installConvos is idempotent for permissions (find-or-create)", async () => {
            const r1 = await installConvos(ctx, rbac);
            const r2 = await installConvos(ctx, rbac);
            expect(r1.permissionIris[PERM_CONVO_CREATE]).toBe(r2.permissionIris[PERM_CONVO_CREATE]);
        });

        it("uninstallConvos revokes the supplied grant IRIs", async () => {
            const result = await installConvos(ctx, rbac);
            const grant = await rbac.grant(ctx, systemSec, {
                principalIri: ALICE,
                roleIri: result.userRoleIri,
            });
            expect(await rbac.can(ctx, secFor(ALICE), { permission: PERM_CONVO_CREATE })).toBe(
                true,
            );
            await uninstallConvos(ctx, rbac, [grant.iri]);
            expect(await rbac.can(ctx, secFor(ALICE), { permission: PERM_CONVO_CREATE })).toBe(
                false,
            );
        });
    });

    // ── NotificationService ───────────────────────────────────────────────────

    describe(`NotificationService — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let ctx: ServerContext;
        let store: TripleStore;
        let notifRepo: NotificationRepository;
        let svc: NotificationService;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            ctx = buildServerContext(store, { trx });
            store = new TripleStore(knex);
            notifRepo = new NotificationRepository(store);
            svc = new NotificationService({ notifications: notifRepo });
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        // ── one-time ──────────────────────────────────────────────────────────

        it("one-time: delivers on first call and is suppressed on subsequent calls", async () => {
            const first = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:welcome",
                payload: { name: "Alice" },
                dedupe: { kind: "one-time" },
            });
            expect(first).not.toBeNull();
            if (!first) {
                return;
            }
            expect(first.templateKey).toBe("insights:welcome");
            expect(first.payload).toBe(JSON.stringify({ name: "Alice" }));

            const second = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:welcome",
                payload: { name: "Alice" },
                dedupe: { kind: "one-time" },
            });
            expect(second).toBeNull();
        });

        it("one-time: dismissing does NOT reset the latch", async () => {
            const n = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:welcome",
                dedupe: { kind: "one-time" },
            });
            expect(n).not.toBeNull();
            if (!n) {
                return;
            }
            await notifRepo.dismiss(ctx, systemSec, { id: n.id });

            const after = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:welcome",
                dedupe: { kind: "one-time" },
            });
            expect(after).toBeNull();
        });

        it("one-time: independent per user", async () => {
            await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:welcome",
                dedupe: { kind: "one-time" },
            });
            const bob = await svc.send(ctx, systemSec, {
                userId: BOB,
                templateKey: "insights:welcome",
                dedupe: { kind: "one-time" },
            });
            expect(bob).not.toBeNull();
        });

        // ── resettable ────────────────────────────────────────────────────────

        it("resettable: delivers once, then suppresses until dismissed", async () => {
            const first = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:tip",
                dedupe: { kind: "resettable" },
            });
            expect(first).not.toBeNull();

            const suppressed = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:tip",
                dedupe: { kind: "resettable" },
            });
            expect(suppressed).toBeNull();

            if (!first) {
                return;
            }
            await notifRepo.dismiss(ctx, systemSec, { id: first.id });

            const afterDismiss = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:tip",
                dedupe: { kind: "resettable" },
            });
            expect(afterDismiss).not.toBeNull();
        });

        // ── window ────────────────────────────────────────────────────────────

        it("window: delivers within the time window and then suppresses", async () => {
            const first = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:daily-digest",
                payload: { activeUsers: 42 },
                dedupe: { kind: "window", hours: 24 },
            });
            expect(first).not.toBeNull();

            const withinWindow = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:daily-digest",
                payload: { activeUsers: 50 },
                dedupe: { kind: "window", hours: 24 },
            });
            expect(withinWindow).toBeNull();
        });

        it("window: dismissing resets the window", async () => {
            const first = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:daily-digest",
                dedupe: { kind: "window", hours: 24 },
            });
            expect(first).not.toBeNull();
            if (!first) {
                return;
            }
            await notifRepo.dismiss(ctx, systemSec, { id: first.id });

            const afterDismiss = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:daily-digest",
                dedupe: { kind: "window", hours: 24 },
            });
            expect(afterDismiss).not.toBeNull();
        });

        it("window: a zero-hour window never suppresses (always delivers)", async () => {
            await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:realtime",
                dedupe: { kind: "window", hours: 0 },
            });
            const second = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:realtime",
                dedupe: { kind: "window", hours: 0 },
            });
            expect(second).not.toBeNull();
        });

        // ── sendToMany ────────────────────────────────────────────────────────

        it("sendToMany: delivers to each user independently, skipping suppressed ones", async () => {
            await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:feature-announcement",
                dedupe: { kind: "one-time" },
            });

            const results = await svc.sendToMany(ctx, systemSec, {
                userIds: [ALICE, BOB, CHARLIE],
                input: {
                    templateKey: "insights:feature-announcement",
                    payload: { feature: "dark mode" },
                    dedupe: { kind: "one-time" },
                },
            });

            expect(results).toHaveLength(2);
            expect(results.map((n) => n.userId)).toEqual(expect.arrayContaining([BOB, CHARLIE]));
        });

        // ── helper queries ────────────────────────────────────────────────────

        it("wasSentEver returns false before first send and true after", async () => {
            expect(
                await svc.wasSentEver(ctx, systemSec, {
                    userId: ALICE,
                    templateKey: "insights:welcome",
                }),
            ).toBe(false);
            await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:welcome",
                dedupe: { kind: "one-time" },
            });
            expect(
                await svc.wasSentEver(ctx, systemSec, {
                    userId: ALICE,
                    templateKey: "insights:welcome",
                }),
            ).toBe(true);
        });

        it("wasSentEver returns true even after dismiss", async () => {
            const n = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:welcome",
                dedupe: { kind: "one-time" },
            });
            expect(n).not.toBeNull();
            if (!n) {
                return;
            }
            await notifRepo.dismiss(ctx, systemSec, { id: n.id });
            expect(
                await svc.wasSentEver(ctx, systemSec, {
                    userId: ALICE,
                    templateKey: "insights:welcome",
                }),
            ).toBe(true);
        });

        it("hasPending returns false after dismiss and true when undismissed", async () => {
            expect(
                await svc.hasPending(ctx, systemSec, {
                    userId: ALICE,
                    templateKey: "insights:tip",
                }),
            ).toBe(false);
            const n = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:tip",
                dedupe: { kind: "resettable" },
            });
            expect(
                await svc.hasPending(ctx, systemSec, {
                    userId: ALICE,
                    templateKey: "insights:tip",
                }),
            ).toBe(true);
            expect(n).not.toBeNull();
            if (!n) {
                return;
            }
            await notifRepo.dismiss(ctx, systemSec, { id: n.id });
            expect(
                await svc.hasPending(ctx, systemSec, {
                    userId: ALICE,
                    templateKey: "insights:tip",
                }),
            ).toBe(false);
        });

        it("history returns all deliveries for a (user, templateKey), newest first", async () => {
            for (let i = 0; i < 3; i++) {
                await svc.send(ctx, systemSec, {
                    userId: ALICE,
                    templateKey: "insights:hourly",
                    dedupe: { kind: "window", hours: 0 },
                });
            }
            const h = await svc.history(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:hourly",
            });
            expect(h).toHaveLength(3);
            expect(h[0].createdAt.getTime()).toBeGreaterThanOrEqual(h[1].createdAt.getTime());
        });

        // ── payload round-trip ────────────────────────────────────────────────

        it("payload is stored as JSON and round-trips correctly", async () => {
            const data = { count: 99, label: "active users", nested: { ok: true } };
            const expected = JSON.stringify(data);

            const n = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:stats",
                payload: data,
                dedupe: { kind: "window", hours: 0 },
            });
            expect(n).not.toBeNull();
            if (!n) {
                return;
            }
            expect(n.payload).toBe(expected);

            const fetched = await notifRepo.findById(ctx, systemSec, { id: n.id });
            expect(fetched?.payload).toBe(expected);
        });

        // ── sourceIri optional ────────────────────────────────────────────────

        it("sourceIri is optional — insight notifications work without it", async () => {
            const n = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:welcome",
                dedupe: { kind: "one-time" },
            });
            expect(n).not.toBeNull();
            if (!n) {
                return;
            }
            expect(n.sourceIri).toBeUndefined();
        });

        it("sourceIri is stored and returned when provided", async () => {
            const n = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:link",
                sourceIri: "urn:sys:test:events:ev123",
                dedupe: { kind: "window", hours: 0 },
            });
            expect(n).not.toBeNull();
            if (!n) {
                return;
            }
            expect(n.sourceIri).toBe("urn:sys:test:events:ev123");
        });

        // ── notifType default ─────────────────────────────────────────────────

        it("notifType defaults to 'insight' when not specified", async () => {
            const n = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:welcome",
                dedupe: { kind: "one-time" },
            });
            expect(n).not.toBeNull();
            if (!n) {
                return;
            }
            expect(n.notifType).toBe("insight");
        });

        it("notifType can be overridden by the caller", async () => {
            const n = await svc.send(ctx, systemSec, {
                userId: ALICE,
                templateKey: "insights:digest",
                notifType: "digest",
                dedupe: { kind: "window", hours: 0 },
            });
            expect(n).not.toBeNull();
            if (!n) {
                return;
            }
            expect(n.notifType).toBe("digest");
        });

        // ── NPM-consumer pattern example ──────────────────────────────────────

        it("downstream consumer pattern: send welcome once and daily digest with 24h window", async () => {
            // Simulate an application insights extension using NotificationService
            // as a standalone dep (no ConvoService needed).

            async function sendWelcome(userId: string): Promise<boolean> {
                const result = await svc.send(ctx, systemSec, {
                    userId,
                    templateKey: "myapp:insights:welcome",
                    payload: { version: "2.0" },
                    dedupe: { kind: "one-time" },
                });
                return result !== null;
            }

            async function sendDailyDigest(
                userId: string,
                stats: Record<string, number>,
            ): Promise<boolean> {
                const result = await svc.send(ctx, systemSec, {
                    userId,
                    templateKey: "myapp:insights:daily-digest",
                    payload: stats,
                    dedupe: { kind: "window", hours: 24 },
                });
                return result !== null;
            }

            expect(await sendWelcome(ALICE)).toBe(true); // delivered
            expect(await sendWelcome(ALICE)).toBe(false); // suppressed forever

            expect(await sendDailyDigest(ALICE, { dau: 100 })).toBe(true); // delivered
            expect(await sendDailyDigest(ALICE, { dau: 101 })).toBe(false); // within 24h
        });
    });
}
