import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Model, Provider } from "@opencode/plugin"
import { PpqPlugin } from "../plugin/opencode-ppq"

async function configure(options: { environmentKey?: string; storedKey?: string; configuredKey?: string; response?: unknown; failFetch?: boolean; staleCache?: unknown[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ppq-v2-"))
  const previous = { home: process.env.XDG_DATA_HOME, key: process.env.PPQ_API_KEY, fetch: globalThis.fetch }
  const methods: unknown[] = []
  const hooks = new Map<string, Function>()
  let transform: Function | undefined
  let provider: any
  let source: any
  let currentKey = options.storedKey
  let refreshEvent: (() => void) | undefined
  let refreshed: (() => void) | undefined
  let eventType = "provider.updated"
  let cleanup: (() => unknown) | void
  let requests = 0
  const ppq = Provider.ID.make("ppq")
  const staticModel = { ...Model.Info.default(ppq, Model.ID.make("manual/model")), name: "User model" }
  const initial = { provider: { ...Provider.Info.empty(ppq), settings: options.configuredKey ? { apiKey: options.configuredKey } : {} }, models: new Map([[staticModel.id, staticModel]]) }
  const replay = () => {
    transform!({ get: () => initial, add: (value: any) => { source = value; provider = value.info } })
  }
  try {
    process.env.XDG_DATA_HOME = root
    if (options.environmentKey) process.env.PPQ_API_KEY = options.environmentKey
    else delete process.env.PPQ_API_KEY
    if (options.staleCache) {
      await mkdir(join(root, "opencode"), { recursive: true })
      await writeFile(join(root, "opencode", "ppq-models.cache.json"), JSON.stringify({ fetchedAt: 0, data: options.staleCache }))
    }
    globalThis.fetch = (async (_url, init) => {
      requests++
      expect(new Headers(init?.headers).has("authorization")).toBe(false)
      if (options.failFetch) throw new Error("offline")
      return Response.json(options.response ?? { data: [{ id: "vendor/model", context_length: 1000, supported_parameters: ["tools", "temperature"], pricing: { input_per_1M_tokens: 2, output_per_1M_tokens: 4 }, architecture: { input_modalities: ["file"], output_modalities: ["video"] } }] })
    }) as typeof fetch
    const ctx = {
      provider: {
        list: async () => { if (transform) replay(); return { data: [transform ? provider : initial.provider] } },
        transform: async (fn: Function) => {
          transform = fn
          return { dispose: async () => { transform = undefined } }
        },
        reload: async () => { refreshed?.() },
      },
      integration: {
        transform: async (fn: Function) => fn({ method: { update: (method: unknown) => methods.push(method) } }),
        connection: { active: async () => currentKey ? { type: "credential", id: "test" } : undefined, resolve: async () => ({ type: "key", key: currentKey }) },
      },
      session: { hook: async (name: string, fn: Function) => hooks.set(name, fn) },
      event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        while (!signal.aborted) {
          await new Promise<void>((resolve) => {
            refreshEvent = resolve
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
          if (!signal.aborted) yield { type: eventType }
        }
      } },
    }
    cleanup = await PpqPlugin.setup(ctx as never)
    await new Promise<void>((resolve) => { refreshed = resolve; refreshEvent!() })
    await ctx.provider.list()
    return {
      provider, models: source.models, methods, requests,
      replay: () => { replay(); return source },
      guard: (providerID: string, id: string) => hooks.get("context")!({ model: { providerID, id } }),
      switchKey: async (key: string | undefined) => {
        currentKey = key
        eventType = "credential.switched"
        await new Promise<void>((resolve) => { refreshed = resolve; refreshEvent!() })
        await ctx.provider.list()
        return { provider, models: source.models }
      },
      close: async () => {
        await cleanup?.()
        globalThis.fetch = previous.fetch
        if (previous.home === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous.home
        if (previous.key === undefined) delete process.env.PPQ_API_KEY; else process.env.PPQ_API_KEY = previous.key
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await cleanup?.()
    globalThis.fetch = previous.fetch
    if (previous.home === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous.home
    if (previous.key === undefined) delete process.env.PPQ_API_KEY; else process.env.PPQ_API_KEY = previous.key
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

test("environment overrides saved and configured keys; catalog maps v2 capabilities and prices", async () => {
  const result = await configure({ environmentKey: "env", storedKey: "saved", configuredKey: "config" })
  try {
    expect(result.provider.settings.apiKey).toBe("env")
    const model = result.models.find((model: any) => model.id === "vendor/model")
    expect(model.capabilities).toEqual({ tools: true, temperature: true, input: ["pdf"], output: ["video"] })
    expect(model.cost).toEqual([{ input: 2, output: 4, cache: { read: 0, write: 0 } }])
    expect(result.models.find((model: any) => model.id === "manual/model").name).toBe("User model")
    expect(result.replay().models).toEqual(result.models)
  } finally { await result.close() }
})

for (const options of [{ storedKey: "saved", configuredKey: "config" }, { configuredKey: "config" }]) {
  test(`uses ${options.storedKey ? "saved v2 credentials" : "configured credentials"}`, async () => {
    const result = await configure(options)
    try { expect(result.provider.settings.apiKey).toBe(options.storedKey || options.configuredKey); expect(result.requests).toBe(1) }
    finally { await result.close() }
  })
}

for (const configuredKey of [undefined, "config"]) {
  test(`removing saved credentials falls back to ${configuredKey ? "configuration" : "no key"}, not our published key`, async () => {
    const result = await configure({ storedKey: "saved", configuredKey })
    try {
      const refreshed = await result.switchKey(undefined)
      expect(refreshed.provider.settings.apiKey).toBe(configuredKey)
      expect(refreshed.models.some((model: any) => model.id === "vendor/model")).toBe(Boolean(configuredKey))
    } finally { await result.close() }
  })
}

test("unauthenticated startup skips the catalog; connecting reloads it without restart", async () => {
  const result = await configure()
  try {
    expect(result.requests).toBe(0)
    expect(result.methods).toContainEqual(expect.objectContaining({ integrationID: "ppq", method: expect.objectContaining({ type: "key" }) }))
    const refreshed = await result.switchKey("new-key")
    expect(refreshed.provider.settings.apiKey).toBe("new-key")
    expect(refreshed.models.some((model: any) => model.id === "vendor/model")).toBe(true)
    expect(() => result.guard("ppq", "sign-in-required")).toThrow("/connect")
    expect(() => result.guard("other", "sign-in-required")).not.toThrow()
  } finally { await result.close() }
})

test("invalid catalog is rejected and stale cache survives an offline refresh", async () => {
  const invalid = await configure({ environmentKey: "key", response: { data: [{ id: "bad id" }] } })
  try { expect(invalid.models.some((model: any) => model.id === "bad id")).toBe(false) }
  finally { await invalid.close() }
  const cached = await configure({ environmentKey: "key", failFetch: true, staleCache: [{ id: "cached/model", context_length: 10 }] })
  try { expect(cached.models.find((model: any) => model.id === "cached/model").limit.context).toBe(10) }
  finally { await cached.close() }
})

test("non-finite metadata and fractional limits cannot break the model schema", async () => {
  const result = await configure({ environmentKey: "key", response: { data: [{ id: "vendor/model", context_length: 12.7, created_at: null, pricing: { input_per_1M_tokens: null, output_per_1M_tokens: -1 } }] } })
  try {
    const model = result.models.find((model: any) => model.id === "vendor/model")
    expect(model.limit).toEqual({ context: 12, output: 12 })
    expect(model.cost[0].input).toBe(0)
    expect(model.cost[0].output).toBe(0)
  } finally { await result.close() }
})
