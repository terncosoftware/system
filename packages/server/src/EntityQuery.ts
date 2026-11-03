import type { IRI, Literal } from "@terncosoftware/core";
import type {
    ListFilter,
    ListQuery,
    ListRow,
    ListSchema,
    ListWindow,
} from "@terncosoftware/core/list";
import type {
    SubjectCompareOp,
    SubjectCondition,
    SubjectField,
    SubjectQuery,
    SubjectRow,
    SubjectSort,
    TripleStore,
} from "@terncosoftware/data";
import { compareSubjectRows, escapeLike, matchesSubjectRow } from "@terncosoftware/data";
import type {
    EncryptedLiteral,
    EntityRecord,
    EntitySchema,
    FilterOp,
    IFieldCipher,
} from "@terncosoftware/entities";
import { propIri, toLiteral, XSD_STRING } from "@terncosoftware/entities";
import {
    type EdgeInput,
    type EntityInput,
    type EntityStore,
    edgeTargetIri,
} from "./EntityStore.js";
import { createEntityStore } from "./EntityStoreFactory.js";
import type { ServerContext } from "./ServerContext.js";
import { tenantGraph } from "./tenancy.js";

export type { FilterOp };

/** The timestamps every entity carries, derived from its edges. Sortable and comparable like a property. */
export type EntityTimestampField = "createdAt" | "updatedAt";

/** A field a query can sort and filter on: a schema property or an entity timestamp. */
export type EntityQueryField<Props> = (keyof Props & string) | EntityTimestampField;

/** One page of a query and how many entities its filters admit. */
export interface EntityPage<Props extends Record<string, unknown>> {
    readonly records: EntityRecord<Props>[];
    readonly total: number;
}

const COMPARE_OPS: Readonly<Record<string, SubjectCompareOp>> = {
    "=": "eq",
    "!=": "neq",
    "<": "lt",
    "<=": "lte",
    ">": "gt",
    ">=": "gte",
};

const LIST_COMPARE_OPS: Readonly<Record<string, FilterOp>> = {
    eq: "=",
    neq: "!=",
    lt: "<",
    lte: "<=",
    gt: ">",
    gte: ">=",
};

/**
 * Reads entities of one schema. Every filter, sort, search and page runs in
 * SQL, so a page costs the rows on it, not the rows of the type.
 *
 * Values order as `compareListValues` in `@terncosoftware/core/list` orders
 * them: a missing value sorts after every present one ascending, strings
 * compare case-insensitively and then exactly, and the entity IRI breaks
 * every tie, so the order is total and stable across pages.
 *
 * PII properties are encrypted at rest, so SQL cannot compare, sort or search
 * them. A query that filters, sorts or searches one narrows in SQL on its
 * other filters, then decrypts what is left and filters, sorts and pages that
 * in memory, by the same rules. Such a read costs the rows the other filters
 * admit, not the rows on the page. A PII value compares as the string it was
 * encrypted from.
 */
export class EntityQuery<Props extends Record<string, unknown>> {
    private readonly _es: EntityStore;
    private _where: SubjectCondition[] = [];
    private _sort: SubjectSort[] = [];
    private _limit?: number;
    private _offset?: number;
    private _acrossTenants = false;
    /** IRIs of the PII predicates this query names: SQL sees only their ciphertext. */
    private readonly _pii = new Set<string>();

    constructor(
        private readonly _store: TripleStore,
        private readonly _schema: EntitySchema<Props>,
        private readonly _cipher?: IFieldCipher,
    ) {
        // The cipher (when supplied) flows to the inner EntityStore so that
        // hydrating PII-bearing records decrypts them, matching ctx.cipher
        // semantics for callers that wire the cipher at construction instead.
        this._es = createEntityStore(_store, undefined, _cipher);
    }

    /**
     * Keep entities whose `prop` compares to `value`. A null value with `=`
     * keeps entities with no value, with `!=` those with any. `!=` keeps an
     * entity with no value. LIKE and ILIKE take a SQL pattern on the lexical
     * value, with backslash escaping `%` and `_`.
     */
    where(prop: EntityQueryField<Props>, op: FilterOp, value: unknown): this {
        const field = this._field(prop);
        if (op === "LIKE" || op === "ILIKE") {
            this._where.push({
                kind: "like",
                predicate: this._predicate(field, prop, op),
                pattern: String(value),
                caseInsensitive: op === "ILIKE",
            });
            return this;
        }
        const compare = COMPARE_OPS[op];
        if (compare === undefined) {
            throw new Error(`EntityQuery.where: unknown operator "${String(op)}"`);
        }
        this._where.push({
            kind: "compare",
            field,
            op: compare,
            value: this._literal(field, value),
        });
        return this;
    }

    /** Keep entities whose `prop` equals any of `values`. An empty list keeps nothing; null matches no value. */
    whereIn(prop: keyof Props & string, values: readonly unknown[]): this {
        const field = this._field(prop);
        const predicate = this._predicate(field, prop, "whereIn");
        this._where.push({
            kind: "in",
            predicate,
            values: values.map((v) => this._literal(field, v)),
        });
        return this;
    }

    /**
     * Keep entities where every whitespace-separated term of `text` appears,
     * case-insensitively, in one of `props`. Blank text keeps everything.
     */
    search(text: string, props: readonly (keyof Props & string)[]): this {
        const terms = text.split(/\s+/).filter(Boolean);
        if (terms.length === 0) {
            return this;
        }
        const predicates = props.map((p) => this._predicate(this._field(p), p, "search"));
        this._where.push({ kind: "search", predicates, terms });
        return this;
    }

    /**
     * Read across EVERY tenant graph instead of the caller's own: the
     * sanctioned escape hatch for system surfaces (superuser dashboards,
     * install-wide metrics) whose whole point is a cross-tenant view.  The
     * caller is responsible for gating access (e.g. behind a superuser guard);
     * request paths must never use this; they stay scoped to ctx.tenantId.
     */
    acrossTenants(): this {
        this._acrossTenants = true;
        return this;
    }

    /** Add a sort key. Keys apply in the order they are added; the entity IRI breaks remaining ties. */
    orderBy(prop: EntityQueryField<Props>, dir: "asc" | "desc" = "asc"): this {
        this._sort.push({ field: this._field(prop), direction: dir });
        return this;
    }

    /**
     * Filter to entities whose `edge` points at `target` (an id, IRI, or record).
     * This is the topological replacement for `.where('fooId', '=', …)`: it
     * matches on the IRI-object edge, not a foreign-key scalar.
     */
    connectedTo(edge: string, target: EdgeInput): this {
        return this.connectedToAny(edge, [target]);
    }

    /**
     * Filter to entities whose `edge` points at ANY of `targets`, the reverse
     * batched form of connectedTo (e.g. grants whose hasPrincipal is in a
     * principal set). An empty set matches nothing.
     */
    connectedToAny(edge: string, targets: EdgeInput[]): this {
        const def = this._schema.edges?.[edge];
        if (!def) {
            throw new Error(`EntityQuery: schema has no edge "${edge}"`);
        }
        this._where.push({
            kind: "edge",
            predicate: def.predicate,
            targets: targets.map((t) => ({ value: edgeTargetIri(t, def.target?.()) }) as IRI),
        });
        return this;
    }

    /**
     * Filter to entities that lie within the subtree rooted at `root`, following
     * the given `edge`'s predicate (e.g. `.within('parent', folderId)` returns the
     * folder and everything transitively under it).  Evaluated as one recursive CTE.
     */
    within(edge: string, root: EdgeInput): this {
        const def = this._schema.edges?.[edge];
        if (!def) {
            throw new Error(`EntityQuery: schema has no edge "${edge}"`);
        }
        this._where.push({
            kind: "within",
            predicate: def.predicate,
            root: { value: edgeTargetIri(root, def.target?.()) } as IRI,
        });
        return this;
    }

    limit(n: number): this {
        this._limit = n;
        return this;
    }

    offset(n: number): this {
        this._offset = n;
        return this;
    }

    /**
     * Narrow this query to one list window: the query's sort, filters, search
     * and page. List field names are schema property names or an entity
     * timestamp, and the list's key must be the record id, since the entity
     * IRI is the tiebreak. `toRow` turns each record on the page into its row.
     */
    async window<Row extends ListRow>(
        ctx: ServerContext,
        query: ListQuery,
        schema: ListSchema,
        toRow: (record: EntityRecord<Props>) => Row,
    ): Promise<ListWindow<Row>> {
        for (const sort of query.sort) {
            this.orderBy(sort.field as EntityQueryField<Props>, sort.direction);
        }
        for (const filter of query.filters) {
            this._applyListFilter(filter);
        }
        this.search(query.search, schema.searchFields as (keyof Props & string)[]);
        const { offset, limit } = query.page;
        const page = await this.offset(offset).limit(limit).page(ctx);
        return { rows: page.records.map(toRow), total: page.total, offset, limit };
    }

    /** The page this query's limit and offset select, and how many entities its filters admit. */
    async page(ctx: ServerContext): Promise<EntityPage<Props>> {
        return this._store.withTransaction(ctx, async (txCtx) => {
            const { subjects, total } = this._needsPlaintext()
                ? await this._selectDecrypted(txCtx)
                : await this._store.selectSubjects(txCtx, this._query(txCtx));
            const records = await this._hydrate(txCtx, subjects);
            return { records, total };
        });
    }

    async all(ctx: ServerContext): Promise<EntityRecord<Props>[]> {
        return (await this.page(ctx)).records;
    }

    async first(ctx: ServerContext): Promise<EntityRecord<Props> | null> {
        const results = await this.limit(1).all(ctx);
        return results[0] ?? null;
    }

    /** How many entities the filters admit, whatever the limit and offset. */
    async count(ctx: ServerContext): Promise<number> {
        return this._store.withTransaction(ctx, async (txCtx) =>
            this._needsPlaintext()
                ? (await this._selectDecrypted(txCtx)).total
                : this._store.countSubjects(txCtx, this._query(txCtx)),
        );
    }

    async create(ctx: ServerContext, data: EntityInput<Props>): Promise<EntityRecord<Props>> {
        return this._es.create(ctx, this._schema, data);
    }

    async save(ctx: ServerContext, record: EntityRecord<Props>): Promise<void> {
        return this._es.update(ctx, this._schema, record.id, record.props);
    }

    async delete(ctx: ServerContext, id: string): Promise<void> {
        return this._es.delete(ctx, this._schema, id);
    }

    get store(): TripleStore {
        return this._store;
    }

    // ── Static / free function ────────────────────────────────────────────────

    /** Convenience: start a query from a raw store (no ctx required at this point). */
    static from<Props extends Record<string, unknown>>(
        store: TripleStore,
        schema: EntitySchema<Props>,
        cipher?: IFieldCipher,
    ): EntityQuery<Props> {
        return new EntityQuery(store, schema, cipher);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    /**
     * The scope a query reads in: a schema's fixed graphIri wins, otherwise the
     * caller's tenant graph (null is the default graph). It mirrors
     * EntityStore._filterGraph so a query and its store agree on scope;
     * acrossTenants() reads every graph.
     */
    private _query(ctx: ServerContext): SubjectQuery {
        return {
            type: this._schema.typeIRI,
            scope: this._acrossTenants
                ? { acrossTenants: true }
                : { graph: this._schema.graphIri ?? tenantGraph(ctx, this._schema.graph) },
            where: this._where,
            sort: this._sort,
            offset: this._offset,
            limit: this._limit,
        };
    }

    /** True when a condition or the sort reads a PII value, which SQL sees only as ciphertext. */
    private _needsPlaintext(): boolean {
        return this._where.some((c) => this._readsPii(c)) || this._sortReadsPii();
    }

    private _readsPii(c: SubjectCondition): boolean {
        switch (c.kind) {
            case "compare":
                return "predicate" in c.field && this._pii.has(c.field.predicate.value);
            case "in":
            case "like":
                return this._pii.has(c.predicate.value);
            case "search":
                return c.predicates.some((p) => this._pii.has(p.value));
            default:
                return false;
        }
    }

    private _sortReadsPii(): boolean {
        return this._sort.some(
            (s) => "predicate" in s.field && this._pii.has(s.field.predicate.value),
        );
    }

    /**
     * The page and total for a query that reads PII: SQL applies every
     * condition it can, then the rest, the sort and the page run in memory
     * over the decrypted values.
     */
    private async _selectDecrypted(
        ctx: ServerContext,
    ): Promise<{ subjects: IRI[]; total: number }> {
        const cipher = ctx.cipher ?? this._cipher;
        if (!cipher) {
            throw new Error(
                "EntityQuery: this query reads a PII property but no field cipher is available " +
                    "on the context or query, so it cannot decrypt it.",
            );
        }
        const inMemory = this._where.filter((c) => this._readsPii(c));
        const predicates = new Map<string, IRI>();
        const read = (p: IRI): void => {
            predicates.set(p.value, p);
        };
        for (const c of inMemory) {
            if (c.kind === "search") {
                c.predicates.forEach(read);
            } else if (c.kind === "compare") {
                read((c.field as { predicate: IRI }).predicate);
            } else if (c.kind === "in" || c.kind === "like") {
                read(c.predicate);
            }
        }
        for (const s of this._sort) {
            if ("predicate" in s.field) {
                read(s.field.predicate);
            }
        }
        const query = { ...this._query(ctx), where: this._where.filter((c) => !this._readsPii(c)) };
        const rows = (await this._store.subjectRows(ctx, query, [...predicates.values()]))
            .map((row) => this._decryptRow(row, cipher))
            .filter((row) => inMemory.every((c) => matchesSubjectRow(row, c)))
            .sort((a, b) => compareSubjectRows(a, b, this._sort));
        const start = this._offset ?? 0;
        const end = this._limit === undefined ? undefined : start + this._limit;
        return {
            subjects: rows.slice(start, end).map((row) => ({ value: row.iri }) as IRI),
            total: rows.length,
        };
    }

    /** A row with each PII value replaced by the string it was encrypted from. */
    private _decryptRow(row: SubjectRow, cipher: IFieldCipher): SubjectRow {
        const values = new Map(row.values);
        for (const [predicate, literals] of values) {
            if (this._pii.has(predicate)) {
                values.set(
                    predicate,
                    literals.map((lit) => ({
                        termType: "Literal",
                        value: cipher.decrypt(
                            (lit as Partial<EncryptedLiteral>).keyId ?? cipher.currentKeyId,
                            lit.value,
                        ),
                        datatype: XSD_STRING,
                    })),
                );
            }
        }
        return { ...row, values };
    }

    private async _hydrate(ctx: ServerContext, subjects: IRI[]): Promise<EntityRecord<Props>[]> {
        if (subjects.length === 0) {
            return [];
        }
        return this._es.hydrateMany(
            ctx,
            this._schema,
            subjects.map((s) => s.value),
            { acrossTenants: this._acrossTenants },
        );
    }

    /** A schema property or an entity timestamp. A PII property is noted, for _selectDecrypted. */
    private _field(prop: string): SubjectField {
        const def = (this._schema.properties as Record<string, unknown>)[prop] as
            | Parameters<typeof propIri>[0]
            | undefined;
        if (def !== undefined) {
            const predicate = propIri(def);
            if (typeof def === "object" && "pii" in def && def.pii === true) {
                this._pii.add(predicate.value);
            }
            return { predicate };
        }
        if (prop === "createdAt" || prop === "updatedAt") {
            return { timestamp: prop };
        }
        throw new Error(`EntityQuery: schema has no property "${prop}"`);
    }

    private _predicate(field: SubjectField, prop: string, use: string): IRI {
        if ("predicate" in field) {
            return field.predicate;
        }
        throw new Error(`EntityQuery: ${use} cannot apply to the "${prop}" timestamp`);
    }

    /** A PII value is stored as the string form of what was written, so it compares as one. */
    private _literal(field: SubjectField, value: unknown): Literal | null {
        if (value === null || value === undefined) {
            return null;
        }
        const literal = toLiteral(value);
        return "predicate" in field && this._pii.has(field.predicate.value)
            ? { ...literal, datatype: XSD_STRING }
            : literal;
    }

    private _applyListFilter(filter: ListFilter): void {
        const prop = filter.field as keyof Props & string;
        const { value } = filter;
        if (filter.op === "in") {
            this.whereIn(prop, Array.isArray(value) ? value : [value]);
            return;
        }
        if (filter.op === "contains") {
            this.where(prop, "ILIKE", `%${escapeLike(String(value ?? ""))}%`);
            return;
        }
        if (Array.isArray(value)) {
            throw new Error(`EntityQuery: the "${filter.op}" filter takes one value, not a list`);
        }
        const op = LIST_COMPARE_OPS[filter.op];
        if (op === undefined) {
            throw new Error(`EntityQuery: unknown list filter "${filter.op}"`);
        }
        this.where(prop as EntityQueryField<Props>, op, value);
    }
}
