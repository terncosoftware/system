import type { SnapshotFrame, TopicParams } from "@terncosoftware/core/topics";
import type { TopicHandle, TopicSource } from "./TopicSource.js";

/** `reconnecting` is not an error: what the view holds stays until the next frame. */
export type TopicViewStatus = "loading" | "live" | "reconnecting" | "error";

export interface SnapshotViewState<T> {
    readonly status: TopicViewStatus;
    /** The last value received. Kept through an error so the tile does not blank. */
    readonly value: T | null;
    readonly error: string | null;
}

/** Holds the latest value of one snapshot topic. Framework free; the React hook binds it. */
export class SnapshotTopicView<T> {
    private _handle: TopicHandle | null = null;
    private _version: string | null = null;
    private _state: SnapshotViewState<T> = { status: "loading", value: null, error: null };
    private readonly _listeners = new Set<() => void>();

    constructor(
        private readonly _source: TopicSource,
        private readonly _topic: string,
        private readonly _view: string,
        private readonly _params: TopicParams,
    ) {}

    state = (): SnapshotViewState<T> => this._state;

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
                    if (frame.type === "snapshot") {
                        this._onFrame(frame as SnapshotFrame<T>);
                    }
                },
                error: (message) => this._set({ status: "error", error: message }),
                reconnecting: () => this._set({ status: "reconnecting", error: null }),
            },
        );
    }

    stop(): void {
        this._handle?.close();
        this._handle = null;
    }

    private _onFrame(frame: SnapshotFrame<T>): void {
        if (frame.version === this._version && this._state.status === "live") {
            return;
        }
        this._version = frame.version;
        this._set({ status: "live", value: frame.value, error: null });
    }

    private _set(patch: Partial<SnapshotViewState<T>>): void {
        this._state = { ...this._state, ...patch };
        for (const listener of this._listeners) {
            listener();
        }
    }
}
