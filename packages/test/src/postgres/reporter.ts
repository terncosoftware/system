/**
 * Reports how many Postgres-leg tests ran, so a run cannot pass on SQLite alone
 * without saying so.
 *
 * A Postgres leg is any test whose suite title contains "Postgres": every
 * dual-engine suite names its Postgres provider that way, and Postgres-only
 * suites say "real Postgres" in their title. CI requires the summary line to
 * show at least one passed test.
 */

import type { Reporter, TestModule, Vitest } from "vitest/node";

export default class PostgresLegReporter implements Reporter {
    private _vitest: Vitest | null = null;

    onInit(vitest: Vitest): void {
        this._vitest = vitest;
    }

    onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
        const logger = this._vitest?.logger;
        if (logger === undefined) {
            return;
        }
        if (!process.env.SYS_PG_URL) {
            logger.warn(
                "\nPostgres legs SKIPPED: SYS_PG_URL is not set, so only the SQLite legs ran. " +
                    "Set it to a Postgres URL to run them.\n",
            );
            return;
        }

        const counts = { passed: 0, failed: 0, skipped: 0 };
        const files = new Set<string>();
        for (const testModule of testModules) {
            for (const test of testModule.children.allTests()) {
                if (!test.fullName.includes("Postgres")) {
                    continue;
                }
                const state = test.result().state;
                if (state === "passed") {
                    counts.passed++;
                } else if (state === "failed") {
                    counts.failed++;
                } else {
                    counts.skipped++;
                }
                files.add(testModule.moduleId);
            }
        }
        logger.log(
            `\nPostgres legs: ${counts.passed} passed, ${counts.failed} failed, ` +
                `${counts.skipped} skipped across ${files.size} files\n`,
        );
    }
}
