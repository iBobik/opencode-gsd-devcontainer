import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CouncilPlugin } from "../plugin/opencode-council"

type GeneratedConfig = Record<string, unknown>

async function runCouncilCommand(messages: unknown, prompt = "User request for the council:\nreview it"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opencode-council-command-test-"))
  const worktree = join(root, "project")
  const previousConfigHome = process.env.XDG_CONFIG_HOME

  try {
    await mkdir(join(worktree, ".opencode"), { recursive: true })
    process.env.XDG_CONFIG_HOME = join(root, "config")
    const client = {
      session: {
        messages: async () => {
          if (messages instanceof Error) throw messages
          return { data: messages }
        },
      },
    }
    const hooks = await CouncilPlugin({ worktree, client } as never)
    const parts = [{
      type: "subtask" as const,
      agent: "council-orchestrator",
      description: "",
      prompt,
    }]
    await hooks["command.execute.before"]?.({
      command: "council",
      sessionID: "session-1",
      arguments: "review it",
    }, { parts } as never)
    return parts[0].prompt
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousConfigHome
    await rm(root, { recursive: true, force: true })
  }
}

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
  expect(member.permission).toMatchObject({
    read: "allow",
    edit: "deny",
    bash: "deny",
    task: "deny",
    doom_loop: "deny",
  })
  expect(member.steps).toBe(12)
  expect(member.maxSteps).toBeUndefined()
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
    doom_loop: "deny",
  })
  expect(orchestrator.steps).toBe(11)
  expect(orchestrator.maxSteps).toBeUndefined()
  expect(config.command).toMatchObject({ council: { agent: "council-orchestrator" } })
})

test("retries failures and continues incomplete responses once in fresh parallel calls", async () => {
  const config = await configureCouncil()
  const prompt = String(agents(config)["council-orchestrator"].prompt)

  expect(prompt).toContain("For an explicit failure or a response with no usable analysis, retry once with the original task prompt")
  expect(prompt).toContain("reached its maximum steps, stopped early, or left requested work unfinished")
  expect(prompt).toContain("both the original task prompt and the member's full prior response")
  expect(prompt).toContain("avoid repeating completed work or any tool call identified as problematic")
  expect(prompt).toContain("Ordinary recommendations for future action do not by themselves")
  expect(prompt).toContain("Submit all needed retries together in ONE assistant message")
  expect(prompt).toContain("start fresh calls without task_id")
  expect(prompt).toContain("never retry any member more than once")
  expect(prompt).toContain("continue even if some members still failed")
  expect(prompt).toContain("retain useful evidence from an incomplete initial response")
})

test("adds recent visible conversation text to the council request", async () => {
  const prompt = await runCouncilCommand([
    {
      info: { role: "assistant", time: { created: 2 } },
      parts: [
        { type: "text", text: "I changed src/auth.ts." },
        { type: "text", text: "internal summary", synthetic: true },
        { type: "reasoning", text: "private reasoning" },
        { type: "text", text: "superseded answer", ignored: true },
      ],
    },
    {
      info: { role: "user", time: { created: 1 } },
      parts: [{ type: "text", text: "Fix the authentication bug." }],
    },
  ])

  expect(prompt).toContain("User:\nFix the authentication bug.")
  expect(prompt).toContain("Assistant:\nI changed src/auth.ts.")
  expect(prompt.indexOf("Fix the authentication bug.")).toBeLessThan(prompt.indexOf("I changed src/auth.ts."))
  expect(prompt).toContain("Current council request:\nUser request for the council:\nreview it")
  expect(prompt).not.toContain("internal summary")
  expect(prompt).not.toContain("private reasoning")
  expect(prompt).not.toContain("superseded answer")
})

test("limits history to the newest twenty messages", async () => {
  const messages = Array.from({ length: 21 }, (_, index) => ({
    info: { role: "user", time: { created: index } },
    parts: [{ type: "text", text: `history-message-${index}` }],
  }))
  const prompt = await runCouncilCommand(messages)

  expect(prompt).not.toContain("history-message-0\n")
  expect(prompt).toContain("history-message-1")
  expect(prompt).toContain("history-message-20")
})

test("truncates oversized history while retaining both ends of the newest message", async () => {
  const text = "start-marker-" + "x".repeat(30_000) + "-end-marker"
  const prompt = await runCouncilCommand([{
    info: { role: "assistant", time: { created: 1 } },
    parts: [{ type: "text", text }],
  }])

  expect(prompt).toContain("start-marker-")
  expect(prompt).toContain("[earlier content in this message omitted]")
  expect(prompt).toContain("-end-marker")
  expect(prompt.length).toBeLessThan(24_200)
})

test("keeps the original request when session history cannot be read", async () => {
  const original = "User request for the council:\nreview it"
  const warning = console.warn
  console.warn = () => {}
  try {
    expect(await runCouncilCommand(new Error("history unavailable"), original)).toBe(original)
  } finally {
    console.warn = warning
  }
})
