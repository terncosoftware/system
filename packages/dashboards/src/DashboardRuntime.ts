import type { CommandImpl, Dispatch } from "@terncosoftware/core-ui";
import {
    type ConfigureTileArgs,
    DashboardCommands,
    DashboardEvents,
    type ResizeTileArgs,
    type TileAddress,
} from "./messages.js";
import type {
    DashboardDefinition,
    TilePlacement,
    TilePreferences,
    TileSize,
    TileSizeLimits,
    TileState,
} from "./model.js";
import type { DashboardPreferences, TilePreferenceStore } from "./preferences.js";
import type { TileTypeRegistry } from "./TileTypeRegistry.js";

/** A dispatch the runtime can also register its commands on. */
export interface CommandRegistrar extends Dispatch {
    register<TArg = unknown>(name: string, impl: CommandImpl<TArg>): void;
}

export interface DashboardRuntimeOptions {
    readonly dispatch: CommandRegistrar;
    readonly preferences: TilePreferenceStore;
    readonly tileTypes: TileTypeRegistry;
}

/** The size limits used for a tile whose type is not registered. */
const UNKNOWN_TYPE_SIZE: TileSizeLimits = {
    default: { cols: 1, rows: 1 },
    min: { cols: 1, rows: 1 },
    max: { cols: 1, rows: 1 },
};

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Math.round(value)));
}

function clampSize(size: TileSize, limits: TileSizeLimits, columns: number): TileSize {
    const maxCols = Math.max(limits.min.cols, Math.min(limits.max.cols, columns));
    return {
        cols: clamp(size.cols, limits.min.cols, maxCols),
        rows: clamp(size.rows, limits.min.rows, limits.max.rows),
    };
}

/**
 * One dashboard as one viewer sees it: its tiles with that viewer's
 * preferences applied. Change it through the dispatch commands, so whatever
 * sends them never needs a reference to this object.
 */
export class MountedDashboard {
    private _tiles: readonly TileState[];
    private _preferences: Record<string, TilePreferences>;
    private readonly _listeners = new Set<() => void>();

    constructor(
        readonly definition: DashboardDefinition,
        readonly userId: string,
        preferences: DashboardPreferences,
        private readonly _options: DashboardRuntimeOptions,
        private readonly _onUnmount: (mounted: MountedDashboard) => void,
    ) {
        this._preferences = { ...preferences };
        this._tiles = definition.tiles.map((placement) => this._resolve(placement));
    }

    /** Every tile in placement order. The array is replaced, never mutated, on change. */
    tiles = (): readonly TileState[] => this._tiles;

    tile(tileId: string): TileState | undefined {
        return this._tiles.find((tile) => tile.tileId === tileId);
    }

    /** Called after every change. Returns an unsubscribe. */
    subscribe = (listener: () => void): (() => void) => {
        this._listeners.add(listener);
        return () => {
            this._listeners.delete(listener);
        };
    };

    unmount(): void {
        this._listeners.clear();
        this._onUnmount(this);
    }

    /** Apply a tile's new preferences, or drop them with null. */
    async update(tileId: string, preferences: TilePreferences | null): Promise<void> {
        const placement = this.definition.tiles.find((tile) => tile.id === tileId);
        if (placement === undefined) {
            throw new Error(`Dashboard "${this.definition.id}" has no tile "${tileId}"`);
        }
        if (preferences === null) {
            delete this._preferences[tileId];
        } else {
            this._preferences[tileId] = preferences;
        }
        const next = this._resolve(placement);
        this._tiles = this._tiles.map((tile) => (tile.tileId === tileId ? next : tile));
        for (const listener of this._listeners) {
            listener();
        }
        this._options.dispatch.event(DashboardEvents.tileChanged, next);
        await this._options.preferences.save(
            { userId: this.userId, dashboardId: this.definition.id },
            this._preferences,
        );
    }

    /** The viewer's stored preferences for a tile. */
    preferencesFor(tileId: string): TilePreferences {
        return this._preferences[tileId] ?? {};
    }

    /** Size limits of a tile's type. */
    limitsFor(tileId: string): TileSizeLimits {
        const placement = this.definition.tiles.find((tile) => tile.id === tileId);
        const type = placement ? this._options.tileTypes.get(placement.type) : undefined;
        return type?.size ?? UNKNOWN_TYPE_SIZE;
    }

    private _resolve(placement: TilePlacement): TileState {
        const type = this._options.tileTypes.get(placement.type);
        const limits = type?.size ?? UNKNOWN_TYPE_SIZE;
        const saved = this._preferences[placement.id] ?? {};
        return {
            dashboardId: this.definition.id,
            tileId: placement.id,
            type: placement.type,
            title: placement.title ?? type?.title ?? placement.type,
            size: clampSize(
                saved.size ?? placement.size ?? limits.default,
                limits,
                this.definition.columns,
            ),
            settings: { ...placement.settings, ...saved.settings },
        };
    }
}

/**
 * Hosts every mounted dashboard on one dispatch and answers the dashboard
 * commands for all of them. Create one per dispatch: a second would take the
 * commands over from the first.
 */
export class DashboardRuntime {
    private readonly _mounted = new Map<string, MountedDashboard>();

    constructor(private readonly _options: DashboardRuntimeOptions) {
        const { dispatch } = _options;
        dispatch.register<ResizeTileArgs>(DashboardCommands.resizeTile, async (args) => {
            const mounted = this._find(args);
            const limits = mounted.limitsFor(args.tileId);
            await mounted.update(args.tileId, {
                ...mounted.preferencesFor(args.tileId),
                size: clampSize(args.size, limits, mounted.definition.columns),
            });
        });
        dispatch.register<ConfigureTileArgs>(DashboardCommands.configureTile, async (args) => {
            const mounted = this._find(args);
            const current = mounted.preferencesFor(args.tileId);
            await mounted.update(args.tileId, {
                ...current,
                settings: { ...current.settings, ...args.settings },
            });
        });
        dispatch.register<TileAddress>(DashboardCommands.resetTile, async (args) => {
            await this._find(args).update(args.tileId, null);
        });
    }

    get dispatch(): Dispatch {
        return this._options.dispatch;
    }

    get tileTypes(): TileTypeRegistry {
        return this._options.tileTypes;
    }

    /**
     * Load a viewer's preferences and mount the dashboard. Mounting a
     * dashboard id that is already mounted replaces it.
     */
    async mount(definition: DashboardDefinition, userId: string): Promise<MountedDashboard> {
        const preferences = await this._options.preferences.load({
            userId,
            dashboardId: definition.id,
        });
        const mounted = new MountedDashboard(
            definition,
            userId,
            preferences,
            this._options,
            (gone) => {
                if (this._mounted.get(definition.id) === gone) {
                    this._mounted.delete(definition.id);
                }
            },
        );
        this._mounted.set(definition.id, mounted);
        return mounted;
    }

    mounted(dashboardId: string): MountedDashboard | undefined {
        return this._mounted.get(dashboardId);
    }

    private _find(address: TileAddress): MountedDashboard {
        const mounted = this._mounted.get(address.dashboardId);
        if (mounted === undefined || mounted.tile(address.tileId) === undefined) {
            throw new Error(`No tile "${address.tileId}" on dashboard "${address.dashboardId}"`);
        }
        return mounted;
    }
}
