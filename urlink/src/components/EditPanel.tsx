import type { Theme } from "../theme.ts";
import type { EditState, EditSection } from "../types.ts";
import { ModalFrame } from "./ModalFrame.tsx";
import { BlinkingCursor } from "./BlinkingCursor.tsx";
import { PANEL_SECTION_GAP } from "../layout.ts";

interface EditPanelProps {
  edit: EditState;
  theme: Theme;
  width: number;
  tagSuggest?: string[];
}

const SECTIONS: Array<{ key: EditSection; label: string }> = [
  { key: "url", label: "URL" },
  { key: "tags", label: "Tags" },
  { key: "title", label: "Title" },
  { key: "description", label: "Description" },
];

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return value.slice(0, max - 3) + "...";
}

export function EditPanel(props: EditPanelProps) {
  const { edit: e, theme, width } = props;
  const inner = Math.max(12, width - 6);
  const valueWidth = Math.max(4, inner - 14 - 1);
  const valueFor = (key: EditSection): string => {
    switch (key) {
      case "url":
        return e.url;
      case "tags":
        return e.tagsText;
      case "title":
        return e.title;
      case "description":
        return e.description;
    }
  };
  const displayValue = (key: EditSection): string => {
    if (key === "url" && e.fetching) return "fetching...";
    const value = valueFor(key);
    return value.length === 0 ? "(empty)" : value;
  };
  const title = e.mode === "add" ? "New bookmark" : "Edit bookmark";
  return (
    <ModalFrame theme={theme} width={width}>
        <text fg={theme.accent}>
          <b>{title}</b>
        </text>
        <box height={PANEL_SECTION_GAP} />
        {SECTIONS.map((s) => {
          const focused = e.focus === s.key;
          const shown = clip(displayValue(s.key), valueWidth);
          const caret = focused ? (valueFor(s.key).length === 0 ? shown.length : Math.max(0, Math.min(e.cursor, shown.length))) : 0;
          // Ghost completion: only for a full suggestion prefix typed at the end of the field.
          const suggest = focused ? props.tagSuggest?.[0] ?? null : null;
          let ghost = "";
          if (suggest) {
            const value = valueFor(s.key);
            const word = value.slice(0, caret).split(/\s+/).pop() ?? "";
            if (caret === value.length && suggest.toLowerCase().startsWith(word.toLowerCase())) {
              ghost = suggest.slice(word.length);
            }
          }
          return (
            <box key={s.key} width="100%" height={1} flexDirection="row">
              <text width={14} fg={focused ? theme.text : theme.faint}>
                {focused ? `▸ ${s.label}` : `  ${s.label}`}
              </text>
              <text flexGrow={1} fg={focused ? theme.title : theme.subtle} wrapMode="none">
                {focused ? (
                  <>
                    {shown.slice(0, caret)}
                    {ghost ? (
                      // The cursor sits "on" the first suggested character instead of
                      // pushing the ghost text aside.
                      <>
                        <span fg={theme.accent}>{ghost[0]}</span>
                        <span fg={theme.faint}>{ghost.slice(1)}</span>
                      </>
                    ) : (
                      <BlinkingCursor theme={theme} resetKey={`${s.key}:${e.cursor}`} hiddenColor={theme.surface} />
                    )}
                    {shown.slice(caret)}
                  </>
                ) : (
                  shown
                )}
              </text>
            </box>
          );
        })}
        {e.error ? <text fg="#ff5555">{e.error}</text> : null}
        <box height={PANEL_SECTION_GAP} />
        <text fg={theme.faint} wrapMode="none">
          ↑↓ field · tab completes tag · ←/→ caret · ctrl/alt+⌫ word · enter save · esc cancel
        </text>
      </ModalFrame>
  );
}
