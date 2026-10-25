/**
 * TRN-157: Integration tests for JobRunner + JobHandlers.
 *
 * Uses SQLite in-memory (via createDataContext) — real DB, real schema,
 * no mocks. Tests drive _tick() directly without going through onInit so
 * no background setInterval fires during tests.
 *
 * Covers:
 *   - Happy path: registered handler runs → row goes pending→running→succeeded.
 *   - Throwing handler retries with backoff; final attempt → dead.
 *   - module:// handler resolves and runs with parsed query args.
 *   - Two runners over shared pending runs → each run executed exactly once.
 *   - requires_role gating: run stays pending when this runner does not hold
 *     the required role.
 *   - Handler timeout marks the run failed/retried.
 *   - A run whose handler this process did not register stays pending.
 *
 * No arbitrary setTimeout sleeps. The injectable clock (ManualClock) is
 * advanced to make backoff timing deterministic; _tick() is invoked directly.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { _clearModuleRefCache, bindService } from "@terncosoftware/core";
import { createDataContext, DataSource } from "@terncosoftware/data";
import { FlowContext } from "@terncosoftware/flow";
import { JobHandlers, JobRunner } from "@terncosoftware/worker";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invocations } from "./fixtures/noop-handler.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

class ManualClock {
    private _ms: number;

    constructor(initial: Date = new Date()) {
        this._ms = initial.getTime();
    }

    now(): Date {
        return new Date(this._ms);
    }

    advance(ms: number): void {
        this._ms += ms;
    }

    set(date: Date): void {
        this._ms = date.getTime();
    }
}

function makeFlowContext(): FlowContext {
    return new FlowContext();
}

function makeRunner(
    knex: Knex,
    handlers: JobHandlers,
    clock: ManualClock,
    opts?: {
        holdsRole?: (role: string) => boolean;
        timeoutMs?: number;
        batchSize?: number;
        backoffMaxMs?: number;
    },
): JobRunner {
    return new JobRunner({
        context: makeFlowContext(),
        handlers,
        now: () => clock.now(),
        holdsRole: opts?.holdsRole,
        timeoutMs: opts?.timeoutMs,
        batchSize: opts?.batchSize,
        backoffMaxMs: opts?.backoffMaxMs,
        // Use a very long tick interval so the background timer never fires.
        tickIntervalMs: 1_000_000,
    });
}

/**
 * Drive one tick on the runner without going through onInit
 * (which would start the background interval).
 */
async function runTick(runner: JobRunner): Promise<void> {
    await (runner as unknown as { _tick(): Promise<void> })._tick();
}

/**
 * Insert a sys_job row and a pending sys_job_run for it.
 * Returns the run id.
 */
async function insertPendingRun(
    knex: Knex,
    opts: {
        jobId: string;
        handler: string;
        scheduledFor: Date;
        attempt?: number;
        maxAttempts?: number;
        requiresRole?: string | null;
    },
): Promise<string> {
    const {
        jobId,
        handler,
        scheduledFor,
        attempt = 1,
        maxAttempts = 3,
        requiresRole = null,
    } = opts;

    // Upsert the sys_job row so tests that create multiple runs for the same
    // job don't fail on the primary key constraint.
    const existing = await knex("sys_job").where({ id: jobId }).first();
    if (existing == null) {
        await knex("sys_job").insert({
            id: jobId,
            schedule: JSON.stringify({ every: "PT30S" }),
            handler,
            requires_role: requiresRole,
            enabled: true,
            next_run_at: new Date(scheduledFor.getTime() + 30_000),
            max_attempts: maxAttempts,
            meta: null,
        });
    }

    const runId = crypto.randomUUID();
    await knex("sys_job_run").insert({
        id: runId,
        job_id: jobId,
        scheduled_for: scheduledFor,
        status: "pending",
        attempt,
        claimed_by: null,
        started_at: null,
        finished_at: null,
        error: null,
    });

    return runId;
}

async function getRunById(knex: Knex, runId: string) {
    return knex("sys_job_run").where({ id: runId }).first();
}

async function getAllRunsForJob(knex: Knex, jobId: string) {
    return knex("sys_job_run").where({ job_id: jobId }).orderBy("attempt", "asc").select("*");
}

const FIXTURE_DIR = resolve(new URL(import.meta.url).pathname, "../fixtures");

function fixtureUri(filename: string, member?: string, query?: string): string {
    const fileUrl = pathToFileURL(resolve(FIXTURE_DIR, filename)).href;
    let uri = `module://${fileUrl}`;
    if (member !== undefined) {
        uri += `#${member}`;
    }
    if (query !== undefined) {
        uri += `?${query}`;
    }
    return uri;
}

// ── Test constants ────────────────────────────────────────────────────────────

const NOW = new Date("2026-06-01T12:00:00.000Z");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("JobRunner — SQLite (in-memory)", () => {
    let knex: Knex;
    let clock: ManualClock;
    let handlers: JobHandlers;

    beforeEach(async () => {
        knex = await createDataContext({ client: "sqlite", filename: ":memory:" });
        bindService(DataSource, new DataSource(knex));
        clock = new ManualClock(NOW);
        handlers = new JobHandlers();
        // Reset the module-level fixture invocation log.
        invocations.length = 0;
        _clearModuleRefCache();
    });

    afterEach(async () => {
        await knex.destroy();
    });

    // ── Happy path ─────────────────────────────────────────────────────────────

    it("runs a registered handler and marks the run succeeded", async () => {
        let handlerCalled = false;

        handlers.registerJob("test.happy", async (_ctx, _args) => {
            handlerCalled = true;
        });

        const scheduledFor = new Date(NOW.getTime() - 1_000);
        const runId = await insertPendingRun(knex, {
            jobId: "job.happy",
            handler: "test.happy",
            scheduledFor,
        });

        const runner = makeRunner(knex, handlers, clock);
        await runTick(runner);

        const row = await getRunById(knex, runId);
        expect(handlerCalled).toBe(true);
        expect(row.status).toBe("succeeded");
        expect(row.started_at).not.toBeNull();
        expect(row.finished_at).not.toBeNull();
        expect(row.error).toBeNull();
    });

    // ── Retry with backoff → dead on final attempt ─────────────────────────────

    it("retries a throwing handler up to max_attempts then marks it dead", async () => {
        handlers.registerJob("test.throw", async (_ctx, _args) => {
            throw new Error("boom");
        });

        const scheduledFor = new Date(NOW.getTime() - 1_000);
        await insertPendingRun(knex, {
            jobId: "job.throw",
            handler: "test.throw",
            scheduledFor,
            attempt: 1,
            maxAttempts: 3,
        });

        const runner = makeRunner(knex, handlers, clock, {
            // Use a tiny backoff so advancing the clock is easy.
            backoffMaxMs: 1_000,
        });

        // Attempt 1 — should fail and insert attempt 2 retry.
        await runTick(runner);

        const runsAfter1 = await getAllRunsForJob(knex, "job.throw");
        expect(runsAfter1).toHaveLength(2);
        expect(runsAfter1[0].attempt).toBe(1);
        expect(runsAfter1[0].status).toBe("failed");
        expect(runsAfter1[0].error).toContain("boom");
        expect(runsAfter1[1].attempt).toBe(2);
        expect(runsAfter1[1].status).toBe("pending");

        // Advance clock past the backoff so attempt 2 becomes eligible.
        clock.advance(10_000);
        await runTick(runner);

        const runsAfter2 = await getAllRunsForJob(knex, "job.throw");
        expect(runsAfter2).toHaveLength(3);
        expect(runsAfter2[1].status).toBe("failed");
        expect(runsAfter2[2].attempt).toBe(3);
        expect(runsAfter2[2].status).toBe("pending");

        // Advance clock again for attempt 3.
        clock.advance(10_000);
        await runTick(runner);

        const runsAfter3 = await getAllRunsForJob(knex, "job.throw");
        // No new row — this was the final attempt.
        expect(runsAfter3).toHaveLength(3);
        expect(runsAfter3[2].status).toBe("dead");
        expect(runsAfter3[2].error).toContain("boom");
    });

    // ── module:// handler resolves and receives args ───────────────────────────

    it("resolves a module:// handler and passes parsed query args", async () => {
        const handlerUri = fixtureUri("noop-handler.ts", "handleNoopJob", "scope=active&dry=true");

        const scheduledFor = new Date(NOW.getTime() - 1_000);
        const runId = await insertPendingRun(knex, {
            jobId: "job.modref",
            handler: handlerUri,
            scheduledFor,
        });

        const runner = makeRunner(knex, handlers, clock);
        await runTick(runner);

        const row = await getRunById(knex, runId);
        expect(row.status).toBe("succeeded");

        expect(invocations).toHaveLength(1);
        expect(invocations[0].args).toEqual({ scope: "active", dry: "true" });
    });

    // ── Two runners — no double execution ─────────────────────────────────────

    it("two runners over several pending runs execute each run exactly once", async () => {
        let executionCount = 0;

        handlers.registerJob("test.counter", async (_ctx, _args) => {
            executionCount++;
        });

        const scheduledFor = new Date(NOW.getTime() - 1_000);

        // Insert 4 pending runs.
        for (let i = 0; i < 4; i++) {
            await insertPendingRun(knex, {
                jobId: `job.counter.${i}`,
                handler: "test.counter",
                scheduledFor,
            });
        }

        const runner1 = makeRunner(knex, handlers, clock);
        const runner2 = makeRunner(knex, handlers, clock);

        // Run both ticks. SQLite serialises writers so one runner claims each
        // row first; the other sees them already claimed (running) and skips.
        await Promise.all([runTick(runner1), runTick(runner2)]);

        // Each run must have been executed exactly once.
        expect(executionCount).toBe(4);

        // Every run must be succeeded.
        const allRuns = await knex("sys_job_run").select("*");
        const succeeded = allRuns.filter((r: { status: string }) => r.status === "succeeded");
        expect(succeeded).toHaveLength(4);
    });

    // ── requires_role gating ───────────────────────────────────────────────────

    it("leaves a run pending when this runner does not hold the required role", async () => {
        handlers.registerJob("test.role-gated", async (_ctx, _args) => {
            // Should never be called.
            throw new Error("should not run — role not held");
        });

        const scheduledFor = new Date(NOW.getTime() - 1_000);
        const runId = await insertPendingRun(knex, {
            jobId: "job.role-gated",
            handler: "test.role-gated",
            scheduledFor,
            requiresRole: "labs.lifecycle",
        });

        // holdsRole always returns false — this runner does not hold any role.
        const runner = makeRunner(knex, handlers, clock, {
            holdsRole: () => false,
        });

        await runTick(runner);

        const row = await getRunById(knex, runId);
        expect(row.status).toBe("pending");
        expect(row.started_at).toBeNull();
    });

    it("claims and runs a run when the required role is held", async () => {
        let called = false;

        handlers.registerJob("test.role-held", async (_ctx, _args) => {
            called = true;
        });

        const scheduledFor = new Date(NOW.getTime() - 1_000);
        const runId = await insertPendingRun(knex, {
            jobId: "job.role-held",
            handler: "test.role-held",
            scheduledFor,
            requiresRole: "labs.lifecycle",
        });

        // holdsRole returns true for the specific role.
        const runner = makeRunner(knex, handlers, clock, {
            holdsRole: (role) => role === "labs.lifecycle",
        });

        await runTick(runner);

        const row = await getRunById(knex, runId);
        expect(row.status).toBe("succeeded");
        expect(called).toBe(true);
    });

    // ── Handler timeout ────────────────────────────────────────────────────────

    it("marks a timed-out handler failed and inserts a retry run", async () => {
        handlers.registerJob("test.timeout", async (_ctx, _args) => {
            // Simulate a wedged handler by returning a never-resolving promise.
            await new Promise<void>(() => {
                // intentionally never resolves
            });
        });

        const scheduledFor = new Date(NOW.getTime() - 1_000);
        const runId = await insertPendingRun(knex, {
            jobId: "job.timeout",
            handler: "test.timeout",
            scheduledFor,
            attempt: 1,
            maxAttempts: 2,
        });

        // Use a 1ms timeout so the test does not actually wait.
        const runner = makeRunner(knex, handlers, clock, { timeoutMs: 1 });
        await runTick(runner);

        const row = await getRunById(knex, runId);
        expect(row.status).toBe("failed");
        expect(row.error).toMatch(/timed out/i);

        // A retry run (attempt 2) should have been inserted.
        const allRuns = await getAllRunsForJob(knex, "job.timeout");
        expect(allRuns).toHaveLength(2);
        expect(allRuns[1].attempt).toBe(2);
        expect(allRuns[1].status).toBe("pending");
    });

    // ── Unregistered handler ───────────────────────────────────────────────────

    it("leaves a run pending when its handler id is not registered in this process", async () => {
        const scheduledFor = new Date(NOW.getTime() - 1_000);
        const runId = await insertPendingRun(knex, {
            jobId: "job.unregistered",
            handler: "not.registered",
            scheduledFor,
            attempt: 1,
            maxAttempts: 1,
        });

        // Another process may register this handler: this runner must not claim
        // the run, let alone fail it.
        const runner = makeRunner(knex, handlers, clock);
        await runTick(runner);

        const row = await getRunById(knex, runId);
        expect(row.status).toBe("pending");
        expect(row.claimed_by).toBeNull();
        expect(row.error).toBeNull();
    });

    // ── Run not yet due ────────────────────────────────────────────────────────

    it("does not claim a run whose scheduled_for is in the future", async () => {
        handlers.registerJob("test.future", async () => {
            throw new Error("should not run yet");
        });

        // scheduled_for is 60 seconds in the future.
        const scheduledFor = new Date(NOW.getTime() + 60_000);
        const runId = await insertPendingRun(knex, {
            jobId: "job.future",
            handler: "test.future",
            scheduledFor,
        });

        const runner = makeRunner(knex, handlers, clock);
        await runTick(runner);

        const row = await getRunById(knex, runId);
        expect(row.status).toBe("pending");
    });
});
