/**
 * Points this worker's SYS_PG_URL at its own database, creating it on the
 * worker's first test file, before any suite reads the variable. An unset
 * SYS_PG_URL stays unset.
 */

import { inject } from "vitest";
import { withAdminConnection, workerDatabaseName } from "./global-setup.js";

const baseUrl = inject("pgBaseUrl");
if (baseUrl !== null) {
    const poolId = process.env.VITEST_POOL_ID;
    if (poolId === undefined) {
        throw new Error("VITEST_POOL_ID is not set, so this worker has no Postgres database");
    }
    const url = new URL(baseUrl);
    const database = workerDatabaseName(url.pathname.slice(1), poolId);

    // Files on one pool id run one after another, so nothing else creates
    // this database concurrently.
    await withAdminConnection(baseUrl, async (admin) => {
        const existing = await admin("pg_database").where({ datname: database }).first("datname");
        if (existing === undefined) {
            await admin.raw("CREATE DATABASE ??", [database]);
        }
    });

    url.pathname = `/${database}`;
    process.env.SYS_PG_URL = url.toString();
}
