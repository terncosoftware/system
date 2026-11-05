import {
    applyFeedFrame,
    type FeedFrame,
    type FeedSchema,
    type TopicParams,
} from "@terncosoftware/core/topics";
import type { TopicViewStatus } from "./SnapshotTopicView.js";
import type { TopicHandle, TopicSource } from "./TopicSource.js";

export interface FeedViewState<T> {
    readonly status: TopicViewStatus;
    /** Newest first, at most the schema's `maxItems`. */
    readonly items: readonly T[];
    /** Keys of the items the last frame added on top. */
    readonly fresh: readonly string[];
    readonly error: string | null;
}

/** Holds the newest items of one feed topic. Framework free; the React hook binds it. */
export class FeedTopicView<T> {
    private _handle: TopicHandle | null = null;
    private _state: FeedViewState<T> = { status: "loading", items: [], fresh: [], error: null };
    private readonly _listeners = new Set<() => void>();

    constructor(
        private readonly _source: TopicSource,
        private readonly _topic: string,
        private readonly _view: string,
        private readonly _params: TopicParams,
        private readonly _schema: FeedSchema,
    ) {}

    state = (): FeedViewState<T> => this._state;

    subscribe = (listener: () => void): (() => void) => {
        this._listeners.add(listener);
        return () => {
            this._listeners.delete(listener);
        };
    };

    start(): void {
        if (this._handle !== null) {
            return;
        }
        this._handle = this._source.open(
            { topic: this._topic, view: this._view, params: this._params, query: null },
            {
                frame: (frame) => {
                    if (frame.type === "items") {
                        this._onFrame(frame as FeedFrame<T>);
                    }
                },
                error: (message) => this._set({ status: "error", error: message, fresh: [] }),
                reconnecting: () => this._set({ status: "reconnecting", error: null, fresh: [] }),
            },
        );
    }

    stop(): void {
        this._handle?.close();
        this._handle = null;
    }

    private _onFrame(frame: FeedFrame<T>): void {
        const items = applyFeedFrame(this._state.items, frame, this._schema);
        const fresh = frame.reset ? [] : frame.items.map((item) => this._keyOf(item));
        this._set({ status: "live", items, fresh, error: null });
    }

    private _keyOf(item: T): string {
        return String((item as Record<string, unknown>)[this._schema.key] ?? "");
    }

    private _set(patch: Partial<FeedViewState<T>>): void {
        this._state = { ...this._state, ...patch };
        for (const listener of this._listeners) {
            listener();
        }
    }
}
