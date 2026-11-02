import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * This package is generic: it imports only system packages and the libraries
 * it declares, and names no product. Hosts plug products in from outside.
 */
const ROOT = path.resolve(__dirname);

const ALLOWED_IMPORTS = [
    /^\.{1,2}\//,
    /^@terncosoftware\/core\/list$/,
    /^@terncosoftware\/core\/topics$/,
    /^@terncosoftware\/core-ui$/,
    /^react$/,
    /^react\/jsx-runtime$/,
];

/** Test files may also use the test tooling. */
const ALLOWED_IN_TESTS = [/^vitest$/, /^@testing-library\//, /^node:/];

const PRODUCT_WORDS = /\b(ternco|tern|tubemail|mail|labs|scopes|switchyard|uptime)\b/i;

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        return statSync(full).isDirectory() ? files(full) : [full];
    });
}

const sources = files(ROOT).filter((file) => !file.endsWith("boundary.test.ts"));

describe("package boundary", () => {
    it("imports only system packages and declared libraries", () => {
        const offending: string[] = [];
        for (const file of sources.filter((name) => /\.(ts|tsx)$/.test(name))) {
            const test = /\.test\.tsx?$/.test(file);
            const text = readFileSync(file, "utf8");
            for (const match of text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
                const target = match[1];
                const allowed = [...ALLOWED_IMPORTS, ...(test ? ALLOWED_IN_TESTS : [])];
                if (!allowed.some((rule) => rule.test(target))) {
                    offending.push(`${path.relative(ROOT, file)}: ${target}`);
                }
            }
        }
        expect(offending).toEqual([]);
    });

    it("names no product", () => {
        const offending = sources
            .filter((file) => PRODUCT_WORDS.test(readFileSync(file, "utf8")))
            .map((file) => path.relative(ROOT, file));
        expect(offending).toEqual([]);
    });
});
