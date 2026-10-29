/**
 * TRN-157: JobRunner FlowComponent.
 *
 * Claims `pending` sys_job_run rows, resolves + executes each job's handler,
 * and records the outcome with retry / backoff / dead-letter semantics.
 *
 * N runners across processes drain the queue concurrently via FOR UPDATE SKIP
 * LOCKED (Postgres) or serialised SQLite writes.
 *
 * Claim tick:
 *   1. SELECT pending sys_job_run rows with scheduled_for <= now, oldest first,
 *      joined to sys_job to read requires_role, handler, max_attempts.
 *      — Only runs this process can resolve: the job handler is a `module://`
 *        URI or an id registered in this process's JobHandlers. A run whose
 *        handler only another process registered is never claimed here, so it
 *        cannot be failed with "no handler registered".
 *      — Only runs whose job requires_role is null or a role this process
 *        holds (holdsRole); the rest stay pending for the holder.
 *      — FOR UPDATE SKIP LOCKED on Postgres; plain SELECT on SQLite.
 *   2. Within the same transaction, mark the selected rows running + set
 *      claimed_by + started_at.
 *
 * Execute:
 *   - Resolve the handler (module:// URI → resolveModuleRef; otherwise look up
 *     in the in-process registry).
 *   - An IN-PROCESS handler runs inside a fresh handler-scoped transaction so a
 *     failure rolls back the handler's own DB work but NOT the run-status
 *     bookkeeping. A MODULE:// handler runs WITHOUT an outer transaction: it owns
 *     its own persistence and may make a long network call mid-run, so holding a
 *     pooled connection idle across it would starve the small pool and deadlock
 *     (TRN-403). See _execute for the full rationale.
 *   - Enforce timeoutMs via Promise.race so wedged handlers cannot hang the runner.
 *   - Success → status='succeeded', finished_at=now.
 *   - Failure (throw/timeout) → record error; if attempt < max_attempts, insert
 *     a NEW retry run (status='pending', attempt+1, scheduled_for=now+backoff)
 *     and mark the current run failed; else mark it dead. The retry insert is
 *     idempotent on (job_id, scheduled_for, attempt) so colliding sibling retries
 *     fold into one rather than aborting the tick.
 *
 * Injection points for deterministic tests:
 *   - now: () => Date           — injectable clock
 *   - holdsRole: (role) => bool — injectable role predicate (default: () => true)
 *   - tickIntervalMs            — override tick cadence
 */

import { getLog, Inject, resolveModuleRef, systemSec } from "@terncosoftware/core";
// biome-ignore lint/style/useImportType: runtime DI token for @Inject (emitDecoratorMetadata); import type would elide it
import { DataSource } from "@terncosoftware/data";
import { FlowComponent, type FlowComponentOptions } from "@terncosoftware/flow";
import type { Knex } from "knex";
import {
    RUNNER_BACKOFF_BASE_MS,
    RUNNER_BACKOFF_MAX_MS,
    RUNNER_BATCH_SIZE,
    RUNNER_HANDLER_TIMEOUT_MS,
    RUNNER_TICK_INTERVAL_MS,
} from "../config.js";
import type { JobContext, JobHandler, JobHandlers } from "../JobHandlers.js";

const log = getLog("sys:worker:job-runner");

// ── Types ─────────────────────────────────────────────────────────────────────

/** A resolved handler: its callable, bound args, and whether it came from a module:// URI. */
interface ResolvedHandler {
    fn: JobHandler;
    args: Record<string, string>;
    /** True for a `module://` handler (run without an outer transaction; see _execute). */
    isModuleRef: boolean;
}

/** A pending sys_job_run row joined to its parent sys_job. */
interface ClaimCandidate {
    run_id: string;
    job_id: string;
    scheduled_for: Date | string;
    attempt: number;
    handler: string;
    requires_role: string | null;
    max_attempts: number;
}

export interface JobRunnerOptions extends FlowComponentOptions {
    handlers: JobHandlers;
    /**
     * Injectable clock for deterministic tests. Defaults to () => new Date().
     */
    now?: () => Date;
    /**
     * Returns true when this process holds the given role.
     * Wire this to roleManager.holds(role) in the app. JobRunner never imports
     * or references RoleManager directly.
     * Defaults to () => true (no role gating).
     */
    holdsRole?: (role: string) => boolean;
    /** Per-handler execution timeout in ms. Defaults to RUNNER_HANDLER_TIMEOUT_MS. */
    timeoutMs?: number;
    /** Maximum runs claimed per tick. Defaults to RUNNER_BATCH_SIZE. */
    batchSize?: number;
    /** Maximum backoff cap in ms. Defaults to RUNNER_BACKOFF_MAX_MS. */
    backoffMaxMs?: number;
    /** Tick interval in ms. Defaults to RUNNER_TICK_INTERVAL_MS. */
    tickIntervalMs?: number;
}

// ── JobRunner ─────────────────────────────────────────────────────────────────

/**
 * FlowComponent that claims pending sys_job_run rows, executes their handlers,
 * and records the outcome with retry and dead-letter semantics.
 */
export class JobRunner extends FlowComponent {
    @Inject private readonly _dataSource: DataSource;
    private get _knex(): Knex {
        return this._dataSource.knex;
    }
    private readonly _handlers: JobHandlers;
    private readonly _now: () => Date;
    private readonly _holdsRole: (role: string) => boolean;
    private readonly _timeoutMs: number;
    private readonly _batchSize: number;
    private readonly _backoffMaxMs: number;
    private readonly _tickIntervalMs: number;
    private _timer: ReturnType<typeof setInterval> | undefined;

    constructor(options: JobRunnerOptions) {
        super(options);

        this._handlers = options.handlers;
        this._now = options.now ?? (() => new Date());
        this._holdsRole = options.holdsRole ?? (() => true);
        this._timeoutMs = options.timeoutMs ?? RUNNER_HANDLER_TIMEOUT_MS;
        this._batchSize = options.batchSize ?? RUNNER_BATCH_SIZE;
        this._backoffMaxMs = options.backoffMaxMs ?? RUNNER_BACKOFF_MAX_MS;
        this._tickIntervalMs = options.tickIntervalMs ?? RUNNER_TICK_INTERVAL_MS;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    protected override async onInit(): Promise<void> {
        // Run one tick immediately so the runner acts without waiting for the
        // first interval.
        await this._tick();

        this._timer = setInterval(() => {
            const tickPromise = this._tick();
            tickPromise.catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                log.error("tick-failed", "Job runner tick failed", { error: msg });
            });
        }, this._tickIntervalMs);
    }

    protected override async onDispose(): Promise<void> {
        if (this._timer !== undefined) {
            clearInterval(this._timer);
            this._timer = undefined;
        }
    }

    // ── Tick ──────────────────────────────────────────────────────────────────

    /**
     * One runner tick. Exposed for direct invocation in tests (without going
     * through onInit and starting the background timer).
     */
    async _tick(): Promise<void> {
        const now = this._now();
        const claimed = await this._claim(now);

        for (const run of claimed) {
            await this._execute(run, now);
        }
    }

    // ── Claim ─────────────────────────────────────────────────────────────────

    /**
     * Select and claim pending runs in one transaction.
     *
     * On Postgres: FOR UPDATE SKIP LOCKED ensures concurrent runners never
     * double-claim. On SQLite: serialised writers make a plain SELECT safe.
     *
     * The handler and role filters are part of the query, so a run this
     * process cannot resolve, or whose role it does not hold, never takes a
     * slot in the batch or a row lock. It stays pending for the process that
     * can run it, and it never starves the runs this process can.
     */
    private async _claim(now: Date): Promise<ClaimCandidate[]> {
        const isPg = _isPgClient(this._knex);
        const runnerId = _runnerId();
        const claimed: ClaimCandidate[] = [];

        await this._knex.transaction(async (trx) => {
            const heldRoles = await this._heldRoles(trx);
            let query = trx("sys_job_run as r")
                .join("sys_job as j", "r.job_id", "j.id")
                .select<ClaimCandidate[]>(
                    "r.id as run_id",
                    "r.job_id",
                    "r.scheduled_for",
                    "r.attempt",
                    "j.handler",
                    "j.requires_role",
                    "j.max_attempts",
                )
                .where("r.status", "pending")
                .where("r.scheduled_for", "<=", now)
                .where((q) => {
                    q.where("j.handler", "like", "module://%").orWhereIn(
                        "j.handler",
                        this._handlers.ids(),
                    );
                })
                .where((q) => {
                    q.whereNull("j.requires_role").orWhereIn("j.requires_role", heldRoles);
                })
                .orderBy("r.scheduled_for", "asc")
                .limit(this._batchSize);

            if (isPg) {
                query = query.forUpdate("r").skipLocked();
            }

            const candidates = await query;
            if (candidates.length === 0) {
                return;
            }

            await trx("sys_job_run")
                .whereIn(
                    "id",
                    candidates.map((candidate) => candidate.run_id),
                )
                .update({
                    status: "running",
                    claimed_by: runnerId,
                    started_at: now,
                });
            claimed.push(...candidates);
        });

        return claimed;
    }

    /**
     * The roles named by any job that this process currently holds. Read from
     * sys_job (one row per job, not per run) so the claim query can filter on
     * them in SQL.
     */
    private async _heldRoles(trx: Knex.Transaction): Promise<string[]> {
        const rows: { requires_role: string }[] = await trx("sys_job")
            .distinct("requires_role")
            .whereNotNull("requires_role");
        return rows.map((row) => row.requires_role).filter((role) => this._holdsRole(role));
    }

    // ── Execute ───────────────────────────────────────────────────────────────

    /**
     * Execute one claimed run.
     *
     * Resolves the handler reference, runs it under a timeout guard, and records
     * the outcome.
     *
     * Transaction scope depends on the handler KIND, because the two kinds have
     * opposite needs and a `module://` handler holding an idle outer transaction
     * is what wedged the durable scheduler on staging (TRN-403):
     *
     *   - In-process registered handler (reaper, pruner): wrapped in a fresh
     *     handler-scoped transaction. These do short, purely-local DB bookkeeping
     *     and rely on `ctx.trx` for atomicity (mark + re-enqueue must commit
     *     together). Unchanged behaviour.
     *
     *   - `module://` handler (the Switchyard Clock dispatcher): run with NO outer
     *     transaction — `ctx.trx` is the bare knex handle. A module handler is a
     *     process-boundary handler that owns its OWN persistence through a
     *     separate store and may make a multi-second network call mid-run. Holding
     *     a pooled connection idle across that work starves the small per-process
     *     pool: the handler then cannot acquire the further connections it needs to
     *     finish, so it never returns and is killed at the 30s timeout. Not holding
     *     one keeps the pool free. The JobContext doc already scopes `trx` to a
     *     handler's "own book-keeping"; a module handler has none here.
     */
    private async _execute(run: ClaimCandidate, claimedAt: Date): Promise<void> {
        let handler: ResolvedHandler;

        try {
            handler = await this._resolveHandler(run.handler);
        } catch (resolveErr) {
            const errorMsg = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
            await this._recordFailure(run, claimedAt, errorMsg);
            return;
        }

        const handlerError = handler.isModuleRef
            ? await this._runWithoutTransaction(run, handler)
            : await this._runInTransaction(run, handler);

        const finishedAt = this._now();

        if (handlerError === undefined) {
            await this._recordSuccess(run, finishedAt);
        } else {
            await this._recordFailure(run, finishedAt, handlerError);
        }
    }

    /**
     * Run a `module://` handler with the bare knex handle as `ctx.trx` (no outer
     * transaction held). Returns the error message on failure/timeout, or
     * undefined on success.
     */
    private async _runWithoutTransaction(
        run: ClaimCandidate,
        handler: ResolvedHandler,
    ): Promise<string | undefined> {
        const ctx: JobContext = {
            knex: this._knex,
            trx: this._knex as unknown as Knex.Transaction,
            sec: systemSec,
            tenantId: null,
        };
        return this._raceHandler(run, handler, ctx);
    }

    /**
     * Run an in-process handler inside a fresh handler-scoped transaction. The
     * transaction commits on success and rolls back on failure/timeout, so the
     * handler's own DB bookkeeping is atomic while the run-status update (a
     * separate transaction) is not rolled back with it. Returns the error message
     * on failure/timeout, or undefined on success.
     */
    private async _runInTransaction(
        run: ClaimCandidate,
        handler: ResolvedHandler,
    ): Promise<string | undefined> {
        let handlerError: string | undefined;
        try {
            await this._knex.transaction(async (handlerTrx) => {
                const ctx: JobContext = {
                    knex: this._knex,
                    trx: handlerTrx,
                    sec: systemSec,
                    tenantId: null,
                };
                const err = await this._raceHandler(run, handler, ctx);
                if (err !== undefined) {
                    // Throw so knex rolls the handler-scoped transaction back; the
                    // message is recovered below and folded into the run outcome.
                    throw new Error(err);
                }
            });
        } catch (err) {
            handlerError = err instanceof Error ? err.message : String(err);
        }
        return handlerError;
    }

    /**
     * Run the handler against `ctx`, racing it against the per-handler timeout.
     * Returns the error message on failure/timeout, or undefined on success.
     */
    private async _raceHandler(
        run: ClaimCandidate,
        handler: ResolvedHandler,
        ctx: JobContext,
    ): Promise<string | undefined> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                reject(
                    new Error(
                        `JobRunner: handler "${run.handler}" timed out after ${this._timeoutMs}ms`,
                    ),
                );
            }, this._timeoutMs);
        });
        try {
            await Promise.race([handler.fn(ctx, handler.args), timeoutPromise]);
            return undefined;
        } catch (err) {
            return err instanceof Error ? err.message : String(err);
        } finally {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        }
    }

    // ── Handler resolution ────────────────────────────────────────────────────

    /**
     * Resolve the handler string to a callable + args + kind triple.
     *
     * If the string starts with `module://` it is forwarded to resolveModuleRef
     * and flagged `isModuleRef` (so `_execute` runs it WITHOUT an outer
     * transaction — see its doc). Otherwise it is treated as an in-process
     * registered id and looked up in the handler registry. Throws a descriptive
     * error if neither resolves.
     */
    private async _resolveHandler(handlerRef: string): Promise<ResolvedHandler> {
        if (handlerRef.startsWith("module://")) {
            const resolved = await resolveModuleRef(handlerRef);
            return {
                fn: resolved.fn as JobHandler,
                args: resolved.args,
                isModuleRef: true,
            };
        }

        const registered = this._handlers.lookup(handlerRef);
        if (registered === undefined) {
            throw new Error(
                `JobRunner: no handler registered for "${handlerRef}". ` +
                    `Register one via handlers.registerJob("${handlerRef}", fn) ` +
                    `or use a module:// URI.`,
            );
        }

        return { fn: registered, args: {}, isModuleRef: false };
    }

    // ── Outcome recording ─────────────────────────────────────────────────────

    private async _recordSuccess(run: ClaimCandidate, finishedAt: Date): Promise<void> {
        await this._knex("sys_job_run").where({ id: run.run_id }).update({
            status: "succeeded",
            finished_at: finishedAt,
            error: null,
        });
    }

    /**
     * Record a handler failure.
     *
     * If the run has remaining attempts: mark it `failed` and insert a new
     * retry run with capped exponential backoff.
     * If this was the final attempt: mark it `dead`.
     *
     * The retry insert is idempotent on the UNIQUE (job_id, scheduled_for,
     * attempt) key: when several runs of the SAME attempt fail in the same
     * backoff window they compute an identical retry slot, so the second insert
     * collides. That collision means "the retry already exists" — a harmless
     * no-op, exactly as the JobScheduler treats a racing fire — so it is caught
     * and swallowed inside the same transaction (the status update still
     * commits). Letting it throw here would (a) leave THIS run stuck `running`
     * and (b) abort the whole runner tick, abandoning sibling claimed runs.
     */
    private async _recordFailure(
        run: ClaimCandidate,
        finishedAt: Date,
        error: string,
    ): Promise<void> {
        const hasRetry = run.attempt < run.max_attempts;

        await this._knex.transaction(async (trx) => {
            await trx("sys_job_run")
                .where({ id: run.run_id })
                .update({
                    status: hasRetry ? "failed" : "dead",
                    finished_at: finishedAt,
                    error,
                });

            if (!hasRetry) {
                return;
            }

            const backoffMs = _computeBackoff(
                run.attempt,
                RUNNER_BACKOFF_BASE_MS,
                this._backoffMaxMs,
            );
            // scheduled_for for the retry run is the retry-eligible time,
            // not the original scheduled_for. The runner's claim scan uses
            // scheduled_for <= now to gate eligibility.
            const retryAt = new Date(finishedAt.getTime() + backoffMs);

            // Insert-if-absent on the UNIQUE (job_id, scheduled_for, attempt)
            // key: a concurrent sibling that already queued this exact retry slot
            // makes this a no-op rather than a unique-violation that aborts the
            // tick. onConflict().ignore() is portable across the pg and SQLite
            // backends the worker runs on.
            await trx("sys_job_run")
                .insert({
                    id: crypto.randomUUID(),
                    job_id: run.job_id,
                    scheduled_for: retryAt,
                    status: "pending",
                    attempt: run.attempt + 1,
                    claimed_by: null,
                    started_at: null,
                    finished_at: null,
                    error: null,
                })
                .onConflict(["job_id", "scheduled_for", "attempt"])
                .ignore();
        });
    }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Detect whether the Knex instance is connected to Postgres.
 * Mirrors the isPg check used in JobScheduler and migration 003.
 */
function _isPgClient(knex: Knex): boolean {
    const client = (knex.client as { config: { client: string } }).config.client;
    return client === "pg" || client === "postgresql";
}

/**
 * Capped exponential backoff.
 *
 * attempt 1 → base * 2^0 = base
 * attempt 2 → base * 2^1 = 2*base
 * …
 * capped at maxMs.
 */
function _computeBackoff(attempt: number, baseMs: number, maxMs: number): number {
    const raw = baseMs * 2 ** (attempt - 1);
    return Math.min(raw, maxMs);
}

/** Normalise a date value that may arrive as a string from SQLite. */
function _toDate(value: Date | string): Date {
    if (value instanceof Date) {
        return value;
    }
    return new Date(value);
}

/**
 * Stable runner identifier for the `claimed_by` column.
 *
 * Built once per module load (i.e. once per process). Using the process PID
 * + a fixed startup timestamp keeps it unique across restarts without requiring
 * a DB round trip.
 */
const _RUNNER_ID = `runner-${process.pid}-${Date.now()}`;

function _runnerId(): string {
    return _RUNNER_ID;
}
