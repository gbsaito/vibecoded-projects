// Shared layout constants for the whole TUI. Every padding/margin value lives
// here so sidebar, main panel, modals and bookmark rows stay consistent.

// Shared inner gutter: row/column inset for top-level regions (sidebar, main
// panel) and single-row spacings.
export const PAD = 1;

// Modal inner padding (top/bottom rows and left/right columns).
export const MODAL_VERTICAL_PAD = 1;
export const MODAL_HORIZONTAL_PAD = 2;

// Vertical gap between bookmark entries. Zero means adjacent rows, no blank
// spacer lines between bookmarks.
export const BOOKMARK_VERTICAL_GAP = 0;

// Vertical spacer row between modal content blocks (title -> fields -> hint).
export const PANEL_SECTION_GAP = 1;
