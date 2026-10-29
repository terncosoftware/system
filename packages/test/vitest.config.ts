import path from "node:path";
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

const workspaceRoot = path.resolve(__dirname, "../..");

const pkg = (name: string) => path.resolve(__dirname, `../${name}/src`);

// esbuild (vite's default transform) cannot emit emitDecoratorMetadata, so
// typescript-ioc @Inject field tokens resolve to `undefined` at runtime.
// Transform TS/TSX with SWC instead, which emits legacy-decorator metadata.
const swcPlugin = swc.vite({
    jsc: {
        transform: {
            legacyDecorator: true,
            decoratorMetadata: true,
        },
        keepClassNames: true,
    },
});

export default defineConfig({
    root: workspaceRoot,
    // unplugin-swc resolves a different vite copy than vitest's bundled vite, so
    // their Plugin types are nominally incompatible though runtime-compatible.
    // biome-ignore lint/suspicious/noExplicitAny: cross-vite-version Plugin type bridge
    plugins: [swcPlugin as any],
    test: {
        globals: true,
        environment: "node",
        include: ["packages/test/src/**/*.test.ts"],
        // Each worker gets its own Postgres database when SYS_PG_URL is set, and
        // the run ends with a count of the Postgres-leg tests that ran.
        globalSetup: [path.resolve(__dirname, "src/postgres/global-setup.ts")],
        setupFiles: [path.resolve(__dirname, "src/postgres/worker-setup.ts")],
        reporters: ["default", path.resolve(__dirname, "src/postgres/reporter.ts")],
        coverage: {
            provider: "v8",
            enabled: true,
            reportsDirectory: path.resolve(__dirname, "coverage/vitest"),
            reporter: ["text", "html", "lcov"],
            include: ["packages/*/src/**/*.ts"],
            exclude: [
                "**/*.d.ts",
                "**/node_modules/**",
                "**/dist/**",
                "**/gen/src/bin.ts",
                "**/sandbox-*/src/**",
            ],
        },
    },
    resolve: {
        alias: {
            // Primary package names
            "@terncosoftware/api": pkg("api"),
            "@terncosoftware/app": pkg("app"),
            "@terncosoftware/auth": pkg("auth"),
            "@terncosoftware/convos": pkg("convos"),
            "@terncosoftware/core": pkg("core"),
            "@terncosoftware/data": pkg("data"),
            "@terncosoftware/entities": pkg("entities"),
            "@terncosoftware/events": pkg("events"),
            "@terncosoftware/flow": pkg("flow"),
            "@terncosoftware/gen": pkg("gen"),
            "@terncosoftware/server": pkg("server"),
            "@terncosoftware/vaults": pkg("vaults"),
            "@terncosoftware/worker": pkg("worker"),
            // Legacy aliases used in config/codegen test fixtures
            "@system/api": pkg("api"),
            "@system/app": pkg("app"),
            "@system/auth": pkg("auth"),
            "@system/core": pkg("core"),
            "@system/data": pkg("data"),
            "@system/entities": pkg("entities"),
            "@system/flow": pkg("flow"),
            "@system/gen": pkg("gen"),
            "@system/server": pkg("server"),
            "@system/vaults": pkg("vaults"),
            "@system/worker": pkg("worker"),
        },
    },
});
