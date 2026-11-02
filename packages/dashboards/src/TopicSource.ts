import type { ListQuery } from "@terncosoftware/core/list";
import type { TopicFrame, TopicParams } from "@terncosoftware/core/topics";

/** One view of a topic. Two tiles on the same topic hold two views. */
export interface TopicSubscription {
    readonly topic: string;
    /** Unique per view on one connection, so each view keeps its own query. */
    readonly view: string;
    readonly params: TopicParams;
    /** The page a list view wants; null for snapshots and feeds. */
    readonly query: ListQuery | null;
}

export interface TopicListener {
    frame(frame: TopicFrame): void;
    error(message: string): void;
}

export interface TopicHandle {
    /** Read the topic again: with a new query for a list, as it stands for anything else. */
    update(query: ListQuery | null): void;
    close(): void;
}

/**
 * How a host delivers topics to tiles. The host owns the connection,
 * authentication and addressing; a tile only ever sees frames.
 */
export interface TopicSource {
    open(subscription: TopicSubscription, listener: TopicListener): TopicHandle;
}
