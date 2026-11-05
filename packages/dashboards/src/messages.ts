import type { TileSettings, TileSize, TileState } from "./model.js";

/** Addresses one tile on one dashboard. */
export interface TileAddress {
    readonly dashboardId: string;
    readonly tileId: string;
}

export interface ResizeTileArgs extends TileAddress {
    readonly size: TileSize;
}

export interface ConfigureTileArgs extends TileAddress {
    /** Merged over the tile's current settings. */
    readonly settings: TileSettings;
}

/** Commands a dashboard accepts. Anything holding the dispatch can send them. */
export const DashboardCommands = {
    /** Resize a tile, clamped to what its type allows. */
    resizeTile: "dashboard.tile.resize",
    /** Change a tile's settings. */
    configureTile: "dashboard.tile.configure",
    /** Drop the viewer's preferences for a tile. */
    resetTile: "dashboard.tile.reset",
} as const;

/** Events a dashboard raises. */
export const DashboardEvents = {
    /** A tile's size or settings changed, carrying its new state. */
    tileChanged: "dashboard.tile.changed",
} as const;

declare module "@terncosoftware/core-ui" {
    interface SystemCommands {
        "dashboard.tile.resize": ResizeTileArgs;
        "dashboard.tile.configure": ConfigureTileArgs;
        "dashboard.tile.reset": TileAddress;
    }
    interface SystemEvents {
        "dashboard.tile.changed": TileState;
    }
}
