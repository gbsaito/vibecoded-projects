/**
 * Gamepad support.
 *
 * Reads a PlayStation (DualShock 4) controller and turns the pad into the
 * same key events the keyboard produces, so every existing binding works
 * unchanged and the pad can drive the overlays too.
 *
 * The evdev interface is used because it names the controls exactly
 * (BTN_SOUTH, ABS_HAT0X, ...) instead of the legacy joystick API's
 * positional numbering. The legacy API is kept as a fallback for devices
 * whose evdev node cannot be opened.
 */

import { closeSync, constants, openSync, readSync, readFileSync } from "node:fs";

/** The key shape the app's key handler consumes. */
export interface KeyLike {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  raw?: string;
}

/** evdev event types. */
const EV_KEY = 0x01;
const EV_ABS = 0x03;
const EV_SYN = 0x00;

/** evdev button codes. */
const BTN_SOUTH = 0x130;
const BTN_EAST = 0x131;
const BTN_NORTH = 0x133;
const BTN_WEST = 0x134;
const BTN_TL = 0x136;
const BTN_TR = 0x137;
const BTN_TL2 = 0x138;
const BTN_TR2 = 0x139;
const BTN_SELECT = 0x13a;
const BTN_START = 0x13b;
const BTN_MODE = 0x13c;
const BTN_THUMBL = 0x13d;
const BTN_THUMBR = 0x13e;

/** evdev absolute axis codes. */
const ABS_X = 0x00;
const ABS_Y = 0x01;
const ABS_Z = 0x02;
const ABS_RX = 0x03;
const ABS_RY = 0x04;
const ABS_RZ = 0x05;
const ABS_HAT0X = 0x10;
const ABS_HAT0Y = 0x11;

/**
 * Button to key mapping. The layout follows the DualShock 4: Cross, Circle,
 * Triangle, Square, then the shoulders and triggers, Share, Options, the PS
 * button and the two stick clicks.
 */
const BUTTON_KEYS: Record<number, KeyLike> = {
  [BTN_SOUTH]: { name: "enter" }, // Cross
  [BTN_EAST]: { name: "escape" }, // Circle
  [BTN_NORTH]: { name: "?" }, // Triangle
  [BTN_WEST]: { name: "v" }, // Square
  [BTN_TL]: { name: "tab", shift: true }, // L1
  [BTN_TR]: { name: "tab" }, // R1
  [BTN_TL2]: { name: "-" }, // L2
  [BTN_TR2]: { name: "+" }, // R2
  [BTN_SELECT]: { name: ":" }, // Share
  [BTN_START]: { name: "s" }, // Options
  [BTN_MODE]: { name: "v", shift: true }, // PS button
  [BTN_THUMBL]: { name: "e", shift: true }, // L3
  [BTN_THUMBR]: { name: "e" }, // R3
};

/** Key repeat: first repeat after this delay, then at this interval. */
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 90;

/** Deflection, in axis units, that counts as a direction on a stick. */
const STICK_DEADZONE = 40;

/** Deflection that counts as a direction on a d-pad (it reports -1/0/+1). */
const HAT_DEADZONE = 1;

/**
 * The geometry of the axes a gamepad reports. The evdev interface exposes
 * raw values, so the resting position and the usable range are known
 * exactly: sticks report 0..255 and rest at 128, a d-pad hat reports
 * -1/0/+1 and rests at 0.
 */
const AXIS_GEOMETRY: Record<number, { center: number; deadzone: number }> = {
  [ABS_X]: { center: 128, deadzone: STICK_DEADZONE },
  [ABS_Y]: { center: 128, deadzone: STICK_DEADZONE },
  [ABS_RX]: { center: 128, deadzone: STICK_DEADZONE },
  [ABS_RY]: { center: 128, deadzone: STICK_DEADZONE },
  [ABS_HAT0X]: { center: 0, deadzone: HAT_DEADZONE },
  [ABS_HAT0Y]: { center: 0, deadzone: HAT_DEADZONE },
};

/** A direction that can be produced by more than one physical control. */
interface DirGroup {
  /** Axis that wins when several are deflected at once (the d-pad). */
  priority: number;
  axes: number[];
  keys: { neg: KeyLike; pos: KeyLike };
  dir: number;
  nextRepeatAt: number;
}

interface AxisState {
  /** Resting value, so a deflection is measured from the centre. */
  center: number;
  /** Last value seen. */
  value: number;
  /** Deflection that counts as a direction. */
  deadzone: number;
}

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** True when the device is a DualShock 4 (Sony 054c:09cc). */
function isDualShock4(uevent: string): boolean {
  // The uevent reports PRODUCT=<bus>/<vendor>/<product>/<version>, with the
  // vendor and product as variable-width hex (the leading zeros are often
  // dropped, so "054c" arrives as "54c").
  const m = /PRODUCT=[0-9a-f]+\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(uevent);
  if (m) {
    const vendor = m[1].toLowerCase().padStart(4, "0");
    const product = m[2].toLowerCase().padStart(4, "0");
    return vendor === "054c" && product === "09cc";
  }
  // Older kernels expose the ids separately.
  return /Vendor=054c/i.test(uevent) && /Product=09cc/i.test(uevent);
}

/**
 * The evdev node of a gamepad. The kernel lists, per input device, the
 * handler nodes it owns; the gamepad proper is the one that shares its
 * node with the joystick handler, which is the one carrying the buttons.
 */
function findEvdevNode(): { path: string; dualShock: boolean } | null {
  const devices = readFile("/proc/bus/input/devices");
  let fallback: { path: string; dualShock: boolean } | null = null;
  for (const block of devices.split("\n\n")) {
    const handler = /Handlers=(.+)/.exec(block)?.[1] ?? "";
    const event = handler.split(/\s+/).find((h) => h.startsWith("event"));
    if (!event) continue;
    // Only devices with buttons and absolute axes are gamepads.
    if (!/B: KEY=/.test(block) || !/B: ABS=/.test(block)) continue;
    const uevent = readFile(`/sys/class/input/${event}/device/uevent`);
    const dualShock = isDualShock4(uevent);
    // The main node also owns the joystick handler; that is the one with
    // the buttons we need.
    if (handler.includes("js")) {
      return { path: `/dev/input/${event}`, dualShock };
    }
    if (dualShock && !fallback) {
      fallback = { path: `/dev/input/${event}`, dualShock };
    }
  }
  return fallback;
}

/** The legacy joystick node, used when the evdev node cannot be opened. */
function findJsNode(): string | null {
  const devices = readFile("/proc/bus/input/devices");
  for (const block of devices.split("\n\n")) {
    const handler = /Handlers=(.+)/.exec(block)?.[1] ?? "";
    const js = handler.split(/\s+/).find((h) => h.startsWith("js"));
    if (js) return `/dev/input/${js}`;
  }
  return null;
}

export class Gamepad {
  private readonly fd: number;
  private readonly evdev: boolean;
  private readonly buf: Buffer;
  private readonly axes = new Map<number, AxisState>();
  private readonly buttons = new Set<number>();
  private readonly groups: DirGroup[];
  private readonly dualShock: boolean;

  private constructor(fd: number, evdev: boolean, dualShock: boolean) {
    this.fd = fd;
    this.evdev = evdev;
    this.dualShock = dualShock;
    this.buf = Buffer.alloc(evdev ? 24 * 64 : 8 * 64);

    // Sticks and the d-pad, in the evdev axis codes. The d-pad has priority
    // because it is a deliberate press.
    this.groups = [
      {
        priority: ABS_HAT0X,
        axes: [ABS_X, ABS_HAT0X],
        keys: { neg: { name: "left" }, pos: { name: "right" } },
        dir: 0,
        nextRepeatAt: 0,
      },
      {
        priority: ABS_HAT0Y,
        axes: [ABS_Y, ABS_HAT0Y],
        keys: { neg: { name: "up" }, pos: { name: "down" } },
        dir: 0,
        nextRepeatAt: 0,
      },
      {
        priority: ABS_RX,
        axes: [ABS_RX],
        keys: { neg: { name: "left", shift: true }, pos: { name: "right", shift: true } },
        dir: 0,
        nextRepeatAt: 0,
      },
    ];
  }

  /**
   * Opens the controller if one is attached. Returns null when there is no
   * pad or it cannot be read, so the app runs unchanged without one.
   *
   * MST_GAMEPAD overrides the device. MST_GAMEPAD_FORMAT selects the
   * protocol: "evdev" (the default for a real device) or "legacy" for a
   * recorded joystick stream.
   */
  static detect(): Gamepad | null {
    const override = process.env.MST_GAMEPAD;
    if (override) {
      const fd = openDevice(override);
      if (fd === null) return null;
      const evdev = (process.env.MST_GAMEPAD_FORMAT ?? "evdev") !== "legacy";
      const name = override.replace("/dev/input/", "");
      const dualShock = forceDualShock() || isDualShock4(readFile(`/sys/class/input/${name}/device/uevent`));
      return new Gamepad(fd, evdev, dualShock);
    }

    const node = findEvdevNode();
    if (node) {
      const fd = openDevice(node.path);
      if (fd !== null) {
        return new Gamepad(fd, true, node.dualShock || forceDualShock());
      }
    }
    // Fall back to the legacy joystick API.
    const js = findJsNode();
    if (js) {
      const fd = openDevice(js);
      if (fd !== null) {
        return new Gamepad(fd, false, forceDualShock());
      }
    }
    return null;
  }

  /** True when the pad is a DualShock 4 and gets the PS4 layout. */
  get isDualShock4(): boolean {
    return this.dualShock;
  }

  /** Polls the pad and returns the key events it produced. */
  poll(now: number): KeyLike[] {
    const out: KeyLike[] = [];
    if (this.evdev) this.readEvdev(out);
    else this.readLegacy(out);
    for (const group of this.groups) {
      const dir = this.direction(group);
      if (dir !== group.dir) {
        group.dir = dir;
        if (dir !== 0) {
          out.push(dir < 0 ? group.keys.neg : group.keys.pos);
          group.nextRepeatAt = now + REPEAT_DELAY_MS;
        }
      } else if (dir !== 0 && now >= group.nextRepeatAt) {
        out.push(dir < 0 ? group.keys.neg : group.keys.pos);
        group.nextRepeatAt = now + REPEAT_INTERVAL_MS;
      }
    }
    return out;
  }

  close(): void {
    try {
      closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }

  // ------------------------------------------------------------- evdev path

  private readEvdev(out: KeyLike[]): void {
    for (;;) {
      let read = 0;
      try {
        read = readSync(this.fd, this.buf, 0, this.buf.length, null);
      } catch {
        return; // EAGAIN: nothing pending
      }
      if (read <= 0) return;
      for (let off = 0; off + 24 <= read; off += 24) {
        const type = this.buf.readUInt16LE(off + 16);
        const code = this.buf.readUInt16LE(off + 18);
        const value = this.buf.readInt32LE(off + 20);
        if (type === EV_SYN) continue;
        if (type === EV_KEY) {
          this.handleButton(code, value, out);
        } else if (type === EV_ABS) {
          this.handleAxis(code, value);
        }
      }
      if (read < this.buf.length) return;
    }
  }

  // ------------------------------------------------------------ legacy path

  private readLegacy(out: KeyLike[]): void {
    for (;;) {
      let read = 0;
      try {
        read = readSync(this.fd, this.buf, 0, this.buf.length, null);
      } catch {
        return;
      }
      if (read <= 0) return;
      for (let off = 0; off + 8 <= read; off += 8) {
        const value = this.buf.readInt16LE(off + 4);
        const rawType = this.buf.readUInt8(off + 6);
        const number = this.buf.readUInt8(off + 7);
        const type = rawType & 0x7f;
        const init = (rawType & 0x80) !== 0;
        if (type === 0x02) {
          this.handleLegacyAxis(number, value, init);
        } else if (type === 0x01) {
          this.handleLegacyButton(number, value, init, out);
        }
      }
      if (read < this.buf.length) return;
    }
  }

  // -------------------------------------------------------------- handlers

  private handleButton(code: number, value: number, out: KeyLike[]): void {
    const pressed = value !== 0;
    if (!pressed) {
      this.buttons.delete(code);
      return;
    }
    if (this.buttons.has(code)) return;
    this.buttons.add(code);
    const key = BUTTON_KEYS[code];
    if (key) out.push({ ...key });
  }

  private handleAxis(code: number, value: number): void {
    const geometry = AXIS_GEOMETRY[code];
    const state = this.axes.get(code) ?? {
      center: geometry ? geometry.center : value,
      value,
      deadzone: geometry ? geometry.deadzone : STICK_DEADZONE,
    };
    state.value = value;
    this.axes.set(code, state);
  }

  private handleLegacyButton(number: number, value: number, init: boolean, out: KeyLike[]): void {
    const pressed = value !== 0;
    if (init) {
      if (pressed) this.buttons.add(number);
      return;
    }
    this.handleButton(legacyButtonCode(number), value, out);
  }

  private handleLegacyAxis(number: number, value: number, init: boolean): void {
    const code = legacyAxisCode(number);
    const geometry = AXIS_GEOMETRY[code];
    const state = this.axes.get(code) ?? {
      center: value,
      value,
      deadzone: geometry ? geometry.deadzone : STICK_DEADZONE,
    };
    if (init) {
      // The kernel reports the resting position when the device is opened.
      state.center = value;
    }
    state.value = value;
    this.axes.set(code, state);
  }

  /** The current direction of a group: -1, 0 or 1. */
  private direction(group: DirGroup): number {
    let best = 0;
    let bestStrength = 0;
    for (const axis of group.axes) {
      const state = this.axes.get(axis);
      if (!state) continue;
      const diff = state.value - state.center;
      if (Math.abs(diff) < state.deadzone) continue;
      const strength = Math.abs(diff);
      // The d-pad is a deliberate press, so it wins over a resting stick.
      if (axis === group.priority || strength > bestStrength) {
        best = diff < 0 ? -1 : 1;
        bestStrength = strength;
      }
    }
    return best;
  }
}

function openDevice(path: string): number | null {
  try {
    return openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
}

/**
 * Forces the DualShock 4 layout. The device is identified by its USB id, but
 * the override exists for replaying recorded input and for pads that report
 * the DualShock 4 id under a different transport.
 */
function forceDualShock(): boolean {
  const v = process.env.MST_GAMEPAD_LAYOUT;
  return v === "ds4" || v === "dualshock4";
}

/** Legacy joystick button number to evdev button code. */
function legacyButtonCode(n: number): number {
  const codes = [
    BTN_SOUTH, BTN_EAST, BTN_NORTH, BTN_WEST, BTN_TL, BTN_TR, BTN_TL2, BTN_TR2,
    BTN_SELECT, BTN_START, BTN_MODE, BTN_THUMBL, BTN_THUMBR,
  ];
  return codes[n] ?? -1;
}

/** Legacy joystick axis number to evdev axis code. */
function legacyAxisCode(n: number): number {
  const codes = [ABS_X, ABS_Y, ABS_Z, ABS_RX, ABS_RY, ABS_RZ, ABS_HAT0X, ABS_HAT0Y];
  return codes[n] ?? -1;
}
