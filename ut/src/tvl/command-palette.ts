/**
 * Command palette.
 *
 * Two-level: top-level ACTIONS, then (for actions with sub-items) a list of
 * choices. Typing filters the current level. Enter selects/drills in; Esc
 * goes back one level (or closes at the top).
 */

import { BoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import { App } from "./app.ts";
import { Sort, Status, statusLabel, statusIcon, STATUS_ALL } from "./model.ts";

const clip = (s: string, n: number): string => {
  const chars = Array.from(s);
  return chars.length <= n ? s : chars.slice(0, Math.max(0, n)).join("");
};

export interface Command {
  id: string;
  label: string;
  icon?: string;
  /** Sub-items; if present, selecting drills into them instead of executing. */
  children?: Command[];
  execute?(app: App): void;
}

export class CommandPalette {
  private readonly renderer: CliRenderer | null;
  /** Hosted by ut: renderables are added here (defaults to the renderer root). */
  private hostRoot: Renderable | null = null;
  private box!: BoxRenderable;
  private title!: TextRenderable;
  private filterBox!: TextRenderable;
  private items: TextRenderable[] = [];
  private footer!: TextRenderable;

  private root: Command[] = [];
  private stack: Command[][] = [];
  private filter = "";
  private filtered: Command[] = [];
  private selected = 0;
  private _visible = false;
  private onClose: (() => void) | null = null;

  get visible(): boolean {
    return this._visible;
  }

  constructor(renderer: CliRenderer | null, root?: Renderable) {
    this.renderer = renderer;
    this.hostRoot = root ?? renderer?.root ?? null;
  }

  private get host(): Renderable {
    if (!this.renderer) throw new Error("hosted command palette requires a renderer");
    return this.hostRoot ?? this.renderer.root;
  }

  private createElements(renderer: CliRenderer): void {
    this.box = new BoxRenderable(renderer, {
      position: "absolute",
      flexShrink: 0,
      backgroundColor: "#11141c",
      border: ["top", "bottom", "left", "right"],
      borderColor: "#7aa2f7",
      zIndex: 100,
    });
    this.host.add(this.box);

    this.title = new TextRenderable(renderer, {
      position: "absolute",
      flexShrink: 0,
      content: "",
      fg: "#7aa2f7",
      zIndex: 100,
    });
    this.host.add(this.title);

    this.filterBox = new TextRenderable(renderer, {
      position: "absolute",
      flexShrink: 0,
      content: "",
      fg: "#d8dee9",
      zIndex: 100,
    });
    this.host.add(this.filterBox);

    this.items = Array.from({ length: 24 }, () =>
      new TextRenderable(renderer, {
        position: "absolute",
        flexShrink: 0,
        content: "",
        fg: "#d8dee9",
        zIndex: 100,
      }),
    );
    for (const item of this.items) this.host.add(item);

    this.footer = new TextRenderable(renderer, {
      position: "absolute",
      flexShrink: 0,
      content: "type to filter  ↑/↓ navigate  Enter select  Esc back/close",
      fg: "#6b7280",
      zIndex: 100,
    });
    this.host.add(this.footer);
  }

  setCommands(commands: Command[]): void {
    this.root = commands;
  }

  open(onClose?: () => void): void {
    if (!this.renderer) {
      this._visible = true;
      this.stack = [this.root];
      this.filter = "";
      this.applyFilter();
      this.selected = 0;
      this.onClose = onClose ?? null;
      return;
    }
    if (!this.box) {
      this.createElements(this.renderer);
    }
    this._visible = true;
    this.stack = [this.root];
    this.filter = "";
    this.applyFilter();
    this.selected = 0;
    this.onClose = onClose ?? null;
    this.render();
  }

  close(): void {
    this._visible = false;
    this.hideAll();
    this.onClose?.();
    this.onClose = null;
  }

  private hideAll(): void {
    if (this.box) this.box.visible = false;
    if (this.title) this.title.visible = false;
    if (this.filterBox) this.filterBox.visible = false;
    if (this.footer) this.footer.visible = false;
    for (const item of this.items) item.visible = false;
  }

  private current(): Command[] {
    return this.stack[this.stack.length - 1] ?? [];
  }

  private applyFilter(): void {
    const q = this.filter.trim().toLowerCase();
    const base = this.current();
    if (!q) {
      this.filtered = [...base];
    } else {
      this.filtered = base.filter((c) => c.label.toLowerCase().includes(q));
    }
    this.selected = 0;
  }

  handleKey(key: { name: string; ctrl?: boolean; shift?: boolean; raw?: string }): boolean {
    if (!this._visible) return false;

    switch (key.name) {
      case "escape":
        if (this.stack.length > 1) {
          this.stack.pop();
          this.filter = "";
          this.applyFilter();
          this.render();
        } else {
          this.close();
        }
        return false;
      case "up":
        this.selected = Math.max(0, this.selected - 1);
        this.render();
        return false;
      case "down":
        this.selected = Math.min(this.filtered.length - 1, this.selected + 1);
        this.render();
        return false;
      case "enter":
      case "return": {
        const cmd = this.filtered[this.selected];
        if (cmd) {
          if (cmd.children && cmd.children.length) {
            this.stack.push(cmd.children);
            this.filter = "";
            this.applyFilter();
            this.render();
          } else if (cmd.execute) {
            cmd.execute(this.app);
            this.close();
          }
        }
        return false;
      }
      case "backspace":
        this.filter = this.filter.slice(0, -1);
        this.applyFilter();
        this.render();
        return false;
      default:
        break;
    }

    const raw = key.raw ?? "";
    if (!key.ctrl && raw && [...raw].length === 1 && raw >= " " && raw !== "\t") {
      this.filter += raw;
      this.applyFilter();
      this.render();
    }
    return false;
  }

  app!: App;

  private render(): void {
    if (!this._visible || !this.renderer) return;

    const w = this.renderer.width;
    const h = this.renderer.height;

    const boxW = Math.min(58, w - 4);
    const boxH = Math.min(this.filtered.length + 5, h - 4);
    const bx = Math.floor((w - boxW) / 2);
    const by = Math.floor((h - boxH) / 2);

    this.box.left = bx;
    this.box.top = by;
    this.box.width = boxW;
    this.box.height = boxH;
    this.box.visible = true;

    const isSub = this.stack.length > 1;
    this.title.left = bx + 2;
    this.title.top = by + 1;
    this.title.width = boxW - 4;
    this.title.height = 1;
    this.title.content = clip(
      isSub
        ? "‹ " +
          (this.stack[this.stack.length - 2]?.find((c) => c.children === this.current())?.label ?? "Back")
        : "Command Palette",
      boxW - 4,
    );
    this.title.visible = true;

    this.filterBox.left = bx + 3;
    this.filterBox.top = by + 2;
    this.filterBox.width = boxW - 6;
    this.filterBox.height = 1;
    this.filterBox.content = clip(` ${this.filter}_ `, boxW - 6);
    this.filterBox.visible = true;

    // Rows available for items between title/filter and the footer.
    const maxItems = Math.max(0, boxH - 5);
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (i < this.filtered.length && i < maxItems) {
        const cmd = this.filtered[i];
        const active = i === this.selected;
        item.visible = true;
        item.left = bx + 2;
        item.top = by + 3 + i;
        item.width = boxW - 4;
        item.height = 1;
        item.fg = active ? "#ffffff" : "#d8dee9";
        item.bg = active ? "#2b3a55" : "#11141c";
        // Truncate so text never overruns the right border.
        item.content = clip(`  ${cmd.label}`, boxW - 4);
        if (cmd.id.startsWith("sep")) item.fg = "#6b7280";
      } else {
        item.visible = false;
      }
    }

    this.footer.left = bx + 2;
    this.footer.top = by + boxH - 2;
    this.footer.width = boxW - 4;
    this.footer.height = 1;
    this.footer.visible = true;
    const footerText =
      this.stack.length > 1
        ? "Esc back  ↑↓ navigate  Enter select"
        : "type to filter  ↑↓ navigate  Enter select  Esc close";
    this.footer.content = clip(footerText, boxW - 4);

    this.renderer.requestRender();
  }
}

export function buildAllCommands(app: App): Command[] {
  const exportJson: Command = {
    id: "action:export-json",
    label: "Export library as JSON",
    icon: "\uf05e",
    execute: (a: App) => a.exportLibrary("json"),
  };

  const exportCsv: Command = {
    id: "action:export-csv",
    label: "Export library as CSV",
    icon: "\uf05e",
    execute: (a: App) => a.exportLibrary("csv"),
  };

  const statusCmds: Command[] = STATUS_ALL.map((status) => ({
    id: `status:${status}`,
    label: `${statusLabel(status)}`,
    icon: statusIcon(status),
    execute(a: App) {
      a.setPendingStatus(status);
      a.notify(`Next add files to ${statusLabel(status)}`);
    },
  }));

  return [
    {
      id: "action:export",
      label: "Export library",
      icon: "\uf05e",
      children: [exportJson, exportCsv],
    },
    {
      id: "action:status",
      label: "Set default status",
      icon: "\uf07c",
      children: statusCmds,
    },
    {
      id: "action:filter",
      label: "Cycle status filter",
      icon: "\uf0b0",
      execute(a: App) {
        a.cycleFilter();
      },
    },
    {
      id: "action:wishlist",
      label: "Toggle wishlist",
      icon: "\uf004",
      execute(a: App) {
        a.toggleWishlist();
      },
    },
    {
      id: "action:hundred",
      label: "Toggle 100% completion",
      icon: "\uf00c",
      execute(a: App) {
        a.toggleHundred();
      },
    },
    {
      id: "action:platform",
      label: "Cycle platform played on",
      icon: "\uf11b",
      execute(a: App) {
        a.cyclePlatform();
      },
    },
    {
      id: "action:open-store",
      label: "Open store page",
      icon: "\uf08e",
      execute(a: App) {
        a.openStorePage();
      },
    },
    {
      id: "action:refresh-cover",
      label: "Refresh cover art",
      icon: "\uf03e",
      execute(a: App) {
        a.refreshCoverArt();
      },
    },
    {
      id: "action:sort-added",
      label: "Sort by added",
      icon: "\uf0dc",
      execute(a: App) {
        a.sort = Sort.Added;
        a.sortDesc = false;
      },
    },
    {
      id: "action:sort-title",
      label: "Sort by title",
      icon: "\uf0dc",
      execute(a: App) {
        a.sort = Sort.Title;
        a.sortDesc = false;
      },
    },
    {
      id: "action:sort-metacritic",
      label: "Sort by metascore",
      icon: "\uf0dc",
      execute(a: App) {
        a.sort = Sort.Metacritic;
        a.sortDesc = true;
      },
    },
  ];
}
