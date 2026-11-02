import {
    defaultListQuery,
    type ListFilter,
    type ListQuery,
    type ListRow,
    type ListSchema,
    type ListSort,
    listKeyOf,
    normalizeListQuery,
} from "@terncosoftware/core/list";
import type { TopicParams } from "@terncosoftware/core/topics";
import type React from "react";
import { useEffect, useId, useMemo, useState } from "react";
import { useListTopic, useTileCommands } from "./hooks.js";
import { type ListColumn, ListTable } from "./ListTable.js";
import type { TileProps } from "./types.js";

/** One entry of the filter menu: a label and the filters it applies. */
export interface ListFilterChoice {
    readonly id: string;
    readonly label: string;
    readonly filters: readonly ListFilter[];
}

export interface ListTileProps<T extends ListRow> extends TileProps {
    readonly topic: string;
    readonly params?: TopicParams;
    readonly schema: ListSchema;
    readonly columns: readonly ListColumn<T>[];
    /** What the rows are, singular and plural: { one: "user", other: "users" }. */
    readonly noun: { readonly one: string; readonly other: string };
    readonly filterChoices?: readonly ListFilterChoice[];
    readonly pageSize?: number;
}

/** What a list tile keeps in its settings between visits. */
export interface ListTileSettings {
    readonly sort?: readonly ListSort[];
    readonly search?: string;
    readonly filter?: string;
    readonly offset?: number;
}

const SEARCH_DELAY_MS = 300;

const NO_CHOICES: readonly ListFilterChoice[] = [];

function readSettings(raw: unknown): ListTileSettings {
    return typeof raw === "object" && raw !== null ? (raw as ListTileSettings) : {};
}

function buildQuery(
    settings: ListTileSettings,
    schema: ListSchema,
    choices: readonly ListFilterChoice[],
    pageSize: number | undefined,
): ListQuery {
    const fallback = defaultListQuery(schema);
    const choice = choices.find((entry) => entry.id === settings.filter);
    return normalizeListQuery(
        {
            sort: settings.sort ?? fallback.sort,
            filters: choice?.filters ?? [],
            search: settings.search ?? "",
            page: { offset: settings.offset ?? 0, limit: pageSize ?? fallback.page.limit },
        },
        schema,
    );
}

function nextSort(current: readonly ListSort[], field: string): ListSort[] {
    const head = current[0];
    if (head?.field === field) {
        return [{ field, direction: head.direction === "asc" ? "desc" : "asc" }];
    }
    return [{ field, direction: "asc" }];
}

const COUNT = new Intl.NumberFormat();

/**
 * The reference tile: a live table over a list topic.
 *
 * Search, the filter menu, column sort and paging all become a query that the
 * topic answers; the tile never sorts or filters rows itself. Each change is
 * sent as a configure command, so it is saved for this viewer on this
 * dashboard and anything else on the dispatch can drive the tile the same way.
 */
export function ListTile<T extends ListRow>(props: ListTileProps<T>): React.ReactElement {
    const {
        tile,
        topic,
        params,
        schema,
        columns,
        noun,
        filterChoices = NO_CHOICES,
        pageSize,
    } = props;
    const commands = useTileCommands(tile);
    const settings = useMemo(() => readSettings(tile.settings.list), [tile.settings.list]);
    const query = useMemo(
        () => buildQuery(settings, schema, filterChoices, pageSize),
        [settings, schema, filterChoices, pageSize],
    );
    const live = useListTopic<T>(tile, { topic, params, schema, query });
    const [failed, setFailed] = useState<string | null>(null);
    const ids = useId();

    const save = async (patch: ListTileSettings): Promise<void> => {
        try {
            setFailed(null);
            await commands.configure({ list: { ...settings, ...patch } });
        } catch (err) {
            setFailed(err instanceof Error ? err.message : String(err));
        }
    };

    const [draft, setDraft] = useState(query.search);
    useEffect(() => {
        setDraft(query.search);
    }, [query.search]);
    const search = draft.trim();
    // biome-ignore lint/correctness/useExhaustiveDependencies: save is rebuilt every render; the search text is what should re-arm the timer.
    useEffect(() => {
        if (search === query.search) {
            return;
        }
        const timer = setTimeout(() => {
            save({ search, offset: 0 });
        }, SEARCH_DELAY_MS);
        return () => clearTimeout(timer);
    }, [search, query.search]);

    const page = live.window;
    const total = page?.total ?? 0;
    const filtered = query.search !== "" || query.filters.length > 0;
    const first = page && page.rows.length > 0 ? page.offset + 1 : 0;
    const last = page ? page.offset + page.rows.length : 0;
    const word = total === 1 ? noun.one : noun.other;

    return (
        <div className="dboard-list" data-testid={`dashboard-list-${tile.tileId}`}>
            <p className="dboard-list-total" aria-live="polite" aria-atomic="true">
                <span
                    className="dboard-list-count"
                    data-testid={`dashboard-list-total-${tile.tileId}`}
                >
                    {page ? COUNT.format(total) : "-"}
                </span>{" "}
                <span className="dboard-list-noun">{filtered ? `${word} match` : word}</span>
            </p>

            <div className="dboard-list-controls">
                <label className="dboard-list-field" htmlFor={`${ids}-search`}>
                    <span className="dboard-list-label">Search</span>
                    <input
                        id={`${ids}-search`}
                        className="dboard-list-search"
                        type="search"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        data-testid={`dashboard-list-search-${tile.tileId}`}
                    />
                </label>
                {filterChoices.length > 0 && (
                    <label className="dboard-list-field" htmlFor={`${ids}-filter`}>
                        <span className="dboard-list-label">Show</span>
                        <select
                            id={`${ids}-filter`}
                            className="dboard-list-filter"
                            value={settings.filter ?? ""}
                            onChange={(event) =>
                                save({ filter: event.target.value || undefined, offset: 0 })
                            }
                            data-testid={`dashboard-list-filter-${tile.tileId}`}
                        >
                            <option value="">All {noun.other}</option>
                            {filterChoices.map((choice) => (
                                <option key={choice.id} value={choice.id}>
                                    {choice.label}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
            </div>

            {(failed ?? live.error) && (
                <p className="dboard-list-error" role="alert">
                    {failed ?? live.error}
                </p>
            )}

            <ListTable<T>
                label={`${tile.title}, ${first}-${last} of ${total}`}
                columns={columns}
                rows={page?.rows ?? []}
                rowKey={(row) => listKeyOf(row, schema)}
                sort={query.sort}
                onSort={(field) => save({ sort: nextSort(query.sort, field), offset: 0 })}
                fresh={live.changed}
                busy={live.status === "loading"}
                empty={
                    page
                        ? filtered
                            ? `No ${noun.other} match.`
                            : `No ${noun.other} yet.`
                        : live.status === "loading"
                          ? `Loading ${noun.other}`
                          : undefined
                }
                rowTestId={() => `dashboard-list-row-${tile.tileId}`}
                sortTestId={(field) => `dashboard-list-sort-${tile.tileId}-${field}`}
            />

            <nav className="dboard-list-pager" aria-label={`${tile.title} pages`}>
                <span
                    className="dboard-list-range"
                    data-testid={`dashboard-list-range-${tile.tileId}`}
                >
                    {first}-{last} of {COUNT.format(total)}
                </span>
                <button
                    type="button"
                    className="dboard-list-page"
                    disabled={!page || page.offset === 0}
                    onClick={() =>
                        save({ offset: Math.max(0, query.page.offset - query.page.limit) })
                    }
                    data-testid={`dashboard-list-prev-${tile.tileId}`}
                >
                    Previous
                </button>
                <button
                    type="button"
                    className="dboard-list-page"
                    disabled={!page || last >= total}
                    onClick={() => save({ offset: query.page.offset + query.page.limit })}
                    data-testid={`dashboard-list-next-${tile.tileId}`}
                >
                    Next
                </button>
            </nav>
        </div>
    );
}
