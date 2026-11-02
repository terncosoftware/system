// @vitest-environment jsdom
import type { FeedSchema } from "@terncosoftware/core/topics";
import { InMemoryDispatch } from "@terncosoftware/core-ui";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardRuntime } from "../DashboardRuntime.js";
import { MemoryTopicSource } from "../MemoryTopicSource.js";
import type { TileState } from "../model.js";
import { MemoryTilePreferenceStore } from "../preferences.js";
import { TileTypeRegistry } from "../TileTypeRegistry.js";
import type { TopicSource } from "../TopicSource.js";
import { DashboardHostProvider } from "./context.js";
import { useFeedTopic, useSnapshotTopic } from "./hooks.js";
import { ListTable } from "./ListTable.js";

interface Counts {
    readonly users: number;
    readonly workspaces: number;
}

interface Event {
    readonly id: string;
    readonly text: string;
}

const feedSchema: FeedSchema = { key: "id", maxItems: 3 };

const tile = (tileId: string): TileState => ({
    dashboardId: "board",
    tileId,
    type: "demo:any",
    title: tileId,
    size: { cols: 1, rows: 1 },
    settings: {},
});

function CountsTile(props: { siteId: string }): React.ReactElement {
    const counts = useSnapshotTopic<Counts>(tile("counts"), {
        topic: "demo:counts",
        params: { siteId: props.siteId },
    });
    return (
        <p data-testid="counts" data-status={counts.status}>
            {counts.value ? `${counts.value.users}/${counts.value.workspaces}` : "-"}
        </p>
    );
}

function EventsTile(): React.ReactElement {
    const feed = useFeedTopic<Event>(tile("events"), { topic: "demo:events", schema: feedSchema });
    return (
        <ol>
            {feed.items.map((item) => (
                <li
                    key={item.id}
                    data-testid="event"
                    data-fresh={feed.fresh.includes(item.id) ? "true" : undefined}
                >
                    {item.text}
                </li>
            ))}
        </ol>
    );
}

describe("topic hooks", () => {
    let source: MemoryTopicSource;
    let runtime: DashboardRuntime;

    function mount(children: React.ReactNode): ReturnType<typeof render> {
        return render(
            <DashboardHostProvider runtime={runtime} topics={source}>
                {children}
            </DashboardHostProvider>,
        );
    }

    beforeEach(() => {
        source = new MemoryTopicSource();
        runtime = new DashboardRuntime({
            dispatch: new InMemoryDispatch(),
            preferences: new MemoryTilePreferenceStore(),
            tileTypes: new TileTypeRegistry(),
        });
    });

    afterEach(() => {
        cleanup();
    });

    it("test a snapshot tile shows the value and follows every change", async () => {
        source.setSnapshot("demo:counts", { users: 4, workspaces: 2 });
        mount(<CountsTile siteId="a" />);
        await vi.waitFor(() => expect(screen.getByTestId("counts").textContent).toBe("4/2"));
        expect(screen.getByTestId("counts").getAttribute("data-status")).toBe("live");

        act(() => {
            source.setSnapshot("demo:counts", { users: 5, workspaces: 2 });
        });
        expect(screen.getByTestId("counts").textContent).toBe("5/2");
    });

    it("test a snapshot tile opens a new view when its params change", async () => {
        source.setSnapshot("demo:counts", { users: 1, workspaces: 1 });
        const opened: string[] = [];
        const host: TopicSource = {
            open: (subscription, listener) => {
                opened.push(subscription.params.siteId ?? "");
                return source.open(subscription, listener);
            },
        };
        const page = (siteId: string): React.ReactElement => (
            <DashboardHostProvider runtime={runtime} topics={host}>
                <CountsTile siteId={siteId} />
            </DashboardHostProvider>
        );
        const view = render(page("a"));
        await vi.waitFor(() => expect(opened).toEqual(["a"]));

        view.rerender(page("b"));
        await vi.waitFor(() => expect(opened).toEqual(["a", "b"]));
        expect(source.openViews("demo:counts")).toBe(1);
        cleanup();
        expect(source.openViews()).toBe(0);
    });

    it("test an unknown topic reports an error instead of loading forever", async () => {
        mount(<CountsTile siteId="a" />);
        await vi.waitFor(() =>
            expect(screen.getByTestId("counts").getAttribute("data-status")).toBe("error"),
        );
    });

    it("test a feed tile puts new items on top, once each, up to its limit", async () => {
        source.setFeed("demo:events", feedSchema, [
            { id: "2", text: "second" },
            { id: "1", text: "first" },
        ]);
        mount(<EventsTile />);
        await vi.waitFor(() => expect(screen.getAllByTestId("event")).toHaveLength(2));

        act(() => {
            source.appendFeed("demo:events", [
                { id: "4", text: "fourth" },
                { id: "3", text: "third" },
                { id: "2", text: "second again" },
            ]);
        });
        const items = screen.getAllByTestId("event");
        expect(items.map((item) => item.textContent)).toEqual(["fourth", "third", "second again"]);
        expect(items[0]?.getAttribute("data-fresh")).toBe("true");
    });
});

describe(ListTable, () => {
    afterEach(() => {
        cleanup();
    });

    const rows = [
        { id: "1", name: "Ada", age: 36 },
        { id: "2", name: "Alan", age: 41 },
    ];

    it("test headers and the narrow sort menu both ask for a sort, and rows keep their labels", () => {
        const onSort = vi.fn();
        render(
            <ListTable
                label="People"
                columns={[
                    { field: "name", label: "Name", sortable: true },
                    { field: "age", label: "Age", sortable: true, align: "end" },
                ]}
                rows={rows}
                rowKey={(row) => row.id}
                sort={[{ field: "name", direction: "asc" }]}
                onSort={onSort}
                sortTestId={(field) => `sort-${field}`}
                rowTestId={() => "row"}
            />,
        );
        expect(screen.getByTestId("sort-name").closest("th")?.getAttribute("aria-sort")).toBe(
            "ascending",
        );
        fireEvent.click(screen.getByTestId("sort-age"));
        expect(onSort).toHaveBeenLastCalledWith("age");

        fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "age:asc" } });
        expect(onSort).toHaveBeenLastCalledWith("age");

        const cells = screen.getAllByTestId("row")[0]?.querySelectorAll("td") ?? [];
        expect([...cells].map((cell) => cell.getAttribute("data-label"))).toEqual(["Name", "Age"]);
        expect(cells[0]?.getAttribute("data-title")).toBe("true");
    });

    it("test an empty table says why instead of showing nothing", () => {
        render(
            <ListTable
                label="People"
                columns={[{ field: "name", label: "Name" }]}
                rows={[]}
                rowKey={(row: { id: string }) => row.id}
                empty="No people yet."
            />,
        );
        expect(screen.getByText("No people yet.")).toBeTruthy();
        expect(screen.queryByLabelText("Sort by")).toBeNull();
    });
});
