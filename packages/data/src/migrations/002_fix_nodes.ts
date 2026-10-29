import type { Knex } from "knex";

/**
 * TRN-85: Clean up the nodes table.
 *
 *  1. Delete rows with no semantic content (all-null triples).
 *  2. Strip the redundant `dt` field from value_json — the datatype IRI is
 *     already stored in the dedicated column.
 *  3. Rename `datatype` → `dt`.
 *  4. Add `v` (integer version counter, default 0) and `vh` (version hash) for
 *     entity node versioning.
 */
export async function up(knex: Knex): Promise<void> {
    const client = (knex.client as { config: { client: string } }).config.client;
    const isPg = client === "pg" || client === "postgresql";

    // 1. Remove all-null triples — rows with no IRI, blank ID, value, or JSON payload.
    await knex("nodes")
        .whereNull("iri")
        .whereNull("blank_id")
        .whereNull("value")
        .whereNull("value_json")
        .delete();

    // 2. Strip the `dt` field from value_json — it duplicates the datatype column.
    //    Only rows that still carry it are rewritten, so a re-run updates nothing.
    //    `\\?` is knex's escape for Postgres's jsonb key-exists operator.
    if (isPg) {
        await knex.raw(
            `UPDATE nodes SET value_json = value_json - 'dt' WHERE kind = 'literal' AND value_json \\? 'dt'`,
        );
    } else {
        await knex.raw(
            `UPDATE nodes SET value_json = json_remove(value_json, '$.dt') WHERE kind = 'literal' AND json_type(value_json, '$.dt') IS NOT NULL`,
        );
    }

    // 3. Rename datatype → dt — only if not already done. The ledger runs this
    //    once per database, but one that predates the ledger may re-run it, so
    //    it must be a no-op against an already-migrated database. Renaming
    //    again would fail: the source column no longer exists.
    const hasDatatype = await knex.schema.hasColumn("nodes", "datatype");
    const hasDt = await knex.schema.hasColumn("nodes", "dt");
    if (hasDatatype && !hasDt) {
        await knex.schema.alterTable("nodes", (t) => {
            t.renameColumn("datatype", "dt");
        });
    }

    // 4. Add version columns — each guarded so a re-run does not fail on an
    //    already-present column.
    if (!(await knex.schema.hasColumn("nodes", "v"))) {
        await knex.schema.alterTable("nodes", (t) => {
            t.integer("v").notNullable().defaultTo(0);
        });
    }
    if (!(await knex.schema.hasColumn("nodes", "vh"))) {
        await knex.schema.alterTable("nodes", (t) => {
            t.text("vh").nullable();
        });
    }
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.alterTable("nodes", (t) => {
        t.dropColumn("v");
        t.dropColumn("vh");
    });
    await knex.schema.alterTable("nodes", (t) => {
        t.renameColumn("dt", "datatype");
    });
    // Deleted null triples and stripped dt from value_json cannot be restored.
}
