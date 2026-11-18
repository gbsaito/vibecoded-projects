// Entry point: open the JSON store, take a PID lock beside it, and mount the
// React tree on an OpenTUI renderer. `--data <path>` (or `-data`) overrides the
// default XDG location, matching tasker v1.

import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { appendFileSync } from "node:fs"

import { App } from "./app"
import { lockDataFile, unlockDataFile } from "./lock"
import { Store, defaultPath } from "./store"

function logDebug(line: string): void {
  if (process.env.OTUI_DEBUG) {
    try {
      appendFileSync("/tmp/tasker-keys.log", line + "\n")
    } catch {}
  }
}

function dataPathFromArgs(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--data" || arg === "-data") {
      const value = argv[i + 1]
      if (value) return value
    }
    if (arg.startsWith("--data=")) return arg.slice("--data=".length)
    if (arg.startsWith("-data=")) return arg.slice("-data=".length)
  }
  return ""
}

async function main(): Promise<void> {
  const path = dataPathFromArgs(process.argv.slice(2)) || defaultPath()

  try {
    lockDataFile(path)
  } catch (error) {
    console.error(`tasker: ${(error as Error).message}`)
    process.exit(1)
  }

  let store: Store
  try {
    store = Store.open(path)
  } catch (error) {
    unlockDataFile()
    console.error(`tasker: ${(error as Error).message}`)
    process.exit(1)
  }

  process.on("exit", unlockDataFile)

  try {
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      useMouse: true,
      screenMode: "alternate-screen",
      clearOnShutdown: true,
      onDestroy: unlockDataFile,
    })
    renderer.setTerminalTitle("tasker")
    // OpenTUI does mouse selection itself, but only its debug console binds
    // Ctrl+Shift+C to copy — and even that binding skips when onCopySelection
    // is unset, so selection text never lands anywhere. Copy here instead.
    // Kitty can report ctrl+shift+c as plain \x03 (TERM=xterm-256color), which
    // is indistinguishable from ctrl+c — so copy whenever a selection exists and
    // ctrl is held; plain ctrl+c without a selection still falls through to the app.
    const wlCopy = Bun.which("wl-copy")
    const copySelection = (text: string): void => {
      if (wlCopy) void Bun.spawn([wlCopy], { stdin: new Blob([text]), stdout: "ignore", stderr: "ignore" }).exited.catch(() => {})
      else renderer.copyToClipboardOSC52(text)
    }
    renderer.keyInput.on("keypress", (event) => {
      if (!event.ctrl || event.name !== "c") return
      const con = renderer.console as any
      const fromConsole = con.isVisible && con.hasSelection()
      const text = fromConsole ? con.getSelectedText() : renderer.getSelection()?.getSelectedText()
      logDebug(`ctrl+c seq=${JSON.stringify(event.sequence)} shift=${event.shift} consoleSel=${fromConsole} selText=${JSON.stringify(text)}`)
      if (!text) return
      event.stopPropagation()
      event.preventDefault()
      copySelection(text)
      if (fromConsole) con.clearSelection()
      else renderer.clearSelection()
    })
    renderer.on("selection", (selection) => {
      logDebug(`selection end text=${JSON.stringify(selection.getSelectedText())}`)
    })
    createRoot(renderer).render(<App store={store} />)
  } catch (error) {
    unlockDataFile()
    console.error(`tasker: ${(error as Error).message}`)
    process.exit(1)
  }
}

void main()
