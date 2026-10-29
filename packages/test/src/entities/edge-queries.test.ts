/**
 * Topological query tests: connectedTo (edge equality) and within (subtree
 * reachability).  These replace `.where('fooId', '=', …)` and ad-hoc parent
 * walks with edge- and reachability-based filters evaluated in the store.
 * Runs against SQLite (always) and Postgres (when SYS_PG_URL is set).
 */

import { IRI } from "@terncosoftware/core";
import { TripleStore } from "@terncosoftware/data";
import { EntitySchema } from "@terncosoftware/entities";
import {
    buildServerContext,
    EntityQuery,
    EntityStore,
    type ServerContext,
} from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

// ── Schemas ─────────────────────────────────────────────────────────────────────

const RNS = "http://test.dev/res/";
interface ResProps extends Record<string, unknown> {
    name: string;
}
const ResourceSchema: EntitySchema<ResProps> = new EntitySchema<ResProps>({
    typeIRI: new IRI(`${RNS}Resource`),
    ns: RNS,
    properties: { name: new IRI(`${RNS}name`) },
    edges: {
        parent: {
            predicate: new IRI(`${RNS}parent`),
            target: () => ResourceSchema,
            cardinality: "one",
            direction: "out",
        },
    },
});

const LNS = "http://test.dev/lib2/";
interface AuthorProps extends Record<string, unknown> {
    name: string;
}
interface BookProps extends Record<string, unknown> {
    title: string;
}
const AuthorSchema = new EntitySchema<AuthorProps>({
    typeIRI: new IRI(`${LNS}Author`),
    ns: LNS,
    properties: { name: new IRI(`${LNS}name`) },
});
const BookSchema = new EntitySchema<BookProps>({
    typeIRI: new IRI(`${LNS}Book`),
    ns: LNS,
    properties: { title: new IRI(`${LNS}title`) },
    edges: {
        author: {
            predicate: new IRI(`${LNS}writtenBy`),
            target: () => AuthorSchema,
            cardinality: "one",
            direction: "out",
        },
    },
});

// ── Provider matrix ─────────────────────────────────────────────────────────────

interface Provider {
    name: string;
    create(): Promise<Knex>;
}
const providers: Provider[] = [
    {
        name: "SQLite",
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
    describe(`EntityQuery topology — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let store: TripleStore;
        let es: EntityStore;
        let ctx: ServerContext;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            store = new TripleStore(knex);
            es = new EntityStore(store);
            ctx = buildServerContext(store, { trx });
        });
        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        function names(records: { props: { name: string } }[]): string[] {
            return records.map((r) => r.props.name).sort();
        }

        // root → a → {a1, a2}; root → b
        async function seedTree() {
            const root = await es.create(ctx, ResourceSchema, { name: "root" });
            const a = await es.create(ctx, ResourceSchema, { name: "a", parent: root.id });
            const b = await es.create(ctx, ResourceSchema, { name: "b", parent: root.id });
            const a1 = await es.create(ctx, ResourceSchema, { name: "a1", parent: a.id });
            const a2 = await es.create(ctx, ResourceSchema, { name: "a2", parent: a.id });
            return { root, a, b, a1, a2 };
        }

        it("connectedTo filters by edge target, not a fooId scalar", async () => {
            const a1 = await es.create(ctx, AuthorSchema, { name: "Author One" });
            const a2 = await es.create(ctx, AuthorSchema, { name: "Author Two" });
            await es.create(ctx, BookSchema, { title: "One-A", author: a1.id });
            await es.create(ctx, BookSchema, { title: "One-B", author: a1.id });
            await es.create(ctx, BookSchema, { title: "Two-A", author: a2.id });

            const byA1 = await EntityQuery.from(store, BookSchema)
                .connectedTo("author", a1.id)
                .all(ctx);
            expect(byA1.map((b) => b.props.title).sort()).toEqual(["One-A", "One-B"]);

            const byA2 = await EntityQuery.from(store, BookSchema)
                .connectedTo("author", a2)
                .all(ctx);
            expect(byA2.map((b) => b.props.title)).toEqual(["Two-A"]);
        });

        it("within returns the whole subtree rooted at a node", async () => {
            const { root, a } = await seedTree();

            const all = await EntityQuery.from(store, ResourceSchema)
                .within("parent", root.id)
                .all(ctx);
            expect(names(all)).toEqual(["a", "a1", "a2", "b", "root"]);

            const underA = await EntityQuery.from(store, ResourceSchema)
                .within("parent", a.id)
                .all(ctx);
            expect(names(underA)).toEqual(["a", "a1", "a2"]);
        });

        it("within composes with where", async () => {
            const { root } = await seedTree();
            const matches = await EntityQuery.from(store, ResourceSchema)
                .within("parent", root.id)
                .where("name", "=", "a1")
                .all(ctx);
            expect(names(matches)).toEqual(["a1"]);
        });

        it("count respects edge filters", async () => {
            const author = await es.create(ctx, AuthorSchema, { name: "Counted" });
            await es.create(ctx, BookSchema, { title: "X", author: author.id });
            await es.create(ctx, BookSchema, { title: "Y", author: author.id });
            await es.create(ctx, BookSchema, { title: "Z" }); // no author

            const n = await EntityQuery.from(store, BookSchema)
                .connectedTo("author", author.id)
                .count(ctx);
            expect(n).toBe(2);
        });

        it("throws when filtering on an undeclared edge", () => {
            expect(() => EntityQuery.from(store, BookSchema).connectedTo("nope", "x")).toThrow(
                /no edge "nope"/,
            );
            expect(() => EntityQuery.from(store, ResourceSchema).within("nope", "x")).toThrow(
                /no edge "nope"/,
            );
        });
    });
}
