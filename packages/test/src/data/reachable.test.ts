/**
 * Reachability primitive tests.
 *
 * TripleStore.reachable() evaluates a transitive closure over the edge graph as
 * a single recursive CTE.  Per the project spec these run against BOTH SQLite
 * (always) and Postgres (when SYS_PG_URL is set), each suite wrapped in a
 * transaction that is rolled back afterwards.
 */

import type { IRI, Quad } from "@terncosoftware/core";
import { TripleStore } from "@terncosoftware/data";
import { buildServerContext, type ServerContext } from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function iri(value: string): IRI {
    return { value } as IRI;
}

const EX = (local: string) => iri(`http://example.org/${local}`);
const PARENT = EX("parent");
const MEMBER_OF = EX("memberOf");
const GRAPH = EX("g1");
const OTHER_GRAPH = EX("g2");

function edge(subject: IRI, predicate: IRI, object: IRI, graph: IRI | null = GRAPH): Quad {
    return { subject, predicate, object, graph: graph ?? undefined } as unknown as Quad;
}

function values(iris: IRI[]): string[] {
    return iris.map((i) => i.value).sort();
}

// ── Provider matrix ─────────────────────────────────────────────────────────────

interface Provider {
    name: string;
    create(): Promise<Knex>;
}

const providers: Provider[] = [
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
    describe(`TripleStore.reachable — ${provider.name}`, () => {
        let knex: Knex;
        let store: TripleStore;
        let trx: Knex.Transaction;
        let ctx: ServerContext;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            store = new TripleStore(knex);
            ctx = buildServerContext(store, { trx });
        });

        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        // A small resource tree:  root → a → a1, a → a2, root → b
        //   edges stored child --parent--> parent
        async function seedTree(): Promise<void> {
            await store.insertMany(ctx, [
                edge(EX("a"), PARENT, EX("root")),
                edge(EX("b"), PARENT, EX("root")),
                edge(EX("a1"), PARENT, EX("a")),
                edge(EX("a2"), PARENT, EX("a")),
            ]);
        }

        it("walks ancestors (direction out) — scope chain", async () => {
            await seedTree();
            const got = await store.reachable(ctx, {
                roots: [EX("a1")],
                predicates: [PARENT],
                direction: "out",
                graph: GRAPH,
            });
            expect(values(got)).toEqual(values([EX("a1"), EX("a"), EX("root")]));
        });

        it("walks descendants (direction in) — whole subtree from a root", async () => {
            await seedTree();
            const got = await store.reachable(ctx, {
                roots: [EX("root")],
                predicates: [PARENT],
                direction: "in",
                graph: GRAPH,
            });
            expect(values(got)).toEqual(values([EX("root"), EX("a"), EX("b"), EX("a1"), EX("a2")]));
        });

        it("includes the roots by default and can exclude them", async () => {
            await seedTree();
            const withRoots = await store.reachable(ctx, {
                roots: [EX("a")],
                predicates: [PARENT],
                direction: "out",
                graph: GRAPH,
            });
            expect(values(withRoots)).toEqual(values([EX("a"), EX("root")]));

            const withoutRoots = await store.reachable(ctx, {
                roots: [EX("a")],
                predicates: [PARENT],
                direction: "out",
                graph: GRAPH,
                includeRoots: false,
            });
            expect(values(withoutRoots)).toEqual(values([EX("root")]));
        });

        it("returns only the roots when no edges match", async () => {
            await seedTree();
            const got = await store.reachable(ctx, {
                roots: [EX("root")],
                predicates: [PARENT],
                direction: "out", // root has no parent
                graph: GRAPH,
            });
            expect(values(got)).toEqual(values([EX("root")]));
        });

        it("respects maxDepth (bounded hops)", async () => {
            await seedTree();
            const depth1 = await store.reachable(ctx, {
                roots: [EX("a1")],
                predicates: [PARENT],
                direction: "out",
                graph: GRAPH,
                maxDepth: 1,
            });
            expect(values(depth1)).toEqual(values([EX("a1"), EX("a")]));
        });

        it("terminates on cycles (set-semantics closure)", async () => {
            await store.insertMany(ctx, [
                edge(EX("x"), PARENT, EX("y")),
                edge(EX("y"), PARENT, EX("z")),
                edge(EX("z"), PARENT, EX("x")), // cycle
            ]);
            const got = await store.reachable(ctx, {
                roots: [EX("x")],
                predicates: [PARENT],
                direction: "out",
                graph: GRAPH,
            });
            expect(values(got)).toEqual(values([EX("x"), EX("y"), EX("z")]));
        });

        it("follows multiple predicates at once", async () => {
            await store.insertMany(ctx, [
                edge(EX("u"), MEMBER_OF, EX("team")),
                edge(EX("team"), MEMBER_OF, EX("org")),
                edge(EX("u"), PARENT, EX("dept")),
            ]);
            const got = await store.reachable(ctx, {
                roots: [EX("u")],
                predicates: [MEMBER_OF, PARENT],
                direction: "out",
                graph: GRAPH,
            });
            expect(values(got)).toEqual(values([EX("u"), EX("team"), EX("org"), EX("dept")]));
        });

        it("scopes to a named graph", async () => {
            await store.insertMany(ctx, [
                edge(EX("c"), PARENT, EX("inG1"), GRAPH),
                edge(EX("c"), PARENT, EX("inG2"), OTHER_GRAPH),
            ]);
            const got = await store.reachable(ctx, {
                roots: [EX("c")],
                predicates: [PARENT],
                direction: "out",
                graph: GRAPH,
            });
            expect(values(got)).toEqual(values([EX("c"), EX("inG1")]));
        });

        it("excludes soft-deleted edges", async () => {
            await seedTree();
            await store.delete(ctx, { subject: EX("a1"), predicate: PARENT, graph: GRAPH });
            const got = await store.reachable(ctx, {
                roots: [EX("a1")],
                predicates: [PARENT],
                direction: "out",
                graph: GRAPH,
            });
            expect(values(got)).toEqual(values([EX("a1")]));
        });

        it("returns empty when no roots resolve", async () => {
            await seedTree();
            const got = await store.reachable(ctx, {
                roots: [EX("never-interned")],
                predicates: [PARENT],
                direction: "out",
                graph: GRAPH,
            });
            expect(got).toEqual([]);
        });

        it("returns the roots when predicates never resolve", async () => {
            await seedTree();
            const got = await store.reachable(ctx, {
                roots: [EX("a1")],
                predicates: [EX("never-a-predicate")],
                direction: "out",
                graph: GRAPH,
            });
            expect(values(got)).toEqual(values([EX("a1")]));
        });
    });
}
