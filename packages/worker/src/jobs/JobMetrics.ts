/**
 * TRN-159: Per-job metrics + threshold alerting.
 *
 * Derives operational metrics for every job from sys_job_run history:
 *   - lastRunAt          — started_at of the most recent terminal run.
 *   - lastStatus         — its status (succeeded | failed | dead).
 *   - lastDurationMs     — finished_at − started_at of that run.
 *   - schedulingLagMs    — started_at − scheduled_for of that run (how late the
 *                          runner picked it up).
 *   - consecutiveFailures — count of the most-recent terminal runs that failed
 *                          or went dead, back to (not including) the last
 *                          success. Resets to 0 on any success.
 *   - overduePendingRuns  — pending runs the stale-run reaper stamped overdue:
 *                          still unclaimed long past their due time, because
 *                          no process registers the handler or holds the role.
 *                          Alarm on any value above 0.
 *
 * computeJobMetrics issues one query for all terminal runs (ordered) and one
 * grouped count of overdue pending runs, and folds in memory — no per-job query
 * loop. emitJobMetrics surfaces them via
 * an injectable structured-log sink and is loud (warn) for any job whose
 * consecutiveFailures crosses METRICS_CONSECUTIVE_FAILURE_ALERT_THRESHOLD, so
 * operators can act before the next run goes dead.
 *
 * The log sink is injected (defaulting to console) because the worker has no
 * structured logger wired yet; swapping in pino later is a one-line change at
 * the call site.
 */

import { getLog } from "@terncosoftware/core";
import type { Knex } from "knex";
import { METRICS_CONSECUTIVE_FAILURE_ALERT_THRESHOLD } from "../config.js";

const log = getLog("sys:worker:job-metrics");

/** Terminal run statuses, most-recent-first folding stops/continues on these. */
const TERMINAL_STATUSES = ["succeeded", "failed", "dead"] as const;

export interface JobMetric {
    jobId: string;
    enabled: boolean;
    lastRunAt: Date | null;
    lastStatus: string | null;
    lastDurationMs: number | null;
    schedulingLagMs: number | null;
    consecutiveFailures: number;
    overduePendingRuns: number;
}

/** Structured log record emitted per job over the alert threshold. */
export interface JobMetricAlert {
    level: "warn";
    message: string;
    metric: JobMetric;
}

export type MetricLogSink = (alert: JobMetricAlert) => void;

interface JobRow {
    id: string;
    enabled: boolean | number;
}

interface TerminalRunRow {
    job_id: string;
    status: string;
    scheduled_for: Date | string;
    started_at: Date | string | null;
    finished_at: Date | string | null;
}

function _toDate(value: Date | string | null): Date | null {
    if (value === null) {
        return null;
    }
    return value instanceof Date ? value : new Date(value);
}

/**
 * Compute per-job metrics from sys_job_run history.
 *
 * One query fetches every terminal run (oldest jobs included via the job list),
 * ordered by job then started_at descending; the fold walks each job's runs
 * once. Jobs with no terminal runs yet report nulls and zero failures.
 */
export async function computeJobMetrics(knex: Knex): Promise<JobMetric[]> {
    const jobs = await knex<JobRow>("sys_job").select("id", "enabled").orderBy("id", "asc");

    const runs = await knex<TerminalRunRow>("sys_job_run")
        .whereIn("status", [...TERMINAL_STATUSES])
        .whereNotNull("started_at")
        .select("job_id", "status", "scheduled_for", "started_at", "finished_at")
        .orderBy([
            { column: "job_id", order: "asc" },
            { column: "started_at", order: "desc" },
        ]);

    // Only the reaper writes an error on a pending run (OVERDUE_PENDING_ERROR).
    const overdueRows: { job_id: string; runs: number | string }[] = await knex("sys_job_run")
        .where("status", "pending")
        .whereNotNull("error")
        .select("job_id")
        .count("* as runs")
        .groupBy("job_id");
    const overdueByJob = new Map(overdueRows.map((row) => [row.job_id, Number(row.runs)]));

    // Bucket the ordered runs by job (single pass; runs are grouped by job_id).
    const runsByJob = new Map<string, TerminalRunRow[]>();
    for (const run of runs) {
        const bucket = runsByJob.get(run.job_id);
        if (bucket === undefined) {
            runsByJob.set(run.job_id, [run]);
        } else {
            bucket.push(run);
        }
    }

    return jobs.map((job) => {
        const jobRuns = runsByJob.get(job.id) ?? [];
        const enabled = job.enabled === true || job.enabled === 1;
        const overduePendingRuns = overdueByJob.get(job.id) ?? 0;

        if (jobRuns.length === 0) {
            return {
                jobId: job.id,
                enabled,
                lastRunAt: null,
                lastStatus: null,
                lastDurationMs: null,
                schedulingLagMs: null,
                consecutiveFailures: 0,
                overduePendingRuns,
            };
        }

        const latest = jobRuns[0];
        const startedAt = _toDate(latest.started_at);
        const finishedAt = _toDate(latest.finished_at);
        const scheduledFor = _toDate(latest.scheduled_for);

        const lastDurationMs =
            startedAt !== null && finishedAt !== null
                ? finishedAt.getTime() - startedAt.getTime()
                : null;
        const schedulingLagMs =
            startedAt !== null && scheduledFor !== null
                ? startedAt.getTime() - scheduledFor.getTime()
                : null;

        // Walk most-recent-first, counting failures until the first success.
        let consecutiveFailures = 0;
        for (const run of jobRuns) {
            if (run.status === "succeeded") {
                break;
            }
            consecutiveFailures++;
        }

        return {
            jobId: job.id,
            enabled,
            lastRunAt: startedAt,
            lastStatus: latest.status,
            lastDurationMs,
            schedulingLagMs,
            consecutiveFailures,
            overduePendingRuns,
        };
    });
}

export interface EmitJobMetricsOptions {
    /** Structured-log sink. Defaults to the platform logger at warn level. */
    log?: MetricLogSink;
    /**
     * consecutiveFailures at or above this value triggers a warn alert.
     * Defaults to METRICS_CONSECUTIVE_FAILURE_ALERT_THRESHOLD.
     */
    threshold?: number;
}

const _defaultSink: MetricLogSink = (alert) => {
    log.warn("alert", alert.message);
};

/**
 * Compute metrics and emit a warn alert for every job whose consecutiveFailures
 * is at or above the threshold. Returns the full metric set so callers can also
 * push it to a scrape endpoint. Jobs below the threshold are not logged.
 */
export async function emitJobMetrics(
    knex: Knex,
    options: EmitJobMetricsOptions = {},
): Promise<JobMetric[]> {
    const log = options.log ?? _defaultSink;
    const threshold = options.threshold ?? METRICS_CONSECUTIVE_FAILURE_ALERT_THRESHOLD;

    const metrics = await computeJobMetrics(knex);

    for (const metric of metrics) {
        if (metric.consecutiveFailures >= threshold) {
            log({
                level: "warn",
                message:
                    `job "${metric.jobId}" has ${metric.consecutiveFailures} consecutive ` +
                    `failures (last status: ${metric.lastStatus ?? "none"})`,
                metric,
            });
        }
    }

    return metrics;
}
