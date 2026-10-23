// @ts-nocheck
/**
 * One line for several plugins.
 *
 * Contract copy of `pi-utils/extensions/status-row.ts` (version 1); keep the two in
 * sync, bump `version` in both when the shape changes.
 *
 * pi renders every `ctx.ui.setWidget(key, …)` as a child of a vertical container
 * (`renderWidgetContainer` just adds them in order), so two plugins that both want a
 * status line always get two lines. `setWidget` is keyed, though, so plugins can agree
 * on one key, keep a registry on `globalThis` and lay their parts out with pi-tui's
 * `HStack` - one line, several owners.
 *
 * The registry is the contract between the packages that use it: whoever gets there
 * first creates it, it survives being created by the other side, and the last part to
 * leave removes the widget.
 *
 * A part is a component factory, not a component: `render` builds fresh children every
 * frame, so a part keeps its own `MouseRegion` and clicks keep landing on the part that
 * owns the column.
 */
import * as TUI from "@earendil-works/pi-tui";

/** The widget key every participant uses - one key, one line. */
export const ROW_KEY = "status-row";

/** A part's component factory: the same shape as a `setWidget` factory. */
// type Part = (tui, theme) => Component

const GLOBAL_KEY = "__piStatusRow";

/**
 * The parts of pi-tui this module needs. A namespace import keeps an older build
 * (no `HStack`) loadable: the row then reports itself unavailable instead of failing
 * the extension at import time, and the caller falls back to its own widget.
 */
function api() {
  return { HStack: TUI.HStack, visibleWidth: TUI.visibleWidth };
}

/** True when this pi-tui can lay parts out side by side (older builds cannot). */
export function statusRowAvailable(tuiApi = api()) {
  return typeof tuiApi?.HStack === "function" && typeof tuiApi?.visibleWidth === "function";
}

function existing() {
  const row = globalThis[GLOBAL_KEY];
  return row?.version === 1 ? row : undefined;
}

function buildRegistry(tuiApi) {
  const parts = new Map();
  let row;
  row = {
    version: 1,
    parts,
    widgetSet: false,
    render: (tui, theme) => {
      row.tui = tui;
      // One HStack for the life of the widget, refilled on every render: a part that
      // joins later (or leaves) shows up on the next frame, without re-setting the
      // widget. `render(width)` returns the lines `Container` would, so pi's layout
      // engine owns the horizontal allocation.
      const stack = new tuiApi.HStack([]);
      let children = [];
      return {
        render(width) {
          stack.clear();
          children = [...parts.values()].map((part) => part(tui, theme));
          for (const child of children) stack.addChild(child);
          return stack.render(width);
        },
        invalidate() {
          stack.invalidate?.();
        },
        // pi's `Container.handleMouse` finds children by row only, which for a
        // horizontal stack would hand every click to the first part.
        handleMouse(event) {
          let start = 0;
          for (const child of children) {
            // The width `HStack` gives this child when the parts fit - which is every
            // terminal wide enough to show two short labels on one line.
            const width = child
              .render(event.width)
              .reduce((widest, line) => Math.max(widest, tuiApi.visibleWidth(line)), 0);
            if (event.x >= start && event.x < start + width) {
              return child.handleMouse?.({ ...event, x: event.x - start });
            }
            start += width;
          }
          return undefined;
        },
      };
    },
  };
  return row;
}

function registry(tuiApi = api()) {
  const built = existing();
  // Someone else's registry: add to it, but never replace its render or its keys.
  if (built) return built;
  if (!statusRowAvailable(tuiApi)) throw new Error("status row: this pi-tui has no HStack");
  const row = buildRegistry(tuiApi);
  globalThis[GLOBAL_KEY] = row;
  return row;
}

/**
 * Add (or replace) this plugin's part. The widget is set once, by whoever arrives
 * first; later joins only add a part and repaint.
 */
export function joinStatusRow(ui, id, part, tuiApi = api()) {
  const row = registry(tuiApi);
  const previous = row.parts.get(id);
  row.parts.set(id, part);
  if (!row.widgetSet) {
    try {
      ui.setWidget(ROW_KEY, row.render);
      row.widgetSet = true;
    } catch (err) {
      // Put the registry back the way we found it: a caller that falls back to its own
      // widget must not leave a part behind in a row nobody can see.
      if (previous) row.parts.set(id, previous);
      else row.parts.delete(id);
      throw err;
    }
  }
  row.tui?.requestRender();
}

/** Remove this plugin's part. Idempotent, and harmless for an id nobody joined with. */
export function leaveStatusRow(ui, id) {
  const row = existing();
  if (!row) return;
  row.parts.delete(id);
  if (row.parts.size > 0) {
    row.tui?.requestRender();
    return;
  }
  row.tui = undefined;
  if (row.widgetSet) {
    // Reset before the call: a throwing setWidget must not leave us thinking we own
    // a widget that is gone.
    row.widgetSet = false;
    ui.setWidget(ROW_KEY, undefined);
  }
}
