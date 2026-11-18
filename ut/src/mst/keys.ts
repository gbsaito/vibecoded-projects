/**
 * Key handling.
 *
 * Extracted from the entry point so the bindings can be unit tested: the most
 * valuable regression is "status keys never swallow typed characters", which
 * is impossible to guard while the handler is unreachable.
 *
 * Key names are read off OpenTUI's parser, not assumed:
 *  - Uppercase letters arrive with `name` lower-cased and `shift: true`.
 *  - Shift+Tab arrives as name "tab" with `shift: true`.
 *  - Digits 1-5 select the five status tabs (`Tabs[0]` is search).
 */

import type { App } from "./app.ts";
import { Tabs, isSearchTab } from "./app.ts";
import { Status } from "./model.ts";

/**
 * The key shape the handler needs. OpenTUI's KeyEvent satisfies it, and so
 * does a gamepad button, so both feed the same bindings.
 */
export interface KeyLike {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  raw?: string;
}

/** Grid: move one cell left/right, wrapping within the current page. */
function gridHorizontal(app: App, dir: 1 | -1): void {
  const cols = app.gridColumns(app.bodyWidth());
  const total = app.visible().length;
  if (total === 0) return;
  const rows = app.gridRows(app.viewHeight - 1);
  const perPage = cols * rows;
  const pageStart = app.gridPage * perPage;
  const pageEnd = Math.min(pageStart + perPage, total);
  const pageItems = pageEnd - pageStart;
  if (pageItems === 0) return;
  const posInPage = app.selected - pageStart;
  const col = posInPage % cols;
  const row = Math.floor(posInPage / cols);
  if (dir > 0) {
    if (col < cols - 1) {
      // stay in the row
      if (posInPage + 1 < pageItems) app.selected++;
    } else if (row + 1 < rows && (row + 1) * cols < pageItems) {
      // last col: first col of the next row
      app.selected = pageStart + (row + 1) * cols;
    } else {
      // wrap to the first cell
      app.selected = pageStart;
    }
  } else if (col > 0) {
    app.selected--;
  } else if (row > 0) {
    // first col: last col of the previous row
    const prevRowLastCol = pageStart + (row - 1) * cols + (cols - 1);
    if (prevRowLastCol < pageEnd) app.selected = Math.min(prevRowLastCol, pageEnd - 1);
  } else {
    // wrap to the last cell on the page
    const lastRow = Math.floor((pageItems - 1) / cols);
    app.selected = pageStart + lastRow * cols + Math.min(cols - 1, pageItems - 1 - lastRow * cols);
  }
}

/** Grid: move a whole page forward/back. */
function gridPage(app: App, dir: 1 | -1): void {
  const rows = app.gridRows(app.viewHeight - 1);
  const perPage = app.gridColumns(app.bodyWidth()) * rows;
  if (perPage <= 0) return;
  const totalPages = Math.ceil(app.visible().length / perPage);
  if (dir > 0) {
    if (app.gridPage < totalPages - 1) {
      app.gridPage++;
      app.selected = app.gridPage * perPage;
    }
  } else if (app.gridPage > 0) {
    app.gridPage--;
    app.selected = app.gridPage * perPage;
  }
}

/**
 * Apply one keypress. Returns true when the app should exit.
 *
 * Precedence:
 *  1. The help overlay swallows input until dismissed.
 *  2. Global keys, because the app starts with the results focused (`/`
 *     opens the search box).
 *  3. Literal characters go to the box.
 *  4. Once the box is left do letters become commands again.
 */
export function handleKey(app: App, k: KeyLike): boolean {
  if (k.ctrl && (k.name === "c" || k.name === "d")) return true;
  // Ctrl+H is backspace on many terminals; ignore it to avoid invoking
  // the terminal pager (less) or other shell bindings.
  if (k.ctrl && k.name === "h") return false;

  if (app.showHelp) {
    if (k.name === "?" || k.name === "escape" || k.name === "return" || k.name === "enter" || k.name === "q") {
      if (k.name === "q") return true;
      app.showHelp = false;
    }
    return false;
  }

  // Command palette swallows input while open.
  if (app.commandPalette.visible) {
    return app.commandPalette.handleKey(k);
  }

  if (k.name === "?") {
    app.showHelp = true;
    return false;
  }
  if (k.name === ":" || (k.ctrl && k.name === "p")) {
    app.openCommandPalette();
    return false;
  }
  // Quitting is a browse-mode command; while the search box is focused the
  // character is query text, not a binding.
  if (k.name === "q" && !app.focused) return true;

  const key = k.shift && k.name.length === 1 ? k.name.toUpperCase() : k.name;
  const back = k.name === "tab" && k.shift;
  const digit = /^[1-5]$/.test(key) ? Number(key) : 0;
  // Grid is a status-tab view; the search tab always lists, so grid movement
  // must not engage there even if grid was toggled earlier.
  const grid = app.grid && app.currentStatus !== null;

  if (digit) {
    app.setTab(digit);
    return false;
  }

  const addSelected = () => {
    const added = app.addSelectedHit();
    if (added) void app.enrich(added);
  };

  // --- focused box -------------------------------------------------------
  if (app.focused) {
    switch (k.name) {
      case "escape":
        // Leave the box but keep the query and its results, like Enter;
        // backspace edits the text once the box is reopened with `/`.
        app.focused = false;
        return false;
      case "return":
      case "enter":
        // Enter commits the query and hands focus to the results, so typing
        // afterwards is treated as commands, not more query text. `/` brings
        // the box back.
        app.focused = false;
        if (isSearchTab(app.current)) void app.searchNow();
        return false;
      case "backspace":
        app.query = [...app.query].slice(0, -1).join("");
        app.queryChanged();
        return false;
      case "tab": {
        const wasSearch = isSearchTab(app.current);
        app.setTab((app.tabIndex + (back ? Tabs.length - 1 : 1)) % Tabs.length);
        if (wasSearch && !isSearchTab(app.current)) app.clearQuery();
        return false;
      }
      case "down":
        app.moveSelection(1);
        return false;
      case "up":
        app.moveSelection(-1);
        return false;
      case "left":
      case "right": {
        // The box is focused, but grid navigation still applies.
        if (grid) {
          const dir: 1 | -1 = k.name === "right" ? 1 : -1;
          if (k.shift) gridPage(app, dir);
          else gridHorizontal(app, dir);
        }
        return false;
      }
      default:
        break;
    }

    const raw = k.raw ?? "";
    if (!k.ctrl && raw && [...raw].length === 1 && raw >= " " && raw !== "\t") {
      app.query += raw;
      app.queryChanged();
    }
    return false;
  }

  // --- browse mode -------------------------------------------------------
  switch (k.name) {
    case "tab":
      app.setTab((app.tabIndex + (back ? Tabs.length - 1 : 1)) % Tabs.length);
      return false;
    case "right":
    case "l":
      if (grid) {
        if (k.shift) gridPage(app, 1);
        else gridHorizontal(app, 1);
        return false;
      }
      app.setTab((app.tabIndex + 1) % Tabs.length);
      return false;
    case "left":
    case "h":
      if (grid) {
        if (k.shift) gridPage(app, -1);
        else gridHorizontal(app, -1);
        return false;
      }
      app.setTab((app.tabIndex + Tabs.length - 1) % Tabs.length);
      return false;
    case "return":
    case "enter":
      // Enter acts on the highlighted hit. The box is opened with `/` only,
      // so Enter never steals focus from the results.
      if (isSearchTab(app.current)) addSelected();
      return false;
    case "down":
      app.moveSelection(grid ? app.gridColumns(app.bodyWidth()) : 1);
      return false;
    case "up":
      app.moveSelection(grid ? -app.gridColumns(app.bodyWidth()) : -1);
      return false;
    case "j":
      app.moveSelection(grid ? app.gridColumns(app.bodyWidth()) : 1);
      return false;
    case "k":
      app.moveSelection(grid ? -app.gridColumns(app.bodyWidth()) : -1);
      return false;
    case "home":
      app.selected = 0;
      return false;
    case "end":
      app.selected = Math.max(0, app.visible().length - 1);
      return false;
    default:
      break;
  }

  switch (key) {
    case "w":
      app.setStatus(Status.Watchlist);
      return false;
    case "W":
      app.setStatus(Status.Watching);
      return false;
    case "C":
      app.setStatus(Status.Completed);
      return false;
    case "o":
    case "O":
      app.setStatus(Status.OnHold);
      return false;
    case "d":
      app.setStatus(Status.Dropped);
      return false;
    case "c":
      if (isSearchTab(app.current)) addSelected();
      return false;
    case "D": {
      const removed = app.deleteSelected();
      app.notify(removed ? `deleted ${removed.title}` : "nothing selected to delete");
      return false;
    }
    case "+":
    case "=":
      app.rate("up");
      return false;
    case "-":
    case "_":
      app.rate("down");
      return false;
    case "e":
      app.episode("up");
      return false;
    case "E":
      app.episode("down");
      return false;
    case "s":
      app.cycleSort();
      return false;
    case "S":
      app.reverseSort();
      return false;
    case "v":
      app.grid = !app.grid;
      if (app.grid) app.compact = false;
      app.selected = 0;
      app.gridPage = 0;
      if (app.grid) {
        app.query = "";
        app.hits = [];
        app.queryChanged();
      }
      return false;
    case "V":
      app.compact = !app.compact;
      if (app.compact) app.grid = false;
      app.selected = 0;
      return false;
    case "p":
      app.openCommandPalette();
      return false;
    case "u":
      app.openStreamingUrl();
      return false;
    case "n":
      app.toggleNsfw();
      return false;
    case "/":
      // Reopen the query box with the current query still in it, so it can be
      // refined instead of retyped.
      app.focused = true;
      return false;
    default:
      return false;
  }
}
