import type { ListSort } from "@terncosoftware/core/list";
import type React from "react";
import { useId } from "react";

export interface ListColumn<T> {
    readonly field: string;
    readonly label: string;
    readonly sortable?: boolean;
    /** Numbers and dates usually read best aligned to the end. */
    readonly align?: "start" | "end";
    readonly render?: (row: T) => React.ReactNode;
    /** The column naming the record on a narrow card; the first column by default. */
    readonly title?: boolean;
    /** False for a column a narrow card leaves out, such as a chevron. */
    readonly phone?: boolean;
}

export interface ListTableProps<T> {
    /** Names the table for assistive technology. */
    readonly label: string;
    readonly columns: readonly ListColumn<T>[];
    readonly rows: readonly T[];
    readonly rowKey: (row: T) => string;
    /** The order on screen. Its first entry marks the sorted column. */
    readonly sort?: readonly ListSort[];
    /** Called with a sortable column's field when the viewer asks to sort by it. */
    readonly onSort?: (field: string) => void;
    /** Keys of rows that just arrived or changed. */
    readonly fresh?: readonly string[];
    readonly busy?: boolean;
    /** Shown instead of rows when there are none. */
    readonly empty?: React.ReactNode;
    readonly rowTestId?: (row: T) => string;
    readonly sortTestId?: (field: string) => string;
    /** Extra `data-*` attributes a row carries. */
    readonly rowAttributes?: (row: T) => Readonly<Record<string, string | undefined>>;
}

const NO_SORT: readonly ListSort[] = [];
const NO_KEYS: readonly string[] = [];

function ariaSort(sort: readonly ListSort[], field: string): "ascending" | "descending" | "none" {
    const head = sort[0];
    if (head?.field !== field) {
        return "none";
    }
    return head.direction === "asc" ? "ascending" : "descending";
}

function cellOf<T>(column: ListColumn<T>, row: T): React.ReactNode {
    if (column.render) {
        return column.render(row);
    }
    return String((row as Record<string, unknown>)[column.field] ?? "");
}

/**
 * Rows under sortable headers. It never sorts, filters or pages: it shows the
 * rows it is given and reports what the viewer asked for, so a live topic or
 * the host can answer. In a narrow container each row becomes a labelled card
 * with every field kept, and a sort menu stands in for the headers.
 */
export function ListTable<T>(props: ListTableProps<T>): React.ReactElement {
    const {
        label,
        columns,
        rows,
        rowKey,
        sort = NO_SORT,
        onSort,
        fresh = NO_KEYS,
        busy = false,
        empty,
        rowTestId,
        sortTestId,
        rowAttributes,
    } = props;
    const sortId = useId();
    const freshKeys = new Set(fresh);
    const titleColumn = columns.find((column) => column.title) ?? columns[0];
    const sortable = onSort ? columns.filter((column) => column.sortable) : [];
    const head = sort[0];

    return (
        <div className="dboard-list-scroll">
            {sortable.length > 0 && (
                <div className="dboard-list-phone-sort">
                    <label className="dboard-list-label" htmlFor={sortId}>
                        Sort by
                    </label>
                    <select
                        id={sortId}
                        className="dboard-list-filter"
                        value={head ? `${head.field}:${head.direction}` : ""}
                        onChange={(event) => onSort?.(event.target.value.split(":")[0] ?? "")}
                    >
                        {head === undefined && <option value="">Default</option>}
                        {sortable.map((column) => (
                            <option
                                key={column.field}
                                value={
                                    head?.field === column.field
                                        ? `${head.field}:${head.direction}`
                                        : `${column.field}:asc`
                                }
                            >
                                {column.label}
                            </option>
                        ))}
                    </select>
                </div>
            )}
            <table className="dboard-list-table" aria-busy={busy}>
                <caption className="dboard-visually-hidden">{label}</caption>
                <thead>
                    <tr>
                        {columns.map((column) => (
                            <th
                                key={column.field}
                                scope="col"
                                aria-sort={
                                    column.sortable ? ariaSort(sort, column.field) : undefined
                                }
                                data-align={column.align ?? "start"}
                            >
                                {column.sortable && onSort ? (
                                    <button
                                        type="button"
                                        className="dboard-list-sort"
                                        onClick={() => onSort(column.field)}
                                        data-testid={sortTestId?.(column.field)}
                                    >
                                        {column.label}
                                        <span
                                            className="dboard-list-sort-mark"
                                            aria-hidden="true"
                                        />
                                    </button>
                                ) : (
                                    column.label
                                )}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => {
                        const key = rowKey(row);
                        return (
                            <tr
                                key={key}
                                data-key={key}
                                data-fresh={freshKeys.has(key) ? "true" : undefined}
                                data-testid={rowTestId?.(row)}
                                {...rowAttributes?.(row)}
                            >
                                {columns.map((column) => (
                                    <td
                                        key={column.field}
                                        data-align={column.align ?? "start"}
                                        data-label={column.label}
                                        data-title={column === titleColumn ? "true" : undefined}
                                        data-phone={column.phone === false ? "hide" : undefined}
                                    >
                                        {cellOf(column, row)}
                                    </td>
                                ))}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            {rows.length === 0 && empty !== undefined && (
                <p className="dboard-list-empty">{empty}</p>
            )}
        </div>
    );
}
