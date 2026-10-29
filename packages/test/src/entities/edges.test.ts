/**
 * Topological edge model tests.
 *
 * Relationships between entities are edges (object is the target's IRI), never
 * foreign-key scalars.  A hydrated record carries lazy `edges.<name>` handles
 * whose `.load(ctx)` fetches the target — there is no `fooId` anywhere on the
 * record.  Runs against SQLite (always) and Postgres (when SYS_PG_URL is set).
 */

import { IRI } from "@terncosoftware/core";
import { TripleStore } from "@terncosoftware/data";
import { type EdgeRef, EntitySchema } from "@terncosoftware/entities";
import { buildServerContext, EntityStore, type ServerContext } from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";

// ── Schemas: Author 1──* Book, Book ──1 Author ─────────────────────────────────

const NS = "http://test.dev/lib/";

interface AuthorProps extends Record<string, unknown> {
    name: string;
}
interface BookProps extends Record<string, unknown> {
    title: string;
}

function makeSchemas() {
    const BookSchema: EntitySchema<BookProps> = new EntitySchema<BookProps>({
        typeIRI: new IRI(`${NS}Book`),
        ns: NS,
        properties: { title: new IRI(`${NS}title`) },
        edges: {
            author: {
                predicate: new IRI(`${NS}writtenBy`),
                target: () => AuthorSchema,
                cardinality: "one",
                direction: "out",
            },
        },
    });
    const AuthorSchema: EntitySchema<AuthorProps> = new EntitySchema<AuthorProps>({
        typeIRI: new IRI(`${NS}Author`),
        ns: NS,
        properties: { name: new IRI(`${NS}name`) },
        edges: {
            // inbound: Book --writtenBy--> Author (not hydrated as an out-handle)
            books: {
                predicate: new IRI(`${NS}writtenBy`),
                target: () => BookSchema,
                cardinality: "many",
                direction: "in",
            },
        },
    });
    return { AuthorSchema, BookSchema };
}

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
    describe(`EntityStore edges — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let es: EntityStore;
        let ctx: ServerContext;
        let schemas: ReturnType<typeof makeSchemas>;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            const store = new TripleStore(knex);
            es = new EntityStore(store);
            ctx = buildServerContext(store, { trx });
            schemas = makeSchemas();
        });

        afterEach(async () => {
            await trx.rollback();
            await assertEmptyStore(knex);
            await knex.destroy();
        });

        it("writes a relationship as an IRI-object edge, not a fooId literal", async () => {
            const { AuthorSchema, BookSchema } = schemas;
            const author = await es.create(ctx, AuthorSchema, { name: "Le Guin" });
            const book = await es.create(ctx, BookSchema, {
                title: "A Wizard of Earthsea",
                author: author.id,
            });

            // No foreign-key scalar leaks into props.
            expect(book.props).toEqual({ title: "A Wizard of Earthsea" });
            expect("authorId" in book.props).toBe(false);
            expect("author" in book.props).toBe(false);

            // The edge is a navigable handle to the target IRI.
            const ref = book.edges?.author as EdgeRef;
            expect(ref).toBeDefined();
            expect(ref.iri).toBe(author.iri);
            expect(ref.id).toBe(author.id);
        });

        it("hydrates the out-edge as a lazy handle that loads the target", async () => {
            const { AuthorSchema, BookSchema } = schemas;
            const author = await es.create(ctx, AuthorSchema, { name: "Tolkien" });
            const created = await es.create(ctx, BookSchema, {
                title: "The Hobbit",
                author: author,
            });

            const book = await es.findById(ctx, BookSchema, created.id);
            const ref = book?.edges?.author as EdgeRef<{
                id: string;
                iri: string;
                props: AuthorProps;
            }>;
            expect(ref.iri).toBe(author.iri);

            const loaded = await ref.load(ctx);
            expect(loaded?.props.name).toBe("Tolkien");
        });

        it("accepts a full target IRI as an edge value", async () => {
            const { AuthorSchema, BookSchema } = schemas;
            const author = await es.create(ctx, AuthorSchema, { name: "Pratchett" });
            const created = await es.create(ctx, BookSchema, {
                title: "Mort",
                author: author.iri, // full IRI form
            });
            const book = await es.findById(ctx, BookSchema, created.id);
            const ref = book?.edges?.author as EdgeRef;
            expect(ref.iri).toBe(author.iri);
        });

        it("repoints an edge on update", async () => {
            const { AuthorSchema, BookSchema } = schemas;
            const a1 = await es.create(ctx, AuthorSchema, { name: "Ghostwriter" });
            const a2 = await es.create(ctx, AuthorSchema, { name: "Real Author" });
            const created = await es.create(ctx, BookSchema, { title: "Memoir", author: a1.id });

            await es.update(ctx, BookSchema, created.id, { author: a2.id });

            const book = await es.findById(ctx, BookSchema, created.id);
            const ref = book?.edges?.author as EdgeRef;
            expect(ref.iri).toBe(a2.iri);
        });

        it("leaves edgeless schemas with the original record shape", async () => {
            const Plain = new EntitySchema<{ label: string }>({
                typeIRI: new IRI(`${NS}Plain`),
                ns: NS,
                properties: { label: new IRI(`${NS}label`) },
            });
            const rec = await es.create(ctx, Plain, { label: "x" });
            expect(rec.edges).toBeUndefined();
            const found = await es.findById(ctx, Plain, rec.id);
            expect(found?.edges).toBeUndefined();
        });

        it("supports a polymorphic edge (no target): navigable by IRI, load rejects", async () => {
            const NS2 = "http://test.dev/poly/";
            const GrantSchema = new EntitySchema<{ label: string }>({
                typeIRI: new IRI(`${NS2}Grant`),
                ns: NS2,
                properties: { label: new IRI(`${NS2}label`) },
                edges: {
                    // principal may be any kind of entity — no single target schema
                    principal: { predicate: new IRI(`${NS2}principal`), direction: "out" },
                },
            });
            const principalIri = `${NS2}user/abc123`;
            const grant = await es.create(ctx, GrantSchema, {
                label: "g1",
                principal: principalIri,
            });

            const found = await es.findById(ctx, GrantSchema, grant.id);
            const ref = found?.edges?.principal as EdgeRef;
            expect(ref.iri).toBe(principalIri);
            await expect(ref.load(ctx)).rejects.toThrow(/no target schema/);
        });

        it("exposes an empty EdgeSet for a 'many' edge with no targets", async () => {
            // 'books' on Author is an inbound 'many' edge; out-hydration leaves it
            // empty (inbound collections are resolved by query, not on the record).
            const { AuthorSchema } = schemas;
            const author = await es.create(ctx, AuthorSchema, { name: "Solo" });
            const found = await es.findById(ctx, AuthorSchema, author.id);
            // inbound edge is not hydrated as an out-handle
            expect(found?.edges?.books).toBeUndefined();
        });
    });
}
