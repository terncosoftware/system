import {
    type ListQuery,
    type ListRow,
    type ListSchema,
    listWindowFrame,
    planListPush,
} from "@terncosoftware/core/list";
import { applyFeedFrame, type FeedSchema, snapshotFrame } from "@terncosoftware/core/topics";
import type { TopicHandle, TopicListener, TopicSource, TopicSubscription } from "./TopicSource.js";

interface OpenView {
    readonly topic: string;
    query: ListQuery | null;
    readonly listener: TopicListener;
}

interface HeldList {
    readonly schema: ListSchema;
    rows: readonly ListRow[];
}

interface HeldFeed {
    readonly schema: FeedSchema;
    items: readonly unknown[];
}

/**
 * Topics served from data held in memory, through the same frames and
 * placement rule a server uses. For tests, previews and hosts whose data
 * already sits in the browser. Params are not part of an address here.
 */
export class MemoryTopicSource implements TopicSource {
    private readonly _lists = new Map<string, HeldList>();
    private readonly _snapshots = new Map<string, unknown>();
    private readonly _feeds = new Map<string, HeldFeed>();
    private readonly _views = new Set<OpenView>();

    open(subscription: TopicSubscription, listener: TopicListener): TopicHandle {
        const { topic } = subscription;
        if (!this._lists.has(topic) && !this._snapshots.has(topic) && !this._feeds.has(topic)) {
            listener.error(`Unknown topic: ${topic}`);
            return { update: () => {}, close: () => {} };
        }
        const view: OpenView = { topic, query: subscription.query, listener };
        this._views.add(view);
        this._send(view);
        return {
            update: (query) => {
                view.query = query;
                this._send(view);
            },
            close: () => {
                this._views.delete(view);
            },
        };
    }

    /** Replace a list's rows and push each open view whatever it can see change. */
    setList<T extends ListRow>(topic: string, schema: ListSchema, rows: readonly T[]): void {
        const held = this._lists.get(topic);
        this._lists.set(topic, { schema, rows });
        if (held === undefined) {
            return;
        }
        for (const view of this._viewsOf(topic)) {
            if (view.query === null) {
                continue;
            }
            const frame = planListPush(held.rows, rows, view.query, schema);
            if (frame !== null) {
                view.listener.frame(frame);
            }
        }
    }

    rows(topic: string): readonly ListRow[] {
        return this._lists.get(topic)?.rows ?? [];
    }

    setSnapshot(topic: string, value: unknown): void {
        this._snapshots.set(topic, value);
        for (const view of this._viewsOf(topic)) {
            view.listener.frame(snapshotFrame(value));
        }
    }

    /** Replace a feed's items, newest first. */
    setFeed(topic: string, schema: FeedSchema, items: readonly unknown[]): void {
        this._feeds.set(topic, { schema, items });
        for (const view of this._viewsOf(topic)) {
            this._send(view);
        }
    }

    /** Add items, newest first, on top of a feed. */
    appendFeed(topic: string, items: readonly unknown[]): void {
        const held = this._feeds.get(topic);
        if (held === undefined) {
            throw new Error(`Unknown feed: ${topic}`);
        }
        const frame = { type: "items", reset: false, items } as const;
        held.items = applyFeedFrame(held.items, frame, held.schema);
        for (const view of this._viewsOf(topic)) {
            view.listener.frame(frame);
        }
    }

    /** How many views are open, on one topic or on all of them. */
    openViews(topic?: string): number {
        return topic === undefined ? this._views.size : this._viewsOf(topic).length;
    }

    private _viewsOf(topic: string): OpenView[] {
        return [...this._views].filter((view) => view.topic === topic);
    }

    private _send(view: OpenView): void {
        const list = this._lists.get(view.topic);
        if (list !== undefined) {
            if (view.query !== null) {
                view.listener.frame(listWindowFrame(list.rows, view.query, list.schema));
            }
            return;
        }
        if (this._snapshots.has(view.topic)) {
            view.listener.frame(snapshotFrame(this._snapshots.get(view.topic)));
            return;
        }
        const feed = this._feeds.get(view.topic);
        if (feed !== undefined) {
            view.listener.frame({ type: "items", reset: true, items: feed.items });
        }
    }
}
