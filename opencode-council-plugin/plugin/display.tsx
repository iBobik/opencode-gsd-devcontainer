// Keep UI helpers in TSX so OpenCode supplies its shared Solid runtime.
import { createEffect, createSignal, on, onCleanup } from "solid-js"
import type { CouncilDisplay } from "./council-rpc"

export function councilDisplay(sessionID: () => string, read: (sessionID: string) => Promise<CouncilDisplay>) {
  const [display, setDisplay] = createSignal<CouncilDisplay>()
  let disposed = false
  let busy = false
  let lastError = ""
  const refresh = async () => {
    if (busy) return
    busy = true
    const id = sessionID()
    try {
      const result = await read(id)
      if (!disposed && sessionID() === id) setDisplay(result)
      lastError = ""
    } catch (error) {
      const message = String(error)
      if (!disposed && message !== lastError) {
        console.warn(`[council-ui] Could not refresh status for ${id}: ${message}`)
        lastError = message
      }
    } finally { busy = false }
  }
  createEffect(on(sessionID, () => {
    // SDK reads during refresh must not subscribe this effect to child activity
    // and erase the live status every time a member emits an update.
    setDisplay(undefined)
    void refresh()
  }))
  const timer = setInterval(() => void refresh(), 1000)
  onCleanup(() => { disposed = true; clearInterval(timer) })
  return display
}
