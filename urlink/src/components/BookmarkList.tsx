import type { Theme } from "../theme.ts";
import { BOOKMARK_VERTICAL_GAP } from "../layout.ts";
import type { Bookmark } from "../types.ts";
import { hostnameOf } from "../store.ts";

interface BookmarkListProps {
  bookmarks: Bookmark[];
  selectedId: string | null;
  theme: Theme;
  focused?: boolean;
}

export function BookmarkList(props: BookmarkListProps) {
  const { bookmarks, selectedId, theme, focused = true } = props;
  if (bookmarks.length === 0) {
    return (
      <box flexDirection="column">
        <text fg={theme.dim}>No bookmarks found.</text>
        <text fg={theme.dim}>Press a to add one.</text>
      </box>
    );
  }
  return (
    <scrollbox focused={focused}>
      <box flexDirection="column" rowGap={BOOKMARK_VERTICAL_GAP}>
        {bookmarks.map((b) => {
        const selected = b.id === selectedId;
        const title = b.title || hostnameOf(b.url);
        return (
          <box key={b.id} style={selected ? { backgroundColor: theme.selectedBg } : undefined}>
            <text wrapMode="none" truncate>
              <span fg={theme.title}>{title}</span>
              {b.tags.map((t) => (
                <span key={t}>
                  {" "}
                  <span fg={theme.tag}>#{t}</span>
                </span>
              ))}
            </text>
            {b.description ? (
              <text fg={theme.description} wrapMode="none" truncate height={1}>
                {b.description}
              </text>
            ) : null}
          </box>
        );
      })}
      </box>
    </scrollbox>
  );
}
