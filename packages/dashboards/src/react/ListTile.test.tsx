// @vitest-environment jsdom
import type { ListSchema } from "@terncosoftware/core/list";
import { InMemoryDispatch } from "@terncosoftware/core-ui";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardRuntime } from "../DashboardRuntime.js";
import { MemoryTopicSource } from "../MemoryTopicSource.js";
import { DashboardCommands } from "../messages.js";
import type { DashboardDefinition } from "../model.js";
import { MemoryTilePreferenceStore } from "../preferences.js";
import { TileTypeRegistry } from "../TileTypeRegistry.js";
import { DashboardHostProvider } from "./context.js";
import { Dashboard } from "./Dashboard.js";
import { ListTile } from "./ListTile.js";
import type { TileProps } from "./types.js";

interface Member {
    [field: string]: string | number | boolean | null;
    id: string;
    name: string;
    joined: string;
    admin: boolean;
}

const schema: ListSchema = {
    key: "id",
    fields: ["name", "joined", "admin"],
    searchFields: ["name"],
    defaultSort: [{ field: "joined", direction: "desc" }],
};

const member = (id: string, name: string, joined: string, admin = false): Member => ({
    id,
    name,
    joined,
    admin,
});

const TOPIC = "members";

function MembersTile(props: TileProps): React.ReactElement {
    return (
        <ListTile<Member>
            tile={props.tile}
            topic={TOPIC}
            schema={schema}
            noun={{ one: "member", other: "members" }}
            pageSize={3}
            filterChoices={[
                {
                    id: "admins",
                    label: "Admins",
                    filters: [{ field: "admin", op: "eq", value: true }],
                },
            ]}
            columns={[
                { field: "name", label: "Name", sortable: true },
                { field: "joined", label: "Joined", sortable: true, align: "end" },
            ]}
        />
    );
}

const definition: DashboardDefinition = {
    id: "people",
    title: "People",
    columns: 4,
    tiles: [
        { id: "recent", type: "demo:members", title: "Recent members" },
        {
            id: "admins",
            type: "demo:members",
            title: "Admins",
            settings: { list: { filter: "admins" } },
        },
    ],
};

function names(tileId: string): string[] {
    return screen
        .getAllByTestId(`dashboard-list-row-${tileId}`)
        .map((row) => row.querySelector("td")?.textContent ?? "");
}

describe(ListTile, () => {
    let source: MemoryTopicSource;
    let dispatch: InMemoryDispatch;
    let runtime: DashboardRuntime;
    let preferences: MemoryTilePreferenceStore;

    function mount(): void {
        render(
            <DashboardHostProvider runtime={runtime} topics={source}>
                <Dashboard definition={definition} userId="viewer" />
            </DashboardHostProvider>,
        );
    }

    beforeEach(() => {
        source = new MemoryTopicSource();
        source.setList<Member>(TOPIC, schema, [
            member("1", "Ada", "2026-01-01T00:00:00Z", true),
            member("2", "Grace", "2026-02-01T00:00:00Z"),
            member("3", "Alan", "2026-03-01T00:00:00Z"),
            member("4", "Edsger", "2026-04-01T00:00:00Z", true),
        ]);
        dispatch = new InMemoryDispatch();
        preferences = new MemoryTilePreferenceStore();
        const tileTypes = new TileTypeRegistry<React.ComponentType<TileProps>>();
        tileTypes.register({
            type: "demo:members",
            title: "Members",
            size: {
                default: { cols: 2, rows: 2 },
                min: { cols: 1, rows: 1 },
                max: { cols: 4, rows: 4 },
            },
            render: MembersTile,
        });
        runtime = new DashboardRuntime({ dispatch, preferences, tileTypes });
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it("holds a separate query per instance and updates both live", async () => {
        mount();
        expect(await screen.findAllByTestId("dashboard-list-row-recent")).toHaveLength(3);
        expect(names("recent")).toEqual(["Edsger", "Alan", "Grace"]);
        expect(names("admins")).toEqual(["Edsger", "Ada"]);
        expect(screen.getByTestId("dashboard-list-total-recent").textContent).toBe("4");
        expect(screen.getByTestId("dashboard-list-total-admins").textContent).toBe("2");

        act(() => {
            source.setList(TOPIC, schema, [
                ...source.rows(TOPIC),
                member("5", "Barbara", "2026-05-01T00:00:00Z", true),
            ]);
        });

        expect(names("recent")).toEqual(["Barbara", "Edsger", "Alan"]);
        expect(names("admins")).toEqual(["Barbara", "Edsger", "Ada"]);
        expect(screen.getByTestId("dashboard-list-total-recent").textContent).toBe("5");
        expect(screen.getByTestId("dashboard-list-total-admins").textContent).toBe("3");
        const fresh = screen.getAllByTestId("dashboard-list-row-recent")[0];
        expect(fresh.getAttribute("data-fresh")).toBe("true");
    });

    it("sorts, searches and pages through the topic", async () => {
        mount();
        await screen.findAllByTestId("dashboard-list-row-recent");

        fireEvent.click(screen.getByTestId("dashboard-list-sort-recent-name"));
        await vi.waitFor(() => expect(names("recent")).toEqual(["Ada", "Alan", "Edsger"]));

        fireEvent.click(screen.getByTestId("dashboard-list-next-recent"));
        await vi.waitFor(() => expect(names("recent")).toEqual(["Grace"]));
        expect(screen.getByTestId("dashboard-list-range-recent").textContent).toBe("4-4 of 4");

        fireEvent.change(screen.getByTestId("dashboard-list-search-recent"), {
            target: { value: "gr" },
        });
        await vi.waitFor(() =>
            expect(screen.getByTestId("dashboard-list-range-recent").textContent).toBe("1-1 of 1"),
        );
        expect(names("recent")).toEqual(["Grace"]);
        expect(names("admins")).toEqual(["Edsger", "Ada"]);
        expect(
            screen.getByTestId("dashboard-list-recent").querySelector(".dboard-list-total")
                ?.textContent,
        ).toBe("1 member matches");
        expect(
            screen.getByTestId("dashboard-list-admins").querySelector(".dboard-list-total")
                ?.textContent,
        ).toBe("2 members match");
    });

    it("shows no count or range while the topic has not answered", async () => {
        source = new MemoryTopicSource();
        mount();
        await screen.findAllByText("Unknown topic: members");
        expect(screen.queryByTestId("dashboard-list-total-recent")).toBeNull();
        expect(screen.getByTestId("dashboard-list-range-recent").textContent).toBe("");
    });

    it("keeps the viewer's query and size for the next visit", async () => {
        mount();
        await screen.findAllByTestId("dashboard-list-row-recent");
        fireEvent.change(screen.getByTestId("dashboard-list-filter-recent"), {
            target: { value: "admins" },
        });
        const handle = screen.getByTestId("dashboard-tile-resize-recent");
        fireEvent.keyDown(handle, { key: "ArrowRight" });
        await vi.waitFor(() =>
            expect(screen.getByTestId("dashboard-tile-recent").getAttribute("data-cols")).toBe("3"),
        );

        cleanup();
        mount();
        await vi.waitFor(() => expect(names("recent")).toEqual(["Edsger", "Ada"]));
        expect(screen.getByTestId("dashboard-tile-recent").getAttribute("data-cols")).toBe("3");
    });

    it("takes commands from anything on the dispatch", async () => {
        mount();
        await screen.findAllByTestId("dashboard-list-row-admins");
        await act(() =>
            dispatch.command(DashboardCommands.configureTile).exec({
                dashboardId: "people",
                tileId: "admins",
                settings: { list: { search: "ada" } },
            }),
        );
        await vi.waitFor(() => expect(names("admins")).toEqual(["Ada"]));
    });

    it("draws no refresh control: the topic keeps every tile current", async () => {
        mount();
        await screen.findAllByTestId("dashboard-list-row-recent");
        const frame = screen.getByTestId("dashboard-tile-recent");
        expect(frame.querySelector(".dboard-tile-header button")).toBeNull();
        expect(within(frame).queryByRole("button", { name: /refresh/i })).toBeNull();
        expect(screen.queryByTestId("dashboard-tile-refresh-recent")).toBeNull();
    });

    it("says it is reconnecting as a neutral status, not an error, and keeps its rows", async () => {
        mount();
        await screen.findAllByTestId("dashboard-list-row-recent");
        const status = screen.getByTestId("dashboard-list-status-recent");
        expect(status.getAttribute("role")).toBe("status");
        expect(status.textContent).toBe("");

        act(() => source.disconnect());

        expect(status.textContent).toBe(
            "Reconnecting. This fills in again as soon as the connection is back.",
        );
        expect(status.className).toBe("dboard-list-status");
        const tile = screen.getByTestId("dashboard-list-recent");
        expect(within(tile).queryByRole("alert")).toBeNull();
        expect(tile.querySelector(".dboard-list-error")).toBeNull();
        expect(names("recent")).toEqual(["Edsger", "Alan", "Grace"]);

        // A change made while the connection is down arrives when it is back.
        source.setList(TOPIC, schema, [
            ...source.rows(TOPIC),
            member("5", "Barbara", "2026-05-01T00:00:00Z"),
        ]);
        expect(names("recent")).toEqual(["Edsger", "Alan", "Grace"]);
        act(() => source.reconnect());

        expect(status.textContent).toBe("");
        expect(names("recent")).toEqual(["Barbara", "Edsger", "Alan"]);
        expect(screen.getByTestId("dashboard-list-total-recent").textContent).toBe("5");
    });

    it("closes its topic view when the dashboard goes away", async () => {
        mount();
        await screen.findAllByTestId("dashboard-list-row-recent");
        expect(source.openViews()).toBe(2);
        cleanup();
        expect(source.openViews()).toBe(0);
    });
});
