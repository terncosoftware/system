/**
 * TRN-159: Stale-run reaper.
 *
 * A built-in system job (id `sys.jobs.reap`) that recovers `sys_job_run` rows
 * stuck in `running` because the executor crashed mid-run. It is the crash
 * counterpart to lease expiry on the role side: JobRunner marks a run `running`
 * before invoking the handler, so a process that dies mid-handler leaves the row
 * `running` forever with no one to finish it.
 *
 * A run is "stale" when its `started_at` is older than `staleTimeoutMs` — longer
 * than any handler is allowed to take (the per-handler timeout). The reaper
 * treats a stale run as a failed attempt, mirroring JobRunner's failure path:
 *   - attempts remaining  → mark the stale row `failed` and enqueue a fresh
 *     `pending` retry (attempt + 1, eligible immediately).
 *   - attempts exhausted  → mark the stale row `dead`.
 *
 * Incrementing the attempt across reaps is deliberate: a handler that crashes
 * the process every run must still reach `dead` rather than loop forever.
 *
 * It also catches the opposite case: a due `pending` run nobody claims. The
 * runner claims only runs it has a handler and role for, so a job whose handler
 * no process registers stays pending forever. A pending run still unclaimed
 * `overdueIntervals` schedule intervals after it was due is stamped with
 * OVERDUE_PENDING_ERROR (a pending run has no other error) and logged as an
 * error, once per job until its runs are claimed. JobMetric.overduePendingRuns
 * counts the stamped runs for an alarm.
 *
 * Registered as a JobHandler so the platform manages itself with its own
 * primitive. The clock and stale threshold are injectable for deterministic
 * tests; production wires the real clock and REAPER_STALE_TIMEOUT_MS.
 */

import { getLog } from "@terncosoftware/core";
import type { Knex } from "knex";
import { REAPER_OVERDUE_INTERVALS, REAPER_STALE_TIMEOUT_MS } from "../config.js";
import type { JobContext, JobHandler } from "../JobHandlers.js";
import { nextRunBase } from "../schedule/nextRun.js";
import type { Schedule } from "../schedule/types.js";

const log = getLog("sys:worker:stale-run-reaper");

/** Stamped on a pending run that stayed unclaimed long past its due time. */
export const OVERDUE_PENDING_ERROR =
    "overdue: no process claims this run (none registers its handler or holds its role)";

export interface StaleRunReaperOptions {
    /** Injectable clock for deterministic tests. Defaults to () => new Date(). */
    now?: () => Date;
    /**
     * A `running` run whose started_at is older than this is considered stale.
     * Defaults to REAPER_STALE_TIMEOUT_MS.
     */
    staleTimeoutMs?: number;
    /**
     * A due pending run unclaimed after this many schedule intervals is
     * overdue. Defaults to REAPER_OVERDUE_INTERVALS.
     */
    overdueIntervals?: number;
}

/** A stale `running` run joined to its parent job's attempt cap. */
interface StaleRun {
    id: string;
    job_id: string;
    attempt: number;
    max_attempts: number;
}

/** A sys_job row's id and its stored schedule (jsonb, or text on SQLite). */
interface JobSchedule {
    id: string;
    schedule: unknown;
}

/**
 * Build the stale-run reaper handler.
 *
 * Register the result under SYS_JOB_REAPER_ID:
 *   handlers.registerJob(SYS_JOB_REAPER_ID, createStaleRunReaper({ ... }))
 */
export function createStaleRunReaper(options: StaleRunReaperOptions = {}): JobHandler {
    const now = options.now ?? (() => new Date());
    const staleTimeoutMs = options.staleTimeoutMs ?? REAPER_STALE_TIMEOUT_MS;
    const overdueIntervals = options.overdueIntervals ?? REAPER_OVERDUE_INTERVALS;

    return async (ctx: JobContext, _args: Record<string, string>): Promise<void> => {
        const reapedAt = now();
        const cutoff = new Date(reapedAt.getTime() - staleTimeoutMs);
        const trx = ctx.trx;

        const stale = await trx("sys_job_run as r")
            .join("sys_job as j", "r.job_id", "j.id")
            .where("r.status", "running")
            .where("r.started_at", "<=", cutoff)
            .select<StaleRun[]>(
                "r.id as id",
                "r.job_id as job_id",
                "r.attempt as attempt",
                "j.max_attempts as max_attempts",
            );

        for (const run of stale) {
            const hasRetry = run.attempt < run.max_attempts;
            const error =
                `reaped: run was stale (running with no progress for over ${staleTimeoutMs}ms); ` +
                "the executor likely crashed mid-run";

            await trx("sys_job_run")
                .where({ id: run.id })
                .update({
                    status: hasRetry ? "failed" : "dead",
                    finished_at: reapedAt,
                    error,
                });

            if (hasRetry) {
                // Re-enqueue immediately: a crash is not a logic failure, so no
                // backoff. Eligibility is gated by scheduled_for <= now.
                await trx("sys_job_run").insert({
                    id: crypto.randomUUID(),
                    job_id: run.job_id,
                    scheduled_for: reapedAt,
                    status: "pending",
                    attempt: run.attempt + 1,
                    claimed_by: null,
                    started_at: null,
                    finished_at: null,
                    error: null,
                });
            }
        }

        await _flagOverduePendingRuns(trx, reapedAt, overdueIntervals);
    };
}

/**
 * Stamp every due pending run left unclaimed for `overdueIntervals` of its
 * job's schedule intervals, and log an error for each job that had no stamped
 * run yet, so a stuck job is reported once rather than on every reap.
 */
async function _flagOverduePendingRuns(
    trx: Knex.Transaction,
    now: Date,
    overdueIntervals: number,
): Promise<void> {
    const jobs = await trx("sys_job").select<JobSchedule[]>("id", "schedule");
    const cutoffs = jobs.flatMap((job) => {
        const intervalMs = _intervalMs(job.schedule, now);
        if (intervalMs === null) {
            return [];
        }
        return [{ jobId: job.id, cutoff: new Date(now.getTime() - overdueIntervals * intervalMs) }];
    });
    if (cutoffs.length === 0) {
        return;
    }

    const overdue = (query: Knex.QueryBuilder): Knex.QueryBuilder =>
        query
            .where("status", "pending")
            .whereNull("error")
            .where((any) => {
                for (const { jobId, cutoff } of cutoffs) {
                    any.orWhere((run) => {
                        run.where("job_id", jobId).where("scheduled_for", "<=", cutoff);
                    });
                }
            });

    const counts: { job_id: string; runs: number | string }[] = await overdue(trx("sys_job_run"))
        .select("job_id")
        .count("* as runs")
        .groupBy("job_id");
    if (counts.length === 0) {
        return;
    }

    const stamped: { job_id: string }[] = await trx("sys_job_run")
        .where("status", "pending")
        .whereNotNull("error")
        .distinct("job_id");
    const alreadyReported = new Set(stamped.map((row) => row.job_id));

    await overdue(trx("sys_job_run")).update({ error: OVERDUE_PENDING_ERROR });

    for (const row of counts) {
        if (alreadyReported.has(row.job_id)) {
            continue;
        }
        log.error(
            "overdue-pending-run",
            "A due job run is still pending long past its schedule; no process claims it",
            { jobId: row.job_id, runs: Number(row.runs), overdueIntervals },
        );
    }
}

/**
 * The gap between a schedule's next two fires after `now`, or null when the
 * stored schedule cannot be read (JobScheduler already fails loudly on it).
 */
function _intervalMs(raw: unknown, now: Date): number | null {
    try {
        const schedule = (typeof raw === "string" ? JSON.parse(raw) : raw) as Schedule;
        const next = nextRunBase(schedule, now);
        return nextRunBase(schedule, next).getTime() - next.getTime();
    } catch {
        return null;
    }
}
