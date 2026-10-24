import { strict as assert } from "node:assert"
import { createRoot, createSignal } from "solid-js"
import { councilDisplay } from "../plugin/display"

// The SDK can read reactive client/session state synchronously before returning
// its RPC promise. Those reads must not become reset-effect dependencies.
const [activity, setActivity] = createSignal(0)
const [session, setSession] = createSignal("parent")
let calls = 0
let dispose!: () => void
const display = createRoot((cleanup) => {
  dispose = cleanup
  return councilDisplay(session, async (sessionID) => {
    activity()
    calls++
    return { status: `${sessionID}: 2 running`, text: "", running: true }
  })
})
try {
  await Bun.sleep(1)
  assert.equal(display()?.status, "parent: 2 running")
  for (let tick = 1; tick <= 100; tick++) setActivity(tick)
  assert.equal(display()?.status, "parent: 2 running", "Member activity erased the visible panel")
  assert.equal(calls, 1, "Member activity reran the navigation/reset effect")
  setSession("other")
  assert.equal(display(), undefined, "Navigation left another conversation's display visible")
  await Bun.sleep(1)
  assert.equal(display()?.status, "other: 2 running")
  assert.equal(calls, 2)
  console.log("Display reactivity regression passed: child activity does not clear live status")
} finally { dispose() }
