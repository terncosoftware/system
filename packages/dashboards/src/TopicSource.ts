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
    /** The topic cannot be read. */
    error(message: string): void;
    /**
     * The connection dropped and the host is bringing it back. Not an error:
     * the view keeps what it holds, and the next frame brings it up to date.
     */
    reconnecting(): void;
}

export interface TopicHandle {
    /** Ask a list view for a different page, order or filter. */
    update(query: ListQuery): void;
    close(): void;
}

/**
 * How a host delivers topics to tiles. The host owns the connection,
 * authentication and addressing; a tile only ever sees frames.
 */
export interface TopicSource {
    open(subscription: TopicSubscription, listener: TopicListener): TopicHandle;
}
