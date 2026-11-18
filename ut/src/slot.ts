/**
 * The contract every hosted tracker in `ut` satisfies.
 *
 * One OpenTUI renderer, one terminal: `ut` creates the renderer and hands a
 * renderable root to each tracker slot, then routes keys — the host menu
 * shows between trackers; everything else goes to the active one.
 */

import type { CliRenderer, Renderable } from "@opentui/core";

/** Context handed to a tracker when it is hosted. */
export interface SlotCtx {
  renderer: CliRenderer;
  /** Container for this tracker; slots add their own absolute children to it. */
  root: Renderable;
  /** True when the user asked to quit the whole TUI. */
  quit(): void;
}

/** The key shape the hosted handler consumes; OpenTUI's KeyEvent satisfies it. */
export interface KeyLike {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  raw?: string;
  stopPropagation?: () => void;
}

/** One hosted tracker: the key half, plus lifecycle hooks the host owns. */
export interface TrackerSlot {
  /** Tracker name for status/branding. */
  readonly name: string;
  /** Handle one key. Return true when this tracker asked to leave (host menu). */
  key(k: KeyLike): boolean;
  /** Called when the tracker becomes the active tab. */
  activate(): void;
  /** Called when the tracker leaves the active tab; stop its timers. */
  deactivate(): void;
  /** Called when the terminal resizes while this tracker is active. */
  resize(): void;
  /** Fire-and-forget status line. */
  announce(msg: string): void;
  /** Tear down in-flight work (debounce, ticker, app dispose). */
  dispose(): void;
}
