import { Model, Provider, type Plugin } from "@opencode/plugin"
import { createServer } from "node:http"
import { writeFile } from "node:fs/promises"

/** Deterministic loopback provider, including a real foreground member call. */
export async function modelFixture(ctx: Plugin.Context) {
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body)
    const primary = request.headers["x-council-test-kind"] === "primary"
    const member = primary && body.includes("You are council member test")
    const orchestrator = primary && body.includes("hidden orchestrator")
    const followup = primary && !member && !orchestrator && body.includes("FOLLOWUP_REQUEST_SMOKE")
    const delegate = orchestrator && !body.includes("MEMBER_RESULT_SMOKE")
    const sessionID = request.headers["x-council-test-session"] as string
    if (delegate) {
      const session = await ctx.session.get({ sessionID })
      const parent = await ctx.session.get({ sessionID: session.parentID! })
      await writeFile("/tmp/council-title-verified", parent.title ?? "")
    }
    if (followup) {
      if (!body.includes("COUNCIL_SYNTHESIS_SMOKE")) throw new Error("Follow-up request did not include the council report")
      const parent = await ctx.session.get({ sessionID })
      if (parent.title !== "Smoke test title") throw new Error("Follow-up replaced the summarized council title")
      await writeFile("/tmp/council-followup-verified", "passed")
    } else if (!delegate) {
      // Keep the orchestrator working long enough for the real UI poll to render.
      await new Promise((resolve) => setTimeout(resolve, member && body.includes("You are council member test-slow") ? 6000 : 3000))
    }
    const text = !primary ? "Smoke test title" : followup ? "FOLLOWUP_WITH_COUNCIL_SMOKE" : member ? "MEMBER_RESULT_SMOKE" : "COUNCIL_SYNTHESIS_SMOKE"
    const tool = input.tools?.find((tool: any) => tool.function?.name === "subagent")
    if (delegate && !tool) throw new Error(`Subagent tool missing: ${JSON.stringify(input.tools)}`)
    const toolCalls = delegate ? ["test", "test-slow"].map((member) => ({ id: `call_${member}`, type: "function", function: { name: tool.function.name, arguments: JSON.stringify({ agent: `council-member-${member}`, description: "Smoke test member", prompt: "Investigate the smoke test", background: false }) } })) : undefined
    const finish = delegate ? "tool_calls" : "stop"
    if (input.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" })
      for (const delta of [delegate ? { role: "assistant", content: "Starting council members", tool_calls: toolCalls!.map((call, index) => ({ index, ...call })) } : { role: "assistant", content: text }, {}]) {
        response.write(`data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : finish }] })}\n\n`)
      }
      response.end("data: [DONE]\n\n")
    } else {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ id: "smoke", object: "chat.completion", created: 1, model: "mock", choices: [{ index: 0, message: { role: "assistant", content: delegate ? "Starting council members" : text, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  await ctx.session.hook("model.request", (event) => {
    event.headers["x-council-test-kind"] = event.kind
    event.headers["x-council-test-session"] = event.sessionID
  })
  const providerID = Provider.ID.make("council-test")
  await ctx.provider.transform((editor) => {
    editor.add({
      info: { ...Provider.Info.empty(providerID), name: "Council Test", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "test" } },
      models: ["mock", "mock-slow"].map((id) => {
        const model = Model.Info.default(providerID, Model.ID.make(id))
        return { ...model, name: "Council Mock", capabilities: { ...model.capabilities, tools: true } }
      }),
    })
  })
  return () => { server.closeAllConnections(); server.close() }
}
