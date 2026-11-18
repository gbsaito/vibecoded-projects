import { test } from "node:test";
import assert from "node:assert/strict";
import { getTheme, nextThemeIndex, normalizeThemeName, themeLabel, themeNames, themes } from "../src/theme.ts";

test("themeNames lists the built-in themes", () => {
  assert.deepEqual([...themeNames], ["dark", "light", "tokyo-night", "monokai", "everforest", "flexoki"]);
});

test("every theme has every token filled in", () => {
  const required = [
    "name",
    "bg",
    "sidebarBg",
    "border",
    "surface",
    "title",
    "tag",
    "description",
    "selectedFg",
    "selectedBg",
    "dim",
    "faint",
    "text",
    "accent",
    "subtle",
  ] as const;
  for (const name of themeNames) {
    const theme = themes[name];
    for (const token of required) {
      assert.ok(theme[token], `${name}.${token} is set`);
    }
    assert.equal(theme.name, name);
  }
});

test("tokyo-night matches folke/tokyonight.nvim night", () => {
  const theme = getTheme("tokyo-night");
  assert.equal(theme.sidebarBg, "#16161e"); // bg_dark
  assert.equal(theme.border, "#3b4261"); // fg_gutter
  assert.equal(theme.surface, "#292e42"); // bg_highlight
  assert.equal(theme.title, "#c0caf5"); // fg
  assert.equal(theme.tag, "#9ece6a"); // green
  assert.equal(theme.description, "#7aa2f7"); // blue
  assert.equal(theme.selectedFg, "#7aa2f7"); // blue
  assert.equal(theme.selectedBg, "#283457"); // bg_visual
  assert.equal(theme.dim, "#565f89"); // comment
  assert.equal(theme.faint, "#3b4261"); // fg_gutter
  assert.equal(theme.text, "#a9b1d6"); // fg_dark
  assert.equal(theme.accent, "#7aa2f7"); // blue
  assert.equal(theme.subtle, "#565f89"); // comment
});

test("tokyo-night background is one step off the kitty background so it stays solid", () => {
  const theme = getTheme("tokyo-night");
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(theme.bg.slice(i, i + 2), 16));
  assert.deepEqual([r, g, b], [0x1a, 0x1b, 0x27]);
  assert.equal(b, 0x26 + 1);
});

test("getTheme falls back to dark for unknown names", () => {
  assert.equal(getTheme("nope").name, "dark");
});

test("normalizeThemeName accepts known names and defaults to dark", () => {
  assert.equal(normalizeThemeName("light"), "light");
  assert.equal(normalizeThemeName("tokyo-night"), "tokyo-night");
  assert.equal(normalizeThemeName("solarized"), "dark");
});

test("theme labels are human readable", () => {
  assert.equal(themeLabel("dark"), "Dark");
  assert.equal(themeLabel("light"), "Light");
  assert.equal(themeLabel("tokyo-night"), "Tokyo Night");
  assert.equal(themeLabel("monokai"), "Monokai");
  assert.equal(themeLabel("everforest"), "Everforest");
  assert.equal(themeLabel("flexoki"), "Flexoki");
});

test("monokai uses the classic palette", () => {
  const theme = getTheme("monokai");
  assert.equal(theme.bg, "#272822");
  assert.equal(theme.tag, "#a6e22e");
  assert.equal(theme.description, "#66d9ef");
  assert.equal(theme.accent, "#f92672");
});

test("everforest uses the dark medium palette", () => {
  const theme = getTheme("everforest");
  assert.equal(theme.bg, "#2d353b");
  assert.equal(theme.tag, "#a7c080");
  assert.equal(theme.description, "#7fbbb3");
  assert.equal(theme.accent, "#e69875");
});

test("flexoki uses the dark palette", () => {
  const theme = getTheme("flexoki");
  assert.equal(theme.bg, "#100f0f");
  assert.equal(theme.tag, "#879a39");
  assert.equal(theme.description, "#4385be");
  assert.equal(theme.accent, "#da702c");
});

test("nextThemeIndex wraps in both directions", () => {
  assert.equal(nextThemeIndex(0, 1), 1);
  assert.equal(nextThemeIndex(themeNames.length - 1, 1), 0);
  assert.equal(nextThemeIndex(0, -1), themeNames.length - 1);
});
