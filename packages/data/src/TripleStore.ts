import {
    type ApplicationContext,
    type BlankNode,
    DEFAULT_GRAPH,
    type DefaultGraph,
    type IRI,
    type Literal,
    type Quad,
} from "@terncosoftware/core";
import type { Knex } from "knex";
import { C, DEFAULT_GRAPH_IRI, type LiteralJson, type NodeKind, T } from "./schema.js";
import {
    type CompiledSubjectQuery,
    compileSubjectQuery,
    PG_DIALECT,
    SQLITE_DIALECT,
    type SubjectQuery,
    subjectQueryIris,
} from "./subjectQuery.js";

interface ServerContext extends ApplicationContext {
    trx?: Knex.Transaction;
}

// ── Internal row types ────────────────────────────────────────────────────────

interface NodeRow {
    id: number;
    kind: NodeKind;
    /** IRI string for kind='iri'; null otherwise. */
    iri: string | null;
    /** Blank-node identifier for kind='blank'; null otherwise. */
    blank_id: string | null;
    value: string | null;
    dt: string | null;
    lang: string | null;
    /** JSONB payload for literal nodes.  May be an object (Postgres) or JSON string (SQLite). */
    value_json: LiteralJson | string | null;
    created_at: string;
    updated_at: string;
}
interface EdgeRow {
    id: number;
    subject: number;
    predicate: number;
    object: number;
    graph: number;
    created_at: string;
    updated_at: string;
    is_deleted: boolean;
    deleted_at: string | null;
}

type RdfTerm = IRI | BlankNode | Literal;

/**
 * A pattern resolved for a WHERE clause: node ids for IRI and blank terms, and
 * a literal object kept as its value, since a value can have many nodes.
 */
interface PatternIds {
    subject?: number;
    predicate?: number;
    object?: number;
    objectLiteral?: Literal;
    graphId?: number;
}

/**
 * A literal whose lexical `value` already holds ciphertext.  The entity layer
 * produces these for PII properties: it encrypts the plaintext before the value
 * ever reaches the store, then tags the term with the key id so internment can
 * persist the `is_encrypted` / `key_id` columns on the node row.  The store
 * stays oblivious to plaintext — it never encrypts or decrypts, it only records
 * that the interned value is ciphertext.  The extra fields are in-process hints
 * on the quad object and are never written as RDF.
 */
interface EncryptedLiteral extends Literal {
    /** Marks `value` as ciphertext. */
    encrypted: true;
    /** Id of the key that produced the ciphertext (persisted for rotation). */
    keyId: string;
}

function isLiteral(term: RdfTerm): term is Literal {
    return "termType" in term && term.termType === "Literal";
}

function isEncryptedLiteral(term: RdfTerm): term is EncryptedLiteral {
    return (
        "termType" in term &&
        term.termType === "Literal" &&
        (term as Partial<EncryptedLiteral>).encrypted === true
    );
}

// ── Module-level constants ────────────────────────────────────────────────────

const DEFAULT_GRAPH_NODE = makeIRI(DEFAULT_GRAPH_IRI);

// ── Literal JSONB helpers ─────────────────────────────────────────────────────

const XSD = "http://www.w3.org/2001/XMLSchema#";

function coerceLiteralValue(value: string, datatypeIri: string): string | number | boolean {
    switch (datatypeIri) {
        case `${XSD}boolean`:
            return value === "true";
        case `${XSD}integer`:
        case `${XSD}int`:
        case `${XSD}long`:
        case `${XSD}short`:
        case `${XSD}byte`:
        case `${XSD}unsignedInt`:
        case `${XSD}unsignedLong`:
        case `${XSD}unsignedShort`: {
            const n = parseInt(value, 10);
            return Number.isNaN(n) ? value : n;
        }
        case `${XSD}decimal`:
        case `${XSD}float`:
        case `${XSD}double`: {
            const n = parseFloat(value);
            return Number.isNaN(n) ? value : n;
        }
        default:
            return value;
    }
}

function makeLiteralJson(value: string, datatypeIri: string, language?: string): LiteralJson {
    const json: LiteralJson = { v: coerceLiteralValue(value, datatypeIri) };
    if (language) {
        json.lang = language;
    }
    return json;
}

function parseLiteralJson(raw: LiteralJson | string | null): LiteralJson | null {
    if (!raw) {
        return null;
    }
    if (typeof raw === "string") {
        return JSON.parse(raw) as LiteralJson;
    }
    /* c8 ignore next -- Postgres returns JSONB as a pre-parsed object; SQLite always returns a string */
    return raw;
}

// ── Term helpers ──────────────────────────────────────────────────────────────

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

function makeIRI(iriStr: string): IRI {
    return { value: iriStr } as IRI;
}

function isIRI(term: RdfTerm): term is IRI {
    return !("termType" in term);
}

function nodeToTerm(row: NodeRow): RdfTerm {
    if (row.kind === "iri") {
        if (row.iri == null) {
            throw new Error("nodeToTerm: iri must not be null for IRI node");
        }
        return makeIRI(row.iri);
    }
    if (row.kind === "blank") {
        if (row.blank_id == null) {
            throw new Error("nodeToTerm: blank_id must not be null for blank node");
        }
        return { termType: "BlankNode", id: row.blank_id } satisfies BlankNode;
    }

    // Literal — prefer the typed JSONB payload when present
    const json = parseLiteralJson(row.value_json);
    /* v8 ignore next -- row.dt is always set by ensureNode */
    const dtIri = row.dt ?? "http://www.w3.org/2001/XMLSchema#string";
    if (json) {
        return {
            termType: "Literal",
            value: String(json.v),
            datatype: makeIRI(dtIri),
            language: json.lang ?? undefined,
        } satisfies Literal;
    }

    // Fallback: rows without value_json (pre-002 rows in existing DBs)
    if (row.value == null) {
        throw new Error("nodeToTerm: value must not be null for literal node");
    }
    return {
        termType: "Literal",
        value: row.value,
        datatype: makeIRI(dtIri),
        language: row.lang ?? undefined,
    } satisfies Literal;
}

// ── Public API types ──────────────────────────────────────────────────────────

/**
 * The term half of a pattern: which quads to match, saying nothing about where
 * to look for them.  Only findAcrossTenants() takes terms on their own.
 */
export interface QuadTerms {
    subject?: IRI | BlankNode;
    predicate?: IRI;
    object?: IRI | BlankNode | Literal;
}

/**
 * Terms plus the scope they are read in.
 *
 * `graph` is required.  Scope is a decision the caller makes, never one that
 * falls out of leaving a key off: pass a named graph IRI to read that tenant,
 * or `null` to read the default graph (urn:sys:graph:default), where
 * provisioning writes users, orgs, tenants and memberships.  To read every
 * tenant's graph at once, call findAcrossTenants() instead.
 */
export interface QuadPattern extends QuadTerms {
    graph: IRI | null;
}

/**
 * Rejects a read that declares no scope.
 *
 * An omitted `graph` reaches _patternIds as undefined, which adds no WHERE
 * clause and so reads every graph in the database, which is to say every
 * tenant.  That is a real thing to want and a terrible thing to get by
 * accident, because it looks exactly like a scoped read at the call site and
 * its symptom (rows from a tenant you never asked about, or zero rows once a
 * caller is tenanted) never points back here.  TypeScript already requires
 * `graph`; this catches the JS callers and the casts it cannot see.
 */
function assertScoped(pattern: Partial<QuadPattern>, method: string): void {
    if (pattern.graph !== undefined) {
        return;
    }
    throw new Error(
        `TripleStore.${method}() was given a pattern with no 'graph', which would read across ` +
            "every tenant's graph. Declare the scope: 'graph: tenantGraph(ctx)' reads the " +
            "caller's tenant, and 'graph: null' reads the default graph " +
            "(urn:sys:graph:default), where users, orgs, tenants and memberships live. " +
            "To span tenants on purpose, call TripleStore.findAcrossTenants().",
    );
}

/** DB-managed creation/modification timestamps for an entity (a subject IRI). */
export interface EntityTimestamps {
    /** Earliest created_at across the subject's live edges (anchored by rdf:type). */
    createdAt: Date;
    /** Latest updated_at across the subject's live edges (newest write). */
    updatedAt: Date;
}

/** A quad annotated with its temporal metadata (returned by findHistory). */
export interface QuadHistory extends Quad {
    /** When this edge was first asserted. */
    createdAt: Date;
    /** When this edge was last modified (same as deletedAt when soft-deleted). */
    updatedAt: Date;
    /** True if this version has been superseded by a newer assertion. */
    isDeleted: boolean;
    /** When this version was soft-deleted; null while still active. */
    deletedAt: Date | null;
}

/**
 * Options for a transitive-closure (reachability) walk over the edge graph.
 *
 * Starting from `roots`, follow edges whose predicate is in `predicates`,
 * in the given `direction`, and return every node reached (including the roots
 * unless `includeRoots` is false).  The walk is evaluated as a single recursive
 * CTE — one round-trip regardless of depth — and is cycle-safe.
 */
export interface ReachOptions {
    /** Starting nodes for the walk. */
    roots: readonly IRI[];
    /** Edge predicates to follow.  Empty ⇒ only the roots are reachable. */
    predicates: readonly IRI[];
    /**
     * "out" follows subject → object (e.g. memberOf, inheritsFrom, parent).
     * "in"  follows object → subject (e.g. find a subtree's descendants from its root).
     */
    direction: "out" | "in";
    /** Graph scope: an IRI for a named graph, null for the default graph, undefined for any graph. */
    graph?: IRI | null;
    /**
     * Maximum number of hops from the roots.  When set, depth is bounded
     * (roots are depth 0).  When omitted, the walk runs to full closure using
     * set semantics, which terminates even on cyclic graphs.
     */
    maxDepth?: number;
    /** Include the root IRIs in the result.  Defaults to true. */
    includeRoots?: boolean;
}

/** One hop in a rooted traversal: follow `predicate` out (current→next) or in (next→current). */
export interface TraverseHop {
    predicate: IRI;
    direction: "out" | "in";
}

/**
 * A rooted graph traversal: the path that every domain query must walk from the
 * tenant root down to its leaf. Compiles to a single chain of inner joins on
 * edges (one per hop), scoped to `graph` and live edges, so a result is
 * returned only if the full root→leaf path exists. There is no flat
 * "find nodes of type X" — reachability from the root is the query.
 */
export interface RootedTraverseOpts {
    /** The node the path must start from (e.g. the caller's tenant). */
    root: IRI;
    /** Ordered hops from the root to the leaf. Empty ⇒ the leaf is the root. */
    hops: readonly TraverseHop[];
    /** Graph scope: a named graph IRI, null for the default graph, undefined for any graph. */
    graph?: IRI | null;
    /** Optional rdf:type constraint on the leaf node. */
    leafType?: IRI;
    /** Optional leaf property-equality constraints (leaf --predicate--> object). */
    leafEq?: readonly { predicate: IRI; object: IRI | Literal }[];
}

export interface StoreStats {
    namespaces: number;
    nodes: number;
    /** Count of active (non-deleted) edges only. */
    edges: number;
    /** Count of all edges including soft-deleted history. */
    edgesTotal: number;
}

// ── TripleStore ───────────────────────────────────────────────────────────────

/**
 * Graph + time-series RDF quad store backed by Knex.
 *
 * Schema (see migrations/001_init.ts):
 *   namespaces — prefix → IRI mappings
 *   nodes      — every RDF term (IRI / blank / literal).
 *                IRI nodes store the full IRI string in the `iri` column.
 *                Blank nodes store the blank-node identifier in `blank_id`.
 *                Literal nodes store lexical form in `value`, datatype IRI in
 *                `datatype`, language in `lang`, and a typed JSONB payload in
 *                `value_json`.
 *   edges      — quads (subject, predicate, object, graph) with full temporal
 *                     metadata.  The `graph` column is always non-null: quads in the
 *                     RDF default graph use the well-known IRI urn:sys:graph:default.
 *
 * All writes are append-only:
 *   - IRI and blank nodes are interned on first use and never deleted.
 *   - Literal nodes are not interned: each edge that asserts a literal gets
 *     its own literal node.  Looking a value up across every literal before
 *     writing it cost a scan of the whole table per write, and buys nothing.
 *   - Every write persists: asserting a quad that is already active adds
 *     another edge, stamped with its own created_at.  Setting a user's name
 *     to the same value twice records two writes.  `dedupeQuads` restores
 *     the old skip-if-present check; it is off by default.
 *   - Edges are soft-deleted (is_deleted=true + deleted_at timestamp) rather than
 *     physically removed.  findHistory() returns the full audit trail.
 *
 * @internal
 * TripleStore is the low-level quad store and is NOT the public data-access API.
 * The public surface is EntityStore / EntityQuery (built on top of this in
 * @terncosoftware/server), which add domain entities, schema-aware projection, PII
 * decryption, and rooted-traversal queries.  Do NOT add new direct importers of
 * TripleStore from application or bounded-context code — the architecture gate
 * test (packages/test/src/architecture/triplestore-internal.test.ts) enforces
 * this.  Only the entity infrastructure, migrations, documented host-side
 * `get store()` seams, and sandbox demos use it directly.
 */
export interface TripleStoreOptions {
    /**
     * Skip a write whose quad is already active, at the cost of a lookup per
     * write. Off by default: every write persists as its own edge.
     */
    dedupeQuads?: boolean;
}

export class TripleStore {
    private readonly _knex: Knex;

    /**
     * Process-wide serialization tail for top-level transactions.
     *
     * withTransaction is re-entrant: a nested call reuses the ambient ctx.trx, so
     * a single transaction's one connection is shared by all the work inside it.
     * That is safe only if no OTHER transaction runs at the same time. This lock
     * serializes the opening of top-level transactions across the whole process,
     * so at most one transaction is ever in flight: a reused trx can never be
     * raced by an independent transaction, and the single-connection (SQLite) and
     * pooled (Postgres) paths behave identically.
     *
     * Re-entrant calls (ctx.trx already set) must NOT take the lock: they run
     * inside the holder's critical section, and re-acquiring would deadlock the
     * holder against itself. Likewise, opening a fresh top-level transaction from
     * inside another transaction (a trx-less ctx used mid-transaction) would
     * deadlock by design and indicates a context that should have been threaded
     * through instead.
     *
     * Tradeoff: top-level transactions cannot run in parallel within a process (a
     * long or stuck transaction is head-of-line for the rest). The common path,
     * nested/re-entrant work under one request transaction, is unaffected.
     */
    private static _txTail: Promise<unknown> = Promise.resolve();

    private readonly _dedupeQuads: boolean;

    constructor(knex: Knex, options: TripleStoreOptions = {}) {
        this._knex = knex;
        this._dedupeQuads = options.dedupeQuads ?? false;
    }

    /** Direct access to the underlying Knex instance for advanced queries. */
    get knex(): Knex {
        return this._knex;
    }

    /**
     * Returns the transaction to run a query on. Every store operation MUST run
     * inside a transaction — nothing executes outside one, not even a single
     * read. Callers establish a transaction with `withTransaction(ctx, ...)`,
     * which threads `ctx.trx`. Hitting the raw connection would commit
     * immediately and outside any unit of work, so the absence of `ctx.trx` is
     * a programming error and throws rather than silently falling back.
     */
    private _db(ctx: ServerContext): Knex {
        const trx = ctx.trx as Knex | undefined;
        if (!trx) {
            throw new Error(
                "TripleStore: no active transaction. Every store operation must run inside " +
                    "store.withTransaction(ctx, ...) — no query may execute outside a transaction.",
            );
        }
        return trx;
    }

    /** Inserts a row and returns its auto-increment ID, for both Postgres and SQLite. */
    private async _insert(
        ctx: ServerContext,
        table: string,
        data: Record<string, unknown>,
    ): Promise<number> {
        if (this._isPg()) {
            const [row] = (await this._db(ctx)(table).insert(data).returning("id")) as [
                { id: number },
            ];
            return row.id;
        }
        const [id] = (await this._db(ctx)(table).insert(data)) as [number];
        return id;
    }

    // ── Transaction ───────────────────────────────────────────────────────────

    async withTransaction<T, C extends ServerContext>(
        ctx: C,
        fn: (ctx: C) => Promise<T>,
    ): Promise<T> {
        if (ctx.trx) {
            // Re-entrant: reuse the ambient transaction. Taking the process-wide
            // lock here would deadlock, since its holder is awaiting this call.
            return fn(ctx);
        }
        const open = (): Promise<T> =>
            this._knex.transaction(async (trx) => fn({ ...ctx, trx } as C));
        // Chain behind any in-flight top-level transaction, running whether the
        // predecessor committed or rolled back, then advance the tail so the next
        // top-level transaction waits for this one.
        const result = TripleStore._txTail.then(open, open);
        TripleStore._txTail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    // ── Namespace registry ────────────────────────────────────────────────────

    async ensureNamespace(ctx: ServerContext, prefix: string, iriStr: string): Promise<number> {
        return this.withTransaction(ctx, (ctx) => this._ensureNamespace(ctx, prefix, iriStr));
    }

    private async _ensureNamespace(
        ctx: ServerContext,
        prefix: string,
        iriStr: string,
    ): Promise<number> {
        const row = await this._db(ctx)(T.namespaces)
            .where(C.prefix, prefix)
            .first<{ id: number }>();
        if (row) {
            return row.id;
        }
        return this._insert(ctx, T.namespaces, { [C.prefix]: prefix, [C.iri]: iriStr });
    }

    // ── Term internment ───────────────────────────────────────────────────────

    async ensureNode(ctx: ServerContext, term: RdfTerm): Promise<number> {
        return this.withTransaction(ctx, (ctx) => this._ensureNode(ctx, term));
    }

    private async _ensureNode(ctx: ServerContext, term: RdfTerm): Promise<number> {
        if (isIRI(term)) {
            const row = await this._db(ctx)(T.nodes)
                .where({ [C.kind]: "iri", [C.iri]: term.value })
                .first<NodeRow>();
            if (row) {
                return row.id;
            }
            return this._insert(ctx, T.nodes, { [C.kind]: "iri", [C.iri]: term.value });
        }

        if (term.termType === "BlankNode") {
            const row = await this._db(ctx)(T.nodes)
                .where({ [C.kind]: "blank", [C.blankId]: term.id })
                .first<NodeRow>();
            if (row) {
                return row.id;
            }
            return this._insert(ctx, T.nodes, { [C.kind]: "blank", [C.blankId]: term.id });
        }

        // A literal gets a node of its own; see the class comment.
        /* v8 ignore next */
        const dtIri = term.datatype?.value ?? "http://www.w3.org/2001/XMLSchema#string";
        const jsonPayload = makeLiteralJson(term.value, dtIri, term.language);
        const encrypted = isEncryptedLiteral(term);
        return this._insert(ctx, T.nodes, {
            [C.kind]: "literal",
            [C.value]: term.value,
            [C.dt]: dtIri,
            [C.lang]: term.language ?? null,
            [C.valueJson]: JSON.stringify(jsonPayload),
            [C.isEncrypted]: encrypted,
            [C.keyId]: encrypted ? term.keyId : null,
        });
    }

    // ── Write ─────────────────────────────────────────────────────────────────

    /**
     * Asserts a quad as a new edge row, even when an identical quad is
     * already active (unless the store was built with `dedupeQuads`).
     *
     * Quads with `graph: DEFAULT_GRAPH` or no graph are stored under the
     * well-known IRI urn:sys:graph:default so `graph` is never null.
     */
    async insert(ctx: ServerContext, quad: Quad): Promise<void> {
        return this.withTransaction(ctx, (ctx) => this._insertQuad(ctx, quad));
    }

    private async _insertQuad(ctx: ServerContext, quad: Quad): Promise<void> {
        // Sequential, not Promise.all: all three run on the transaction's single
        // connection, which executes one statement at a time. Issuing them
        // together does not overlap them - the driver queues them and warns that
        // the client is already executing a query, a warning pg 9 turns into an
        // error. Awaiting each in turn is what was actually happening, said
        // plainly.
        const sId = await this._ensureNode(ctx, quad.subject as RdfTerm);
        const pId = await this._ensureNode(ctx, quad.predicate as IRI);

        const gIsDefault =
            !quad.graph || ("termType" in quad.graph && quad.graph.termType === "DefaultGraph");
        const graphTerm = gIsDefault ? DEFAULT_GRAPH_NODE : (quad.graph as IRI);
        const gId = await this._ensureNode(ctx, graphTerm);

        const object = quad.object as RdfTerm;
        if (this._dedupeQuads && (await this._isActive(ctx, sId, pId, object, gId))) {
            return;
        }
        const oId = await this._ensureNode(ctx, object);

        await this._db(ctx)(T.edges).insert({
            [C.subject]: sId,
            [C.predicate]: pId,
            [C.object]: oId,
            [C.graph]: gId,
            [C.isDeleted]: false,
        });
    }

    async insertMany(ctx: ServerContext, quads: readonly Quad[]): Promise<void> {
        return this.withTransaction(ctx, async (ctx) => {
            for (const q of quads) {
                await this.insert(ctx, q);
            }
        });
    }

    // ── Read ──────────────────────────────────────────────────────────────────

    /**
     * Finds all active (non-deleted) quads in the pattern's graph.
     * To include historical (soft-deleted) quads, use findHistory().
     */
    async find(ctx: ServerContext, pattern: QuadPattern): Promise<Quad[]> {
        assertScoped(pattern, "find");
        return this.withTransaction(ctx, (ctx) => this._find(ctx, pattern));
    }

    /**
     * Finds all active quads in EVERY tenant's graph.
     *
     * The deliberate cross-tenant read, and the only one: find() requires a
     * scope, so spanning tenants cannot be reached by omitting a key.  Callers
     * are the few surfaces that are cross-tenant by definition, and each says
     * why at its call site.
     */
    async findAcrossTenants(ctx: ServerContext, terms: QuadTerms): Promise<Quad[]> {
        return this.withTransaction(ctx, (ctx) => this._find(ctx, terms));
    }

    private async _find(ctx: ServerContext, pattern: Partial<QuadPattern>): Promise<Quad[]> {
        let q = this._db(ctx)(T.edges).where(C.isDeleted, false).select<EdgeRow[]>("*");
        const ids = await this._patternIds(ctx, pattern);
        if (ids === null) {
            return [];
        }
        q = this._addPatternClauses(q, ids);
        const edges = await q;
        if (edges.length === 0) {
            return [];
        }
        return this._hydrateEdges(ctx, edges);
    }

    /**
     * Like find(), but returns edges sorted by insertion order (edge id ascending).
     * Use this when the order of results is semantically meaningful (e.g. ordered collections).
     */
    async findOrdered(ctx: ServerContext, pattern: QuadPattern): Promise<Quad[]> {
        assertScoped(pattern, "findOrdered");
        return this.withTransaction(ctx, (ctx) => this._findOrdered(ctx, pattern));
    }

    private async _findOrdered(ctx: ServerContext, pattern: Partial<QuadPattern>): Promise<Quad[]> {
        let q = this._db(ctx)(T.edges)
            .where(C.isDeleted, false)
            .orderBy(C.id, "asc")
            .select<EdgeRow[]>("*");
        const ids = await this._patternIds(ctx, pattern);
        if (ids === null) {
            return [];
        }
        q = this._addPatternClauses(q, ids);
        const edges = await q;
        if (edges.length === 0) {
            return [];
        }
        return this._hydrateEdges(ctx, edges);
    }

    /**
     * Returns ALL versions of quads matching the pattern, including soft-deleted
     * ones, in ascending creation order.  Each result is annotated with temporal metadata.
     */
    async findHistory(ctx: ServerContext, pattern: QuadPattern): Promise<QuadHistory[]> {
        assertScoped(pattern, "findHistory");
        return this.withTransaction(ctx, (ctx) => this._findHistory(ctx, pattern));
    }

    private async _findHistory(
        ctx: ServerContext,
        pattern: Partial<QuadPattern>,
    ): Promise<QuadHistory[]> {
        let q = this._db(ctx)(T.edges).orderBy(C.createdAt, "asc").select<EdgeRow[]>("*");
        const ids = await this._patternIds(ctx, pattern);
        if (ids === null) {
            return [];
        }
        q = this._addPatternClauses(q, ids);
        const edges = await q;
        if (edges.length === 0) {
            return [];
        }

        const nodeIds = new Set<number>();
        for (const e of edges) {
            nodeIds.add(e.subject);
            nodeIds.add(e.predicate);
            nodeIds.add(e.object);
            nodeIds.add(e.graph);
        }
        const nodeMap = await this._loadNodes(ctx, [...nodeIds]);

        return edges.map((e) => {
            const subject = nodeMap.get(e.subject);
            if (subject == null) {
                throw new Error(`findHistory: missing node for subject id ${e.subject}`);
            }
            const predicate = nodeMap.get(e.predicate);
            if (predicate == null) {
                throw new Error(`findHistory: missing node for predicate id ${e.predicate}`);
            }
            const object = nodeMap.get(e.object);
            if (object == null) {
                throw new Error(`findHistory: missing node for object id ${e.object}`);
            }
            const graph = this._graphTermFromNode(nodeMap.get(e.graph));
            return {
                subject: subject as IRI | BlankNode,
                predicate: predicate as IRI,
                object: object as RdfTerm,
                graph,
                createdAt: new Date(e.created_at),
                updatedAt: new Date(e.updated_at),
                isDeleted: !!e.is_deleted,
                deletedAt: e.deleted_at ? new Date(e.deleted_at) : null,
            };
        });
    }

    // ── Soft delete ───────────────────────────────────────────────────────────

    /**
     * Soft-deletes all active edges matching the pattern.
     * Returns the count of edges marked as deleted.
     * No data is physically removed.
     */
    async delete(ctx: ServerContext, pattern: QuadPattern): Promise<number> {
        return this.withTransaction(ctx, (ctx) => this._delete(ctx, pattern));
    }

    private async _delete(ctx: ServerContext, pattern: Partial<QuadPattern>): Promise<number> {
        const ids = await this._patternIds(ctx, pattern);
        if (ids === null) {
            return 0;
        }
        let q = this._db(ctx)(T.edges).where(C.isDeleted, false);
        q = this._addPatternClauses(q, ids);
        return q.update({ [C.isDeleted]: true });
    }

    /**
     * Soft-deletes all active edges whose subject is one of the given terms.
     * Single SQL round-trip — use instead of calling delete() N times.
     */
    async deleteSubjects(
        ctx: ServerContext,
        subjects: readonly (IRI | BlankNode)[],
        graph?: IRI | null,
    ): Promise<number> {
        return this.withTransaction(ctx, (ctx) => this._deleteSubjects(ctx, subjects, graph));
    }

    private async _deleteSubjects(
        ctx: ServerContext,
        subjects: readonly (IRI | BlankNode)[],
        graph?: IRI | null,
    ): Promise<number> {
        if (subjects.length === 0) {
            return 0;
        }
        const idMap = await this._nodeIds(ctx, subjects);
        const validIds = [
            ...new Set(
                subjects
                    .map((s) => idMap.get(this._termKey(s)))
                    .filter((id): id is number => id !== undefined),
            ),
        ];
        if (validIds.length === 0) {
            return 0;
        }

        let q = this._db(ctx)(T.edges).whereIn(C.subject, validIds).where(C.isDeleted, false);
        if (graph !== undefined) {
            const gId = await this._resolveGraph(ctx, graph);
            if (gId === null) {
                return 0;
            }
            q = q.where(C.graph, gId);
        }
        return q.update({ [C.isDeleted]: true });
    }

    /**
     * Soft-deletes active edges matching a subject AND whose predicate is one
     * of the given IRIs.  Single SQL round-trip — use in updateGroup instead
     * of N × delete(predicate).
     */
    async deleteBySubjectPredicates(
        ctx: ServerContext,
        subject: IRI | BlankNode,
        predicates: readonly IRI[],
        graph?: IRI | null,
    ): Promise<number> {
        return this.withTransaction(ctx, (ctx) =>
            this._deleteBySubjectPredicates(ctx, subject, predicates, graph),
        );
    }

    private async _deleteBySubjectPredicates(
        ctx: ServerContext,
        subject: IRI | BlankNode,
        predicates: readonly IRI[],
        graph?: IRI | null,
    ): Promise<number> {
        if (predicates.length === 0) {
            return 0;
        }
        const sId = await this._nodeId(ctx, subject as IRI | BlankNode);
        if (sId === null) {
            return 0;
        }
        // One query for every predicate, rather than a per-predicate SELECT
        // issued concurrently on the transaction's single connection.
        const validPIds = [...(await this._nodeIds(ctx, predicates)).values()];
        if (validPIds.length === 0) {
            return 0;
        }

        let q = this._db(ctx)(T.edges)
            .where(C.subject, sId)
            .whereIn(C.predicate, validPIds)
            .where(C.isDeleted, false);
        if (graph !== undefined) {
            const gId = await this._resolveGraph(ctx, graph);
            if (gId === null) {
                return 0;
            }
            q = q.where(C.graph, gId);
        }
        return q.update({ [C.isDeleted]: true });
    }

    // ── Batch read ────────────────────────────────────────────────────────────

    /**
     * Fetches all active quads for a list of subjects in a single round-trip.
     * Returns a Map keyed by subject IRI string (or `_:id` for blank nodes).
     */
    async findForSubjects(
        ctx: ServerContext,
        subjects: readonly (IRI | BlankNode)[],
        graph?: IRI | null,
    ): Promise<Map<string, Quad[]>> {
        return this.withTransaction(ctx, (ctx) => this._findForSubjects(ctx, subjects, graph));
    }

    private async _findForSubjects(
        ctx: ServerContext,
        subjects: readonly (IRI | BlankNode)[],
        graph?: IRI | null,
    ): Promise<Map<string, Quad[]>> {
        if (subjects.length === 0) {
            return new Map();
        }

        const idMap = await this._nodeIds(ctx, subjects);
        const validPairs: Array<[IRI | BlankNode, number]> = [];
        const idToSubject = new Map<number, IRI | BlankNode>();
        for (const s of subjects) {
            const id = idMap.get(this._termKey(s));
            if (id !== undefined) {
                validPairs.push([s, id]);
                idToSubject.set(id, s);
            }
        }
        if (validPairs.length === 0) {
            return new Map();
        }

        let edgesQ = this._db(ctx)(T.edges)
            .whereIn(
                C.subject,
                validPairs.map(([, id]) => id),
            )
            .where(C.isDeleted, false);
        if (graph !== undefined) {
            const gId = await this._resolveGraph(ctx, graph);
            if (gId === null) {
                return new Map();
            }
            edgesQ = edgesQ.where(C.graph, gId);
        }
        const edges = await edgesQ.select<EdgeRow[]>("*");

        if (edges.length === 0) {
            return new Map();
        }

        const nodeIds = new Set<number>();
        for (const e of edges) {
            nodeIds.add(e.subject);
            nodeIds.add(e.predicate);
            nodeIds.add(e.object);
            nodeIds.add(e.graph);
        }
        const nodeMap = await this._loadNodes(ctx, [...nodeIds]);

        const result = new Map<string, Quad[]>();
        for (const e of edges) {
            const subjTerm = idToSubject.get(e.subject);
            if (subjTerm == null) {
                throw new Error(`findForSubjects: missing subject term for id ${e.subject}`);
            }
            const key = isIRI(subjTerm) ? subjTerm.value : `_:${(subjTerm as BlankNode).id}`;
            if (!result.has(key)) {
                result.set(key, []);
            }
            const subjectNode = nodeMap.get(e.subject);
            if (subjectNode == null) {
                throw new Error(`findForSubjects: missing node for subject id ${e.subject}`);
            }
            const predicateNode = nodeMap.get(e.predicate);
            if (predicateNode == null) {
                throw new Error(`findForSubjects: missing node for predicate id ${e.predicate}`);
            }
            const objectNode = nodeMap.get(e.object);
            if (objectNode == null) {
                throw new Error(`findForSubjects: missing node for object id ${e.object}`);
            }
            const graph = this._graphTermFromNode(nodeMap.get(e.graph));
            result.get(key)?.push({
                subject: subjectNode as IRI | BlankNode,
                predicate: predicateNode as IRI,
                object: objectNode as RdfTerm,
                graph,
            });
        }
        return result;
    }

    /**
     * Derives each subject's entity-level timestamps from the DB-managed
     * created_at / updated_at columns on its edge rows, aggregated per subject:
     *   createdAt = MIN(created_at), updatedAt = MAX(updated_at)
     * over the subject's non-deleted edges.  The rdf:type edge (never rewritten
     * by update) anchors createdAt; any property/edge write bumps updatedAt.
     *
     * Batched into one grouped query.  Subjects with no live edges are absent
     * from the returned map.
     */
    async entityTimestamps(
        ctx: ServerContext,
        subjects: readonly (IRI | BlankNode)[],
        graph?: IRI | null,
    ): Promise<Map<string, EntityTimestamps>> {
        return this.withTransaction(ctx, (ctx) => this._entityTimestamps(ctx, subjects, graph));
    }

    private async _entityTimestamps(
        ctx: ServerContext,
        subjects: readonly (IRI | BlankNode)[],
        graph?: IRI | null,
    ): Promise<Map<string, EntityTimestamps>> {
        if (subjects.length === 0) {
            return new Map();
        }

        const idMap = await this._nodeIds(ctx, subjects);
        const validPairs: Array<[IRI | BlankNode, number]> = [];
        const idToSubject = new Map<number, IRI | BlankNode>();
        for (const s of subjects) {
            const id = idMap.get(this._termKey(s));
            if (id !== undefined) {
                validPairs.push([s, id]);
                idToSubject.set(id, s);
            }
        }
        if (validPairs.length === 0) {
            return new Map();
        }

        let q = this._db(ctx)(T.edges)
            .whereIn(
                C.subject,
                validPairs.map(([, id]) => id),
            )
            .where(C.isDeleted, false);
        if (graph !== undefined) {
            const gId = await this._resolveGraph(ctx, graph);
            if (gId === null) {
                return new Map();
            }
            q = q.where(C.graph, gId);
        }
        const rows = await q
            .groupBy(C.subject)
            .select<{ subject: number; created_at: string; updated_at: string }[]>(
                C.subject,
                this._db(ctx).raw(`MIN(${C.createdAt}) as ${C.createdAt}`),
                this._db(ctx).raw(`MAX(${C.updatedAt}) as ${C.updatedAt}`),
            );

        const result = new Map<string, EntityTimestamps>();
        for (const row of rows) {
            const subjTerm = idToSubject.get(row.subject);
            /* v8 ignore next 3 -- subject ids come straight from idToSubject */
            if (subjTerm == null) {
                continue;
            }
            const key = isIRI(subjTerm) ? subjTerm.value : `_:${(subjTerm as BlankNode).id}`;
            result.set(key, {
                createdAt: new Date(row.created_at),
                updatedAt: new Date(row.updated_at),
            });
        }
        return result;
    }

    // ── Subject queries ───────────────────────────────────────────────────────

    /**
     * One page of the subjects of a type, filtered and sorted in SQL, plus the
     * number of subjects the filters admit. See subjectQuery.ts for the order
     * values sort in. Both statements run in one transaction.
     */
    async selectSubjects(
        ctx: ServerContext,
        query: SubjectQuery,
    ): Promise<{ subjects: IRI[]; total: number }> {
        return this.withTransaction(ctx, async (ctx) => {
            const compiled = await this._compileSubjectQuery(ctx, query);
            if (compiled === null) {
                return { subjects: [], total: 0 };
            }
            const page = this._rows<{ iri: string }>(
                await this._db(ctx).raw(compiled.page.sql, [...compiled.page.bindings]),
            );
            const count = this._rows<{ total: number | string }>(
                await this._db(ctx).raw(compiled.count.sql, [...compiled.count.bindings]),
            );
            return {
                subjects: page.map((r) => makeIRI(r.iri)),
                total: Number(count[0]?.total ?? 0),
            };
        });
    }

    /** How many subjects of a type the query's filters admit; its sort and page are ignored. */
    async countSubjects(ctx: ServerContext, query: SubjectQuery): Promise<number> {
        return this.withTransaction(ctx, async (ctx) => {
            const compiled = await this._compileSubjectQuery(ctx, query);
            if (compiled === null) {
                return 0;
            }
            const count = this._rows<{ total: number | string }>(
                await this._db(ctx).raw(compiled.count.sql, [...compiled.count.bindings]),
            );
            return Number(count[0]?.total ?? 0);
        });
    }

    /** Null when the query's graph was never written, so no subject can match. */
    private async _compileSubjectQuery(
        ctx: ServerContext,
        query: SubjectQuery,
    ): Promise<CompiledSubjectQuery | null> {
        let graphId: number | null = null;
        if ("graph" in query.scope) {
            graphId = await this._resolveGraph(ctx, query.scope.graph);
            if (graphId === null) {
                return null;
            }
        }
        const rdfType = makeIRI(RDF_TYPE);
        const ids = await this._nodeIds(ctx, subjectQueryIris(query, rdfType));
        const dialect = this._isPg() ? PG_DIALECT : SQLITE_DIALECT;
        return compileSubjectQuery(query, rdfType, ids, graphId, dialect);
    }

    /** The rows of a raw statement: Postgres wraps them, SQLite returns them bare. */
    private _rows<R>(raw: unknown): R[] {
        return (Array.isArray(raw) ? raw : (raw as { rows: R[] }).rows) as R[];
    }

    // ── Graph reachability ────────────────────────────────────────────────────

    /**
     * Transitive closure over the edge graph: starting from `opts.roots`, follow
     * edges of the given predicate(s) in the given direction and return every
     * IRI node reached.  Evaluated as a single recursive CTE — one round-trip
     * regardless of path length — and cycle-safe.
     *
     * This is the topology primitive that replaces every client-side BFS/while
     * graph walk (RBAC scope chains, group membership, role inheritance,
     * entity ownership).  Postgres and SQLite share the WITH RECURSIVE syntax;
     * only the boolean literal differs.
     */
    async reachable(ctx: ServerContext, opts: ReachOptions): Promise<IRI[]> {
        return this.withTransaction(ctx, (ctx) => this._reachable(ctx, opts));
    }

    private async _reachable(ctx: ServerContext, opts: ReachOptions): Promise<IRI[]> {
        const includeRoots = opts.includeRoots ?? true;

        // One query per set, rather than a SELECT per term issued concurrently
        // on the transaction's single connection. Terms that were never interned
        // are simply absent from the map, which is the filter this replaces.
        const rootIds = [...(await this._nodeIds(ctx, opts.roots)).values()];
        if (rootIds.length === 0) {
            return [];
        }

        const predIds = [...(await this._nodeIds(ctx, opts.predicates)).values()];

        // No resolvable predicates ⇒ no edges to follow; only the roots qualify.
        if (predIds.length === 0) {
            const rootSet = new Set(rootIds);
            return includeRoots ? this._idsToIris(ctx, [...rootSet]) : [];
        }

        let graphClause = "1 = 1";
        if (opts.graph !== undefined) {
            const gId = await this._resolveGraph(ctx, opts.graph);
            if (gId === null) {
                return includeRoots ? this._idsToIris(ctx, rootIds) : [];
            }
            graphClause = `e.${C.graph} = ${gId}`;
        }

        const fromCol = opts.direction === "out" ? C.subject : C.object;
        const toCol = opts.direction === "out" ? C.object : C.subject;
        const isPg = this._isPg();
        const falseLit = isPg ? "false" : "0";
        const rootList = rootIds.join(", ");
        const predList = predIds.join(", ");

        const sql =
            opts.maxDepth !== undefined
                ? `WITH RECURSIVE reach(node, depth) AS (
                    SELECT ${C.id}, 0 FROM ${T.nodes} WHERE ${C.id} IN (${rootList})
                    UNION ALL
                    SELECT e.${toCol}, r.depth + 1
                    FROM ${T.edges} e JOIN reach r ON e.${fromCol} = r.node
                    WHERE r.depth < ${Number(opts.maxDepth)}
                      AND e.${C.predicate} IN (${predList})
                      AND e.${C.isDeleted} = ${falseLit}
                      AND ${graphClause}
                   ) SELECT DISTINCT node FROM reach`
                : `WITH RECURSIVE reach(node) AS (
                    SELECT ${C.id} FROM ${T.nodes} WHERE ${C.id} IN (${rootList})
                    UNION
                    SELECT e.${toCol}
                    FROM ${T.edges} e JOIN reach r ON e.${fromCol} = r.node
                    WHERE e.${C.predicate} IN (${predList})
                      AND e.${C.isDeleted} = ${falseLit}
                      AND ${graphClause}
                   ) SELECT node FROM reach`;

        const raw = await this._db(ctx).raw(sql);
        const rows = (Array.isArray(raw) ? raw : raw.rows) as Array<{ node: number }>;

        const rootSet = new Set(rootIds);
        const ids = rows
            .map((r) => Number(r.node))
            .filter((id) => includeRoots || !rootSet.has(id));
        return this._idsToIris(ctx, ids);
    }

    /** Resolves a set of node ids to their IRI terms, dropping any non-IRI (literal/blank) nodes. */
    private async _idsToIris(ctx: ServerContext, ids: number[]): Promise<IRI[]> {
        if (ids.length === 0) {
            return [];
        }
        const unique = [...new Set(ids)];
        const nodeMap = await this._loadNodes(ctx, unique);
        const result: IRI[] = [];
        for (const id of unique) {
            const term = nodeMap.get(id);
            if (term && isIRI(term)) {
                result.push(term);
            }
        }
        return result;
    }

    /**
     * Walks a fixed path from `opts.root` to a leaf, following `opts.hops` as a
     * chain of inner joins on edges. Returns the leaf IRIs reachable via the
     * full path — the rooted-traversal primitive the query layer is built on.
     * Every join is scoped to `opts.graph` and live edges, so a leaf is returned
     * only when the entire root→leaf path exists in that graph.
     */
    async rootedTraverse(ctx: ServerContext, opts: RootedTraverseOpts): Promise<IRI[]> {
        return this.withTransaction(ctx, (ctx) => this._rootedTraverse(ctx, opts));
    }

    private async _rootedTraverse(ctx: ServerContext, opts: RootedTraverseOpts): Promise<IRI[]> {
        const rootId = await this._nodeId(ctx, opts.root as IRI | BlankNode);
        if (rootId === null) {
            return [];
        }

        // Resolve the graph scope to a node id once; reused on every join.
        let graphId: number | undefined;
        if (opts.graph !== undefined) {
            const gId = await this._resolveGraph(ctx, opts.graph);
            if (gId === null) {
                return [];
            }
            graphId = gId;
        }
        const falseLit = this._isPg() ? "false" : "0";
        const scope = (alias: string): string => {
            const g = graphId === undefined ? "1 = 1" : `${alias}.${C.graph} = ${graphId}`;
            return `${g} AND ${alias}.${C.isDeleted} = ${falseLit}`;
        };

        // Resolve every predicate up front; an unknown predicate means no path.
        const hopPredIds: number[] = [];
        for (const hop of opts.hops) {
            const pid = await this._nodeId(ctx, hop.predicate as IRI | BlankNode);
            if (pid === null) {
                return [];
            }
            hopPredIds.push(pid);
        }

        // Build the hop chain. e0 is anchored at the root; each hop's leaf feeds
        // the next hop's anchor. `leafExpr` is the SQL expression for the leaf id.
        const wheres: string[] = [];
        const joins: string[] = [];
        let leafExpr: string;
        let base: string;
        if (opts.hops.length === 0) {
            base = "(SELECT 1) base";
            leafExpr = String(rootId);
        } else {
            const h0 = opts.hops[0] as TraverseHop;
            const from0 = h0.direction === "out" ? C.subject : C.object;
            const to0 = h0.direction === "out" ? C.object : C.subject;
            base = `${T.edges} e0`;
            wheres.push(`e0.${from0} = ${rootId}`);
            wheres.push(`e0.${C.predicate} = ${hopPredIds[0]}`);
            wheres.push(scope("e0"));
            leafExpr = `e0.${to0}`;
            for (let i = 1; i < opts.hops.length; i++) {
                const h = opts.hops[i] as TraverseHop;
                const from = h.direction === "out" ? C.subject : C.object;
                const to = h.direction === "out" ? C.object : C.subject;
                const a = `e${i}`;
                joins.push(
                    `JOIN ${T.edges} ${a} ON ${a}.${from} = ${leafExpr} AND ` +
                        `${a}.${C.predicate} = ${hopPredIds[i]} AND ${scope(a)}`,
                );
                leafExpr = `${a}.${to}`;
            }
        }

        // Leaf constraints: rdf:type and property-equality, each an extra join.
        let cIdx = 0;
        if (opts.leafType) {
            const rdfTypeId = await this._nodeId(ctx, makeIRI(RDF_TYPE));
            const typeId = await this._nodeId(ctx, opts.leafType as IRI | BlankNode);
            if (rdfTypeId === null || typeId === null) {
                return [];
            }
            const a = `c${cIdx++}`;
            joins.push(
                `JOIN ${T.edges} ${a} ON ${a}.${C.subject} = ${leafExpr} AND ` +
                    `${a}.${C.predicate} = ${rdfTypeId} AND ${a}.${C.object} = ${typeId} AND ${scope(a)}`,
            );
        }
        const bindings: (string | number)[] = [];
        for (const eq of opts.leafEq ?? []) {
            const pid = await this._nodeId(ctx, eq.predicate as IRI | BlankNode);
            if (pid === null) {
                return [];
            }
            let objectClause: string;
            if (isLiteral(eq.object)) {
                const lit = this._literalNodes(eq.object).toSQL();
                objectClause = `${C.object} IN (${lit.sql})`;
                bindings.push(...(lit.bindings as (string | number)[]));
            } else {
                const oid = await this._nodeId(ctx, eq.object as IRI | BlankNode);
                if (oid === null) {
                    return [];
                }
                objectClause = `${C.object} = ${oid}`;
            }
            const a = `c${cIdx++}`;
            joins.push(
                `JOIN ${T.edges} ${a} ON ${a}.${C.subject} = ${leafExpr} AND ` +
                    `${a}.${C.predicate} = ${pid} AND ${a}.${objectClause} AND ${scope(a)}`,
            );
        }

        const whereClause = wheres.length > 0 ? ` WHERE ${wheres.join(" AND ")}` : "";
        const sql = `SELECT DISTINCT ${leafExpr} AS leaf FROM ${base} ${joins.join(" ")}${whereClause}`;
        const raw = await this._db(ctx).raw(sql, bindings);
        const rows = (Array.isArray(raw) ? raw : raw.rows) as Array<{ leaf: number }>;
        return this._idsToIris(
            ctx,
            rows.map((r) => Number(r.leaf)),
        );
    }

    /** True when the underlying Knex client is Postgres. */
    private _isPg(): boolean {
        const client = (this._knex.client as { config: { client: string } }).config.client;
        return client === "pg" || client === "postgresql";
    }

    // ── Stats ─────────────────────────────────────────────────────────────────

    async stats(ctx: ServerContext): Promise<StoreStats> {
        return this.withTransaction(ctx, (ctx) => this._stats(ctx));
    }

    private async _stats(ctx: ServerContext): Promise<StoreStats> {
        // Sequential: four counts on the transaction's single connection run one
        // at a time whether or not they are issued together.
        const ns = await this._db(ctx)(T.namespaces).count<[{ count: number }]>(`${C.id} as count`);
        const no = await this._db(ctx)(T.nodes).count<[{ count: number }]>(`${C.id} as count`);
        const ne = await this._db(ctx)(T.edges)
            .where(C.isDeleted, false)
            .count<[{ count: number }]>(`${C.id} as count`);
        const net = await this._db(ctx)(T.edges).count<[{ count: number }]>(`${C.id} as count`);
        return {
            namespaces: Number(ns[0].count),
            nodes: Number(no[0].count),
            edges: Number(ne[0].count),
            edgesTotal: Number(net[0].count),
        };
    }

    // ── Private ───────────────────────────────────────────────────────────────

    /**
     * Whether an active edge already asserts this quad: the `dedupeQuads`
     * check. A literal object is matched by value, since a value can have
     * many nodes.
     */
    private async _isActive(
        ctx: ServerContext,
        sId: number,
        pId: number,
        object: RdfTerm,
        gId: number,
    ): Promise<boolean> {
        let q = this._db(ctx)(T.edges)
            .where({ [C.subject]: sId, [C.predicate]: pId, [C.graph]: gId })
            .where(C.isDeleted, false);
        if (isLiteral(object)) {
            q = q.whereIn(C.object, this._literalNodes(object));
        } else {
            const oId = await this._nodeId(ctx, object);
            if (oId === null) {
                return false;
            }
            q = q.where(C.object, oId);
        }
        return (await q.first<{ id: number }>()) !== undefined;
    }

    /**
     * The ids of every literal node holding this term's value, as a subquery.
     * Literals are not interned, so one value can have many nodes; callers
     * match an edge's object against the set, never look up one id.
     */
    private _literalNodes(term: Literal): Knex.QueryBuilder {
        /* v8 ignore next */
        const dtIri = term.datatype?.value ?? "http://www.w3.org/2001/XMLSchema#string";
        return this._knex(T.nodes)
            .select(C.id)
            .where({
                [C.kind]: "literal",
                [C.value]: term.value,
                [C.dt]: dtIri,
                [C.lang]: term.language ?? null,
            });
    }

    private async _nodeId(ctx: ServerContext, term: IRI | BlankNode): Promise<number | null> {
        if (isIRI(term)) {
            const node = await this._db(ctx)(T.nodes)
                .where({ [C.kind]: "iri", [C.iri]: term.value })
                .first<NodeRow>();
            return node?.id ?? null;
        }

        const node = await this._db(ctx)(T.nodes)
            .where({ [C.kind]: "blank", [C.blankId]: term.id })
            .first<NodeRow>();
        return node?.id ?? null;
    }

    /** Map key for a subject term: the IRI value, or `_:id` for a blank node. */
    private _termKey(term: IRI | BlankNode): string {
        return isIRI(term) ? term.value : `_:${(term as BlankNode).id}`;
    }

    /**
     * Batch-resolves IRI and blank-node terms to their node ids in one query per
     * kind, instead of a SELECT per term. Returns a map keyed by term key (the
     * IRI value, or `_:id` for a blank node). Terms not interned are absent. This
     * is the no-N+1 replacement for `Promise.all(terms.map(_nodeId))` in the
     * batch subject methods (findForSubjects, entityTimestamps, deleteSubjects),
     * so hydrating N entities resolves their subject ids in one round-trip.
     */
    private async _nodeIds(
        ctx: ServerContext,
        terms: readonly (IRI | BlankNode)[],
    ): Promise<Map<string, number>> {
        const result = new Map<string, number>();
        if (terms.length === 0) {
            return result;
        }
        const iris = new Set<string>();
        const blanks = new Set<string>();
        for (const t of terms) {
            if (isIRI(t)) {
                iris.add(t.value);
            } else {
                blanks.add((t as BlankNode).id);
            }
        }
        if (iris.size > 0) {
            const rows = await this._db(ctx)(T.nodes)
                .where(C.kind, "iri")
                .whereIn(C.iri, [...iris])
                .select<{ id: number; iri: string }[]>(C.id, C.iri);
            for (const r of rows) {
                result.set(r.iri, r.id);
            }
        }
        if (blanks.size > 0) {
            const rows = await this._db(ctx)(T.nodes)
                .where(C.kind, "blank")
                .whereIn(C.blankId, [...blanks])
                .select<{ id: number; blank_id: string }[]>(C.id, C.blankId);
            for (const r of rows) {
                result.set(`_:${r.blank_id}`, r.id);
            }
        }
        return result;
    }

    /**
     * Resolves a graph term to its node ID.
     * `null` input means "default graph" → looks up urn:sys:graph:default.
     * Returns null if the graph has never been interned (no matching quads).
     */
    private async _resolveGraph(ctx: ServerContext, graph: IRI | null): Promise<number | null> {
        const gTerm = graph === null ? DEFAULT_GRAPH_NODE : graph;
        return this._nodeId(ctx, gTerm);
    }

    /**
     * Resolves a QuadPattern to concrete node IDs.
     * Returns null (meaning "no rows can match") if any required node isn't in the store.
     */
    private async _patternIds(
        ctx: ServerContext,
        pattern: Partial<QuadPattern>,
    ): Promise<PatternIds | null> {
        const result: PatternIds = {};

        if (pattern.subject !== undefined) {
            const id = await this._nodeId(ctx, pattern.subject);
            if (id === null) {
                return null;
            }
            result.subject = id;
        }
        if (pattern.predicate !== undefined) {
            const id = await this._nodeId(ctx, pattern.predicate);
            if (id === null) {
                return null;
            }
            result.predicate = id;
        }
        if (pattern.object !== undefined) {
            if (isLiteral(pattern.object)) {
                result.objectLiteral = pattern.object;
            } else {
                const id = await this._nodeId(ctx, pattern.object);
                if (id === null) {
                    return null;
                }
                result.object = id;
            }
        }
        if (pattern.graph !== undefined) {
            const id = await this._resolveGraph(ctx, pattern.graph);
            if (id === null) {
                return null;
            }
            result.graphId = id;
        }
        return result;
    }

    /** Applies resolved pattern IDs as WHERE clauses to a query builder. */
    private _addPatternClauses<R extends object>(
        q: Knex.QueryBuilder<R>,
        ids: PatternIds,
    ): Knex.QueryBuilder<R> {
        if (ids.subject !== undefined) {
            q = q.where(C.subject, ids.subject);
        }
        if (ids.predicate !== undefined) {
            q = q.where(C.predicate, ids.predicate);
        }
        if (ids.object !== undefined) {
            q = q.where(C.object, ids.object);
        }
        if (ids.objectLiteral !== undefined) {
            q = q.whereIn(C.object, this._literalNodes(ids.objectLiteral));
        }
        if (ids.graphId !== undefined) {
            q = q.where(C.graph, ids.graphId);
        }
        return q;
    }

    private async _hydrateEdges(ctx: ServerContext, edges: EdgeRow[]): Promise<Quad[]> {
        const nodeIds = new Set<number>();
        for (const e of edges) {
            nodeIds.add(e.subject);
            nodeIds.add(e.predicate);
            nodeIds.add(e.object);
            nodeIds.add(e.graph);
        }
        const nodeMap = await this._loadNodes(ctx, [...nodeIds]);

        return edges.map((e) => {
            const subject = nodeMap.get(e.subject);
            if (subject == null) {
                throw new Error(`_hydrateEdges: missing node for subject id ${e.subject}`);
            }
            const predicate = nodeMap.get(e.predicate);
            if (predicate == null) {
                throw new Error(`_hydrateEdges: missing node for predicate id ${e.predicate}`);
            }
            const object = nodeMap.get(e.object);
            if (object == null) {
                throw new Error(`_hydrateEdges: missing node for object id ${e.object}`);
            }
            const graph = this._graphTermFromNode(nodeMap.get(e.graph));
            return {
                subject: subject as IRI | BlankNode,
                predicate: predicate as IRI,
                object: object as RdfTerm,
                graph,
            };
        });
    }

    /**
     * Converts a graph node from the node map to the appropriate Quad graph term.
     * The well-known default graph IRI is mapped back to the DEFAULT_GRAPH sentinel.
     */
    private _graphTermFromNode(node: RdfTerm | undefined): IRI | DefaultGraph {
        if (node == null || !isIRI(node)) {
            // Defensive fallback — graph column is always set to a non-null IRI node.
            /* v8 ignore next */
            return DEFAULT_GRAPH satisfies DefaultGraph;
        }
        if ((node as IRI).value === DEFAULT_GRAPH_IRI) {
            return DEFAULT_GRAPH satisfies DefaultGraph;
        }
        return node as IRI;
    }

    private async _loadNodes(ctx: ServerContext, ids: number[]): Promise<Map<number, RdfTerm>> {
        /* v8 ignore next */
        if (ids.length === 0) {
            return new Map();
        }
        const nodes = await this._db(ctx)(T.nodes).whereIn(C.id, ids).select<NodeRow[]>("*");
        /* v8 ignore next */
        return new Map(nodes.map((n) => [n.id, nodeToTerm(n)]));
    }
}
