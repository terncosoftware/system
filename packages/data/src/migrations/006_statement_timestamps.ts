import type { Knex } from "knex";

/**
 * Stamps node and edge rows with the time of the statement that wrote them, not
 * the start of the transaction.
 *
 * Postgres NOW() is fixed for a whole transaction, so every row written in one
 * transaction got the same created_at and updated_at, and "most recent" or
 * "after the read watermark" could not order them. SQLite's triggers already
 * stamp per statement; statement_timestamp() gives Postgres the same meaning.
 *
 * Postgres only, and idempotent: CREATE OR REPLACE swaps the trigger functions
 * that 001 installed, and the triggers that call them stay as they are.
 */
export async function up(knex: Knex): Promise<void> {
    const client = (knex.client as { config: { client: string } }).config.client;
    if (client !== "pg" && client !== "postgresql") {
        return;
    }

    await knex.raw(`
        CREATE OR REPLACE FUNCTION tern_node_timestamps()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_OP = 'INSERT' THEN
                NEW.created_at = statement_timestamp();
                NEW.updated_at = statement_timestamp();
            ELSE
                NEW.created_at = OLD.created_at;
                NEW.updated_at = statement_timestamp();
            END IF;
            RETURN NEW;
        END; $$;
    `);

    await knex.raw(`
        CREATE OR REPLACE FUNCTION tern_edge_timestamps()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_OP = 'INSERT' THEN
                NEW.created_at = statement_timestamp();
                NEW.updated_at = statement_timestamp();
            ELSE
                NEW.created_at = OLD.created_at;
                NEW.updated_at = statement_timestamp();
                IF NEW.is_deleted AND NOT OLD.is_deleted THEN
                    NEW.deleted_at = statement_timestamp();
                END IF;
            END IF;
            RETURN NEW;
        END; $$;
    `);
}
