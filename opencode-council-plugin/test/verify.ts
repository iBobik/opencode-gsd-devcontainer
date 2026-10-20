import { Plugin } from "@opencode/plugin"
import { writeFile } from "node:fs/promises"

export default Plugin.define({
  id: "council-test",
  async setup(ctx) {
    const agents = (await ctx.agent.list()).data
    const orchestrator = agents.find((agent) => agent.id === "council-orchestrator")
    const member = agents.find((agent) => agent.id === "council-member-claude")
    if (!orchestrator || !member || member.model?.providerID !== "ppq" || !member.permissions.some((rule) => rule.action === "*" && rule.effect === "deny")) {
      throw new Error("Council agents, models, or permissions were not registered")
    }
    const commands = (await ctx.command.list()).data
    if (!["council", "council-last"].every((name) => commands.some((command) => command.name === name))) throw new Error("Council commands were not registered")
    await writeFile("/tmp/council-verified", "passed")
  },
})
