import { getTheme, themeLabel, themeNames } from "../theme.ts";
import type { Theme } from "../theme.ts";
import { ModalFrame } from "./ModalFrame.tsx";
import { PANEL_SECTION_GAP } from "../layout.ts";

interface ThemePanelProps {
  theme: Theme;
  width: number;
  activeName: string;
  index: number;
}

export function ThemePanel(props: ThemePanelProps) {
  const { theme, width, activeName, index } = props;
  return (
    <ModalFrame theme={theme} width={width}>
      <text fg={theme.accent}>
        <b>Themes</b>
      </text>
      <box height={PANEL_SECTION_GAP} />
      {themeNames.map((name, i) => {
        const t = getTheme(name);
        const selected = i === index;
        const active = name === activeName;
        return (
          <box
            key={name}
            width="100%"
            height={1}
            flexDirection="row"
            backgroundColor={selected ? theme.selectedBg : undefined}
          >
            <text width={2} fg={selected ? theme.selectedFg : theme.dim}>
              {selected ? "▸" : " "}
            </text>
            <text width={14} fg={selected ? theme.title : theme.text}>
              {themeLabel(name)}
            </text>
            <text flexGrow={1} wrapMode="none">
              <span fg={t.bg}>■</span>
              <span fg={t.accent}>■</span>
              <span fg={t.tag}>■</span>
              <span fg={t.description}>■</span>
              <span fg={t.text}>■</span>
            </text>
            <text fg={theme.tag}>{active ? "current" : ""}</text>
          </box>
        );
      })}
      <box height={PANEL_SECTION_GAP} />
      <text fg={theme.faint}>↑/↓ choose · enter apply · esc close</text>
    </ModalFrame>
  );
}
