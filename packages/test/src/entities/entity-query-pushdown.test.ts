/**
 * EntityQuery reads a list window in SQL: several sort keys, `in`, a search
 * across several fields, limit/offset and a count that respects the filters.
 *
 * Runs against SQLite (always) and Postgres (when SYS_PG_URL is set), each
 * test inside a rolled-back transaction. The window test checks the SQL page
 * against applyListQuery, the in-memory reference a browser places changes
 * with, so the two orders cannot drift apart.
 *
 * Every test runs twice: once with name and team as plain properties, read in
 * SQL, and once with them PII, decrypted and read in memory. Both must answer
 * the same.
 */

import { IRI } from "@terncosoftware/core";
import { applyListQuery, type ListQuery, type ListSchema } from "@terncosoftware/core/list";
import { TripleStore } from "@terncosoftware/data";
import { type EntityRecord, EntitySchema } from "@terncosoftware/entities";
import { buildServerContext, EntityQuery, EntityStore } from "@terncosoftware/server";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEmptyStore, createTestDataContext } from "../assertEmptyStore.js";
import { TEST_CIPHER } from "../auth/testCipher.js";

interface DbProvider {
    name: string;
    create(): Promise<Knex>;
}

const providers: DbProvider[] = [
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

const NS = "urn:sys:test:pushdown:";

interface PersonProps extends Record<string, unknown> {
    name: string;
    team: string;
    age: number;
    active: boolean;
    secret: string;
}

const PersonSchema = new EntitySchema<PersonProps>({
    typeIRI: new IRI(`${NS}Person`),
    ns: NS,
    properties: {
        name: new IRI(`${NS}name`),
        team: new IRI(`${NS}team`),
        age: new IRI(`${NS}age`),
        active: new IRI(`${NS}active`),
        secret: { iri: new IRI(`${NS}secret`), pii: true },
    },
});

const PiiPersonSchema = new EntitySchema<PersonProps>({
    typeIRI: new IRI(`${NS}PiiPerson`),
    ns: NS,
    properties: {
        name: { iri: new IRI(`${NS}name`), pii: true },
        team: { iri: new IRI(`${NS}team`), pii: true },
        age: new IRI(`${NS}age`),
        active: new IRI(`${NS}active`),
        secret: { iri: new IRI(`${NS}secret`), pii: true },
    },
});

const SCHEMAS = [
    { label: "plain", schema: PersonSchema },
    { label: "PII", schema: PiiPersonSchema },
];

interface PersonRow {
    [field: string]: string | number | boolean | null;
    id: string;
    name: string;
    team: string | null;
    age: number;
    active: boolean;
}

function toRow(record: EntityRecord<PersonProps>): PersonRow {
    return {
        id: record.id,
        name: record.props.name,
        team: record.props.team ?? null,
        age: record.props.age,
        active: record.props.active,
    };
}

const LIST_SCHEMA: ListSchema = {
    key: "id",
    fields: ["name", "team", "age", "active"],
    searchFields: ["name", "team"],
    defaultSort: [{ field: "age", direction: "desc" }],
    maxLimit: 100,
};

// Five people: three share age 30, "Bob" and "Dan" are capitalised, eve has no team.
const PEOPLE: Partial<PersonProps>[] = [
    { name: "ann", team: "red", age: 30, active: true },
    { name: "Bob", team: "blue", age: 30, active: false },
    { name: "cara", team: "red", age: 25, active: true },
    { name: "Dan", team: "green", age: 30, active: true },
    { name: "eve", age: 40, active: false },
];

async function setup(db: DbProvider, schema: EntitySchema<PersonProps>) {
    const knex = await db.create();
    const trx = await knex.transaction();
    const store = new TripleStore(knex);
    const es = new EntityStore(store, undefined, TEST_CIPHER);
    const ctx = buildServerContext(store, { trx, cipher: TEST_CIPHER });
    for (const person of PEOPLE) {
        await es.create(ctx, schema, { ...person, secret: `s-${person.name}` });
    }
    return { ctx, knex, trx, store };
}

for (const db of providers) {
    for (const { label, schema } of SCHEMAS) {
        describe(`EntityQuery in SQL (${db.name}, ${label} name and team)`, () => {
            let env: Awaited<ReturnType<typeof setup>>;
            const people = () => EntityQuery.from(env.store, schema, TEST_CIPHER);
            const names = (records: EntityRecord<PersonProps>[]) =>
                records.map((r) => r.props.name);

            beforeEach(async () => {
                env = await setup(db, schema);
            });
            afterEach(async () => {
                await env.trx.rollback();
                await assertEmptyStore(env.knex);
                await env.knex.destroy();
            });

            it("breaks a tie on the first sort key with the second", async () => {
                const records = await people().orderBy("age", "desc").orderBy("name").all(env.ctx);
                // ann, Bob and Dan tie on 30; names compare case-insensitively.
                expect(names(records)).toEqual(["eve", "ann", "Bob", "Dan", "cara"]);
            });

            it("breaks a tie on every sort key by the entity, the same way each read", async () => {
                const first = await people().orderBy("age", "desc").all(env.ctx);
                const second = await people().orderBy("age", "desc").all(env.ctx);
                expect(names(first)).toEqual(names(second));
                expect(names(first)[0]).toBe("eve");
                expect(names(first)[4]).toBe("cara");
            });

            it("keeps nothing for `in` with an empty list, and counts nothing", async () => {
                const query = () => people().whereIn("team", []);
                expect(await query().all(env.ctx)).toEqual([]);
                expect(await query().count(env.ctx)).toBe(0);
                expect(await query().page(env.ctx)).toEqual({ records: [], total: 0 });
            });

            it("keeps any member for `in`, and a missing value for a null member", async () => {
                const teams = await people()
                    .whereIn("team", ["red", "blue"])
                    .orderBy("name")
                    .all(env.ctx);
                expect(names(teams)).toEqual(["ann", "Bob", "cara"]);
                const orNone = await people()
                    .whereIn("team", ["blue", null])
                    .orderBy("name")
                    .all(env.ctx);
                expect(names(orNone)).toEqual(["Bob", "eve"]);
                const ages = await people().whereIn("age", [25, 40]).orderBy("age").all(env.ctx);
                expect(names(ages)).toEqual(["cara", "eve"]);
            });

            it("finds nothing for a search that matches nothing", async () => {
                const query = () => people().search("zzz", ["name", "team"]);
                expect(await query().all(env.ctx)).toEqual([]);
                expect(await query().count(env.ctx)).toBe(0);
            });

            it("searches several fields, case-insensitively, every term in one of them", async () => {
                const bob = await people().search("BOB", ["name", "team"]).all(env.ctx);
                expect(names(bob)).toEqual(["Bob"]);
                // "red" is a team, "an" a name: only ann has both.
                const both = await people().search(" red  an ", ["name", "team"]).all(env.ctx);
                expect(names(both)).toEqual(["ann"]);
                const team = await people()
                    .search("re", ["name", "team"])
                    .orderBy("name")
                    .all(env.ctx);
                expect(names(team)).toEqual(["ann", "cara", "Dan"]);
            });

            it("treats search wildcards as text", async () => {
                expect(await people().search("%", ["name"]).count(env.ctx)).toBe(0);
                expect(await people().search("_", ["name"]).count(env.ctx)).toBe(0);
            });

            it("returns an empty page past the end, with the full total", async () => {
                const page = await people().orderBy("name").offset(10).limit(5).page(env.ctx);
                expect(page).toEqual({ records: [], total: 5 });
            });

            it("counts what the filters admit, whatever the page", async () => {
                const query = () =>
                    people().whereIn("team", ["red", "blue"]).where("age", ">=", 30);
                expect(await query().count(env.ctx)).toBe(2);
                const page = await query().orderBy("name").limit(1).page(env.ctx);
                expect(names(page.records)).toEqual(["ann"]);
                expect(page.total).toBe(2);
                expect(await query().limit(1).offset(1).count(env.ctx)).toBe(2);
            });

            it("compares with every operator", async () => {
                const sorted = (q: EntityQuery<PersonProps>) => q.orderBy("name").all(env.ctx);
                expect(names(await sorted(people().where("age", "<", 30)))).toEqual(["cara"]);
                expect(names(await sorted(people().where("age", ">", 30)))).toEqual(["eve"]);
                expect(names(await sorted(people().where("name", "=", "Bob")))).toEqual(["Bob"]);
                expect(await people().where("name", "=", "bob").count(env.ctx)).toBe(0);
                expect(names(await sorted(people().where("active", "=", false)))).toEqual([
                    "Bob",
                    "eve",
                ]);
                // Strings compare case-insensitively first: "Bob" < "cara" < "Dan".
                expect(names(await sorted(people().where("name", "<", "cara")))).toEqual([
                    "ann",
                    "Bob",
                ]);
                // A missing value fails `<` and passes `!=`.
                expect(names(await sorted(people().where("team", "!=", "red")))).toEqual([
                    "Bob",
                    "Dan",
                    "eve",
                ]);
                expect(names(await sorted(people().where("team", "=", null)))).toEqual(["eve"]);
                expect(names(await sorted(people().where("name", "LIKE", "D%")))).toEqual(["Dan"]);
                expect(await people().where("name", "LIKE", "d%").count(env.ctx)).toBe(0);
                expect(names(await sorted(people().where("name", "ILIKE", "d%")))).toEqual(["Dan"]);
            });

            it("filters, sorts and searches an encrypted property by its plaintext", async () => {
                const sorted = (q: EntityQuery<PersonProps>) => q.orderBy("name").all(env.ctx);
                expect(names(await sorted(people().where("secret", "=", "s-ann")))).toEqual([
                    "ann",
                ]);
                expect(names(await sorted(people().whereIn("secret", ["s-Bob", "s-eve"])))).toEqual(
                    ["Bob", "eve"],
                );
                expect(await people().whereIn("secret", []).count(env.ctx)).toBe(0);
                expect(names(await sorted(people().where("secret", "ILIKE", "S-D%")))).toEqual([
                    "Dan",
                ]);
                expect(names(await sorted(people().search("s-c", ["team", "secret"])))).toEqual([
                    "cara",
                ]);
                const page = await people()
                    .where("age", "=", 30)
                    .orderBy("secret", "desc")
                    .limit(2)
                    .page(env.ctx);
                expect(names(page.records)).toEqual(["Dan", "Bob"]);
                expect(page.total).toBe(3);
            });

            it("refuses to read an encrypted property with no cipher to decrypt it", async () => {
                const bare = buildServerContext(env.store, { trx: env.trx });
                const query = EntityQuery.from(env.store, schema).orderBy("secret");
                await expect(query.count(bare)).rejects.toThrow(/no field cipher/);
            });

            it("refuses a pattern or a list on a timestamp", () => {
                expect(() => people().where("createdAt", "LIKE", "2026%")).toThrow(/timestamp/);
                expect(() =>
                    people().whereIn("createdAt" as keyof PersonProps & string, []),
                ).toThrow(/timestamp/);
            });

            it("sorts and filters on createdAt", async () => {
                const asc = await people().orderBy("createdAt").all(env.ctx);
                expect(asc).toHaveLength(5);
                const after = await people()
                    .where("createdAt", ">=", "2000-01-01T00:00:00.000Z")
                    .count(env.ctx);
                expect(after).toBe(5);
                const before = await people()
                    .where("createdAt", "<", "2000-01-01T00:00:00.000Z")
                    .count(env.ctx);
                expect(before).toBe(0);
                if (db.name === "Postgres") {
                    // Each write is its own statement, so Postgres stamps them apart.
                    expect(names(asc)).toEqual(PEOPLE.map((p) => p.name));
                }
            });

            it("answers a ListQuery window exactly as applyListQuery orders the same rows", async () => {
                const everyone = (await people().all(env.ctx)).map(toRow);
                const queries: ListQuery[] = [
                    {
                        sort: [
                            { field: "age", direction: "desc" },
                            { field: "name", direction: "asc" },
                        ],
                        filters: [{ field: "team", op: "in", value: ["red", "green"] }],
                        search: "",
                        page: { offset: 1, limit: 1 },
                    },
                    {
                        sort: [{ field: "team", direction: "asc" }],
                        filters: [],
                        search: "",
                        page: { offset: 0, limit: 10 },
                    },
                    {
                        sort: [
                            { field: "team", direction: "desc" },
                            { field: "active", direction: "asc" },
                        ],
                        filters: [{ field: "age", op: "gte", value: 30 }],
                        search: "",
                        page: { offset: 0, limit: 10 },
                    },
                    {
                        sort: [{ field: "name", direction: "desc" }],
                        filters: [{ field: "name", op: "contains", value: "A" }],
                        search: "e",
                        page: { offset: 0, limit: 2 },
                    },
                    {
                        sort: [],
                        filters: [{ field: "team", op: "neq", value: "red" }],
                        search: "",
                        page: { offset: 0, limit: 10 },
                    },
                    {
                        sort: [{ field: "age", direction: "asc" }],
                        filters: [],
                        search: "nobody",
                        page: { offset: 0, limit: 10 },
                    },
                ];
                for (const query of queries) {
                    const window = await people().window(env.ctx, query, LIST_SCHEMA, toRow);
                    expect(window, JSON.stringify(query)).toEqual(
                        applyListQuery(everyone, query, LIST_SCHEMA),
                    );
                }
                const first = await people().window(
                    env.ctx,
                    queries[0] as ListQuery,
                    LIST_SCHEMA,
                    toRow,
                );
                expect(first.rows.map((r) => r.name)).toEqual(["Dan"]);
                expect(first.total).toBe(3);
            });
        });
    }
}
