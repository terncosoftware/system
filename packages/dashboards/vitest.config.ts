import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const pkg = (name: string): string => path.resolve(__dirname, `../${name}/src`);

export default defineConfig({
    plugins: [react()],
    test: {
        globals: true,
        environment: "node",
        include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    },
    resolve: {
        alias: {
            "@terncosoftware/core/list": path.join(pkg("core"), "list"),
            "@terncosoftware/core/topics": path.join(pkg("core"), "topics"),
            "@terncosoftware/core-ui": pkg("core-ui"),
        },
    },
});
