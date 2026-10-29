import { setTimeout as sleep } from "node:timers/promises";
import { getLog } from "@terncosoftware/core";
import type { Knex } from "knex";
import { up as migrate001 } from "./migrations/001_init.js";
import { up as migrate002 } from "./migrations/002_fix_nodes.js";
import { up as migrate003 } from "./migrations/003_jobs_roles.js";
import { up as migrate004 } from "./migrations/004_node_encryption.js";
import {
    isPresent as hasNodesValueIndex,
    up as migrate005,
    upConcurrently as migrate005Concurrently,
    type PgSession,
} from "./migrations/005_nodes_value_index.js";
import { C, T } from "./schema.js";

const log = getLog("sys:data:migrate");

/** Applied-migrations ledger: one row per data migration this database has run. */
export const DATA_MIGRATION_LEDGER = "sys_data_migrations";

/**
 * Advisory-lock namespace for data migrations ('sdat' in ASCII), paired with
 * hashtext(current_database()) so connects to different databases on one
 * cluster do not contend. Distinct from tern's 'tern' and 'tapp' keys, which a
 * tern server may hold on another connection while it calls createDataContext.
 */
const DATA_MIGRATION_LOCK_NAMESPACE = 0x73646174;

/** How often a connect waiting on the ledger lock tries it again. */
const LOCK_POLL_MS = 250;

interface DataMigration {
    readonly name: string;
    readonly up: (knex: Knex) => Promise<void>;
    /**
     * Postgres only, in place of `up`: a migration that cannot run inside a
     * transaction (CREATE INDEX CONCURRENTLY). It runs on one pinned connection
     * under a session-level hold of the ledger lock.
     */
    readonly upConcurrently?: (session: PgSession) => Promise<void>;
    /**
     * True when a database that predates the ledger already carries this
     * migration's effects. Before the ledger, every connect re-ran every
     * migration, so present schema means the whole migration ran.
     */
    readonly isPresent: (knex: Knex) => Promise<boolean>;
}

async function hasTables(knex: Knex, tables: readonly string[]): Promise<boolean> {
    for (const table of tables) {
        if (!(await knex.schema.hasTable(table))) {
            return false;
        }
    }
    return true;
}

async function hasColumns(knex: Knex, table: string, columns: readonly string[]): Promise<boolean> {
    for (const column of columns) {
        if (!(await knex.schema.hasColumn(table, column))) {
            return false;
        }
    }
    return true;
}

const DATA_MIGRATIONS: readonly DataMigration[] = [
    {
        name: "001_init",
        up: migrate001,
        isPresent: async (knex) =>
            (await hasTables(knex, [T.namespaces, T.nodes, T.edges])) &&
            (await knex(T.namespaces).where(C.prefix, "rbac").first(C.id)) !== undefined,
    },
    {
        name: "002_fix_nodes",
        up: migrate002,
        isPresent: async (knex) =>
            (await hasTables(knex, [T.nodes])) &&
            !(await knex.schema.hasColumn(T.nodes, "datatype")) &&
            (await hasColumns(knex, T.nodes, [C.dt, "v", "vh"])),
    },
    {
        name: "003_jobs_roles",
        up: migrate003,
        isPresent: (knex) => hasTables(knex, ["sys_role_lease", "sys_job", "sys_job_run"]),
    },
    {
        name: "004_node_encryption",
        up: migrate004,
        isPresent: async (knex) =>
            (await hasTables(knex, [T.nodes])) &&
            (await hasColumns(knex, T.nodes, [C.isEncrypted, C.keyId])),
    },
    {
        name: "005_nodes_value_index",
        up: migrate005,
        upConcurrently: migrate005Concurrently,
        isPresent: async (knex) =>
            (await hasTables(knex, [T.nodes])) && (await hasNodesValueIndex(knex, isPg(knex))),
    },
];

/** Every data migration name, in the order they apply. The last is the newest. */
export const DATA_MIGRATION_NAMES: readonly string[] = DATA_MIGRATIONS.map((m) => m.name);

function isPg(knex: Knex): boolean {
    const client = (knex.client as { config: { client: string } }).config.client;
    return client === "pg" || client === "postgresql";
}

/**
 * Runs `fn` on one pinned Postgres connection while that session holds the
 * ledger lock, released (with the connection) when `fn` settles.
 *
 * The lock is taken by polling with try-lock, outside any transaction, never
 * by blocking: a waiter that blocks in a statement, or polls inside an open
 * transaction, holds a snapshot, and CREATE INDEX CONCURRENTLY under the lock
 * waits out every older snapshot in the database. The waiter and the build
 * would then wait on each other forever, unseen by the deadlock detector.
 */
async function holdingLedgerLock(
    knex: Knex,
    fn: (session: PgSession) => Promise<void>,
): Promise<void> {
    const session = (await knex.client.acquireConnection()) as PgSession;
    try {
        for (;;) {
            const [row] = (await knex
                .select(
                    knex.raw("pg_try_advisory_lock(?, hashtext(current_database())) AS locked", [
                        DATA_MIGRATION_LOCK_NAMESPACE,
                    ]),
                )
                .connection(session)) as { locked: boolean }[];
            if (row?.locked) {
                break;
            }
            await sleep(LOCK_POLL_MS);
        }
        try {
            await fn(session);
        } finally {
            await knex
                .select(
                    knex.raw("pg_advisory_unlock(?, hashtext(current_database()))", [
                        DATA_MIGRATION_LOCK_NAMESPACE,
                    ]),
                )
                .connection(session);
        }
    } finally {
        await knex.client.releaseConnection(session);
    }
}

/**
 * Runs `fn` with ledger writes serialised across processes. On Postgres that is
 * a transaction on the connection holding the ledger lock, so a migration and
 * its ledger row commit together. SQLite runs `fn` directly: its pool is one
 * connection in one process, and knex's SQLite column DDL opens its own
 * transaction, which would wait forever on a held one.
 */
async function withLedgerLock(knex: Knex, fn: (db: Knex) => Promise<void>): Promise<void> {
    if (!isPg(knex)) {
        await fn(knex);
        return;
    }
    await holdingLedgerLock(knex, (session) =>
        knex.transaction((trx) => fn(trx), { connection: session }),
    );
}

/** Runs one pending migration on its pinned session and records it there. */
async function applyConcurrently(
    knex: Knex,
    m: DataMigration & { upConcurrently: (session: PgSession) => Promise<void> },
): Promise<boolean> {
    let ran = false;
    await holdingLedgerLock(knex, async (session) => {
        const { rows } = await session.query<{ name: string }>(
            `SELECT name FROM ${DATA_MIGRATION_LEDGER} WHERE name = $1`,
            [m.name],
        );
        if (rows.length > 0) {
            log.info("skipped", "Data migration applied by a concurrent connect", {
                migration: m.name,
            });
            return;
        }

        log.debug("applying", "Applying data migration", { migration: m.name });
        try {
            await m.upConcurrently(session);
        } catch (e) {
            log.error("failed", "Data migration failed", {
                migration: m.name,
                error: e instanceof Error ? e.message : String(e),
            });
            throw e;
        }
        await session.query(`INSERT INTO ${DATA_MIGRATION_LEDGER} (name) VALUES ($1)`, [m.name]);
        ran = true;
    });
    return ran;
}

async function appliedNames(knex: Knex): Promise<Set<string>> {
    return new Set(await knex(DATA_MIGRATION_LEDGER).pluck("name"));
}

/**
 * Creates the ledger and, for a database that predates it, records the
 * migrations whose effects are already present instead of running them again.
 * A migration it cannot confirm stays pending and runs normally; each one is
 * idempotent, so that errs safe.
 */
async function createLedger(db: Knex): Promise<void> {
    await db.schema.createTable(DATA_MIGRATION_LEDGER, (t) => {
        t.text("name").primary();
        t.timestamp("applied_at", { useTz: true }).notNullable().defaultTo(db.fn.now());
    });

    const present: string[] = [];
    for (const m of DATA_MIGRATIONS) {
        if (await m.isPresent(db)) {
            present.push(m.name);
        }
    }
    if (present.length > 0) {
        await db(DATA_MIGRATION_LEDGER).insert(present.map((name) => ({ name })));
        log.info("backfilled", "Recorded data migrations already present", { migrations: present });
    }
}

/**
 * Applies each pending data migration exactly once per database.
 *
 * A connect with nothing pending reads the ledger and returns: no lock, no
 * migration SQL. Otherwise each pending migration runs under the ledger lock and
 * re-checks the ledger first, so a process that waited on a concurrent connect
 * finds the migration recorded and skips it. On Postgres the migration and its
 * ledger row commit together; a failure leaves neither.
 */
export async function runDataMigrations(knex: Knex): Promise<void> {
    if (await knex.schema.hasTable(DATA_MIGRATION_LEDGER)) {
        const applied = await appliedNames(knex);
        if (DATA_MIGRATION_NAMES.every((name) => applied.has(name))) {
            return;
        }
    } else {
        await withLedgerLock(knex, async (db) => {
            // Re-checked under the lock: a concurrent connect may have created it.
            if (!(await db.schema.hasTable(DATA_MIGRATION_LEDGER))) {
                await createLedger(db);
            }
        });
    }

    const applied = await appliedNames(knex);
    const ran: string[] = [];
    for (const m of DATA_MIGRATIONS) {
        if (applied.has(m.name)) {
            continue;
        }

        if (m.upConcurrently && isPg(knex)) {
            if (await applyConcurrently(knex, { ...m, upConcurrently: m.upConcurrently })) {
                ran.push(m.name);
            }
            continue;
        }

        await withLedgerLock(knex, async (db) => {
            if (await db(DATA_MIGRATION_LEDGER).where({ name: m.name }).first("name")) {
                log.info("skipped", "Data migration applied by a concurrent connect", {
                    migration: m.name,
                });
                return;
            }

            log.debug("applying", "Applying data migration", { migration: m.name });
            try {
                await m.up(db);
            } catch (e) {
                log.error("failed", "Data migration failed", {
                    migration: m.name,
                    error: e instanceof Error ? e.message : String(e),
                });
                throw e;
            }
            await db(DATA_MIGRATION_LEDGER).insert({ name: m.name });
            ran.push(m.name);
        });
    }
    if (ran.length > 0) {
        log.info("applied", "Applied data migrations", { migrations: ran });
    }
}
