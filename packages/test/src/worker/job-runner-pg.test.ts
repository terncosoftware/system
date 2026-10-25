/**
 * TRN-403: JobRunner regressions proven against REAL Postgres.
 *
 * Two staging defects, root-caused to the JobRunner:
 *
 *   1. A `module://` handler (the Switchyard Clock dispatcher) hung until the 30s
 *      timeout. The runner ran every handler inside an OUTER knex transaction it
 *      held for the handler's whole duration; the Clock handler then needs further
 *      pooled connections for its own (separate-store) writes after a network
 *      send, so on a small pool it could never get one and never returned — a
 *      deadlock surfacing as a timeout. Fix: a module:// handler runs with NO
 *      outer transaction, so the pool is free for its own work.
 *
 *   2. The timeout drove a retry whose (job_id, scheduled_for, attempt) insert
 *      collided with a sibling's, throwing a duplicate-key error OUT of the tick
 *      (spamming logs, leaving the run stuck `running`). Fix: the retry insert is
 *      idempotent (onConflict.ignore), exactly like the scheduler's.
 *
 * A third case: runners that hold the same role but registered different
 * handlers each claim only the runs they can execute, so neither fails the
 * other's jobs with "no handler registered".
 *
 * Real infra only: a single-connection pg pool is what makes the deadlock real —
 * SQLite serialises on one connection and cannot exhibit it. Each test isolates by
 * truncating the sys_job/sys_job_run tables it touches; it never resets the schema.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { _clearModuleRefCache, bindService } from "@terncosoftware/core";
import { createDataContext, DataSource } from "@terncosoftware/data";
import { FlowContext } from "@terncosoftware/flow";
import { JobHandlers, JobRunner } from "@terncosoftware/worker";
import type { Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { poolInvocations, setPoolHandlerKnex } from "./fixtures/pool-handler.js";

const PG_CONFIG = {
    client: "pg" as const,
    host: process.env.SYS_POSTGRES_HOST ?? "localhost",
    port: Number(process.env.SYS_POSTGRES_PORT ?? "5432"),
    database: process.env.SYS_POSTGRES_DATABASE ?? "sys",
    user: process.env.SYS_POSTGRES_USER ?? "sys",
    password: process.env.SYS_POSTGRES_PASSWORD ?? "sys",
};

const FIXTURE_DIR = resolve(new URL(import.meta.url).pathname, "../fixtures");

function fixtureUri(filename: string, member: string): string {
    return `module://${pathToFileURL(resolve(FIXTURE_DIR, filename)).href}#${member}`;
}

function runTick(runner: JobRunner): Promise<void> {
    return (runner as unknown as { _tick(): Promise<void> })._tick();
}

async function insertJob(
    knex: Knex,
    opts: { jobId: string; handler: string; maxAttempts?: number; requiresRole?: string },
): Promise<void> {
    await knex("sys_job").insert({
        id: opts.jobId,
        schedule: JSON.stringify({ every: "PT30S" }),
        handler: opts.handler,
        requires_role: opts.requiresRole ?? null,
        enabled: true,
        next_run_at: new Date(Date.now() + 30_000),
        max_attempts: opts.maxAttempts ?? 3,
        meta: null,
    });
}

async function insertPendingRun(
    knex: Knex,
    opts: { jobId: string; scheduledFor: Date; attempt?: number },
): Promise<string> {
    const runId = crypto.randomUUID();
    await knex("sys_job_run").insert({
        id: runId,
        job_id: opts.jobId,
        scheduled_for: opts.scheduledFor,
        status: "pending",
        attempt: opts.attempt ?? 1,
        claimed_by: null,
        started_at: null,
        finished_at: null,
        error: null,
    });
    return runId;
}

// Postgres-only: a single-connection pg pool is what makes the deadlock real, so
// the suite is meaningless on SQLite. Gate on the repo's standard Postgres opt-in
// (SYS_PG_URL) so the SQLite-only CI skips it instead of failing to reach :5432.
describe.skipIf(!process.env.SYS_PG_URL)("JobRunner — real Postgres (TRN-403)", () => {
    let knex: Knex;

    beforeAll(async () => {
        // A pool of ONE: the smallest pool that makes the held-transaction deadlock
        // deterministic. createDataContext runs the migrations so the schema exists.
        knex = await createDataContext({ ...PG_CONFIG });
        bindService(DataSource, new DataSource(knex));
        // Shrink the pool created above to a single connection for this suite.
        await knex.destroy();
        const { default: Knex } = await import("knex");
        knex = Knex({ client: "pg", connection: PG_CONFIG, pool: { min: 1, max: 1 } });
        bindService(DataSource, new DataSource(knex));
    });

    afterAll(async () => {
        setPoolHandlerKnex(null);
        await knex.destroy();
    });

    beforeEach(async () => {
        _clearModuleRefCache();
        poolInvocations.length = 0;
        // Isolate: clear only this suite's rows (runs before jobs for the FK).
        await knex("sys_job_run")
            .whereIn("job_id", (q) =>
                q
                    .select("id")
                    .from("sys_job")
                    .where("id", "like", "trn403.%")
                    .orWhere("id", "like", "shared-role.%"),
            )
            .del();
        await knex("sys_job")
            .where("id", "like", "trn403.%")
            .orWhere("id", "like", "shared-role.%")
            .del();
    });

    it("runs a module:// handler that does its OWN pooled DB work and records it succeeded", async () => {
        setPoolHandlerKnex(knex);
        const handler = fixtureUri("pool-handler.ts", "handlePoolJob");

        await insertJob(knex, { jobId: "trn403.pool", handler });
        const runId = await insertPendingRun(knex, {
            jobId: "trn403.pool",
            scheduledFor: new Date(Date.now() - 1_000),
        });

        const runner = new JobRunner({
            context: new FlowContext(),
            handlers: new JobHandlers(),
            // A real (but generous) timeout: the deadlock fix means the handler
            // returns in milliseconds; the OLD code would hit this and fail.
            timeoutMs: 5_000,
            tickIntervalMs: 1_000_000,
        });

        await runTick(runner);

        const row = await knex("sys_job_run").where({ id: runId }).first();
        expect(row.status).toBe("succeeded");
        expect(row.error).toBeNull();
        // The handler actually reached a second connection mid-run.
        expect(poolInvocations).toEqual([{ value: 42 }]);
    }, 15_000);

    it("idempotently absorbs a colliding retry insert instead of crashing the tick", async () => {
        // Two runs of the SAME attempt that both fail (here: a handler that
        // throws at once) in the same backoff window compute the SAME retry
        // slot (job_id, scheduled_for, attempt). The second insert must be a
        // no-op, not a duplicate-key throw that aborts the tick.
        // Pin "now" AFTER the rows' scheduled_for so both are claimable, and so
        // both failures compute an identical retryAt -> identical retry key.
        const pinnedNow = new Date("2026-06-26T12:00:00.000Z");
        const due = new Date(pinnedNow.getTime() - 1_000);
        await insertJob(knex, {
            jobId: "trn403.collide",
            handler: "trn403.throws",
            maxAttempts: 3,
        });
        const run1 = await insertPendingRun(knex, {
            jobId: "trn403.collide",
            scheduledFor: due,
            attempt: 1,
        });
        // A second attempt-1 run for the same job (a real possibility under the
        // staging retry pile-up) whose failure wants the same retry slot.
        const run2 = await insertPendingRun(knex, {
            jobId: "trn403.collide",
            scheduledFor: new Date(due.getTime() + 1),
            attempt: 1,
        });

        const handlers = new JobHandlers();
        handlers.registerJob("trn403.throws", async () => {
            throw new Error("handler failed");
        });
        const runner = new JobRunner({
            context: new FlowContext(),
            handlers,
            now: () => pinnedNow,
            backoffMaxMs: 5_000,
            tickIntervalMs: 1_000_000,
        });

        // The tick must not throw even though the second retry insert collides.
        await expect(runTick(runner)).resolves.toBeUndefined();

        // Both originals are recorded failed (not left stuck running).
        const r1 = await knex("sys_job_run").where({ id: run1 }).first();
        const r2 = await knex("sys_job_run").where({ id: run2 }).first();
        expect(r1.status).toBe("failed");
        expect(r2.status).toBe("failed");

        // Exactly ONE attempt-2 retry exists for the job — the collision folded
        // into a single retry rather than erroring or duplicating.
        const retries = await knex("sys_job_run")
            .where({ job_id: "trn403.collide", attempt: 2 })
            .select("*");
        expect(retries).toHaveLength(1);
        expect(retries[0].status).toBe("pending");
    }, 15_000);

    it("runs each job only on the runner that registered its handler when both hold the role", async () => {
        // Both runners hold the job's role (the mis-configuration that hit tern:
        // several workers asking for one scheduler role). Each registered a
        // different handler set, so each must claim only its own runs.
        const role = "shared-role.scheduler";
        const due = new Date(Date.now() - 1_000);
        const ran: { runner: string; job: string }[] = [];

        const makeRunner = (name: string, jobIds: string[]): JobRunner => {
            const handlers = new JobHandlers();
            for (const jobId of jobIds) {
                handlers.registerJob(jobId, async () => {
                    ran.push({ runner: name, job: jobId });
                });
            }
            return new JobRunner({
                context: new FlowContext(),
                handlers,
                holdsRole: (r) => r === role,
                timeoutMs: 5_000,
                tickIntervalMs: 1_000_000,
            });
        };

        const jobsA = ["shared-role.a1", "shared-role.a2"];
        const jobsB = ["shared-role.b1", "shared-role.b2"];
        const runIds = new Map<string, string>();
        for (const jobId of [...jobsA, ...jobsB]) {
            await insertJob(knex, { jobId, handler: jobId, maxAttempts: 3, requiresRole: role });
            runIds.set(jobId, await insertPendingRun(knex, { jobId, scheduledFor: due }));
        }

        const runnerA = makeRunner("a", jobsA);
        const runnerB = makeRunner("b", jobsB);

        // A ticks first with every run due: it must leave B's runs pending.
        await runTick(runnerA);
        const afterA = await knex("sys_job_run")
            .whereIn("job_id", jobsB)
            .select("status", "claimed_by", "error");
        expect(afterA).toHaveLength(2);
        for (const row of afterA) {
            expect(row.status).toBe("pending");
            expect(row.claimed_by).toBeNull();
            expect(row.error).toBeNull();
        }

        await runTick(runnerB);
        // Further ticks find nothing left to run.
        await runTick(runnerA);
        await runTick(runnerB);

        expect([...ran].sort((x, y) => x.job.localeCompare(y.job))).toEqual([
            { runner: "a", job: "shared-role.a1" },
            { runner: "a", job: "shared-role.a2" },
            { runner: "b", job: "shared-role.b1" },
            { runner: "b", job: "shared-role.b2" },
        ]);

        const rows = await knex("sys_job_run")
            .whereIn("job_id", [...jobsA, ...jobsB])
            .select("id", "status", "error");
        // No retries were queued: one run per job, each succeeded.
        expect(rows).toHaveLength(4);
        for (const row of rows) {
            expect([...runIds.values()]).toContain(row.id);
            expect(row.status).toBe("succeeded");
            expect(row.error).toBeNull();
        }
    }, 15_000);
});
