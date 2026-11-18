import { createReadStream, readFileSync, type ReadStream } from "node:fs";

/**
 * PlayStation 4 controller support through the Linux joystick API.
 *
 * A DualShock 4 appears as `/dev/input/jsN` (and as an evdev device). The
 * joystick API is a stream of 8 byte `js_event` structs, which is easy to
 * parse without a native dependency:
 *
 *   uint32 time, int16 value, uint8 type, uint8 number
 */

const JS_EVENT_BUTTON = 0x01;
const JS_EVENT_AXIS = 0x02;
const JS_EVENT_INIT = 0x80;

/** ABS_X: the horizontal axis of the left stick. */
const ABS_X = 0x00;
/** ABS_HAT0X: the horizontal axis of the D-pad. */
const ABS_HAT0X = 0x06;

/**
 * Buttons of the DualShock 4, as reported by the Linux joystick driver. The
 * joystick API truncates the evdev button codes to one byte, so BTN_MODE
 * (0x13e) arrives as 0x3e.
 */
export const GamepadButton = {
  Cross: 0x30,
  Circle: 0x31,
  Triangle: 0x33,
  Square: 0x34,
  L1: 0x36,
  R1: 0x37,
  L2: 0x38,
  R2: 0x39,
  L3: 0x3a,
  R3: 0x3b,
  Share: 0x3c,
  Options: 0x3d,
  Ps: 0x3e,
} as const;

export interface GamepadHandlers {
  /** The left stick, -1 (left) to 1 (right). */
  onAxis?: (value: number) => void;
  /** The D-pad, -1 (left) to 1 (right). */
  onHat?: (value: number) => void;
  onButton?: (button: number, pressed: boolean) => void;
}

export interface GamepadOptions extends GamepadHandlers {
  /** The joystick device to open. Defaults to the first DS4 that is found. */
  device?: string;
}

export class Gamepad {
  readonly device: string;
  readonly name: string;
  private readonly stream: ReadStream;
  private readonly handlers: GamepadHandlers;
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private wide = false;
  private closed = false;

  private constructor(device: string, name: string, handlers: GamepadHandlers) {
    this.device = device;
    this.name = name;
    this.handlers = handlers;
    this.stream = createReadStream(device);
    this.stream.on("data", (chunk) => this.consume(chunk));
    this.stream.on("error", () => this.close());
  }

  /**
   * Opens the controller. Returns undefined when no controller is found or
   * the device cannot be read (permissions).
   */
  static open(options: GamepadOptions = {}): Gamepad | undefined {
    const device = options.device ?? findJoystick();
    if (!device) return undefined;

    const name = deviceName(device) ?? "gamepad";
    try {
      return new Gamepad(device, name, options);
    } catch {
      return undefined;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream.destroy();
  }

  private consume(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "binary") : chunk;
    this.pending = this.pending.length === 0 ? bytes : Buffer.concat([this.pending, bytes]);

    const usable = Math.floor(this.pending.length / 8) * 8;
    for (const event of parseJoystickEvents(this.pending.subarray(0, usable))) {
      if (event.type === JS_EVENT_AXIS) {
        if (event.number === ABS_X) this.handlers.onAxis?.(this.normalize(event.value));
        else if (event.number === ABS_HAT0X) {
          this.handlers.onHat?.(Math.max(-1, Math.min(1, event.value)));
        }
      } else if (event.type === JS_EVENT_BUTTON) {
        this.handlers.onButton?.(event.number, event.value !== 0);
      }
    }

    this.pending = this.pending.subarray(usable);
  }

  /**
   * Normalizes the stick. The DualShock 4 reports 0..255 with 128 in the
   * middle, while the evdev driver reports -32767..32767. A negative value or
   * a large one means the wide range.
   */
  private normalize(value: number): number {
    if (value < 0 || Math.abs(value) > 255) this.wide = true;
    if (this.wide) return Math.max(-1, Math.min(1, value / 32767));

    // Eight bit axis: the middle is 128, the ends are 0 and 255.
    return Math.max(-1, Math.min(1, (value - 128) / 127));
  }
}

export interface JoystickEvent {
  readonly value: number;
  readonly type: number;
  readonly number: number;
}

/** Parses the 8 byte structs of the Linux joystick API. */
export function parseJoystickEvents(data: Buffer): JoystickEvent[] {
  const events: JoystickEvent[] = [];
  for (let offset = 0; offset + 8 <= data.length; offset += 8) {
    const type = data.readUInt8(offset + 6);
    if (type & JS_EVENT_INIT) continue;
    events.push({
      value: data.readInt16LE(offset + 4),
      type,
      number: data.readUInt8(offset + 7),
    });
  }
  return events;
}

/** The joystick devices of this machine, with their names. */
function joystickDevices(): Array<{ device: string; name: string }> {
  const devices: Array<{ device: string; name: string }> = [];
  let blocks: string[] = [];

  try {
    blocks = readFileSync("/proc/bus/input/devices", "utf8").split("\n\n");
  } catch {
    return devices;
  }

  for (const block of blocks) {
    const name = /\nN: Name="([^"]*)"/.exec(`\n${block}`)?.[1];
    if (!name) continue;
    const handler = /\nH: Handlers=(.*)/.exec(`\n${block}`)?.[1] ?? "";
    const js = handler.split(/\s+/).find((entry) => entry.startsWith("js"));
    if (!js) continue;
    devices.push({ device: `/dev/input/${js}`, name });
  }

  return devices;
}

function findJoystick(): string | undefined {
  const devices = joystickDevices();
  const sony = devices.find((entry) =>
    /sony|playstation|dualshock|wireless controller/i.test(entry.name),
  );
  return (sony ?? devices[0])?.device;
}

function deviceName(device: string): string | undefined {
  return joystickDevices().find((entry) => entry.device === device)?.name;
}
