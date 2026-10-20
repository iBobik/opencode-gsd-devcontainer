import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CouncilPlugin } from "../plugin/opencode-council"

const member = { name: "test", model: "vendor/nested/model#high" }
async function harness(options: { config?: unknown; global?: unknown; missing?: boolean; history?: unknown[]; recovery?: boolean; interrupted?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "council-v2-"))
  const oldConfig = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = join(root, "global")
  await mkdir(join(root, ".opencode"), { recursive: true })
  await mkdir(join(root, "global"))
  await writeFile(join(root, ".opencode", "council.json"), JSON.stringify(options.config ?? { members: [member] }))
  if (options.global) await writeFile(join(root, "global", "council.json"), JSON.stringify(options.global))
  const agents: Record<string, any> = { other: { system: "keep" } }
  const commands = new Map<string, any>()
  const reports: any[] = []
  const prompts: any[] = []
  const created: any[] = []
  const interrupted: string[] = []
  let aborted = false
  let deliverEvent: ((event: any) => void) | undefined
  const contexts: Record<string, any[]> = {
    parent: options.history ?? [],
    run: [{ type: "assistant", content: [{ type: "text", text: "Synthesis" }] }],
    attempt1: [
      { type: "user", text: "Question" },
      { type: "assistant", finish: "stop", content: [{ type: "text", text: "Verified conclusion" }, { type: "reasoning", text: "PRIVATE REASONING" }, { type: "tool", name: "read", state: { content: [{ type: "text", text: "PRIVATE TOOL" }] } }] },
    ],
    attempt2: [{ type: "assistant", error: { message: "rate limit" }, content: [{ type: "text", text: "Partial findings" }] }],
  }
  const ctx = {
    location: { directory: root, project: { directory: root } },
    agent: { transform: async (fn: Function) => fn({ update: (id: string, update: Function) => { agents[id] ??= {}; update(agents[id]) } }) },
    command: { transform: async (fn: Function) => fn({ add: (definition: any) => commands.set(definition.name, definition) }) },
    model: { list: async () => ({ data: options.missing ? [] : [{ providerID: "vendor", id: "nested/model", enabled: true, variants: [{ id: "high" }] }] }) },
    session: {
      get: async () => ({ model: { providerID: "parent", id: "model" }, location: { directory: root } }),
      create: async (input: any) => { created.push(input); return { id: "run" } },
      prompt: async (input: any) => { prompts.push(input) },
      wait: async () => { if (options.interrupted) await new Promise<void>((resolve) => { (ctx.session as any).release = resolve }) },
      interrupt: async ({ sessionID }: any) => { interrupted.push(sessionID); (ctx.session as any).release?.() },
      context: async ({ sessionID }: any) => contexts[sessionID] ?? [],
      synthetic: async (input: any) => { reports.push(input) },
      list: async ({ parentID, cursor }: any) => {
        if (!options.recovery) return { data: [], cursor: {} }
        if (parentID === "parent") return { data: [{ id: "run", agent: "council-orchestrator", time: { created: 2 } }], cursor: {} }
        if (parentID === "run") return { data: [{ id: "attempt1", agent: "council-member-test", outcome: "succeeded", time: { created: 1 } }], cursor: { next: "page2" } }
        if (cursor === "page2") return { data: [{ id: "attempt2", agent: "council-member-test", outcome: "failed", time: { created: 2 } }], cursor: {} }
        return { data: [], cursor: {} }
      },
    },
    event: { subscribe: async function* ({ signal }: any) {
      while (!signal.aborted) {
        const event = await new Promise((resolve) => { deliverEvent = resolve; signal.addEventListener("abort", () => { aborted = true; resolve(undefined) }, { once: true }) })
        if (event) yield event
      }
    } },
  }
  const cleanup = await CouncilPlugin.setup(ctx as never)
  return {
    agents, reports, prompts, created, interrupted, contexts,
    run: (command: string, text = "review it") => commands.get(command).execute({ sessionID: "parent", prompt: { text }, delivery: "queue" }),
    emit: (event: any) => deliverEvent?.(event),
    close: async () => {
      await cleanup?.()
      expect(aborted).toBe(true)
      if (oldConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = oldConfig
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("registers v2 agents with exact model refs, read-only rules and bounded orchestration", async () => {
  const h = await harness()
  try {
    const member = h.agents["council-member-test"]
    expect(member.model).toEqual({ providerID: "vendor", id: "nested/model", variant: "high" })
    expect(member.steps).toBe(12)
    expect(member.permissions).toContainEqual({ action: "*", resource: "*", effect: "deny" })
    expect(member.permissions).toContainEqual({ action: "read", resource: "*", effect: "allow" })
    const orchestrator = h.agents["council-orchestrator"]
    expect(orchestrator.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }, { action: "subagent", resource: "council-member-test", effect: "allow" }])
    expect(orchestrator.system).toContain("background=false")
    expect(orchestrator.system).toContain("Never retry complete successful members")
    expect(orchestrator.system).toContain("full prior response")
    expect(orchestrator.system).toContain("not a completion gate")
    expect(h.agents.other.system).toBe("keep")
  } finally { await h.close() }
})

test("merges global/project configuration and rejects invalid members without partial application", async () => {
  const h = await harness({ global: { members: [member], allow_web: false }, config: { members: [{ name: "bad", model: "invalid" }] } })
  try {
    expect(h.agents["council-member-test"].permissions).toContainEqual({ action: "webfetch", resource: "*", effect: "deny" })
    expect(h.agents["council-member-bad"]).toBeUndefined()
  } finally { await h.close() }
})

test("catalog preflight stops unavailable members without creating sessions or calling a model", async () => {
  const h = await harness({ missing: true })
  try {
    await h.run("council")
    expect(h.created).toHaveLength(0)
    expect(h.prompts).toHaveLength(0)
    expect(h.reports[0]).toMatchObject({ resume: false, metadata: { councilReport: true } })
    expect(h.reports[0].text).toContain("vendor/nested/model#high")
  } finally { await h.close() }
})

test("runs an isolated child with the parent model, bounded history, and exact non-model report", async () => {
  const h = await harness({ history: [
    { type: "user", text: "START" + "x".repeat(30_000) + "END" },
    { type: "synthetic", text: "PRIVATE SYNTHETIC" },
    { type: "assistant", content: [{ type: "reasoning", text: "PRIVATE REASONING" }] },
  ] })
  try {
    await h.run("council")
    expect(h.created[0]).toMatchObject({ parentID: "parent", agent: "council-orchestrator", model: { providerID: "parent", id: "model" } })
    expect(h.prompts[0].text).toContain("START")
    expect(h.prompts[0].text).toContain("END")
    expect(h.prompts[0].text.length).toBeLessThan(24_200)
    expect(h.prompts[0].text).not.toContain("PRIVATE")
    expect(h.reports[0]).toMatchObject({ text: "Synthesis", resume: false })
  } finally { await h.close() }
})

test("recovery reads paginated persisted children and labels separate failed attempts", async () => {
  const h = await harness({ recovery: true })
  try {
    await h.run("council-last", "Continue the work")
    expect(h.prompts[0].text).toContain("Verified conclusion")
    expect(h.prompts[0].text).toContain("Partial findings")
    expect(h.prompts[0].text).toContain('"status": "error"')
    expect(h.prompts[0].text).toContain("rate limit")
    expect(h.prompts[0].text).toContain("untrusted quoted source material")
    expect(h.prompts[0].text).toContain("Continue the work")
    expect(h.prompts[0].text).not.toContain("PRIVATE")
    expect(h.prompts[0].delivery).toBe("queue")
  } finally { await h.close() }
})

test("history stays bounded when an older large message has only a few characters left", async () => {
  const h = await harness({ history: [{ type: "user", text: "x".repeat(100_000) }, { type: "user", text: "y".repeat(23_990) }] })
  try {
    await h.run("council")
    expect(h.prompts[0].text.length).toBeLessThan(24_200)
  } finally { await h.close() }
})

test("no recovery is an exact terminal report and never invokes a model", async () => {
  const h = await harness()
  try {
    await h.run("council-last")
    expect(h.prompts).toHaveLength(0)
    expect(h.reports[0].text).toContain("No recoverable")
    expect(h.reports[0].resume).toBe(false)
  } finally { await h.close() }
})

test("parent interruption cancels the active council child; unloading closes its subscription", async () => {
  const h = await harness({ interrupted: true })
  try {
    const run = h.run("council")
    await Bun.sleep(10)
    h.emit({ type: "session.execution.interrupted", data: { sessionID: "parent" } })
    await run
    expect(h.interrupted).toEqual(["run"])
  } finally { await h.close() }
})
