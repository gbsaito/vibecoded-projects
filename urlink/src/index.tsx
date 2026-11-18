import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./App.tsx";

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: true,
  screenMode: "alternate-screen",
  consoleMode: "disabled",
  openConsoleOnError: false,
  targetFps: 30,
});

const root = createRoot(renderer);
root.render(<App />);

const _origConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const msg = args.map((a) => String(a)).join(" ");
  if (
    msg.includes("socket idle timeout") ||
    msg.includes("UND_ERR_INFO") ||
    msg.includes("InformationalError") ||
    msg.includes("FFI is an experimental feature")
  ) {
    return;
  }
  _origConsoleError(...args);
};

process.on("uncaughtException", (err) => {
  const msg = String((err as { message?: unknown })?.message ?? err ?? "");
  if (
    msg.includes("socket idle timeout") ||
    msg.includes("UND_ERR_INFO") ||
    msg.includes("InformationalError") ||
    msg.includes("FFI is an experimental feature")
  ) {
    return;
  }
  console.error("uncaughtException:", err);
});

process.on("unhandledRejection", (reason) => {
  const msg = String((reason as { message?: unknown })?.message ?? reason ?? "");
  if (
    msg.includes("socket idle timeout") ||
    msg.includes("UND_ERR_INFO") ||
    msg.includes("InformationalError") ||
    msg.includes("FFI is an experimental feature")
  ) {
    return;
  }
  console.error("unhandledRejection:", reason);
});

const shutdown = () => {
  try {
    root.unmount();
  } catch {
    /* noop */
  }
  try {
    renderer.destroy();
  } catch {
    /* noop */
  }
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
