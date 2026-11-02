import type React from "react";
import { useRef, useState } from "react";
import type { TileSize, TileSizeLimits, TileState } from "../model.js";
import { useTileCommands } from "./hooks.js";

export interface TileFrameProps {
    readonly tile: TileState;
    readonly limits: TileSizeLimits;
    /** Grid width in cells, which also caps a tile's width. */
    readonly columns: number;
    readonly children: React.ReactNode;
}

interface Drag {
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    readonly start: TileSize;
    readonly colStep: number;
    readonly rowStep: number;
}

function clampTo(size: TileSize, limits: TileSizeLimits, columns: number): TileSize {
    const maxCols = Math.max(limits.min.cols, Math.min(limits.max.cols, columns));
    return {
        cols: Math.min(maxCols, Math.max(limits.min.cols, size.cols)),
        rows: Math.min(limits.max.rows, Math.max(limits.min.rows, size.rows)),
    };
}

/** The distance in pixels from one grid cell to the next, across and down. */
function gridSteps(grid: HTMLElement, columns: number): { colStep: number; rowStep: number } {
    const style = getComputedStyle(grid);
    const columnGap = Number.parseFloat(style.columnGap) || 0;
    const rowGap = Number.parseFloat(style.rowGap) || 0;
    const rowHeight = Number.parseFloat(style.gridAutoRows) || 0;
    const cellWidth = (grid.clientWidth - columnGap * (columns - 1)) / columns;
    return { colStep: cellWidth + columnGap, rowStep: rowHeight + rowGap };
}

const KEY_STEPS: Record<string, TileSize> = {
    ArrowRight: { cols: 1, rows: 0 },
    ArrowLeft: { cols: -1, rows: 0 },
    ArrowDown: { cols: 0, rows: 1 },
    ArrowUp: { cols: 0, rows: -1 },
};

/**
 * The chrome around every tile: its title, a refresh action, and a resize
 * handle that works by pointer drag or by arrow keys. The new size is sent as
 * a command, so the frame never decides it alone.
 */
export function TileFrame(props: TileFrameProps): React.ReactElement {
    const { tile, limits, columns, children } = props;
    const commands = useTileCommands(tile);
    const frame = useRef<HTMLElement>(null);
    const drag = useRef<Drag | null>(null);
    const [preview, setPreview] = useState<TileSize | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    const size = preview ?? tile.size;

    const send = async (next: TileSize): Promise<void> => {
        try {
            setFailed(null);
            await commands.resize(next);
        } catch (err) {
            setFailed(err instanceof Error ? err.message : String(err));
        } finally {
            setPreview(null);
        }
    };

    const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
        const grid = frame.current?.parentElement;
        if (!grid || event.button !== 0) {
            return;
        }
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            start: tile.size,
            ...gridSteps(grid, columns),
        };
    };

    const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) {
            return;
        }
        const cols =
            active.colStep > 0 ? Math.round((event.clientX - active.x) / active.colStep) : 0;
        const rows =
            active.rowStep > 0 ? Math.round((event.clientY - active.y) / active.rowStep) : 0;
        setPreview(
            clampTo(
                { cols: active.start.cols + cols, rows: active.start.rows + rows },
                limits,
                columns,
            ),
        );
    };

    const onPointerUp = async (event: React.PointerEvent<HTMLButtonElement>): Promise<void> => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) {
            return;
        }
        drag.current = null;
        if (preview && (preview.cols !== tile.size.cols || preview.rows !== tile.size.rows)) {
            await send(preview);
        } else {
            setPreview(null);
        }
    };

    const onKeyDown = async (event: React.KeyboardEvent<HTMLButtonElement>): Promise<void> => {
        const step = KEY_STEPS[event.key];
        if (!step) {
            return;
        }
        event.preventDefault();
        const next = clampTo(
            { cols: tile.size.cols + step.cols, rows: tile.size.rows + step.rows },
            limits,
            columns,
        );
        if (next.cols !== tile.size.cols || next.rows !== tile.size.rows) {
            await send(next);
        }
    };

    const onRefresh = async (): Promise<void> => {
        try {
            setFailed(null);
            await commands.refresh();
        } catch (err) {
            setFailed(err instanceof Error ? err.message : String(err));
        }
    };

    const titleId = `dboard-tile-title-${tile.dashboardId}-${tile.tileId}`;
    return (
        <article
            ref={frame}
            className="dboard-tile"
            aria-labelledby={titleId}
            data-testid={`dashboard-tile-${tile.tileId}`}
            data-cols={size.cols}
            data-rows={size.rows}
            data-resizing={preview ? "true" : undefined}
            style={
                { "--dboard-cols": size.cols, "--dboard-rows": size.rows } as React.CSSProperties
            }
        >
            <header className="dboard-tile-header">
                <h2 className="dboard-tile-title" id={titleId}>
                    {tile.title}
                </h2>
                <button
                    type="button"
                    className="dboard-tile-action"
                    onClick={onRefresh}
                    aria-label={`Refresh ${tile.title}`}
                    data-testid={`dashboard-tile-refresh-${tile.tileId}`}
                >
                    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                        <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
                    </svg>
                </button>
            </header>
            {failed && (
                <p className="dboard-tile-error" role="alert">
                    {failed}
                </p>
            )}
            <div className="dboard-tile-body">{children}</div>
            <button
                type="button"
                className="dboard-tile-resize"
                aria-label={`Resize ${tile.title}, ${size.cols} by ${size.rows}. Use arrow keys.`}
                data-testid={`dashboard-tile-resize-${tile.tileId}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => {
                    drag.current = null;
                    setPreview(null);
                }}
                onKeyDown={onKeyDown}
            >
                <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                    <path d="M11 4 4 11M11 8l-3 3" />
                </svg>
            </button>
        </article>
    );
}
