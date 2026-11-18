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
 *  - Digits 1-3 select the three tabs (`Tabs[0]` is search).
 */

import type { KeyEvent } from "@opentui/core";
import type { App } from "./app.ts";
import { Tabs, isSearchTab } from "./app.ts";
import { Status } from "./model.ts";

/**
 * Apply one keypress. Returns true when the app should exit.
 *
 * Precedence:
 *  1. The help overlay swallows input until dismissed.
 *  2. While the search box is focused, editing keys and every printable
 *     character belong to the box (`q`, `?` and digits included).
 *  3. Once the box is left, letters and digits become commands again.
 */
export function handleKey(app: App, k: KeyEvent): boolean {
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

  const addSelected = () => {
    const added = app.addSelectedHit();
    if (added) void app.enrich(added);
  };
  const back = k.name === "tab" && k.shift;

  // --- focused box -------------------------------------------------------
  // A focused box owns every printable key, including `q`, `?` and digits:
  // game titles contain all of them. Commands resume on Escape or Tab.
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
        // Commit the query and return to browse mode so the list binds work.
        app.focused = false;
        return false;
      }
      case "down":
        app.moveSelection(1);
        return false;
      case "up":
        app.moveSelection(-1);
        return false;
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
  if (app.coverPickerOpen) {
    const rawDigit = k.raw && /^[1-9]$/.test(k.raw) ? k.raw : (k.name && /^[1-9]$/.test(k.name) ? k.name : null);
    if (rawDigit) {
      app.chooseCover(Number(rawDigit));
      return false;
    }
    if (k.name === "escape" || k.name === "return" || k.name === "enter") {
      if (k.name === "escape") app.closeCoverPicker();
      else {
        // Enter confirms first option
        app.chooseCover(1);
      }
      return false;
    }
  }
  if (k.name === "?") {
    app.showHelp = true;
    return false;
  }
  if (k.name === "q") return true;
  if (k.name === ":" || (k.ctrl && k.name === "p") || (k.name === "p" && !k.shift)) {
    app.openCommandPalette();
    return false;
  }
  if (k.name === "return" || k.name === "enter") {
    if (isSearchTab(app.current)) addSelected();
    return false;
  }

  const key = k.shift && k.name.length === 1 ? k.name.toUpperCase() : k.name;
  const digit = /^[1-3]$/.test(key) ? Number(key) : 0;

  if (digit) {
    app.setTab(digit - 1);
    return false;
  }

  switch (k.name) {
    case "tab":
      app.setTab((app.tabIndex + (back ? Tabs.length - 1 : 1)) % Tabs.length);
      return false;
    case "right":
    case "l":
      if (app.carouselActive()) {
        app.moveSelection(1);
        return false;
      }
      app.setTab((app.tabIndex + 1) % Tabs.length);
      return false;
    case "left":
    case "h":
      if (app.carouselActive()) {
        app.moveSelection(-1);
        return false;
      }
      app.setTab((app.tabIndex + Tabs.length - 1) % Tabs.length);
      return false;
    case "down":
      app.moveSelection(1);
      return false;
    case "up":
      app.moveSelection(-1);
      return false;
    case "j":
      app.moveSelection(1);
      return false;
    case "k":
      app.moveSelection(-1);
      return false;
    case "home":
      if (isSearchTab(app.current)) app.hitSel = 0;
      else app.selected = 0;
      return false;
    case "end":
      if (isSearchTab(app.current)) app.hitSel = Math.max(0, app.hits.length - 1);
      else app.selected = Math.max(0, app.visible().length - 1);
      return false;
    default:
      break;
  }

  switch (key) {
    case "b":
      app.setStatus(Status.Backlog);
      return false;
    case "g":
    case "W":
      app.setStatus(Status.Playing);
      return false;
    case "y":
    case "C":
      app.setStatus(Status.Played);
      return false;
    case "a":
    case "d":
      app.setStatus(Status.Abandoned);
      return false;
    case "w":
      app.toggleWishlist();
      return false;
    case "x":
      app.toggleHundred();
      return false;
    case "f":
      app.cycleFilter();
      return false;
    case "P":
      app.cyclePlatform();
      return false;
    case "r":
      void app.refreshCoverArt();
      return false;
    case "R":
      app.reloadAll();
      return false;
    case "A":
      void app.cycleCoverArt();
      return false;
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
    case "6":
    case "7":
    case "8":
    case "9":
      if (app.coverPickerOpen) {
        app.chooseCover(Number(key));
      }
      return false;
    case "escape":
      if (app.coverPickerOpen) {
        app.closeCoverPicker();
        return false;
      }
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
      app.playtime("up");
      return false;
    case "E":
      app.playtime("down");
      return false;
    case "s":
      app.cycleSort();
      return false;
    case "S":
      app.reverseSort();
      return false;
    case "v":
      if (isSearchTab(app.current)) return false;
      app.cycleView();
      return false;
    case "V":
      if (isSearchTab(app.current)) return false;
      app.compact = !app.compact;
      if (app.compact) app.carousel = false;
      app.selected = 0;
      return false;
    case "u":
      app.openStorePage();
      return false;
    case "/":
      // Reopen the box fresh: after Enter hands focus back to the results, a
      // new search starts from an empty query.
      app.clearQuery();
      app.focused = true;
      return false;
    default:
      return false;
  }
}
