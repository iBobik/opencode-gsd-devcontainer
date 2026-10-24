import { Plugin } from "@opencode/plugin"
import { writeFile } from "node:fs/promises"
import { CouncilUI } from "../opencode-council-plugin/plugin/council-rpc"
import { modelFixture } from "./model-fixture"

export default Plugin.define({
  id: "council-test",
  async setup(ctx) {
    const smoke = process.env.COUNCIL_UI_SMOKE === "1"
    const cleanup = smoke ? await modelFixture(ctx) : undefined
    if (smoke) await ctx.command.transform((editor) => {
      editor.add({
        name: "council-move-test",
        async execute({ sessionID }) {
          await ctx.session.move({ sessionID, directory: "/workspace/other" })
          await ctx.session.wait({ sessionID })
          const session = await ctx.session.get({ sessionID })
          if (session.location.directory !== "/workspace/other") throw new Error("Test session did not move")
          await writeFile("/tmp/council-location-verified", "passed")
          await ctx.session.command({ sessionID, name: "council", text: "Moved-location smoke test" })
        },
      })
      editor.add({
        name: "council-delete-test",
        async execute({ sessionID }) {
          await ctx.session.remove({ sessionID })
          const display = await ctx.rpc(CouncilUI).status({ sessionID }) as { text: string; running: boolean }
          if (display.text || display.running) throw new Error("Deleted council report remains RPC-readable")
          await writeFile("/tmp/council-deletion-verified", "passed")
        },
      })
    })
    const agents = (await ctx.agent.list()).data
    const orchestrator = agents.find((agent) => agent.id === "council-orchestrator")
    const member = agents.find((agent) => agent.id === (smoke ? "council-member-test" : "council-member-claude"))
    if (!orchestrator || !member || member.model?.providerID !== (smoke ? "council-test" : "ppq") || !member.permissions.some((rule) => rule.action === "*" && rule.effect === "deny")) {
      throw new Error("Council agents, models, or permissions were not registered")
    }
    const commands = (await ctx.command.list()).data
    if (!["council", "council-last"].every((name) => commands.some((command) => command.name === name))) throw new Error("Council commands were not registered")
    const display = await ctx.rpc(CouncilUI).status({ sessionID: "ses_unused_test_session" }) as { status: string; running: boolean }
    if (display.status !== "" || display.running) throw new Error("Council display RPC did not load")
    await writeFile("/tmp/council-verified", "passed")
    return cleanup
  },
})
