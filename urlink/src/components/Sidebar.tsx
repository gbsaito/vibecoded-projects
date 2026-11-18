import type { ReactNode } from "react";
import { TextAttributes, type MouseEvent } from "@opentui/core";
import { PAD } from "../layout.ts";
import type { Theme } from "../theme.ts";

interface SidebarProps {
  theme: Theme;
  width: number;
  entries: string[];
  tagIndex: number;
  tagFilter: string[];
  onMoveTag: (dir: number) => void;
  onToggleTag: (tag: string) => void;
}

// Selection marker lives in a gutter reserved on every row, so item text never
// shifts horizontally when the selection moves.
const MARKER = "▸";
const GUTTER = MARKER.length + 1;

function gutter(marker: string): string {
  return marker.padEnd(GUTTER);
}

interface LineProps {
  children: ReactNode;
  marker?: string;
  markerFg?: string;
}

function Line(props: LineProps) {
  return (
    <box paddingLeft={PAD}>
      <text wrapMode="none">
        <span fg={props.markerFg}>{gutter(props.marker ?? "")}</span>
        {props.children}
      </text>
    </box>
  );
}

export function Sidebar(props: SidebarProps) {
  const { theme, width, entries, tagIndex, tagFilter } = props;

  const handleRootMouseDown = (event: MouseEvent) => {
    if (event.type !== "down" || event.button !== 0) return;
    const index = event.y - PAD - 1; // column top (PAD) + Tags heading row, then entries start
    if (index < 0 || index >= entries.length) return;
    props.onToggleTag(entries[index] ?? "");
  };

  return (
    <box flexDirection="column" width={width} height="100%" style={{ backgroundColor: theme.sidebarBg }} onMouseDown={handleRootMouseDown}>
      <box flexDirection="column" flexGrow={1} paddingTop={PAD}>
        <Line>
          <span fg={theme.dim}>Tags</span>
        </Line>
        {entries.map((t, i) => {
          const selected = i === tagIndex;
          const active = tagFilter.includes(t);
          const isAll = t === "All";
          const isTrash = t === "Trash";
          const label = isAll ? "All" : isTrash ? "Trash" : `#${t}`;
          return (
            <Line key={t} marker={selected ? MARKER : ""} markerFg={theme.selectedFg}>
              <span fg={selected ? theme.title : theme.tag}>{label}</span>
              {active && !isTrash ? " ✓" : ""}
            </Line>
          );
        })}
        {entries.length === 0 ? (
          <Line>
            <span fg={theme.dim}>no tags</span>
          </Line>
        ) : null}
      </box>
      <box flexDirection="column" paddingTop={PAD}>
        <Line>
          <span fg={theme.dim}>←/→ move</span>
        </Line>
        <Line>
          <span fg={theme.dim}>space toggle</span>
        </Line>
      </box>
      <box flexDirection="column" paddingTop={PAD} paddingBottom={PAD}>
        <Line>
          <span fg={theme.title} attributes={TextAttributes.BOLD}>
            urlink
          </span>
        </Line>
      </box>
    </box>
  );
}
