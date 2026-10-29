/**
 * Gives every vitest worker its own Postgres database when SYS_PG_URL is set.
 *
 * Suites run in parallel workers, and their Postgres legs migrate, commit and
 * truncate, so they cannot share one database. Each worker creates and uses
 * `<db>_w<VITEST_POOL_ID>` next to the database SYS_PG_URL names (see
 * worker-setup.ts). This drops those databases before and after the run, so
 * every run starts empty. Two runs at once need different SYS_PG_URL databases.
 */

import knex, { type Knex } from "knex";
import type { TestProject } from "vitest/node";

declare module "vitest" {
    export interface ProvidedContext {
        /** SYS_PG_URL as the run was started with, or null when unset. */
        pgBaseUrl: string | null;
    }
}

/** The database a vitest worker runs its Postgres legs against. */
export function workerDatabaseName(baseDatabase: string, poolId: string): string {
    return `${baseDatabase}_w${poolId}`;
}

/**
 * Runs `fn` on one connection to the base database. CREATE and DROP DATABASE
 * cannot run inside a transaction, so callers issue them on this connection.
 */
export async function withAdminConnection(
    baseUrl: string,
    fn: (admin: Knex) => Promise<void>,
): Promise<void> {
    const admin = knex({ client: "pg", connection: baseUrl, pool: { min: 0, max: 1 } });
    try {
        await fn(admin);
    } finally {
        await admin.destroy();
    }
}

async function dropWorkerDatabases(baseUrl: string): Promise<void> {
    const pattern = `^${workerDatabaseName(new URL(baseUrl).pathname.slice(1), "[0-9]+")}$`;
    await withAdminConnection(baseUrl, async (admin) => {
        const rows: { datname: string }[] = await admin("pg_database")
            .select("datname")
            .whereRaw("datname ~ ?", [pattern]);
        for (const { datname } of rows) {
            await admin.raw("DROP DATABASE IF EXISTS ?? WITH (FORCE)", [datname]);
        }
    });
}

export default async function setup(
    project: TestProject,
): Promise<(() => Promise<void>) | undefined> {
    const baseUrl = process.env.SYS_PG_URL ?? null;
    project.provide("pgBaseUrl", baseUrl);
    if (baseUrl === null) {
        return undefined;
    }

    // A killed run leaves its databases behind.
    await dropWorkerDatabases(baseUrl);
    return () => dropWorkerDatabases(baseUrl);
}
