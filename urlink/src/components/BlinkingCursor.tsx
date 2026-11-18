import { useEffect, useState } from "react";
import type { Theme } from "../theme.ts";

interface BlinkingCursorProps {
  theme: Theme;
  resetKey?: unknown;
  hiddenColor?: string;
}

export function BlinkingCursor(props: BlinkingCursorProps) {
  const { theme, resetKey, hiddenColor } = props;
  const [on, setOn] = useState(true);

  useEffect(() => {
    setOn(true);
    const id = setInterval(() => setOn((value) => !value), 530);
    return () => clearInterval(id);
  }, [resetKey]);

  if (hiddenColor) {
    return <span fg={on ? theme.accent : hiddenColor}>█</span>;
  }
  return <span fg={theme.accent}>{on ? "█" : " "}</span>;
}
