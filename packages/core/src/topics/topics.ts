import { fingerprintOf } from "../list/fingerprint.js";
import { normalizeListQuery } from "../list/query.js";
import type {
    FeedFrame,
    FeedSchema,
    SnapshotFrame,
    TopicChanged,
    TopicDefinition,
    TopicParamSpec,
    TopicParams,
    TopicRead,
} from "./types.js";

/** The bus event a write publishes when it may change what a topic shows. */
export const TOPIC_CHANGED = "core.topic.changed";

/** Longest param value accepted. Params are ids, ranges and zones, never free text. */
export const MAX_TOPIC_PARAM_LENGTH = 512;

const TOPIC_NAME = /^[a-z0-9-]+:[a-z0-9-]+$/;
const PARAM_NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;

/** Search keys an HTTP read keeps for itself, so no param may take them. */
const READ_KEYS = new Set(["q", "after", "format"]);

/** Check a definition's name and params once, where it is declared. */
export function defineTopic<D extends TopicDefinition<never, never>>(definition: D): D {
    if (!TOPIC_NAME.test(definition.name)) {
        throw new Error(`Topic "${definition.name}" must be named <provider>:<name>`);
    }
    for (const param of Object.keys(definition.params)) {
        if (!PARAM_NAME.test(param) || READ_KEYS.has(param)) {
            throw new Error(`Topic "${definition.name}" cannot take a param named "${param}"`);
        }
    }
    return definition;
}

/**
 * Keep only the params a topic names, as strings of a sane length. Null when
 * a required one is missing, so the caller refuses rather than guesses.
 */
export function normalizeTopicParams(input: unknown, spec: TopicParamSpec): TopicParams | null {
    const raw =
        typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
    const params: Record<string, string> = {};
    for (const [name, need] of Object.entries(spec)) {
        const value = raw[name];
        if (typeof value === "string" && value !== "" && value.length <= MAX_TOPIC_PARAM_LENGTH) {
            params[name] = value;
        } else if (need === "required") {
            return null;
        }
    }
    return params;
}

/** One string per topic address, the same whatever order the params arrived in. */
export function topicAddress(topic: string, params: TopicParams): string {
    const sorted = Object.keys(params)
        .sort()
        .map((name) => [name, params[name]]);
    return `${topic}?${JSON.stringify(sorted)}`;
}

/** Whether a change event reaches a subscription at this tenant and these params. */
export function topicChangeReaches(
    change: TopicChanged,
    topic: string,
    tenantId: string | null,
    params: TopicParams,
): boolean {
    if (change.topic !== topic || change.tenantId !== tenantId) {
        return false;
    }
    return Object.entries(change.params).every(([name, value]) => params[name] === value);
}

export function snapshotFrame<T>(value: T): SnapshotFrame<T> {
    return { type: "snapshot", version: fingerprintOf(value), value };
}

/**
 * The items a reader holds after a feed frame: newest first, each key once,
 * at most `schema.maxItems`. When an item arrives twice, as it can when two
 * servers push the same one, the newer copy wins.
 */
export function applyFeedFrame<T>(
    held: readonly T[],
    frame: FeedFrame<T>,
    schema: FeedSchema,
): T[] {
    const incoming = frame.reset ? frame.items : [...frame.items, ...held];
    const seen = new Set<string>();
    const items: T[] = [];
    for (const item of incoming) {
        const key = String((item as Record<string, unknown>)[schema.key] ?? "");
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        items.push(item);
        if (items.length >= schema.maxItems) {
            break;
        }
    }
    return items;
}

/** The search string for an HTTP read. Each param is its own key; a list's query travels as JSON in `q`. */
export function topicReadSearch(read: TopicRead): URLSearchParams {
    const search = new URLSearchParams();
    for (const name of Object.keys(read.params).sort()) {
        search.set(name, read.params[name] ?? "");
    }
    if (read.query !== null) {
        search.set("q", JSON.stringify(read.query));
    }
    if (read.after !== null) {
        search.set("after", read.after);
    }
    return search;
}

/**
 * Parse an HTTP read for one topic. Null when a required param is missing.
 * The query is normalized against the topic's schema, so a list read only
 * ever sorts and filters on fields the topic offers.
 */
export function parseTopicRead(
    search: URLSearchParams,
    definition: TopicDefinition<never, never>,
): TopicRead | null {
    const params = normalizeTopicParams(Object.fromEntries(search), definition.params);
    if (params === null) {
        return null;
    }
    let query = null;
    if (definition.kind === "list") {
        let raw: unknown = null;
        try {
            raw = JSON.parse(search.get("q") ?? "null");
        } catch {
            raw = null;
        }
        query = normalizeListQuery(raw, definition.schema);
    }
    const after = definition.kind === "feed" ? (search.get("after") ?? null) : null;
    return { params, query, after };
}
