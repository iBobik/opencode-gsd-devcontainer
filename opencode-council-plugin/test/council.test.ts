import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CouncilPlugin } from "../plugin/opencode-council"
import * as Host from "@opencode/plugin/host"
import { bounded } from "../plugin/lifecycle"
import { latestDisplay } from "../plugin/run-storage"

const member = { name: "test", model: "vendor/nested/model#high" }

test("the actual OpenCode resolver finds both local-directory entrypoints", () => {
  const entrypoints = Host.resolve({ directory: join(import.meta.dir, "..") })
  expect(entrypoints.server).toEndWith("/index.ts")
  expect(entrypoints.tui).toEndWith("/tui.ts")
})
async function harness(options: { config?: unknown; global?: unknown; missing?: boolean; history?: unknown[]; recovery?: boolean; interrupted?: boolean; createFails?: boolean; waitFails?: boolean; store?: Map<string, any>; attempts?: any[]; sessions?: Record<string, any>; titleText?: string; titleFails?: boolean; renameDuringTitle?: boolean; titleWork?: () => Promise<void>; modelWork?: () => Promise<void>; createWork?: () => Promise<void>; promptWork?: () => Promise<void>; storageWork?: (value: any) => Promise<void>; storageFails?: boolean; deliveryFails?: boolean; recoveryFails?: boolean; missingSessions?: Set<string>; getFails?: boolean } = {}) {
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
  const updates: any[] = []
  const generations: any[] = []
  const sessions = options.sessions ?? {}
  const defaultSession = () => ({ model: { providerID: "parent", id: "model" }, location: { directory: root } })
  const stored = options.store ?? new Map<string, any>()
  let rpc: any
  const attempts: any[] = options.attempts ?? []
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
    storage: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: any) => { await options.storageWork?.(value); if (options.storageFails) throw new Error("storage failed"); stored.set(key, value) },
      remove: async (key: string) => { stored.delete(key) },
      scan: async ({ prefix }: any) => ({ entries: [...stored].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }),
    },
    rpc: { register: async (_definition: any, implementation: any) => { rpc = implementation } },
    location: { directory: root, project: { directory: root } },
    agent: {
      get: async () => ({ data: { system: "Native title instructions", model: { providerID: "vendor", id: "title" } } }),
      transform: async (fn: Function) => fn({ update: (id: string, update: Function) => { agents[id] ??= {}; update(agents[id]) } }),
    },
    generate: { text: async (input: any) => {
      generations.push(input)
      await options.titleWork?.()
      if (options.titleFails) throw new Error("title provider unavailable")
      if (options.renameDuringTitle) sessions.parent = { ...defaultSession(), title: "Manual rename" }
      return { text: options.titleText ?? "Design review" }
    } },
    command: { transform: async (fn: Function) => fn({ add: (definition: any) => commands.set(definition.name, definition) }) },
    model: { list: async () => { await options.modelWork?.(); return { data: options.missing ? [] : [{ providerID: "vendor", id: "nested/model", enabled: true, variants: [{ id: "high" }] }] } } },
    session: {
      get: async ({ sessionID }: any) => {
        if (options.getFails) throw new Error("server unavailable")
        if (options.missingSessions?.has(sessionID)) throw { _tag: "SessionNotFoundError" }
        return sessions[sessionID] ?? defaultSession()
      },
      update: async (input: any) => { updates.push(input); sessions[input.sessionID] = { ...defaultSession(), ...sessions[input.sessionID], ...input } },
      create: async (input: any) => { if (options.createFails) throw new Error("create failed"); created.push(input); await options.createWork?.(); return { id: "run" } },
      prompt: async (input: any) => { prompts.push(input); await options.promptWork?.() },
      wait: async () => {
        if (options.waitFails) throw new Error("wait failed")
        if (options.interrupted) await new Promise<void>((resolve) => { (ctx.session as any).release = resolve })
        else sessions.run ??= { ...defaultSession(), outcome: "succeeded" }
      },
      interrupt: async ({ sessionID }: any) => { interrupted.push(sessionID); (ctx.session as any).release?.() },
      context: async ({ sessionID }: any) => contexts[sessionID] ?? [],
      synthetic: async (input: any) => { reports.push(input); if (options.deliveryFails) throw new Error("delivery failed") },
      list: async ({ parentID, cursor }: any) => {
        if (options.recoveryFails) throw new Error("recovery read failed")
        if (parentID === "run" && attempts.length) return { data: attempts, cursor: {} }
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
    agents, reports, prompts, created, interrupted, contexts, attempts, stored, updates, generations,
    status: () => rpc.status({ sessionID: "parent" }),
    saved: () => latestDisplay(ctx.storage, "parent"),
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
    expect(member.steps).toBe(30)
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

test("inherits global step budgets and preserves per-member overrides", async () => {
  const h = await harness({
    global: { member_steps: 45 },
    config: { members: [member, { name: "custom", model: "vendor/custom", steps: 60 }] },
  })
  try {
    expect(h.agents["council-member-test"].steps).toBe(45)
    expect(h.agents["council-member-custom"].steps).toBe(60)
    expect(h.agents["council-orchestrator"].steps).toBe(6)
  } finally { await h.close() }
})

test("project budgets override global budgets without replacing inherited members", async () => {
  const h = await harness({ global: { members: [member], member_steps: 45 }, config: { member_steps: 55 } })
  try {
    expect(h.agents["council-member-test"].steps).toBe(55)
  } finally { await h.close() }
})

test("accepts step budget boundaries for council defaults and individual members", async () => {
  for (const steps of [1, 100]) {
    const h = await harness({ config: { members: [member, { name: "custom", model: "vendor/custom", steps }], member_steps: steps } })
    try {
      expect(h.agents["council-member-test"].steps).toBe(steps)
      expect(h.agents["council-member-custom"].steps).toBe(steps)
    } finally { await h.close() }
  }
})

test("invalid step budgets reject the entire config and retain inherited settings", async () => {
  for (const steps of [0, -1, 101, 1.5, "30", null, true]) {
    for (const config of [
      { members: [member], member_steps: steps, allow_web: true },
      { members: [{ ...member, steps }], member_steps: 50, allow_web: true },
    ]) {
      const h = await harness({ global: { members: [member], member_steps: 45, allow_web: false }, config })
      try {
        expect(h.agents["council-member-test"].steps).toBe(45)
        expect(h.agents["council-member-test"].permissions).toContainEqual({ action: "webfetch", resource: "*", effect: "deny" })
      } finally { await h.close() }
    }
  }
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

test("summarizes the council prompt with OpenCode's configured title agent without prompting the main session", async () => {
  const h = await harness()
  try {
    await h.run("council", "Review\n  the design")
    expect(h.updates).toEqual([{ sessionID: "parent", title: "Council: Review the design" }, { sessionID: "parent", title: "Design review" }])
    expect(h.generations).toHaveLength(1)
    expect(h.generations[0].model).toEqual({ providerID: "vendor", id: "title" })
    expect(h.generations[0].prompt).toContain("Native title instructions")
    expect(h.generations[0].prompt).toContain(JSON.stringify("Review\n  the design"))
    expect(h.prompts.every((prompt) => prompt.sessionID === "run")).toBe(true)
  } finally { await h.close() }
})

test("council naming preserves custom titles and existing conversations", async () => {
  for (const options of [
    { sessions: { parent: { title: "My chosen title" } } },
    { history: [{ type: "user", text: "Original conversation" }] },
  ]) {
    const h = await harness(options)
    try {
      await h.run("council")
      expect(h.updates).toHaveLength(0)
      expect(h.generations).toHaveLength(0)
    } finally { await h.close() }
  }
})

test("recognizes exact legacy fallback titles and bounds long prompt-based titles", async () => {
  const created = Date.UTC(2026, 9, 24)
  const h = await harness({ sessions: { parent: { title: `New session - ${new Date(created).toISOString()}`, time: { created } } }, titleText: "y".repeat(200) })
  try {
    await h.run("council", "x".repeat(200))
    expect(h.updates[0].title).toHaveLength(100)
    expect(h.updates[0].title).toStartWith("Council: ")
    expect(h.updates[0].title).toEndWith("...")
    expect(h.updates.at(-1).title).toHaveLength(100)
  } finally { await h.close() }
})

test("title failure keeps the fallback and does not stop council; a manual rename beats title generation", async () => {
  for (const options of [{ titleFails: true }, { titleText: "" }, { renameDuringTitle: true }]) {
    const h = await harness(options)
    try {
      await h.run("council")
      expect(h.updates).toEqual([{ sessionID: "parent", title: "Council: review it" }])
      expect(h.reports.at(-1).text).toBe("Synthesis")
    } finally { await h.close() }
  }
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

test("publishes a durable visible summary without prompting the parent model", async () => {
  const h = await harness()
  try {
    await h.run("council")
    expect(await h.status()).toMatchObject({ status: "Council finished", text: "Synthesis", running: false })
    expect((await h.saved())?.text).toBe("Synthesis")
    expect(h.reports).toHaveLength(1)
    expect(h.reports[0]).toMatchObject({ sessionID: "parent", text: "Synthesis", resume: false })
    expect(h.reports[0].description).toBe("Synthesis")
    expect(h.prompts.every((prompt) => prompt.sessionID === "run")).toBe(true)
  } finally { await h.close() }
})

test("progress follows member attempts, retries and synthesis", async () => {
  const h = await harness({ interrupted: true })
  try {
    const run = h.run("council")
    await Bun.sleep(10)
    expect((await h.status()).status).toContain("preparing member tasks")
    h.attempts.push({ id: "first", agent: "council-member-test", time: { created: 1 } })
    expect((await h.status()).status).toContain("1 running · 0/1")
    h.attempts[0].outcome = "failed"
    h.attempts.push({ id: "retry", agent: "council-member-test", time: { created: 2 } })
    expect((await h.status()).status).toContain("retrying · 1 running")
    h.attempts[1].outcome = "succeeded"
    expect((await h.status()).status).toContain("preparing synthesis")
    h.emit({ type: "session.execution.interrupted", data: { sessionID: "parent" } })
    await run
    expect((await h.status()).running).toBe(false)
  } finally { await h.close() }
})

test("a different plugin instance can observe a running council through shared storage", async () => {
  const store = new Map<string, any>()
  const attempts = [{ id: "first", agent: "council-member-test", time: { created: 1 } }]
  const owner = await harness({ store, attempts, interrupted: true })
  const observer = await harness({ store, attempts, config: { members: [member, { name: "other", model: "vendor/other" }] } })
  const run = owner.run("council")
  try {
    await Bun.sleep(10)
    expect((await observer.status()).status).toBe((await owner.status()).status)
    expect((await observer.status()).status).toContain("1 running · 0/1")
    owner.emit({ type: "session.execution.interrupted", data: { sessionID: "parent" } })
    await run
    expect((await observer.status()).text).toContain("Synthesis")
  } finally {
    owner.emit({ type: "session.execution.interrupted", data: { sessionID: "parent" } })
    await observer.close()
    await owner.close()
    await run
  }
})

test("an instance's previous report cannot hide a newer run saved by another owner", async () => {
  const h = await harness()
  try {
    await h.run("council")
    expect((await h.status()).running).toBe(false)
    h.stored.set("display/parent/newer", { status: "Council preparing", text: "", running: true, runID: "new-run", memberCount: 1, createdAt: Date.now() + 1, updatedAt: Date.now() })
    expect((await h.status()).running).toBe(true)
    expect((await h.status()).status).toContain("preparing member tasks")
  } finally { await h.close() }
})

test("startup and execution failures replace progress with a visible terminal report", async () => {
  for (const options of [{ createFails: true }, { waitFails: true }]) {
    const h = await harness(options)
    try {
      await h.run("council")
      expect((await h.status()).running).toBe(false)
      expect((await h.status()).text).toContain("failed")
      expect(h.reports[0].resume).toBe(false)
      expect(h.prompts.some((prompt) => prompt.sessionID === "parent")).toBe(false)
    } finally { await h.close() }
  }
})

test("restores displays and checks actual run outcomes instead of local ownership", async () => {
  const sessions: Record<string, any> = { run: { outcome: "interrupted" } }
  const h = await harness({ sessions })
  try {
    h.stored.set("display/parent", { status: "Council finished", text: "Saved synthesis", running: false })
    expect((await h.status()).text).toBe("Saved synthesis")
    h.stored.set("display/parent", { status: "Council preparing", text: "", running: true })
    expect((await h.status()).running).toBe(false)
    h.stored.set("display/parent", { status: "Council preparing", text: "", running: true, runID: "run" })
    expect((await h.status()).running).toBe(false)
    expect((await h.status()).status).toBe("Council interrupted")
    expect((await h.status()).text).toContain("/council-last")
    sessions.run.outcome = "succeeded"
    expect((await h.status()).text).toBe("Synthesis")
  } finally { await h.close() }
})

function gate() {
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>((resolve) => { entered = resolve })
  const pending = new Promise<void>((resolve) => { release = resolve })
  return { ready, release, work: async () => { entered(); await pending } }
}

test("expired execution leases stop displaying running, while terminal outcomes win over expiry", async () => {
  const sessions: Record<string, any> = { run: {} }
  const h = await harness({ sessions })
  try {
    h.stored.set("display/parent/abandoned", { running: true, status: "Running", text: "", runID: "run", updatedAt: Date.now() - 31_000, createdAt: 1 })
    expect(await h.status()).toMatchObject({ running: false, status: "Council interrupted" })
    expect((await h.status()).text).toContain("may still be active")
    sessions.run.outcome = "succeeded"
    expect(await h.status()).toMatchObject({ running: false, text: "Synthesis" })
  } finally { await h.close() }
})

test("an interruption notice without synthesis falls back to member recovery", async () => {
  const store = new Map<string, any>([["display/parent/stopped", { running: false, status: "Council interrupted", text: "Use /council-last", createdAt: 1 }]])
  const h = await harness({ store, recovery: true })
  try {
    await h.run("council-last", "")
    expect(h.prompts[0].text).toContain("Verified conclusion")
    expect(h.reports).toHaveLength(0)
  } finally { await h.close() }
})

test("interrupting an orchestrator preamble leaves bare council-last able to recover members", async () => {
  const h = await harness({ interrupted: true, recovery: true })
  h.contexts.run = [{ type: "assistant", content: [{ type: "text", text: "Starting council members" }] }]
  const running = h.run("council")
  try {
    await Bun.sleep(10)
    h.emit({ type: "session.execution.interrupted", data: { sessionID: "parent" } })
    await running
    expect(await h.saved()).toMatchObject({ status: "Council interrupted", hasSynthesis: false })
    expect(h.reports.at(-1).text).toContain("Starting council members")
    const reportCount = h.reports.length
    await h.run("council-last", "")
    expect(h.prompts.at(-1)).toMatchObject({ sessionID: "parent", delivery: "queue" })
    expect(h.prompts.at(-1).text).toContain("Verified conclusion")
    expect(h.reports).toHaveLength(reportCount)
    // Previously saved partial reports may already carry the incorrect flag.
    const saved = (await h.saved())!
    saved.hasSynthesis = true
    await h.run("council-last", "")
    expect(h.reports).toHaveLength(reportCount)
    expect(h.prompts.at(-1).text).toContain("Verified conclusion")
  } finally { await h.close(); await running }
})

test("failed or unconfirmed outcomes do not mark preamble text as a completed synthesis", async () => {
  for (const outcome of ["failed", undefined]) {
    const h = await harness({ recovery: true, sessions: { run: { outcome } } })
    try {
      h.contexts.run = [{ type: "assistant", content: [{ type: "text", text: "Starting council members" }] }]
      await h.run("council")
      expect((await h.saved())?.hasSynthesis).toBe(false)
      await h.run("council-last", "")
      expect(h.prompts.at(-1).text).toContain("Verified conclusion")
    } finally { await h.close() }
  }
})

test("recovery-only notices never outrank a council whose first write was delayed", async () => {
  for (const recoveryFails of [false, true]) {
    const store = new Map<string, any>()
    const initialWrite = gate()
    const preparing = gate()
    let firstWrite = true
    const owner = await harness({ store, modelWork: preparing.work, storageWork: async (value) => {
      if (value.running && firstWrite) { firstWrite = false; await initialWrite.work() }
    } })
    const recovery = await harness({ store, recoveryFails, deliveryFails: true })
    const running = owner.run("council")
    try {
      await initialWrite.ready
      expect(await owner.saved()).toBeUndefined()
      await recovery.run("council-last", "")
      const notice = recoveryFails ? "Council recovery failed" : "Council recovery unavailable"
      expect((await recovery.status()).status).toBe(notice)
      expect(store.get("notice/parent").status).toBe(notice)
      expect(await owner.saved()).toBeUndefined()
      initialWrite.release()
      await preparing.ready
      expect((await recovery.status()).running).toBe(true)
      preparing.release()
      await running
      expect(await recovery.status()).toMatchObject({ running: false, status: "Council finished", text: "Synthesis" })
      expect([...store.keys()].filter((key) => key.startsWith("display/parent/"))).toHaveLength(1)
    } finally {
      initialWrite.release(); preparing.release()
      await running; await recovery.close(); await owner.close()
    }
  }
})

test("latest invocation selection paginates and ignores heartbeat recency", async () => {
  const older = { status: "old", running: false, text: "old synthesis", createdAt: 1, updatedAt: 100 }
  const newer = { status: "new", running: true, text: "", createdAt: 2, updatedAt: 2 }
  const storage = {
    get: async () => undefined,
    scan: async ({ after }: { after?: string }) => after
      ? { entries: [{ key: "display/parent/new", value: newer }] }
      : { entries: [{ key: "display/parent/old", value: older }], next: "second" },
  }
  expect(await latestDisplay(storage, "parent")).toBe(newer)
})

test("unloading after creation persists interruption even if the run has no outcome", async () => {
  const h = await harness({ interrupted: true })
  const running = h.run("council")
  await Bun.sleep(10)
  await h.close()
  await running
  expect(await h.saved()).toMatchObject({ running: false, status: "Council interrupted", runID: "run" })
  expect(h.interrupted).toContain("run")
})

test("delayed writes, completion and recovery from another instance cannot hide a newer run", async () => {
  const store = new Map<string, any>()
  const delayed = gate()
  const preparing = gate()
  const old = await harness({ store, storageWork: (value) => value.running ? Promise.resolve() : delayed.work() })
  const next = await harness({ store, modelWork: preparing.work })
  const first = old.run("council")
  let second: Promise<void> | undefined
  try {
    await delayed.ready
    second = next.run("council")
    await preparing.ready
    const current = await next.saved()
    delayed.release()
    await first
    await old.run("council-last", "")
    expect(await next.saved()).toBe(current)
    expect((await next.status()).running).toBe(true)
  } finally {
    delayed.release(); preparing.release()
    await first; await second
    await next.close(); await old.close()
  }
})

test("a delayed heartbeat and old-owner cleanup cannot replace a newer invocation", async () => {
  const store = new Map<string, any>()
  const heartbeat = gate()
  let runningWrites = 0
  const old = await harness({ store, interrupted: true, storageWork: (value) => value.running && ++runningWrites === 3 ? heartbeat.work() : Promise.resolve() })
  const next = await harness({ store, interrupted: true })
  const first = old.run("council")
  let second: Promise<void> | undefined
  let closed = false
  try {
    await heartbeat.ready
    second = next.run("council")
    await Bun.sleep(10)
    const current = await next.saved()
    heartbeat.release()
    await old.close()
    closed = true
    await first
    expect(await next.saved()).toBe(current)
    expect((await next.status()).running).toBe(true)
  } finally {
    heartbeat.release()
    await next.close(); await second
    if (!closed) await old.close()
    await first
  }
}, 15_000)

test("local deadline works without adapter signal support and ignores late rejection", async () => {
  const controller = new AbortController()
  let reject!: (error: Error) => void
  const pending = new Promise<void>((_, fail) => { reject = fail })
  await expect(bounded(pending, controller.signal, 5)).rejects.toThrow("timed out")
  reject(new Error("late provider rejection"))
  await Bun.sleep(0)
  const aborting = bounded(new Promise<void>(() => {}), controller.signal, 10_000)
  controller.abort(new Error("cancelled"))
  await expect(aborting).rejects.toThrow("cancelled")
})

test("the actual title path stops waiting after ten seconds when the adapter ignores signals", async () => {
  const h = await harness({ titleWork: () => new Promise<void>(() => {}) })
  try {
    await h.run("council")
    expect(h.created).toHaveLength(1)
    expect(h.updates).toEqual([{ sessionID: "parent", title: "Council: review it" }])
    expect(h.reports.at(-1).text).toBe("Synthesis")
  } finally { await h.close() }
}, 15_000)

test("interrupting preflight, title generation, creation, or prompt admission prevents later launch", async () => {
  for (const phase of ["modelWork", "titleWork", "createWork", "promptWork"] as const) {
    const paused = gate()
    const h = await harness({ [phase]: paused.work })
    const running = h.run("council")
    try {
      await paused.ready
      h.emit({ type: "session.execution.interrupted", data: { sessionID: "parent" } })
      // Give the event watcher a turn before releasing the pending operation.
      await Bun.sleep(0)
      paused.release()
      await running
      expect((await h.status()).status).toBe("Council interrupted")
      if (phase !== "promptWork") expect(h.prompts).toHaveLength(0)
      if (phase === "createWork" || phase === "promptWork") expect(h.interrupted).toContain("run")
      else expect(h.created).toHaveLength(0)
    } finally { paused.release(); await running; await h.close() }
  }
})

test("unloading during title startup cancels immediately and ignores late title results", async () => {
  const paused = gate()
  const h = await harness({ titleWork: paused.work })
  const running = h.run("council")
  await paused.ready
  try {
    await h.close()
    await running
    paused.release()
    await Bun.sleep(0)
    expect(h.created).toHaveLength(0)
    expect(h.updates).toHaveLength(1)
    expect(await h.saved()).toMatchObject({ running: false, status: "Council interrupted" })
  } finally { paused.release() }
})

test("display write failures do not block startup or suppress the exact synthesis", async () => {
  const h = await harness({ storageFails: true })
  try {
    await h.run("council")
    expect(h.prompts).toHaveLength(1)
    expect(h.reports).toHaveLength(1)
    expect(h.reports[0].text).toBe("Synthesis")
  } finally { await h.close() }
})

test("delivery failure preserves the synthesis and explicit recovery returns it without a model", async () => {
  const options = { deliveryFails: true }
  const h = await harness(options)
  try {
    await h.run("council")
    expect(h.reports).toHaveLength(1)
    expect(h.reports[0].id).toBeUndefined()
    expect((await h.status()).text).toBe("Synthesis")
    expect((await h.status()).deliveryConfirmed).toBe(false)
    options.deliveryFails = false
    await h.run("council-last", "")
    expect(h.reports.at(-1).text).toBe("Synthesis")
    expect((await h.status()).deliveryConfirmed).toBe(true)
    expect(h.prompts.filter((prompt) => prompt.sessionID === "parent")).toHaveLength(0)
  } finally { await h.close() }
})

test("deleting during pending creation cannot restore display state or deliver a report", async () => {
  const paused = gate()
  const missingSessions = new Set<string>()
  const h = await harness({ createWork: paused.work, missingSessions })
  const running = h.run("council")
  try {
    await paused.ready
    missingSessions.add("parent")
    h.emit({ type: "session.deleted", data: { sessionID: "parent" } })
    await Bun.sleep(0)
    paused.release()
    await running
    expect(h.interrupted).toContain("run")
    expect(h.prompts).toHaveLength(0)
    expect(h.reports).toHaveLength(0)
    expect(h.stored.has("display/parent")).toBe(false)
    expect([...h.stored.keys()].some((key) => key.startsWith("display/parent/"))).toBe(false)
    expect((await h.status()).text).toBe("")
  } finally { paused.release(); await running; await h.close() }
})

test("deleted reports are pruned on restart and lazy status reads, but transient errors preserve data", async () => {
  const store = new Map<string, any>([["display/parent", { status: "Council finished", text: "PRIVATE", running: false }]])
  const missingSessions = new Set(["parent"])
  const h = await harness({ store, missingSessions })
  try {
    expect(store.size).toBe(0)
    store.set("display/parent", { status: "Council finished", text: "PRIVATE", running: false })
    expect((await h.status()).text).toBe("")
    expect(store.size).toBe(0)
  } finally { await h.close() }
  store.set("display/parent", { status: "Council finished", text: "Saved", running: false })
  const offline = await harness({ store, getFails: true })
  try {
    await expect(offline.status()).rejects.toThrow("server unavailable")
    expect(store.size).toBe(1)
  } finally { await offline.close() }
})

test("startup leases expire without misclassifying another live owner's preparation", async () => {
  const h = await harness()
  try {
    h.stored.set("display/parent", { status: "Preparing", text: "", running: true, updatedAt: Date.now() })
    expect((await h.status()).running).toBe(true)
    h.stored.get("display/parent").updatedAt = Date.now() - 31_000
    expect((await h.status()).running).toBe(false)
    expect((await h.status()).status).toBe("Council startup stopped")
  } finally { await h.close() }
})

test("duplicate council and recovery requests are explicit and do not overwrite active state", async () => {
  const paused = gate()
  const h = await harness({ modelWork: paused.work })
  const running = h.run("council")
  try {
    await paused.ready
    const display = await h.saved()
    await h.run("council")
    await h.run("council-last")
    expect(h.reports[0].text).toContain("already running")
    expect(h.reports[1].text).toContain("still running")
    expect(await h.saved()).toBe(display)
    expect(h.created).toHaveLength(0)
  } finally { paused.release(); await running; await h.close() }
})

test("recovery absence and errors have accurate terminal labels", async () => {
  for (const recoveryFails of [false, true]) {
    const h = await harness({ recoveryFails })
    try {
      await h.run("council-last")
      expect((await h.status()).status).toBe(recoveryFails ? "Council recovery failed" : "Council recovery unavailable")
    } finally { await h.close() }
  }
})

test("report delivery does not wait for display storage, and deletion wins over a pending write", async () => {
  const paused = gate()
  const h = await harness({ storageWork: (value) => value.running ? Promise.resolve() : paused.work() })
  const running = h.run("council")
  try {
    await paused.ready
    expect(h.reports).toHaveLength(1)
    expect(h.reports[0].text).toBe("Synthesis")
    h.emit({ type: "session.deleted", data: { sessionID: "parent" } })
    await Bun.sleep(0)
    paused.release()
    await running
    expect(h.stored.has("display/parent")).toBe(false)
    expect([...h.stored.keys()].some((key) => key.startsWith("display/parent/"))).toBe(false)
  } finally { paused.release(); await running; await h.close() }
})
