import { strict as assert } from "node:assert"
import { Terminal } from "@xterm/headless"

const config = JSON.stringify({ members: [{ name: "test", model: "council-test/mock" }, { name: "test-slow", model: "council-test/mock-slow" }] })
await Bun.write("/workspace/.opencode/council.json", config)
await Bun.write("/workspace/other/.opencode/council.json", config)
const screen = new Terminal({ cols: 120, rows: 50, allowProposedApi: true })
const visibleText = () => {
  const buffer = screen.buffer.active
  return Array.from({ length: screen.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").join("\n")
}
let output = ""
const child = Bun.spawn(["opencode", "--standalone", "--session", "ses_council_ui_smoke", "--prompt", "/council smoke test"], {
  cwd: "/workspace",
  env: { ...process.env, TERM: "xterm-256color", COUNCIL_UI_SMOKE: "1", OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "council-test/mock" }) },
  terminal: {
    cols: 120, rows: 50,
    data(terminal, data) {
      const text = new TextDecoder().decode(data)
      output += text
      screen.write(text)
      if (text.includes("\x1b[6n")) terminal.write("\x1b[1;1R")
    },
  },
})
try {
  const waitFor = async (text: string) => {
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline && !visibleText().includes(text)) await Bun.sleep(100)
    assert.ok(visibleText().includes(text), `The actual terminal did not render: ${text}`)
  }
  const waitForStatusToDisappear = async () => {
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline && visibleText().includes("Council status")) await Bun.sleep(100)
    assert.ok(!visibleText().includes("Council status"), "Completed council status remained above the composer")
  }
  await waitFor("Council status")
  await waitFor("2 running")
  await waitFor("1/2 members finished")
  await waitFor("preparing synthesis")
  await waitFor("COUNCIL_SYNTHESIS_SMOKE")
  await waitForStatusToDisappear()
  assert.equal(visibleText().split("COUNCIL_SYNTHESIS_SMOKE").length - 1, 1, "The report was displayed twice")
  assert.equal(await Bun.file("/tmp/council-title-verified").text(), "Smoke test title", "New session did not receive a summarized council title")
  assert.equal(await Bun.file("/tmp/council-followup-verified").exists(), false)
  child.terminal!.write("FOLLOWUP_REQUEST_SMOKE")
  await Bun.sleep(100)
  child.terminal!.write("\r")
  await waitFor("FOLLOWUP_WITH_COUNCIL_SMOKE")
  assert.equal(await Bun.file("/tmp/council-followup-verified").text(), "passed")
  // A later run still shows live progress without duplicating its report.
  child.terminal!.write("/council second smoke test")
  await Bun.sleep(100)
  child.terminal!.write("\r")
  await waitFor("2 running")
  await waitFor("1/2 members finished")
  await waitFor("preparing synthesis")
  await waitForStatusToDisappear()
  assert.equal(await Bun.file("/tmp/council-title-verified").text(), "Smoke test title", "A later council replaced the original summarized title")
  // The server's default location is still /workspace after moving this
  // session. Status RPC calls must follow the session's new plugin instance.
  child.terminal!.write("/council-move-test ")
  await Bun.sleep(100)
  child.terminal!.write("\r")
  const moveDeadline = Date.now() + 25_000
  while (Date.now() < moveDeadline && !await Bun.file("/tmp/council-location-verified").exists()) await Bun.sleep(100)
  assert.equal(await Bun.file("/tmp/council-location-verified").text(), "passed")
  await waitFor("/workspace/other")
  await waitFor("2 running")
  await waitFor("1/2 members finished")
  await waitFor("preparing synthesis")
  await waitForStatusToDisappear()
  child.terminal!.write("/council-delete-test ")
  await Bun.sleep(100)
  child.terminal!.write("\r")
  const deletionDeadline = Date.now() + 25_000
  while (Date.now() < deletionDeadline && !await Bun.file("/tmp/council-deletion-verified").exists()) await Bun.sleep(100)
  assert.equal(await Bun.file("/tmp/council-deletion-verified").text(), "passed")
  console.log("Real-terminal smoke test passed: single report, two-member progress, next-turn context, repeated runs, moved location, and deletion privacy")
} catch (error) {
  console.log(output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""))
  console.log((await Bun.file("/root/.local/share/opencode/log/opencode.log").text()).slice(-20_000))
  throw error
} finally {
  child.kill()
  await child.exited
  child.terminal?.close()
  screen.dispose()
}
