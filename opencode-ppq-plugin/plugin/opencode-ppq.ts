/** PPQ provider for OpenCode 2. Catalog requests never carry credentials. */
import { Integration, Model, Plugin, Provider } from "@opencode/plugin"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

const PPQ_BASE_URL = "https://api.ppq.ai"
const CACHE_TTL_MS = 10 * 60 * 1000
const providerID = Provider.ID.make("ppq")

interface PpqRawModel {
  id: string
  name?: string
  created_at?: number
  context_length?: number
  architecture?: { input_modalities?: string[]; output_modalities?: string[] }
  supported_parameters?: string[]
  pricing?: { input_per_1M_tokens?: number; output_per_1M_tokens?: number }
}

interface CacheShape { fetchedAt: number; data: PpqRawModel[] }
const cachePath = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode", "ppq-models.cache.json")

function validCatalog(value: unknown): value is PpqRawModel[] {
  return Array.isArray(value) && value.every((model) => model && typeof model === "object"
    && typeof model.id === "string" && model.id.length > 0 && !/\s/.test(model.id)
    && !["__proto__", "constructor", "prototype"].includes(model.id))
}

async function readCache(): Promise<CacheShape | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath(), "utf8")) as CacheShape
    if (Number.isFinite(parsed?.fetchedAt) && validCatalog(parsed?.data)) return parsed
  } catch { /* best-effort cache */ }
}

async function fetchCatalog(signal: AbortSignal): Promise<PpqRawModel[]> {
  const cached = await readCache()
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data
  try {
    const response = await fetch(`${PPQ_BASE_URL}/v1/models`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    })
    if (!response.ok) throw new Error(`PPQ /v1/models -> ${response.status}`)
    const json = await response.json() as { data?: unknown }
    if (!validCatalog(json.data) || !json.data.length) throw new Error("invalid or empty response")
    try {
      const file = cachePath()
      await fs.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${Math.random().toString(36).slice(2)}.tmp`
      await fs.writeFile(tmp, JSON.stringify({ fetchedAt: Date.now(), data: json.data }))
      await fs.rename(tmp, file)
    } catch { /* cache writes must not fail startup */ }
    return json.data
  } catch (error) {
    if (!signal.aborted) console.warn(`[ppq] Could not load model catalog: ${error instanceof Error ? error.message : String(error)}`)
    return cached?.data ?? []
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function modalities(value: unknown): string[] {
  const values = strings(value).map((item) => item.toLowerCase() === "file" ? "pdf" : item.toLowerCase())
  return values.length ? [...new Set(values.filter((item) => ["text", "pdf", "image", "video", "audio"].includes(item)))] : ["text"]
}

function toModel(raw: PpqRawModel): Model.Info {
  const model = Model.Info.default(providerID, Model.ID.make(raw.id))
  const params = strings(raw.supported_parameters).map((item) => item.toLowerCase())
  const price = (value: number | undefined) => (Number.isFinite(value) ? Math.max(0, value!) : 0) as Model.Cost["input"]
  const context = Number.isFinite(raw.context_length) ? Math.max(0, Math.floor(raw.context_length!)) : 0
  return {
    ...model,
    name: typeof raw.name === "string" && raw.name ? raw.name : raw.id,
    capabilities: {
      tools: params.includes("tools") || params.includes("tool_choice"),
      temperature: params.includes("temperature"),
      input: modalities(raw.architecture?.input_modalities),
      output: modalities(raw.architecture?.output_modalities),
    },
    cost: [{ input: price(raw.pricing?.input_per_1M_tokens), output: price(raw.pricing?.output_per_1M_tokens), cache: { read: price(0), write: price(0) } }],
    time: { released: Number.isFinite(raw.created_at) && raw.created_at! > 0 ? raw.created_at! : 0 },
    limit: { context, output: Math.min(context, 32000) },
  }
}

export const PpqPlugin = Plugin.define({
  id: "ppq",
  async setup(ctx) {
    const controller = new AbortController()
    let models: Model.Info[] = []
    let key: string | undefined = process.env.PPQ_API_KEY || undefined
    let configuredKey: string | undefined

    // Source edits are synchronous/replayable. Configured definitions win over discovery.
    const publish: Parameters<typeof ctx.provider.transform>[0] = (editor) => {
      const previous = editor.get(providerID)
      const info = previous?.provider ?? Provider.Info.empty(providerID)
      const inventory = new Map<string, Model.Info>(models.map((model) => [model.id, model]))
      for (const [id, model] of previous?.models ?? []) inventory.set(id, model)
      if (!inventory.size) {
        const stub = Model.Info.default(providerID, Model.ID.make("sign-in-required"))
        inventory.set(stub.id, { ...stub, name: key ? "Connect PPQ (Failed to load models)" : "Connect PPQ to load models" })
      }
      editor.add({
        info: {
          ...info,
          name: previous?.provider.name || "PayPerQ - ppq.ai",
          integrationID: Integration.ID.make("ppq"),
          activation: info.activation === "disabled" ? "disabled" : "enabled",
          package: previous?.provider.package || "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: PPQ_BASE_URL, ...info.settings, ...(key ? { apiKey: key } : {}) },
        },
        models: [...inventory.values()],
      })
    }
    let source = await ctx.provider.transform(publish)
    await ctx.integration.transform((editor) => {
      editor.method.update({ integrationID: "ppq", method: { type: "key", label: "Open https://ppq.ai/invite/a586e70a → Add funds → Get an API key → paste key" } })
      editor.method.update({ integrationID: "ppq", method: { type: "env", names: ["PPQ_API_KEY"] } })
    })

    const refresh = async () => {
      const connection = await ctx.integration.connection.active("ppq")
      const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined
      key = process.env.PPQ_API_KEY || (credential?.type === "key" ? credential.key : undefined) || configuredKey
      const catalog = key ? await fetchCatalog(controller.signal) : []
      if (controller.signal.aborted) return
      models = catalog.map(toModel)
      await ctx.provider.reload()
    }
    await refresh()

    // Built-in configuration transforms register after user plugins. The batched
    // startup notification is the first point where their settings are readable.
    // Remove our overlay before reading so a saved key cannot become a config key.
    let startup = true
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (startup && event.type === "provider.updated") {
          startup = false
          await source.dispose()
          const provider = (await ctx.provider.list()).data.find((provider) => provider.id === providerID)
          configuredKey = typeof provider?.settings.apiKey === "string" ? provider.settings.apiKey : undefined
          source = await ctx.provider.transform(publish)
          await refresh()
        } else if (event.type === "credential.updated" || event.type === "credential.switched") {
          await refresh()
        }
      }
    })().catch((error) => {
      if (!controller.signal.aborted) console.warn(`[ppq] Credential refresh stopped: ${String(error)}`)
    })
    await ctx.session.hook("context", (event) => {
      if (event.model.providerID === "ppq" && event.model.id === "sign-in-required") {
        throw new Error("PPQ is not connected or its catalog could not load. Run /connect, choose PPQ, and paste a funded API key from https://ppq.ai/invite/a586e70a. If already connected, check network access and restart OpenCode's service.")
      }
    })
    return () => { controller.abort() }
  },
})

export default PpqPlugin
