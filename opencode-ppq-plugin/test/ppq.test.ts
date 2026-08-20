import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PpqPlugin } from "../plugin/opencode-ppq"

type Config = Record<string, any>

async function configure(options: { environmentKey?: string; storedKey?: string; configuredKey?: string; response?: unknown; failFetch?: boolean; staleCache?: unknown[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "opencode-ppq-test-"))
  const previousDataHome = process.env.XDG_DATA_HOME
  const previousKey = process.env.PPQ_API_KEY
  const originalFetch = globalThis.fetch
  const warnings: string[] = []
  const originalWarn = console.warn

  try {
    process.env.XDG_DATA_HOME = root
    if (options.environmentKey === undefined) delete process.env.PPQ_API_KEY
    else process.env.PPQ_API_KEY = options.environmentKey
    if (options.storedKey) {
      await mkdir(join(root, "opencode"), { recursive: true })
      await writeFile(join(root, "opencode", "auth.json"), JSON.stringify({ ppq: { type: "api", key: options.storedKey } }))
    }
    if (options.staleCache) {
      await mkdir(join(root, "opencode"), { recursive: true })
      await writeFile(join(root, "opencode", "ppq-models.cache.json"), JSON.stringify({ fetchedAt: 0, data: options.staleCache }))
    }
    globalThis.fetch = (async (_input, init) => {
      expect((init?.headers as Record<string, string>).Authorization).toBeUndefined()
      if (options.failFetch) throw new Error("offline")
      return new Response(JSON.stringify(options.response ?? { data: [{ id: "vendor/model", created_at: 1, context_length: 1000, pricing: { input_per_1M_tokens: 2, output_per_1M_tokens: 4 }, architecture: { input_modalities: ["pdf"], output_modalities: ["video"] } }] }), { status: 200 })
    }) as typeof fetch
    console.warn = (...values: unknown[]) => warnings.push(values.join(" "))

    const hooks = await PpqPlugin({} as never)
    const config: Config = { provider: { ppq: { options: options.configuredKey ? { apiKey: options.configuredKey } : {} } } }
    await hooks.config?.(config as never)
    return { config, warnings }
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousDataHome
    if (previousKey === undefined) delete process.env.PPQ_API_KEY
    else process.env.PPQ_API_KEY = previousKey
    await rm(root, { recursive: true, force: true })
  }
}

test("environment key overrides configured and stored credentials", async () => {
  const { config } = await configure({ environmentKey: "environment", storedKey: "stored", configuredKey: "configured" })
  expect(config.provider.ppq.options.apiKey).toBe("environment")
  expect(config.provider.ppq.models["vendor/model"].attachment).toBe(true)
  expect(config.provider.ppq.models["vendor/model"].modalities.output).toEqual(["video"])
})

test("configured key loads models when no environment or stored key exists", async () => {
  const { config } = await configure({ configuredKey: "configured" })
  expect(config.provider.ppq.models["vendor/model"].cost).toEqual({ input: 2, output: 4, cache_read: 0, cache_write: 0 })
})

test("missing key keeps only the sign-in stub", async () => {
  const { config } = await configure()
  expect(config.provider.ppq.models).toEqual(expect.objectContaining({ "sign-in-required": expect.any(Object) }))
})

test("invalid catalog data falls back to the sign-in stub without crashing", async () => {
  const { config, warnings } = await configure({ environmentKey: "key", response: { data: [{ id: "bad id" }] } })
  expect(config.provider.ppq.models["sign-in-required"].name).toContain("Failed")
  expect(warnings.join("\n")).toContain("Could not load model catalog")
})

test("uses a valid stale cache after a catalog failure", async () => {
  const { config, warnings } = await configure({
    environmentKey: "key",
    failFetch: true,
    staleCache: [{ id: "cached/model", context_length: 10 }],
  })
  expect(config.provider.ppq.models["cached/model"].limit.context).toBe(10)
  expect(warnings.join("\n")).toContain("Could not load model catalog")
})

test("non-finite metadata is normalized safely", async () => {
  const { config } = await configure({ environmentKey: "key", response: { data: [{ id: "vendor/model", created_at: null, context_length: null, pricing: { input_per_1M_tokens: null, output_per_1M_tokens: null } }] } })
  expect(config.provider.ppq.models["vendor/model"].limit).toEqual({ context: 0, output: 0 })
  expect(config.provider.ppq.models["vendor/model"].cost.input).toBe(0)
})
