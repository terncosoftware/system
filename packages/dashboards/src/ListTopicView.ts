import {
    applyListFrame,
    type ListFrame,
    type ListQuery,
    type ListRow,
    type ListSchema,
    type ListState,
    type ListWindow,
    listKeyOf,
} from "@terncosoftware/core/list";
import type { TopicParams } from "@terncosoftware/core/topics";
import type { TopicViewStatus } from "./SnapshotTopicView.js";
import type { TopicHandle, TopicSource } from "./TopicSource.js";

export type ListViewStatus = TopicViewStatus;

export interface ListViewSnapshot<T extends ListRow = ListRow> {
    readonly status: ListViewStatus;
    readonly query: ListQuery;
    /** The last page received. Kept while a new query loads so the table does not blank. */
    readonly window: ListWindow<T> | null;
    /** Keys of rows that arrived or changed in the last frame. */
    readonly changed: readonly string[];
    readonly error: string | null;
}

/**
 * Holds one live page of a list topic and keeps it in step with the topic,
 * reading it again whenever the placement rule says the page fell behind.
 * Framework free; the React hook is a thin binding over it.
 */
export class ListTopicView<T extends ListRow = ListRow> {
    private _state: ListState<T> | null = null;
    private _handle: TopicHandle | null = null;
    /** True while the page on screen answers a query other than the current one. */
    private _requeried = false;
    private _snapshot: ListViewSnapshot<T>;
    private readonly _listeners = new Set<() => void>();

    constructor(
        private readonly _source: TopicSource,
        private readonly _topic: string,
        private readonly _view: string,
        private readonly _params: TopicParams,
        private readonly _schema: ListSchema,
        query: ListQuery,
    ) {
        this._snapshot = { status: "loading", query, window: null, changed: [], error: null };
    }

    snapshot = (): ListViewSnapshot<T> => this._snapshot;

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
            {
                topic: this._topic,
                view: this._view,
                params: this._params,
                query: this._snapshot.query,
            },
            {
                frame: (frame) => this._onFrame(frame as ListFrame<T>),
                error: (message) => this._set({ status: "error", error: message, changed: [] }),
            },
        );
    }

    stop(): void {
        this._handle?.close();
        this._handle = null;
    }

    /** Ask for a different page, order or filter. */
    setQuery(query: ListQuery): void {
        this._requeried = true;
        this._read(query);
    }

    /** Read the current page again. */
    refresh(): void {
        this._read(this._snapshot.query);
    }

    private _read(query: ListQuery): void {
        this._state = null;
        this._set({ status: "loading", query, changed: [] });
        this._handle?.update(query);
    }

    private _onFrame(frame: ListFrame<T>): void {
        // Changes for an earlier query can still be in flight after a query
        // change; until the new window lands there is no page to place them on.
        if (this._state === null && frame.type === "changes") {
            return;
        }
        const next = applyListFrame(this._state, frame, this._snapshot.query, this._schema);
        if (next === null) {
            this.refresh();
            return;
        }
        if (next === this._state) {
            return;
        }
        const changed = this._changedKeys(frame, next);
        this._state = next;
        this._requeried = false;
        this._set({ status: "live", window: next.window, error: null, changed });
    }

    /**
     * Rows worth pointing out: those a change touched, or those a re-read of
     * the same query brought onto the page. A new query's page is all new, so
     * nothing on it is singled out.
     */
    private _changedKeys(frame: ListFrame<T>, next: ListState<T>): string[] {
        const shown = new Set(next.window.rows.map((row) => listKeyOf(row, this._schema)));
        if (frame.type === "changes") {
            return frame.changes.map((change) => change.key).filter((key) => shown.has(key));
        }
        const held = this._snapshot.window;
        if (held === null || this._requeried) {
            return [];
        }
        const before = new Map(held.rows.map((row) => [listKeyOf(row, this._schema), row]));
        return next.window.rows
            .filter((row) => {
                const was = before.get(listKeyOf(row, this._schema));
                return was === undefined || JSON.stringify(was) !== JSON.stringify(row);
            })
            .map((row) => listKeyOf(row, this._schema));
    }

    private _set(patch: Partial<ListViewSnapshot<T>>): void {
        this._snapshot = { ...this._snapshot, ...patch };
        for (const listener of this._listeners) {
            listener();
        }
    }
}
