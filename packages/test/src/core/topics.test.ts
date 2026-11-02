import { type ListSchema, listPageFrame } from "@terncosoftware/core/list";
import {
    applyFeedFrame,
    defineTopic,
    type FeedSchema,
    normalizeTopicParams,
    parseTopicRead,
    snapshotFrame,
    TOPIC_CHANGED,
    topicAddress,
    topicChangeReaches,
    topicReadSearch,
} from "@terncosoftware/core/topics";
import { describe, expect, it } from "vitest";

const schema: ListSchema = {
    key: "id",
    fields: ["name", "createdAt"],
    searchFields: ["name"],
    defaultSort: [{ field: "createdAt", direction: "desc" }],
    maxLimit: 50,
};

const allow = async (): Promise<boolean> => true;

const messages = defineTopic({
    name: "demo:messages",
    kind: "list",
    params: { domainId: "required", range: "optional" },
    schema,
    authorize: allow,
    read: async () => ({ rows: [], total: 0, offset: 0, limit: 25 }),
});

const activity = defineTopic({
    name: "demo:activity",
    kind: "feed",
    params: {},
    schema: { key: "id", maxItems: 50 },
    authorize: allow,
    read: async () => ({ items: [], cursor: "0" }),
});

describe("topics", () => {
    it("test the change event has a stable name", () => {
        expect(TOPIC_CHANGED).toBe("core.topic.changed");
    });

    it("test a topic must be named by provider and cannot take a read key as a param", () => {
        expect(() => defineTopic({ ...messages, name: "messages" })).toThrow(/<provider>:<name>/);
        expect(() => defineTopic({ ...messages, params: { q: "optional" } })).toThrow(/"q"/);
        expect(() => defineTopic({ ...messages, params: { format: "optional" } })).toThrow(
            /"format"/,
        );
    });

    it("test params keep only named strings and refuse a missing required one", () => {
        expect(
            normalizeTopicParams(
                { domainId: "d1", range: "7d", tenantId: "other" },
                messages.params,
            ),
        ).toEqual({ domainId: "d1", range: "7d" });
        expect(normalizeTopicParams({ domainId: "d1", range: 7 }, messages.params)).toEqual({
            domainId: "d1",
        });
        expect(normalizeTopicParams({ range: "7d" }, messages.params)).toBeNull();
        expect(normalizeTopicParams({ domainId: "x".repeat(513) }, messages.params)).toBeNull();
        expect(normalizeTopicParams(null, {})).toEqual({});
    });

    it("test an address is the same whatever order params arrive in", () => {
        expect(topicAddress("demo:messages", { range: "7d", domainId: "d1" })).toBe(
            topicAddress("demo:messages", { domainId: "d1", range: "7d" }),
        );
        expect(topicAddress("demo:messages", { domainId: "d1" })).not.toBe(
            topicAddress("demo:messages", { domainId: "d2" }),
        );
    });

    it("test a change reaches subscriptions at its tenant whose params it names or leaves open", () => {
        const change = { topic: "demo:messages", tenantId: "t1", params: { domainId: "d1" } };
        expect(topicChangeReaches(change, "demo:messages", "t1", { domainId: "d1" })).toBe(true);
        expect(
            topicChangeReaches(change, "demo:messages", "t1", { domainId: "d1", range: "7d" }),
        ).toBe(true);
        expect(topicChangeReaches(change, "demo:messages", "t1", { domainId: "d2" })).toBe(false);
        expect(topicChangeReaches(change, "demo:messages", "t2", { domainId: "d1" })).toBe(false);
        expect(topicChangeReaches(change, "demo:other", "t1", { domainId: "d1" })).toBe(false);

        const anywhere = { topic: "demo:messages", tenantId: "t1", params: {} };
        expect(topicChangeReaches(anywhere, "demo:messages", "t1", { domainId: "d9" })).toBe(true);

        const install = { topic: "demo:messages", tenantId: null, params: {} };
        expect(topicChangeReaches(install, "demo:messages", null, {})).toBe(true);
        expect(topicChangeReaches(install, "demo:messages", "t1", {})).toBe(false);
    });

    it("test a snapshot's version moves only when its value does", () => {
        const a = snapshotFrame({ users: 4, names: ["ada"] });
        expect(a.type).toBe("snapshot");
        expect(snapshotFrame({ users: 4, names: ["ada"] }).version).toBe(a.version);
        expect(snapshotFrame({ users: 5, names: ["ada"] }).version).not.toBe(a.version);
    });

    it("test a page read from a store is sent again only when the page or its total moved", () => {
        const page = { rows: [{ id: "1", name: "Ada" }], total: 1, offset: 0, limit: 25 };
        const frame = listPageFrame(page);
        expect(frame.type).toBe("window");
        expect(listPageFrame({ ...page }).version).toBe(frame.version);
        expect(listPageFrame({ ...page, total: 2 }).version).not.toBe(frame.version);
        expect(
            listPageFrame({ ...page, rows: [{ id: "1", name: "Ada Lovelace" }] }).version,
        ).not.toBe(frame.version);
    });

    it("test feed items stay newest first, once each, within the limit", () => {
        const feed: FeedSchema = { key: "id", maxItems: 3 };
        const held = [
            { id: "2", n: 2 },
            { id: "1", n: 1 },
        ];
        expect(
            applyFeedFrame(
                held,
                {
                    type: "items",
                    reset: false,
                    items: [
                        { id: "3", n: 3 },
                        { id: "2", n: 22 },
                    ],
                },
                feed,
            ),
        ).toEqual([
            { id: "3", n: 3 },
            { id: "2", n: 22 },
            { id: "1", n: 1 },
        ]);
        expect(
            applyFeedFrame(held, { type: "items", reset: true, items: [{ id: "9", n: 9 }] }, feed),
        ).toEqual([{ id: "9", n: 9 }]);
    });

    it("test an HTTP read round-trips and is held to the topic's schema", () => {
        const search = topicReadSearch({
            params: { domainId: "d1" },
            query: {
                sort: [{ field: "name", direction: "asc" }],
                filters: [{ field: "secret", op: "eq", value: "x" }],
                search: "ada",
                page: { offset: 0, limit: 500 },
            },
            after: null,
        });
        expect(search.get("domainId")).toBe("d1");

        const read = parseTopicRead(search, messages);
        expect(read?.params).toEqual({ domainId: "d1" });
        expect(read?.query?.sort).toEqual([{ field: "name", direction: "asc" }]);
        expect(read?.query?.filters).toEqual([]);
        expect(read?.query?.search).toBe("ada");
        expect(read?.query?.page.limit).toBe(50);
        expect(read?.after).toBeNull();

        expect(parseTopicRead(new URLSearchParams({ q: "{" }), messages)).toBeNull();
        expect(
            parseTopicRead(new URLSearchParams({ domainId: "d1", q: "{" }), messages)?.query,
        ).toEqual({
            sort: [{ field: "createdAt", direction: "desc" }],
            filters: [],
            search: "",
            page: { offset: 0, limit: 25 },
        });

        const feedRead = parseTopicRead(new URLSearchParams({ after: "41", q: "{}" }), activity);
        expect(feedRead).toEqual({ params: {}, query: null, after: "41" });
    });
});
