export interface Theme {
  name: string;
  bg: string;
  sidebarBg: string;
  border: string;
  surface: string;
  title: string;
  tag: string;
  description: string;
  selectedFg: string;
  selectedBg: string;
  dim: string;
  faint: string;
  text: string;
  accent: string;
  subtle: string;
}

export const themeNames = ["dark", "light", "tokyo-night", "monokai", "everforest", "flexoki"] as const;

export type ThemeName = (typeof themeNames)[number];

export const themes: Record<ThemeName, Theme> = {
  dark: {
    name: "dark",
    bg: "#15171c",
    sidebarBg: "#101216",
    border: "#2a2f3a",
    surface: "#1c1f26",
    title: "#f0f3f8",
    tag: "#8bd49c",
    description: "#8fb8ff",
    selectedFg: "#a8c7ff",
    selectedBg: "#253246",
    dim: "#6a7280",
    faint: "#333945",
    text: "#c6ccd8",
    accent: "#82aaff",
    subtle: "#6a7280",
  },
  light: {
    name: "light",
    bg: "#f7f7f9",
    sidebarBg: "#ececf1",
    border: "#d3d4dc",
    surface: "#ffffff",
    title: "#1b1d24",
    tag: "#2f7d4f",
    description: "#2563eb",
    selectedFg: "#1d4ed8",
    selectedBg: "#dde6ff",
    dim: "#6b7280",
    faint: "#a1a7b3",
    text: "#333845",
    accent: "#2563eb",
    subtle: "#6b7280",
  },
  // folke/tokyonight.nvim night palette; bg is bg + 1 blue so kitty renders it opaque.
  "tokyo-night": {
    name: "tokyo-night",
    bg: "#1a1b27",
    sidebarBg: "#16161e",
    border: "#3b4261",
    surface: "#292e42",
    title: "#c0caf5",
    tag: "#9ece6a",
    description: "#7aa2f7",
    selectedFg: "#7aa2f7",
    selectedBg: "#283457",
    dim: "#565f89",
    faint: "#3b4261",
    text: "#a9b1d6",
    accent: "#7aa2f7",
    subtle: "#565f89",
  },
  monokai: {
    name: "monokai",
    bg: "#272822",
    sidebarBg: "#1e1f1c",
    border: "#49483e",
    surface: "#2d2e27",
    title: "#f8f8f2",
    tag: "#a6e22e",
    description: "#66d9ef",
    selectedFg: "#f8f8f2",
    selectedBg: "#3e3d32",
    dim: "#75715e",
    faint: "#49483e",
    text: "#f8f8f2",
    accent: "#f92672",
    subtle: "#75715e",
  },
  everforest: {
    name: "everforest",
    bg: "#2d353b",
    sidebarBg: "#232a2e",
    border: "#475258",
    surface: "#343f44",
    title: "#d3c6aa",
    tag: "#a7c080",
    description: "#7fbbb3",
    selectedFg: "#d3c6aa",
    selectedBg: "#3d484d",
    dim: "#859289",
    faint: "#475258",
    text: "#d3c6aa",
    accent: "#e69875",
    subtle: "#859289",
  },
  flexoki: {
    name: "flexoki",
    bg: "#100f0f",
    sidebarBg: "#1c1b1a",
    border: "#403e3c",
    surface: "#282726",
    title: "#cecdc3",
    tag: "#879a39",
    description: "#4385be",
    selectedFg: "#cecdc3",
    selectedBg: "#343331",
    dim: "#9f9d96",
    faint: "#403e3c",
    text: "#cecdc3",
    accent: "#da702c",
    subtle: "#9f9d96",
  },
};

const THEME_LABELS: Record<ThemeName, string> = {
  dark: "Dark",
  light: "Light",
  "tokyo-night": "Tokyo Night",
  monokai: "Monokai",
  everforest: "Everforest",
  flexoki: "Flexoki",
};

export function themeLabel(name: string): string {
  return THEME_LABELS[name as ThemeName] ?? name;
}

export function normalizeThemeName(name: string): ThemeName {
  return (themeNames as readonly string[]).includes(name) ? (name as ThemeName) : "dark";
}

export function getTheme(name: string): Theme {
  return themes[normalizeThemeName(name)];
}

export function nextThemeIndex(index: number, dir: number): number {
  const length = themeNames.length;
  return ((index + dir) % length + length) % length;
}
