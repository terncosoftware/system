import type { ListQuery, ListRow, ListSchema } from "@terncosoftware/core/list";
import { type FeedSchema, type TopicParams, topicAddress } from "@terncosoftware/core/topics";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { FeedTopicView, type FeedViewState } from "../FeedTopicView.js";
import { ListTopicView, type ListViewSnapshot } from "../ListTopicView.js";
import { DashboardCommands, DashboardEvents } from "../messages.js";
import type { TileSettings, TileSize, TileState } from "../model.js";
import { SnapshotTopicView, type SnapshotViewState } from "../SnapshotTopicView.js";
import { useDashboardHost } from "./context.js";

export interface TileCommands {
    resize(size: TileSize): Promise<void>;
    configure(settings: TileSettings): Promise<void>;
    reset(): Promise<void>;
    refresh(): Promise<void>;
}

/** The dashboard commands, bound to one tile. */
export function useTileCommands(tile: TileState): TileCommands {
    const { runtime } = useDashboardHost();
    const { dispatch } = runtime;
    const { dashboardId, tileId } = tile;
    const resize = useCallback(
        (size: TileSize) =>
            dispatch.command(DashboardCommands.resizeTile).exec({ dashboardId, tileId, size }),
        [dispatch, dashboardId, tileId],
    );
    const configure = useCallback(
        (settings: TileSettings) =>
            dispatch
                .command(DashboardCommands.configureTile)
                .exec({ dashboardId, tileId, settings }),
        [dispatch, dashboardId, tileId],
    );
    const reset = useCallback(
        () => dispatch.command(DashboardCommands.resetTile).exec({ dashboardId, tileId }),
        [dispatch, dashboardId, tileId],
    );
    const refresh = useCallback(
        () => dispatch.command(DashboardCommands.refreshTile).exec({ dashboardId, tileId }),
        [dispatch, dashboardId, tileId],
    );
    return { resize, configure, reset, refresh };
}

/** Run `onRefresh` whenever this tile is asked to read its data again. */
export function useTileRefresh(tile: TileState, onRefresh: () => void): void {
    const { runtime } = useDashboardHost();
    const { dashboardId, tileId } = tile;
    useEffect(
        () =>
            runtime.dispatch.on(DashboardEvents.tileRefreshRequested, (address) => {
                if (address.dashboardId === dashboardId && address.tileId === tileId) {
                    onRefresh();
                }
            }),
        [runtime, dashboardId, tileId, onRefresh],
    );
}

const NO_PARAMS: TopicParams = {};

/** Start a view while the tile is mounted, and read it again when the tile is refreshed. */
function useLiveView(
    tile: TileState,
    view: { start(): void; stop(): void; refresh(): void },
): void {
    useEffect(() => {
        view.start();
        return () => view.stop();
    }, [view]);
    useTileRefresh(
        tile,
        useCallback(() => view.refresh(), [view]),
    );
}

export interface UseListTopicArgs {
    readonly topic: string;
    readonly params?: TopicParams;
    readonly schema: ListSchema;
    readonly query: ListQuery;
}

/**
 * One live page of a list topic for one tile. The view is keyed by the tile,
 * so two tiles on the same topic each hold their own query.
 */
export function useListTopic<T extends ListRow>(
    tile: TileState,
    args: UseListTopicArgs,
): ListViewSnapshot<T> {
    const { topics } = useDashboardHost();
    const { topic, params = NO_PARAMS, schema, query } = args;
    const view = `${tile.dashboardId}/${tile.tileId}`;
    const address = topicAddress(topic, params);
    // biome-ignore lint/correctness/useExhaustiveDependencies: the address stands for topic and params, a topic's schema does not change under it, and a query change is applied below rather than by a new view.
    const live = useMemo(
        () => new ListTopicView<T>(topics, topic, view, params, schema, query),
        [topics, address, view],
    );
    useLiveView(tile, live);

    const queryKey = JSON.stringify(query);
    useEffect(() => {
        if (JSON.stringify(live.snapshot().query) !== queryKey) {
            live.setQuery(JSON.parse(queryKey) as ListQuery);
        }
    }, [live, queryKey]);

    return useSyncExternalStore(live.subscribe, live.snapshot, live.snapshot);
}

export interface UseSnapshotTopicArgs {
    readonly topic: string;
    readonly params?: TopicParams;
}

/** The latest value of a snapshot topic for one tile. */
export function useSnapshotTopic<T>(
    tile: TileState,
    args: UseSnapshotTopicArgs,
): SnapshotViewState<T> {
    const { topics } = useDashboardHost();
    const { topic, params = NO_PARAMS } = args;
    const view = `${tile.dashboardId}/${tile.tileId}`;
    const address = topicAddress(topic, params);
    // biome-ignore lint/correctness/useExhaustiveDependencies: the address stands for topic and params.
    const live = useMemo(
        () => new SnapshotTopicView<T>(topics, topic, view, params),
        [topics, address, view],
    );
    useLiveView(tile, live);
    return useSyncExternalStore(live.subscribe, live.state, live.state);
}

export interface UseFeedTopicArgs {
    readonly topic: string;
    readonly params?: TopicParams;
    readonly schema: FeedSchema;
}

/** The newest items of a feed topic for one tile. */
export function useFeedTopic<T>(tile: TileState, args: UseFeedTopicArgs): FeedViewState<T> {
    const { topics } = useDashboardHost();
    const { topic, params = NO_PARAMS, schema } = args;
    const view = `${tile.dashboardId}/${tile.tileId}`;
    const address = topicAddress(topic, params);
    // biome-ignore lint/correctness/useExhaustiveDependencies: the address stands for topic and params, and a topic's schema does not change under it.
    const live = useMemo(
        () => new FeedTopicView<T>(topics, topic, view, params, schema),
        [topics, address, view],
    );
    useLiveView(tile, live);
    return useSyncExternalStore(live.subscribe, live.state, live.state);
}
