/**
 * TRN-527 — WebSocket store-access authentication + authorization.
 *
 * The sandbox-server WS pipeline carries the raw triple.* store handlers
 * (find/insert/stats). Before this change any anonymous, cross-site WS client
 * could read every graph and forge RBAC PolicyGrant quads. This suite proves the
 * hole is closed against REAL infrastructure — a real WebSocket server, a real
 * Postgres triple store, the real AuthService session-validation path, and the
 * real RbacService superuser evaluation. No mocks, stubs, or in-memory engine:
 * isolation is by a single rolled-back Postgres transaction per test.
 *
 * Coverage of the PO acceptance bar:
 *   1. Anonymous upgrade (no session token) is rejected at connect (401).
 *   2. A real session principal is threaded as `sec`; triple.* is gated behind
 *      superuser RBAC (denied for anon + non-superuser, allowed for superuser),
 *      end to end over a real socket.
 *   3. allowedOrigins is enforced (cross-site upgrade → 403).
 *   4. An anonymous triple.insert of a PolicyGrant quad fails and writes nothing.
 */

import {
    AuthService,
    GoogleProvider,
    MemorySessionStore,
    UserDeviceRepository,
    UserIdentityRepository,
    UserRepository,
    UserSessionRepository,
} from "@terncosoftware/auth";
import {
    anonymousSec,
    query,
    type SecurityContext,
    SYSTEM_TYPES,
    type SystemRequest,
    type SystemResult,
} from "@terncosoftware/core";
import { type Knex, TripleStore } from "@terncosoftware/data";
import { FlowApp, WebSocketServer, type WsPrincipal } from "@terncosoftware/flow";
import {
    buildServerContext,
    PermissionRepository,
    PolicyGrantRepository,
    RbacService,
    ResourceNodeRepository,
    RoleRepository,
    type ServerContext,
    ServiceAccountRepository,
    SuperuserService,
    seedSystemData,
    systemSec,
    TenantRepository,
    UserGroupRepository,
} from "@terncosoftware/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";
// The real sandbox-server seams under test — imported directly (never the
// package root, whose index.ts self-runs the server main()).
import { buildWsAuthenticate, secFromPrincipal } from "../../../sandbox-server/src/auth/wsAuth.js";
import { MessageDecoder } from "../../../sandbox-server/src/components/MessageDecoder.js";
import { MessageEncoder } from "../../../sandbox-server/src/components/MessageEncoder.js";
import { MessageRouter } from "../../../sandbox-server/src/components/MessageRouter.js";
import {
    handleFind,
    handleInsert,
    handleStats,
} from "../../../sandbox-server/src/handlers/triples.js";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";
import { TEST_CIPHER } from "../auth/testCipher.js";

// ── Infra: real Postgres only (no SQLite — repo law + PO bar) ────────────────

const PG_URL = process.env.SYS_PG_URL ?? "postgresql://sys:sys@localhost:5432/sys";

function pgContext(): Promise<Knex> {
    const url = new URL(PG_URL);
    return createTestDataContext({
        client: "pg",
        host: url.hostname,
        port: url.port ? Number(url.port) : 5432,
        database: url.pathname.slice(1),
        user: url.username,
        password: url.password,
    });
}

// ── Helpers (real, not mocks) ────────────────────────────────────────────────

async function freePort(): Promise<number> {
    const net = await import("node:net");
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, () => {
            const addr = srv.address() as { port: number };
            srv.close(() => resolve(addr.port));
        });
        srv.on("error", reject);
    });
}

interface ConnectResult {
    ok: boolean;
    status: number | null;
    ws: WsClient | null;
}

function connectWs(url: string, headers: Record<string, string>): Promise<ConnectResult> {
    const ws = new WsClient(url, { headers });
    return new Promise((resolve) => {
        ws.on("open", () => resolve({ ok: true, status: 101, ws }));
        ws.on("unexpected-response", (_req, res) => {
            ws.terminate();
            resolve({ ok: false, status: res.statusCode ?? null, ws: null });
        });
        ws.on("error", () => resolve({ ok: false, status: null, ws: null }));
    });
}

const ORIGIN = "http://localhost:5173";

describe("TRN-527 — WS triple.* store access is authenticated + superuser-gated", () => {
    // knex/trx are null until their setup hook succeeds, and the teardown hooks
    // guard on that: a failed connection or seed then reports the real setup
    // error instead of cascading a TypeError out of afterEach/afterAll.
    let knex: Knex | null = null;
    let trx: Knex.Transaction | null = null;
    let store: TripleStore;
    let ctx: ServerContext;
    let rbac: RbacService;
    let superusers: SuperuserService;
    let auth: AuthService;

    beforeAll(async () => {
        knex = await pgContext();
    });
    afterAll(async () => {
        if (knex !== null) {
            await knex.destroy();
            knex = null;
        }
    });

    beforeEach(async () => {
        if (knex === null) {
            throw new Error("Postgres connection was not established in beforeAll");
        }
        trx = await knex.transaction();
        // Binding the store to the transaction makes even the handlers' internal
        // buildServerContext(store) (no explicit trx) run inside a savepoint of
        // this transaction, so every write rolls back — full isolation on the
        // shared cluster Postgres.
        store = new TripleStore(trx as unknown as Knex);
        ctx = buildServerContext(store, { trx });
        await seedSystemData(ctx, store);

        rbac = new RbacService({
            store,
            tenants: new TenantRepository(store),
            groups: new UserGroupRepository(store),
            roles: new RoleRepository(store),
            grants: new PolicyGrantRepository(store),
            permissions: new PermissionRepository(store),
            resources: new ResourceNodeRepository(store),
            serviceAccounts: new ServiceAccountRepository(store),
        });
        superusers = new SuperuserService(rbac);
        auth = new AuthService({
            providers: [new GoogleProvider("cid", "cs")],
            sessionStore: new MemorySessionStore(),
            users: new UserRepository(store, TEST_CIPHER),
            identities: new UserIdentityRepository(store, TEST_CIPHER),
            sessions: new UserSessionRepository(store),
            devices: new UserDeviceRepository(store),
        });
    });
    afterEach(async () => {
        if (trx !== null && !trx.isCompleted()) {
            await trx.rollback();
        }
        trx = null;
        if (knex !== null) {
            await assertEmptyStore(knex);
        }
    });

    // Mint a real session and return its raw bearer token + the user IRI.
    async function makeSession(email: string): Promise<{ token: string; userIri: string }> {
        const user = await new UserRepository(store, TEST_CIPHER).create(ctx, systemSec, { email });
        const device = await new UserDeviceRepository(store).findOrCreate(ctx, systemSec, {
            userId: user.id,
            info: {},
        });
        const session = await new UserSessionRepository(store).create(ctx, systemSec, {
            userId: user.id,
            deviceId: device.id,
            expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        });
        return { token: session.sessionToken, userIri: user.iri };
    }

    // The real AuthService.validateToken path, shaped as the WS edge consumes it
    // (exactly what AuthRouterComponent.validateToken wraps in production).
    function authLike() {
        return {
            validateToken: (token: string) => auth.validateToken(ctx, systemSec, { token }),
        };
    }

    // ── PO #1 + #3: connect-time authentication + origin allow-list ──────────

    describe("upgrade authentication (real WebSocket server)", () => {
        let app: FlowApp;
        let wsServer: WebSocketServer;
        let port: number;

        beforeEach(async () => {
            port = await freePort();
            app = new FlowApp({ mode: "push" });
            wsServer = new WebSocketServer({
                name: "ws",
                context: app.context,
                port,
                authenticate: buildWsAuthenticate(authLike()),
                allowedOrigins: [ORIGIN],
            });
            app.addComponent(wsServer);
            await app.start();
            app.scheduler.start();
        });
        afterEach(async () => {
            await app.stop();
        });

        it("rejects an anonymous upgrade with no session token (401)", async () => {
            const result = await connectWs(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
            expect(result.ok).toBe(false);
            expect(result.status).toBe(401);
        });

        it("rejects an upgrade bearing an invalid session token (401)", async () => {
            const result = await connectWs(`ws://127.0.0.1:${port}`, {
                origin: ORIGIN,
                authorization: "Bearer not-a-real-token",
            });
            expect(result.ok).toBe(false);
            expect(result.status).toBe(401);
        });

        it("rejects a cross-site upgrade before authenticating (403)", async () => {
            const { token } = await makeSession("cswsh@test.com");
            const result = await connectWs(`ws://127.0.0.1:${port}`, {
                origin: "https://evil.example.com",
                authorization: `Bearer ${token}`,
            });
            expect(result.ok).toBe(false);
            expect(result.status).toBe(403);
        });

        it("accepts a valid session token and stamps the principal on the connection", async () => {
            const { token, userIri } = await makeSession("good@test.com");
            const result = await connectWs(`ws://127.0.0.1:${port}`, {
                origin: ORIGIN,
                cookie: `tern_session=${token}`,
            });
            expect(result.ok).toBe(true);

            // The principal resolved at upgrade is the authenticated user.
            const deadline = Date.now() + 2000;
            let connId: string | undefined;
            while (connId === undefined && Date.now() < deadline) {
                connId = wsServer.connected.read();
                if (connId === undefined) {
                    await new Promise((r) => setTimeout(r, 10));
                }
            }
            expect(connId).toBeDefined();
            const principal = wsServer.getPrincipal(connId as string) as WsPrincipal | null;
            expect(secFromPrincipal(principal).principalIri).toBe(userIri);

            result.ws?.close();
        });
    });

    // ── PO #2 + #4: triple.* handlers are superuser-gated ────────────────────

    describe("triple.* superuser gate (handlers against real store)", () => {
        function handlerCtx(sec: SecurityContext) {
            return { connectionId: "c1", sec, tenantId: null, store, rbac };
        }

        it("denies triple.find / insert / stats for an anonymous principal", async () => {
            const anonCtx = handlerCtx(anonymousSec);
            const find = await handleFind(query(SYSTEM_TYPES.tripleFind, {}), anonCtx);
            const insert = await handleInsert(
                query(SYSTEM_TYPES.tripleInsert, {
                    subject: { value: "urn:x:s" },
                    predicate: { value: "urn:x:p" },
                    object: { value: "urn:x:o" },
                }),
                anonCtx,
            );
            const stats = await handleStats(query(SYSTEM_TYPES.tripleStats), anonCtx);
            for (const res of [find, insert, stats]) {
                expect(res.ok).toBe(false);
                expect(res.error).toContain("superuser");
            }
        });

        it("denies triple.find for an authenticated non-superuser", async () => {
            const { userIri } = await makeSession("plain@test.com");
            const sec: SecurityContext = {
                principalIri: userIri,
                sessionId: null,
                isImpersonating: false,
            };
            const res = await handleFind(query(SYSTEM_TYPES.tripleFind, {}), handlerCtx(sec));
            expect(res.ok).toBe(false);
            expect(res.error).toContain("superuser");
        });

        it("allows triple.find + stats for an authenticated superuser", async () => {
            const { userIri } = await makeSession("root@test.com");
            await superusers.grant(ctx, systemSec, { userIri });
            const sec: SecurityContext = {
                principalIri: userIri,
                sessionId: null,
                isImpersonating: false,
            };
            const find = await handleFind(query(SYSTEM_TYPES.tripleFind, {}), handlerCtx(sec));
            const stats = await handleStats(query(SYSTEM_TYPES.tripleStats), handlerCtx(sec));
            expect(find.ok).toBe(true);
            expect(stats.ok).toBe(true);
        });

        // PO #4 — the exact old exploit: anonymous forge of an RBAC grant quad.
        it("rejects an anonymous triple.insert of a PolicyGrant quad and writes nothing", async () => {
            const forgedSubject = "urn:sys:core:auth:user:attacker";
            const grantPredicate = "urn:sys:rbac:policygrant:hasRole";
            const req = query(SYSTEM_TYPES.tripleInsert, {
                subject: { value: forgedSubject },
                predicate: { value: grantPredicate },
                object: { value: "urn:sys:rbac:role:superuser" },
                graph: { value: "urn:sys:rbac:graph" },
            });
            const res = await handleInsert(req, handlerCtx(anonymousSec));
            expect(res.ok).toBe(false);
            expect(res.error).toContain("superuser");

            // Prove the quad never landed: no triple with the forged subject exists.
            const quads = await store.findAcrossTenants(buildServerContext(store), {
                subject: { value: forgedSubject } as never,
            });
            expect(quads).toHaveLength(0);
        });
    });

    // ── PO #2 end-to-end: sec threads through the real WS pipeline ───────────

    describe("full WS pipeline: principal → sec → superuser-gated dispatch", () => {
        let app: FlowApp;
        let wsServer: WebSocketServer;
        let registry: RbacGatedRegistry;
        let port: number;

        // A minimal real Dispatcher that routes the triple.* types to the real
        // handlers — the production wiring registers these same handlers.
        class RbacGatedRegistry {
            async dispatch(
                request: SystemRequest,
                extras: Record<string, unknown>,
            ): Promise<SystemResult> {
                const hctx = extras as unknown as Parameters<typeof handleFind>[1];
                if (request.type.iri === SYSTEM_TYPES.tripleFind.iri) {
                    return handleFind(request, hctx);
                }
                if (request.type.iri === SYSTEM_TYPES.tripleInsert.iri) {
                    return handleInsert(request, hctx);
                }
                if (request.type.iri === SYSTEM_TYPES.tripleStats.iri) {
                    return handleStats(request, hctx);
                }
                throw new Error(`unexpected type ${request.type.iri}`);
            }
        }

        beforeEach(async () => {
            port = await freePort();
            app = new FlowApp({ mode: "push" });
            wsServer = new WebSocketServer({
                name: "ws",
                context: app.context,
                port,
                authenticate: buildWsAuthenticate(authLike()),
                allowedOrigins: [ORIGIN],
            });
            registry = new RbacGatedRegistry();
            const decoder = new MessageDecoder({ name: "dec", context: app.context });
            const router = new MessageRouter({
                name: "router",
                context: app.context,
                dispatcher: registry,
                handlerContext: { store, rbac },
                resolveSec: (connectionId) => secFromPrincipal(wsServer.getPrincipal(connectionId)),
            });
            const encoder = new MessageEncoder({ name: "enc", context: app.context });
            app.addComponent(wsServer)
                .addComponent(decoder)
                .addComponent(router)
                .addComponent(encoder)
                .connect(wsServer.received, decoder.in)
                .connect(decoder.out, router.in)
                .connect(router.out, encoder.in)
                .connect(encoder.out, wsServer.send);
            await app.start();
            app.scheduler.start();
        });
        afterEach(async () => {
            await app.stop();
        });

        async function roundTrip(token: string, request: SystemRequest): Promise<SystemResult> {
            const conn = await connectWs(`ws://127.0.0.1:${port}`, {
                origin: ORIGIN,
                authorization: `Bearer ${token}`,
            });
            expect(conn.ok).toBe(true);
            const ws = conn.ws as WsClient;
            const received = new Promise<SystemResult>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("no WS reply")), 3000);
                ws.on("message", (raw: Buffer) => {
                    clearTimeout(timer);
                    resolve(JSON.parse(raw.toString("utf8")) as SystemResult);
                });
            });
            ws.send(JSON.stringify(request));
            const result = await received;
            ws.close();
            return result;
        }

        it("denies a non-superuser's triple.find over the socket", async () => {
            const { token } = await makeSession("wschannel-plain@test.com");
            const result = await roundTrip(token, query(SYSTEM_TYPES.tripleFind, {}));
            expect(result.ok).toBe(false);
            expect(result.error).toContain("superuser");
        });

        it("allows a superuser's triple.find over the socket", async () => {
            const { token, userIri } = await makeSession("wschannel-root@test.com");
            await superusers.grant(ctx, systemSec, { userIri });
            const result = await roundTrip(token, query(SYSTEM_TYPES.tripleFind, {}));
            expect(result.ok).toBe(true);
        });
    });
});
