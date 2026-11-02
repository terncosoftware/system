/**
 * Default configuration constants for the worker package.
 *
 * All timing values are in milliseconds unless suffixed otherwise.
 * Group constants by concern so callers can import only what they need.
 */

// ── JobScheduler defaults ─────────────────────────────────────────────────────

/**
 * How often the scheduler polls for due jobs, in milliseconds.
 * Short enough for timely firing; long enough to avoid hammering the DB.
 */
export const SCHEDULER_TICK_INTERVAL_MS = 5_000;

/**
 * Maximum number of due jobs processed in a single tick.
 * Keeps each tick bounded; a backlog drains across successive ticks.
 */
export const SCHEDULER_BATCH_SIZE = 50;

// ── JobRunner defaults ────────────────────────────────────────────────────────

/**
 * How often the runner polls for pending runs, in milliseconds.
 * Short enough for timely execution; long enough to avoid hammering the DB.
 */
export const RUNNER_TICK_INTERVAL_MS = 2_000;

/**
 * Maximum number of pending runs claimed in a single tick.
 * Keeps each tick bounded; excess runs drain across successive ticks.
 */
export const RUNNER_BATCH_SIZE = 10;

/**
 * Per-handler execution timeout in milliseconds.
 * A wedged handler is killed and counted as a failure after this window.
 */
export const RUNNER_HANDLER_TIMEOUT_MS = 30_000;

/**
 * Base delay for exponential backoff between retry attempts, in milliseconds.
 * attempt N → backoff = min(BASE * 2^(attempt-1), MAX).
 */
export const RUNNER_BACKOFF_BASE_MS = 5_000;

/**
 * Maximum backoff cap between retry attempts, in milliseconds.
 * Prevents unbounded retry delays regardless of attempt count.
 */
export const RUNNER_BACKOFF_MAX_MS = 300_000;

// ── StaleRunReaper defaults ───────────────────────────────────────────────────

/**
 * A running sys_job_run whose started_at is older than this threshold is
 * considered stale (the executor crashed mid-run). The reaper recovers it
 * by marking it failed and, if retries remain, enqueuing a new pending run.
 */
export const REAPER_STALE_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes

/**
 * How often the reaper job fires.
 * Expressed as an ISO-8601 duration so it can be stored in sys_job.schedule.
 */
export const REAPER_SCHEDULE = "PT1M"; // every 1 minute

/**
 * A due `pending` run still unclaimed after this many of its job's schedule
 * intervals is overdue: no process registers its handler or holds its role.
 * The reaper logs it as an error once and flags it for JobMetric's
 * overduePendingRuns count.
 */
export const REAPER_OVERDUE_INTERVALS = 10;

// ── HistoryPruner defaults ────────────────────────────────────────────────────

/**
 * Succeeded and failed sys_job_run rows older than this are eligible for
 * deletion. Shorter than the dead-run window to keep the table lean while
 * the recent-success audit trail is retained.
 */
export const PRUNER_SUCCEEDED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days

/**
 * Dead sys_job_run rows older than this are eligible for deletion.
 * Dead runs are kept longer than succeeded ones to aid post-mortem diagnosis.
 */
export const PRUNER_DEAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days

/**
 * How often the pruner job fires.
 * Expressed as an ISO-8601 duration so it can be stored in sys_job.schedule.
 */
export const PRUNER_SCHEDULE = "P1D"; // every 1 day

// ── JobMetrics defaults ───────────────────────────────────────────────────────

/**
 * When a job's consecutive-failure count crosses this threshold, a structured
 * warning log entry is emitted so operators can act before the run goes dead.
 */
export const METRICS_CONSECUTIVE_FAILURE_ALERT_THRESHOLD = 3;

// ── Built-in system job ids ───────────────────────────────────────────────────

/** Handler/job id for the stale-run reaper built-in job. */
export const SYS_JOB_REAPER_ID = "sys.jobs.reap";

/** Handler/job id for the history pruner built-in job. */
export const SYS_JOB_PRUNER_ID = "sys.jobs.prune";

/** Role required by system self-management jobs. */
export const SYS_SCHEDULER_ROLE = "sys.scheduler";

/**
 * Attempt cap for built-in system jobs (reaper, pruner). They are idempotent,
 * so a few retries absorb transient DB hiccups before a run goes dead.
 */
export const SYS_JOB_MAX_ATTEMPTS = 5;

// ── RoleManager defaults ──────────────────────────────────────────────────────

/** Default lease TTL. A process must renew within this window or lose its slot. */
export const ROLE_DEFAULT_TTL_MS = 30_000;

/**
 * Heartbeat interval as a fraction of the TTL.
 * Renewing at TTL/3 gives two missed beats before the lease expires.
 */
export const ROLE_HEARTBEAT_DIVISOR = 3;

/** Default cap (number of concurrent holders) for a role. */
export const ROLE_DEFAULT_SLOTS = 1;

/** Nonce length (bytes) used when building the holder_id. */
export const ROLE_HOLDER_NONCE_BYTES = 4;
