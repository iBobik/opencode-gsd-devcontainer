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

async function runCouncilLastCommand(fixture: {
  children: Record<string, unknown>
  messages: Record<string, unknown>
  childrenError?: Error
}, request = "What can we conclude?", inspectMessage?: (message: Record<string, unknown>) => void): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opencode-council-last-test-"))
  const worktree = join(root, "project")
  const previousConfigHome = process.env.XDG_CONFIG_HOME

  try {
    await mkdir(join(worktree, ".opencode"), { recursive: true })
    process.env.XDG_CONFIG_HOME = join(root, "config")
    const client = {
      session: {
        children: async ({ path }: { path: { id: string } }) => {
          if (fixture.childrenError) throw fixture.childrenError
          return { data: fixture.children[path.id] ?? [] }
        },
        messages: async ({ path }: { path: { id: string } }) => ({ data: fixture.messages[path.id] ?? [] }),
      },
    }
    const hooks = await CouncilPlugin({ worktree, client } as never)
    const parts = [{ type: "text" as const, text: request }]
    await hooks["command.execute.before"]?.({
      command: "council-last",
      sessionID: "main-session",
      arguments: request,
    }, { parts } as never)
    const message: Record<string, unknown> = {}
    await hooks["chat.message"]?.({ sessionID: "main-session" }, { message, parts } as never)
    const completed = { text: "I should debug the plugin instead." }
    await hooks["experimental.text.complete"]?.({
      sessionID: "main-session",
      messageID: "assistant-message",
      partID: "text-part",
    }, completed)
    message.completedText = completed.text
    inspectMessage?.(message)
    return parts[0].text
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousConfigHome
    await rm(root, { recursive: true, force: true })
  }
}

function session(id: string, created: number, title = id): unknown {
  return { id, title, time: { created, updated: created } }
}

function agentMessages(agent: string, assistant: {
  text?: string
  finish?: string
  completed?: number
  error?: unknown
  extraParts?: unknown[]
} = {}): unknown[] {
  return [
    {
      info: { role: "user", agent, time: { created: 1 } },
      parts: [{ type: "text", text: "Investigate the design." }],
    },
    {
      info: {
        role: "assistant",
        time: { created: 2, ...(assistant.completed ? { completed: assistant.completed } : {}) },
        ...(assistant.finish ? { finish: assistant.finish } : {}),
        ...(assistant.error ? { error: assistant.error } : {}),
      },
      parts: [
        ...(assistant.text ? [{ type: "text", text: assistant.text }] : []),
        ...(assistant.extraParts ?? []),
      ],
    },
  ]
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

  expect(agents(config)["council-member-claude"].model).toStartWith("ppq/claude")
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
  const registeredAgents = agents(config)
  const registered = Object.keys(registeredAgents).filter((name) => name.startsWith("council-member-"))
  const orchestrator = registeredAgents["council-orchestrator"]

  expect(registered).toHaveLength(7)
  for (const [member, model] of Object.entries({
    claude: "ppq/claude-opus-5.5",
    gpt: "ppq/gpt-6-sol",
    gemini: "ppq/google/gemini-3.8-flash",
    qwen: "ppq/qwen/qwen3.8-max-0902",
    kimi: "ppq/moonshotai/kimi-k3",
    glm: "ppq/glm-5.3",
    grok: "ppq/x-ai/grok-4.7",
  })) {
    expect(registeredAgents[`council-member-${member}`].model).toBe(model)
  }
  expect(orchestrator.permission).toMatchObject({
    task: { "*": "deny", "council-member-*": "allow" },
    doom_loop: "deny",
  })
  expect(orchestrator.steps).toBe(11)
  expect(orchestrator.maxSteps).toBeUndefined()
  expect(config.command).toMatchObject({
    council: { agent: "council-orchestrator" },
    "council-last": { template: "Recover the latest council run.\n$ARGUMENTS" },
  })
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

test("recovers every member attempt from the latest saved council run", async () => {
  const prompt = await runCouncilLastCommand({
    children: {
      "main-session": [session("old-orchestrator", 1), session("unrelated", 2), session("new-orchestrator", 3)],
      "old-orchestrator": [session("old-claude", 1)],
      "new-orchestrator": [session("new-claude", 4), session("new-claude-retry", 5), session("new-gpt", 6)],
    },
    messages: {
      "old-orchestrator": agentMessages("council-orchestrator"),
      unrelated: agentMessages("general"),
      "new-orchestrator": agentMessages("council-orchestrator"),
      "old-claude": agentMessages("council-member-claude", { text: "obsolete finding", finish: "stop" }),
      "new-claude": agentMessages("council-member-claude", { text: "partial Claude finding" }),
      "new-claude-retry": agentMessages("council-member-claude", { text: "completed Claude finding", finish: "stop" }),
      "new-gpt": agentMessages("council-member-gpt", {
        text: "useful GPT fragment",
        error: { name: "MessageAbortedError", data: { message: "interrupted" } },
      }),
    },
  }, "Which risks remain?")

  expect(prompt).toContain("Which risks remain?")
  expect(prompt).toContain('"member": "claude"')
  expect(prompt).toContain('"attempt": 1')
  expect(prompt).toContain('"attempt": 2')
  expect(prompt).toContain('"status": "incomplete"')
  expect(prompt).toContain('"status": "completed"')
  expect(prompt).toContain('"status": "error"')
  expect(prompt).toContain("partial Claude finding")
  expect(prompt).toContain("completed Claude finding")
  expect(prompt).toContain("useful GPT fragment")
  expect(prompt).toContain("MessageAbortedError: interrupted")
  expect(prompt).not.toContain("obsolete finding")
})

test("excludes private, synthetic, ignored, tool, and non-council content from recovery", async () => {
  const prompt = await runCouncilLastCommand({
    children: {
      "main-session": [session("orchestrator", 1)],
      orchestrator: [session("claude", 2), session("explorer", 3)],
    },
    messages: {
      orchestrator: agentMessages("council-orchestrator"),
      claude: agentMessages("council-member-claude", {
        text: "public conclusion",
        finish: "stop",
        extraParts: [
          { type: "reasoning", text: "private reasoning" },
          { type: "text", text: "synthetic note", synthetic: true },
          { type: "text", text: "ignored note", ignored: true },
          { type: "tool", state: { status: "completed", output: "raw tool output" } },
        ],
      }),
      explorer: agentMessages("explore", { text: "unrelated analysis", finish: "stop" }),
    },
  })

  expect(prompt).toContain("public conclusion")
  expect(prompt).not.toContain("private reasoning")
  expect(prompt).not.toContain("synthetic note")
  expect(prompt).not.toContain("ignored note")
  expect(prompt).not.toContain("raw tool output")
  expect(prompt).not.toContain("unrelated analysis")
})

test("uses a default recovery request when council-last has no arguments", async () => {
  const prompt = await runCouncilLastCommand({
    children: { "main-session": [session("orchestrator", 1)], orchestrator: [session("member", 2)] },
    messages: {
      orchestrator: agentMessages("council-orchestrator"),
      member: agentMessages("council-member-claude", { text: "finding", finish: "stop" }),
    },
  }, "")

  expect(prompt).toContain("Present each member's recovered conclusions separately")
})

test("reports when no recoverable council run exists", async () => {
  let message: Record<string, unknown> = {}
  const prompt = await runCouncilLastCommand({
    children: { "main-session": [session("unrelated", 1)] },
    messages: { unrelated: agentMessages("general", { text: "not council", finish: "stop" }) },
  }, "What can we conclude?", (value) => { message = value })

  expect(prompt).toBe("No recoverable council member sessions were found in the current session. Command /council-last can only recover a council run from the same parent session.")
  expect(message.system).toContain("terminal command result")
  expect(message.tools).toMatchObject({ read: false, edit: false, bash: false, task: false })
  expect(message.completedText).toBe(prompt)
})

test("turns session API failures into a safe recovery response", async () => {
  const warning = console.warn
  console.warn = () => {}
  try {
    let message: Record<string, unknown> = {}
    const prompt = await runCouncilLastCommand({
      children: {},
      messages: {},
      childrenError: new Error("database unavailable"),
    }, "What can we conclude?", (value) => { message = value })
    expect(prompt).toBe("Council recovery failed while reading saved sessions: database unavailable")
    expect(message.system).toContain("Reply with exactly that text and nothing else")
    expect(message.tools).toMatchObject({ read: false, edit: false, bash: false, task: false })
    expect(message.completedText).toBe(prompt)
  } finally {
    console.warn = warning
  }
})

test("bounds oversized recovered transcripts and marks truncation", async () => {
  const prompt = await runCouncilLastCommand({
    children: { "main-session": [session("orchestrator", 1)], orchestrator: [session("member", 2)] },
    messages: {
      orchestrator: agentMessages("council-orchestrator"),
      member: agentMessages("council-member-claude", {
        text: "start-marker-" + "x".repeat(120_000) + "-end-marker",
        finish: "stop",
      }),
    },
  })

  expect(prompt).toContain("start-marker-")
  expect(prompt).toContain("[recovered transcript truncated]")
  expect(prompt).toContain("-end-marker")
  expect(prompt.length).toBeLessThan(97_000)
})
