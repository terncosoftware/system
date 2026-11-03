import type { IRI, Literal } from "@terncosoftware/core";
import { C, T } from "./schema.js";

/**
 * A read of the subjects of one rdf:type, filtered, sorted and paged in SQL.
 *
 * The entity layer compiles its queries to this shape; the store resolves the
 * IRIs to node ids and runs one statement for the page and one for the count.
 *
 * Values order the way `compareListValues` in `@terncosoftware/core/list`
 * orders them, so a page read here and a page placed in a browser agree:
 * booleans before numbers before strings, numbers numerically, strings
 * case-insensitively and then by code point, a missing value after every
 * present one ascending (and before them descending), and the subject IRI
 * breaking every tie.
 */

/** Where a subject query looks. `acrossTenants` reads every graph. */
export type SubjectScope = { readonly graph: IRI | null } | { readonly acrossTenants: true };

/** A literal property of the subject, or one of its edge-derived timestamps. */
export type SubjectField =
    | { readonly predicate: IRI }
    | { readonly timestamp: "createdAt" | "updatedAt" };

export type SubjectCompareOp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";

export type SubjectCondition =
    /** A null value: `eq` matches a subject with no value, `neq` one with any value. */
    | {
          readonly kind: "compare";
          readonly field: SubjectField;
          readonly op: SubjectCompareOp;
          readonly value: Literal | null;
      }
    /** Any of the values. An empty list matches nothing; a null member matches a missing value. */
    | { readonly kind: "in"; readonly predicate: IRI; readonly values: readonly (Literal | null)[] }
    /** A SQL LIKE pattern on the lexical value; backslash escapes `%` and `_`. */
    | {
          readonly kind: "like";
          readonly predicate: IRI;
          readonly pattern: string;
          readonly caseInsensitive: boolean;
      }
    /** Every term appears, case-insensitively, in the value of one of the predicates. */
    | {
          readonly kind: "search";
          readonly predicates: readonly IRI[];
          readonly terms: readonly string[];
      }
    /** subject --predicate--> any of the targets. An empty list matches nothing. */
    | { readonly kind: "edge"; readonly predicate: IRI; readonly targets: readonly IRI[] }
    /** The subject is the root or reaches it by following `predicate` out, any number of hops. */
    | { readonly kind: "within"; readonly predicate: IRI; readonly root: IRI };

export interface SubjectSort {
    readonly field: SubjectField;
    readonly direction: "asc" | "desc";
}

export interface SubjectQuery {
    readonly type: IRI;
    readonly scope: SubjectScope;
    readonly where: readonly SubjectCondition[];
    /** Applied in order; the subject IRI breaks every remaining tie. */
    readonly sort: readonly SubjectSort[];
    readonly offset?: number;
    readonly limit?: number;
}

/** The SQL that differs between the two clients. */
export interface SqlDialect {
    readonly falseLit: string;
    /** Appended to a text expression so it compares by code point. */
    readonly collateC: string;
    readonly doubleType: string;
    /** A bound ISO-8601 timestamp, as something that compares with created_at. */
    readonly timestampParam: string;
    /** A case-sensitive pattern match: Postgres LIKE, SQLite GLOB (its LIKE ignores case). */
    likeCaseSensitive(expr: string, pattern: string): { sql: string; binding: string };
    /** LIMIT/OFFSET for an optional limit and offset. */
    page(limit: number | undefined, offset: number): { sql: string; bindings: number[] };
}

export const PG_DIALECT: SqlDialect = {
    falseLit: "false",
    collateC: ' COLLATE "C"',
    doubleType: "double precision",
    timestampParam: "CAST(? AS timestamptz)",
    likeCaseSensitive: (expr, pattern) => ({
        sql: `${expr} LIKE ? ESCAPE '\\'`,
        binding: pattern,
    }),
    page: (limit, offset) => {
        const parts: string[] = [];
        const bindings: number[] = [];
        if (limit !== undefined) {
            parts.push("LIMIT ?");
            bindings.push(limit);
        }
        if (offset > 0) {
            parts.push("OFFSET ?");
            bindings.push(offset);
        }
        return { sql: parts.join(" "), bindings };
    },
};

export const SQLITE_DIALECT: SqlDialect = {
    falseLit: "0",
    collateC: "",
    doubleType: "REAL",
    // The triggers stamp ISO-8601 with milliseconds; compare in that form.
    timestampParam: "strftime('%Y-%m-%dT%H:%M:%fZ', ?)",
    likeCaseSensitive: (expr, pattern) => ({
        sql: `${expr} GLOB ?`,
        binding: likeToGlob(pattern),
    }),
    page: (limit, offset) => {
        if (limit === undefined && offset === 0) {
            return { sql: "", bindings: [] };
        }
        // SQLite takes OFFSET only after a LIMIT; -1 means no limit.
        return { sql: "LIMIT ? OFFSET ?", bindings: [limit ?? -1, offset] };
    },
};

/** Translate a LIKE pattern (backslash escapes) to the GLOB pattern that matches the same strings. */
export function likeToGlob(pattern: string): string {
    let out = "";
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i] as string;
        if (ch === "\\" && i + 1 < pattern.length) {
            i++;
            out += globLiteral(pattern[i] as string);
        } else if (ch === "%") {
            out += "*";
        } else if (ch === "_") {
            out += "?";
        } else {
            out += globLiteral(ch);
        }
    }
    return out;
}

function globLiteral(ch: string): string {
    return ch === "*" || ch === "?" || ch === "[" ? `[${ch}]` : ch;
}

/** Escape LIKE wildcards so a string matches only itself. */
export function escapeLike(text: string): string {
    return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const XSD = "http://www.w3.org/2001/XMLSchema#";
const XSD_BOOLEAN = `${XSD}boolean`;
const XSD_NUMERIC = [
    "integer",
    "int",
    "long",
    "short",
    "byte",
    "unsignedInt",
    "unsignedLong",
    "unsignedShort",
    "decimal",
    "float",
    "double",
].map((local) => `${XSD}${local}`);

/** 0 boolean, 1 number, 2 string: the order `typeof` names give in compareListValues. */
type Rank = 0 | 1 | 2;

function rankOf(datatype: string | undefined): Rank {
    if (datatype === XSD_BOOLEAN) {
        return 0;
    }
    return datatype !== undefined && XSD_NUMERIC.includes(datatype) ? 1 : 2;
}

/** Node ids for every IRI a query names; an IRI the store never interned is absent. */
export type NodeIdMap = ReadonlyMap<string, number>;

/** Every IRI a query needs resolved to a node id. */
export function subjectQueryIris(q: SubjectQuery, rdfType: IRI): IRI[] {
    const iris: IRI[] = [rdfType, q.type];
    const field = (f: SubjectField): void => {
        if ("predicate" in f) {
            iris.push(f.predicate);
        }
    };
    for (const c of q.where) {
        switch (c.kind) {
            case "compare":
                field(c.field);
                break;
            case "in":
            case "like":
                iris.push(c.predicate);
                break;
            case "search":
                iris.push(...c.predicates);
                break;
            case "edge":
                iris.push(c.predicate, ...c.targets);
                break;
            case "within":
                iris.push(c.predicate, c.root);
                break;
        }
    }
    for (const s of q.sort) {
        field(s.field);
    }
    return iris;
}

export interface CompiledStatement {
    readonly sql: string;
    readonly bindings: readonly (string | number)[];
}

export interface CompiledSubjectQuery {
    readonly page: CompiledStatement;
    readonly count: CompiledStatement;
    /**
     * Every subject the filters admit, unsorted and unpaged: `subjects` gives
     * each one's IRI and timestamps, `values` the live literal values of
     * `predicates` on them, newest first.
     */
    rows(predicates: readonly IRI[]): { subjects: CompiledStatement; values: CompiledStatement };
}

/** No node has this id, so a clause naming an IRI the store never saw matches nothing. */
const MISSING = -1;

/**
 * Compile a subject query. `graphId` is the resolved graph for a scoped
 * query, or null across tenants. Node ids are inlined (they come from the
 * store); every value a caller supplied is a binding.
 */
export function compileSubjectQuery(
    q: SubjectQuery,
    rdfType: IRI,
    ids: NodeIdMap,
    graphId: number | null,
    d: SqlDialect,
): CompiledSubjectQuery {
    const id = (iri: IRI): number => ids.get(iri.value) ?? MISSING;
    const live = (a: string): string =>
        `${a}.${C.isDeleted} = ${d.falseLit}${graphId === null ? "" : ` AND ${a}.${C.graph} = ${graphId}`}`;

    const rank = (n: string): string =>
        `CASE WHEN ${n}.${C.dt} = '${XSD_BOOLEAN}' THEN 0 WHEN ${n}.${C.dt} IN (${XSD_NUMERIC.map((dt) => `'${dt}'`).join(", ")}) THEN 1 ELSE 2 END`;
    const num = (n: string): string =>
        `CASE WHEN ${n}.${C.dt} IN (${XSD_NUMERIC.map((dt) => `'${dt}'`).join(", ")}) THEN CAST(${n}.${C.value} AS ${d.doubleType}) END`;
    const fold = (expr: string): string => `lower(${expr})${d.collateC}`;
    const exact = (expr: string): string => `${expr}${d.collateC}`;
    const text = "CAST(? AS TEXT)";

    // One live value of `predicate` on the candidate, joined to its node as `n`.
    const hasValue = (predicate: number | readonly number[], cond: string): string => {
        const pred =
            typeof predicate === "number"
                ? `e.${C.predicate} = ${predicate}`
                : predicate.length === 0
                  ? "1 = 0"
                  : `e.${C.predicate} IN (${predicate.join(", ")})`;
        return (
            `EXISTS (SELECT 1 FROM ${T.edges} e JOIN ${T.nodes} n ON n.${C.id} = e.${C.object} ` +
            `WHERE e.${C.subject} = c.sid AND ${pred} AND ${live("e")} AND ${cond})`
        );
    };
    const timestampOf = (which: "createdAt" | "updatedAt"): string => {
        const agg = which === "createdAt" ? `MIN(e.${C.createdAt})` : `MAX(e.${C.updatedAt})`;
        return `(SELECT ${agg} FROM ${T.edges} e WHERE e.${C.subject} = c.sid AND ${live("e")})`;
    };

    const bindings: (string | number)[] = [];

    // A literal equal to `lit`: numbers numerically, the rest by exact lexical form.
    const equals = (lit: Literal): string => {
        const r = rankOf(lit.datatype?.value);
        if (r === 1) {
            bindings.push(Number(lit.value));
            return `${num("n")} = ?`;
        }
        bindings.push(lit.value);
        return `(${rank("n")} = ${r} AND n.${C.value} = ${text})`;
    };

    const compareRange = (op: "lt" | "lte" | "gt" | "gte", lit: Literal): string => {
        const r = rankOf(lit.datatype?.value);
        const sym = { lt: "<", lte: "<=", gt: ">", gte: ">=" }[op];
        const strict = op === "lt" || op === "lte" ? "<" : ">";
        let same: string;
        if (r === 1) {
            same = `${num("n")} ${sym} ?`;
            bindings.push(Number(lit.value));
        } else if (r === 0) {
            same = `n.${C.value} ${sym} ${text}`;
            bindings.push(lit.value);
        } else {
            same =
                `(${fold(`n.${C.value}`)} ${strict} ${fold(text)} OR ` +
                `(${fold(`n.${C.value}`)} = ${fold(text)} AND ${exact(`n.${C.value}`)} ${sym} ${exact(text)}))`;
            bindings.push(lit.value, lit.value, lit.value);
        }
        return `(${rank("n")} ${strict} ${r} OR (${rank("n")} = ${r} AND ${same}))`;
    };

    const condition = (c: Exclude<SubjectCondition, { kind: "within" }>): string => {
        switch (c.kind) {
            case "compare": {
                if ("timestamp" in c.field) {
                    if (c.value === null) {
                        return c.op === "neq" ? "1 = 1" : "1 = 0";
                    }
                    const sym = { eq: "=", neq: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" }[
                        c.op
                    ];
                    bindings.push(c.value.value);
                    return `${timestampOf(c.field.timestamp)} ${sym} ${d.timestampParam}`;
                }
                const pid = id(c.field.predicate);
                if (c.value === null) {
                    if (c.op === "eq") {
                        return `NOT ${hasValue(pid, "1 = 1")}`;
                    }
                    return c.op === "neq" ? hasValue(pid, "1 = 1") : "1 = 0";
                }
                if (c.op === "eq") {
                    return hasValue(pid, equals(c.value));
                }
                if (c.op === "neq") {
                    return `NOT ${hasValue(pid, equals(c.value))}`;
                }
                return hasValue(pid, compareRange(c.op, c.value));
            }
            case "in": {
                const present = c.values.filter((v): v is Literal => v !== null);
                const parts: string[] = [];
                if (present.length > 0) {
                    parts.push(hasValue(id(c.predicate), `(${present.map(equals).join(" OR ")})`));
                }
                if (present.length < c.values.length) {
                    parts.push(`NOT ${hasValue(id(c.predicate), "1 = 1")}`);
                }
                return parts.length === 0 ? "1 = 0" : `(${parts.join(" OR ")})`;
            }
            case "like": {
                if (c.caseInsensitive) {
                    bindings.push(c.pattern);
                    return hasValue(
                        id(c.predicate),
                        `lower(n.${C.value}) LIKE lower(${text}) ESCAPE '\\'`,
                    );
                }
                const like = d.likeCaseSensitive(`n.${C.value}`, c.pattern);
                bindings.push(like.binding);
                return hasValue(id(c.predicate), like.sql);
            }
            case "search": {
                const pids = c.predicates.map(id);
                const terms = c.terms.filter((t) => t.length > 0);
                if (terms.length === 0) {
                    return "1 = 1";
                }
                return `(${terms
                    .map((term) => {
                        bindings.push(`%${escapeLike(term.toLowerCase())}%`);
                        return hasValue(pids, `lower(n.${C.value}) LIKE ? ESCAPE '\\'`);
                    })
                    .join(" AND ")})`;
            }
            case "edge": {
                if (c.targets.length === 0) {
                    return "1 = 0";
                }
                const targets = c.targets.map(id).join(", ");
                return (
                    `EXISTS (SELECT 1 FROM ${T.edges} e WHERE e.${C.subject} = c.sid AND ` +
                    `e.${C.predicate} = ${id(c.predicate)} AND e.${C.object} IN (${targets}) AND ${live("e")})`
                );
            }
        }
    };

    // Subtree filters are recursive CTEs at the head of the statement.
    const ctes: string[] = [];
    const where: string[] = [];
    for (const c of q.where) {
        if (c.kind === "within") {
            const name = `w${ctes.length}`;
            ctes.push(
                `${name}(node) AS (SELECT ${id(c.root)} UNION SELECT e.${C.subject} FROM ${T.edges} e ` +
                    `JOIN ${name} ON e.${C.object} = ${name}.node WHERE e.${C.predicate} = ${id(c.predicate)} AND ${live("e")})`,
            );
            where.push(`c.sid IN (SELECT node FROM ${name})`);
        } else {
            where.push(condition(c));
        }
    }

    const withSql = ctes.length > 0 ? `WITH RECURSIVE ${ctes.join(", ")} ` : "";
    const candidates =
        `(SELECT t.${C.subject} AS sid FROM ${T.edges} t WHERE t.${C.predicate} = ${id(rdfType)} ` +
        `AND t.${C.object} = ${id(q.type)} AND ${live("t")} GROUP BY t.${C.subject}) c`;
    const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";

    // Each sorted property joins its newest live value as k<i>.
    const joins: string[] = [];
    const order: string[] = [];
    q.sort.forEach((s, i) => {
        const dir = s.direction === "desc" ? "DESC" : "ASC";
        if ("timestamp" in s.field) {
            order.push(`${timestampOf(s.field.timestamp)} ${dir}`);
            return;
        }
        const k = `k${i}`;
        joins.push(
            `LEFT JOIN ${T.nodes} ${k} ON ${k}.${C.id} = (SELECT e.${C.object} FROM ${T.edges} e ` +
                `WHERE e.${C.subject} = c.sid AND e.${C.predicate} = ${id(s.field.predicate)} AND ${live("e")} ` +
                `ORDER BY e.${C.id} DESC LIMIT 1)`,
        );
        order.push(
            `CASE WHEN ${k}.${C.id} IS NULL THEN 1 ELSE 0 END ${dir}`,
            `${rank(k)} ${dir}`,
            `${num(k)} ${dir}`,
            `${fold(`${k}.${C.value}`)} ${dir}`,
            `${exact(`${k}.${C.value}`)} ${dir}`,
        );
    });
    order.push(`${fold(`s.${C.iri}`)} ASC`, `${exact(`s.${C.iri}`)} ASC`);

    const page = d.page(q.limit, q.offset ?? 0);
    const pageSql =
        `${withSql}SELECT s.${C.iri} AS iri FROM ${candidates} JOIN ${T.nodes} s ON s.${C.id} = c.sid ` +
        `${joins.join(" ")}${whereSql} ORDER BY ${order.join(", ")} ${page.sql}`;
    const countSql = `${withSql}SELECT COUNT(*) AS total FROM ${candidates}${whereSql}`;

    const from = `${withSql}SELECT s.${C.iri} AS iri`;
    const subjectsSql =
        `${from}, ${timestampOf("createdAt")} AS ${C.createdAt}, ${timestampOf("updatedAt")} AS ${C.updatedAt} ` +
        `FROM ${candidates} JOIN ${T.nodes} s ON s.${C.id} = c.sid${whereSql}`;

    return {
        page: { sql: pageSql.trim(), bindings: [...bindings, ...page.bindings] },
        count: { sql: countSql, bindings },
        rows: (predicates) => {
            const pids = predicates.map(id);
            const valuesSql =
                `${from}, vp.${C.iri} AS predicate, vn.${C.value} AS value, vn.${C.dt} AS dt, vn.${C.keyId} AS key_id ` +
                `FROM ${candidates} JOIN ${T.nodes} s ON s.${C.id} = c.sid ` +
                `JOIN ${T.edges} ve ON ve.${C.subject} = c.sid AND ve.${C.predicate} IN (${pids.length > 0 ? pids.join(", ") : MISSING}) AND ${live("ve")} ` +
                `JOIN ${T.nodes} vp ON vp.${C.id} = ve.${C.predicate} ` +
                `JOIN ${T.nodes} vn ON vn.${C.id} = ve.${C.object} AND vn.${C.kind} = 'literal'${whereSql} ` +
                `ORDER BY ve.${C.id} DESC`;
            return {
                subjects: { sql: subjectsSql, bindings },
                values: { sql: valuesSql, bindings },
            };
        },
    };
}

// ── Conditions and sorts on values held in memory ────────────────────────────

/** A subject's values as SQL sees them, for conditions it cannot evaluate itself. */
export interface SubjectRow {
    readonly iri: string;
    /** ISO-8601. */
    readonly createdAt: string;
    /** ISO-8601. */
    readonly updatedAt: string;
    /** Live literal values by predicate IRI, newest first. */
    readonly values: ReadonlyMap<string, readonly Literal[]>;
}

const lexCompare = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);
const foldCompare = (a: string, b: string): number =>
    lexCompare(a.toLowerCase(), b.toLowerCase()) || lexCompare(a, b);

/** One present value against another, as the SQL ORDER BY ranks them. */
function compareLiterals(a: Literal, b: Literal): number {
    const ra = rankOf(a.datatype?.value);
    const rb = rankOf(b.datatype?.value);
    if (ra !== rb) {
        return ra - rb;
    }
    if (ra === 1) {
        const order = Number(a.value) - Number(b.value);
        if (order !== 0) {
            return order;
        }
    }
    return foldCompare(a.value, b.value);
}

function literalEquals(n: Literal, lit: Literal): boolean {
    const r = rankOf(lit.datatype?.value);
    if (r === 1) {
        return rankOf(n.datatype?.value) === 1 && Number(n.value) === Number(lit.value);
    }
    return rankOf(n.datatype?.value) === r && n.value === lit.value;
}

function literalInRange(n: Literal, op: "lt" | "lte" | "gt" | "gte", lit: Literal): boolean {
    const rn = rankOf(n.datatype?.value);
    const r = rankOf(lit.datatype?.value);
    const below = op === "lt" || op === "lte";
    if (rn !== r) {
        return below ? rn < r : rn > r;
    }
    const order =
        r === 1
            ? Number(n.value) - Number(lit.value)
            : r === 0
              ? lexCompare(n.value, lit.value)
              : foldCompare(n.value, lit.value);
    return { lt: order < 0, lte: order <= 0, gt: order > 0, gte: order >= 0 }[op];
}

/** A LIKE pattern (backslash escapes) as an anchored regular expression. */
function likeToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
    let source = "";
    for (let i = 0; i < pattern.length; i++) {
        let ch = pattern[i] as string;
        if (ch === "\\" && i + 1 < pattern.length) {
            i++;
            ch = pattern[i] as string;
        } else if (ch === "%") {
            source += ".*";
            continue;
        } else if (ch === "_") {
            source += ".";
            continue;
        }
        source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${source}$`, caseInsensitive ? "si" : "s");
}

/**
 * True when the row passes the condition, by the rules the SQL applies.
 * Edge, subtree and timestamp conditions read the graph, so only SQL runs them.
 */
export function matchesSubjectRow(row: SubjectRow, c: SubjectCondition): boolean {
    const valuesOf = (predicate: IRI): readonly Literal[] => row.values.get(predicate.value) ?? [];
    switch (c.kind) {
        case "compare": {
            if ("timestamp" in c.field) {
                throw new Error("matchesSubjectRow: timestamp conditions run in SQL only");
            }
            const values = valuesOf(c.field.predicate);
            const { value } = c;
            if (value === null) {
                return c.op === "eq" ? values.length === 0 : c.op === "neq" && values.length > 0;
            }
            if (c.op === "eq") {
                return values.some((n) => literalEquals(n, value));
            }
            if (c.op === "neq") {
                return !values.some((n) => literalEquals(n, value));
            }
            const op = c.op;
            return values.some((n) => literalInRange(n, op, value));
        }
        case "in": {
            const values = valuesOf(c.predicate);
            return c.values.some((lit) =>
                lit === null ? values.length === 0 : values.some((n) => literalEquals(n, lit)),
            );
        }
        case "like": {
            const re = likeToRegExp(c.pattern, c.caseInsensitive);
            return valuesOf(c.predicate).some((n) => re.test(n.value));
        }
        case "search": {
            const haystack = c.predicates.flatMap((p) =>
                valuesOf(p).map((n) => n.value.toLowerCase()),
            );
            return c.terms
                .filter((t) => t.length > 0)
                .every((term) => haystack.some((v) => v.includes(term.toLowerCase())));
        }
        case "edge":
        case "within":
            throw new Error(`matchesSubjectRow: ${c.kind} conditions run in SQL only`);
    }
}

/** Order two rows by the sort keys, then by IRI, exactly as the compiled ORDER BY does. */
export function compareSubjectRows(
    a: SubjectRow,
    b: SubjectRow,
    sort: readonly SubjectSort[],
): number {
    for (const s of sort) {
        let order: number;
        if ("timestamp" in s.field) {
            order = lexCompare(a[s.field.timestamp], b[s.field.timestamp]);
        } else {
            const va = a.values.get(s.field.predicate.value)?.[0];
            const vb = b.values.get(s.field.predicate.value)?.[0];
            // A missing value sorts after every present one ascending.
            order =
                va === undefined || vb === undefined
                    ? Number(va === undefined) - Number(vb === undefined)
                    : compareLiterals(va, vb);
        }
        if (order !== 0) {
            return s.direction === "desc" ? -order : order;
        }
    }
    return foldCompare(a.iri, b.iri);
}
