/**
 * The push placement rule: where a changed row lands on a page someone is
 * looking at.
 *
 * A subscriber holds one page, not the list. When a row changes, the page
 * either takes it at its sorted position, keeps its rows and moves only its
 * total, ignores it, or cannot tell and has to be read again. The server and
 * the browser run the same function on the same page, so they agree without
 * the server remembering what it sent.
 */
import { fingerprintOf, fnv1a } from "./fingerprint.js";
import { applyListQuery, compareListRows, listKeyOf, matchesListQuery } from "./query.js";
import type {
    ListChange,
    ListFrame,
    ListPlacement,
    ListQuery,
    ListRow,
    ListSchema,
    ListState,
    ListWindow,
} from "./types.js";

const DROPPED = { kind: "dropped" } as const;
const STALE = { kind: "stale" } as const;

function sameRow(a: ListRow, b: ListRow): boolean {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) {
        return false;
    }
    return keys.every((key) => a[key] === b[key]);
}

/** Every row added, removed or altered between two reads, ordered by key. */
export function diffListRows<T extends ListRow>(
    before: readonly T[],
    after: readonly T[],
    schema: ListSchema,
): ListChange<T>[] {
    const prior = new Map(before.map((row) => [listKeyOf(row, schema), row]));
    const changes: ListChange<T>[] = [];
    for (const row of after) {
        const key = listKeyOf(row, schema);
        const was = prior.get(key) ?? null;
        prior.delete(key);
        if (was === null || !sameRow(was, row)) {
            changes.push({ key, before: was, after: row });
        }
    }
    for (const [key, was] of prior) {
        changes.push({ key, before: was, after: null });
    }
    return changes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * A fingerprint of the rows a query admits. It moves only when something the
 * subscriber could see changes, so two processes reading the same data agree
 * on it, and a change outside the filter leaves it alone.
 */
export function listVersion(
    rows: readonly ListRow[],
    query: ListQuery,
    schema: ListSchema,
): string {
    const selected = rows
        .filter((row) => matchesListQuery(row, query, schema))
        .map((row) => `${listKeyOf(row, schema)}\x1f${JSON.stringify(row)}`)
        .sort();
    let hash = fnv1a("");
    for (const entry of selected) {
        hash = fnv1a(entry, hash);
    }
    return `${selected.length}.${hash.toString(36)}`;
}

/** The first position on the page the row sorts before, or the page's length. */
function insertionIndex(
    rows: readonly ListRow[],
    row: ListRow,
    query: ListQuery,
    schema: ListSchema,
): number {
    const at = rows.findIndex((held) => compareListRows(row, held, query, schema) < 0);
    return at === -1 ? rows.length : at;
}

/**
 * Where one change lands on a page.
 *
 * The page knows its own rows and nothing either side of them, which decides
 * every case:
 *
 * - a row entering or leaving above the page shifts which rows the page
 *   holds, so the page is stale unless it is the first one;
 * - a row leaving the page leaves a gap the next row below would fill, so the
 *   page is stale unless nothing lies below or the row moves back in;
 * - a row entering below a full page moves only the total.
 */
export function placeListChange<T extends ListRow>(
    window: ListWindow<T>,
    change: ListChange<T>,
    query: ListQuery,
    schema: ListSchema,
): ListPlacement<T> {
    const wasIn = change.before !== null && matchesListQuery(change.before, query, schema);
    const isIn = change.after !== null && matchesListQuery(change.after, query, schema);
    if (!wasIn && !isIn) {
        return DROPPED;
    }

    const { offset, limit } = window;
    const rows = [...window.rows];
    let total = window.total;
    let gap = false;

    if (wasIn && change.before !== null) {
        const at = rows.findIndex((row) => listKeyOf(row, schema) === change.key);
        if (at >= 0) {
            rows.splice(at, 1);
            total -= 1;
            gap = offset + rows.length < total;
        } else if (
            window.rows.length === 0 ||
            compareListRows(change.before, window.rows[0], query, schema) < 0
        ) {
            return STALE;
        } else {
            total -= 1;
        }
    }

    if (isIn && change.after !== null) {
        if (offset > 0 && rows.length === 0) {
            return STALE;
        }
        const at = insertionIndex(rows, change.after, query, schema);
        if (at === 0 && offset > 0) {
            return STALE;
        }
        if (at < rows.length || (rows.length < limit && !gap)) {
            rows.splice(at, 0, change.after);
            total += 1;
            gap = false;
            if (rows.length > limit) {
                rows.pop();
            }
        } else {
            total += 1;
        }
    }

    if (gap) {
        return STALE;
    }
    return { kind: "placed", window: { rows, total, offset, limit } };
}

/** A frame that replaces the subscriber's page with a fresh read. */
export function listWindowFrame<T extends ListRow>(
    rows: readonly T[],
    query: ListQuery,
    schema: ListSchema,
): ListFrame<T> {
    return {
        type: "window",
        version: listVersion(rows, query, schema),
        window: applyListQuery(rows, query, schema),
    };
}

/**
 * What one subscriber should be sent after the list moved from `before` to
 * `after`, or null when nothing it can see changed.
 *
 * Sends the changes when every one of them places onto the subscriber's page,
 * and a fresh page as soon as one does not.
 */
export function planListPush<T extends ListRow>(
    before: readonly T[],
    after: readonly T[],
    query: ListQuery,
    schema: ListSchema,
): ListFrame<T> | null {
    const from = listVersion(before, query, schema);
    const to = listVersion(after, query, schema);
    if (from === to) {
        return null;
    }
    let window = applyListQuery(before, query, schema);
    const placed: ListChange<T>[] = [];
    for (const change of diffListRows(before, after, schema)) {
        const placement = placeListChange(window, change, query, schema);
        if (placement.kind === "stale") {
            return listWindowFrame(after, query, schema);
        }
        if (placement.kind === "placed") {
            window = placement.window;
            placed.push(change);
        }
    }
    return { type: "changes", from, to, changes: placed };
}

/**
 * Apply a frame to the page a subscriber holds.
 *
 * Returns the new state, the same state for a frame already applied (two
 * processes can each push one change), or null when the page has fallen out of
 * step and must be read again.
 */
export function applyListFrame<T extends ListRow>(
    state: ListState<T> | null,
    frame: ListFrame<T>,
    query: ListQuery,
    schema: ListSchema,
): ListState<T> | null {
    if (frame.type === "window") {
        return { version: frame.version, window: frame.window };
    }
    if (state === null) {
        return null;
    }
    if (state.version === frame.to) {
        return state;
    }
    if (state.version !== frame.from) {
        return null;
    }
    let window = state.window;
    for (const change of frame.changes) {
        const placement = placeListChange(window, change, query, schema);
        if (placement.kind === "stale") {
            return null;
        }
        if (placement.kind === "placed") {
            window = placement.window;
        }
    }
    return { version: frame.to, window };
}

/**
 * The frame for a page read straight from a store, which answers the page and
 * its total but not the whole list. Its version fingerprints exactly that, so
 * a server re-reading the page sends it again only when the version moved.
 */
export function listPageFrame<T extends ListRow>(
    window: ListWindow<T>,
): Extract<ListFrame<T>, { type: "window" }> {
    return { type: "window", version: fingerprintOf(window), window };
}
