import { getLog } from "@terncosoftware/core";
import type { Knex } from "knex";
import { runDataMigrations } from "./migrate.js";
import { attachSqlLogging, sqlLoggingEnabled } from "./sqlLogging.js";

const log = getLog("sys:data:sql");

export type DbClient = "sqlite" | "pg";

export interface SqliteConfig {
    readonly client: "sqlite";
    /** Pass ':memory:' for an in-process ephemeral database (tests). */
    readonly filename: string;
}

/**
 * Connection-pool bounds for a Postgres DataContext.
 *
 * Each caller sizes this for ITS OWN workload rather than inheriting a single
 * global cap: a test file that opens many pools concurrently against one shared
 * Postgres wants a small pool so it does not starve the server, whereas a
 * production worker managing many domains needs enough connections to service
 * its concurrent per-domain work without the pool wedging. Only the fields a
 * caller sets are applied; the rest fall back to DEFAULT_PG_POOL.
 */
export interface PgPoolConfig {
    /** Minimum idle connections the pool keeps open. */
    readonly min?: number;
    /** Maximum connections the pool may open. */
    readonly max?: number;
    /**
     * How long (ms) an acquire waits for a free connection before rejecting with
     * "Timeout acquiring a connection". Shorter values surface a saturated pool
     * as a fast, logged error instead of a 60s stall.
     */
    readonly acquireTimeoutMillis?: number;
}

/**
 * Conservative default pool, used when a PgConfig does not set its own `pool`.
 *
 * Deliberately small: many test files open pools concurrently against one
 * Postgres, so an unbounded default (min 2, max 10) would starve the shared
 * server. This is a TEST-safe default, NOT a production sizing — a production
 * caller (e.g. a worker managing many domains) must pass an explicit, larger
 * `pool` sized for its load rather than inherit this cap.
 */
export const DEFAULT_PG_POOL = { min: 0, max: 4 } as const;

export interface PgConfig {
    readonly client: "pg";
    readonly host: string;
    readonly port?: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
    /**
     * Connection-pool bounds sized for this caller's workload. Omitted ⇒
     * DEFAULT_PG_POOL (a test-safe cap). Production callers size this explicitly.
     */
    readonly pool?: PgPoolConfig;
}

export type DataConfig = SqliteConfig | PgConfig;

/**
 * Creates a Knex instance for the given configuration and applies any pending
 * data migrations (see runDataMigrations). A connect to an up-to-date database
 * only reads the migrations ledger. Call `knex.destroy()` when finished to
 * release the connection pool.
 */
export async function createDataContext(config: DataConfig): Promise<Knex> {
    const { default: Knex } = await import("knex");

    let knex: Knex;

    if (config.client === "sqlite") {
        knex = Knex({
            client: "better-sqlite3",
            connection: { filename: config.filename },
            useNullAsDefault: true,
            // A single connection: a ':memory:' database is private to its
            // connection, so a multi-connection pool would scatter writes and
            // reads across separate empty databases. One connection also matches
            // better-sqlite3's synchronous, single-writer model.
            pool: { min: 1, max: 1 },
        });
    } else {
        knex = Knex({
            client: "pg",
            connection: {
                host: config.host,
                port: config.port ?? 5432,
                database: config.database,
                user: config.user,
                password: config.password,
            },
            // Pool bounds come from the caller (sized for its workload), falling
            // back to the test-safe DEFAULT_PG_POOL. Only the fields the caller
            // set are applied; acquireTimeoutMillis is left to knex's default
            // unless the caller opts into a shorter, fail-fast timeout.
            pool: {
                min: config.pool?.min ?? DEFAULT_PG_POOL.min,
                max: config.pool?.max ?? DEFAULT_PG_POOL.max,
                ...(config.pool?.acquireTimeoutMillis !== undefined
                    ? { acquireTimeoutMillis: config.pool.acquireTimeoutMillis }
                    : {}),
            },
        });
    }

    if (sqlLoggingEnabled()) {
        attachSqlLogging(knex, (line) => log.debug("query", line));
    }

    await runDataMigrations(knex);
    return knex;
}
