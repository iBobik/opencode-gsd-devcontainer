import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseDotenvProfile, parseProfile, GsdModelsPlugin } from "../plugin/opencode-gsd-models"

test("parses only GSD_MODELS_PROFILE from dotenv syntax", () => {
  expect(parseDotenvProfile("OPENAI_API_KEY=secret\nexport GSD_MODELS_PROFILE = 'gpt' # ignored\n")).toBe("gpt")
  expect(parseDotenvProfile("GSD_MODELS_PROFILE=claude\nGSD_MODELS_PROFILE=mixed\n")).toBe("mixed")
  expect(parseDotenvProfile("GSD_MODELS_PROFILE=\"gpt\" trailing\n")).toBeUndefined()
  expect(parseProfile(" GPT ")).toBe("gpt")
  expect(parseProfile("genius")).toBeUndefined()
})

test("pins catalog-backed GSD agents and preserves unrelated agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-gsd-models-test-"))
  const oldConfig = process.env.OPENCODE_CONFIG
  const oldProfile = process.env.GSD_MODELS_PROFILE
  try {
    await mkdir(join(root, "config", "gsd-core", "bin", "shared"), { recursive: true })
    await writeFile(join(root, "config", "opencode.json"), "{}")
    await writeFile(join(root, "config", "gsd-core", "bin", "shared", "model-catalog.json"), JSON.stringify({ agents: {
      "gsd-planner": { routingTier: "heavy" }, "gsd-executor": { routingTier: "standard" },
    } }))
    process.env.OPENCODE_CONFIG = join(root, "config", "opencode.json")
    process.env.GSD_MODELS_PROFILE = "gpt"
    const hooks = await GsdModelsPlugin({ worktree: root, directory: root, client: { tui: { showToast: async () => ({}) } } } as never)
    const config: Record<string, any> = { agent: {
      "gsd-planner": { model: "old/model", variant: "high", prompt: "keep" },
      "gsd-executor": { model: "old/model" }, other: { model: "other/model" },
    } }
    await hooks.config?.(config as never)
    expect(config.agent["gsd-planner"]).toMatchObject({ model: "openai/gpt-5.6-sol", prompt: "keep" })
    expect(config.agent["gsd-planner"].variant).toBeUndefined()
    expect(config.agent["gsd-executor"].model).toBe("openai/gpt-5.6-terra")
    expect(config.agent.other.model).toBe("other/model")
    await hooks.dispose?.()
  } finally {
    if (oldConfig === undefined) delete process.env.OPENCODE_CONFIG
    else process.env.OPENCODE_CONFIG = oldConfig
    if (oldProfile === undefined) delete process.env.GSD_MODELS_PROFILE
    else process.env.GSD_MODELS_PROFILE = oldProfile
    await rm(root, { recursive: true, force: true })
  }
})

test("invalid explicit profiles stay in inherit mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-gsd-models-test-"))
  const oldConfig = process.env.OPENCODE_CONFIG
  const oldProfile = process.env.GSD_MODELS_PROFILE
  const oldAnthropicKey = process.env.ANTHROPIC_API_KEY
  try {
    await mkdir(join(root, "config", "gsd-core", "bin", "shared"), { recursive: true })
    await writeFile(join(root, "config", "gsd-core", "bin", "shared", "model-catalog.json"), JSON.stringify({
      agents: { "gsd-planner": { routingTier: "heavy" } },
    }))
    process.env.OPENCODE_CONFIG = join(root, "config", "opencode.json")
    process.env.GSD_MODELS_PROFILE = "typo"
    process.env.ANTHROPIC_API_KEY = "test-key"
    const hooks = await GsdModelsPlugin({ worktree: root, directory: root, client: { tui: { showToast: async () => ({}) } } } as never)
    const config: Record<string, any> = { agent: { "gsd-planner": { model: "old/model" } } }
    await hooks.config?.(config as never)
    expect(config.agent["gsd-planner"].model).toBeUndefined()
    await hooks.dispose?.()
  } finally {
    if (oldConfig === undefined) delete process.env.OPENCODE_CONFIG
    else process.env.OPENCODE_CONFIG = oldConfig
    if (oldProfile === undefined) delete process.env.GSD_MODELS_PROFILE
    else process.env.GSD_MODELS_PROFILE = oldProfile
    if (oldAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = oldAnthropicKey
    await rm(root, { recursive: true, force: true })
  }
})

test("blocks conflicting GSD config setters", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-gsd-models-test-"))
  try {
    await mkdir(join(root, ".planning"), { recursive: true })
    await writeFile(join(root, ".planning", "config.json"), JSON.stringify({
      model_profile: "inherit", resolve_model_ids: "omit", telemetry: false,
    }))
    const hooks = await GsdModelsPlugin({ worktree: root, directory: root, client: { tui: { showToast: async () => ({}) } } } as never)
    await expect(hooks["tool.execute.before"]?.({ tool: "bash" } as never, { args: { command: "gsd-tools query config-set model_profile balanced" } } as never)).rejects.toThrow("GSD model routing")
    await expect(hooks["tool.execute.before"]?.({ tool: "bash" } as never, { args: { command: "gsd-tools --cwd /project query config-set.model_profile budget --raw" } } as never)).rejects.toThrow("GSD model routing")
    await expect(hooks["tool.execute.before"]?.({ tool: "bash" } as never, { args: { command: "node /tmp/gsd-tools.cjs query config-set.resolve_model_ids true" } } as never)).rejects.toThrow("GSD model routing")
    await expect(hooks["tool.execute.before"]?.({ tool: "bash" } as never, { args: { command: "node --no-warnings /tmp/gsd-tools.cjs query config-set.resolve_model_ids true" } } as never)).rejects.toThrow("GSD model routing")
    await expect(hooks["tool.execute.before"]?.({ tool: "bash" } as never, { args: { command: "gsd-tools query config-set model_profile=balanced" } } as never)).rejects.toThrow("GSD model routing")
    await expect(hooks["tool.execute.before"]?.({ tool: "bash" } as never, { args: { command: "bash -lc 'gsd-tools query config-set resolve_model_ids true'" } } as never)).rejects.toThrow("GSD model routing")
    await expect(hooks["tool.execute.before"]?.({ tool: "bash" } as never, { args: { command: "gsd_run query config-set-model-profile inherit" } } as never)).resolves.toBeUndefined()

    await expect(hooks["tool.execute.before"]?.({ tool: "edit" } as never, { args: {
      filePath: ".planning/config.json", oldString: "inherit", newString: "balanced",
    } } as never)).rejects.toThrow("GSD config must retain")
    await expect(hooks["tool.execute.before"]?.({ tool: "edit" } as never, { args: {
      filePath: ".planning/config.json", oldString: "false", newString: "true",
    } } as never)).resolves.toBeUndefined()
    await expect(hooks["tool.execute.before"]?.({ tool: "apply_patch" } as never, { args: { patchText: [
      "*** Begin Patch", "*** Update File: .planning/config.json", "@@", "-  false", "+  true", "*** End Patch",
    ].join("\n") } } as never)).rejects.toThrow("GSD config must retain")
    await expect(hooks["tool.execute.before"]?.({ tool: "write" } as never, { args: {
      filePath: join(root, ".planning", "config.json"), content: '{"model_profile":"budget","resolve_model_ids":"omit"}',
    } } as never)).rejects.toThrow("GSD config must retain")
    await hooks.dispose?.()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("does not attribute known non-GSD failures to GSD", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-gsd-models-test-"))
  const messages: string[] = []
  try {
    const hooks = await GsdModelsPlugin({ worktree: root, directory: root, client: { tui: {
      showToast: async ({ body }: { body: { message: string } }) => { messages.push(body.message); return {} },
    } } } as never)
    await hooks["chat.message"]?.({ sessionID: "regular", agent: "general" } as never, {} as never)
    await hooks.event?.({ event: { type: "session.error", properties: {
      sessionID: "regular", error: { name: "ProviderAuthError", data: { providerID: "openai", message: "401" } },
    } } } as never)
    expect(messages).toEqual([])

    await hooks.event?.({ event: { type: "session.error", properties: {
      sessionID: "unknown", error: { name: "ProviderAuthError", data: { providerID: "openai", message: "401" } },
    } } } as never)
    expect(messages[0]).toStartWith("A provider request hit an auth failure.")
    await hooks.dispose?.()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
