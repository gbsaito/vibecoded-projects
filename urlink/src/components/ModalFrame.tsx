import type { ReactNode } from "react";
import type { Theme } from "../theme.ts";
import { MODAL_HORIZONTAL_PAD, MODAL_VERTICAL_PAD } from "../layout.ts";

interface ModalFrameProps {
  theme: Theme;
  width: number;
  children: ReactNode;
}

export function ModalFrame(props: ModalFrameProps) {
  const { theme, width, children } = props;
  const inner = Math.max(12, width - 6);
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={100}
      alignItems="center"
      justifyContent="center"
    >
      <box
        width={inner}
        flexDirection="column"
        backgroundColor={theme.surface}
        border
        borderStyle="rounded"
        borderColor={theme.accent}
        paddingLeft={MODAL_HORIZONTAL_PAD}
        paddingRight={MODAL_HORIZONTAL_PAD}
        paddingTop={MODAL_VERTICAL_PAD}
        paddingBottom={MODAL_VERTICAL_PAD}
        zIndex={101}
      >
        {children}
      </box>
    </box>
  );
}
