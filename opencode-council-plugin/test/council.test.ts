import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CouncilPlugin } from "../plugin/opencode-council"

type GeneratedConfig = Record<string, unknown>

async function configureCouncil(projectConfig?: string, initialConfig: GeneratedConfig = {}, warnings?: string[]): Promise<GeneratedConfig> {
  const root = await mkdtemp(join(tmpdir(), "opencode-council-test-"))
  const worktree = join(root, "project")
  const previousConfigHome = process.env.XDG_CONFIG_HOME
  const originalWarn = console.warn

  try {
    await mkdir(join(worktree, ".opencode"), { recursive: true })
    if (projectConfig !== undefined) {
      await writeFile(join(worktree, ".opencode", "council.json"), projectConfig)
    }

    process.env.XDG_CONFIG_HOME = join(root, "config")
    if (warnings) console.warn = (...values: unknown[]) => warnings.push(values.join(" "))

    const hooks = await CouncilPlugin({ worktree } as never)
    const config = { ...initialConfig }
    await hooks.config?.(config as never)
    return config
  } finally {
    console.warn = originalWarn
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousConfigHome
    await rm(root, { recursive: true, force: true })
  }
}

function agents(config: GeneratedConfig): Record<string, Record<string, unknown>> {
  return config.agent as Record<string, Record<string, unknown>>
}

test("rejects case-variant member names before agents are registered", async () => {
  const config = await configureCouncil(JSON.stringify({
    members: [
      { name: "Claude", model: "test/claude-a" },
      { name: "claude", model: "test/claude-b" },
    ],
    minimum_successful_members: 2,
  }))

  expect(agents(config)["council-member-claude"].model).toBe("ppq/claude-fable-5")
})

test("caps an inherited quorum when a config replaces the member list", async () => {
  const config = await configureCouncil(JSON.stringify({
    members: [{ name: "reviewer", model: "test/reviewer" }],
  }))

  expect(agents(config)["council-member-reviewer"].model).toBe("test/reviewer")
  expect(agents(config)["council-orchestrator"].prompt).toContain("at least 1 successful members")
})

test("rejects an explicitly invalid quorum", async () => {
  const warnings: string[] = []
  const config = await configureCouncil(JSON.stringify({
    members: [{ name: "reviewer", model: "test/reviewer" }],
    minimum_successful_members: 2,
  }), {}, warnings)

  expect(agents(config)["council-member-reviewer"]).toBeUndefined()
  expect(warnings.join("\n")).toContain("expected 1-12 uniquely named members, a valid quorum, and boolean allow_web")
})

test("rejects null configuration values instead of treating them as absent", async () => {
  const config = await configureCouncil(JSON.stringify({
    members: [{ name: "reviewer", model: "test/reviewer" }],
    minimum_successful_members: null,
    allow_web: null,
  }))

  expect(agents(config)["council-member-reviewer"]).toBeUndefined()
})

test("reports JSON parse errors", async () => {
  const warnings: string[] = []
  await configureCouncil("{", {}, warnings)

  expect(warnings.join("\n")).toContain("Could not parse configuration")
})

test("preserves higher depth settings and grants members read-only access", async () => {
  const config = await configureCouncil(undefined, { subagent_depth: 5 })
  const member = agents(config)["council-member-claude"]

  expect(config.subagent_depth).toBe(5)
  expect(member.permission).toMatchObject({ read: "allow", edit: "deny", bash: "deny", task: "deny" })
})

test("raises depth to the required nested-task minimum", async () => {
  const config = await configureCouncil(undefined, { subagent_depth: 1 })

  expect(config.subagent_depth).toBe(2)
})

test("registers seven default members and allowlists only those members for tasks", async () => {
  const config = await configureCouncil()
  const registered = Object.keys(agents(config)).filter((name) => name.startsWith("council-member-"))
  const orchestrator = agents(config)["council-orchestrator"]

  expect(registered).toHaveLength(7)
  expect(orchestrator.permission).toMatchObject({
    task: { "*": "deny", "council-member-*": "allow" },
  })
  expect(config.command).toMatchObject({ council: { agent: "council-orchestrator" } })
})
