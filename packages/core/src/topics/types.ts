/**
 * Topics: everything a screen shows, served live.
 *
 * A topic is a name plus params. Its kind says what it carries: a `list` of
 * rows a client pages, sorts, filters and searches; a `snapshot`, one value
 * sent whole whenever it changes; or a `feed`, items appended newest first.
 * The same definition answers a socket subscription and an HTTP read.
 */
import type { ApplicationContext } from "../ApplicationContext.js";
import type { ListFrame, ListQuery, ListRow, ListSchema, ListWindow } from "../list/types.js";
import type { SecurityContext } from "../SecurityContext.js";

export type TopicKind = "list" | "snapshot" | "feed";

/**
 * What a topic is addressed by beyond its name: the ids, ranges and zones a
 * tile fills from where it is placed. Values are strings so they travel in a
 * URL as well as a message.
 */
export type TopicParams = Readonly<Record<string, string>>;

/** The params a topic accepts. A required one must be present to subscribe or read. */
export type TopicParamSpec = Readonly<Record<string, "required" | "optional">>;

export interface AuthorizeTopicArgs {
    readonly params: TopicParams;
}

export interface ReadListTopicArgs {
    readonly params: TopicParams;
    readonly query: ListQuery;
}

export interface ReadSnapshotTopicArgs {
    readonly params: TopicParams;
}

export interface ReadFeedTopicArgs {
    readonly params: TopicParams;
    /** The cursor of the newest item the reader holds, or null for the latest page. */
    readonly after: string | null;
}

interface TopicBase<TCtx, TSec> {
    /** `<provider>:<name>`, the same name the tile showing it is registered under. */
    readonly name: string;
    readonly params: TopicParamSpec;
    /** Whether `sec` may read this topic at these params. Checked on every subscribe and read. */
    authorize(ctx: TCtx, sec: TSec, args: AuthorizeTopicArgs): Promise<boolean>;
}

export interface ListTopicDefinition<
    T extends ListRow = ListRow,
    TCtx = ApplicationContext,
    TSec = SecurityContext,
> extends TopicBase<TCtx, TSec> {
    readonly kind: "list";
    readonly schema: ListSchema;
    /** One page of the sorted, filtered list, read from the store, never every row. */
    read(ctx: TCtx, sec: TSec, args: ReadListTopicArgs): Promise<ListWindow<T>>;
}

export interface SnapshotTopicDefinition<
    T = unknown,
    TCtx = ApplicationContext,
    TSec = SecurityContext,
> extends TopicBase<TCtx, TSec> {
    readonly kind: "snapshot";
    /** The whole value. It must be JSON-serializable. */
    read(ctx: TCtx, sec: TSec, args: ReadSnapshotTopicArgs): Promise<T>;
}

/** How a feed's items are told apart and how many a reader keeps. */
export interface FeedSchema {
    /** The field holding each item's unique key. */
    readonly key: string;
    readonly maxItems: number;
}

/** Items newer than a cursor, newest first, and the cursor to read on from. */
export interface FeedPage<T = unknown> {
    readonly items: readonly T[];
    readonly cursor: string;
}

export interface FeedTopicDefinition<T = unknown, TCtx = ApplicationContext, TSec = SecurityContext>
    extends TopicBase<TCtx, TSec> {
    readonly kind: "feed";
    readonly schema: FeedSchema;
    /** The latest `schema.maxItems` items when `after` is null, otherwise the items after it. */
    read(ctx: TCtx, sec: TSec, args: ReadFeedTopicArgs): Promise<FeedPage<T>>;
}

export type TopicDefinition<TCtx = ApplicationContext, TSec = SecurityContext> =
    | ListTopicDefinition<ListRow, TCtx, TSec>
    // biome-ignore lint/suspicious/noExplicitAny: a registry holds snapshots of every value type.
    | SnapshotTopicDefinition<any, TCtx, TSec>
    // biome-ignore lint/suspicious/noExplicitAny: a registry holds feeds of every item type.
    | FeedTopicDefinition<any, TCtx, TSec>;

/** A snapshot topic's value, sent whole. `version` fingerprints it, so an unchanged value is not sent again. */
export interface SnapshotFrame<T = unknown> {
    readonly type: "snapshot";
    readonly version: string;
    readonly value: T;
}

/**
 * Feed items, newest first. `reset` replaces what the reader holds, as the
 * first frame after a subscribe does; otherwise the items go on top.
 */
export interface FeedFrame<T = unknown> {
    readonly type: "items";
    readonly reset: boolean;
    readonly items: readonly T[];
}

/** Anything a topic sends one subscriber. */
export type TopicFrame = ListFrame | SnapshotFrame | FeedFrame;

/**
 * Published after a write that may change what a topic shows. A param the
 * event leaves out matches every value of it. Subscribers at a matching
 * address read again, so the event names where, never what.
 */
export interface TopicChanged {
    readonly topic: string;
    /** The tenant whose data changed, or null for install-wide topics. */
    readonly tenantId: string | null;
    readonly params: TopicParams;
}

/** A topic read over HTTP: what to read and, for a list, which page; for a feed, from where. */
export interface TopicRead {
    readonly params: TopicParams;
    readonly query: ListQuery | null;
    readonly after: string | null;
}
