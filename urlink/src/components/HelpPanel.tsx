import type { Theme } from "../theme.ts";
import { ModalFrame } from "./ModalFrame.tsx";
import { PANEL_SECTION_GAP } from "../layout.ts";

interface HelpPanelProps {
  theme: Theme;
  width: number;
}

const ROWS: Array<{ keys: string; desc: string }> = [
  { keys: "a", desc: "add bookmark" },
  { keys: "e", desc: "edit bookmark" },
  { keys: "d", desc: "delete (archive)" },
  { keys: "A", desc: "trash view" },
  { keys: "r", desc: "restore from trash" },
  { keys: "/", desc: "fuzzy find" },
  { keys: "o", desc: "open url" },
  { keys: "s", desc: "cycle sort (name / date / url)" },
  { keys: "y", desc: "yank selection url" },
  { keys: "x", desc: "export bookmarks" },
  { keys: "i", desc: "import bookmarks" },
  { keys: "T", desc: "themes" },
  { keys: "?", desc: "help" },
  { keys: "q", desc: "quit" },
];

export function HelpPanel(props: HelpPanelProps) {
  const { theme, width } = props;
  const inner = Math.max(12, width - 6);
  const boxWidth = Math.min(58, inner);
  return (
    <ModalFrame theme={theme} width={width}>
        <text fg={theme.accent}>
          <b>Help</b>
        </text>
        <box height={PANEL_SECTION_GAP} />
        {ROWS.map((r) => (
          <box key={r.keys} width="100%" height={1} flexDirection="row">
            <text width={6} fg={theme.text}>
              {r.keys}
            </text>
            <text flexGrow={1} fg={theme.subtle} wrapMode="none">
              {r.desc}
            </text>
          </box>
        ))}
        <box height={PANEL_SECTION_GAP} />
        <text fg={theme.faint}>esc close · ? help</text>
      </ModalFrame>
  );
}
