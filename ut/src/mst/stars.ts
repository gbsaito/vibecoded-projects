export const STAR_FULL = "\uf006"; // filled star (verified codepoint)
export const STAR_EMPTY = "\uf006"; // empty star (same glyph, dim color)

export interface GlyphSet {
  full: string;
  empty: string;
}

export const NERD_GLYPHS: GlyphSet = { full: STAR_FULL, empty: STAR_EMPTY };
export const ASCII_GLYPHS: GlyphSet = { full: "*", empty: "." };

export const glyphs = (nerd: boolean): GlyphSet =>
  nerd ? NERD_GLYPHS : ASCII_GLYPHS;

export function stars(max: number, rating: number | null, nerd = true): string[] {
  const g = glyphs(nerd);
  const n = rating === null ? 0 : Math.min(max, Math.max(1, Math.trunc(rating)));
  return Array.from({ length: max }, (_, i) => (i < n ? g.full : g.empty));
}

export function ratingBadge(rating: number | null, nerd = true): string {
  if (rating === null) return "--";
  const g = glyphs(nerd);
  return `${g.full.repeat(rating)} ${rating}`;
}
