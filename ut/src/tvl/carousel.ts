/**
 * The carousel model: where the strip is, where it is heading, and where each
 * card sits. Pure arithmetic — no terminal imports — so the animation and the
 * layout can be tested without a renderer.
 *
 * Ported from ~/Projects/slider. tvl is not a looping strip: a library should
 * not slide across the whole list from the last game to the first, so the
 * target is clamped to the item count instead of wrapped.
 */

/** Cards shown on each side of the focused one. */
export const SIDE_COUNT = 3;
/** The focused card is this much bigger than the others. */
export const FOCUS_SCALE = 1.5;
/** Free cells between two neighbouring cards. */
export const GAP = 1;
/** Width of a card in cells, per row of card height. */
export const CARD_ASPECT = 1.25;
/** How much the outer cards rise, in rows per step. */
export const ARC_STEP = 0.8;
/** Cards per second at full stick deflection. */
const SCROLL_SPEED = 9;
/** Stick deflection that is ignored. */
const AXIS_DEADZONE = 0.18;

const SPRING_STIFFNESS = 260;
const SPRING_DAMPING = 26;

export interface CardBox {
  /** Position of the card in the strip. */
  readonly index: number;
  /** Distance to the focused card, negative on the left. */
  readonly offset: number;
  /** Distance to the focused card, always positive. */
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Dimming level: 0 is the bright one. */
  readonly variant: number;
}

export interface CarouselLayout {
  /** The cards to draw, farthest card first. */
  readonly cards: CardBox[];
  readonly focused: CardBox;
  /** Rows reserved above the strip (title, metadata). */
  readonly titleY: number;
  readonly labelY: number;
  readonly hintY: number;
}

export class Carousel {
  /** Continuous position of the focused card, in card units. */
  private focus = 0;
  /** Continuous velocity of the focused card. */
  private velocity = 0;
  /** Where the strip is heading, in card units. */
  private target = 0;
  /** Whether the target sits exactly on a card. */
  private snapped = true;
  /** The left stick of the gamepad, -1 to 1. */
  private axis = 0;
  private count = 0;

  /** Continuous position of the strip, in card units. Exposed for tests. */
  get position(): number {
    return this.focus;
  }

  /** True while the left stick is outside its deadzone. */
  get axisActive(): boolean {
    return Math.abs(this.axis) > AXIS_DEADZONE;
  }

  /** Index the strip is heading to (integer, clamped to the item count). */
  get targetIndex(): number {
    return Math.round(this.target);
  }

  /** True when the spring has reached the target and nothing is moving. */
  get settled(): boolean {
    return Math.abs(this.target - this.focus) < 0.0005 && Math.abs(this.velocity) < 0.01;
  }

  get length(): number {
    return this.count;
  }

  /** Tell the model how many items are available, clamping any old target. */
  setCount(n: number): void {
    const next = Math.max(0, Math.floor(n));
    if (next === this.count) return;
    this.count = next;
    const max = Math.max(0, next - 1);
    this.target = clamp(this.target, 0, max);
    this.focus = clamp(this.focus, 0, max);
    if (next === 0) {
      this.focus = 0;
      this.target = 0;
      this.velocity = 0;
      this.snapped = true;
    }
  }

  /**
   * Aim the strip at an item. Idempotent: re-rendering with the same selection
   * must not restart the spring the view is already animating.
   */
  setTarget(index: number): void {
    const max = Math.max(0, this.count - 1);
    const next = clamp(Math.round(index), 0, max);
    this.axis = 0;
    if (next === this.target) {
      this.snapped = true;
      return;
    }
    this.target = next;
    this.snapped = true;
  }

  /**
   * Jump straight to an item without animating. Used when the list itself
   * changes (tab, filter, sort), where sliding across unrelated games would be
   * noise rather than feedback.
   */
  snapTo(index: number): void {
    const max = Math.max(0, this.count - 1);
    const next = clamp(Math.round(index), 0, max);
    this.axis = 0;
    this.target = next;
    this.focus = next;
    this.velocity = 0;
    this.snapped = true;
  }

  /** Move one card left or right, stopping at the ends. */
  move(direction: -1 | 1): void {
    const max = Math.max(0, this.count - 1);
    this.target = clamp(Math.round(this.target) + direction, 0, max);
    this.snapped = true;
  }

  /** The horizontal position of the gamepad's left stick, -1 to 1. */
  setAxis(value: number): void {
    this.axis = Number.isFinite(value) ? clamp(value, -1, 1) : 0;
  }

  /** Advance the spring towards the target position. */
  update(deltaTime: number): void {
    const dt = clamp(deltaTime, 0, 50) / 1000;
    if (this.count === 0) {
      this.focus = 0;
      this.target = 0;
      this.velocity = 0;
      this.axis = 0;
      this.snapped = true;
      return;
    }

    const max = Math.max(0, this.count - 1);
    const deflection = Math.max(
      0,
      (Math.abs(this.axis) - AXIS_DEADZONE) / (1 - AXIS_DEADZONE),
    );
    if (deflection > 0) {
      // The stick scrubs continuously; the spring still does the smoothing.
      this.target = clamp(
        this.target + Math.sign(this.axis) * deflection * SCROLL_SPEED * dt,
        0,
        max,
      );
      this.snapped = false;
    } else if (!this.snapped) {
      this.target = clamp(Math.round(this.target), 0, max);
      this.snapped = true;
    }

    this.target = clamp(this.target, 0, max);

    const accel = (this.target - this.focus) * SPRING_STIFFNESS - this.velocity * SPRING_DAMPING;
    this.velocity += accel * dt;
    this.focus += this.velocity * dt;

    if (Math.abs(this.target - this.focus) < 0.0005 && Math.abs(this.velocity) < 0.01) {
      this.focus = this.target;
      this.velocity = 0;
    }
  }

  /**
   * Place the cards inside a box of the given size. `chromeRows` are reserved
   * for the title above and the caption/hint below, so cards never overlap
   * them. `areaTop` is how many of those rows sit above the strip (the title
   * block); the rest belong to the footer rows. Cards whose indices fall
   * outside the item count are still returned; the view skips them (that is
   * how the strip continues off both ends).
   */
  layout(width: number, height: number, chromeRows = 0, areaTop = chromeRows >= 2 ? 2 : 0): CarouselLayout {
    const boxW = Math.max(1, Math.floor(width));
    const boxH = Math.max(1, Math.floor(height));
    const chrome = Math.max(0, Math.floor(chromeRows));
    const topRows = Math.max(0, Math.min(Math.floor(areaTop), chrome));
    const areaHeight = Math.max(4, boxH - chrome);

    let sideHeight = clamp(Math.floor(areaHeight / FOCUS_SCALE), 4, 10);
    let sideWidth = Math.max(3, Math.round(sideHeight * CARD_ASPECT));

    const totalWidth = (cardWidth: number) =>
      Math.round(cardWidth * FOCUS_SCALE) + 2 * (SIDE_COUNT * cardWidth + SIDE_COUNT * GAP);

    if (totalWidth(sideWidth) > boxW - 2) {
      const scale = (boxW - 2) / totalWidth(sideWidth);
      sideWidth = Math.max(3, Math.round(sideWidth * scale));
      sideHeight = Math.max(3, Math.round(sideHeight * scale));
    }

    const focusWidth = Math.round(sideWidth * FOCUS_SCALE);
    const focusHeight = Math.round(sideHeight * FOCUS_SCALE);
    const centreX = Math.round(boxW / 2);
    const centreY = topRows + Math.round(areaHeight / 2);

    // Distance between the centres of the focused card and the first side
    // card, and between two side cards.
    const toFirst = focusWidth / 2 + GAP + sideWidth / 2;
    const step = sideWidth + GAP;

    // The focused card stays in the centre while it is focused. A card that
    // leaves the centre slides out to its place, a card that arrives slides in.
    const distance = (offset: number): number => {
      const steps = Math.abs(offset);
      if (steps <= 0.5) return 0;
      if (steps <= 1) return (steps - 0.5) * 2 * toFirst;
      if (steps <= 2) return toFirst + (steps - 1) * step;
      if (steps <= 3) return toFirst + step + (steps - 2) * step;
      return toFirst + 2 * step + (steps - 3) * step;
    };

    const first = Math.round(this.focus) - SIDE_COUNT;
    const cards: CardBox[] = [];
    for (let index = first; index <= first + SIDE_COUNT * 2; index++) {
      const offset = index - this.focus;
      const depth = Math.abs(offset);
      // The size only changes once the card leaves the centre.
      const grown = clamp((depth - 0.5) * 2, 0, 1);
      const width = Math.round(lerp(focusWidth, sideWidth, grown));
      const height = Math.round(lerp(focusHeight, sideHeight, grown));
      const x = Math.round(centreX + Math.sign(offset) * distance(offset) - width / 2);
      const y = Math.round(centreY - Math.max(0, depth - 1) * ARC_STEP - height / 2);

      cards.push({
        index,
        offset,
        depth,
        x,
        y,
        width,
        height,
        variant: clamp(Math.round(depth - 0.5), 0, SIDE_COUNT),
      });
    }

    // Farthest card first, so the focused card ends up on top.
    cards.sort((a, b) => b.depth - a.depth);
    const focused = cards.reduce((best, card) => (card.depth < best.depth ? card : best));

    return {
      cards,
      focused,
      titleY: Math.max(0, topRows - 3),
      labelY: Math.max(0, boxH - 2),
      hintY: Math.max(0, boxH - 1),
    };
  }
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
