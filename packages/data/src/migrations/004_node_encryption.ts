import type { Knex } from "knex";
import { C, T } from "../schema.js";

/**
 * TRN-191: At-rest encryption flag for literal nodes.
 *
 * Adds two additive columns to the `nodes` table:
 *
 *   is_encrypted — boolean, default false. True when `value` holds ciphertext
 *                  rather than plaintext.
 *   key_id       — text, nullable. Id of the key that encrypted `value`, so
 *                  keys can rotate without rewriting old rows.
 *
 * Additive only — no behavior change here. Encryption of values, the query-term
 * matching, and the entity-layer encrypt/decrypt seam land in later changes.
 *
 * Idempotent: each column add is guarded by hasColumn, so a database that
 * predates the migrations ledger can re-run it as a no-op.
 */
export async function up(knex: Knex): Promise<void> {
    if (!(await knex.schema.hasColumn(T.nodes, C.isEncrypted))) {
        await knex.schema.alterTable(T.nodes, (t) => {
            t.boolean(C.isEncrypted).notNullable().defaultTo(false);
        });
    }
    if (!(await knex.schema.hasColumn(T.nodes, C.keyId))) {
        await knex.schema.alterTable(T.nodes, (t) => {
            t.text(C.keyId).nullable();
        });
    }
}

export async function down(knex: Knex): Promise<void> {
    if (await knex.schema.hasColumn(T.nodes, C.keyId)) {
        await knex.schema.alterTable(T.nodes, (t) => {
            t.dropColumn(C.keyId);
        });
    }
    if (await knex.schema.hasColumn(T.nodes, C.isEncrypted)) {
        await knex.schema.alterTable(T.nodes, (t) => {
            t.dropColumn(C.isEncrypted);
        });
    }
}
