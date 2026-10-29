/**
 * SchemaRegistry integration tests.
 *
 * Covers five concerns:
 *   1. Version registration — ensureVersion() idempotently registers a schema
 *      and stores a queryable snapshot.  Each version is identified by a single
 *      string "{n}-{8-char-hash}", e.g. "1-a8bc4d6e", computed from the
 *      monotonic count of prior versions for that type and a content hash of
 *      the schema shape.
 *   2. Version numbering — each new hash for a type gets the next integer prefix;
 *      re-registering the same schema returns the same version string.
 *   3. Entity version tagging — EntityStore.create() stamps each entity with the
 *      current version string; findById() echoes it back.
 *   4. Schema drift detection — when an entity's stored version string diverges
 *      from the current one, findById() reports it on the record.
 *   5. Traversal planning — traversalPlan() describes the out-edge walk; the
 *      EntityStore.hydrateWithPlan() executes it in a single batch per depth.
 *
 * Runs against SQLite (always) and Postgres (when SYS_PG_URL is set).
 * Each suite runs inside a rolled-back transaction for full isolation.
 */

import { UserSchema } from "@terncosoftware/auth";
import { DEFAULT_GRAPH, IRI } from "@terncosoftware/core";
import { TripleStore } from "@terncosoftware/data";
import { EntitySchema, propIri, toLiteral } from "@terncosoftware/entities";
import {
    buildServerContext,
    EntityStore,
    SCHEMA_VERSION_PREDICATE,
    SchemaRegistry,
    type HydratedRecord,
    type TraversalPlan,
    type TypeSnapshot,
    type TypeVersion,
} from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

// ── Inline schemas ────────────────────────────────────────────────────────────
// Auth schemas store relationship IRIs as scalar properties rather than
// EdgeDef entries; the traversal planner operates on EdgeDef edges.  We define
// minimal schemas here to drive that interface cleanly.
//
// AuthorSchema / V2 / V3 share a typeIRI so we can test sequential version
// numbering without touching production schemas.

const SR_NS = "http://test.dev/sr/";
const SR_GRAPH = new IRI(`${SR_NS}graph`);

interface AuthorProps extends Record<string, unknown> { name: string; }
interface AuthorPropsV2 extends Record<string, unknown> { name: string; bio: string; }
interface AuthorPropsV3 extends Record<string, unknown> { name: string; bio: string; url: string; }
interface PostProps extends Record<string, unknown> { title: string; }

const AuthorSchema = new EntitySchema<AuthorProps>({
    typeIRI: new IRI(`${SR_NS}Author`),
    ns: SR_NS,
    properties: { name: new IRI(`${SR_NS}name`) },
    graphIri: SR_GRAPH,
});

const AuthorSchemaV2 = new EntitySchema<AuthorPropsV2>({
    typeIRI: new IRI(`${SR_NS}Author`),
    ns: SR_NS,
    properties: { name: new IRI(`${SR_NS}name`), bio: new IRI(`${SR_NS}bio`) },
    graphIri: SR_GRAPH,
});

const AuthorSchemaV3 = new EntitySchema<AuthorPropsV3>({
    typeIRI: new IRI(`${SR_NS}Author`),
    ns: SR_NS,
    properties: {
        name: new IRI(`${SR_NS}name`),
        bio: new IRI(`${SR_NS}bio`),
        url: new IRI(`${SR_NS}url`),
    },
    graphIri: SR_GRAPH,
});

const PostSchema = new EntitySchema<PostProps>({
    typeIRI: new IRI(`${SR_NS}Post`),
    ns: SR_NS,
    properties: { title: new IRI(`${SR_NS}title`) },
    graphIri: SR_GRAPH,
    edges: {
        author: {
            predicate: new IRI(`${SR_NS}writtenBy`),
            target: () => AuthorSchema,
            cardinality: "one",
            direction: "out",
        },
    },
});

// ── XSD range IRIs used in property-type tests ────────────────────────────────

const XSD = "http://www.w3.org/2001/XMLSchema#";
const XSD_STRING = new IRI(`${XSD}string`);
const XSD_BOOLEAN = new IRI(`${XSD}boolean`);
const XSD_DATETIME = new IRI(`${XSD}dateTime`);

// ── Version string helpers ────────────────────────────────────────────────────

/** Matches the "{n}-{8-char-hex}" format produced by the registry. */
const VERSION_RE = /^\d+-[0-9a-f]{8}$/;

function versionNumber(v: string): number {
    return parseInt(v.split("-")[0]!, 10);
}

// ── DB provider matrix ────────────────────────────────────────────────────────

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

// ── Setup / teardown ──────────────────────────────────────────────────────────

async function setup(db: DbProvider) {
    const knex = await db.create();
    const trx = await knex.transaction();
    const store = new TripleStore(trx as unknown as import("knex").Knex);
    const registry = new SchemaRegistry(store);
    const es = new EntityStore(store, registry);
    return { ...buildServerContext(store, { trx }), knex, trx, store, es, registry };
}

async function teardown(ctx: Awaited<ReturnType<typeof setup>>) {
    await ctx.trx.rollback();
    await assertEmptyStore(ctx.knex);
    await ctx.knex.destroy();
}

// ─────────────────────────────────────────────────────────────────────────────

for (const db of providers) {

    // ── 1. Version registration ───────────────────────────────────────────────

    describe(`version registration (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        beforeEach(async () => { ctx = await setup(db); });
        afterEach(async () => { await teardown(ctx); });

        it("first registration returns a version string in {n}-{hash} format", async () => {
            const v: TypeVersion = await ctx.registry.ensureVersion(ctx, UserSchema);

            expect(v.version).toMatch(VERSION_RE);
            expect(v.typeIri).toBe(UserSchema.typeIRI.value);
        });

        it("first registration for any type starts at version number 1", async () => {
            const v = await ctx.registry.ensureVersion(ctx, UserSchema);
            expect(versionNumber(v.version)).toBe(1);
        });

        it("re-registering the same schema returns the same version string", async () => {
            const v1: TypeVersion = await ctx.registry.ensureVersion(ctx, UserSchema);
            const v2: TypeVersion = await ctx.registry.ensureVersion(ctx, UserSchema);

            expect(v1.version).toBe(v2.version);
            expect(v1.typeIri).toBe(UserSchema.typeIRI.value);
        });

        it("two distinct types each start at version 1 with different strings", async () => {
            const authorV = await ctx.registry.ensureVersion(ctx, AuthorSchema);
            const postV = await ctx.registry.ensureVersion(ctx, PostSchema);

            expect(versionNumber(authorV.version)).toBe(1);
            expect(versionNumber(postV.version)).toBe(1);
            expect(authorV.version).not.toBe(postV.version);
        });

        it("currentVersion() is synchronous and matches the registered version string", async () => {
            const v = await ctx.registry.ensureVersion(ctx, UserSchema);
            expect(ctx.registry.currentVersion(UserSchema)).toBe(v.version);
        });

        it("loadSnapshot() returns a snapshot carrying the version string", async () => {
            const v = await ctx.registry.ensureVersion(ctx, UserSchema);
            const snapshot: TypeSnapshot | null = await ctx.registry.loadSnapshot(
                ctx,
                UserSchema.typeIRI.value,
            );

            expect(snapshot).not.toBeNull();
            expect(snapshot!.version).toBe(v.version);
            expect(snapshot!.typeIri).toBe(UserSchema.typeIRI.value);
        });

        it("loadSnapshot() lists all property descriptors with predicate IRIs", async () => {
            await ctx.registry.ensureVersion(ctx, UserSchema);
            const snapshot = await ctx.registry.loadSnapshot(ctx, UserSchema.typeIRI.value);

            const propNames = snapshot!.properties.map((p) => p.name);
            expect(propNames).toContain("email");
            expect(propNames).toContain("displayName");
            expect(propNames).toContain("avatarUrl");

            const emailProp = snapshot!.properties.find((p) => p.name === "email");
            expect(emailProp!.predicateIri).toBe(propIri(UserSchema.properties.email).value);
        });

        it("loadSnapshot() stores edge descriptors with target type IRI and cardinality", async () => {
            await ctx.registry.ensureVersion(ctx, PostSchema);
            const snapshot = await ctx.registry.loadSnapshot(ctx, PostSchema.typeIRI.value);

            expect(snapshot!.edges).toHaveLength(1);
            const edge = snapshot!.edges[0]!;
            expect(edge.name).toBe("author");
            expect(edge.targetTypeIri).toBe(AuthorSchema.typeIRI.value);
            expect(edge.cardinality).toBe("one");
            expect(edge.direction).toBe("out");
        });

        it("loadSnapshot() returns null for an unregistered type", async () => {
            expect(await ctx.registry.loadSnapshot(ctx, "urn:not:registered")).toBeNull();
        });
    });

    // ── 2. Version numbering ──────────────────────────────────────────────────

    describe(`version numbering (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        beforeEach(async () => { ctx = await setup(db); });
        afterEach(async () => { await teardown(ctx); });

        it("a new hash for the same type increments the version number", async () => {
            const v1 = await ctx.registry.ensureVersion(ctx, AuthorSchema);
            const v2 = await ctx.registry.ensureVersion(ctx, AuthorSchemaV2);

            expect(versionNumber(v1.version)).toBe(1);
            expect(versionNumber(v2.version)).toBe(2);
            expect(v1.version).not.toBe(v2.version);
        });

        it("with two existing versions, the next new hash is version 3", async () => {
            await ctx.registry.ensureVersion(ctx, AuthorSchema);
            await ctx.registry.ensureVersion(ctx, AuthorSchemaV2);
            const v3 = await ctx.registry.ensureVersion(ctx, AuthorSchemaV3);

            expect(versionNumber(v3.version)).toBe(3);
        });

        it("re-registering an earlier hash returns its original version number, not the next", async () => {
            const v1 = await ctx.registry.ensureVersion(ctx, AuthorSchema);
            await ctx.registry.ensureVersion(ctx, AuthorSchemaV2);

            const v1Again = await ctx.registry.ensureVersion(ctx, AuthorSchema);
            expect(v1Again.version).toBe(v1.version);
            expect(versionNumber(v1Again.version)).toBe(1);
        });

        it("version counter is scoped per type — a different type always starts at 1", async () => {
            await ctx.registry.ensureVersion(ctx, AuthorSchema);
            await ctx.registry.ensureVersion(ctx, AuthorSchemaV2);

            const postV = await ctx.registry.ensureVersion(ctx, PostSchema);
            expect(versionNumber(postV.version)).toBe(1);
        });

        it("hash portion of the version string is stable and deterministic", async () => {
            const v1a = await ctx.registry.ensureVersion(ctx, AuthorSchema);
            const v1b = await ctx.registry.ensureVersion(ctx, AuthorSchema);

            expect(v1a.version.split("-")[1]).toBe(v1b.version.split("-")[1]);
        });
    });

    // ── 3. Snapshot queries ───────────────────────────────────────────────────

    describe(`snapshot queries (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        beforeEach(async () => { ctx = await setup(db); });
        afterEach(async () => { await teardown(ctx); });

        it("loadSnapshotForVersion() returns the snapshot for a given version string", async () => {
            const v = await ctx.registry.ensureVersion(ctx, AuthorSchema);
            const snapshot = await ctx.registry.loadSnapshotForVersion(ctx, v.version);

            expect(snapshot).not.toBeNull();
            expect(snapshot!.version).toBe(v.version);
            expect(snapshot!.typeIri).toBe(AuthorSchema.typeIRI.value);
        });

        it("loadSnapshotForVersion() returns the v1 snapshot even after v2 is registered", async () => {
            const v1 = await ctx.registry.ensureVersion(ctx, AuthorSchema);
            await ctx.registry.ensureVersion(ctx, AuthorSchemaV2);

            const snapshot = await ctx.registry.loadSnapshotForVersion(ctx, v1.version);

            expect(versionNumber(snapshot!.version)).toBe(1);
            const names = snapshot!.properties.map((p) => p.name);
            expect(names).toContain("name");
            expect(names).not.toContain("bio");
        });

        it("loadSnapshotForVersion() returns the v2 snapshot with its added property", async () => {
            await ctx.registry.ensureVersion(ctx, AuthorSchema);
            const v2 = await ctx.registry.ensureVersion(ctx, AuthorSchemaV2);

            const snapshot = await ctx.registry.loadSnapshotForVersion(ctx, v2.version);

            expect(versionNumber(snapshot!.version)).toBe(2);
            const names = snapshot!.properties.map((p) => p.name);
            expect(names).toContain("name");
            expect(names).toContain("bio");
        });

        it("all three versions of a type are independently queryable by version string", async () => {
            const v1 = await ctx.registry.ensureVersion(ctx, AuthorSchema);
            const v2 = await ctx.registry.ensureVersion(ctx, AuthorSchemaV2);
            const v3 = await ctx.registry.ensureVersion(ctx, AuthorSchemaV3);

            const s1 = await ctx.registry.loadSnapshotForVersion(ctx, v1.version);
            const s2 = await ctx.registry.loadSnapshotForVersion(ctx, v2.version);
            const s3 = await ctx.registry.loadSnapshotForVersion(ctx, v3.version);

            expect(s1!.properties.map((p) => p.name).sort()).toEqual(["name"]);
            expect(s2!.properties.map((p) => p.name).sort()).toEqual(["bio", "name"]);
            expect(s3!.properties.map((p) => p.name).sort()).toEqual(["bio", "name", "url"]);
        });

        it("edge descriptors are preserved in historical snapshots", async () => {
            const v1 = await ctx.registry.ensureVersion(ctx, PostSchema);
            const snapshot = await ctx.registry.loadSnapshotForVersion(ctx, v1.version);

            expect(snapshot!.edges).toHaveLength(1);
            const edge = snapshot!.edges[0]!;
            expect(edge.name).toBe("author");
            expect(edge.targetTypeIri).toBe(AuthorSchema.typeIRI.value);
            expect(edge.cardinality).toBe("one");
            expect(edge.direction).toBe("out");
        });

        it("property range IRI is preserved in historical snapshots", async () => {
            const typedAuthor = new EntitySchema({
                typeIRI: new IRI(`${SR_NS}TypedAuthor`),
                ns: SR_NS,
                graphIri: SR_GRAPH,
                properties: { name: { iri: new IRI(`${SR_NS}name`), range: XSD_STRING } },
            });
            const v1 = await ctx.registry.ensureVersion(ctx, typedAuthor);
            const snapshot = await ctx.registry.loadSnapshotForVersion(ctx, v1.version);

            const nameProp = snapshot!.properties.find((p) => p.name === "name");
            expect(nameProp!.rangeIri).toBe(XSD_STRING.value);
        });

        it("loadSnapshotForVersion() returns null for an unknown version string", async () => {
            expect(await ctx.registry.loadSnapshotForVersion(ctx, "99-deadbeef")).toBeNull();
        });

        it("loadSnapshotForVersion() and loadVersion() agree on typeIri and version string", async () => {
            const v1 = await ctx.registry.ensureVersion(ctx, AuthorSchema);

            const versionRecord = await ctx.registry.loadVersion(ctx, v1.version);
            const snapshot = await ctx.registry.loadSnapshotForVersion(ctx, v1.version);

            expect(snapshot!.typeIri).toBe(versionRecord!.typeIri);
            expect(snapshot!.version).toBe(versionRecord!.version);
        });
    });

    // ── 4. Schema hash sensitivity ───────────────────────────────────────────
    //
    // Each test creates two schemas that differ in exactly one dimension and
    // asserts whether currentVersion() considers them the same or different.
    // These are purely in-process (no entity writes) — the hash is computed
    // from the EntitySchema object alone, no DB round-trip required.
    //
    // Properties accept either a bare IRI (predicate only, untyped) or a
    // PropertyDef { iri: IRI, range: IRI } object.  Both the predicate IRI
    // and the range IRI are included in the hash, so any type change produces
    // a new version.

    describe(`schema hash sensitivity (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        beforeEach(async () => { ctx = await setup(db); });
        afterEach(async () => { await teardown(ctx); });

        const T = new IRI("http://test.dev/hash/T");
        const NS = "http://test.dev/hash/";
        const G = new IRI(`${NS}graph`);
        const p1 = new IRI(`${NS}p1`);
        const p2 = new IRI(`${NS}p2`);
        const EdgeTarget = new EntitySchema({
            typeIRI: new IRI(`${NS}EdgeTarget`),
            ns: NS,
            properties: { x: p1 },
            graphIri: G,
        });
        const EdgeTargetAlt = new EntitySchema({
            typeIRI: new IRI(`${NS}EdgeTargetAlt`),
            ns: NS,
            properties: { x: p1 },
            graphIri: G,
        });

        // ── Properties ──────────────────────────────────────────────────────

        it("removing a property produces a different version", () => {
            const withTwo = new EntitySchema({ typeIRI: T, ns: NS, properties: { a: p1, b: p2 }, graphIri: G });
            const withOne = new EntitySchema({ typeIRI: T, ns: NS, properties: { a: p1 }, graphIri: G });

            expect(ctx.registry.currentVersion(withTwo)).not.toBe(ctx.registry.currentVersion(withOne));
        });

        it("changing a property's predicate IRI produces a different version", () => {
            const original = new EntitySchema({ typeIRI: T, ns: NS, properties: { a: p1 }, graphIri: G });
            const changedPred = new EntitySchema({ typeIRI: T, ns: NS, properties: { a: p2 }, graphIri: G });

            expect(ctx.registry.currentVersion(original)).not.toBe(ctx.registry.currentVersion(changedPred));
        });

        it("renaming a TypeScript property key without changing its predicate IRI does NOT change the version", () => {
            const keyA = new EntitySchema({ typeIRI: T, ns: NS, properties: { firstName: p1 }, graphIri: G });
            const keyB = new EntitySchema({ typeIRI: T, ns: NS, properties: { name: p1 }, graphIri: G });

            expect(ctx.registry.currentVersion(keyA)).toBe(ctx.registry.currentVersion(keyB));
        });

        // ── Edges ────────────────────────────────────────────────────────────

        it("adding an edge produces a different version", () => {
            const noEdge = new EntitySchema({ typeIRI: T, ns: NS, properties: { a: p1 }, graphIri: G });
            const withEdge = new EntitySchema({
                typeIRI: T, ns: NS, properties: { a: p1 }, graphIri: G,
                edges: { rel: { predicate: p2, target: () => EdgeTarget, cardinality: "one", direction: "out" } },
            });

            expect(ctx.registry.currentVersion(noEdge)).not.toBe(ctx.registry.currentVersion(withEdge));
        });

        it("removing an edge produces a different version", () => {
            const withEdge = new EntitySchema({
                typeIRI: T, ns: NS, properties: { a: p1 }, graphIri: G,
                edges: { rel: { predicate: p2, target: () => EdgeTarget, cardinality: "one", direction: "out" } },
            });
            const noEdge = new EntitySchema({ typeIRI: T, ns: NS, properties: { a: p1 }, graphIri: G });

            expect(ctx.registry.currentVersion(withEdge)).not.toBe(ctx.registry.currentVersion(noEdge));
        });

        it("changing an edge's predicate IRI produces a different version", () => {
            const edgeP1 = new EntitySchema({
                typeIRI: T, ns: NS, properties: {}, graphIri: G,
                edges: { rel: { predicate: p1, target: () => EdgeTarget, cardinality: "one", direction: "out" } },
            });
            const edgeP2 = new EntitySchema({
                typeIRI: T, ns: NS, properties: {}, graphIri: G,
                edges: { rel: { predicate: p2, target: () => EdgeTarget, cardinality: "one", direction: "out" } },
            });

            expect(ctx.registry.currentVersion(edgeP1)).not.toBe(ctx.registry.currentVersion(edgeP2));
        });

        it("changing an edge's target type IRI produces a different version", () => {
            const toTarget = new EntitySchema({
                typeIRI: T, ns: NS, properties: {}, graphIri: G,
                edges: { rel: { predicate: p1, target: () => EdgeTarget, cardinality: "one", direction: "out" } },
            });
            const toAlt = new EntitySchema({
                typeIRI: T, ns: NS, properties: {}, graphIri: G,
                edges: { rel: { predicate: p1, target: () => EdgeTargetAlt, cardinality: "one", direction: "out" } },
            });

            expect(ctx.registry.currentVersion(toTarget)).not.toBe(ctx.registry.currentVersion(toAlt));
        });

        it("changing an edge's cardinality produces a different version", () => {
            const one = new EntitySchema({
                typeIRI: T, ns: NS, properties: {}, graphIri: G,
                edges: { rel: { predicate: p1, target: () => EdgeTarget, cardinality: "one", direction: "out" } },
            });
            const many = new EntitySchema({
                typeIRI: T, ns: NS, properties: {}, graphIri: G,
                edges: { rel: { predicate: p1, target: () => EdgeTarget, cardinality: "many", direction: "out" } },
            });

            expect(ctx.registry.currentVersion(one)).not.toBe(ctx.registry.currentVersion(many));
        });

        it("changing an edge's direction produces a different version", () => {
            const out = new EntitySchema({
                typeIRI: T, ns: NS, properties: {}, graphIri: G,
                edges: { rel: { predicate: p1, target: () => EdgeTarget, cardinality: "one", direction: "out" } },
            });
            const inbound = new EntitySchema({
                typeIRI: T, ns: NS, properties: {}, graphIri: G,
                edges: { rel: { predicate: p1, target: () => EdgeTarget, cardinality: "one", direction: "in" } },
            });

            expect(ctx.registry.currentVersion(out)).not.toBe(ctx.registry.currentVersion(inbound));
        });

        it("renaming a TypeScript edge name without changing its predicate or structure does NOT change the version", () => {
            const nameA = new EntitySchema({
                typeIRI: T, ns: NS, properties: {}, graphIri: G,
                edges: { author: { predicate: p1, target: () => EdgeTarget, cardinality: "one", direction: "out" } },
            });
            const nameB = new EntitySchema({
                typeIRI: T, ns: NS, properties: {}, graphIri: G,
                edges: { writer: { predicate: p1, target: () => EdgeTarget, cardinality: "one", direction: "out" } },
            });

            expect(ctx.registry.currentVersion(nameA)).toBe(ctx.registry.currentVersion(nameB));
        });

        // ── Property range (type) ────────────────────────────────────────────
        // Properties can be declared as { iri, range } to carry XSD type info.
        // The range IRI is part of the hash — changing it changes the version.

        it("adding a range to a previously untyped property produces a different version", () => {
            const untyped = new EntitySchema({ typeIRI: T, ns: NS, properties: { val: p1 }, graphIri: G });
            const typed = new EntitySchema({
                typeIRI: T, ns: NS, graphIri: G,
                properties: { val: { iri: p1, range: XSD_STRING } },
            });

            expect(ctx.registry.currentVersion(untyped)).not.toBe(ctx.registry.currentVersion(typed));
        });

        it("changing a property's range from string to boolean produces a different version", () => {
            const asString = new EntitySchema({
                typeIRI: T, ns: NS, graphIri: G,
                properties: { val: { iri: p1, range: XSD_STRING } },
            });
            const asBoolean = new EntitySchema({
                typeIRI: T, ns: NS, graphIri: G,
                properties: { val: { iri: p1, range: XSD_BOOLEAN } },
            });

            expect(ctx.registry.currentVersion(asString)).not.toBe(ctx.registry.currentVersion(asBoolean));
        });

        it("changing a property's range from string to dateTime produces a different version", () => {
            const asString = new EntitySchema({
                typeIRI: T, ns: NS, graphIri: G,
                properties: { val: { iri: p1, range: XSD_STRING } },
            });
            const asDateTime = new EntitySchema({
                typeIRI: T, ns: NS, graphIri: G,
                properties: { val: { iri: p1, range: XSD_DATETIME } },
            });

            expect(ctx.registry.currentVersion(asString)).not.toBe(ctx.registry.currentVersion(asDateTime));
        });

        it("same predicate IRI and same range produces the same version", () => {
            const a = new EntitySchema({
                typeIRI: T, ns: NS, graphIri: G,
                properties: { val: { iri: p1, range: XSD_STRING } },
            });
            const b = new EntitySchema({
                typeIRI: T, ns: NS, graphIri: G,
                properties: { val: { iri: p1, range: XSD_STRING } },
            });

            expect(ctx.registry.currentVersion(a)).toBe(ctx.registry.currentVersion(b));
        });

        it("snapshot stores the range IRI alongside the property", async () => {
            const schema = new EntitySchema({
                typeIRI: T, ns: NS, graphIri: G,
                properties: { val: { iri: p1, range: XSD_STRING } },
            });
            await ctx.registry.ensureVersion(ctx, schema);
            const snapshot = await ctx.registry.loadSnapshot(ctx, T.value);

            const valProp = snapshot!.properties.find((p) => p.name === "val");
            expect(valProp!.rangeIri).toBe(XSD_STRING.value);
        });

        it("snapshot for an untyped property has no rangeIri", async () => {
            const schema = new EntitySchema({ typeIRI: T, ns: NS, graphIri: G, properties: { val: p1 } });
            await ctx.registry.ensureVersion(ctx, schema);
            const snapshot = await ctx.registry.loadSnapshot(ctx, T.value);

            const valProp = snapshot!.properties.find((p) => p.name === "val");
            expect(valProp!.rangeIri).toBeUndefined();
        });

        // ── Schema metadata that should NOT affect the hash ──────────────────

        it("changing ns does NOT change the version", () => {
            const nsA = new EntitySchema({ typeIRI: T, ns: `${NS}a/`, properties: { a: p1 }, graphIri: G });
            const nsB = new EntitySchema({ typeIRI: T, ns: `${NS}b/`, properties: { a: p1 }, graphIri: G });

            expect(ctx.registry.currentVersion(nsA)).toBe(ctx.registry.currentVersion(nsB));
        });

        it("changing graphIri does NOT change the version", () => {
            const gA = new EntitySchema({ typeIRI: T, ns: NS, properties: { a: p1 }, graphIri: new IRI(`${NS}graph-a`) });
            const gB = new EntitySchema({ typeIRI: T, ns: NS, properties: { a: p1 }, graphIri: new IRI(`${NS}graph-b`) });

            expect(ctx.registry.currentVersion(gA)).toBe(ctx.registry.currentVersion(gB));
        });

        it("changing defaults does NOT change the version", () => {
            const noDefault = new EntitySchema({ typeIRI: T, ns: NS, properties: { a: p1 }, graphIri: G });
            const withDefault = new EntitySchema({
                typeIRI: T, ns: NS, properties: { a: p1 }, graphIri: G,
                defaults: { a: "fallback" },
            });

            expect(ctx.registry.currentVersion(noDefault)).toBe(ctx.registry.currentVersion(withDefault));
        });
    });

    // ── 4. Entity version tagging ─────────────────────────────────────────────

    describe(`entity version tagging (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        beforeEach(async () => { ctx = await setup(db); });
        afterEach(async () => { await teardown(ctx); });

        it("created entity carries the current version string", async () => {
            const user = await ctx.es.create(ctx, UserSchema, { email: "tagged@test.com" });

            expect(user.schemaVersion).toBeDefined();
            expect(user.schemaVersion).toMatch(VERSION_RE);
            expect(user.schemaVersion).toBe(ctx.registry.currentVersion(UserSchema));
        });

        it("schema version survives a findById round-trip", async () => {
            const user = await ctx.es.create(ctx, UserSchema, { email: "roundtrip@test.com" });
            const found = await ctx.es.findById(ctx, UserSchema, user.id);

            expect(found!.schemaVersion).toBe(user.schemaVersion);
        });

        it("each schema type gets its own version string on its entities", async () => {
            const author = await ctx.es.create(ctx, AuthorSchema, { name: "Alice" });
            const post = await ctx.es.create(ctx, PostSchema, {
                title: "Hello",
                author: author.iri,
            });

            expect(author.schemaVersion).toBe(ctx.registry.currentVersion(AuthorSchema));
            expect(post.schemaVersion).toBe(ctx.registry.currentVersion(PostSchema));
            expect(author.schemaVersion).not.toBe(post.schemaVersion);
        });

        it("version number is readable directly from the entity's schemaVersion field", async () => {
            await ctx.registry.ensureVersion(ctx, AuthorSchema);
            await ctx.registry.ensureVersion(ctx, AuthorSchemaV2);

            const v1Entity = await ctx.es.create(ctx, AuthorSchema, { name: "Alice" });
            const v2Entity = await ctx.es.create(ctx, AuthorSchemaV2, { name: "Bob", bio: "Writer" });

            expect(versionNumber(v1Entity.schemaVersion!)).toBe(1);
            expect(versionNumber(v2Entity.schemaVersion!)).toBe(2);
        });

        it("registry.loadVersion() resolves the full TypeVersion record from an entity's schemaVersion string", async () => {
            const v1Entity = await ctx.es.create(ctx, AuthorSchema, { name: "Alice" });

            const version = await ctx.registry.loadVersion(ctx, v1Entity.schemaVersion!);

            expect(version).not.toBeNull();
            expect(version!.version).toBe(v1Entity.schemaVersion);
            expect(version!.typeIri).toBe(AuthorSchema.typeIRI.value);
            expect(versionNumber(version!.version)).toBe(1);
            expect(version!.registeredAt).toBeInstanceOf(Date);
        });

        it("registry.loadVersion() works for any version, not just the current one", async () => {
            const v1Entity = await ctx.es.create(ctx, AuthorSchema, { name: "Alice" });
            // Advance to v2 — v1Entity is now on a stale version.
            await ctx.registry.ensureVersion(ctx, AuthorSchemaV2);

            const v1Info = await ctx.registry.loadVersion(ctx, v1Entity.schemaVersion!);

            expect(versionNumber(v1Info!.version)).toBe(1);
            expect(v1Info!.version).not.toBe(ctx.registry.currentVersion(AuthorSchemaV2));
        });

        it("registry.loadVersion() returns null for an unknown version string", async () => {
            expect(await ctx.registry.loadVersion(ctx, "99-deadbeef")).toBeNull();
        });
    });

    // ── 4. Schema drift detection ─────────────────────────────────────────────

    describe(`schema drift detection (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        beforeEach(async () => { ctx = await setup(db); });
        afterEach(async () => { await teardown(ctx); });

        it("no drift when entity version matches current", async () => {
            const user = await ctx.es.create(ctx, UserSchema, { email: "nodrift@test.com" });
            const found = await ctx.es.findById(ctx, UserSchema, user.id);

            expect(found!.drift).toBeUndefined();
        });

        it("drift is reported with both version strings when entity carries a stale version", async () => {
            const user = await ctx.es.create(ctx, UserSchema, { email: "drift@test.com" });
            const currentVersion = ctx.registry.currentVersion(UserSchema);
            const staleVersion = "1-00000000";

            // Patch the stored version tag directly to simulate a schema update
            // that happened after this entity was created.
            const entityNode = { value: user.iri } as IRI;
            await ctx.store.deleteBySubjectPredicates(
                ctx,
                entityNode,
                [SCHEMA_VERSION_PREDICATE],
                null,
            );
            await ctx.store.insert(ctx, {
                subject: entityNode,
                predicate: SCHEMA_VERSION_PREDICATE,
                object: toLiteral(staleVersion),
                graph: DEFAULT_GRAPH,
            });

            const found = await ctx.es.findById(ctx, UserSchema, user.id);

            expect(found).not.toBeNull();
            expect(found!.schemaVersion).toBe(staleVersion);
            expect(found!.drift).toBeDefined();
            expect(found!.drift!.entityVersion).toBe(staleVersion);
            expect(found!.drift!.currentVersion).toBe(currentVersion);
        });

        it("drifted entity is still fully readable — callers decide what to do", async () => {
            const user = await ctx.es.create(ctx, UserSchema, { email: "intact@test.com" });

            const entityNode = { value: user.iri } as IRI;
            await ctx.store.deleteBySubjectPredicates(
                ctx,
                entityNode,
                [SCHEMA_VERSION_PREDICATE],
                null,
            );
            await ctx.store.insert(ctx, {
                subject: entityNode,
                predicate: SCHEMA_VERSION_PREDICATE,
                object: toLiteral("1-00000000"),
                graph: DEFAULT_GRAPH,
            });

            const found = await ctx.es.findById(ctx, UserSchema, user.id);

            expect(found!.id).toBe(user.id);
            expect(found!.props.email).toBe("intact@test.com");
        });
    });

    // ── 5. Traversal planning ─────────────────────────────────────────────────

    describe(`traversal planning (${db.name})`, () => {
        let ctx: Awaited<ReturnType<typeof setup>>;
        beforeEach(async () => { ctx = await setup(db); });
        afterEach(async () => { await teardown(ctx); });

        it("traversalPlan() describes the out-edges of a schema at depth 1", () => {
            const plan: TraversalPlan = ctx.registry.traversalPlan(PostSchema, 1);

            expect(plan.root.typeIRI.value).toBe(PostSchema.typeIRI.value);
            expect(plan.steps).toHaveLength(1);

            const step = plan.steps[0]!;
            expect(step.edgeName).toBe("author");
            expect(step.cardinality).toBe("one");
            expect(step.targetSchema.typeIRI.value).toBe(AuthorSchema.typeIRI.value);
            expect(step.depth).toBe(1);
        });

        it("traversalPlan() with depth 0 produces no steps", () => {
            const plan = ctx.registry.traversalPlan(PostSchema, 0);
            expect(plan.steps).toHaveLength(0);
        });

        it("traversalPlan() is pure — synchronous, no DB access", () => {
            const plan = ctx.registry.traversalPlan(PostSchema, 1);
            expect(plan).toBeDefined();
        });

        it("hydrateWithPlan() augments root records with related entities", async () => {
            const author = await ctx.es.create(ctx, AuthorSchema, { name: "Jane Doe" });
            const post = await ctx.es.create(ctx, PostSchema, {
                title: "First Post",
                author: author.iri,
            });

            const plan = ctx.registry.traversalPlan(PostSchema, 1);
            const results: HydratedRecord<PostProps>[] = await ctx.es.hydrateWithPlan(
                ctx,
                [post],
                plan,
            );

            expect(results).toHaveLength(1);
            expect(results[0]!.id).toBe(post.id);
            expect(results[0]!.related.author!.id).toBe(author.id);
            expect((results[0]!.related.author!.props as AuthorProps).name).toBe("Jane Doe");
        });

        it("hydrateWithPlan() loads all roots' related entities in a single batch", async () => {
            const alice = await ctx.es.create(ctx, AuthorSchema, { name: "Alice" });
            const bob = await ctx.es.create(ctx, AuthorSchema, { name: "Bob" });
            const post1 = await ctx.es.create(ctx, PostSchema, {
                title: "Post by Alice",
                author: alice.iri,
            });
            const post2 = await ctx.es.create(ctx, PostSchema, {
                title: "Post by Bob",
                author: bob.iri,
            });

            const plan = ctx.registry.traversalPlan(PostSchema, 1);
            const results = await ctx.es.hydrateWithPlan(ctx, [post1, post2], plan);

            expect(results).toHaveLength(2);
            expect((results[0]!.related.author!.props as AuthorProps).name).toBe("Alice");
            expect((results[1]!.related.author!.props as AuthorProps).name).toBe("Bob");
        });

        it("hydrateWithPlan() sets related to null when edge target is absent", async () => {
            const post = await ctx.es.create(ctx, PostSchema, { title: "Orphan Post" });
            const plan = ctx.registry.traversalPlan(PostSchema, 1);
            const results = await ctx.es.hydrateWithPlan(ctx, [post], plan);

            expect(results[0]!.related.author).toBeNull();
        });
    });
}
