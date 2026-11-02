/**
 * TRN-159: Integration tests for the stale-run reaper (sys.jobs.reap).
 *
 * Real SQLite (in-memory), real schema, real transactions — no mocks. The
 * reaper's clock and stale threshold are injected so the "stale" boundary is
 * deterministic; rows are inserted with explicit started_at offsets.
 *
 * Covers:
 *   - Stale running run with attempts remaining → failed + a fresh pending retry.
 *   - Stale running run with attempts exhausted → dead, no retry enqueued.
 *   - A fresh running run (within the timeout) is left untouched.
 *   - Non-running rows (pending / succeeded / dead) are never touched.
 *   - A pending run unclaimed 10 schedule intervals past due is stamped
 *     overdue, logged as an error once per job, and counted in JobMetric
 *     (SQLite and real Postgres, issue #128).
 */

import {
    bindService,
    ConsoleLogger,
    type Logger,
    SystemLogger,
    systemSec,
} from "@terncosoftware/core";
import { createDataContext } from "@terncosoftware/data";
import {
    computeJobMetrics,
    createStaleRunReaper,
    type JobContext,
    type JobHandler,
    OVERDUE_PENDING_ERROR,
} from "@terncosoftware/worker";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ── Constants ───────────────────────────────────────────────────────────────

const NOW = new Date("2026-06-01T12:00:00.000Z");
const STALE_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes

// ── Helpers ─────────────────────────────────────────────────────────────────

async function runHandler(knex: Knex, handler: JobHandler): Promise<void> {
    await knex.transaction(async (trx) => {
        const ctx: JobContext = { knex, trx, sec: systemSec, tenantId: null };
        await handler(ctx, {});
    });
}

async function insertJob(knex: Knex, opts: { id: string; maxAttempts?: number }): Promise<void> {
    await knex("sys_job").insert({
        id: opts.id,
        schedule: JSON.stringify({ every: "PT1M" }),
        handler: "noop",
        requires_role: null,
        enabled: true,
        next_run_at: NOW,
        max_attempts: opts.maxAttempts ?? 3,
        meta: null,
    });
}

async function insertRun(
    knex: Knex,
    opts: {
        jobId: string;
        status: string;
        attempt?: number;
        startedAt?: Date | null;
        scheduledFor?: Date;
        finishedAt?: Date | null;
    },
): Promise<string> {
    const id = crypto.randomUUID();
    // Unique scheduled_for per row so multiple runs for one job don't collide
    // on unique(job_id, scheduled_for, attempt). Reaping keys off status +
    // started_at, not scheduled_for, so the exact value is irrelevant here.
    const scheduledFor = opts.scheduledFor ?? new Date(NOW.getTime() + _seq++);
    await knex("sys_job_run").insert({
        id,
        job_id: opts.jobId,
        scheduled_for: scheduledFor,
        status: opts.status,
        attempt: opts.attempt ?? 1,
        claimed_by: opts.status === "running" ? "runner-test" : null,
        started_at: opts.startedAt ?? null,
        finished_at: opts.finishedAt ?? null,
        error: null,
    });
    return id;
}

function getRun(knex: Knex, id: string) {
    return knex("sys_job_run").where({ id }).first();
}

function runsForJob(knex: Knex, jobId: string) {
    return knex("sys_job_run").where({ job_id: jobId }).orderBy("attempt", "asc").select("*");
}

// A started_at comfortably past the stale boundary.
const STALE_STARTED_AT = new Date(NOW.getTime() - STALE_TIMEOUT_MS - 1_000);

// Monotonic sequence to give each inserted run a distinct scheduled_for.
let _seq = 0;

// ── Tests ───────────────────────────────────────────────────────────────────

describe("StaleRunReaper — SQLite (in-memory)", () => {
    let knex: Knex;
    let reaper: JobHandler;

    beforeEach(async () => {
        knex = await createDataContext({ client: "sqlite", filename: ":memory:" });
        reaper = createStaleRunReaper({ now: () => NOW, staleTimeoutMs: STALE_TIMEOUT_MS });
    });

    afterEach(async () => {
        await knex.destroy();
    });

    it("fails a stale running run with attempts remaining and enqueues a retry", async () => {
        await insertJob(knex, { id: "job.stale", maxAttempts: 3 });
        const staleId = await insertRun(knex, {
            jobId: "job.stale",
            status: "running",
            attempt: 1,
            startedAt: STALE_STARTED_AT,
        });

        await runHandler(knex, reaper);

        const original = await getRun(knex, staleId);
        expect(original.status).toBe("failed");
        expect(original.finished_at).not.toBeNull();
        expect(original.error).toMatch(/reaped/i);

        const all = await runsForJob(knex, "job.stale");
        expect(all).toHaveLength(2);
        const retry = all[1];
        expect(retry.attempt).toBe(2);
        expect(retry.status).toBe("pending");
        expect(retry.started_at).toBeNull();
    });

    it("marks a stale running run dead when attempts are exhausted", async () => {
        await insertJob(knex, { id: "job.exhausted", maxAttempts: 2 });
        const staleId = await insertRun(knex, {
            jobId: "job.exhausted",
            status: "running",
            attempt: 2,
            startedAt: STALE_STARTED_AT,
        });

        await runHandler(knex, reaper);

        const original = await getRun(knex, staleId);
        expect(original.status).toBe("dead");
        expect(original.error).toMatch(/reaped/i);

        // No retry enqueued — this was the final attempt.
        const all = await runsForJob(knex, "job.exhausted");
        expect(all).toHaveLength(1);
    });

    it("leaves a fresh running run (within the timeout) untouched", async () => {
        await insertJob(knex, { id: "job.fresh", maxAttempts: 3 });
        const freshStartedAt = new Date(NOW.getTime() - 1_000); // 1s ago, not stale
        const freshId = await insertRun(knex, {
            jobId: "job.fresh",
            status: "running",
            attempt: 1,
            startedAt: freshStartedAt,
        });

        await runHandler(knex, reaper);

        const row = await getRun(knex, freshId);
        expect(row.status).toBe("running");
        const all = await runsForJob(knex, "job.fresh");
        expect(all).toHaveLength(1);
    });

    it("never touches non-running rows regardless of age", async () => {
        await insertJob(knex, { id: "job.mixed", maxAttempts: 3 });
        const old = new Date(NOW.getTime() - STALE_TIMEOUT_MS - 60_000);
        const pendingId = await insertRun(knex, {
            jobId: "job.mixed",
            status: "pending",
            scheduledFor: old,
        });
        const succeededId = await insertRun(knex, {
            jobId: "job.mixed",
            status: "succeeded",
            startedAt: old,
            finishedAt: old,
        });
        const deadId = await insertRun(knex, {
            jobId: "job.mixed",
            status: "dead",
            startedAt: old,
            finishedAt: old,
        });

        await runHandler(knex, reaper);

        expect((await getRun(knex, pendingId)).status).toBe("pending");
        expect((await getRun(knex, succeededId)).status).toBe("succeeded");
        expect((await getRun(knex, deadId)).status).toBe("dead");
        const all = await runsForJob(knex, "job.mixed");
        expect(all).toHaveLength(3);
    });
});

// ── Overdue pending runs (#128) ─────────────────────────────────────────────

interface Provider {
    name: string;
    create(): Promise<Knex>;
}

const providers: Provider[] = [
    {
        name: "SQLite (in-memory)",
        create: () => createDataContext({ client: "sqlite", filename: ":memory:" }),
    },
];

if (process.env.SYS_PG_URL) {
    const url = new URL(process.env.SYS_PG_URL);
    providers.push({
        name: "Postgres",
        create: () =>
            createDataContext({
                client: "pg",
                host: url.hostname,
                port: url.port ? Number(url.port) : 5432,
                database: url.pathname.slice(1),
                user: url.username,
                password: url.password,
            }),
    });
}

interface ErrorLine {
    code: string;
    meta?: Record<string, unknown>;
}

/** A sink that records error lines, bound in place of the real logger. */
function captureErrors(): { sink: Logger; errors: ErrorLine[] } {
    const errors: ErrorLine[] = [];
    const sink: Logger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (code, _msg, meta) => errors.push({ code, meta }),
    };
    return { sink, errors };
}

// Every job here runs every minute, so ten intervals is ten minutes.
const INTERVAL_MS = 60_000;

for (const provider of providers) {
    describe(`StaleRunReaper overdue pending runs — ${provider.name}`, () => {
        let knex: Knex;
        let trx: Knex.Transaction;
        let errors: ErrorLine[];
        let reaper: JobHandler;

        beforeEach(async () => {
            knex = await provider.create();
            trx = await knex.transaction();
            const captured = captureErrors();
            errors = captured.errors;
            bindService(SystemLogger, captured.sink);
            reaper = createStaleRunReaper({ now: () => NOW, overdueIntervals: 10 });
        });

        afterEach(async () => {
            bindService(SystemLogger, new ConsoleLogger());
            await trx.rollback();
            await knex.destroy();
        });

        async function overdueCount(jobId: string): Promise<number> {
            const metric = (await computeJobMetrics(trx)).find((m) => m.jobId === jobId);
            return metric?.overduePendingRuns ?? 0;
        }

        it("stamps a run pending 10 intervals past due, logs it once, and counts it", async () => {
            await insertJob(trx, { id: "job.orphan" });
            const firstId = await insertRun(trx, {
                jobId: "job.orphan",
                status: "pending",
                scheduledFor: new Date(NOW.getTime() - 11 * INTERVAL_MS),
            });

            await runHandler(trx, reaper);

            const first = await getRun(trx, firstId);
            expect(first.status).toBe("pending");
            expect(first.error).toBe(OVERDUE_PENDING_ERROR);
            expect(errors).toEqual([
                {
                    code: "overdue-pending-run",
                    meta: expect.objectContaining({ jobId: "job.orphan", runs: 1 }),
                },
            ]);
            expect(await overdueCount("job.orphan")).toBe(1);

            // The next fire goes overdue too: counted, but the job is not
            // reported again.
            await insertRun(trx, {
                jobId: "job.orphan",
                status: "pending",
                scheduledFor: new Date(NOW.getTime() - 10 * INTERVAL_MS),
            });
            await runHandler(trx, reaper);

            expect(errors).toHaveLength(1);
            expect(await overdueCount("job.orphan")).toBe(2);
        });

        it("leaves a run pending under 10 intervals alone", async () => {
            await insertJob(trx, { id: "job.late" });
            const runId = await insertRun(trx, {
                jobId: "job.late",
                status: "pending",
                scheduledFor: new Date(NOW.getTime() - 9 * INTERVAL_MS),
            });

            await runHandler(trx, reaper);

            expect((await getRun(trx, runId)).error).toBeNull();
            expect(errors).toHaveLength(0);
            expect(await overdueCount("job.late")).toBe(0);
        });
    });
}
