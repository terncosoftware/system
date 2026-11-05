import { InMemoryDispatch } from "@terncosoftware/core-ui";
import { beforeEach, describe, expect, it } from "vitest";
import { DashboardRuntime } from "./DashboardRuntime.js";
import { DashboardCommands, DashboardEvents } from "./messages.js";
import type { DashboardDefinition, TileState } from "./model.js";
import { MemoryTilePreferenceStore } from "./preferences.js";
import { TileTypeRegistry } from "./TileTypeRegistry.js";

const definition: DashboardDefinition = {
    id: "overview",
    title: "Overview",
    columns: 4,
    tiles: [
        { id: "left", type: "demo:list", title: "Left" },
        { id: "right", type: "demo:list", title: "Right", settings: { mode: "compact" } },
    ],
};

describe(DashboardRuntime, () => {
    let dispatch: InMemoryDispatch;
    let preferences: MemoryTilePreferenceStore;
    let runtime: DashboardRuntime;

    beforeEach(() => {
        dispatch = new InMemoryDispatch();
        preferences = new MemoryTilePreferenceStore();
        const tileTypes = new TileTypeRegistry();
        tileTypes.register({
            type: "demo:list",
            title: "List",
            size: {
                default: { cols: 2, rows: 2 },
                min: { cols: 1, rows: 1 },
                max: { cols: 6, rows: 4 },
            },
            render: null,
        });
        runtime = new DashboardRuntime({ dispatch, preferences, tileTypes });
    });

    it("places the same tile type twice, each with its own state", async () => {
        const mounted = await runtime.mount(definition, "u1");
        expect(mounted.tiles().map((tile) => [tile.tileId, tile.size, tile.settings])).toEqual([
            ["left", { cols: 2, rows: 2 }, {}],
            ["right", { cols: 2, rows: 2 }, { mode: "compact" }],
        ]);
    });

    it("resizes through the dispatch, clamped to the type and the grid", async () => {
        const mounted = await runtime.mount(definition, "u1");
        const seen: TileState[] = [];
        dispatch.on(DashboardEvents.tileChanged, (state) => seen.push(state));

        await dispatch
            .command(DashboardCommands.resizeTile)
            .exec({ dashboardId: "overview", tileId: "left", size: { cols: 9, rows: 0 } });

        expect(mounted.tile("left")?.size).toEqual({ cols: 4, rows: 1 });
        expect(mounted.tile("right")?.size).toEqual({ cols: 2, rows: 2 });
        expect(seen.map((state) => state.tileId)).toEqual(["left"]);
    });

    it("keeps preferences per viewer and per dashboard", async () => {
        await runtime.mount(definition, "u1");
        await dispatch.command(DashboardCommands.configureTile).exec({
            dashboardId: "overview",
            tileId: "right",
            settings: { search: "ada" },
        });

        const again = await runtime.mount(definition, "u1");
        expect(again.tile("right")?.settings).toEqual({ mode: "compact", search: "ada" });

        const someoneElse = await runtime.mount(definition, "u2");
        expect(someoneElse.tile("right")?.settings).toEqual({ mode: "compact" });

        const otherBoard = await runtime.mount({ ...definition, id: "other" }, "u1");
        expect(otherBoard.tile("right")?.settings).toEqual({ mode: "compact" });
    });

    it("resets a tile to its placement", async () => {
        const mounted = await runtime.mount(definition, "u1");
        const address = { dashboardId: "overview", tileId: "left" };
        await dispatch
            .command(DashboardCommands.resizeTile)
            .exec({ ...address, size: { cols: 3, rows: 3 } });
        await dispatch.command(DashboardCommands.resetTile).exec(address);
        expect(mounted.tile("left")?.size).toEqual({ cols: 2, rows: 2 });
        expect(await preferences.load({ userId: "u1", dashboardId: "overview" })).toEqual({});
    });

    it("refuses a command for a tile that is not mounted", async () => {
        await runtime.mount(definition, "u1");
        await expect(
            dispatch
                .command(DashboardCommands.resetTile)
                .exec({ dashboardId: "overview", tileId: "missing" }),
        ).rejects.toThrow(/No tile "missing"/);
    });

    it("rejects a tile type without a provider prefix", () => {
        const registry = new TileTypeRegistry();
        expect(() =>
            registry.register({
                type: "bare",
                title: "Bare",
                size: {
                    default: { cols: 1, rows: 1 },
                    min: { cols: 1, rows: 1 },
                    max: { cols: 1, rows: 1 },
                },
                render: null,
            }),
        ).toThrow(/<provider>:<name>/);
    });
});
