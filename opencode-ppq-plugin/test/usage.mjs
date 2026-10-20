import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"

// Regular files avoid CLI stdout truncation on large JSON responses. Asynchronous
// children keep this process free to serve the simulated streaming endpoint.
let sequence = 0
async function cli(args) {
  const file = `/tmp/ppq-usage-${sequence++}.json`
  const fd = openSync(file, "w")
  let stderr = ""
  try {
    const child = spawn("opencode", args, { stdio: ["ignore", fd, "pipe"] })
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (text) => { stderr += text })
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000)
    try {
      const status = await new Promise((resolve, reject) => {
        child.on("error", reject)
        child.on("close", resolve)
      })
      assert.equal(status, 0, `${args.join(" ")}: ${stderr}`)
    } finally { clearTimeout(timeout) }
  } finally { closeSync(fd) }
  try { return readFileSync(file, "utf8").trim() }
  finally { unlinkSync(file) }
}

async function api(operation, { params = {}, data } = {}) {
  const args = ["api", operation, "--param", "location[directory]=/workspace"]
  for (const [key, value] of Object.entries(params)) args.push("--param", `${key}=${value}`)
  if (data !== undefined) args.push("--data", JSON.stringify(data))
  const text = await cli(args)
  return text ? JSON.parse(text) : undefined
}

const requests = []
const failures = []
let includeUsage = true
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/chat/completions")
    assert.equal(request.method, "POST")
    assert.equal(request.headers.authorization, "Bearer test-not-a-real-key")
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    assert.equal(body.model, "test/catalog-model")
    assert.equal(body.stream, true)
    assert.equal(body.stream_options?.include_usage, true, "v2 must request streaming usage without provider config")
    requests.push(body)
    response.writeHead(200, { "content-type": "text/event-stream" })
    const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`)
    send({ choices: [{ index: 0, delta: { role: "assistant", content: "Usage fixture reply" }, finish_reason: null }] })
    send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    // Usage arrives after the stop chunk, as in OpenAI-compatible SSE streams.
    if (includeUsage) send({ choices: [], usage: {
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
      completion_tokens_details: { reasoning_tokens: 10 },
    } })
    response.end("data: [DONE]\n\n")
  } catch (error) {
    failures.push(error)
    response.writeHead(500, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message: String(error) } }))
  }
})
await new Promise((resolve, reject) => {
  server.once("error", reject)
  server.listen(18743, "127.0.0.1", resolve)
})

const expected = { input: 70, output: 30, reasoning: 10, cache: { read: 20, write: 10 } }
const zero = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const expectedCost = (70 * 1 + 40 * 2) / 1_000_000
const sessions = []
const originalConfig = readFileSync(process.env.OPENCODE_CONFIG, "utf8")
try {
  const config = JSON.parse(originalConfig)
  assert.equal(config.providers, undefined, "Usage test must not rely on a provider config block")
  writeFileSync(process.env.OPENCODE_CONFIG, JSON.stringify({ ...config, plugins: [...config.plugins, "/test/usage-plugin"] }))
  await cli(["models"])
  const plugins = (await api("plugin.list")).data
  for (const id of ["ppq", "ppq-usage-test"]) {
    assert(plugins.some((plugin) => plugin.id === id && plugin.state.status === "active"), `${id} must activate`)
  }
  const integrations = (await api("integration.list")).data
  assert(integrations.some((integration) => integration.id === "ppq"), "PPQ authentication must register without provider config")
  for (const reported of [true, false]) {
    includeUsage = reported
    const session = (await api("session.create", { data: {
      title: "PPQ usage fixture",
      model: { providerID: "ppq", id: "test/catalog-model" },
      location: { directory: "/workspace" },
    } })).data
    sessions.push(session.id)
    const params = { sessionID: session.id }
    await api("session.prompt", { params, data: { text: "Reply with the fixture text; do not use tools." } })
    const deadline = Date.now() + 20_000
    let saved
    do {
      saved = (await api("session.get", { params })).data
      if (saved.time.idle) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    assert(saved.time.idle, "Session did not finish within 20 seconds")
    if (failures.length) throw failures[0]
    const context = (await api("session.context", { params })).data
    const assistant = context.filter((message) => message.type === "assistant").at(-1)
    assert(assistant, "Missing assistant message")
    assert.equal(assistant.error, undefined, JSON.stringify(assistant.error))
    assert(assistant.content.some((part) => part.type === "text" && part.text === "Usage fixture reply"))
    assert.deepEqual(assistant.tokens ?? zero, reported ? expected : zero)
    assert(Math.abs((assistant.cost ?? 0) - (reported ? expectedCost : 0)) < 1e-12, `Incorrect message cost: ${assistant.cost}`)
    assert.equal(saved.outcome, "succeeded")
    assert.deepEqual(saved.tokens, reported ? expected : zero)
    assert(Math.abs(saved.cost - (reported ? expectedCost : 0)) < 1e-12, `Incorrect session cost: ${saved.cost}`)
  }
  assert.equal(requests.length, 2, "Expected exactly one model request per session")
  console.log("Verified PPQ without provider config: authentication, streaming usage, persisted message/session tokens and costs, and missing-usage handling")
} finally {
  try {
    for (const sessionID of sessions) await api("session.remove", { params: { sessionID } })
  } finally {
    try { await cli(["service", "stop"]) }
    finally {
      writeFileSync(process.env.OPENCODE_CONFIG, originalConfig)
      await new Promise((resolve) => server.close(resolve))
    }
  }
}
