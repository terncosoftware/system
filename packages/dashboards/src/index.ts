// @terncosoftware/dashboards: dashboards made of tiles that any provider registers.
//
// A dashboard knows only tile types. Tiles change through dispatch commands,
// so a tile, a toolbar or a test drives them the same way, and each viewer's
// changes are kept per dashboard. Tiles read live topics (lists, snapshots and
// feeds) through one source the host supplies.

export {
    type CommandRegistrar,
    DashboardRuntime,
    type DashboardRuntimeOptions,
    MountedDashboard,
} from "./DashboardRuntime.js";
export { FeedTopicView, type FeedViewState } from "./FeedTopicView.js";
export { ListTopicView, type ListViewSnapshot, type ListViewStatus } from "./ListTopicView.js";
export { MemoryTopicSource } from "./MemoryTopicSource.js";
export {
    type ConfigureTileArgs,
    DashboardCommands,
    DashboardEvents,
    type ResizeTileArgs,
    type TileAddress,
} from "./messages.js";
export type {
    DashboardDefinition,
    TilePlacement,
    TilePreferences,
    TileSettings,
    TileSize,
    TileSizeLimits,
    TileState,
} from "./model.js";
export {
    BrowserTilePreferenceStore,
    type DashboardPreferences,
    type KeyValueStorage,
    MemoryTilePreferenceStore,
    type PreferenceScope,
    type TilePreferenceStore,
} from "./preferences.js";
export {
    SnapshotTopicView,
    type SnapshotViewState,
    type TopicViewStatus,
} from "./SnapshotTopicView.js";
export { type TileType, TileTypeRegistry } from "./TileTypeRegistry.js";
export type { TopicHandle, TopicListener, TopicSource, TopicSubscription } from "./TopicSource.js";
